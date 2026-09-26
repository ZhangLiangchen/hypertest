/**
 * `hypertest eval run` over a stub eval platform (injected through `io.loadEval`): suite and arm resolution, the CLI's
 * own `config` arm (models + role policies of the configuration file, brains from --scripted-brains), trial options,
 * output (markdown / JSON / --out), exit codes, interruption, and the default loader (`@hypertest/eval`).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { defaultConfig } from '@hypertest/app';
import type { EvalArm, EvalSuite, EvalTrial, SuiteOptions, SuiteResult } from '@hypertest/eval';
import { tempDir } from '@hypertest/testkit';
import { availableSuites, suiteFactoryName, suiteIdOf, type EvalModuleLike } from '../src/index.ts';
import { BRAINS, cli, parseJson, writeProject } from './helpers.ts';

function suiteOf(suiteId: string): EvalSuite {
  return {
    suiteId,
    revision: 'r1',
    tasks: [{ taskId: 't1', suiteRevision: 'r1', title: 'task one', goal: 'g', setup: async () => ({ target: {}, cleanup: async () => undefined }), hiddenFaults: [], expectedVerdict: 'fail', graders: [] }],
  };
}

function arm(armId: string): EvalArm {
  return { armId, description: `${armId} arm`, config: (base) => base };
}

interface Stub {
  module: EvalModuleLike;
  calls: Array<{ suite: EvalSuite; options: SuiteOptions; workDirExisted: boolean }>;
}

/** A stub eval platform: two suites, two arms; every trial passes unless its arm id is listed in `failing`. */
function stubEval(options: { failing?: string[]; arms?: boolean; render?: boolean } = {}): Stub {
  const calls: Stub['calls'] = [];
  const module: EvalModuleLike = {
    pocAWhiteboxSuite: () => suiteOf('poc-a-whitebox'),
    oracleRobustnessSuite: () => suiteOf('oracle-robustness'),
    createSuite: () => ({ not: 'a suite' }),
    async runSuite(suite, o) {
      calls.push({ suite, options: o, workDirExisted: existsSync(o.workDir) });
      const trials: EvalTrial[] = [];
      for (const a of o.arms) {
        for (let i = 0; i < o.trials; i++) {
          const failed = options.failing?.includes(a.armId) ?? false;
          const t: EvalTrial = {
            taskId: 't1', armId: a.armId, trial: i, seed: `s${i}`, result: failed ? 'fail' : 'pass', verdict: 'fail', runId: `run_${a.armId}_${i}`, graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 12,
          };
          trials.push(t);
          o.onTrial?.(t);
        }
      }
      const perArm: SuiteResult['perArm'] = {};
      for (const a of o.arms) {
        const mine = trials.filter((t) => t.armId === a.armId);
        const rate = mine.filter((t) => t.result === 'pass').length / mine.length;
        perArm[a.armId] = { passRate: rate, passHatK: rate, metrics: {} };
      }
      return { suiteId: suite.suiteId, revision: suite.revision, trials, perArm, comparisons: [] };
    },
  };
  if (options.render !== false) module.renderSuiteReport = (r: SuiteResult) => `# eval ${r.suiteId}\n\ntrials: ${r.trials.length}\n`;
  if (options.arms !== false) module.arms = [arm('scripted'), arm('baseline')];
  return { module, calls };
}

describe('hypertest eval run', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-eval-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('suite factory names follow the eval contract', () => {
    assert.equal(suiteFactoryName('poc-a-whitebox'), 'pocAWhiteboxSuite');
    assert.equal(suiteFactoryName('poc-b-event-driven'), 'pocBEventDrivenSuite');
    assert.equal(suiteFactoryName('poc-c-durable-load'), 'pocCDurableLoadSuite');
    assert.equal(suiteFactoryName('recovery-chaos'), 'recoveryChaosSuite');
    assert.equal(suiteIdOf('oracleRobustnessSuite'), 'oracle-robustness');
    assert.deepEqual([...availableSuites(stubEval().module).keys()].sort(), ['oracle-robustness', 'poc-a-whitebox']);
  });

  test('runs the suite with every eval arm, the trials and a temporary work dir (removed after); markdown report; exit 0', async () => {
    const stub = stubEval();
    const r = await cli(['eval', 'run', 'poc-a-whitebox', '--trials', '2', '--timeout-ms', '5000'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '# eval poc-a-whitebox\n\ntrials: 4\n');
    assert.equal(stub.calls.length, 1);
    const { suite, options, workDirExisted } = stub.calls[0]!;
    assert.equal(suite.suiteId, 'poc-a-whitebox');
    assert.deepEqual(options.arms.map((a) => a.armId), ['scripted', 'baseline']);
    assert.deepEqual([options.trials, options.timeoutMs, options.keepWorkDir, options.mode], [2, 5000, false, undefined]);
    assert.equal(workDirExisted, true);
    assert.equal(existsSync(options.workDir), false, 'the temporary work dir was not removed');
    const lines = r.stderr.trimEnd().split('\n');
    assert.match(lines[0]!, /^eval poc-a-whitebox: 1 task × 2 arms \(scripted, baseline\) × 2 trials in \S+ht-eval-\S+$/);
    assert.deepEqual(lines.slice(1), ['  t1 / scripted #0: pass (verdict fail) in 12 ms', '  t1 / scripted #1: pass (verdict fail) in 12 ms', '  t1 / baseline #0: pass (verdict fail) in 12 ms', '  t1 / baseline #1: pass (verdict fail) in 12 ms']);
  });

  test('--arms selects arms; a failing trial ⇒ exit 1; --json + --out; an explicit --work-dir is kept', async () => {
    const stub = stubEval({ failing: ['baseline'] });
    const r = await cli(['eval', 'run', 'oracle-robustness', '--arms', 'baseline', '--json', '--out', 'eval.json', '--work-dir', 'wd', '--mode', 'child-process'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(r.code, 1);
    const result = parseJson<SuiteResult>(r);
    assert.deepEqual(result.trials.map((t) => [t.armId, t.result]), [['baseline', 'fail']]);
    assert.equal(await readFile(join(dir.path, 'eval.json'), 'utf8'), r.stdout);
    const { options } = stub.calls[0]!;
    assert.deepEqual([options.workDir, options.keepWorkDir, options.mode], [join(dir.path, 'wd'), true, 'child-process']);
    assert.equal(existsSync(join(dir.path, 'wd')), true);
    assert.equal(r.stderr, `wrote ${join(dir.path, 'eval.json')}\n`);
  });

  test('without renderSuiteReport the CLI prints its own summary', async () => {
    const stub = stubEval({ render: false });
    const r = await cli(['eval', 'run', 'poc-a-whitebox', '--arms', 'scripted'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(r.code, 0);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'suite poc-a-whitebox (revision r1): 1 trial');
    assert.match(lines[2]!, /^ARM\s+PASS RATE\s+PASS\^K$/);
    assert.match(lines[3]!, /^scripted\s+1\.000\s+1\.000$/);
    assert.match(lines[6]!, /^t1\s+scripted\s+0\s+pass\s+fail\s+run_scripted_0$/);
  });

  test('unknown suites and arms are usage errors listing what exists; nothing runs', async () => {
    const stub = stubEval();
    const s = await cli(['eval', 'run', 'nope'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(s.code, 2);
    assert.match(s.stderr, /^hypertest eval: unknown suite "nope" \(available: oracle-robustness, poc-a-whitebox\)\n/);
    const a = await cli(['eval', 'run', 'poc-a-whitebox', '--arms', 'scripted,ghost'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(a.code, 2);
    assert.match(a.stderr, /^hypertest eval: unknown arm ghost \(available: baseline, scripted\)\n/);
    const m = await cli(['eval', 'run', 'poc-a-whitebox', '--mode', 'forked'], { cwd: dir.path, loadEval: async () => stub.module });
    assert.equal(m.code, 2);
    assert.match(m.stderr, /^hypertest eval: --mode must be in-process or child-process \(got "forked"\)\n/);
    assert.equal(stub.calls.length, 0);
  });

  test('an eval platform that cannot be loaded or has no runSuite is a failure (exit 1)', async () => {
    const broken = await cli(['eval', 'run', 'poc-a-whitebox'], { cwd: dir.path, loadEval: async () => { throw new Error('boom'); } });
    assert.deepEqual([broken.code, broken.stderr], [1, 'hypertest eval: the eval platform (@hypertest/eval) could not be loaded: boom [unavailable]\n']);
    const empty = await cli(['eval', 'run', 'poc-a-whitebox'], { cwd: dir.path, loadEval: async () => ({}) });
    assert.deepEqual([empty.code, empty.stderr], [1, 'hypertest eval: @hypertest/eval does not export runSuite: this build has no eval platform [unsupported]\n']);
  });

  test('the `config` arm: the configuration\'s models and role policies over the trial base, brains from --scripted-brains', async () => {
    const cwd = join(dir.path, 'with-config');
    await mkdir(cwd);
    const project = await writeProject(cwd, { roles: { executor: { defaultModelPolicy: { minQuality: 0.85 } } } });
    try {
      const stub = stubEval({ arms: false });
      const r = await cli(['eval', 'run', 'poc-a-whitebox', '--scripted-brains', BRAINS], { cwd, env: project.env, loadEval: async () => stub.module });
      assert.equal(r.code, 0, r.stderr);
      const configArm = stub.calls[0]!.options.arms[0]!;
      assert.equal(configArm.armId, 'config');
      assert.equal(configArm.description, `models and role policies of ${project.configPath}`);
      const base = defaultConfig({ project: { name: 'trial', dataDir: '/tmp/trial' } });
      const merged = configArm.config(base, { workDir: '/tmp/trial', seed: 's', trial: 0 });
      assert.deepEqual(merged.models.providers, [{ id: 'sim', kind: 'scripted' }]);
      assert.deepEqual(merged.models.routes.map((x) => x.routeId), ['sim-large']);
      assert.deepEqual(merged.roles, { executor: { defaultModelPolicy: { minQuality: 0.85 } } });
      assert.equal(merged.project.dataDir, '/tmp/trial', 'the trial keeps its own data directory');
      const brains = configArm.brains!(suiteOf('x').tasks[0]!, { target: {}, cleanup: async () => undefined });
      assert.deepEqual(Object.keys(brains), ['sim']);
      assert.equal(typeof brains['sim'], 'function');
      // --arms config is also accepted next to eval-provided arms
      const both = stubEval();
      const r2 = await cli(['eval', 'run', 'poc-a-whitebox', '--arms', 'scripted,config', '--scripted-brains', BRAINS], { cwd, env: project.env, loadEval: async () => both.module });
      assert.equal(r2.code, 0, r2.stderr);
      assert.deepEqual(both.calls[0]!.options.arms.map((a) => a.armId), ['scripted', 'config']);
    } finally {
      await project.dispose();
    }
  });

  test('no eval arms and no configuration: a failure naming both (exit 1)', async () => {
    const cwd = join(dir.path, 'bare');
    await mkdir(cwd);
    const stub = stubEval({ arms: false });
    const r = await cli(['eval', 'run', 'poc-a-whitebox'], { cwd, env: { HYPERTEST_CONFIG: undefined }, loadEval: async () => stub.module });
    assert.deepEqual([r.code, r.stderr], [1, 'hypertest eval: no eval arms: @hypertest/eval provides none and no configuration file was found for the `config` arm [precondition_failed]\n']);
    assert.equal(stub.calls.length, 0);
  });

  test('interrupted while the suite runs ⇒ 130; the trial workspace is left in place', async () => {
    let release!: (r: SuiteResult) => void;
    const pending = new Promise<SuiteResult>((resolve) => {
      release = resolve;
    });
    let workDir = '';
    const stub = stubEval();
    const stop = new AbortController();
    // the interrupt arrives while the suite is running (runSuite was called and has not settled)
    stub.module.runSuite = (_suite, o) => {
      workDir = o.workDir;
      setImmediate(() => stop.abort());
      return pending;
    };
    const r = await cli(['eval', 'run', 'poc-a-whitebox'], { cwd: dir.path, signal: stop.signal, loadEval: async () => stub.module });
    release({ suiteId: 'poc-a-whitebox', revision: 'r1', trials: [], perArm: {}, comparisons: [] });
    assert.equal(r.code, 130);
    // runSuite cannot be cancelled: the CLI says the trials in progress keep running instead of pretending they stopped
    assert.match(r.stderr, new RegExp(`interrupted: the evaluation cannot be cancelled from the CLI \\(@hypertest/eval has no cancellation\\); trials still in progress finish in the background, a second Ctrl-C terminates the process; trial workspace ${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is left in place\\n$`));
    assert.equal(existsSync(workDir), true);
    await rm(workDir, { recursive: true, force: true });
  });

  test('interrupted before the suite starts ⇒ 130; no trial is run and the temporary workspace is removed', async () => {
    const stub = stubEval();
    const stop = new AbortController();
    stop.abort();
    const r = await cli(['eval', 'run', 'poc-a-whitebox'], { cwd: dir.path, signal: stop.signal, loadEval: async () => stub.module });
    assert.equal(r.code, 130);
    assert.equal(stub.calls.length, 0);
    const lines = r.stderr.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'interrupted before the evaluation started: no trial was run');
    const workDir = /in (\S+ht-eval-\S+)$/.exec(lines[0]!)![1]!;
    assert.equal(existsSync(workDir), false);
  });

  test('the default loader imports @hypertest/eval', async () => {
    const r = await cli(['eval', 'run', 'no-such-suite'], { cwd: dir.path });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /^hypertest eval: unknown suite "no-such-suite" \((available: [a-z0-9, -]+|@hypertest\/eval provides no suites)\)\n/);
  });
});
