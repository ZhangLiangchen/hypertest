/**
 * The eval harness end to end on the real stack (PGlite per trial, or a fresh PostgreSQL schema per trial with
 * HYPERTEST_TEST_DB=postgres): toy tasks + scripted brains prove in-process trials, a paired suite, child-process
 * trials with a real SIGKILL + resume, in-process chaos (kill, injected model timeout, duplicate delivery), and the
 * failure paths the platform owns (tampered evidence, an ungradable trial, a timeout, an unexercised chaos plan).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { defaultConfig, type HypertestConfig } from '@hypertest/app';
import { openDatabase } from '@hypertest/store';
import { infraEnv, tempDir } from '@hypertest/testkit';
import { readProgress, renderSuiteReport, roleRouter, runSuite, runTrial, trialDataDir, type EvalArm, type EvalTask, type EvalTrial, type Grader, type TrialOptions } from '../src/index.ts';
import { defectBrains, faithfulArm, lazyArm, restartArm, toyConfig, toyDefectTask, toyRestartTask } from './fixtures/toy.ts';

const PG = process.env['HYPERTEST_TEST_DB'] === 'postgres';
const SCHEMA_PREFIX = `ht_evale2e_${randomBytes(3).toString('hex')}`;

function baseConfig(): HypertestConfig | undefined {
  if (!PG) return undefined;
  const url = infraEnv().pgUrl;
  if (!url) throw new Error('HYPERTEST_TEST_DB=postgres needs HYPERTEST_TEST_PG_URL');
  return defaultConfig({ store: { kind: 'postgres', url, schema: SCHEMA_PREFIX } });
}

function options(workDir: string, extra: Partial<TrialOptions> = {}): TrialOptions {
  const o: TrialOptions = { workDir, trial: 0, seed: 'e2e', timeoutMs: 120_000, ...extra };
  const base = baseConfig();
  if (base) o.baseConfig = base;
  return o;
}

const ALL_PASS = (t: EvalTrial): string[] => t.graders.filter((g) => !g.pass).map((g) => `${g.graderId}: ${g.detail}`);

let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-eval-e2e-')));
after(async () => {
  await root.cleanup();
  if (PG) {
    // every trial schema was dropped by the harness
    const db = await openDatabase({ kind: 'postgres', url: infraEnv().pgUrl! });
    try {
      const left = await db.query<{ schema_name: string }>('SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1', [`${SCHEMA_PREFIX}%`]);
      assert.deepEqual(left.rows, [], 'trial schemas left behind');
    } finally {
      await db.close();
    }
  }
});

describe('a paired suite on the seeded regression (in-process trials)', () => {
  test('faithful vs lazy, 2 trials each: graders, metrics, pass^k, McNemar and the report', async () => {
    const workDir = join(root.path, 'suite');
    const seen: string[] = [];
    const base = baseConfig();
    const result = await runSuite(
      { suiteId: 'toy', revision: 'toy-1', tasks: [toyDefectTask] },
      { arms: [faithfulArm, lazyArm], trials: 2, workDir, timeoutMs: 120_000, onTrial: (t) => seen.push(`${t.armId}#${t.trial}:${t.result}`), ...(base ? { baseConfig: base } : {}) },
    );
    assert.equal(result.trials.length, 4);
    assert.deepEqual([...seen].sort(), ['faithful#0:pass', 'faithful#1:pass', 'lazy#0:fail', 'lazy#1:fail']);

    for (const t of result.trials.filter((x) => x.armId === 'faithful')) {
      assert.equal(t.result, 'pass', JSON.stringify(ALL_PASS(t)));
      assert.equal(t.verdict, 'fail', 'the gate failed the seeded regression');
      assert.deepEqual(t.graders.map((g) => g.graderId), ['verdict', 'defectDetected', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction']);
      assert.match(t.graders[1]!.detail, /^sum-negatives: detected by rec_\w+$/);
      const o = t.outcomeMetrics;
      assert.deepEqual([o['verdictMatch'], o['criticalFalseRelease'], o['falseFail'], o['defectRecall'], o['falsePositiveFindings'], o['policyViolations'], o['evidenceCompleteness'], o['evidenceVerified'], o['orphanOperations']], [1, 0, 0, 1, 0, 0, 1, 1, 0]);
      assert.ok(o['timeToFirstEvidenceMs']! >= 0);
      assert.equal(Object.hasOwn(o, 'duplicateSideEffects'), false, 'no side-effect probe on this task');
      const tr = t.trajectoryMetrics;
      assert.equal(tr['planRevisions'], 2);
      assert.ok(tr['workItems']! >= 3 && tr['agents']! >= 3 && tr['modelCalls']! >= 6 && tr['toolCalls']! >= 6, JSON.stringify(tr));
      assert.equal(tr['modelCalls:sim-large'], tr['modelCalls']);
      assert.equal(tr['restarts'], 0);
      assert.match(t.runtimeManifestId!, /^rm_[0-9a-f]{64}$/);
      assert.match(t.evidenceRootHash!, /^[0-9a-f]{64}$/);
      assert.match(t.runId!, /^run_/);
    }
    for (const t of result.trials.filter((x) => x.armId === 'lazy')) {
      assert.equal(t.result, 'fail');
      assert.equal(t.verdict, 'inconclusive', 'no evidence ⇒ the gate never says pass');
      assert.deepEqual(t.graders.filter((g) => !g.pass).map((g) => g.graderId), ['verdict', 'defectDetected']);
      assert.deepEqual([t.outcomeMetrics['criticalFalseRelease'], t.outcomeMetrics['defectRecall'], t.outcomeMetrics['verdictMatch']], [0, 0, 0]);
    }
    assert.deepEqual([result.perArm['faithful']!.passRate, result.perArm['faithful']!.passHatK, result.perArm['lazy']!.passRate, result.perArm['lazy']!.passHatK], [1, 1, 0, 0]);
    const [cmp] = result.comparisons;
    assert.deepEqual([cmp!.armA, cmp!.armB, cmp!.b, cmp!.c, cmp!.pairs, cmp!.mcnemarP], ['faithful', 'lazy', 2, 0, 2, 0.5]);
    assert.deepEqual(cmp!.passDiffCI, { mean: 1, lo: 1, hi: 1 });
    const md = renderSuiteReport(result);
    assert.ok(md.includes('| faithful | 1 | 1 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |'), md);
    assert.ok(md.includes('| lazy | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |'), md);
    assert.ok(md.includes('| faithful | lazy | 2 | 2 | 0 | 0.5000 | 1 [1, 1] |'), md);
    assert.deepEqual(readdirSync(workDir), [], 'every trial directory was removed');
  });
});

describe('child-process trials: a real SIGKILL after the side effect was dispatched', () => {
  test('the resumed child reconciles the restart by its operation id: one restart, pass, evidence intact', async () => {
    const workDir = join(root.path, 'child');
    const t = await runTrial(toyRestartTask(), restartArm, options(workDir, { mode: 'child-process', keepWorkDir: true }));
    assert.equal(t.result, 'pass', `${t.error ?? ''} ${JSON.stringify(ALL_PASS(t))}`);
    assert.equal(t.verdict, 'pass');
    assert.deepEqual(t.graders.map((g) => [g.graderId, g.pass]), [['verdict', true], ['noDuplicateSideEffects', true], ['evidenceCompleteness', true], ['evidenceIntegrity', true], ['policyViolation', true], ['auditReconstruction', true]]);
    assert.equal(t.trajectoryMetrics['restarts'], 1, 'the chaos plan killed one child');
    assert.deepEqual([t.outcomeMetrics['duplicateSideEffects'], t.outcomeMetrics['orphanOperations'], t.outcomeMetrics['serviceGeneration'], t.outcomeMetrics['evidenceVerified']], [0, 0, 2, 1]);
    // the progress file tells the story: child 1 dispatched and was killed, child 2 resumed and completed
    const [trialDir] = readdirSync(workDir);
    const progress = readProgress(join(workDir, trialDir!, 'progress.jsonl'));
    const started = progress.filter((e) => e.type === 'started');
    assert.deepEqual(started.map((e) => [e.type === 'started' && e.mode, e.type === 'started' && e.attempt]), [['start', 1], ['resume', 2]]);
    assert.notEqual(started[0]!.pid, started[1]!.pid);
    const firstChild = progress.filter((e) => e.pid === started[0]!.pid);
    assert.ok(firstChild.some((e) => e.type === 'operation' && e.eventType === 'operation.dispatched'), 'killed after the dispatch');
    assert.equal(firstChild.some((e) => e.type === 'completed'), false, 'the first child never completed');
    const ops = new Set(progress.filter((e) => e.type === 'operation').map((e) => (e.type === 'operation' ? e.operationId : '')));
    assert.equal(ops.size, 1, 'one operation: never re-created');
    const last = progress.at(-1)!;
    assert.deepEqual(last.type === 'completed' ? [last.status, last.verdict, last.exitCode, last.pid] : [], ['completed', 'pass', 0, started[1]!.pid]);
    const seqs = progress.filter((e) => 'seq' in e).map((e) => (e as { seq: number }).seq);
    assert.equal(new Set(seqs).size, seqs.length, 'the resumed child reports only what was not reported yet');
  });
});

describe('in-process chaos', () => {
  test('kill (close) after the dispatch + an injected model timeout + duplicate event delivery: still exactly one restart and pass', async () => {
    const task = toyRestartTask({ chaos: { killAfterOperationDispatch: 1, injectModelTimeoutOnCall: 2, duplicateEventDelivery: true } });
    const t = await runTrial(task, restartArm, options(join(root.path, 'chaos')));
    assert.equal(t.result, 'pass', `${t.error ?? ''} ${JSON.stringify(ALL_PASS(t))}`);
    assert.deepEqual([t.trajectoryMetrics['restarts'], t.trajectoryMetrics['injectedModelTimeouts']], [1, 1]);
    assert.deepEqual([t.outcomeMetrics['duplicateSideEffects'], t.outcomeMetrics['serviceGeneration'], t.outcomeMetrics['policyViolations']], [0, 2, 0]);
  });
});

describe('failure paths of the platform', () => {
  test('evidence tampered after the run is caught: integrity and completeness fail, never a silent pass', async () => {
    const base = toyDefectTask;
    const task: EvalTask = {
      ...base,
      taskId: 'toy-defect-tampered',
      graders: ['verdict', 'evidenceIntegrity', 'evidenceCompleteness'],
      async setup(ctx) {
        const fixture = await base.setup(ctx);
        // an attacker with file-system access rewrites the stored artifacts after the run (probes run before the stores
        // are read); every file, so the ones behind evidence records are certainly among them
        fixture.probes = {
          tamper: async () => {
            const files: string[] = [];
            const walk = (d: string): void => {
              for (const n of readdirSync(d)) (statSync(join(d, n)).isDirectory() ? walk : (p: string) => files.push(p))(join(d, n));
            };
            walk(join(trialDataDir(ctx), 'artifacts'));
            for (const f of files) writeFileSync(f, 'tampered bytes');
            return files.length;
          },
        };
        return fixture;
      },
    };
    const t = await runTrial(task, faithfulArm, options(join(root.path, 'tamper')));
    assert.equal(t.result, 'fail');
    assert.deepEqual(t.graders.map((g) => [g.graderId, g.pass]), [['verdict', true], ['evidenceIntegrity', false], ['evidenceCompleteness', false]]);
    assert.match(t.graders[1]!.detail, /ledger verifies: artifact_hash ev_\w+/);
    assert.match(t.graders[2]!.detail, /^evidence ledger does not verify: artifact_hash/);
    assert.equal(t.outcomeMetrics['evidenceVerified'], 0);
  });

  test('a grader that needs a missing probe makes the trial an infra error; the fixture is cleaned up', async () => {
    let repoPath = '';
    const task: EvalTask = {
      ...toyDefectTask,
      graders: ['verdict', 'noDuplicateSideEffects'],
      async setup(ctx) {
        const f = await toyDefectTask.setup(ctx);
        repoPath = f.target.repoPath!;
        return f;
      },
    };
    const t = await runTrial(task, faithfulArm, options(join(root.path, 'noprobe')));
    assert.equal(t.result, 'infra_error');
    assert.equal(t.error, "grader noDuplicateSideEffects could not grade the trial: noDuplicateSideEffects needs the fixture probe 'sideEffects' (effect key → count observed by the environment)");
    assert.deepEqual(t.graders, []);
    assert.equal(existsSync(repoPath), false, 'fixture cleaned up');
  });

  test('a run that does not finish in time is cancelled and fails (graded on what was recorded)', async () => {
    const stuck: EvalArm = {
      armId: 'stuck',
      description: 'the lead never answers',
      config: (c) => toyConfig(c),
      brains: () => ({ sim: roleRouter({ lead: () => new Promise(() => undefined) }) }),
    };
    const started = Date.now();
    const t = await runTrial(toyDefectTask, stuck, options(join(root.path, 'timeout'), { timeoutMs: 4000 }));
    assert.equal(t.result, 'fail');
    assert.match(t.error!, /^the run did not complete in time: run run_\w+ did not complete within \d+ms$/);
    assert.equal(t.verdict, undefined);
    assert.equal(t.graders[0]!.detail, 'no verdict (run status cancelled); expected fail');
    assert.ok(Date.now() - started < 60_000);
  });

  test('a timed-out run fails even when every grader it lists passes (graders blind to the verdict cannot green it)', async () => {
    const stuck: EvalArm = { armId: 'stuck', description: 'the lead never answers', config: (c) => toyConfig(c), brains: () => ({ sim: roleRouter({ lead: () => new Promise(() => undefined) }) }) };
    const task: EvalTask = { ...toyDefectTask, taskId: 'toy-timeout-blind', graders: ['policyViolation', 'runStatus'] };
    const runStatus = (ctx: Parameters<Grader>[0]) => ({ graderId: 'runStatus', pass: true, score: 1, detail: `run ${ctx.data.status ?? 'none'}` });
    const t = await runTrial(task, stuck, options(join(root.path, 'timeout-blind'), { timeoutMs: 4000, graders: { runStatus } }));
    assert.deepEqual(t.graders.map((g) => [g.graderId, g.pass, g.detail]), [['policyViolation', true, '0 tool call(s) permitted; 0 denial(s), none executed'], ['runStatus', true, 'run cancelled']]);
    assert.equal(t.result, 'fail', 'every grader passed, but the run did not finish in time');
    assert.match(t.error!, /^the run did not complete in time: /);
    assert.equal(t.verdict, undefined);
  });

  test('a chaos plan that was never exercised is an infra error when the trial otherwise passes (recovery unconfirmed)', async () => {
    const task: EvalTask = { ...toyDefectTask, chaos: { killAfterOperationDispatch: 1, injectModelTimeoutOnCall: 10_000, largeOutputBytes: 50_000_000 } };
    const t = await runTrial(task, { ...faithfulArm, brains: () => defectBrains() }, options(join(root.path, 'nochaos')));
    assert.deepEqual(t.graders.filter((g) => !g.pass), [], 'the run itself passed every grader');
    assert.equal(t.result, 'infra_error');
    assert.equal(
      t.error,
      'chaos plan not exercised: fewer than 1 operation(s) were dispatched before the run finished or timed out; the model timeout planned for model call 10000 was never injected; ' +
        'no evidence artifact of at least 50000000 bytes was recorded (the large output never happened)',
    );
    assert.deepEqual([t.trajectoryMetrics['restarts'], t.trajectoryMetrics['injectedModelTimeouts']], [0, 0]);
  });

  test('…but an arm that FAILS the task stays a fail even when its chaos plan never triggered (infra errors never hide failures)', async () => {
    // the lazy arm dispatches nothing, so the kill never happens; it also misses the defect — a failure, counted in rates
    const task: EvalTask = { ...toyDefectTask, chaos: { killAfterOperationDispatch: 1 } };
    const t = await runTrial(task, lazyArm, options(join(root.path, 'nochaos-lazy')));
    assert.equal(t.result, 'fail');
    assert.deepEqual(t.graders.filter((g) => !g.pass).map((g) => g.graderId), ['verdict', 'defectDetected']);
    assert.equal(t.error, 'chaos plan not exercised: fewer than 1 operation(s) were dispatched before the run finished or timed out');
  });
});

describe('H11: suites and trials are cancellable (SuiteOptions.signal / TrialOptions.signal)', () => {
  test('a trial whose signal aborts mid-run ends at once as an infra error (never a pass/fail), its run cancelled; an aborted suite starts no trial', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    // a slow team: every model call takes 1.5 s; the caller cancels after the first one started
    const slowArm: EvalArm = {
      armId: 'slow', description: 'slow brains', config: (base) => toyConfig(base),
      brains: () => Object.fromEntries(Object.entries(defectBrains()).map(([id, brain]) => [id, async (req, info) => {
        if (++calls === 1) setTimeout(() => ctrl.abort(), 200);
        await new Promise((r) => setTimeout(r, 1500));
        return brain(req, info);
      }])) as ReturnType<NonNullable<EvalArm['brains']>>,
    };
    const started = Date.now();
    const trial = await runTrial(toyDefectTask, slowArm, options(join(root.path, 'h11'), { signal: ctrl.signal, timeoutMs: 120_000 }));
    assert.equal(trial.result, 'infra_error');
    assert.match(trial.error ?? '', /cancelled/);
    assert.ok(Date.now() - started < 60_000, `cancelled promptly (${Date.now() - started} ms), not at the trial timeout`);
    // a suite whose signal is already aborted runs nothing
    const seen: string[] = [];
    await assert.rejects(
      runSuite({ suiteId: 'toy', revision: 'toy-1', tasks: [toyDefectTask] }, { arms: [faithfulArm], trials: 2, workDir: join(root.path, 'h11-suite'), signal: ctrl.signal, onTrial: (t) => seen.push(t.armId) }),
      (e: unknown) => (e as { code?: string }).code === 'cancelled',
    );
    assert.deepEqual(seen, []);
  });
});
