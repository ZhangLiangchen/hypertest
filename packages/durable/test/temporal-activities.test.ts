import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApplicationFailure } from '@temporalio/activity';
import { HypertestError, isHypertestError, type ErrorCode } from '@hypertest/core';
import type { ControlPlane } from '@hypertest/control';
import {
  ACTIVITY_NON_RETRYABLE_ERROR_TYPES, DEFAULT_TEMPORAL_TASK_QUEUE, NON_RETRYABLE_ERROR_CODES, TEMPORAL_WORKFLOWS_PATH, TemporalDurableRuntime, createTemporalActivities,
  isRetryableFault, runWorkflowId, toApplicationFailure, workItemWorkflowId, type TemporalDurableOptions,
} from '../src/index.ts';
import { WORKFLOW_NON_RETRYABLE_ERROR_TYPES } from '../src/temporal/workflows.ts';
import { FakeControl, MemoryWorld, addRun } from './fake-control.ts';

const ALL_CODES: ErrorCode[] = [
  'invalid_argument', 'not_found', 'conflict', 'precondition_failed', 'permission_denied', 'stale_fence', 'stale_context', 'budget_exhausted', 'timeout',
  'cancelled', 'unavailable', 'rate_limited', 'provider_error', 'schema_violation', 'integrity_violation', 'unsupported', 'internal',
];

function failure(e: unknown): ApplicationFailure {
  assert.ok(e instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(e)}`);
  return e;
}

describe('activity error mapping', () => {
  test('HypertestError code ⇒ ApplicationFailure type; nonRetryable exactly for the non-retryable codes', () => {
    const nonRetryable = new Set<string>(NON_RETRYABLE_ERROR_CODES);
    for (const code of ALL_CODES) {
      const f = toApplicationFailure(new HypertestError(code, `boom ${code}`, { details: { k: code } }));
      assert.equal(f.type, code);
      assert.equal(f.message, `boom ${code}`);
      assert.equal(f.nonRetryable, nonRetryable.has(code), code);
      assert.deepEqual(f.details, [{ k: code }]);
    }
    // the spec's minimum set is non-retryable; aborted turns, timeouts and unavailable stores are retried
    for (const code of ['stale_fence', 'permission_denied', 'schema_violation', 'invalid_argument'] as const) assert.equal(isRetryableFault(new HypertestError(code, 'x')), false, code);
    for (const code of ['cancelled', 'timeout', 'unavailable', 'conflict', 'internal'] as const) assert.equal(isRetryableFault(new HypertestError(code, 'x')), true, code);
  });

  test('anything else is a retryable internal failure; an ApplicationFailure passes through', () => {
    const f = toApplicationFailure(new TypeError('x is undefined'));
    assert.equal(f.type, 'internal');
    assert.equal(f.nonRetryable, false);
    assert.equal(f.message, 'x is undefined');
    const g = toApplicationFailure('plain string');
    assert.equal(g.type, 'internal');
    assert.equal(g.message, 'plain string');
    const a = ApplicationFailure.nonRetryable('keep me', 'custom');
    assert.equal(toApplicationFailure(a), a);
  });

  test('the workflow retry policy and the activity mapping use the same non-retryable list', () => {
    assert.deepEqual([...WORKFLOW_NON_RETRYABLE_ERROR_TYPES], [...NON_RETRYABLE_ERROR_CODES]);
    assert.deepEqual([...ACTIVITY_NON_RETRYABLE_ERROR_TYPES], [...NON_RETRYABLE_ERROR_CODES]);
  });
});

describe('createTemporalActivities', () => {
  test('each activity calls exactly its ControlPlane method; executeTurn passes expectedTurn only when set', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_1', [{ workItemId: 'wi_1', turns: 2, waitAfterTurn: 1, waitPolls: 1 }]);
    const control = new FakeControl({ instance: 'p1', store });
    const acts = createTemporalActivities(control, { resolveClaim: (id) => control.claimOf(id) });
    assert.deepEqual(await acts.recover('run_1'), { reconciled: 0, requeued: [] });
    const t = await acts.tick('run_1');
    assert.deepEqual(t.dispatched, [{ workItemId: 'wi_1', ownerId: 'p1', fencingToken: 1 }]);
    assert.equal(await acts.resolveClaim('wi_1'), 1);
    assert.deepEqual(await acts.executeTurn({ workItemId: 'wi_1', fencingToken: 1 }), { status: 'waiting', workItemId: 'wi_1', operationIds: ['op-wi_1'] });
    assert.deepEqual(await acts.observeWaiting('wi_1'), { status: 'continue', workItemId: 'wi_1', turn: 1 });
    // a retried activity whose turn already committed replays it
    assert.deepEqual(await acts.executeTurn({ workItemId: 'wi_1', fencingToken: 1, expectedTurn: 1 }), { status: 'continue', workItemId: 'wi_1', turn: 1 });
    assert.deepEqual(await acts.executeTurn({ workItemId: 'wi_1', fencingToken: 1, expectedTurn: 2 }), { status: 'completed', workItemId: 'wi_1' });
    await acts.cancelRun('run_1', 'why');
    assert.deepEqual(control.callsOf('executeTurn').map((c) => [c.expectedTurn, c.result]), [[undefined, 'waiting'], [1, 'continue'], [2, 'completed']]);
    assert.ok(!('expectedTurn' in control.callsOf('executeTurn')[0]!), 'no expectedTurn option when the workflow knows none');
    assert.deepEqual(control.callsOf('cancelRun').map((c) => c.reason), ['why']);
    assert.equal(await acts.resolveClaim('wi_1'), null, 'terminal item: no claim');
  });

  test('faults surface as ApplicationFailures; resolveClaim without a hook (or a non-integer) is null', async () => {
    const control = new FakeControl({ instance: 'p1', store: new MemoryWorld() });
    const acts = createTemporalActivities(control);
    await assert.rejects(acts.tick('run_missing'), (e: unknown) => failure(e).type === 'not_found' && failure(e).nonRetryable === true);
    control.hooks.inject = (c) => {
      if (c.op === 'executeTurn') throw new HypertestError('stale_fence', 'token 3 < 4');
      if (c.op === 'observeWaiting') throw new HypertestError('unavailable', 'db down');
    };
    await assert.rejects(acts.executeTurn({ workItemId: 'wi', fencingToken: 3 }), (e: unknown) => failure(e).type === 'stale_fence' && failure(e).nonRetryable && /token 3 < 4/.test(failure(e).message));
    await assert.rejects(acts.observeWaiting('wi'), (e: unknown) => failure(e).type === 'unavailable' && !failure(e).nonRetryable);
    assert.equal(await acts.resolveClaim('wi'), null);
    const odd = createTemporalActivities(control, { resolveClaim: async () => 1.5 });
    assert.equal(await odd.resolveClaim('wi'), null);
  });

  test('claimAfterResume: with the hook the claim this worker holds now (re-taken token, or null), without it the known token', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_2', [{ workItemId: 'wi_2', turns: 2, waitAfterTurn: 1, waitPolls: 1 }]);
    const control = new FakeControl({ instance: 'p1', store, retakeOnObserve: true });
    const hooked = createTemporalActivities(control, { resolveClaim: (id) => control.claimOf(id) });
    const bare = createTemporalActivities(control);
    await hooked.tick('run_2');
    assert.equal((await hooked.executeTurn({ workItemId: 'wi_2', fencingToken: 1 })).status, 'waiting');
    assert.deepEqual(await hooked.observeWaiting('wi_2'), { status: 'continue', workItemId: 'wi_2', turn: 1 }); // re-took: token 2
    assert.equal(await hooked.claimAfterResume({ workItemId: 'wi_2', fencingToken: 1 }), 2, 'the hook wins over the known token');
    assert.equal(await hooked.claimAfterResume({ workItemId: 'wi_2' }), 2);
    assert.equal(await bare.claimAfterResume({ workItemId: 'wi_2', fencingToken: 1 }), 1, 'no hook: the known token');
    assert.equal(await bare.claimAfterResume({ workItemId: 'wi_2' }), null, 'no hook, no known token: none');
    assert.equal(await createTemporalActivities(control, { resolveClaim: async () => undefined }).claimAfterResume({ workItemId: 'wi_2', fencingToken: 1 }), null, 'the hook says this worker holds no claim');
    control.hooks.inject = (c) => {
      if (c.op === 'claimOf') throw new HypertestError('unavailable', 'db down');
    };
    await assert.rejects(hooked.claimAfterResume({ workItemId: 'wi_2' }), (e: unknown) => failure(e).type === 'unavailable' && !failure(e).nonRetryable);
  });
});

describe('TemporalDurableRuntime (no server)', () => {
  const control = new FakeControl({ instance: 'p1', store: new MemoryWorld() });
  const base: TemporalDurableOptions = { control, listRuns: () => control.listRuns(), address: '127.0.0.1:7233' };

  test('ids, paths and defaults', () => {
    assert.equal(runWorkflowId('run_1'), 'run-run_1');
    assert.equal(workItemWorkflowId('wi_1', 7), 'wi-wi_1-7');
    assert.equal(workItemWorkflowId('wi_1'), 'wi-wi_1-observe');
    assert.match(TEMPORAL_WORKFLOWS_PATH, /packages\/durable\/src\/temporal\/workflows\.ts$/);
    const rt = new TemporalDurableRuntime(base);
    assert.equal(rt.kind, 'temporal');
    assert.equal(rt.taskQueue, DEFAULT_TEMPORAL_TASK_QUEUE);
  });

  test('options are validated before any connection', async () => {
    const bad = (o: Partial<TemporalDurableOptions>, re: RegExp) => assert.throws(() => new TemporalDurableRuntime({ ...base, ...o }), (e: unknown) => isHypertestError(e, 'invalid_argument') && re.test((e as Error).message));
    bad({ address: '' }, /address is required/);
    bad({ workerMode: 'sidecar' as 'external' }, /workerMode must be 'embedded' or 'external'/);
    bad({ maxWorkflowIterations: 0 }, /maxWorkflowIterations must be an integer ≥ 1/);
    bad({ maxConcurrentActivities: 0 }, /maxConcurrentActivities must be an integer ≥ 1/);
    bad({ maxIdleMs: 0 }, /maxIdleMs must be an integer ≥ 1 \(got 0\)/);
    bad({ maxIdleMs: 2.5 }, /maxIdleMs must be an integer ≥ 1/);
    bad({ control: undefined as unknown as ControlPlane }, /control is required/);
    const rt = new TemporalDurableRuntime(base);
    await assert.rejects(rt.startRun(''), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await assert.rejects(rt.signal('run_1', { type: 'cancel', reason: '' }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /reason is required/.test((e as Error).message));
    await assert.rejects(rt.awaitCompletion('run_1', { timeoutMs: Number.NaN }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await rt.shutdown(); // never connected: nothing to close
    await assert.rejects(rt.startRun('run_1'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /shut down/.test((e as Error).message));
  });
});
