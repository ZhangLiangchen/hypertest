import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, isHypertestError } from '@hypertest/core';
import type { OperationStatus } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { operationEventType, type PrepareOperationInput } from '../src/index.ts';
import { eventTypesFor, openEnv, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

function input(runId: string, overrides: Partial<PrepareOperationInput> = {}): PrepareOperationInput {
  return {
    runId,
    workItemId: `wi-${runId}`,
    operationType: 'env.deploy',
    adapterId: 'kubectl',
    target: { resourceKey: `cluster/test/ns/${runId}`, kind: 'namespace' },
    desiredStateHash: 'dsh-1',
    inputHash: 'ih-1',
    ...overrides,
  };
}

const isCode = (code: string) => (e: unknown) => e instanceof HypertestError && e.code === code;

test('prepare creates a prepared record whose idempotency key defaults to the operation id and emits operation.prepared', async () => {
  const op = await env.ledger.prepare(input('run-l1', { agentId: 'agent-1', toolInvocationId: 'sess:1:call-a' }), eventCtx('run-l1'));
  assert.equal(op.status, 'prepared');
  assert.equal(op.attempt, 0);
  assert.equal(op.idempotencyKey, op.operationId);
  assert.match(op.operationId, /^op_/);
  assert.deepEqual(op.evidenceRefs, []);
  assert.equal(op.agentId, 'agent-1');
  assert.deepEqual(op.target, { resourceKey: 'cluster/test/ns/run-l1', kind: 'namespace' });
  assert.equal(op.createdAt, env.clock.isoNow());
  assert.deepEqual(await env.ledger.get(op.operationId), op);
  assert.deepEqual(await env.ledger.findByIdempotencyKey(op.operationId), op);
  assert.deepEqual(await env.ledger.findByToolInvocation('sess:1:call-a'), op);
  assert.deepEqual(eventTypesFor(env, op.operationId), ['operation.prepared']);
  const ev = env.events.ofType('operation.prepared').find((e) => e.aggregateId === op.operationId)!;
  assert.equal(ev.runId, 'run-l1');
  assert.equal(ev.workItemId, 'wi-run-l1', 'defaults to the operation work item');
  assert.equal(ev.agentId, 'agent-1');
});

test('I4: ten concurrent prepares with one idempotency key ⇒ exactly one row and one event', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => env.ledger.prepare(input('run-l2', { idempotencyKey: 'key-l2' }), eventCtx('run-l2'))));
  assert.equal(new Set(results.map((r) => r.operationId)).size, 1);
  const rows = await env.db.query<{ n: number }>('SELECT count(*)::int AS n FROM ht_operations WHERE idempotency_key = $1', ['key-l2']);
  assert.equal(rows.rows[0]!.n, 1);
  assert.equal(env.events.ofType('operation.prepared').filter((e) => e.runId === 'run-l2').length, 1);
});

test('I4: ten concurrent prepares for one (toolInvocationId, operationType) ⇒ one row; another operation type is a separate record', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => env.ledger.prepare(input('run-l3', { toolInvocationId: 'sess:3:call-x' }), eventCtx('run-l3'))));
  assert.equal(new Set(results.map((r) => r.operationId)).size, 1);
  assert.equal((await env.ledger.list({ runId: 'run-l3' })).length, 1);
  const other = await env.ledger.prepare(input('run-l3', { toolInvocationId: 'sess:3:call-x', operationType: 'env.verify' }), eventCtx('run-l3'));
  assert.notEqual(other.operationId, results[0]!.operationId);
  assert.equal((await env.ledger.findByToolInvocation('sess:3:call-x', 'env.verify'))?.operationId, other.operationId);
  assert.equal((await env.ledger.findByToolInvocation('sess:3:call-x', 'env.deploy'))?.operationId, results[0]!.operationId);
  assert.equal((await env.ledger.findByToolInvocation('sess:3:call-x'))?.operationId, results[0]!.operationId, 'oldest first without a type');
});

test('reusing an idempotency key for a different input is a conflict, never a silent alias', async () => {
  await env.ledger.prepare(input('run-l4', { idempotencyKey: 'key-l4' }), eventCtx('run-l4'));
  await assert.rejects(env.ledger.prepare(input('run-l4', { idempotencyKey: 'key-l4', inputHash: 'ih-other' }), eventCtx('run-l4')), isCode('conflict'));
  await assert.rejects(env.ledger.prepare(input('run-l4b', { idempotencyKey: 'key-l4' }), eventCtx('run-l4b')), isCode('conflict'));
});

test('prepare validates its input', async () => {
  await assert.rejects(env.ledger.prepare(input('run-l5', { runId: '' }), eventCtx('run-l5')), isCode('invalid_argument'));
  await assert.rejects(env.ledger.prepare(input('run-l5', { target: { resourceKey: '', kind: 'x' } }), eventCtx('run-l5')), isCode('invalid_argument'));
  await assert.rejects(env.ledger.prepare(input('run-l5', { desiredStateHash: '' }), eventCtx('run-l5')), isCode('invalid_argument'));
});

test('prepare inside a caller transaction is atomic with it', async () => {
  await assert.rejects(
    env.db.transaction(async (tx) => {
      await env.ledger.prepare(input('run-l6', { idempotencyKey: 'key-l6' }), eventCtx('run-l6'), tx);
      throw new Error('caller aborts');
    }),
    /caller aborts/,
  );
  assert.equal(await env.ledger.findByIdempotencyKey('key-l6'), undefined);
});

test('transition enforces the state machine; an illegal transition changes nothing', async () => {
  const op = await env.ledger.prepare(input('run-l7'), eventCtx('run-l7'));
  await assert.rejects(env.ledger.transition(op.operationId, 'verified', {}, eventCtx('run-l7')), isCode('precondition_failed'));
  await assert.rejects(env.ledger.transition(op.operationId, 'outcome_unknown', {}, eventCtx('run-l7')), isCode('precondition_failed'));
  const unchanged = await env.ledger.get(op.operationId);
  assert.equal(unchanged?.status, 'prepared');
  assert.equal(unchanged.updatedAt, op.updatedAt);
  assert.deepEqual(eventTypesFor(env, op.operationId), ['operation.prepared']);
  await assert.rejects(env.ledger.transition('op_missing', 'dispatching', {}, eventCtx('run-l7')), isCode('not_found'));
});

test('transition: optimistic concurrency on expectedFrom and expectedAttempt', async () => {
  const op = await env.ledger.prepare(input('run-l8'), eventCtx('run-l8'));
  const d = await env.ledger.transition(op.operationId, 'dispatching', {}, eventCtx('run-l8'), { expectedFrom: ['prepared'], expectedAttempt: 0 });
  assert.equal(d.attempt, 1);
  await assert.rejects(env.ledger.transition(op.operationId, 'acknowledged', {}, eventCtx('run-l8'), { expectedFrom: ['prepared'] }), (e: unknown) => {
    assert.ok(isHypertestError(e, 'conflict'));
    assert.equal(e.details['actual'], 'dispatching');
    return true;
  });
  await assert.rejects(env.ledger.transition(op.operationId, 'acknowledged', {}, eventCtx('run-l8'), { expectedFrom: ['dispatching'], expectedAttempt: 0 }), isCode('conflict'));
  assert.equal((await env.ledger.get(op.operationId))?.status, 'dispatching');
  // Racing transitions from the same state: exactly one wins.
  const results = await Promise.allSettled(
    (['acknowledged', 'outcome_unknown', 'not_applied'] as OperationStatus[]).map((to) => env.ledger.transition(op.operationId, to, {}, eventCtx('run-l8'), { expectedFrom: ['dispatching'] })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && isHypertestError(r.reason, 'conflict')).length, 2);
});

test('transition: attempt increments on every → dispatching, patches persist, evidence refs are append-only', async () => {
  const ctx = eventCtx('run-l9');
  let op = await env.ledger.prepare(input('run-l9'), ctx);
  op = await env.ledger.transition(op.operationId, 'dispatching', { lease: { leaseId: 'lease_1', resourceKey: 'cluster/test', fencingToken: 7 } }, ctx);
  op = await env.ledger.transition(op.operationId, 'not_applied', { lastError: 'rejected', externalReceipt: 'r-1', evidenceRefs: ['ev-1', 'ev-2'] }, ctx);
  assert.equal(op.externalReceipt, 'r-1');
  op = await env.ledger.transition(op.operationId, 'dispatching', { evidenceRefs: ['ev-2', 'ev-3', 'ev-3'] }, ctx);
  assert.equal(op.attempt, 2);
  assert.equal(op.externalReceipt, undefined, 'a new attempt starts without the previous attempt receipt');
  op = await env.ledger.transition(op.operationId, 'acknowledged', { externalJobId: 'job-9' }, ctx);
  op = await env.ledger.transition(op.operationId, 'verified', { result: { ok: true, rps: 120 } }, ctx);
  const stored = await env.ledger.get(op.operationId);
  assert.deepEqual(stored, op);
  assert.equal(stored?.attempt, 2);
  assert.deepEqual(stored.lease, { leaseId: 'lease_1', resourceKey: 'cluster/test', fencingToken: 7 });
  assert.equal(stored.externalJobId, 'job-9');
  assert.equal(stored.externalReceipt, undefined);
  const notApplied = env.events.ofType('operation.not_applied').find((e) => e.aggregateId === op.operationId);
  assert.equal((notApplied?.payload as Record<string, unknown>)['externalReceipt'], 'r-1', 'the earlier attempt receipt stays in the event history');
  assert.equal(stored.lastError, 'rejected');
  assert.deepEqual(stored.result, { ok: true, rps: 120 });
  assert.deepEqual(stored.evidenceRefs, ['ev-1', 'ev-2', 'ev-3']);
  assert.deepEqual(eventTypesFor(env, op.operationId), [
    'operation.prepared',
    'operation.dispatched',
    'operation.not_applied',
    'operation.dispatched',
    'operation.acknowledged',
    'operation.verified',
  ]);
  const dispatched = env.events.ofType('operation.dispatched').filter((e) => e.aggregateId === op.operationId);
  assert.deepEqual((dispatched[1]!.payload as Record<string, unknown>)['attempt'], 2);
  assert.deepEqual((dispatched[0]!.payload as Record<string, unknown>)['fencingToken'], 7);
});

test('a recorded null result is preserved (distinct from no result)', async () => {
  const ctx = eventCtx('run-l10');
  let op = await env.ledger.prepare(input('run-l10'), ctx);
  for (const to of ['dispatching', 'acknowledged'] as const) op = await env.ledger.transition(op.operationId, to, {}, ctx);
  assert.equal('result' in op, false);
  op = await env.ledger.transition(op.operationId, 'verified', { result: null }, ctx);
  const stored = await env.ledger.get(op.operationId);
  assert.equal('result' in stored!, true);
  assert.equal(stored!.result, null);
});

test('list filters by run, work item and status; listUnsettled returns only dispatching/acknowledged/outcome_unknown/reconciling', async () => {
  const ctx = eventCtx('run-l11');
  const mk = async (workItemId: string, path: OperationStatus[]) => {
    let op = await env.ledger.prepare(input('run-l11', { workItemId }), ctx);
    for (const to of path) op = await env.ledger.transition(op.operationId, to, {}, ctx);
    return op;
  };
  const prepared = await mk('wi-a', []);
  const dispatching = await mk('wi-a', ['dispatching']);
  const acked = await mk('wi-b', ['dispatching', 'acknowledged']);
  const unknown = await mk('wi-b', ['dispatching', 'outcome_unknown']);
  const reconciling = await mk('wi-b', ['dispatching', 'outcome_unknown', 'reconciling']);
  const verified = await mk('wi-b', ['dispatching', 'acknowledged', 'verified']);
  await env.ledger.prepare(input('run-l11-other'), eventCtx('run-l11-other'));
  const other = await env.ledger.prepare(input('run-l11-other', { idempotencyKey: 'k-other' }), eventCtx('run-l11-other'));
  await env.ledger.transition(other.operationId, 'dispatching', {}, eventCtx('run-l11-other'));

  assert.equal((await env.ledger.list({ runId: 'run-l11' })).length, 6);
  assert.deepEqual((await env.ledger.list({ runId: 'run-l11', workItemId: 'wi-a' })).map((o) => o.operationId), [prepared.operationId, dispatching.operationId]);
  assert.deepEqual((await env.ledger.list({ runId: 'run-l11', status: ['verified', 'prepared'] })).map((o) => o.operationId), [prepared.operationId, verified.operationId]);
  assert.deepEqual(
    (await env.ledger.listUnsettled('run-l11')).map((o) => o.operationId),
    [dispatching.operationId, acked.operationId, unknown.operationId, reconciling.operationId],
  );
  const all = (await env.ledger.listUnsettled()).map((o) => o.operationId);
  assert.ok(all.includes(other.operationId));
  assert.ok(!all.includes(verified.operationId) && !all.includes(prepared.operationId));
});

test('event naming: catalog names for prepared/dispatched/verified/outcome_unknown/reconciled/manual_review', () => {
  assert.equal(operationEventType(undefined, 'prepared'), 'operation.prepared');
  assert.equal(operationEventType('prepared', 'dispatching'), 'operation.dispatched');
  assert.equal(operationEventType('acknowledged', 'verified'), 'operation.verified');
  assert.equal(operationEventType('dispatching', 'outcome_unknown'), 'operation.outcome_unknown');
  assert.equal(operationEventType('reconciling', 'acknowledged'), 'operation.reconciled');
  assert.equal(operationEventType('reconciling', 'not_applied'), 'operation.reconciled');
  assert.equal(operationEventType('reconciling', 'manual_review'), 'operation.manual_review');
  assert.equal(operationEventType('dispatching', 'not_applied'), 'operation.not_applied');
});

test('events are emitted in the transition transaction: a failing sink rolls the state change back', async () => {
  const { createOperationLedger } = await import('../src/index.ts');
  let fail = false;
  const ledger = createOperationLedger({
    ...env.deps,
    events: {
      async emit() {
        if (fail) throw new Error('outbox unavailable');
        return [];
      },
    },
  });
  const op = await ledger.prepare(input('run-l12'), eventCtx('run-l12'));
  fail = true;
  await assert.rejects(ledger.transition(op.operationId, 'dispatching', {}, eventCtx('run-l12')), /outbox unavailable/);
  const stored = await ledger.get(op.operationId);
  assert.equal(stored?.status, 'prepared');
  assert.equal(stored.attempt, 0);
});

test('I4: a re-dispatch never inherits the previous attempt\'s externalJobId; a receipt supplied with the new attempt is kept', async () => {
  const ctx = eventCtx('run-l13');
  let op = await env.ledger.prepare(input('run-l13'), ctx);
  op = await env.ledger.transition(op.operationId, 'dispatching', {}, ctx);
  op = await env.ledger.transition(op.operationId, 'acknowledged', { externalJobId: 'job-a1', externalReceipt: 'rcpt-a1' }, ctx);
  for (const to of ['outcome_unknown', 'reconciling', 'manual_review', 'not_applied'] as const) op = await env.ledger.transition(op.operationId, to, {}, ctx);
  assert.equal(op.externalJobId, 'job-a1', 'kept until a new attempt starts');
  op = await env.ledger.transition(op.operationId, 'dispatching', {}, ctx);
  assert.equal(op.attempt, 2);
  assert.equal(op.externalJobId, undefined);
  assert.equal(op.externalReceipt, undefined);
  const stored = await env.ledger.get(op.operationId);
  assert.equal(stored?.externalJobId, undefined, 'persisted, not only in the returned record');
  op = await env.ledger.transition(op.operationId, 'not_applied', {}, ctx);
  op = await env.ledger.transition(op.operationId, 'dispatching', { externalJobId: 'pre-assigned-3' }, ctx);
  assert.equal(op.externalJobId, 'pre-assigned-3');
});

test('reusing an idempotency key or tool invocation for a different adapter is a conflict', async () => {
  await env.ledger.prepare(input('run-l14', { idempotencyKey: 'key-l14', toolInvocationId: 'sess:14:call-a' }), eventCtx('run-l14'));
  await assert.rejects(env.ledger.prepare(input('run-l14', { idempotencyKey: 'key-l14', adapterId: 'docker' }), eventCtx('run-l14')), (e: unknown) => {
    assert.ok(isHypertestError(e, 'conflict'));
    assert.deepEqual((e.details['requested'] as Record<string, unknown>)['adapterId'], 'docker');
    return true;
  });
  await assert.rejects(env.ledger.prepare(input('run-l14', { toolInvocationId: 'sess:14:call-a', adapterId: 'docker' }), eventCtx('run-l14')), isCode('conflict'));
  assert.equal((await env.ledger.list({ runId: 'run-l14' })).length, 1);
});
