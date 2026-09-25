import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedClock, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, infraEnv, skipUnless, testDeps } from '@hypertest/testkit';
import {
  AdapterRegistry,
  createBudgetLedger,
  createLeaseService,
  createOperationLedger,
  createResourceAdmission,
  createSideEffectGateway,
  operationMigrations,
  type OperationDeps,
} from '../src/index.ts';
import { FakeAdapter, FakeTarget, request } from './helpers.ts';

// Real PostgreSQL 16 with a connection pool: true concurrency (PGlite serializes transactions).
const pg = skipUnless(infraEnv().pgUrl !== undefined, 'HYPERTEST_TEST_PG_URL not set (run `npm run infra:up`)');

let db: SqlDatabase | undefined;
let dispose: (() => Promise<void>) | undefined;
let deps: OperationDeps & ReturnType<typeof testDeps>;

before(async () => {
  if (pg.skip) return;
  const t = await createTestDatabase({ kind: 'postgres', migrations: operationMigrations });
  db = t.db;
  dispose = t.dispose;
  deps = { ...testDeps(), db, events: new InMemoryEventSink() };
});
after(async () => {
  await dispose?.();
});

test('postgres: concurrent prepares with one idempotency key ⇒ one row', pg, async () => {
  const ledger = createOperationLedger(deps);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      ledger.prepare(
        { runId: 'pg-1', workItemId: 'wi', operationType: 'env.deploy', adapterId: 'k', target: { resourceKey: 'ns/pg-1', kind: 'ns' }, desiredStateHash: 'd', inputHash: 'i', idempotencyKey: 'pg-key-1' },
        eventCtx('pg-1'),
      ),
    ),
  );
  assert.equal(new Set(results.map((r) => r.operationId)).size, 1);
  const n = await db!.query<{ n: number }>('SELECT count(*)::int AS n FROM ht_operations WHERE idempotency_key = $1', ['pg-key-1']);
  assert.equal(n.rows[0]!.n, 1);
});

test('postgres: concurrent transitions from one state ⇒ exactly one wins', pg, async () => {
  const ledger = createOperationLedger(deps);
  const op = await ledger.prepare(
    { runId: 'pg-2', workItemId: 'wi', operationType: 'env.deploy', adapterId: 'k', target: { resourceKey: 'ns/pg-2', kind: 'ns' }, desiredStateHash: 'd', inputHash: 'i' },
    eventCtx('pg-2'),
  );
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => ledger.transition(op.operationId, 'dispatching', {}, eventCtx('pg-2'), { expectedFrom: ['prepared'] })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await ledger.get(op.operationId))?.attempt, 1);
});

test('postgres: concurrent lease acquisition grants one lease; tokens stay monotonic', pg, async () => {
  const leases = createLeaseService(deps);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => leases.acquire({ resourceKey: 'pg/lease', owner: `w-${i}`, ttlMs: 1_000 })));
  const granted = results.filter((r) => r !== undefined);
  assert.equal(granted.length, 1);
  assert.equal(granted[0]!.fencingToken, 1);
  deps.clock.advance(1_000);
  const next = await Promise.all(Array.from({ length: 10 }, (_, i) => leases.acquire({ resourceKey: 'pg/lease', owner: `v-${i}`, ttlMs: 1_000 })));
  assert.deepEqual(next.filter((r) => r !== undefined).map((r) => r!.fencingToken), [2]);
  assert.equal(await leases.checkFence('pg/lease', 1), false);
  assert.equal(await leases.checkFence('pg/lease', 2), true);
});

test('postgres: concurrent conflicting admissions ⇒ exactly one admitted', pg, async () => {
  const admission = createResourceAdmission(deps);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => admission.admit({ holderId: `h-${i}`, runId: 'pg-5', claims: [{ resourceKey: `pg5/service/x${i % 2 === 0 ? '' : '/db'}`, mode: 'fault_exclusive' }], ttlMs: 60_000 })),
  );
  assert.equal(results.filter((r) => r.admitted).length, 1);
});

test('postgres: concurrent reservations never exceed limits and overlapping scope orders do not deadlock', pg, async () => {
  const budget = createBudgetLedger(deps);
  await budget.open('run:pg6', { toolCalls: 7 });
  await budget.open('a:pg6', {}, 'run:pg6');
  await budget.open('b:pg6', {}, 'run:pg6');
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => budget.reserve(i % 2 === 0 ? ['a:pg6', 'b:pg6'] : ['b:pg6', 'a:pg6'], { toolCalls: 1 }, `r-${i}`)));
  assert.equal(results.filter((r) => r.ok).length, 7);
  assert.deepEqual((await budget.usage('run:pg6'))?.reserved, { toolCalls: 7 });
});

test('postgres: two gateways racing on one tool call with distinct lease owners ⇒ one external side effect', pg, async () => {
  const ledger = createOperationLedger(deps);
  const leases = createLeaseService(deps);
  const target = new FakeTarget();
  const mk = () => {
    const adapter = new FakeAdapter({ target });
    return { adapter, gateway: createSideEffectGateway({ ...deps, ledger, leases, adapters: new AdapterRegistry([adapter]), pollIntervalMs: 5 }) };
  };
  const g1 = mk();
  const g2 = mk();
  const req = request('pg-7');
  const outs = await Promise.all([
    g1.gateway.run({ ...req, lease: { resourceKey: 'pg/env-7', owner: 'w1', ttlMs: 60_000 } }),
    g2.gateway.run({ ...req, lease: { resourceKey: 'pg/env-7', owner: 'w2', ttlMs: 60_000 } }),
  ]);
  assert.ok(outs.some((o) => o.status === 'verified'));
  for (const o of outs) if (o.status !== 'verified') assert.deepEqual([o.status, 'reason' in o ? o.reason : ''], ['failed', 'resource_busy']);
  assert.equal(g1.adapter.calls.dispatch + g2.adapter.calls.dispatch, 1);
  assert.equal(target.created, 1);
});

test('postgres: conflict errors surface as HypertestError(conflict)', pg, async () => {
  const ledger = createOperationLedger(deps);
  await ledger.prepare(
    { runId: 'pg-8', workItemId: 'wi', operationType: 't', adapterId: 'k', target: { resourceKey: 'x', kind: 'x' }, desiredStateHash: 'd', inputHash: 'i', idempotencyKey: 'pg-key-8' },
    eventCtx('pg-8'),
  );
  await assert.rejects(
    ledger.prepare({ runId: 'pg-8', workItemId: 'wi', operationType: 't', adapterId: 'k', target: { resourceKey: 'x', kind: 'x' }, desiredStateHash: 'd', inputHash: 'other', idempotencyKey: 'pg-key-8' }, eventCtx('pg-8')),
    (e: unknown) => isHypertestError(e, 'conflict'),
  );
});

test('postgres: a renewal in progress is never silently overwritten by a concurrent regrant (acquire locks the lease row)', pg, async () => {
  const leasesA = createLeaseService(deps);
  const a = await leasesA.acquire({ resourceKey: 'pg/renew-race', owner: 'worker-a', ttlMs: 1_000 });
  assert.ok(a);
  // Worker B's clock says A's lease just expired; worker A is renewing it at that very moment.
  const leasesB = createLeaseService({ ...deps, clock: new FixedClock(deps.clock.nowMs() + 1_000) });
  const renewedUntil = new Date(deps.clock.nowMs() + 60_000).toISOString();
  let lockHeld!: () => void;
  const held = new Promise<void>((r) => (lockHeld = r));
  let finishRenewal!: () => void;
  const renewalGate = new Promise<void>((r) => (finishRenewal = r));
  // The renewal transaction (what renew() does): lock the lease row, then extend it.
  const renewal = db!.transaction(async (tx) => {
    await tx.query('SELECT lease_id FROM ht_leases WHERE lease_id = $1 FOR UPDATE', [a.leaseId]);
    lockHeld();
    await renewalGate;
    await tx.query('UPDATE ht_leases SET expires_at = $2 WHERE lease_id = $1', [a.leaseId, renewedUntil]);
  });
  await held;
  const acquiring = leasesB.acquire({ resourceKey: 'pg/renew-race', owner: 'worker-b', ttlMs: 1_000 });
  assert.ok(await waitForLockWait('ht_leases'), 'the regrant reached the renewal lock (the race was exercised)');
  finishRenewal();
  await renewal;
  assert.equal(await acquiring, undefined, 'the renewed lease is live: worker B is refused');
  const live = await leasesA.current('pg/renew-race');
  assert.equal(live?.leaseId, a.leaseId);
  assert.equal(live?.expiresAt, renewedUntil);
  assert.equal(await leasesA.checkFence('pg/renew-race', a.fencingToken), true, 'worker A still holds the fence');
});

async function waitForLockWait(table: string): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    const w = await db!.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [`%${table}%`]);
    if (w.rows[0]!.n > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('postgres: an open racing another open of the same new budget scope succeeds (no unique-violation conflict); parents stay immutable', pg, async () => {
  const budget = createBudgetLedger(deps);
  await budget.open('run:pg9', { tokens: 100 });
  // Another worker is opening work:pg9 right now (inserted, not yet committed).
  let inserted!: () => void;
  const insertedP = new Promise<void>((r) => (inserted = r));
  let commit!: () => void;
  const commitGate = new Promise<void>((r) => (commit = r));
  const other = db!.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ht_budget_scopes (scope, parent_scope, limits, used, reserved, created_at, updated_at)
       VALUES ('work:pg9', 'run:pg9', '{"tokens": 5}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    );
    inserted();
    await commitGate;
  });
  await insertedP;
  const opening = budget.open('work:pg9', { tokens: 10 }, 'run:pg9');
  assert.ok(await waitForLockWait('ht_budget_scopes'), 'the second open reached the insert race');
  commit();
  await other;
  await opening;
  assert.deepEqual(await budget.usage('work:pg9'), { scope: 'work:pg9', limits: { tokens: 10 }, used: {}, reserved: {} });
  // The same race under a different parent is still refused (parents are immutable).
  await assert.rejects(budget.open('work:pg9', {}), (e: unknown) => isHypertestError(e, 'conflict'));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => budget.open('work:pg9c', { tokens: 1 }, 'run:pg9')));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill('fulfilled'));
});
