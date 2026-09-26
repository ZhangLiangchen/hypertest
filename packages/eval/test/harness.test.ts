/**
 * runTrial failure paths that never compose a Hypertest (hermetic): invalid options and grader specs fail fast
 * (infra_error, no environment created), setup/fixture/isolation/configuration faults are infra errors, the fixture
 * is always cleaned up and the trial directory removed. Plus the per-trial configuration helpers.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { defaultConfig, type HypertestConfig } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import {
  TRIAL_DATA_DIR, chaosProblems, childExitProblem, decideTrialResult, isolationProblems, runTrial, trialBaseConfig, trialDataDir, unexercisedChaos, type EvalArm, type EvalTask,
  type TrialContext,
} from '../src/index.ts';
import { task } from './helpers.ts';

const arm = (config: EvalArm['config'] = (c) => c, extra: Partial<EvalArm> = {}): EvalArm => ({ armId: 'arm', description: 'd', config, ...extra });

describe('runTrial: fail fast and infra errors', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-eval-harness-')));
  after(async () => dir.cleanup());

  function tracked(extra: Partial<EvalTask> = {}): { t: EvalTask; calls: { setup: number; cleanup: number; ctx?: TrialContext } } {
    const calls: { setup: number; cleanup: number; ctx?: TrialContext } = { setup: 0, cleanup: 0 };
    const t = task({
      async setup(ctx) {
        calls.setup++;
        calls.ctx = ctx;
        return { target: {}, cleanup: async () => void calls.cleanup++ };
      },
      ...extra,
    });
    return { t, calls };
  }

  test('invalid options and unknown graders: infra_error before any environment exists', async () => {
    const { t, calls } = tracked({ graders: ['verdict', 'llmJudge'] });
    const r = await runTrial(t, arm(), { workDir: dir.path, trial: 0, seed: 's' });
    assert.equal(r.result, 'infra_error');
    assert.match(r.error!, /^unknown grader 'llmJudge'/);
    assert.deepEqual([r.graders, r.outcomeMetrics, r.trajectoryMetrics, r.runId], [[], {}, {}, undefined]);
    assert.equal(calls.setup, 0, 'setup never ran');
    for (const [options, re] of [
      [{ workDir: '', trial: 0, seed: 's' }, /workDir must be a non-empty path/],
      [{ workDir: dir.path, trial: -1, seed: 's' }, /trial must be a non-negative integer/],
      [{ workDir: dir.path, trial: 0, seed: 's', timeoutMs: 0 }, /timeoutMs must be > 0/],
      [{ workDir: dir.path, trial: 0, seed: 's', mode: 'thread' as never }, /mode must be in-process or child-process/],
    ] as const) {
      const bad = await runTrial(tracked().t, arm(), options);
      assert.equal(bad.result, 'infra_error');
      assert.match(bad.error!, re);
    }
    const none = await runTrial(tracked({ graders: [] }).t, arm(), { workDir: dir.path, trial: 0, seed: 's' });
    assert.equal(none.error, 'task t1 lists no graders');
    assert.deepEqual(readdirSync(dir.path), []);
  });

  test('a malformed chaos plan or probe timeout: infra_error before any environment exists (never half-applied)', async () => {
    const { t, calls } = tracked({ chaos: { killAfterOperationDispatch: 0, injectModelTimeoutOnCall: 1.5, largeOutputBytes: -1, duplicateEventDelivery: 'yes' as never } });
    const r = await runTrial(t, arm(), { workDir: dir.path, trial: 0, seed: 's' });
    assert.equal(r.result, 'infra_error');
    assert.equal(
      r.error,
      'task t1: chaos.killAfterOperationDispatch must be a positive integer, got 0; chaos.injectModelTimeoutOnCall must be a positive integer, got 1.5; chaos.largeOutputBytes must be a positive integer, got -1; chaos.duplicateEventDelivery must be a boolean, got yes',
    );
    const p = await runTrial(tracked().t, arm(), { workDir: dir.path, trial: 0, seed: 's', probeTimeoutMs: 0 });
    assert.deepEqual([p.result, p.error], ['infra_error', 'TrialOptions.probeTimeoutMs must be > 0, got 0']);
    assert.equal(calls.setup, 0);
    assert.deepEqual(readdirSync(dir.path), []);
  });

  test('child-process mode needs an arm with a child spec', async () => {
    const { t, calls } = tracked();
    const r = await runTrial(t, arm(), { workDir: dir.path, trial: 0, seed: 's', mode: 'child-process' });
    assert.deepEqual([r.result, r.error, calls.setup], ['infra_error', 'arm arm has no child spec (EvalArm.child) for a child-process trial', 0]);
  });

  test('a failing setup or a malformed fixture is an infra error; the trial directory is removed', async () => {
    let ctxSeen: TrialContext | undefined;
    const failing = task({
      async setup(ctx) {
        ctxSeen = ctx;
        throw new Error('fixture repo could not be cloned');
      },
    });
    const r = await runTrial(failing, arm(), { workDir: dir.path, trial: 3, seed: 'seed-3' });
    assert.deepEqual([r.result, r.error, r.taskId, r.armId, r.trial, r.seed], ['infra_error', 'fixture repo could not be cloned', 't1', 'arm', 3, 'seed-3']);
    assert.ok(ctxSeen && ctxSeen.workDir.startsWith(join(dir.path, 't1-arm-t3-')) && ctxSeen.seed === 'seed-3' && ctxSeen.trial === 3);
    assert.equal(existsSync(ctxSeen.workDir), false);
    const noCleanup = await runTrial(task({ setup: async () => ({ target: {} }) as never }), arm(), { workDir: dir.path, trial: 0, seed: 's' });
    assert.deepEqual([noCleanup.result, noCleanup.error], ['infra_error', 'the fixture has no cleanup()']);
    const noTarget = await runTrial(task({ setup: async () => ({ cleanup: async () => undefined }) as never }), arm(), { workDir: dir.path, trial: 0, seed: 's' });
    assert.equal(noTarget.error, 'the fixture has no target');
  });

  test('an arm that breaks trial isolation is refused; the fixture is still cleaned up', async () => {
    const { t, calls } = tracked();
    const shared = arm((c) => ({ ...c, store: { kind: 'pglite', dataDir: '/var/tmp/shared-db' } }));
    const r = await runTrial(t, shared, { workDir: dir.path, trial: 0, seed: 's', keepWorkDir: true });
    assert.equal(r.result, 'infra_error');
    assert.equal(r.error, 'arm arm breaks trial isolation: store.dataDir /var/tmp/shared-db is outside the trial directory');
    assert.equal(calls.cleanup, 1);
    assert.equal(existsSync(calls.ctx!.workDir), true, 'keepWorkDir keeps the directory for inspection');
  });

  test('an invalid arm configuration fails at composition (nothing created) and is an infra error', async () => {
    const { t, calls } = tracked();
    const bogus = arm((c) => ({ ...c, engines: { default: 'dsh' } }), { brains: () => ({}) });
    const r = await runTrial(t, bogus, { workDir: dir.path, trial: 0, seed: 's' });
    assert.equal(r.result, 'infra_error');
    assert.match(r.error!, /^invalid configuration:\n {2}- engines.default: "dsh" is not a registered engine/);
    assert.equal(calls.cleanup, 1);
    assert.equal(existsSync(calls.ctx!.workDir), false);
  });

  test('a scripted provider without a brain fails at composition (infra error, fixture cleaned up)', async () => {
    const { t, calls } = tracked();
    const scripted = arm((c) => ({ ...c, models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'r', provider: 'sim', model: 'm' }] } }));
    const r = await runTrial(t, scripted, { workDir: dir.path, trial: 0, seed: 's' });
    assert.deepEqual([r.result, r.error, calls.cleanup], ['infra_error', "models.providers (sim): scripted provider has no brain; pass overrides.scriptedBrains['sim']", 1]);
  });

  test('a fixture whose cleanup throws does not change the result (logged)', async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {}, child() { return logger; } };
    const t = task({ setup: async () => ({ target: {}, cleanup: async () => Promise.reject(new Error('port still bound')) }) });
    const r = await runTrial(t, arm((c) => ({ ...c, engines: { default: 'dsh' } })), { workDir: dir.path, trial: 0, seed: 's', logger });
    assert.equal(r.result, 'infra_error');
    assert.ok(warnings.includes('fixture cleanup failed'), warnings.join());
  });
});

describe('trial result rules (decideTrialResult, unexercisedChaos, chaosProblems, childExitProblem)', () => {
  const ok = { graderId: 'g', pass: true, score: 1, detail: 'ok' };
  const bad = { graderId: 'h', pass: false, score: 0, detail: 'no' };

  test('a timed-out run fails even when every grader passed (graders that do not look at the verdict cannot green it)', () => {
    assert.deepEqual(decideTrialResult({ graders: [ok], timedOut: true, unexercised: [], error: 'the run did not complete in time: x' }), { result: 'fail', error: 'the run did not complete in time: x' });
    assert.deepEqual(decideTrialResult({ graders: [], timedOut: true, unexercised: [] }), { result: 'fail' });
  });

  test('unexercised chaos never hides a failing arm; with every grader passing it is infra_error (recovery unconfirmed)', () => {
    assert.deepEqual(decideTrialResult({ graders: [ok, bad], timedOut: false, unexercised: ['no kill'] }), { result: 'fail', error: 'chaos plan not exercised: no kill' });
    assert.deepEqual(decideTrialResult({ graders: [ok], timedOut: false, unexercised: ['no kill', 'no timeout'] }), { result: 'infra_error', error: 'chaos plan not exercised: no kill; no timeout' });
    assert.deepEqual(decideTrialResult({ graders: [ok], timedOut: true, unexercised: ['no kill'], error: 'late' }), { result: 'fail', error: 'late; chaos plan not exercised: no kill' });
    assert.deepEqual(decideTrialResult({ graders: [ok], timedOut: false, unexercised: [] }), { result: 'pass' });
    assert.deepEqual(decideTrialResult({ graders: [bad], timedOut: false, unexercised: [] }), { result: 'fail' });
  });

  test('unexercisedChaos: kill, model timeout and large output are each checked against what happened', () => {
    const artifact = (size: number) => ({ artifact: { uri: 'cas://x', sha256: 'x', size, mimeType: 'text/plain' } });
    const chaos = { killAfterOperationDispatch: 2, injectModelTimeoutOnCall: 3, largeOutputBytes: 1000, duplicateEventDelivery: true };
    assert.deepEqual(unexercisedChaos(chaos, { restarts: 0, injectedModelTimeouts: 0, evidence: [artifact(999)] }), [
      'fewer than 2 operation(s) were dispatched before the run finished or timed out',
      'the model timeout planned for model call 3 was never injected',
      'no evidence artifact of at least 1000 bytes was recorded (the large output never happened)',
    ]);
    assert.deepEqual(unexercisedChaos(chaos, { restarts: 1, injectedModelTimeouts: 1, evidence: [artifact(10), artifact(1000)] }), []);
    assert.deepEqual(unexercisedChaos(undefined, { restarts: 0, injectedModelTimeouts: 0, evidence: [] }), []);
    assert.deepEqual(unexercisedChaos({ duplicateEventDelivery: true }, { restarts: 0, injectedModelTimeouts: 0, evidence: [] }), []);
  });

  test('chaosProblems: positive integers and a boolean, or nothing', () => {
    assert.deepEqual(chaosProblems(undefined), []);
    assert.deepEqual(chaosProblems({ killAfterOperationDispatch: 1, injectModelTimeoutOnCall: 2, largeOutputBytes: 3, duplicateEventDelivery: false }), []);
    assert.deepEqual(chaosProblems(null as never), ['chaos must be an object']);
    assert.deepEqual(chaosProblems({ killAfterOperationDispatch: Number.NaN }), ['chaos.killAfterOperationDispatch must be a positive integer, got NaN']);
  });

  test('kill points: validated with the plan, and each one never reached is reported (after killAfterOperationDispatch)', () => {
    assert.deepEqual(chaosProblems({ kills: [{ after: 'acknowledged', operationType: 'load.start' }, { after: 'dispatched', nth: 2, delayMs: 100 }] }), []);
    assert.deepEqual(chaosProblems({ kills: 'soon' as never }), ['chaos.kills must be an array of kill points']);
    assert.deepEqual(chaosProblems({ kills: [{ after: 'later' } as never, { after: 'verified', nth: 1.5 }] }), [
      'chaos.kills[0].after must be one of dispatched, acknowledged, verified, got later', 'chaos.kills[1].nth must be a positive integer, got 1.5',
    ]);
    const chaos = { killAfterOperationDispatch: 1, kills: [{ after: 'dispatched' as const, operationType: 'env.restart', delayMs: 400 }, { after: 'acknowledged' as const, operationType: 'load.start' }] };
    assert.deepEqual(unexercisedChaos(chaos, { restarts: 3, injectedModelTimeouts: 0, evidence: [] }), []);
    assert.deepEqual(unexercisedChaos(chaos, { restarts: 2, injectedModelTimeouts: 0, evidence: [] }), ['kill point 2 (after acknowledged of load.start) was never reached']);
    assert.deepEqual(unexercisedChaos(chaos, { restarts: 0, injectedModelTimeouts: 0, evidence: [] }), [
      'fewer than 1 operation(s) were dispatched before the run finished or timed out',
      'kill point 1 (after dispatched of env.restart + 400 ms) was never reached',
      'kill point 2 (after acknowledged of load.start) was never reached',
    ]);
    assert.deepEqual(unexercisedChaos({ kills: [{ after: 'verified' }] }, { restarts: 1, injectedModelTimeouts: 0, evidence: [] }), []);
  });

  test('childExitProblem: crashes and exit codes that contradict the stored final verdict make the trial ungradable', () => {
    assert.equal(childExitProblem({ code: 1, signal: null }, 'fail'), undefined);
    assert.equal(childExitProblem({ code: 4, signal: null }, undefined), undefined, 'no verdict, none stored');
    assert.equal(childExitProblem({ code: 5, signal: null }, undefined), undefined, 'timeout: the trial fails, it is not ungradable');
    assert.equal(childExitProblem({ code: 0, signal: null }, 'fail'), 'the trial child reported exit 0 (pass) but the store holds verdict fail');
    assert.equal(childExitProblem({ code: 4, signal: null }, 'pass'), 'the trial child reported exit 4 (no verdict) but the store holds verdict pass');
    assert.equal(childExitProblem({ code: 3, signal: null }, undefined), 'the trial child reported exit 3 (inconclusive) but the store holds verdict none');
    assert.equal(childExitProblem({ code: 70, signal: null }, undefined, 'brains module failed'), 'the trial child failed (exit 70): brains module failed');
    assert.equal(childExitProblem({ code: null, signal: 'SIGKILL' }, 'pass'), 'the trial child failed (exit SIGKILL): no error reported');
    assert.equal(childExitProblem({ code: 13, signal: null }, undefined), 'the trial child failed (exit 13): no error reported');
  });
});

describe('trial configuration helpers', () => {
  test('trialBaseConfig: defaults with every local path inside the trial data directory', () => {
    const c = trialBaseConfig('/w/t/hypertest');
    assert.deepEqual([c.project.dataDir, c.store, c.artifacts, c.bus.kind, c.durable.kind], ['/w/t/hypertest', { kind: 'pglite', dataDir: '/w/t/hypertest/db' }, { kind: 'fs', root: '/w/t/hypertest/artifacts' }, 'inprocess', 'local']);
    assert.equal(c.observability?.logLevel, 'warn');
  });

  test('trialBaseConfig over a base: the base keeps its settings but never its paths', () => {
    const base: HypertestConfig = defaultConfig({ project: { name: 'mine', dataDir: '/srv/ht' }, gate: { requireIndependentReview: false } });
    const c = trialBaseConfig('/w/t/hypertest', base);
    assert.deepEqual([c.project.name, c.project.dataDir, c.store, c.artifacts, c.gate], ['mine', '/w/t/hypertest', { kind: 'pglite', dataDir: '/w/t/hypertest/db' }, { kind: 'fs', root: '/w/t/hypertest/artifacts' }, { requireIndependentReview: false }]);
    assert.equal(base.project.dataDir, '/srv/ht', 'the base is not mutated');
    const pg = trialBaseConfig('/w/t/hypertest', { ...base, store: { kind: 'postgres', url: 'postgres://h/db', schema: 'x' } });
    assert.deepEqual(pg.store, { kind: 'postgres', url: 'postgres://h/db', schema: 'x' }, 'a server store is kept (the harness gives each trial a fresh schema)');
  });

  test('isolationProblems lists every path outside the trial directory', () => {
    const c = trialBaseConfig('/w/t/hypertest');
    assert.deepEqual(isolationProblems(c, '/w/t'), []);
    assert.deepEqual(isolationProblems({ ...c, project: { name: 'x', dataDir: '/w/other' }, artifacts: { kind: 'fs', root: '/w/t/../u' } }, '/w/t'), [
      'project.dataDir /w/other is outside the trial directory /w/t',
      'artifacts.root /w/t/../u is outside the trial directory',
    ]);
    assert.equal(trialDataDir({ workDir: '/w/t' }), join('/w/t', TRIAL_DATA_DIR));
  });
});
