/**
 * Suite aggregation, paired comparisons, the markdown report, and runSuite's orchestration (paired seeds, seeded arm
 * order, one fresh trial directory each) — hermetic: the tasks' setups fail, so no Hypertest is composed.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { mcnemarExact, renderSuiteReport, runSuite, seededShuffle, summarizeSuite, trialSeed, type EvalArm, type EvalTrial, type TrialContext } from '../src/index.ts';
import { task } from './helpers.ts';

function trial(taskId: string, armId: string, n: number, result: EvalTrial['result'], extra: Partial<EvalTrial> = {}): EvalTrial {
  return { taskId, armId, trial: n, seed: `s${n}`, result, graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 100, ...extra };
}

describe('summarizeSuite', () => {
  // task A: arm x passes 3/3, arm y 1/3 (one infra error); task B: x 2/3, y 0/3
  const trials: EvalTrial[] = [
    trial('A', 'x', 0, 'pass', { outcomeMetrics: { criticalFalseRelease: 0, defectRecall: 1 }, trajectoryMetrics: { toolCalls: 10 } }),
    trial('A', 'x', 1, 'pass', { outcomeMetrics: { criticalFalseRelease: 0, defectRecall: 1 }, trajectoryMetrics: { toolCalls: 20 } }),
    trial('A', 'x', 2, 'pass', { outcomeMetrics: { criticalFalseRelease: 0, defectRecall: 1 } }),
    trial('A', 'y', 0, 'pass', { outcomeMetrics: { criticalFalseRelease: 0, defectRecall: 1 } }),
    trial('A', 'y', 1, 'fail', { outcomeMetrics: { criticalFalseRelease: 1, defectRecall: 0 }, graders: [{ graderId: 'verdict', pass: false, score: 0, detail: 'verdict pass (expected fail)' }] }),
    trial('A', 'y', 2, 'infra_error', { error: 'setup failed', outcomeMetrics: { criticalFalseRelease: 1 } }),
    trial('B', 'x', 0, 'pass', { outcomeMetrics: { criticalFalseRelease: 0 } }),
    trial('B', 'x', 1, 'fail', { outcomeMetrics: { criticalFalseRelease: 0 } }),
    trial('B', 'x', 2, 'pass', { outcomeMetrics: { criticalFalseRelease: 0 } }),
    trial('B', 'y', 0, 'fail', { outcomeMetrics: { criticalFalseRelease: 1 } }),
    trial('B', 'y', 1, 'fail', { outcomeMetrics: { criticalFalseRelease: 0 } }),
    trial('B', 'y', 2, 'fail', { outcomeMetrics: { criticalFalseRelease: 0 } }),
  ];
  const result = summarizeSuite({ suiteId: 'toy', revision: 'r1' }, ['x', 'y'], trials);

  test('per arm: pass rate over graded trials, pass^k per task, metric means, infra errors counted apart', () => {
    const x = result.perArm['x']!;
    assert.equal(x.passRate, 5 / 6);
    assert.equal(x.passHatK, 0.5, 'task A all passed (1), task B not (0)');
    assert.deepEqual(x.metrics, { trials: 6, graded: 6, infraErrors: 0, durationMs: 100, criticalFalseRelease: 0, defectRecall: 1, 'traj.toolCalls': 15 });
    const y = result.perArm['y']!;
    assert.equal(y.passRate, 1 / 5);
    assert.equal(y.passHatK, 0);
    assert.equal(y.metrics['infraErrors'], 1);
    assert.equal(y.metrics['graded'], 5);
    assert.equal(y.metrics['criticalFalseRelease'], 2 / 5, 'the infra-error trial does not count');
    assert.equal(y.metrics['defectRecall'], 0.5);
  });

  test('paired comparison: discordant pairs over trials graded in both arms, exact McNemar, bootstrap CI of passA − passB', () => {
    assert.equal(result.comparisons.length, 1);
    const c = result.comparisons[0]!;
    // pairs graded in both: A0 (p,p) A1 (p,f) B0 (p,f) B1 (f,f) B2 (p,f) — A2 excluded (y infra error)
    assert.deepEqual([c.armA, c.armB, c.b, c.c, c.pairs], ['x', 'y', 3, 0, 5]);
    assert.equal(c.mcnemarP, mcnemarExact(3, 0));
    assert.equal(c.mcnemarP, 0.25);
    assert.equal(c.passDiffCI!.mean, 0.6);
    assert.ok(c.passDiffCI!.lo <= 0.6 && c.passDiffCI!.hi >= 0.6 && c.passDiffCI!.hi <= 1);
    assert.deepEqual(summarizeSuite({ suiteId: 'toy', revision: 'r1' }, ['x', 'y'], trials).comparisons, result.comparisons, 'deterministic (seeded by the suite)');
  });

  test('arms without graded trials have zero rates and no CI', () => {
    const r = summarizeSuite({ suiteId: 's', revision: '1' }, ['a', 'b'], [trial('T', 'a', 0, 'infra_error'), trial('T', 'b', 0, 'pass')]);
    assert.deepEqual(r.perArm['a'], { passRate: 0, passHatK: 0, metrics: { trials: 1, graded: 0, infraErrors: 1, durationMs: 0 } });
    assert.deepEqual(r.comparisons, [{ armA: 'a', armB: 'b', mcnemarP: 1, b: 0, c: 0, pairs: 0 }]);
  });

  test('renderSuiteReport: arms, comparisons, trials and the explanatory trajectory section', () => {
    const md = renderSuiteReport(result);
    const lines = md.split('\n');
    assert.equal(lines[0], '# Eval suite toy (revision r1)');
    assert.ok(lines.includes('| arm | pass rate | pass^k | graded | infra errors | criticalFalseRelease | defectRecall |'), md);
    assert.ok(lines.includes('| x | 0.833 | 0.500 | 6 | 0 | 0 | 1 |'), md);
    assert.ok(lines.includes('| y | 0.200 | 0 | 5 | 1 | 0.400 | 0.500 |'), md);
    assert.ok(lines.some((l) => /^\| x \| y \| 5 \| 3 \| 0 \| 0\.2500 \| 0\.600 \[/.test(l)), md);
    assert.ok(lines.includes('| A | y | 1 | fail | – | verdict: verdict pass (expected fail) |  |'), md);
    assert.ok(lines.includes('| A | y | 2 | infra_error | – | – | setup failed |'), md);
    assert.ok(lines.includes('## Trajectory (explanatory only — never a success criterion)'), md);
    assert.ok(lines.includes('| toolCalls | 15 | – |'), md);
    assert.equal(renderSuiteReport(result), md, 'deterministic');
  });

  test('table cells are escaped (pipes, newlines)', () => {
    const r = summarizeSuite({ suiteId: 's', revision: '1' }, ['a|b'], [trial('T', 'a|b', 0, 'fail', { error: 'line1\nline2 | x' })]);
    assert.ok(renderSuiteReport(r).includes('| T | a\\|b | 0 | fail | – | – | line1 line2 \\| x |'));
  });
});

describe('runSuite orchestration', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-eval-suite-')));
  after(async () => dir.cleanup());

  test('every task × trial × arm runs once with the paired seed, arms in a seeded order, each in a fresh directory (removed after)', async () => {
    const seen: Array<{ arm: string; ctx: TrialContext; existed: boolean }> = [];
    const arms: EvalArm[] = ['a', 'b', 'c'].map((armId) => ({ armId, description: armId, config: (c) => c }));
    const failing = (taskId: string) =>
      task({
        taskId,
        async setup(ctx) {
          seen.push({ arm: '', ctx, existed: existsSync(ctx.workDir) });
          throw new Error(`no environment for ${taskId}`);
        },
      });
    const onTrial: EvalTrial[] = [];
    const result = await runSuite({ suiteId: 'orch', revision: '7', tasks: [failing('t1'), failing('t2')] }, { arms, trials: 2, workDir: dir.path, onTrial: (t) => onTrial.push(t) });
    assert.equal(result.trials.length, 12);
    assert.deepEqual(onTrial, result.trials);
    for (const t of result.trials) {
      assert.equal(t.result, 'infra_error');
      assert.equal(t.error, `no environment for ${t.taskId}`);
      assert.equal(t.seed, trialSeed({ suiteId: 'orch', revision: '7' }, t.taskId, t.trial));
    }
    // the arm order of each (task, trial) pair is the seeded shuffle of the arms
    for (const taskId of ['t1', 't2']) {
      for (const n of [0, 1]) {
        const order = result.trials.filter((t) => t.taskId === taskId && t.trial === n).map((t) => t.armId);
        assert.deepEqual(order, seededShuffle(['a', 'b', 'c'], trialSeed({ suiteId: 'orch', revision: '7' }, taskId, n)));
      }
    }
    assert.equal(new Set(seen.map((s) => s.ctx.workDir)).size, 12, 'a fresh directory per trial');
    assert.ok(seen.every((s) => s.existed && s.ctx.workDir.startsWith(dir.path)));
    assert.deepEqual(readdirSync(dir.path), [], 'trial directories are removed');
    assert.deepEqual(result.perArm['a'], { passRate: 0, passHatK: 0, metrics: { trials: 4, graded: 0, infraErrors: 4, durationMs: 0 } });
  });

  test('invalid suites and options are refused before any trial', async () => {
    const arm: EvalArm = { armId: 'a', description: '', config: (c) => c };
    const invalid = (e: unknown): boolean => e instanceof HypertestError && e.code === 'invalid_argument';
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [] }, { arms: [], trials: 1, workDir: dir.path }), invalid);
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [] }, { arms: [arm], trials: 0, workDir: dir.path }), invalid);
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [] }, { arms: [arm, arm], trials: 1, workDir: dir.path }), (e: unknown) => invalid(e) && /arm ids must be unique/.test((e as Error).message));
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [task(), task()] }, { arms: [arm], trials: 1, workDir: dir.path }), (e: unknown) => invalid(e) && /task ids must be unique/.test((e as Error).message));
  });

  test('a malformed task or arm set is refused before the first trial (not recorded once per trial as infra errors)', async () => {
    const arm: EvalArm = { armId: 'a', description: '', config: (c) => c };
    let setups = 0;
    const counted = (extra: Parameters<typeof task>[0]) => task({ ...extra, setup: async () => (setups++, { target: {}, cleanup: async () => undefined }) });
    const invalid = (re: RegExp) => (e: unknown): boolean => e instanceof HypertestError && e.code === 'invalid_argument' && re.test((e as Error).message);
    const suite = (t: ReturnType<typeof task>) => ({ suiteId: 's', revision: '1', tasks: [counted({ taskId: 'ok' }), t] });
    await assert.rejects(runSuite(suite(counted({ taskId: 't2', graders: ['verdict', 'llmJudge'] })), { arms: [arm], trials: 1, workDir: dir.path }), invalid(/^unknown grader 'llmJudge'/));
    await assert.rejects(runSuite(suite(counted({ taskId: 't2', graders: [] })), { arms: [arm], trials: 1, workDir: dir.path }), invalid(/^task t2 lists no graders$/));
    await assert.rejects(runSuite(suite(counted({ taskId: 't2', chaos: { killAfterOperationDispatch: 0 } })), { arms: [arm], trials: 1, workDir: dir.path }), invalid(/^task t2: chaos.killAfterOperationDispatch must be a positive integer, got 0$/));
    await assert.rejects(
      runSuite(suite(counted({ taskId: 't2' })), { arms: [arm], trials: 1, workDir: dir.path, mode: 'child-process' }),
      invalid(/^child-process trials need EvalArm.child; missing for arm\(s\) a$/),
    );
    // an extra grader registered in the options resolves
    const custom = await runSuite({ suiteId: 's', revision: '1', tasks: [task({ taskId: 't3', graders: ['rubric'], setup: async () => Promise.reject(new Error('no env')) })] }, {
      arms: [arm], trials: 1, workDir: dir.path, graders: { rubric: () => ({ graderId: 'rubric', pass: true, score: 1, detail: 'ok' }) },
    });
    assert.deepEqual(custom.trials.map((t) => [t.result, t.error]), [['infra_error', 'no env']]);
    assert.equal(setups, 0, 'no trial ran for a refused suite');
  });
});
