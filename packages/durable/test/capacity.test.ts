/**
 * H6: the local runtime hands out claims only up to its free turn slots (TickOptions.maxDispatch) and keeps a claim that
 * nevertheless waits for a slot alive (ControlPlane.renewClaim), so no claim is requeued as if its worker had died.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryLogger, SequentialIdGenerator, FixedClock, sleep } from '@hypertest/core';
import type { ControlPlane, TickOptions, TickResult, TurnOutcome } from '@hypertest/control';
import type { TestRun } from '@hypertest/domain';
import { LocalDurableRuntime } from '../src/index.ts';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function tickResult(runId: string, dispatched: TickResult['dispatched'], final = false): TickResult {
  return {
    runId, status: final ? 'completed' : 'running', dispatched, waiting: [], replanScheduled: false,
    convergence: final ? { state: 'drained', reason: 'ready_for_gate' } : { state: 'active', runnable: 0, running: dispatched.length, waiting: 0, pendingEvents: 0 }, final, idleMs: final ? 0 : 20,
  };
}

test('H6: ticks carry the free turn slots as maxDispatch; a claim queued behind a busy slot is kept alive until it runs', async () => {
  const run = { runId: 'run_h6', status: 'running' } as TestRun;
  const ticks: Array<TickOptions | undefined> = [];
  const renewals: Array<{ workItemId: string; fencingToken: number }> = [];
  const releaseA = deferred();
  const turns: string[] = [];
  let tickNo = 0;
  let bDone = false;
  const control = {
    deps: { ids: new SequentialIdGenerator(), clock: new FixedClock('2026-01-01T00:00:00.000Z'), logger: new MemoryLogger() },
    async recover() {
      return { reconciled: 0, requeued: [] };
    },
    async tick(runId: string, options?: TickOptions): Promise<TickResult> {
      ticks.push(options);
      tickNo++;
      if (bDone) return tickResult(runId, [], true);
      // tick 1 dispatches A; tick 2 dispatches B although no slot is free (a waiting item resumed meanwhile, another run…)
      if (tickNo === 1) return tickResult(runId, [{ workItemId: 'wi_a', ownerId: 'w', fencingToken: 1 }]);
      if (tickNo === 2) return tickResult(runId, [{ workItemId: 'wi_b', ownerId: 'w', fencingToken: 7 }]);
      return tickResult(runId, []);
    },
    async executeTurn(workItemId: string): Promise<TurnOutcome> {
      turns.push(workItemId);
      if (workItemId === 'wi_a') await releaseA.promise;
      if (workItemId === 'wi_b') bDone = true;
      return { status: 'completed', workItemId };
    },
    async observeWaiting(workItemId: string): Promise<TurnOutcome> {
      return { status: 'completed', workItemId };
    },
    async renewClaim(workItemId: string, fencingToken: number) {
      renewals.push({ workItemId, fencingToken });
      return true;
    },
    async cancelRun() {},
    async pauseRun() {},
    async resumeRun() {},
    async startRun() {
      return run;
    },
    async snapshot() {
      throw new Error('unused');
    },
    async report() {
      throw new Error('unused');
    },
  } as unknown as ControlPlane;
  const rt = new LocalDurableRuntime({ control, listRuns: async () => [run], getRun: async () => run, maxConcurrentTurns: 1, maxIdleMs: 20, claimKeepaliveMs: 15 });
  try {
    await rt.startRun(run.runId);
    // A holds the only slot; B was dispatched anyway and waits for it
    for (let i = 0; i < 200 && renewals.length < 3; i++) await sleep(10);
    assert.equal(ticks[0]?.maxDispatch, 1, 'the first tick may hand out one claim (one free slot)');
    assert.ok(ticks.slice(1).every((t) => t?.maxDispatch === 0), `while A runs (and B waits) no slot is free: ${JSON.stringify(ticks.map((t) => t?.maxDispatch))}`);
    assert.deepEqual(turns, ['wi_a'], 'B has not started: it waits for the slot');
    assert.ok(renewals.length >= 3, 'the queued claim is renewed while it waits');
    assert.ok(renewals.every((r) => r.workItemId === 'wi_b' && r.fencingToken === 7), 'only the waiting claim, with its own token');
    releaseA.resolve();
    const outcome = await rt.awaitCompletion(run.runId, { timeoutMs: 5000 });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(turns, ['wi_a', 'wi_b']);
    const renewedAfter = renewals.length;
    await sleep(60);
    assert.equal(renewals.length, renewedAfter, 'the keepalive stops once the claim has its slot');
  } finally {
    releaseA.resolve();
    await rt.shutdown();
  }
});

test('H6: claimKeepaliveMs is validated', () => {
  const control = { deps: { logger: new MemoryLogger() } } as unknown as ControlPlane;
  assert.throws(() => new LocalDurableRuntime({ control, listRuns: async () => [], maxConcurrentTurns: 1, claimKeepaliveMs: 0 }), /claimKeepaliveMs must be > 0/);
});

test('durability-9: the FIRST executeTurn of a claim already names the turn the dispatch reported (a retried first call never advances twice)', async () => {
  const run = { runId: 'run_d9', status: 'running' } as TestRun;
  const calls: Array<number | undefined> = [];
  let ticks = 0;
  const control = {
    deps: { ids: new SequentialIdGenerator(), clock: new FixedClock('2026-01-01T00:00:00.000Z'), logger: new MemoryLogger() },
    async recover() {
      return { reconciled: 0, requeued: [] };
    },
    async tick(runId: string): Promise<TickResult> {
      ticks++;
      if (calls.length >= 2) return tickResult(runId, [], true);
      return tickResult(runId, ticks === 1 ? [{ workItemId: 'wi_x', ownerId: 'w', fencingToken: 4, nextTurn: 3 }] : []);
    },
    async executeTurn(workItemId: string, _token: number, _signal?: AbortSignal, options?: { expectedTurn?: number }): Promise<TurnOutcome> {
      calls.push(options?.expectedTurn);
      return calls.length === 1 ? { status: 'continue', workItemId, turn: 3 } : { status: 'completed', workItemId };
    },
    async observeWaiting(workItemId: string): Promise<TurnOutcome> {
      return { status: 'completed', workItemId };
    },
    async cancelRun() {},
  } as unknown as ControlPlane;
  const rt = new LocalDurableRuntime({ control, listRuns: async () => [run], getRun: async () => run, maxConcurrentTurns: 2, maxIdleMs: 20 });
  try {
    await rt.startRun(run.runId);
    assert.equal((await rt.awaitCompletion(run.runId, { timeoutMs: 5000 })).status, 'completed');
    assert.deepEqual(calls, [3, 4], 'first call expects turn 3 (the dispatch\'s nextTurn), then 4');
  } finally {
    await rt.shutdown();
  }
});
