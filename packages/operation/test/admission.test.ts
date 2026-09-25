import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { createResourceAdmission, type ResourceAdmission } from '../src/index.ts';
import { openEnv, type Env } from './helpers.ts';

let env: Env;
let admission: ResourceAdmission;
before(async () => {
  env = await openEnv();
  admission = createResourceAdmission(env.deps);
});
after(async () => {
  await env.dispose();
});

test('I12: two fault experiments on the same service ⇒ the second is refused with the conflicting holder', async () => {
  const a = await admission.admit({ holderId: 'exp-a', runId: 'run-a1', claims: [{ resourceKey: 'a1/service/payment', mode: 'fault_exclusive' }], ttlMs: 60_000 });
  assert.equal(a.admitted, true);
  const b = await admission.admit({ holderId: 'exp-b', runId: 'run-a1', claims: [{ resourceKey: 'a1/service/payment', mode: 'fault_exclusive' }], ttlMs: 60_000 });
  assert.deepEqual(b, {
    admitted: false,
    conflicts: [{ requested: { resourceKey: 'a1/service/payment', mode: 'fault_exclusive' }, heldBy: 'exp-a', held: { resourceKey: 'a1/service/payment', mode: 'fault_exclusive' } }],
  });
});

test('I12: ancestor/descendant keys conflict when either side is exclusive; sibling prefixes do not', async () => {
  assert.equal((await admission.admit({ holderId: 'ns-owner', runId: 'run-a2', claims: [{ resourceKey: 'a2/cluster/test/ns/run-1', mode: 'write_exclusive' }], ttlMs: 60_000 })).admitted, true);
  // Ancestor read of the whole cluster overlaps the exclusive namespace.
  const ancestor = await admission.admit({ holderId: 'metrics', runId: 'run-a2', claims: [{ resourceKey: 'a2/cluster/test', mode: 'read_shared' }], ttlMs: 60_000 });
  assert.equal(ancestor.admitted, false);
  // Descendant of the exclusive namespace.
  const descendant = await admission.admit({ holderId: 'pod-chaos', runId: 'run-a2', claims: [{ resourceKey: 'a2/cluster/test/ns/run-1/pod/x', mode: 'read_shared' }], ttlMs: 60_000 });
  assert.equal(descendant.admitted, false);
  // `ns/run-10` merely shares a string prefix with `ns/run-1`: no overlap.
  const sibling = await admission.admit({ holderId: 'other-ns', runId: 'run-a2', claims: [{ resourceKey: 'a2/cluster/test/ns/run-10', mode: 'write_exclusive' }], ttlMs: 60_000 });
  assert.equal(sibling.admitted, true);
});

test('I12: read_shared claims are compatible with each other, but not with a writer', async () => {
  const r1 = await admission.admit({ holderId: 'reader-1', runId: 'run-a3', claims: [{ resourceKey: 'a3/service/payment', mode: 'read_shared' }], ttlMs: 60_000 });
  const r2 = await admission.admit({ holderId: 'reader-2', runId: 'run-a3', claims: [{ resourceKey: 'a3/service/payment/api', mode: 'read_shared' }], ttlMs: 60_000 });
  assert.equal(r1.admitted && r2.admitted, true);
  const w = await admission.admit({ holderId: 'loadgen', runId: 'run-a3', claims: [{ resourceKey: 'a3/service/payment', mode: 'write_exclusive' }], ttlMs: 60_000 });
  assert.equal(w.admitted, false);
  assert.deepEqual(w.admitted ? [] : w.conflicts.map((c) => c.heldBy).sort(), ['reader-1', 'reader-2']);
});

test('I12: multi-claim admission is all-or-nothing', async () => {
  await admission.admit({ holderId: 'db-writer', runId: 'run-a4', claims: [{ resourceKey: 'a4/database/orders', mode: 'write_exclusive' }], ttlMs: 60_000 });
  const res = await admission.admit({
    holderId: 'exp-multi',
    runId: 'run-a4',
    claims: [
      { resourceKey: 'a4/loadgen/frigate-01', mode: 'write_exclusive' },
      { resourceKey: 'a4/database/orders', mode: 'read_shared' },
    ],
    ttlMs: 60_000,
  });
  assert.equal(res.admitted, false);
  assert.equal(res.admitted ? 0 : res.conflicts.length, 1);
  const held = await admission.active('run-a4');
  assert.deepEqual(held.map((h) => h.holderId), ['db-writer'], 'the free loadgen claim was not taken');
  // The free resource is still available to someone else.
  assert.equal((await admission.admit({ holderId: 'exp-other', runId: 'run-a4', claims: [{ resourceKey: 'a4/loadgen/frigate-01', mode: 'write_exclusive' }], ttlMs: 60_000 })).admitted, true);
});

test('a holder never conflicts with itself; identical re-admission is idempotent', async () => {
  const first = await admission.admit({ holderId: 'self', runId: 'run-a5', claims: [{ resourceKey: 'a5/service/x', mode: 'fault_exclusive' }], ttlMs: 1_000 });
  assert.equal(first.admitted, true);
  const more = await admission.admit({
    holderId: 'self',
    runId: 'run-a5',
    claims: [
      { resourceKey: 'a5/service/x', mode: 'fault_exclusive' },
      { resourceKey: 'a5/service/x/db', mode: 'write_exclusive' },
    ],
    ttlMs: 5_000,
  });
  assert.ok(first.admitted && more.admitted);
  assert.equal(more.claimIds.length, 2);
  assert.equal(more.claimIds[0], first.claimIds[0], 'the identical claim is reused');
  const active = await admission.active('run-a5');
  assert.equal(active.length, 2);
  assert.equal(active[0]!.expiresAt, new Date(env.clock.nowMs() + 5_000).toISOString(), 'reused claim was extended');
});

test('expired claims do not block admission; release frees a holder', async () => {
  await admission.admit({ holderId: 'short', runId: 'run-a6', claims: [{ resourceKey: 'a6/network/fault-domain-a', mode: 'fault_exclusive' }], ttlMs: 500 });
  assert.equal((await admission.admit({ holderId: 'next', runId: 'run-a6', claims: [{ resourceKey: 'a6/network/fault-domain-a', mode: 'fault_exclusive' }], ttlMs: 500 })).admitted, false);
  env.clock.advance(500);
  assert.deepEqual(await admission.active('run-a6'), []);
  assert.equal((await admission.admit({ holderId: 'next', runId: 'run-a6', claims: [{ resourceKey: 'a6/network/fault-domain-a', mode: 'fault_exclusive' }], ttlMs: 60_000 })).admitted, true);
  assert.equal((await admission.admit({ holderId: 'third', runId: 'run-a6', claims: [{ resourceKey: 'a6/network', mode: 'read_shared' }], ttlMs: 60_000 })).admitted, false);
  await admission.release('next');
  assert.equal((await admission.admit({ holderId: 'third', runId: 'run-a6', claims: [{ resourceKey: 'a6/network', mode: 'read_shared' }], ttlMs: 60_000 })).admitted, true);
});

test('active() filters by run and reports holder, claim and expiry', async () => {
  await admission.admit({ holderId: 'h-7', runId: 'run-a7', claims: [{ resourceKey: 'a7/account/test-wallet-pool', mode: 'write_exclusive', quantity: 3 }], ttlMs: 1_000 });
  const active = await admission.active('run-a7');
  assert.deepEqual(active, [
    { holderId: 'h-7', runId: 'run-a7', claim: { resourceKey: 'a7/account/test-wallet-pool', mode: 'write_exclusive', quantity: 3 }, expiresAt: new Date(env.clock.nowMs() + 1_000).toISOString() },
  ]);
  assert.ok((await admission.active()).some((a) => a.runId === 'run-a7'));
});

test('I12: concurrent conflicting admissions ⇒ exactly one admitted', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => admission.admit({ holderId: `racer-${i}`, runId: 'run-a8', claims: [{ resourceKey: 'a8/service/race', mode: 'write_exclusive' }], ttlMs: 60_000 })),
  );
  assert.equal(results.filter((r) => r.admitted).length, 1);
});

test('invalid claims are rejected', async () => {
  const bad = (claims: unknown, ttlMs = 1_000) => admission.admit({ holderId: 'h', runId: 'run-a9', claims: claims as never, ttlMs });
  for (const key of ['', '/lead', 'trail/', 'dou//ble']) {
    await assert.rejects(bad([{ resourceKey: key, mode: 'read_shared' }]), (e: unknown) => isHypertestError(e, 'invalid_argument'), key);
  }
  await assert.rejects(bad([{ resourceKey: 'a9/x', mode: 'exclusive' }]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(bad([{ resourceKey: 'a9/x', mode: 'read_shared', quantity: -1 }]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(bad([{ resourceKey: 'a9/x', mode: 'read_shared' }], 0), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual(await admission.active('run-a9'), []);
});
