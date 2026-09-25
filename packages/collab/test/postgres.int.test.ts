import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError, type DeliveredEvent } from '@hypertest/core';
import { eventCtx, infraEnv, skipUnless } from '@hypertest/testkit';
import { InProcessEventBus, createOutboxRelay } from '../src/index.ts';
import { count, finding, newWorkItem, openEnv, planInput, type Env } from './helpers.ts';

// Real PostgreSQL 16 with a connection pool: true concurrency (PGlite serializes transactions).
const pg = skipUnless(infraEnv().pgUrl !== undefined, 'HYPERTEST_TEST_PG_URL not set (run `npm run infra:up`)');

let env: Env | undefined;
before(async () => {
  if (pg.skip) return;
  env = await openEnv('postgres');
});
after(async () => {
  await env?.dispose();
});

test('postgres: gap-free per-run seq under 30 concurrent appends across 2 runs', pg, async () => {
  const e = env!;
  assert.equal(e.db.kind, 'postgres');
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      e.events.append([{ eventType: 'tick', aggregateType: 'run', aggregateId: 'x', runId: i % 2 ? 'pg-a' : 'pg-b', correlationId: 'c', actorId: 'system:test', payload: { i } }]),
    ),
  );
  for (const runId of ['pg-a', 'pg-b']) {
    assert.deepEqual((await e.events.read(runId)).map((x) => x.seq), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.equal(await count(e.db, "SELECT count(*) AS n FROM ht_outbox WHERE envelope->>'runId' = $1", [runId]), 15);
  }
});

test('postgres: 10 concurrent createWorkItem with one fingerprint ⇒ 1 created, 9 duplicates, one work.created', pg, async () => {
  const e = env!;
  const runId = 'pg-wi';
  const results = await Promise.all(Array.from({ length: 10 }, () => e.board.createWorkItem(newWorkItem(runId), eventCtx(runId))));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => r.workItem.workItemId)).size, 1);
  assert.equal((await e.events.read(runId, { types: ['work.created'] })).length, 1);
  assert.equal(await e.board.revision(runId), 1);
});

test('postgres: concurrent supersedes of one head ⇒ exactly one wins, the rest conflict', pg, async () => {
  const e = env!;
  const runId = 'pg-sup';
  const ctx = eventCtx(runId);
  const v1 = await e.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'x' }, ctx);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => e.board.postRecord({ runId, recordType: 'finding', payload: finding({ title: `v${i}` }), createdBy: `w${i}`, supersedes: v1.recordId }, ctx)),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => isHypertestError((r as PromiseRejectedResult).reason, 'conflict')));
  assert.equal(await count(e.db, 'SELECT count(*) AS n FROM ht_records WHERE lineage_id = $1', [v1.lineageId]), 2);
  assert.equal(await count(e.db, 'SELECT count(*) AS n FROM ht_records WHERE lineage_id = $1 AND is_head', [v1.lineageId]), 1);
});

test('postgres: concurrent fenced transitions ⇒ one claim wins; the stale worker is refused', pg, async () => {
  const e = env!;
  const runId = 'pg-fence';
  const ctx = eventCtx(runId);
  const { workItem } = await e.board.createWorkItem(newWorkItem(runId), ctx);
  const claims = await Promise.allSettled(
    [1, 2, 3].map((t) => e.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: { ownerId: `w${t}`, leaseId: `l${t}`, fencingToken: t, expiresAt: '2026-01-01T01:00:00.000Z' } }, ctx, { expectedFrom: ['ready'] })),
  );
  assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1);
  const owner = (await e.board.getWorkItem(workItem.workItemId))!.claim!;
  const stale = [1, 2, 3].find((t) => t !== owner.fencingToken)!;
  await assert.rejects(e.board.transitionWorkItem(workItem.workItemId, 'running', {}, ctx, { expectedFencingToken: stale }), (err: unknown) => isHypertestError(err, 'stale_fence'));
  assert.equal((await e.events.read(runId, { types: ['work.claimed'] })).length, 1);
});

test('postgres: mixed concurrent blackboard writes on one run neither deadlock nor leave gaps', pg, async () => {
  const e = env!;
  const runId = 'pg-mixed';
  const ctx = eventCtx(runId);
  const ops: Array<Promise<unknown>> = [];
  for (let i = 0; i < 8; i++) {
    ops.push(e.board.postRecord({ runId, recordType: 'note', payload: { text: `n${i}` }, createdBy: 'x' }, ctx));
    ops.push(e.board.createWorkItem(newWorkItem(runId, { fingerprint: `mixed-${i}` }), ctx));
    ops.push(e.board.proposePlan(planInput(runId), ctx));
  }
  await Promise.all(ops);
  // 8 notes + 8 work items + 8 plans = 24 revision bumps; events: 8 records + 16 work + 8 plans = 32.
  assert.equal(await e.board.revision(runId), 24);
  assert.deepEqual((await e.events.read(runId)).map((x) => x.seq), Array.from({ length: 32 }, (_, i) => i + 1));
  assert.deepEqual((await e.board.listPlans(runId)).map((p) => p.revision), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('postgres: concurrent duplicate deliveries through the inbox ⇒ one side effect', pg, async () => {
  const e = env!;
  const runId = 'pg-i5';
  await e.db.query('CREATE TABLE IF NOT EXISTS test_pg_side_effects (id serial PRIMARY KEY, event_id text NOT NULL)');
  const bus = new InProcessEventBus({ duplicateDelivery: () => true });
  const calls: DeliveredEvent[] = [];
  for (let i = 0; i < 3; i++) {
    await bus.subscribe({
      durableName: 'pg-rca',
      subjects: [`ht.${runId}.finding.created`],
      handler: async (d) => {
        calls.push(d);
        await e.db.transaction(async (tx) => {
          if (!(await e.inbox.tryConsume('pg-rca', d.eventId, tx))) return;
          await tx.query('INSERT INTO test_pg_side_effects (event_id) VALUES ($1)', [d.eventId]);
        });
      },
    });
  }
  await e.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'x' }, eventCtx(runId));
  const relay = createOutboxRelay({ ...e.deps, bus });
  await relay.flush();
  await relay.flush();
  await bus.drain(5000);
  const [ev] = await e.events.read(runId, { types: ['finding.created'] });
  assert.equal(calls.filter((c) => c.eventId === ev!.eventId).length, 2);
  assert.equal(await count(e.db, 'SELECT count(*) AS n FROM test_pg_side_effects WHERE event_id = $1', [ev!.eventId]), 1);
  await bus.close();
});

test('postgres: concurrent saves of one oracle from different run contexts get consecutive revisions (no lost/failed save)', pg, async () => {
  const e = env!;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      e.specs.saveOracle(
        {
          oracleId: 'or-pg-shared', scope: { components: ['checkout'], description: `writer ${i}` }, assertions: [], authorities: [],
          judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
          changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
          status: 'approved', approvedBy: [{ kind: 'human', id: 'alice' }],
        },
        eventCtx(`pg-or-${i}`),
      ),
    ),
  );
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(results.map((r) => (r as PromiseFulfilledResult<{ revision: number }>).value.revision).sort(), [1, 2, 3, 4, 5]);
  assert.equal(await count(e.db, "SELECT count(*) AS n FROM ht_oracles WHERE oracle_id = 'or-pg-shared'"), 5);
  // Optimistic writers (explicit next revision) still get exactly one winner.
  const { revision: _r, createdAt: _c, supersedes: _s, ...base } = (await e.specs.getOracle('or-pg-shared'))!;
  const optimistic = await Promise.allSettled([0, 1, 2].map((i) => e.specs.saveOracle({ ...base, revision: 6, scope: { components: [], description: `opt ${i}` } }, eventCtx(`pg-or-opt-${i}`))));
  assert.equal(optimistic.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(optimistic.filter((r) => r.status === 'rejected').every((r) => isHypertestError((r as PromiseRejectedResult).reason, 'conflict')));
});

test('postgres: concurrent claims with increasing tokens after a requeue never let an older token win', pg, async () => {
  const e = env!;
  const runId = 'pg-mono';
  const ctx = eventCtx(runId);
  const { workItem } = await e.board.createWorkItem(newWorkItem(runId, { fingerprint: 'pg-mono' }), ctx);
  await e.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: { ownerId: 'w5', leaseId: 'l5', fencingToken: 5, expiresAt: '2026-01-01T01:00:00.000Z' } }, ctx);
  await e.board.transitionWorkItem(workItem.workItemId, 'ready', {}, ctx);
  const attempts = await Promise.allSettled(
    [3, 4, 5, 7].map((t) => e.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: { ownerId: `w${t}`, leaseId: `l${t}`, fencingToken: t, expiresAt: '2026-01-01T01:00:00.000Z' } }, ctx, { expectedFrom: ['ready'] })),
  );
  assert.deepEqual(attempts.map((a) => a.status), ['rejected', 'rejected', 'rejected', 'fulfilled']);
  assert.ok(attempts.slice(0, 3).every((a) => isHypertestError((a as PromiseRejectedResult).reason, 'stale_fence') || isHypertestError((a as PromiseRejectedResult).reason, 'conflict')));
  assert.equal((await e.board.getWorkItem(workItem.workItemId))!.claim!.fencingToken, 7);
});
