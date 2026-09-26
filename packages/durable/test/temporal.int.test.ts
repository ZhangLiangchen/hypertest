/**
 * TemporalDurableRuntime against a real Temporal server (the local dev server of `npm run infra:up`), driven by the
 * in-memory FakeControl: the workflows, activities, retries, signals, continueAsNew and a worker crash, end to end.
 * Every test uses its own task queue and run ids.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { HypertestError, MemoryLogger, isHypertestError } from '@hypertest/core';
import type { ControlPlane, TickResult } from '@hypertest/control';
import { infraEnv, skipUnless } from '@hypertest/testkit';
import {
  TemporalDurableRuntime, bundleTemporalWorkflows, createTemporalWorker, runWorkflowId, workItemWorkflowId, type TemporalDurableOptions,
} from '../src/index.ts';
import { WORKFLOW_ZERO_IDLE_STREAK } from '../src/temporal/workflows.ts';
import { FakeControl, Gate, MemoryWorld, addRun, decisionFor, turnsOf, until, type WorldStore } from './fake-control.ts';

const address = infraEnv().temporalAddress;
const temporal = skipUnless(address !== undefined, 'HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run `npm run infra:up`)');

let bundle: { code: string };
let connection: Connection | undefined;
let client: Client;
/** Workflow ids started by the tests: terminated best-effort at the end so a failed test leaves nothing running. */
const started = new Set<string>();
/** Task queues of the tests: whatever still runs on them at the end (e.g. after a failed assertion) is terminated too. */
const queues = new Set<string>();

before(async () => {
  if (temporal.skip) return;
  bundle = await bundleTemporalWorkflows();
  connection = await Connection.connect({ address: address! });
  client = new Client({ connection, namespace: 'default' });
});

after(async () => {
  if (!connection) return;
  for (const id of started) await client.workflow.getHandle(id).terminate('test cleanup').catch(() => undefined);
  for (const taskQueue of queues) {
    for await (const wf of client.workflow.list({ query: `TaskQueue = '${taskQueue}' AND ExecutionStatus = 'Running'` })) {
      await client.workflow.getHandle(wf.workflowId).terminate('test cleanup').catch(() => undefined);
    }
  }
  await connection.close();
});

function unique(): string {
  return randomBytes(5).toString('hex');
}

function newRuntime(control: FakeControl, taskQueue: string, extra: Partial<TemporalDurableOptions> = {}, options: { resolveClaim?: boolean } = {}): TemporalDurableRuntime {
  queues.add(taskQueue);
  const o: TemporalDurableOptions = {
    control,
    listRuns: () => control.listRuns(),
    getRun: (id) => control.getRun(id),
    address: address!,
    taskQueue,
    workflowBundle: bundle,
    logger: new MemoryLogger(),
    ...extra,
  };
  if (options.resolveClaim !== false) o.resolveClaim = (id) => control.claimOf(id);
  return new TemporalDurableRuntime(o);
}

/** The child workflow ids of an item (one per claim it was executed under). */
function childIds(c: FakeControl, workItemId: string): string[] {
  const tokens = [...new Set(c.callsOf('executeTurn', workItemId).map((x) => x.fencingToken!))];
  return tokens.map((t) => workItemWorkflowId(workItemId, t));
}

function track(runId: string, ...controls: FakeControl[]): void {
  started.add(runWorkflowId(runId));
  for (const c of controls) for (const call of c.callsOf('executeTurn')) started.add(workItemWorkflowId(call.workItemId!, call.fencingToken));
}

async function statusOf(workflowId: string): Promise<string | undefined> {
  return (await client.workflow.getHandle(workflowId).describe()).status.name;
}

async function exists(workflowId: string): Promise<boolean> {
  try {
    await client.workflow.getHandle(workflowId).describe();
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === 'WorkflowNotFoundError') return false;
    throw e;
  }
}

async function continuedAsNew(workflowId: string): Promise<boolean> {
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  const attrs = history.events?.[0]?.workflowExecutionStartedEventAttributes;
  return typeof attrs?.continuedExecutionRunId === 'string' && attrs.continuedExecutionRunId.length > 0;
}

describe('TemporalDurableRuntime (Temporal server)', { concurrency: false }, () => {
  test('a run with two work items (3 turns each, one waiting phase) runs to completion; the histories replay deterministically', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const [A, B] = [`wi_${s}_a`, `wi_${s}_b`];
    const store = new MemoryWorld();
    await addRun(store, runId, [
      { workItemId: A, turns: 3, waitAfterTurn: 2, waitPolls: 2 },
      { workItemId: B, turns: 3 },
    ]);
    const control = new FakeControl({ instance: 'p1', store });
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      await rt.startRun(runId); // idempotent: the same workflow id
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 60_000 });
      track(runId, control);
      assert.deepEqual(outcome, { runId, status: 'completed', decision: decisionFor(runId) });
      const world = await store.read();
      assert.deepEqual(turnsOf(world, A), [1, 2, 3]);
      assert.deepEqual(turnsOf(world, B), [1, 2, 3]);
      assert.deepEqual(control.callsOf('executeTurn', A).map((c) => [c.expectedTurn, c.result]), [[undefined, 'continue'], [2, 'waiting'], [3, 'completed']]);
      assert.deepEqual(control.callsOf('executeTurn', B).map((c) => [c.expectedTurn, c.result]), [[undefined, 'continue'], [2, 'continue'], [3, 'completed']]);
      assert.deepEqual(control.callsOf('observeWaiting', A).map((c) => c.result), ['waiting', 'continue']);
      assert.equal(control.callsOf('recover').length, 1);
      for (const id of [...childIds(control, A), ...childIds(control, B)]) {
        assert.equal(await statusOf(id), 'COMPLETED', id);
      }
      assert.deepEqual(await client.workflow.getHandle(childIds(control, A)[0]!).result(), { workItemId: A, status: 'completed' });
      // determinism: the recorded histories replay against the same workflow code
      await Worker.runReplayHistory({ workflowBundle: bundle }, await client.workflow.getHandle(runWorkflowId(runId)).fetchHistory());
      await Worker.runReplayHistory({ workflowBundle: bundle }, await client.workflow.getHandle(childIds(control, A)[0]!).fetchHistory());
    } finally {
      await rt.shutdown();
    }
  });

  for (const when of ['beforeCommit', 'afterCommit'] as const) {
    test(`worker crash mid-turn (${when}): a new worker finishes the run; only unfinished work is re-invoked and no turn advances twice`, temporal, async () => {
      const s = unique();
      const runId = `run_${s}`;
      const [A, B] = [`wi_${s}_a`, `wi_${s}_b`];
      const taskQueue = `ht-durable-${s}`;
      const store: WorldStore = new MemoryWorld();
      await addRun(store, runId, [
        { workItemId: A, turns: 3 },
        { workItemId: B, turns: 3, waitAfterTurn: 1, waitPolls: 1 },
      ]);
      const gate = new Gate(); // never opened: B's turn 2 only ends by the crash
      const p1 = new FakeControl({ instance: 'p1', store, hooks: { [when]: (id: string, turn: number, signal: AbortSignal) => (id === B && turn === 2 ? gate.wait(signal) : Promise.resolve()) } });
      const rt1 = newRuntime(p1, taskQueue);
      let rt2: TemporalDurableRuntime | undefined;
      try {
        await rt1.startRun(runId);
        await gate.reached();
        await until(async () => turnsOf(await store.read(), A).length === 3, 30_000, 'A completed');
        await until(() => p1.callsOf('executeTurn', A).at(-1)?.result === 'completed', 30_000, 'A reported');
        await rt1.shutdown(); // the crash: the worker stops; B's in-flight activity is aborted and fails (retryable)
        track(runId, p1);
        assert.equal(p1.callsOf('executeTurn', B).at(-1)!.result, 'throw:cancelled');
        assert.deepEqual(turnsOf(await store.read(), B), when === 'afterCommit' ? [1, 2] : [1]);

        const p2 = new FakeControl({ instance: 'p2', store }); // a new process over the same truth
        rt2 = newRuntime(p2, taskQueue);
        assert.deepEqual(await rt2.resumeIncomplete(), [runId]); // the workflow is still running: start is a no-op
        const outcome = await rt2.awaitCompletion(runId, { timeoutMs: 90_000 });
        track(runId, p2);
        assert.deepEqual(outcome, { runId, status: 'completed', decision: decisionFor(runId) });
        const world = await store.read();
        assert.deepEqual(turnsOf(world, A), [1, 2, 3], 'A: each turn once');
        assert.deepEqual(turnsOf(world, B), [1, 2, 3], 'B: each turn once');
        // the new worker re-invoked only B's unfinished turn (same claim, same expected turn), never A
        assert.equal(p2.callsOf('executeTurn', A).length + p2.callsOf('observeWaiting', A).length, 0);
        const first = p2.callsOf('executeTurn', B)[0]!;
        assert.deepEqual([first.fencingToken, first.expectedTurn], [p1.callsOf('executeTurn', B)[0]!.fencingToken, 2]);
        assert.equal(first.result, 'continue');
        // after a lost result the retried activity replays the committed turn instead of running turn 3 in its place
        const replays = world.log.filter((e) => e.kind === 'replay');
        assert.deepEqual(replays, when === 'afterCommit' ? [{ kind: 'replay', workItemId: B, expectedTurn: 2, committed: 2, instance: 'p2' }] : []);
        assert.deepEqual(world.log.filter((e) => e.kind === 'turn' && e.workItemId === B).map((e) => e.instance), when === 'afterCommit' ? ['p1', 'p1', 'p2'] : ['p1', 'p2', 'p2']);
        assert.deepEqual(p1.callsOf('observeWaiting', B).map((c) => c.result), ['continue'], 'the waiting phase before the crash');
        assert.deepEqual(p2.callsOf('executeTurn', B).map((c) => c.result).filter((r) => r === 'completed'), ['completed']);
        assert.equal(p2.callsOf('executeTurn', B).at(-1)!.result, 'completed', 'nothing runs after completion');
        assert.equal(p1.callsOf('recover').length + p2.callsOf('recover').length, 1, 'the workflow survived: recover ran once');
      } finally {
        await rt1.shutdown();
        await rt2?.shutdown();
      }
    });
  }

  test('cancel signal: control.cancelRun, the final tick reports cancelled, in-flight children are cancelled', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const B = `wi_${s}_b`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: B, turns: 3 }]);
    const gate = new Gate();
    const control = new FakeControl({ instance: 'p1', store, hooks: { beforeCommit: (id, turn, signal) => (turn === 2 ? gate.wait(signal) : Promise.resolve()) } });
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      await gate.reached();
      track(runId, control);
      await rt.signal(runId, { type: 'cancel', reason: 'operator abort' });
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 60_000 });
      assert.deepEqual(outcome, { runId, status: 'cancelled' });
      assert.deepEqual(control.callsOf('cancelRun').map((c) => c.reason), ['operator abort']);
      const [child] = childIds(control, B);
      assert.deepEqual(await client.workflow.getHandle(child!).result(), { workItemId: B, status: 'cancelled' });
      assert.deepEqual(turnsOf(await store.read(), B), [1]);
    } finally {
      await rt.shutdown();
    }
  });

  test('continueAsNew bounds both histories: in-flight children survive the parent continuing, the run completes exactly once per turn', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const [A, B] = [`wi_${s}_a`, `wi_${s}_b`];
    const store = new MemoryWorld();
    await addRun(store, runId, [
      { workItemId: A, turns: 3, waitAfterTurn: 1, waitPolls: 4 },
      { workItemId: B, turns: 5 },
    ]);
    const control = new FakeControl({ instance: 'p1', store, idleMs: 40 });
    const rt = newRuntime(control, `ht-durable-${s}`, { maxWorkflowIterations: 3 });
    try {
      await rt.startRun(runId);
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 90_000 });
      track(runId, control);
      assert.equal(outcome.status, 'completed');
      const world = await store.read();
      assert.deepEqual(turnsOf(world, A), [1, 2, 3]);
      assert.deepEqual(turnsOf(world, B), [1, 2, 3, 4, 5]);
      assert.equal(control.callsOf('recover').length, 1, 'recover is not repeated by continueAsNew');
      assert.equal(await continuedAsNew(runWorkflowId(runId)), true, 'the run workflow continued as new');
      assert.equal(await continuedAsNew(childIds(control, A)[0]!), true, 'the waiting child continued as new');
      assert.equal(await continuedAsNew(childIds(control, B)[0]!), true, 'the long child continued as new');
      assert.deepEqual(control.callsOf('executeTurn', B).map((c) => c.expectedTurn), [undefined, 2, 3, 4, 5], 'expectedTurn is carried across continueAsNew');
      assert.equal(new Set(control.callsOf('executeTurn').map((c) => c.fencingToken)).size, 2, 'one claim per item: no requeue');
      // a child continuing as new stays one tracked child (its close event only comes with the end of its chain): the
      // run workflow never started a second driver (an observer) for the waiting item
      assert.equal(await exists(workItemWorkflowId(A)), false, 'no observer child for A');
      assert.equal(control.callsOf('claimOf', A).length, 1, 'one resume of A, by its own child');
    } finally {
      await rt.shutdown();
    }
  });

  test('activity faults: retryable ones are retried by the policy; a non-retryable one fails the run workflow, which resumeIncomplete starts again', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: `wi_${s}`, turns: 1 }]);
    let transient = 2;
    let broken = false;
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        inject: (c) => {
          if (c.op !== 'tick') return;
          if (transient > 0) {
            transient--;
            throw new HypertestError('unavailable', 'database restarting');
          }
          if (broken) throw new HypertestError('integrity_violation', 'evidence chain broken');
        },
      },
    });
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      track(runId);
      assert.equal((await rt.awaitCompletion(runId, { timeoutMs: 60_000 })).status, 'completed');
      assert.deepEqual(control.callsOf('tick').slice(0, 3).map((c) => c.result), ['throw:unavailable', 'throw:unavailable', 'dispatched:' + `wi_${s}`]);

      const run2 = `run_${s}_2`;
      await addRun(store, run2, [{ workItemId: `wi_${s}_2`, turns: 1 }]);
      broken = true;
      const ticks = control.callsOf('tick').length;
      await rt.startRun(run2);
      track(run2);
      await assert.rejects(rt.awaitCompletion(run2, { timeoutMs: 60_000 }), (e: unknown) => isHypertestError(e, 'integrity_violation') && /the workflow of run .* failed: evidence chain broken/.test((e as Error).message));
      assert.equal(control.callsOf('tick').length - ticks, 1, 'non-retryable: the activity is not retried');
      assert.equal(await statusOf(runWorkflowId(run2)), 'FAILED');
      broken = false;
      assert.deepEqual(await rt.resumeIncomplete(), [run2]);
      assert.equal((await rt.awaitCompletion(run2, { timeoutMs: 60_000 })).status, 'completed');
      assert.equal(control.callsOf('recover').filter((c) => c.runId === run2).length, 2, 'the new execution recovers again');
    } finally {
      await rt.shutdown();
    }
  });

  test('external worker mode, idempotent starts, awaitCompletion fallbacks and timeouts', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const taskQueue = `ht-durable-${s}`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: `wi_${s}`, turns: 2 }]);
    await addRun(store, `run_${s}_paused`, [{ workItemId: `wi_${s}_p`, turns: 1 }], { status: 'paused' });
    await addRun(store, `run_${s}_done`, [{ workItemId: `wi_${s}_d`, turns: 1 }], { status: 'completed' });
    await store.mutate((w) => {
      w.runs[`run_${s}_done`]!.decided = true;
    });
    await addRun(store, `run_${s}_orphan`, [{ workItemId: `wi_${s}_o`, turns: 1 }], { status: 'running' });
    const control = new FakeControl({ instance: 'p1', store });
    const rt = newRuntime(control, taskQueue, { workerMode: 'external' });
    const worker = await createTemporalWorker({ control, address: address!, taskQueue, workflowBundle: bundle, logger: new MemoryLogger() });
    assert.equal(worker.taskQueue, taskQueue);
    try {
      await rt.start();
      await rt.startRun(runId);
      await rt.startRun(runId);
      track(runId);
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 60_000 });
      assert.deepEqual(outcome, { runId, status: 'completed', decision: decisionFor(runId) });
      await rt.startRun(runId); // completed workflow: not started again (duplicates allowed after a failure only)
      assert.deepEqual(await rt.awaitCompletion(runId), outcome);
      assert.equal(control.callsOf('recover').filter((c) => c.runId === runId).length, 1);

      // a paused run's workflow idles: awaitCompletion times out; a cancel ends it
      await rt.startRun(`run_${s}_paused`);
      track(`run_${s}_paused`);
      await assert.rejects(rt.awaitCompletion(`run_${s}_paused`, { timeoutMs: 400 }), (e: unknown) => isHypertestError(e, 'timeout') && /did not complete within 400ms/.test((e as Error).message));
      await rt.signal(`run_${s}_paused`, { type: 'wake' });
      await rt.signal(`run_${s}_paused`, { type: 'cancel', reason: 'abandoned' });
      assert.deepEqual(await rt.awaitCompletion(`run_${s}_paused`, { timeoutMs: 60_000 }), { runId: `run_${s}_paused`, status: 'cancelled' });

      // no workflow: a terminal run answers from the control plane; a live one is not_found; unknown is not_found
      assert.deepEqual(await rt.awaitCompletion(`run_${s}_done`), { runId: `run_${s}_done`, status: 'completed', decision: decisionFor(`run_${s}_done`) });
      await assert.rejects(rt.awaitCompletion(`run_${s}_orphan`), (e: unknown) => isHypertestError(e, 'not_found') && /has no workflow; startRun or resumeIncomplete drives it/.test((e as Error).message));
      await assert.rejects(rt.awaitCompletion(`run_${s}_nope`), (e: unknown) => isHypertestError(e, 'not_found') && /not found/.test((e as Error).message));
      // a cancel without a workflow goes straight to the control plane
      await rt.signal(`run_${s}_orphan`, { type: 'cancel', reason: 'no workflow' });
      assert.deepEqual(control.callsOf('cancelRun').map((c) => [c.runId, c.reason]), [[`run_${s}_paused`, 'abandoned'], [`run_${s}_orphan`, 'no workflow']]);
      assert.equal((await control.getRun(`run_${s}_orphan`))!.status, 'cancelled');
    } finally {
      await rt.shutdown();
      await worker.shutdown();
      await worker.done;
    }
    await assert.rejects(rt.startRun(runId), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  });

  test('a run workflow that fails cancels its in-flight children: the restarted workflow is the only driver of their items', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const A = `wi_${s}_a`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: A, turns: 2 }]);
    const gate = new Gate(); // never opened: the first turn only ends when its activity is cancelled
    let broken = false;
    const control: FakeControl = new FakeControl({
      instance: 'p1',
      store,
      leaseTtlMs: 400,
      hooks: {
        inject: (c) => {
          if (c.op === 'tick' && broken) throw new HypertestError('integrity_violation', 'evidence chain broken');
        },
        beforeCommit: (id, turn, signal) => (control.callsOf('executeTurn', id).length === 1 ? gate.wait(signal) : Promise.resolve()),
      },
    });
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      await gate.reached();
      const child = workItemWorkflowId(A, 1);
      track(runId, control);
      broken = true; // the next tick fails the run workflow (non-retryable) while the child is mid-turn
      await assert.rejects(rt.awaitCompletion(runId, { timeoutMs: 60_000 }), (e: unknown) => isHypertestError(e, 'integrity_violation'));
      // the failed execution asked its child to cancel: the child does not keep driving the item untracked
      await until(async () => (await statusOf(child)) !== 'RUNNING', 20_000, 'the child of the failed execution closed');
      assert.deepEqual(await client.workflow.getHandle(child).result(), { workItemId: A, status: 'cancelled' });
      broken = false;
      assert.deepEqual(await rt.resumeIncomplete(), [runId]);
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 60_000 });
      track(runId, control);
      assert.equal(outcome.status, 'completed');
      assert.deepEqual(turnsOf(await store.read(), A), [1, 2], 'each turn once');
      // the item (its lease lapsed) was re-dispatched under a new claim to exactly one new child
      assert.deepEqual([...new Set(control.callsOf('executeTurn', A).map((c) => c.fencingToken))], [1, 2]);
      assert.deepEqual(control.callsOf('executeTurn', A).filter((c) => c.fencingToken === 2).map((c) => [c.expectedTurn, c.result]), [[undefined, 'continue'], [2, 'completed']]);
      assert.equal(await statusOf(workItemWorkflowId(A, 2)), 'COMPLETED');
    } finally {
      await rt.shutdown();
    }
  });

  test('a child cancelled or terminated by an operator while its item waits: the run workflow observes the item again (no stale tracking)', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const [A, B] = [`wi_${s}_a`, `wi_${s}_b`];
    const store = new MemoryWorld();
    await addRun(store, runId, [
      { workItemId: A, turns: 2, waitAfterTurn: 1, waitPolls: 1_000_000 },
      { workItemId: B, turns: 2, waitAfterTurn: 1, waitPolls: 1_000_000 },
    ]);
    const control = new FakeControl({ instance: 'p1', store }); // no lease TTL: an unobserved waiting item waits forever
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      await until(() => control.callsOf('observeWaiting', A).length >= 1 && control.callsOf('observeWaiting', B).length >= 1, 30_000, 'both waiting');
      track(runId, control);
      const [childA, childB] = [workItemWorkflowId(A, 1), workItemWorkflowId(B, 2)];
      await client.workflow.getHandle(childA).cancel();
      await client.workflow.getHandle(childB).terminate('operator');
      await until(async () => (await statusOf(childA)) !== 'RUNNING' && (await statusOf(childB)) !== 'RUNNING', 20_000, 'children closed');
      assert.equal(await statusOf(childB), 'TERMINATED');
      await store.mutate((w) => {
        for (const id of [A, B]) w.runs[runId]!.items[id]!.waitPolls = 0; // the operations settle
      });
      const outcome = await rt.awaitCompletion(runId, { timeoutMs: 30_000 });
      started.add(workItemWorkflowId(A)).add(workItemWorkflowId(B));
      assert.equal(outcome.status, 'completed');
      for (const id of [A, B]) {
        assert.deepEqual(turnsOf(await store.read(), id), [1, 2]);
        // an observer child took over the waiting item and continued under its (unchanged) claim
        assert.deepEqual(await client.workflow.getHandle(workItemWorkflowId(id)).result(), { workItemId: id, status: 'completed' });
      }
      assert.deepEqual(control.callsOf('executeTurn', A).map((c) => [c.fencingToken, c.expectedTurn, c.result]), [[1, undefined, 'waiting'], [1, 2, 'completed']]);
    } finally {
      await rt.shutdown();
    }
  });

  test('recover standby: `unavailable` (another live owner) is waited out beyond the retry policy; a cancel during the standby is not delayed', temporal, async () => {
    const s = unique();
    const [run1, run2] = [`run_${s}_1`, `run_${s}_2`];
    const store = new MemoryWorld();
    await addRun(store, run1, [{ workItemId: `wi_${s}_1`, turns: 1 }]);
    await addRun(store, run2, [{ workItemId: `wi_${s}_2`, turns: 1 }]);
    let run1Faults = 6; // more than the 5 attempts of the activity retry policy
    let run2Owned = true;
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        inject: (c) => {
          if (c.op !== 'recover') return;
          if (c.runId === run1 && run1Faults > 0) {
            run1Faults--;
            throw new HypertestError('unavailable', `run ${run1} is owned by live worker w2`);
          }
          if (c.runId === run2 && run2Owned) throw new HypertestError('unavailable', `run ${run2} is owned by live worker w2`);
        },
      },
    });
    const rt = newRuntime(control, `ht-durable-${s}`, { maxIdleMs: 100 });
    try {
      await rt.startRun(run1);
      track(run1);
      assert.equal((await rt.awaitCompletion(run1, { timeoutMs: 60_000 })).status, 'completed');
      assert.deepEqual(control.callsOf('recover').filter((c) => c.runId === run1).map((c) => c.result), [...Array(6).fill('throw:unavailable'), '']);

      await rt.startRun(run2);
      track(run2);
      await until(() => control.callsOf('recover').filter((c) => c.runId === run2).length >= 2, 30_000, 'standing by');
      await rt.signal(run2, { type: 'cancel', reason: 'operator stop' });
      await until(() => control.callsOf('cancelRun').length === 1, 10_000, 'cancelRun during the standby');
      assert.equal(control.callsOf('recover').filter((c) => c.runId === run2).every((c) => c.result === 'throw:unavailable'), true, 'still standing by');
      assert.equal(control.callsOf('tick').filter((c) => c.runId === run2).length, 0, 'no tick before recover');
      run2Owned = false;
      assert.deepEqual(await rt.awaitCompletion(run2, { timeoutMs: 60_000 }), { runId: run2, status: 'cancelled' });
      assert.equal(control.callsOf('recover').filter((c) => c.runId === run2).at(-1)!.result, '', 'recover still ran (it reconciles the run whatever its status)');
      assert.deepEqual(control.callsOf('cancelRun').map((c) => [c.runId, c.reason]), [[run2, 'operator stop']]);
    } finally {
      await rt.shutdown();
    }
  });

  test('a store outage longer than the activity retry policy: the run workflow stands by instead of failing, then completes the run', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: `wi_${s}`, turns: 1 }]);
    let outage = 6; // one more than the policy's 5 attempts of one tick activity
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        inject: (c) => {
          if (c.op === 'tick' && outage > 0) {
            outage--;
            throw new HypertestError('unavailable', 'ECONNREFUSED 127.0.0.1:5432');
          }
        },
      },
    });
    const rt = newRuntime(control, `ht-durable-${s}`, { maxIdleMs: 100 });
    try {
      await rt.startRun(runId);
      track(runId);
      assert.deepEqual(await rt.awaitCompletion(runId, { timeoutMs: 90_000 }), { runId, status: 'completed', decision: decisionFor(runId) });
      assert.equal(await statusOf(runWorkflowId(runId)), 'COMPLETED', 'one execution: never failed');
      assert.deepEqual(control.callsOf('tick').slice(0, 7).map((c) => c.result), [...Array(6).fill('throw:unavailable'), `dispatched:wi_${s}`]);
      assert.equal(control.callsOf('recover').length, 1, 'not restarted');
    } finally {
      await rt.shutdown();
    }
  });

  test('a control plane reporting progress forever: the run workflow yields every WORKFLOW_ZERO_IDLE_STREAK ticks (timers in its history)', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const nonFinal = 2 * WORKFLOW_ZERO_IDLE_STREAK + 5;
    let ticks = 0;
    const active: TickResult = { runId, status: 'running', dispatched: [], waiting: [], replanScheduled: false, convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, final: false, idleMs: 0 };
    const control = {
      deps: new FakeControl({ instance: 'x', store: new MemoryWorld() }).deps,
      recover: async () => ({ reconciled: 0, requeued: [] }),
      tick: async (): Promise<TickResult> => (++ticks <= nonFinal ? active : { ...active, status: 'completed', final: true, convergence: { state: 'drained', reason: 'plan_drained' } }),
      cancelRun: async () => undefined,
    } as unknown as ControlPlane;
    queues.add(`ht-durable-${s}`);
    const rt = new TemporalDurableRuntime({ control, listRuns: async () => [], address: address!, taskQueue: `ht-durable-${s}`, workflowBundle: bundle, logger: new MemoryLogger() });
    try {
      await rt.startRun(runId);
      track(runId);
      assert.deepEqual(await rt.awaitCompletion(runId, { timeoutMs: 60_000 }), { runId, status: 'completed' });
      assert.equal(ticks, nonFinal + 1);
      const history = await client.workflow.getHandle(runWorkflowId(runId)).fetchHistory();
      const timers = (history.events ?? []).filter((e) => e.timerStartedEventAttributes);
      assert.equal(timers.length, 2, 'one yield after each streak of zero-idle ticks');
      await Worker.runReplayHistory({ workflowBundle: bundle }, history);
    } finally {
      await rt.shutdown();
    }
  });

  test('observeWaiting re-took the claim under a new token: the child continues under it right after the resume (no call under the old token)', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const T = `wi_${s}_t`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: T, turns: 3, waitAfterTurn: 1, waitPolls: 1 }]);
    const control = new FakeControl({ instance: 'p1', store, retakeOnObserve: true });
    const rt = newRuntime(control, `ht-durable-${s}`);
    try {
      await rt.startRun(runId);
      assert.equal((await rt.awaitCompletion(runId, { timeoutMs: 60_000 })).status, 'completed');
      track(runId, control);
      assert.deepEqual(control.callsOf('executeTurn', T).map((c) => [c.fencingToken, c.expectedTurn, c.result]), [[1, undefined, 'waiting'], [2, 2, 'continue'], [2, 3, 'completed']]);
      assert.deepEqual(control.callsOf('claimOf', T).map((c) => c.result), ['2']);
      assert.equal((await store.read()).runs[runId]!.items[T]!.attempts, 0);
    } finally {
      await rt.shutdown();
    }
  });

  test('observeWaiting answering lease_lost keeps the child polling: the item resumes under its claim without an observer restart (no resolveClaim)', temporal, async () => {
    const s = unique();
    const runId = `run_${s}`;
    const O = `wi_${s}_o`;
    const store = new MemoryWorld();
    await addRun(store, runId, [{ workItemId: O, turns: 2, waitAfterTurn: 1, waitPolls: 1, observeLeaseLost: 2 }]);
    const control = new FakeControl({ instance: 'p1', store }); // no lease TTL: an item without a driver would hang
    const rt = newRuntime(control, `ht-durable-${s}`, {}, { resolveClaim: false });
    try {
      await rt.startRun(runId);
      assert.equal((await rt.awaitCompletion(runId, { timeoutMs: 30_000 })).status, 'completed');
      track(runId, control);
      assert.deepEqual(control.callsOf('observeWaiting', O).map((c) => c.result), ['lease_lost', 'lease_lost', 'continue']);
      assert.deepEqual(control.callsOf('executeTurn', O).map((c) => [c.fencingToken, c.expectedTurn, c.result]), [[1, undefined, 'waiting'], [1, 2, 'completed']]);
      assert.equal(await exists(workItemWorkflowId(O)), false, 'no observer child was needed');
    } finally {
      await rt.shutdown();
    }
  });
});

describe('durability-5: the agent-turn activity bound is the runtime\'s (long tools finish; liveness is the heartbeat)', { concurrency: false }, () => {
  test('the default bound exceeds the longest tool timeouts; a turn longer than a configured bound is cut, one within it completes', temporal, async () => {
    const { DEFAULT_TURN_ACTIVITY_TIMEOUT_MS } = await import('../src/temporal/workflows.ts');
    // test.run ≤ 1 h, mutation.run ≤ 2 h per call: the old fixed 10-minute bound cut every longer turn
    assert.ok(DEFAULT_TURN_ACTIVITY_TIMEOUT_MS >= 2 * 60 * 60 * 1000 + 10 * 60 * 1000, `default ${DEFAULT_TURN_ACTIVITY_TIMEOUT_MS} ms`);
    for (const [bound, expectDone] of [[1000, false], [20_000, true]] as const) {
      const s = unique();
      const runId = `run_${s}`;
      const store = new MemoryWorld();
      await addRun(store, runId, [{ workItemId: `wi_${s}`, turns: 1 }]);
      // every turn takes 2.5 s of work (heartbeating meanwhile)
      const control = new FakeControl({ instance: 'p1', store, turnMs: 2500 });
      const rt = newRuntime(control, `ht-dur5-${s}`, { turnTimeoutMs: bound });
      try {
        await rt.startRun(runId);
        track(runId, control);
        if (expectDone) {
          const outcome = await rt.awaitCompletion(runId, { timeoutMs: 60_000 });
          assert.equal(outcome.status, 'completed', `bound ${bound} ms`);
        } else {
          // every attempt is cut at 1 s: the turn never commits (the child gives up after its retry policy)
          await until(async () => control.callsOf('executeTurn').length >= 2, 60_000);
          const world = await store.read();
          assert.deepEqual(turnsOf(world, `wi_${s}`), [], 'no attempt within a 1 s bound could finish a 2.5 s turn');
        }
      } finally {
        await rt.shutdown();
      }
    }
  });
});
