import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError, MemoryLogger, isHypertestError, sleep } from '@hypertest/core';
import type { ControlPlane, TickResult } from '@hypertest/control';
import { createTestDatabase } from '@hypertest/store';
import { DEFAULT_MAX_ATTEMPTS, LocalDurableRuntime, ZERO_IDLE_STREAK, type LocalDurableOptions } from '../src/index.ts';
import { FAKE_WORLD_MIGRATIONS, FakeControl, Gate, MemoryWorld, SqlWorld, addRun, decisionFor, turnsOf, until, type WorldStore } from './fake-control.ts';

function runtime(control: FakeControl, overrides: Partial<LocalDurableOptions> = {}): LocalDurableRuntime {
  return new LocalDurableRuntime({
    control,
    listRuns: () => control.listRuns(),
    getRun: (id) => control.getRun(id),
    maxConcurrentTurns: 4,
    maxIdleMs: 50,
    ...overrides,
  });
}

function rejectsCode(code: string, pattern?: RegExp): (e: unknown) => boolean {
  return (e: unknown) => {
    assert.ok(isHypertestError(e), `expected a HypertestError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  };
}

/** executeTurn calls of an item as [expectedTurn, result] pairs. */
function turnCalls(c: FakeControl, workItemId: string): Array<[number | undefined, string | undefined]> {
  return c.callsOf('executeTurn', workItemId).map((x) => [x.expectedTurn, x.result]);
}

describe('LocalDurableRuntime: driving a run to completion', () => {
  test('recover once, tick, turns while continue (each call names the expected turn), waiting polled with backoff, final outcome', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_a', [
      { workItemId: 'wi_a', turns: 3, waitAfterTurn: 2, waitPolls: 2 },
      { workItemId: 'wi_b', turns: 3 },
    ]);
    const control = new FakeControl({ instance: 'p1', store });
    const rt = runtime(control);
    try {
      await rt.startRun('run_a');
      await rt.startRun('run_a'); // idempotent: one loop per run
      const outcome = await rt.awaitCompletion('run_a', { timeoutMs: 10_000 });
      assert.deepEqual(outcome, { runId: 'run_a', status: 'completed', decision: decisionFor('run_a') });
      const world = await store.read();
      assert.deepEqual(turnsOf(world, 'wi_a'), [1, 2, 3]);
      assert.deepEqual(turnsOf(world, 'wi_b'), [1, 2, 3]);
      assert.equal(world.log.filter((e) => e.kind === 'replay').length, 0);
      assert.deepEqual(turnCalls(control, 'wi_a'), [[undefined, 'continue'], [2, 'waiting'], [3, 'completed']]);
      assert.deepEqual(turnCalls(control, 'wi_b'), [[undefined, 'continue'], [2, 'continue'], [3, 'completed']]);
      assert.deepEqual(control.callsOf('observeWaiting', 'wi_a').map((c) => c.result), ['waiting', 'continue']);
      assert.equal(control.callsOf('recover').length, 1);
      // the loop is gone: no further control calls; a second awaitCompletion answers from the control plane
      const calls = control.calls.length;
      await sleep(120);
      assert.equal(control.calls.length, calls);
      assert.deepEqual(await rt.awaitCompletion('run_a'), outcome);
    } finally {
      await rt.shutdown();
    }
  });

  test('turns are bounded by maxConcurrentTurns across the runtime', async () => {
    for (const max of [1, 2]) {
      const store = new MemoryWorld();
      await addRun(store, 'run_c', ['w1', 'w2', 'w3', 'w4'].map((id) => ({ workItemId: id, turns: 2 })));
      const control = new FakeControl({ instance: 'p1', store, turnMs: 15 });
      const rt = runtime(control, { maxConcurrentTurns: max });
      try {
        await rt.startRun('run_c');
        assert.equal((await rt.awaitCompletion('run_c', { timeoutMs: 10_000 })).status, 'completed');
        assert.equal(control.maxInFlightTurns, max, `maxConcurrentTurns ${max}`);
        assert.equal(control.callsOf('executeTurn').length, 8);
      } finally {
        await rt.shutdown();
      }
    }
  });

  test('signal wake ends an idle wait at once; maxIdleMs bounds the idle the control plane suggests', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_w', [{ workItemId: 'wi_w', turns: 1 }], { status: 'paused' });
    const control = new FakeControl({ instance: 'p1', store, idleMs: 60_000 });
    const rt = runtime(control, { maxIdleMs: 60_000 });
    try {
      await rt.startRun('run_w');
      await until(() => control.callsOf('tick').length >= 1);
      await assert.rejects(rt.awaitCompletion('run_w', { timeoutMs: 150 }), rejectsCode('timeout', /run run_w did not complete within 150ms/));
      assert.equal(control.callsOf('tick').length, 1, 'the loop waits the suggested idle time');
      await control.resumeRun('run_w');
      const t0 = Date.now();
      await rt.signal('run_w', { type: 'wake' });
      assert.equal((await rt.awaitCompletion('run_w', { timeoutMs: 5000 })).status, 'completed');
      assert.ok(Date.now() - t0 < 2000, 'woken, not after the 60 s idle');
    } finally {
      await rt.shutdown();
    }

    const store2 = new MemoryWorld();
    await addRun(store2, 'run_i', [{ workItemId: 'wi_i', turns: 1 }], { status: 'paused' });
    const control2 = new FakeControl({ instance: 'p1', store: store2, idleMs: 60_000 });
    const rt2 = runtime(control2, { maxIdleMs: 30 });
    try {
      await rt2.startRun('run_i');
      await sleep(300);
      assert.ok(control2.callsOf('tick').length >= 4, `ticks every ≤ 30 ms (got ${control2.callsOf('tick').length})`);
      await control2.resumeRun('run_i'); // no wake: the bounded idle picks it up
      assert.equal((await rt2.awaitCompletion('run_i', { timeoutMs: 5000 })).status, 'completed');
    } finally {
      await rt2.shutdown();
    }
  });

  test('cancel: control.cancelRun first, in-flight turns aborted, the run finishes cancelled', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_x', [{ workItemId: 'wi_x', turns: 3 }]);
    const gate = new Gate();
    const control = new FakeControl({ instance: 'p1', store, hooks: { beforeCommit: (id, turn, signal) => (turn === 2 ? gate.wait(signal) : Promise.resolve()) } });
    const rt = runtime(control);
    try {
      await rt.startRun('run_x');
      await gate.reached();
      await rt.signal('run_x', { type: 'cancel', reason: 'operator stop' });
      const outcome = await rt.awaitCompletion('run_x', { timeoutMs: 5000 });
      assert.deepEqual(outcome, { runId: 'run_x', status: 'cancelled' });
      assert.deepEqual(control.callsOf('cancelRun').map((c) => c.reason), ['operator stop']);
      assert.deepEqual(turnCalls(control, 'wi_x'), [[undefined, 'continue'], [2, 'throw:cancelled']]);
      assert.deepEqual(turnsOf(await store.read(), 'wi_x'), [1]);
    } finally {
      await rt.shutdown();
    }
  });

  test('resumeIncomplete drives created/running/converging/gating runs only (paused waits for an operator, terminal is done)', async () => {
    const store = new MemoryWorld();
    const statuses = ['created', 'running', 'converging', 'gating', 'paused', 'completed', 'failed', 'cancelled'] as const;
    for (const s of statuses) await addRun(store, `run_${s}`, [{ workItemId: `wi_${s}`, turns: 1 }], { status: s });
    const control = new FakeControl({ instance: 'p1', store });
    const rt = runtime(control);
    try {
      const resumed = await rt.resumeIncomplete();
      assert.deepEqual(resumed, ['run_created', 'run_running', 'run_converging', 'run_gating']);
      for (const id of resumed) assert.equal((await rt.awaitCompletion(id, { timeoutMs: 5000 })).status, 'completed');
      assert.deepEqual(control.callsOf('recover').map((c) => c.runId).sort(), [...resumed].sort());
      assert.equal(control.callsOf('executeTurn', 'wi_paused').length, 0);
      assert.equal(control.callsOf('tick').filter((c) => c.runId === 'run_paused').length, 0);
    } finally {
      await rt.shutdown();
    }
  });
});

describe('LocalDurableRuntime: crash safety (two runtimes over the same database)', () => {
  for (const when of ['beforeCommit', 'afterCommit'] as const) {
    test(`a process killed mid-turn (${when}) loses nothing: a new runtime resumes the run and no turn runs twice`, async () => {
      const { db, dispose } = await createTestDatabase({ migrations: FAKE_WORLD_MIGRATIONS });
      try {
        const store: WorldStore = await SqlWorld.open(db, `crash-${when}`);
        await addRun(store, 'run_k', [
          { workItemId: 'wi_a', turns: 3 },
          { workItemId: 'wi_b', turns: 3 },
        ]);
        const gate = new Gate(); // never opened: the turn only ends by the crash
        const hook = (id: string, turn: number, signal: AbortSignal) => (id === 'wi_b' && turn === 2 ? gate.wait(signal) : Promise.resolve());
        const p1 = new FakeControl({ instance: 'p1', store, hooks: { [when]: hook } });
        const rt1 = runtime(p1);
        await rt1.startRun('run_k');
        const pending = rt1.awaitCompletion('run_k');
        await gate.reached();
        await until(async () => turnsOf(await store.read(), 'wi_a').length === 3, 5000, 'wi_a completed');
        // observed before the shutdown: `pending` rejects while shutdown() still waits for the loops (an unobserved
        // rejection across macrotasks would be reported as unhandled)
        const rejected = assert.rejects(pending, rejectsCode('cancelled', /shut down/)); // from the loop or the status poll, whichever settles first
        const t0 = Date.now();
        await rt1.shutdown(); // the "crash": loops aborted, the blocked turn aborted
        assert.ok(Date.now() - t0 < 2000, 'shutdown does not wait for the blocked turn');
        await rejected;
        await assert.rejects(rt1.startRun('run_k'), rejectsCode('precondition_failed', /shut down/));
        const afterCrash = await store.read();
        assert.deepEqual(turnsOf(afterCrash, 'wi_b'), when === 'afterCommit' ? [1, 2] : [1]);
        assert.equal(afterCrash.runs['run_k']!.items['wi_b']!.state, 'running');

        // a new process: new control instance (its in-memory claims are empty), same database
        const p2 = new FakeControl({ instance: 'p2', store });
        const rt2 = runtime(p2);
        try {
          assert.deepEqual(await rt2.resumeIncomplete(), ['run_k']);
          const outcome = await rt2.awaitCompletion('run_k', { timeoutMs: 10_000 });
          assert.deepEqual(outcome, { runId: 'run_k', status: 'completed', decision: decisionFor('run_k') });
          const world = await store.read();
          assert.deepEqual(turnsOf(world, 'wi_a'), [1, 2, 3], 'wi_a: every turn exactly once');
          assert.deepEqual(turnsOf(world, 'wi_b'), [1, 2, 3], 'wi_b: every turn exactly once');
          assert.deepEqual(world.log.filter((e) => e.kind === 'turn' && e.workItemId === 'wi_b').map((e) => e.instance), when === 'afterCommit' ? ['p1', 'p1', 'p2'] : ['p1', 'p2', 'p2']);
          // recovery requeued exactly the orphaned item; the finished item is never touched again
          assert.deepEqual(p2.callsOf('recover').map((c) => c.result), ['wi_b']);
          assert.equal(p2.callsOf('executeTurn', 'wi_a').length, 0);
          assert.equal(p2.callsOf('executeTurn', 'wi_b').at(-1)!.result, 'completed');
          assert.equal(world.runs['run_k']!.items['wi_b']!.attempts, 1);
        } finally {
          await rt2.shutdown();
        }
      } finally {
        await dispose();
      }
    });
  }

  for (const withHook of [true, false]) {
    test(`a crash while an item waits on an operation: the new runtime observes it and ${withHook ? 'continues under the re-taken claim (resolveClaim)' : 'resumes it through lease expiry (no resolveClaim)'}`, async () => {
      const { db, dispose } = await createTestDatabase({ migrations: FAKE_WORLD_MIGRATIONS });
      try {
        const store = await SqlWorld.open(db, `wait-${withHook}`);
        await addRun(store, 'run_q', [{ workItemId: 'wi_q', turns: 3, waitAfterTurn: 1, waitPolls: 1_000_000 }]);
        const p1 = new FakeControl({ instance: 'p1', store });
        const rt1 = runtime(p1);
        await rt1.startRun('run_q');
        await until(() => p1.callsOf('observeWaiting', 'wi_q').length >= 1, 5000, 'waiting observed');
        await rt1.shutdown();
        // the operation settles while no process runs
        await store.mutate((w) => {
          w.runs['run_q']!.items['wi_q']!.waitPolls = 0;
        });
        const p2 = new FakeControl({ instance: 'p2', store, leaseTtlMs: 200 });
        const logger = new MemoryLogger();
        const rt2 = runtime(p2, withHook ? { resolveClaim: (id) => p2.claimOf(id), logger } : { logger });
        try {
          await rt2.resumeIncomplete();
          assert.equal((await rt2.awaitCompletion('run_q', { timeoutMs: 10_000 })).status, 'completed');
          const world = await store.read();
          assert.deepEqual(turnsOf(world, 'wi_q'), [1, 2, 3]);
          const item = world.runs['run_q']!.items['wi_q']!;
          const retakes = world.log.filter((e) => e.kind === 'retake').map((e) => e.instance);
          assert.deepEqual(retakes, ['p2'], 'recover re-took the waiting claim (no requeue)');
          if (withHook) {
            assert.equal(item.attempts, 0);
            const retake = world.log.find((e) => e.kind === 'retake') as { token: number };
            assert.deepEqual(p2.callsOf('claimOf').map((c) => c.result), [String(retake.token)]);
          } else {
            assert.equal(item.attempts, 1, 'one work attempt spent: lease expiry ⇒ requeue');
            assert.deepEqual(world.log.filter((e) => e.kind === 'requeue').map((e) => (e as { reason: string }).reason), ['lease_expired']);
            assert.ok(logger.entries.some((e) => /no claim token for a resumed work item/.test(e.msg)));
          }
        } finally {
          await rt2.shutdown();
        }
      } finally {
        await dispose();
      }
    });
  }
});

describe('LocalDurableRuntime: faults and outcomes', () => {
  test('a retryable fault after a committed turn: the retry carries expectedTurn and replays instead of advancing twice', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_r', [{ workItemId: 'wi_r', turns: 3 }]);
    let failed = false;
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        afterCommit: async (id, turn) => {
          if (turn === 2 && !failed) {
            failed = true;
            throw new HypertestError('unavailable', 'connection reset after commit');
          }
        },
      },
    });
    const rt = runtime(control);
    try {
      await rt.startRun('run_r');
      assert.equal((await rt.awaitCompletion('run_r', { timeoutMs: 5000 })).status, 'completed');
      const world = await store.read();
      assert.deepEqual(turnsOf(world, 'wi_r'), [1, 2, 3]);
      assert.deepEqual(turnCalls(control, 'wi_r'), [[undefined, 'continue'], [2, 'throw:unavailable'], [2, 'continue'], [3, 'completed']]);
      assert.deepEqual(world.log.filter((e) => e.kind === 'replay'), [{ kind: 'replay', workItemId: 'wi_r', expectedTurn: 2, committed: 2, instance: 'p1' }]);
    } finally {
      await rt.shutdown();
    }
  });

  test('a non-retryable fault stops the work loop at once (no retry); the item resumes through lease expiry', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_n', [{ workItemId: 'wi_n', turns: 2 }]);
    let thrown = 0;
    const control = new FakeControl({
      instance: 'p1',
      store,
      leaseTtlMs: 150,
      hooks: {
        inject: (c) => {
          if (c.op === 'executeTurn' && c.workItemId === 'wi_n' && thrown === 0) {
            thrown++;
            throw new HypertestError('permission_denied', 'policy refused the turn');
          }
        },
      },
    });
    const logger = new MemoryLogger();
    const rt = runtime(control, { logger });
    try {
      await rt.startRun('run_n');
      assert.equal((await rt.awaitCompletion('run_n', { timeoutMs: 5000 })).status, 'completed');
      const calls = control.callsOf('executeTurn', 'wi_n');
      assert.equal(calls[0]!.result, 'throw:permission_denied');
      assert.notEqual(calls[1]!.fencingToken, calls[0]!.fencingToken, 'the next call is under a new claim, not a retry');
      assert.equal((await store.read()).runs['run_n']!.items['wi_n']!.attempts, 1);
      const gaveUp = logger.entries.find((e) => /work loop gave up/.test(e.msg));
      assert.equal(gaveUp?.level, 'error');
      assert.equal(gaveUp?.fields['code'], 'permission_denied');
    } finally {
      await rt.shutdown();
    }
  });

  test('retryable faults are retried at most maxAttempts times per call', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_m', [{ workItemId: 'wi_m', turns: 1 }]);
    const control = new FakeControl({
      instance: 'p1',
      store,
      leaseTtlMs: 150,
      hooks: {
        inject: (c) => {
          if (c.op === 'executeTurn' && c.fencingToken === 1) throw new HypertestError('timeout', 'model call timed out');
        },
      },
    });
    const rt = runtime(control, { maxAttempts: 3 });
    try {
      await rt.startRun('run_m');
      assert.equal((await rt.awaitCompletion('run_m', { timeoutMs: 5000 })).status, 'completed');
      assert.deepEqual(control.callsOf('executeTurn', 'wi_m').map((c) => [c.fencingToken, c.result]), [[1, 'throw:timeout'], [1, 'throw:timeout'], [1, 'throw:timeout'], [2, 'completed']]);
      assert.equal(DEFAULT_MAX_ATTEMPTS, 5);
    } finally {
      await rt.shutdown();
    }
  });

  test('lease_lost stops the work loop: the stale claim is never used again', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_l', [{ workItemId: 'wi_l', turns: 3 }]);
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        afterCommit: async (id, turn) => {
          // another worker takes the item over after turn 1 and finishes it
          if (turn === 1) {
            await store.mutate((w) => {
              const item = w.runs['run_l']!.items['wi_l']!;
              item.token = 999;
            });
            setTimeout(() => void store.mutate((w) => {
              w.runs['run_l']!.items['wi_l']!.state = 'completed';
            }), 50);
          }
        },
      },
    });
    const rt = runtime(control);
    try {
      await rt.startRun('run_l');
      assert.equal((await rt.awaitCompletion('run_l', { timeoutMs: 5000 })).status, 'completed');
      assert.deepEqual(turnCalls(control, 'wi_l'), [[undefined, 'continue'], [2, 'lease_lost']]);
      assert.deepEqual(turnsOf(await store.read(), 'wi_l'), [1]);
    } finally {
      await rt.shutdown();
    }
  });

  test('observeWaiting re-took the claim under a new token: one resolveClaim lookup right after the resume continues the item without a requeue', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_t', [{ workItemId: 'wi_t', turns: 3, waitAfterTurn: 1, waitPolls: 1 }]);
    const control = new FakeControl({ instance: 'p1', store, retakeOnObserve: true });
    const rt = runtime(control, { resolveClaim: (id) => control.claimOf(id) });
    try {
      await rt.startRun('run_t');
      assert.equal((await rt.awaitCompletion('run_t', { timeoutMs: 5000 })).status, 'completed');
      const world = await store.read();
      assert.deepEqual(turnsOf(world, 'wi_t'), [1, 2, 3]);
      assert.equal(world.runs['run_t']!.items['wi_t']!.attempts, 0);
      const calls = control.callsOf('executeTurn', 'wi_t');
      // the claim is looked up right after the resume: no call under the superseded token
      assert.deepEqual(calls.map((c) => [c.fencingToken, c.expectedTurn, c.result]), [[1, undefined, 'waiting'], [2, 2, 'continue'], [2, 3, 'completed']]);
      assert.deepEqual(control.callsOf('claimOf').map((c) => c.result), ['2']);
    } finally {
      await rt.shutdown();
    }
  });

  test('lease_lost after a resume never adopts a newer claim: the item re-dispatched meanwhile has exactly one driver', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_d', [{ workItemId: 'wi_d', turns: 3, waitAfterTurn: 1, waitPolls: 1 }]);
    let stale: { result?: string } | undefined;
    const control: FakeControl = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        beforeBegin: async (c) => {
          if (c.workItemId !== 'wi_d') return;
          if (!stale && c.fencingToken === 1 && c.expectedTurn === 2) {
            // the first turn after the resume: the lease lapses before the call is fenced; the scheduler requeues the item
            // and re-dispatches it to this same worker (new token) before the old call learns it lost the claim
            stale = c;
            await store.mutate((w) => FakeControl.requeue(w, 'wi_d'));
            await until(async () => (await store.read()).runs['run_d']!.items['wi_d']!.token === 2, 5000, 're-dispatched');
            return;
          }
          // the new claim's calls wait until the stale call settled (deterministic order)
          if (c.fencingToken === 2) await until(() => stale?.result !== undefined, 5000, 'stale call settled');
        },
      },
    });
    const rt = runtime(control, { resolveClaim: (id) => control.claimOf(id) });
    try {
      await rt.startRun('run_d');
      assert.equal((await rt.awaitCompletion('run_d', { timeoutMs: 5000 })).status, 'completed');
      const calls = control.callsOf('executeTurn', 'wi_d').map((c) => [c.fencingToken, c.expectedTurn, c.result]);
      // token 1 stops at lease_lost; token 2 is driven by the work loop the tick started for it, and by nobody else
      assert.deepEqual(calls.filter((c) => c[0] === 1), [[1, undefined, 'waiting'], [1, 2, 'lease_lost']]);
      assert.deepEqual(calls.filter((c) => c[0] === 2), [[2, undefined, 'continue'], [2, 3, 'completed']]);
      assert.deepEqual(turnsOf(await store.read(), 'wi_d'), [1, 2, 3]);
      assert.deepEqual(control.callsOf('claimOf').map((c) => c.result), ['1'], 'looked up once, right after the resume');
    } finally {
      await rt.shutdown();
    }
  });

  test('observeWaiting answering lease_lost (another worker still holds the waiting item) keeps polling with backoff; the item resumes under its claim', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_o', [{ workItemId: 'wi_o', turns: 2, waitAfterTurn: 1, waitPolls: 1, observeLeaseLost: 2 }]);
    const control = new FakeControl({ instance: 'p1', store }); // no lease TTL: an item without a driver would hang
    const logger = new MemoryLogger();
    const rt = runtime(control, { logger }); // no resolveClaim hook: the known token is the only way to continue
    try {
      await rt.startRun('run_o');
      assert.equal((await rt.awaitCompletion('run_o', { timeoutMs: 10_000 })).status, 'completed');
      assert.deepEqual(control.callsOf('observeWaiting', 'wi_o').map((c) => c.result), ['lease_lost', 'lease_lost', 'continue']);
      assert.deepEqual(turnCalls(control, 'wi_o'), [[undefined, 'waiting'], [2, 'completed']]);
      assert.equal(control.callsOf('executeTurn', 'wi_o').every((c) => c.fencingToken === 1), true);
      assert.equal((await store.read()).runs['run_o']!.items['wi_o']!.attempts, 0);
      assert.ok(!logger.entries.some((e) => /no claim token/.test(e.msg)), 'one work loop polled throughout (no observer restarted without a token)');
    } finally {
      await rt.shutdown();
    }
  });

  test('startRun while the failed loop still stops (a turn slow to honour the abort) waits for it, then drives the run again', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_s', [{ workItemId: 'wi_s', turns: 2 }]);
    let broken = true;
    let ticks = 0;
    let recoveredWhileTurnInFlight = false;
    const control: FakeControl = new FakeControl({
      instance: 'p1',
      store,
      leaseTtlMs: 150,
      hooks: {
        inject: (c) => {
          if (c.op === 'tick' && ++ticks === 2 && broken) throw new HypertestError('integrity_violation', 'evidence chain broken');
          if (c.op === 'recover' && control.inFlightTurns > 0) recoveredWhileTurnInFlight = true;
        },
        // the first turn ignores the abort for 300 ms
        beforeCommit: async (id, turn) => {
          if (control.callsOf('executeTurn', id).length === 1) await sleep(300);
        },
      },
    });
    const rt = runtime(control);
    try {
      await rt.startRun('run_s');
      await assert.rejects(rt.awaitCompletion('run_s', { timeoutMs: 5000 }), rejectsCode('integrity_violation'));
      assert.equal(control.inFlightTurns, 1, 'the aborted turn is still in flight');
      broken = false;
      await rt.startRun('run_s'); // not a no-op: it waits for the stopping loop, then starts a new one
      assert.equal(control.inFlightTurns, 0);
      assert.equal((await rt.awaitCompletion('run_s', { timeoutMs: 5000 })).status, 'completed');
      assert.equal(control.callsOf('recover').length, 2);
      assert.equal(recoveredWhileTurnInFlight, false, 'the new loop never ran next to the old one');
      assert.deepEqual(turnsOf(await store.read(), 'wi_s'), [1, 2]);
    } finally {
      await rt.shutdown();
    }
  });

  test('paused stops the work loop; after resumeRun the item resumes through the scheduler', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_p', [{ workItemId: 'wi_p', turns: 2 }]);
    const control = new FakeControl({
      instance: 'p1',
      store,
      leaseTtlMs: 150,
      hooks: {
        afterCommit: async (id, turn) => {
          if (turn === 1 && control.callsOf('executeTurn', id).length === 1) await control.pauseRun('run_p');
        },
      },
    });
    const rt = runtime(control);
    try {
      await rt.startRun('run_p');
      await until(() => control.callsOf('executeTurn', 'wi_p').some((c) => c.result === 'paused'), 5000, 'paused outcome');
      await sleep(250);
      assert.equal(control.callsOf('executeTurn', 'wi_p').length, 2, 'no turn while paused');
      await control.resumeRun('run_p');
      await rt.signal('run_p', { type: 'wake' });
      assert.equal((await rt.awaitCompletion('run_p', { timeoutMs: 5000 })).status, 'completed');
      assert.deepEqual(turnsOf(await store.read(), 'wi_p'), [1, 2]);
      assert.deepEqual(control.callsOf('executeTurn', 'wi_p').map((c) => c.result), ['continue', 'paused', 'completed']);
    } finally {
      await rt.shutdown();
    }
  });

  test('recover: unavailable (another live owner) is waited out; a non-retryable tick fault fails awaitCompletion with that fault', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_f', [{ workItemId: 'wi_f', turns: 1 }]);
    let recoverFaults = 0;
    const control = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        inject: (c) => {
          if (c.op === 'recover' && recoverFaults < 7) {
            recoverFaults++;
            throw new HypertestError('unavailable', 'run owned by live worker w2');
          }
          if (c.op === 'tick') throw new HypertestError('integrity_violation', 'evidence chain broken');
        },
      },
    });
    const logger = new MemoryLogger();
    const rt = runtime(control, { maxIdleMs: 10, maxAttempts: 2, logger });
    try {
      await rt.startRun('run_f');
      await assert.rejects(rt.awaitCompletion('run_f', { timeoutMs: 5000 }), rejectsCode('integrity_violation', /evidence chain broken/));
      assert.equal(control.callsOf('recover').length, 8, 'unavailable is retried beyond maxAttempts (standby for the owner)');
      assert.equal(control.callsOf('tick').length, 1, 'a non-retryable tick fault is not retried');
      assert.ok(logger.entries.some((e) => e.level === 'error' && /run loop failed/.test(e.msg) && e.fields['code'] === 'integrity_violation'));
      // the run stays resumable: a new loop can be started once the fault is gone
      delete control.hooks.inject;
      await rt.startRun('run_f');
      assert.equal((await rt.awaitCompletion('run_f', { timeoutMs: 5000 })).status, 'completed');
    } finally {
      await rt.shutdown();
    }
  });

  test('a store outage (tick unavailable) longer than maxAttempts: the run loop stands by and completes the run; other faults still end it', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_u', [{ workItemId: 'wi_u', turns: 2 }]);
    await addRun(store, 'run_v', [{ workItemId: 'wi_v', turns: 1 }]);
    let outage = 8;
    const control: FakeControl = new FakeControl({
      instance: 'p1',
      store,
      hooks: {
        inject: (c) => {
          if (c.op !== 'tick') return;
          // run_u: the first tick dispatches, then the store is down for 8 ticks
          if (c.runId === 'run_u' && control.callsOf('tick').filter((t) => t.runId === 'run_u').length > 1 && outage > 0) {
            outage--;
            throw new HypertestError('unavailable', 'ECONNREFUSED 127.0.0.1:5432');
          }
          if (c.runId === 'run_v') throw new HypertestError('timeout', 'statement timeout');
        },
      },
    });
    const logger = new MemoryLogger();
    const rt = runtime(control, { maxAttempts: 3, maxIdleMs: 20, logger });
    try {
      await rt.startRun('run_u');
      assert.equal((await rt.awaitCompletion('run_u', { timeoutMs: 5000 })).status, 'completed');
      assert.equal(outage, 0);
      assert.equal(control.callsOf('tick').filter((c) => c.result === 'throw:unavailable').length, 8, 'retried past maxAttempts');
      assert.deepEqual(turnsOf(await store.read(), 'wi_u'), [1, 2]);
      assert.equal(logger.entries.filter((e) => e.level === 'warn' && /tick unavailable .*standing by/.test(e.msg)).length, 1, 'one standby warning');
      assert.ok(!logger.entries.some((e) => /run loop failed/.test(e.msg)));
      // any other retryable fault stays bounded by maxAttempts: the loop ends and awaitCompletion reports it
      await rt.startRun('run_v');
      await assert.rejects(rt.awaitCompletion('run_v', { timeoutMs: 5000 }), rejectsCode('timeout', /statement timeout/));
      assert.equal(control.callsOf('tick').filter((c) => c.runId === 'run_v').length, 3);
    } finally {
      await rt.shutdown();
    }
  });

  test('a control plane reporting progress forever cannot spin the loop hot', async () => {
    let ticks = 0;
    const tick: TickResult = { runId: 'run_z', status: 'running', dispatched: [], waiting: [], replanScheduled: false, convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, final: false, idleMs: 0 };
    const control = {
      deps: new FakeControl({ instance: 'x', store: new MemoryWorld() }).deps,
      recover: async () => ({ reconciled: 0, requeued: [] }),
      tick: async () => {
        ticks++;
        return tick;
      },
    } as unknown as ControlPlane;
    const rt = new LocalDurableRuntime({ control, listRuns: async () => [], maxConcurrentTurns: 1 });
    try {
      await rt.startRun('run_z');
      await sleep(260);
    } finally {
      await rt.shutdown();
    }
    assert.ok(ticks >= ZERO_IDLE_STREAK, `it ticked (${ticks})`);
    assert.ok(ticks <= ZERO_IDLE_STREAK * 7, `bounded: ${ticks} ticks in 260 ms`);
  });
});

describe('LocalDurableRuntime: awaitCompletion, validation and shutdown', () => {
  test('awaitCompletion without a loop answers from the control plane; unknown ⇒ not_found; running ⇒ timeout', async () => {
    const store = new MemoryWorld();
    await addRun(store, 'run_done', [{ workItemId: 'wi_d', turns: 1 }], { status: 'completed' });
    await store.mutate((w) => {
      w.runs['run_done']!.decided = true;
    });
    await addRun(store, 'run_live', [{ workItemId: 'wi_l', turns: 1 }], { status: 'running' });
    const control = new FakeControl({ instance: 'p1', store });
    const rt = new LocalDurableRuntime({ control, listRuns: () => control.listRuns(), maxConcurrentTurns: 1 }); // default getRun: listRuns filtered
    try {
      assert.deepEqual(await rt.awaitCompletion('run_done'), { runId: 'run_done', status: 'completed', decision: decisionFor('run_done') });
      await assert.rejects(rt.awaitCompletion('run_nope'), rejectsCode('not_found', /run run_nope not found/));
      await assert.rejects(rt.awaitCompletion('run_live', { timeoutMs: 80 }), rejectsCode('timeout'));
      await assert.rejects(rt.awaitCompletion('run_live', { timeoutMs: -1 }), rejectsCode('invalid_argument'));
      assert.equal(control.callsOf('executeTurn').length, 0, 'awaitCompletion never drives a run');
    } finally {
      await rt.shutdown();
    }
  });

  test('options and arguments are validated', async () => {
    const control = new FakeControl({ instance: 'p1', store: new MemoryWorld() });
    const base = { control, listRuns: () => control.listRuns(), maxConcurrentTurns: 2 };
    assert.throws(() => new LocalDurableRuntime({ ...base, maxConcurrentTurns: 0 }), rejectsCode('invalid_argument', /maxConcurrentTurns must be an integer ≥ 1 \(got 0\)/));
    assert.throws(() => new LocalDurableRuntime({ ...base, maxConcurrentTurns: 1.5 }), rejectsCode('invalid_argument', /maxConcurrentTurns/));
    assert.throws(() => new LocalDurableRuntime({ ...base, maxIdleMs: 0 }), rejectsCode('invalid_argument', /maxIdleMs must be > 0/));
    assert.throws(() => new LocalDurableRuntime({ ...base, maxAttempts: 0 }), rejectsCode('invalid_argument', /maxAttempts/));
    assert.throws(() => new LocalDurableRuntime({ ...base, control: undefined as unknown as ControlPlane }), rejectsCode('invalid_argument', /control is required/));
    assert.throws(() => new LocalDurableRuntime({ ...base, listRuns: undefined as unknown as () => Promise<[]> }), rejectsCode('invalid_argument', /listRuns is required/));
    const rt = new LocalDurableRuntime(base);
    assert.equal(rt.kind, 'local');
    await assert.rejects(rt.startRun(''), rejectsCode('invalid_argument'));
    await assert.rejects(rt.signal('run_1', { type: 'cancel', reason: ' ' }), rejectsCode('invalid_argument', /reason is required/));
    await assert.rejects(rt.signal('run_1', { type: 'pause' } as unknown as { type: 'wake' }), rejectsCode('invalid_argument', /unknown signal type "pause"/));
    assert.equal(control.callsOf('cancelRun').length, 0);
    await rt.signal('run_unknown', { type: 'wake' }); // no loop: a wake is a no-op
    const s1 = rt.shutdown();
    assert.equal(rt.shutdown(), s1, 'shutdown is idempotent');
    await s1;
    await assert.rejects(rt.startRun('run_1'), rejectsCode('precondition_failed'));
    await assert.rejects(rt.awaitCompletion('run_1'), rejectsCode('precondition_failed'));
    await assert.rejects(rt.resumeIncomplete(), rejectsCode('precondition_failed'));
  });
});
