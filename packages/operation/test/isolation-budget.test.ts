import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { BUDGET_DIMENSIONS, createBudgetLedger, createResourceAdmission, operationExperimentId, type BudgetLedger, type ResourceAdmission, type ReserveOutcome } from '../src/index.ts';
import { FakeAdapter, gatewayFor, openEnv, request, type Env } from './helpers.ts';

/**
 * Unit B2 (conformance-5, conformance-6): experiment-compatible admission, reservable QPS, recorded usage (compute /
 * artifact bytes), headroom and open-reservation listing, experiment ids on operations.
 */

let env: Env;
let budget: BudgetLedger;
let admission: ResourceAdmission;
before(async () => {
  env = await openEnv();
  budget = createBudgetLedger(env.deps);
  admission = createResourceAdmission(env.deps);
});
after(async () => {
  await env.dispose();
});

function reservationId(o: ReserveOutcome): string {
  assert.equal(o.ok, true, `expected ok, got ${JSON.stringify(o)}`);
  return o.ok ? o.reservationId : '';
}

// ------------------------------------------------------------------------------------------ admission (conformance-6)

test('conformance-6: a work item running FOR an experiment shares its claims (compatibleHolders); every other holder is still refused', async () => {
  const exp = await admission.admit({ holderId: 'exp-iso-1', runId: 'run-iso-1', claims: [{ resourceKey: 'iso1/env/staging', mode: 'fault_exclusive' }], ttlMs: 60_000 });
  assert.equal(exp.admitted, true);
  // before: the item's own overlapping claim was refused by its own experiment
  const without = await admission.admit({ holderId: 'wi-iso-1', runId: 'run-iso-1', claims: [{ resourceKey: 'iso1/env/staging', mode: 'write_exclusive' }], ttlMs: 60_000 });
  assert.equal(without.admitted, false);
  const withExp = await admission.admit({ holderId: 'wi-iso-1', runId: 'run-iso-1', claims: [{ resourceKey: 'iso1/env/staging', mode: 'write_exclusive' }], ttlMs: 60_000, compatibleHolders: ['exp-iso-1'] });
  assert.equal(withExp.admitted, true);
  // a third holder conflicts with BOTH (the experiment and its work item)
  const other = await admission.admit({ holderId: 'exp-iso-2', runId: 'run-iso-1', claims: [{ resourceKey: 'iso1/env/staging', mode: 'read_shared' }], ttlMs: 60_000 });
  assert.equal(other.admitted, false);
  assert.deepEqual(other.admitted ? [] : other.conflicts.map((c) => c.heldBy).sort(), ['exp-iso-1', 'wi-iso-1']);
  // naming an unrelated holder as compatible does not make the actual conflict go away
  const stillRefused = await admission.admit({ holderId: 'exp-iso-2', runId: 'run-iso-1', claims: [{ resourceKey: 'iso1/env/staging', mode: 'read_shared' }], ttlMs: 60_000, compatibleHolders: ['exp-iso-1'] });
  assert.equal(stillRefused.admitted, false);
  assert.deepEqual(stillRefused.admitted ? [] : stillRefused.conflicts.map((c) => c.heldBy), ['wi-iso-1']);
});

test('conformance-6: held(holder) lists only live claims of that holder; malformed compatibleHolders are refused', async () => {
  await admission.admit({ holderId: 'exp-held', runId: 'run-held', claims: [{ resourceKey: 'held/service/a', mode: 'read_shared' }, { resourceKey: 'held/service/b', mode: 'fault_exclusive' }], ttlMs: 10_000 });
  const held = await admission.held!('exp-held');
  assert.deepEqual(held.map((h) => [h.runId, h.claim.resourceKey, h.claim.mode]), [
    ['run-held', 'held/service/a', 'read_shared'],
    ['run-held', 'held/service/b', 'fault_exclusive'],
  ]);
  env.clock.advance(10_001);
  assert.deepEqual(await admission.held!('exp-held'), [], 'expired claims are not held');
  await assert.rejects(admission.admit({ holderId: 'x', runId: 'r', claims: [], ttlMs: 1000, compatibleHolders: [''] }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(admission.admit({ holderId: 'x', runId: 'r', claims: [], ttlMs: 1000, compatibleHolders: 'exp' as unknown as string[] }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

// ------------------------------------------------------------------------------------------ QPS reservations (conformance-5)

test('conformance-5: externalQps is reservable across concurrent jobs and freed when a job ends (never used)', async () => {
  assert.equal(BUDGET_DIMENSIONS.at(-1), 'externalQps', 'appended last: the order of existing dimensions is unchanged');
  await budget.open('run:qps1', { externalQps: 100 });
  await budget.open('work:qps1a', {}, 'run:qps1');
  await budget.open('work:qps1b', {}, 'run:qps1');
  const jobA = reservationId(await budget.reserve(['work:qps1a'], { externalQps: 60 }, 'load:A', { idempotencyKey: 'qps:inv-A' }));
  // a second concurrent job would exceed the run's cap: refused with the typed exhaustion
  const jobB = await budget.reserve(['work:qps1b'], { externalQps: 50 }, 'load:B', { idempotencyKey: 'qps:inv-B' });
  assert.deepEqual(jobB, { ok: false, exhausted: { scope: 'run:qps1', dimension: 'externalQps', limit: 100, used: 0, reserved: 60, requested: 50 } });
  // the refused reserve recorded nothing: its retry is evaluated afresh once job A ended
  await budget.release(jobA);
  const retryB = reservationId(await budget.reserve(['work:qps1b'], { externalQps: 50 }, 'load:B', { idempotencyKey: 'qps:inv-B' }));
  assert.notEqual(retryB, jobA);
  const u = await budget.usage('run:qps1');
  assert.deepEqual([u?.used.externalQps ?? 0, u?.reserved.externalQps], [0, 50], 'a rate is reserved, never consumed');
});

test('conformance-5: a keyed reserve is idempotent (replay returns the same reservation, never reserves twice); another amount under the key ⇒ conflict', async () => {
  await budget.open('run:qps2', { externalQps: 100 });
  const first = reservationId(await budget.reserve(['run:qps2'], { externalQps: 70 }, 'load', { idempotencyKey: 'qps:inv-replay' }));
  const replay = reservationId(await budget.reserve(['run:qps2'], { externalQps: 70 }, 'load', { idempotencyKey: 'qps:inv-replay' }));
  assert.equal(replay, first);
  assert.equal((await budget.usage('run:qps2'))?.reserved.externalQps, 70);
  await assert.rejects(budget.reserve(['run:qps2'], { externalQps: 10 }, 'load', { idempotencyKey: 'qps:inv-replay' }), (e: unknown) => isHypertestError(e, 'conflict'));
  // six concurrent duplicates of one keyed reserve hold the rate once
  await budget.open('run:qps3', { externalQps: 100 });
  const ids = await Promise.all(Array.from({ length: 6 }, () => budget.reserve(['run:qps3'], { externalQps: 40 }, 'load', { idempotencyKey: 'qps:inv-concurrent' })));
  assert.equal(new Set(ids.map(reservationId)).size, 1);
  assert.equal((await budget.usage('run:qps3'))?.reserved.externalQps, 40);
});

test('conformance-5: openReservations lists open reservations of a scope chain (with their keys); released ones disappear', async () => {
  await budget.open('run:open1', { externalQps: 100, tokens: 1000 });
  await budget.open('work:open1', {}, 'run:open1');
  const a = reservationId(await budget.reserve(['work:open1'], { externalQps: 10 }, 'load:a', { idempotencyKey: 'qps:open-a' }));
  const b = reservationId(await budget.reserve(['work:open1'], { tokens: 100 }, 'model call'));
  const listed = await budget.openReservations!('run:open1');
  assert.deepEqual(listed.map((r) => [r.reservationId, r.reason, r.idempotencyKey ?? null, r.scopes]), [
    [a, 'load:a', 'qps:open-a', ['work:open1', 'run:open1']],
    [b, 'model call', null, ['work:open1', 'run:open1']],
  ]);
  await budget.release(a);
  assert.deepEqual((await budget.openReservations!('work:open1')).map((r) => r.reservationId), [b]);
  assert.deepEqual(await budget.openReservations!('work:unrelated'), []);
});

// ------------------------------------------------------------------------------------------ consume / remaining (conformance-5)

test('conformance-5: consume records spent compute/artifact bytes even beyond the limit and reports the exhaustion (never refused)', async () => {
  await budget.open('run:use1', { computeMs: 1_000, artifactBytes: 10_000 });
  await budget.open('work:use1', {}, 'run:use1');
  const ok = await budget.consume!(['work:use1'], { computeMs: 400, artifactBytes: 2_000 }, 'tool:inv-1');
  assert.equal(ok.exhausted, undefined);
  assert.match(ok.reservationId, /^bres/);
  const over = await budget.consume!(['work:use1'], { computeMs: 900 }, 'tool:inv-2');
  // the usage is recorded in full (1300 > 1000): under-counting a spent resource would hide the exhaustion
  assert.deepEqual(over.exhausted, { scope: 'run:use1', dimension: 'computeMs', limit: 1_000, used: 1_300, reserved: 0, requested: 900 });
  const u = await budget.usage('run:use1');
  assert.deepEqual([u?.used.computeMs, u?.used.artifactBytes], [1_300, 2_000]);
  assert.deepEqual((await budget.usage('work:use1'))?.used, { computeMs: 1_300, artifactBytes: 2_000 }, 'the listed scope is charged too');
  // exhaustion is reported only among the dimensions named in amounts
  const bytesOnly = await budget.consume!(['work:use1'], { artifactBytes: 1 }, 'tool:inv-3');
  assert.equal(bytesOnly.exhausted, undefined);
  // exactly at the limit is exhausted (nothing left)
  await budget.open('run:use2', { artifactBytes: 100 });
  const exact = await budget.consume!(['run:use2'], { artifactBytes: 100 }, 'put');
  assert.equal(exact.exhausted?.dimension, 'artifactBytes');
  await assert.rejects(budget.consume!(['run:missing'], { computeMs: 1 }, 'x'), (e: unknown) => isHypertestError(e, 'not_found'));
  await assert.rejects(budget.consume!(['run:use2'], { computeMs: -1 }, 'x'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

test('conformance-5: remaining() is the headroom over the chain (limit − used − reserved, floored at 0); unlimited dimensions are absent', async () => {
  await budget.open('run:rem1', { computeMs: 1_000, externalQps: 100 });
  await budget.open('work:rem1', { computeMs: 5_000, tokens: 50 }, 'run:rem1');
  await budget.consume!(['work:rem1'], { computeMs: 300 }, 'x');
  reservationId(await budget.reserve(['work:rem1'], { externalQps: 30, tokens: 20 }, 'y'));
  assert.deepEqual(await budget.remaining!(['work:rem1']), { tokens: 30, computeMs: 700, externalQps: 70 });
  await budget.consume!(['work:rem1'], { computeMs: 2_000 }, 'z');
  assert.equal((await budget.remaining!(['work:rem1'])).computeMs, 0, 'floored at 0 after an overrun');
});

// ------------------------------------------------------------------------------------------ operations carry experimentId (conformance-6)

test('conformance-6: a side effect run for an experiment records the experimentId on its operation (+ events); list filters by it', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const withExp = await gateway.run({ ...request('run-exp-op', { toolInvocationId: 'inv-exp-1' }), experimentId: 'exp_a' });
  assert.equal(withExp.status, 'verified');
  assert.equal(operationExperimentId(withExp.operation), 'exp_a');
  const reread = await env.ledger.get(withExp.operation.operationId);
  assert.equal(operationExperimentId(reread!), 'exp_a');
  const plain = await gateway.run(request('run-exp-op', { toolInvocationId: 'inv-exp-2' }));
  assert.equal(operationExperimentId(plain.operation), undefined);
  assert.deepEqual((await env.ledger.list({ runId: 'run-exp-op', experimentId: 'exp_a' })).map((o) => o.operationId), [withExp.operation.operationId]);
  assert.equal((await env.ledger.list({ runId: 'run-exp-op' })).length, 2);
  const prepared = env.events.events.find((e) => e.aggregateId === withExp.operation.operationId && e.eventType === 'operation.prepared');
  assert.equal((prepared?.payload as Record<string, unknown>)['experimentId'], 'exp_a');
  // a replay keeps the first recorded experiment (the record is immutable in this respect)
  const replay = await gateway.run({ ...request('run-exp-op', { toolInvocationId: 'inv-exp-1' }), experimentId: 'exp_other' });
  assert.equal(operationExperimentId(replay.operation), 'exp_a');
  await assert.rejects(env.ledger.prepare({ runId: 'r', workItemId: 'w', operationType: 't', adapterId: 'a', target: { resourceKey: 'k', kind: 'k' }, desiredStateHash: 'd', inputHash: 'i', experimentId: '' }, { runId: 'r', correlationId: 'r', actorId: 'a' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
