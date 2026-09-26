/**
 * Parent side of child-process trials: the progress protocol, exit codes, the real child entry's refusal paths
 * (no Hypertest composed), and the kill/restart helper against a fake child (real processes, real SIGKILL).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import { defaultConfig } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import {
  KILL_POINT_STATES, TRIAL_EXIT_CODES, describeKillPoint, dispatchCount, exitCodeForVerdict, killPointCount, killPointProblems, parseProgress, readProgress, runChildTrial,
  spawnTrialChild, verdictForExitCode, type TrialChildJob,
} from '../src/index.ts';
import { reportedSeq } from '../src/trial-child.ts';
import { TOY_MODULE, toyConfig } from './fixtures/toy.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-child.ts');

describe('progress protocol and exit codes', () => {
  test('parseProgress keeps complete JSON lines only (a torn or trailing partial line is skipped)', () => {
    const text = '{"type":"started","pid":1}\n{"type":"oper\n\n{"type":"completed","pid":1}\n{"type":"par';
    assert.deepEqual(parseProgress(text), [{ type: 'started', pid: 1 }, { type: 'completed', pid: 1 }]);
    assert.deepEqual(parseProgress(''), []);
    assert.deepEqual(readProgress('/nonexistent/progress.jsonl'), []);
  });

  test('verdict ⇄ exit code', () => {
    assert.deepEqual(['pass', 'fail', 'conditional', 'inconclusive', undefined].map((v) => exitCodeForVerdict(v as never)), [0, 1, 2, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 64, 70, null].map(verdictForExitCode), ['pass', 'fail', 'conditional', 'inconclusive', undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual(TRIAL_EXIT_CODES, { pass: 0, fail: 1, conditional: 2, inconclusive: 3, no_verdict: 4, timeout: 5, invalid_job: 64, error: 70 });
  });

  test('dispatchCount counts distinct dispatched operations; reportedSeq is the highest seq reported for the run', () => {
    const lines = [
      { type: 'operation', eventType: 'operation.prepared', runId: 'r', seq: 3, operationId: 'op_1' },
      { type: 'operation', eventType: 'operation.dispatched', runId: 'r', seq: 4, operationId: 'op_1' },
      { type: 'work', eventType: 'work.started', runId: 'r', seq: 9 },
      { type: 'operation', eventType: 'operation.dispatched', runId: 'other', seq: 12, operationId: 'op_2' },
    ] as never[];
    assert.equal(dispatchCount(lines), 2);
    // the ledger emits operation.dispatched on every transition into `dispatching`: a re-dispatch of op_1 (after
    // not_applied) is still ONE dispatched operation, so a kill planned "after the 2nd operation" does not fire early
    const redispatch = [
      ...lines,
      { type: 'operation', eventType: 'operation.not_applied', runId: 'r', seq: 13, operationId: 'op_1' },
      { type: 'operation', eventType: 'operation.dispatched', runId: 'r', seq: 14, operationId: 'op_1' },
    ] as never[];
    assert.equal(dispatchCount(redispatch), 2);
    assert.equal(dispatchCount(lines.slice(0, 2) as never[]), 1);
    return tempDir('ht-eval-seq-').then(async (d) => {
      const f = join(d.path, 'p.jsonl');
      writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"started","runId":"r"}\n');
      assert.equal(reportedSeq(f, 'r'), 9);
      assert.equal(reportedSeq(f, 'nope'), 0);
      await d.cleanup();
    });
  });
});

describe('the real trial child refuses what it cannot run (exit codes + error progress)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-eval-child-')));
  after(async () => dir.cleanup());

  function job(extra: Partial<TrialChildJob> = {}): TrialChildJob {
    return {
      config: defaultConfig({ project: { dataDir: join(dir.path, 'data') } }),
      brainsModule: join(dir.path, 'missing-brains.ts'),
      brainsExport: 'brains',
      mode: 'start',
      input: { goal: 'g', target: {}, runId: 'run_child_test' },
      progressFile: join(dir.path, `progress-${Math.random().toString(16).slice(2)}.jsonl`),
      ...extra,
    };
  }

  test('an invalid job exits 64 with an error line naming every problem', async () => {
    const j = { ...job(), mode: 'sideways', input: { goal: 'g', target: {} } } as unknown as TrialChildJob;
    const p = await spawnTrialChild(j, { jobFile: join(dir.path, 'bad.json') });
    assert.deepEqual(await p.exit, { code: 64, signal: null });
    const [line] = readProgress(j.progressFile);
    assert.equal(line?.type, 'error');
    assert.equal((line as { message: string }).message, "invalid job: mode must be 'start' or 'resume'; input.runId must be a non-empty string (the parent fixes the run id)");
    assert.match(readFileSync(join(dir.path, 'bad.json.out'), 'utf8'), /trial-child: invalid job/);
  });

  test('a brains module that cannot be loaded exits 70 (error line), before anything is composed', async () => {
    const j = job();
    const p = await spawnTrialChild(j, { jobFile: join(dir.path, 'nobrains.json') });
    assert.deepEqual(await p.exit, { code: 70, signal: null });
    const lines = readProgress(j.progressFile);
    assert.deepEqual(lines.map((l) => l.type), ['error']);
    assert.match((lines[0] as { message: string }).message, /missing-brains\.ts/);
    assert.deepEqual(p.progress.map((l) => l.type), ['error'], 'the tail saw the line before the exit resolved');
  });

  test('resume of a run the data directory does not hold exits 70 (composed, nothing driven)', async () => {
    const j = job({
      config: toyConfig(defaultConfig({ project: { dataDir: join(dir.path, 'resume-data') } })),
      brainsModule: TOY_MODULE,
      brainsExport: 'toyBrains',
      brainsArgs: { scenario: 'defect' },
      mode: 'resume',
      input: { goal: 'g', target: {}, runId: 'run_missing' },
    });
    const p = await spawnTrialChild(j, { jobFile: join(dir.path, 'resume.json') });
    assert.deepEqual(await p.exit, { code: 70, signal: null });
    const lines = readProgress(j.progressFile);
    assert.deepEqual(lines.map((l) => l.type), ['started', 'error']);
    assert.equal((lines[1] as { message: string }).message, 'run run_missing does not exist in this data directory');
  });

  test('a brains export of the wrong shape exits 70', async () => {
    const mod = join(dir.path, 'brains.mjs');
    writeFileSync(mod, 'export const brains = { sim: 42 };\n');
    const j = job({ brainsModule: mod });
    const p = await spawnTrialChild(j, { jobFile: join(dir.path, 'shape.json') });
    assert.deepEqual(await p.exit, { code: 70, signal: null });
    assert.match((readProgress(j.progressFile)[0] as { message: string }).message, /must be \(or return\) a record of provider id → brain function/);
  });
});

describe('runChildTrial: kill after the N-th dispatch, then resume (fake child, real SIGKILL)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-eval-kill-')));
  after(async () => dir.cleanup());

  function job(workDir: string, script: Record<string, unknown>): TrialChildJob {
    return {
      config: defaultConfig({ project: { dataDir: join(workDir, 'data') } }),
      brainsModule: 'unused',
      brainsExport: 'unused',
      brainsArgs: script as never,
      mode: 'start',
      input: { goal: 'g', target: {}, runId: 'run_fake' },
      progressFile: join(workDir, 'progress.jsonl'),
      chaos: { injectModelTimeoutOnCall: 2, duplicateEventDelivery: true },
    };
  }

  test('SIGKILL right after the 2nd dispatch; the resumed child (attempt 2, no model-timeout injection) completes', async () => {
    const w = await tempDir('ht-eval-kill-a-');
    try {
      const j = job(w.path, { dispatches: 5, intervalMs: 40, onStart: 'hang', exitCode: 0 });
      const r = await runChildTrial(j, { workDir: w.path, killAfterOperationDispatch: 2, timeoutMs: 20_000, entry: FAKE });
      assert.deepEqual([r.kills, r.chaosExercised, r.timedOut, r.exit], [1, true, false, { code: 0, signal: null }]);
      const first = r.progress.filter((e) => e.pid === r.progress[0]!.pid);
      const second = r.progress.filter((e) => e.pid !== r.progress[0]!.pid);
      assert.deepEqual(first[0], { ...first[0], type: 'started', mode: 'start', attempt: 1 });
      assert.ok(dispatchCount(first) >= 2 && dispatchCount(first) < 5, `killed early: ${dispatchCount(first)} dispatches reported`);
      assert.deepEqual(second.map((e) => e.type), ['started', 'completed']);
      assert.deepEqual(second[0], { ...second[0], mode: 'resume', attempt: 2 });
      const resumed = JSON.parse(readFileSync(join(w.path, 'child-2.json'), 'utf8')) as TrialChildJob;
      assert.deepEqual([resumed.mode, resumed.attempt, resumed.chaos], ['resume', 2, { duplicateEventDelivery: true }]);
      assert.deepEqual(j.chaos, { injectModelTimeoutOnCall: 2, duplicateEventDelivery: true }, 'the caller job is not mutated');
    } finally {
      await w.cleanup();
    }
  });

  test('a re-dispatch of the same operation is not the next operation: the kill waits for the 2nd distinct operation', async () => {
    const w = await tempDir('ht-eval-kill-r-');
    try {
      // op_a is dispatched twice (a re-dispatch after not_applied), then op_b: "after the 2nd operation" means after op_b
      const j = job(w.path, { ids: ['op_a', 'op_a', 'op_a', 'op_b', 'op_c'], intervalMs: 60, onStart: 'hang', exitCode: 0 });
      const r = await runChildTrial(j, { workDir: w.path, killAfterOperationDispatch: 2, timeoutMs: 20_000, entry: FAKE });
      assert.deepEqual([r.kills, r.chaosExercised, r.timedOut, r.exit], [1, true, false, { code: 0, signal: null }]);
      const first = r.progress.filter((e) => e.pid === r.progress[0]!.pid && e.type === 'operation').map((e) => (e.type === 'operation' ? e.operationId : ''));
      assert.deepEqual(first.slice(0, 4), ['op_a', 'op_a', 'op_a', 'op_b'], 'not killed on a re-dispatch of op_a');
      assert.ok(first.length <= 5);
    } finally {
      await w.cleanup();
    }
  });

  test('a run that finishes before the kill point: chaos not exercised, the exit code is the child\'s', async () => {
    const w = await tempDir('ht-eval-kill-b-');
    try {
      const r = await runChildTrial(job(w.path, { dispatches: 1, intervalMs: 5, onStart: 'exit', exitCode: 1 }), { workDir: w.path, killAfterOperationDispatch: 2, timeoutMs: 20_000, entry: FAKE });
      assert.deepEqual([r.kills, r.chaosExercised, r.timedOut, r.exit], [0, false, false, { code: 1, signal: null }]);
    } finally {
      await w.cleanup();
    }
  });

  test('the overall deadline kills a hanging child (timedOut)', async () => {
    const w = await tempDir('ht-eval-kill-c-');
    try {
      const started = Date.now();
      const r = await runChildTrial(job(w.path, { dispatches: 0, onStart: 'hang' }), { workDir: w.path, timeoutMs: 600, entry: FAKE });
      assert.deepEqual([r.kills, r.chaosExercised, r.timedOut, r.exit], [0, true, true, { code: null, signal: 'SIGKILL' }]);
      assert.ok(Date.now() - started < 10_000);
    } finally {
      await w.cleanup();
    }
  });

  test('waitFor: resolves on a match, undefined on timeout or exit; kill() of an exited child resolves with its exit', async () => {
    const w = await tempDir('ht-eval-kill-d-');
    try {
      const p = await spawnTrialChild(job(w.path, { dispatches: 1, intervalMs: 5, onStart: 'hang' }), { jobFile: join(w.path, 'j.json'), entry: FAKE });
      const hit = await p.waitFor((e) => e.type === 'operation', { timeoutMs: 10_000 });
      assert.equal(hit?.type, 'operation');
      assert.equal(await p.waitFor((e) => e.type === 'completed', { timeoutMs: 100 }), undefined);
      const exit = await p.kill();
      assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
      assert.equal(await p.waitFor((e) => e.type === 'completed'), undefined, 'the child exited');
      assert.deepEqual(await p.kill(), exit);
    } finally {
      await w.cleanup();
    }
  });

  test('killAfterOperationDispatch must be a positive integer', async () => {
    await assert.rejects(runChildTrial(job(dir.path, {}), { workDir: dir.path, killAfterOperationDispatch: 0, timeoutMs: 1000, entry: FAKE }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
  });
});

describe('kill points: SIGKILL after an operation reaches a state (type-filtered, ordered, counted over the whole trial)', () => {
  function job(workDir: string, script: Record<string, unknown>): TrialChildJob {
    return {
      config: defaultConfig({ project: { dataDir: join(workDir, 'data') } }),
      brainsModule: 'unused',
      brainsExport: 'unused',
      brainsArgs: script as never,
      mode: 'start',
      input: { goal: 'g', target: {}, runId: 'run_fake' },
      progressFile: join(workDir, 'progress.jsonl'),
    };
  }
  const line = (operationId: string, to: string, operationType?: string) => ({ type: 'operation', runId: 'r', seq: 1, eventType: `operation.${to}`, operationId, from: null, to, ...(operationType ? { operationType } : {}) }) as never;

  test('killPointCount counts distinct operations of the type that reached the state; problems and labels', () => {
    const lines = [line('op_1', 'dispatching', 'env.restart'), line('op_1', 'acknowledged', 'env.restart'), line('op_2', 'dispatching', 'load.start'), line('op_2', 'acknowledged', 'load.start'), line('op_1', 'acknowledged', 'env.restart')];
    assert.equal(killPointCount(lines, { after: 'dispatched' }), 2);
    assert.equal(killPointCount(lines, { after: 'dispatched', operationType: 'load.start' }), 1);
    assert.equal(killPointCount(lines, { after: 'acknowledged', operationType: 'env.restart' }), 1, 'a reconciliation back into the same state is the same operation');
    assert.equal(killPointCount(lines, { after: 'verified' }), 0);
    assert.deepEqual(KILL_POINT_STATES, { dispatched: 'dispatching', acknowledged: 'acknowledged', verified: 'verified' });
    assert.deepEqual(killPointProblems({ after: 'dispatched', operationType: 'load.start', nth: 2, delayMs: 0 }), []);
    assert.deepEqual(killPointProblems({ after: 'sometime', operationType: '', nth: 0, delayMs: -1, downtimeMs: 1.5 }, 'k'), [
      'k.after must be one of dispatched, acknowledged, verified, got sometime', 'k.operationType must be a non-empty string', 'k.nth must be a positive integer, got 0', 'k.delayMs must be a non-negative integer, got -1',
      'k.downtimeMs must be a non-negative integer, got 1.5',
    ]);
    assert.equal(describeKillPoint({ after: 'dispatched', operationType: 'env.restart', delayMs: 400, downtimeMs: 1500 }), 'after dispatched of env.restart + 400 ms, down 1500 ms');
    assert.deepEqual(killPointProblems(null, 'k'), ['k must be an object']);
    assert.equal(describeKillPoint({ after: 'acknowledged', operationType: 'load.start', nth: 2, delayMs: 300 }), 'after acknowledged of load.start #2 + 300 ms');
    assert.equal(describeKillPoint({ after: 'dispatched' }), 'after dispatched of any operation');
  });

  test('two kill points in order: a dispatched restart (not the load dispatch before it), then an acknowledged load job in the resumed child', async () => {
    const w = await tempDir('ht-eval-kp-a-');
    try {
      const j = job(w.path, {
        intervalMs: 150,
        // the load dispatch comes first and must NOT trigger the restart kill point (type filter)
        ops: [{ operationId: 'op_load', operationType: 'load.start', to: 'dispatching' }, { operationId: 'op_rst', operationType: 'env.restart', to: 'dispatching' }, { operationId: 'op_rst', operationType: 'env.restart', to: 'acknowledged' }],
        resumeOps: { '2': [{ operationId: 'op_rst', operationType: 'env.restart', to: 'verified' }, { operationId: 'op_load', operationType: 'load.start', to: 'acknowledged' }, { operationId: 'op_x', operationType: 'load.start', to: 'verified' }] },
        exitCode: 0,
      });
      const r = await runChildTrial(j, {
        workDir: w.path, timeoutMs: 20_000, entry: FAKE,
        kills: [{ after: 'dispatched', operationType: 'env.restart' }, { after: 'acknowledged', operationType: 'load.start' }],
      });
      assert.deepEqual([r.kills, r.killPointsHit, r.chaosExercised, r.timedOut, r.exit], [2, 2, true, false, { code: 0, signal: null }]);
      const pids = [...new Set(r.progress.map((e) => e.pid))];
      assert.equal(pids.length, 3, 'start child, resumed child killed again, final child');
      const ops = (pid: number) => r.progress.filter((e) => e.pid === pid && e.type === 'operation').map((e) => (e.type === 'operation' ? `${e.operationId}:${e.to}` : ''));
      assert.deepEqual(ops(pids[0]!), ['op_load:dispatching', 'op_rst:dispatching'], 'not killed at the load dispatch; killed right after the restart dispatch');
      assert.deepEqual(ops(pids[1]!), ['op_rst:verified', 'op_load:acknowledged'], 'killed right after the load acknowledgement');
      const attempts = r.progress.filter((e) => e.type === 'started').map((e) => (e.type === 'started' ? [e.mode, e.attempt] : []));
      assert.deepEqual(attempts, [['start', 1], ['resume', 2], ['resume', 3]]);
    } finally {
      await w.cleanup();
    }
  });

  test('delayMs: the kill lands that long after the point was reached', async () => {
    const w = await tempDir('ht-eval-kp-d-');
    try {
      const j = job(w.path, { intervalMs: 20, ops: [{ operationId: 'op_1', operationType: 'env.restart', to: 'dispatching' }], exitCode: 0 });
      const started = Date.now();
      const r = await runChildTrial(j, { workDir: w.path, timeoutMs: 20_000, entry: FAKE, kills: [{ after: 'dispatched', delayMs: 400 }] });
      assert.deepEqual([r.kills, r.killPointsHit, r.chaosExercised], [1, 1, true]);
      const hit = r.progress.find((e) => e.type === 'operation')!;
      const resumed = r.progress.filter((e) => e.type === 'started')[1]!;
      assert.ok(Date.parse(resumed.at) - Date.parse(hit.at) >= 350, `resumed ${Date.parse(resumed.at) - Date.parse(hit.at)} ms after the dispatch`);
      assert.ok(Date.now() - started < 15_000);
    } finally {
      await w.cleanup();
    }
  });

  test('downtimeMs: the resumed child starts only that long after the kill (Hypertest stays down; the world moves on)', async () => {
    const w = await tempDir('ht-eval-kp-dt-');
    try {
      const j = job(w.path, { intervalMs: 20, ops: [{ operationId: 'op_1', operationType: 'env.restart', to: 'dispatching' }], exitCode: 0 });
      const r = await runChildTrial(j, { workDir: w.path, timeoutMs: 20_000, entry: FAKE, kills: [{ after: 'dispatched', downtimeMs: 600 }] });
      assert.deepEqual([r.kills, r.killPointsHit, r.chaosExercised, r.exit.code], [1, 1, true, 0]);
      const hit = r.progress.find((e) => e.type === 'operation')!;
      const resumed = r.progress.filter((e) => e.type === 'started')[1]!;
      assert.ok(Date.parse(resumed.at) - Date.parse(hit.at) >= 550, `resumed ${Date.parse(resumed.at) - Date.parse(hit.at)} ms after the kill point`);
    } finally {
      await w.cleanup();
    }
  });

  test('a kill point never reached: the plan stops there (not exercised), the earlier kills count', async () => {
    const w = await tempDir('ht-eval-kp-u-');
    try {
      const j = job(w.path, { intervalMs: 20, ops: [{ operationId: 'op_1', operationType: 'env.restart', to: 'dispatching' }], exitCode: 0 });
      const r = await runChildTrial(j, {
        workDir: w.path, timeoutMs: 20_000, entry: FAKE,
        kills: [{ after: 'dispatched', operationType: 'env.restart' }, { after: 'acknowledged', operationType: 'load.start' }],
      });
      assert.deepEqual([r.kills, r.killPointsHit, r.chaosExercised, r.exit], [1, 1, false, { code: 0, signal: null }]);
    } finally {
      await w.cleanup();
    }
  });

  test('malformed kill points are refused before any child starts', async () => {
    const w = await tempDir('ht-eval-kp-x-');
    try {
      await assert.rejects(runChildTrial(job(w.path, {}), { workDir: w.path, timeoutMs: 1000, entry: FAKE, kills: [{ after: 'never' } as never] }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /kills\[0\]\.after/.test(e.message));
      assert.deepEqual(readProgress(join(w.path, 'progress.jsonl')), [], 'no child was spawned');
    } finally {
      await w.cleanup();
    }
  });
});
