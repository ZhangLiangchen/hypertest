/**
 * `hypertest eval` over the REAL @hypertest/eval exports (suites, tiers, arms, judge, bridge, gate), with `runSuite`
 * stubbed where a test only checks what the CLI hands to the platform, and the real platform where it must run:
 *
 * - (coverage[15]) `--tier` selects suite, trials and mode (each overridable); unknown tiers are usage errors;
 * - (coverage[16]) `--track cold|learning` and `--experience` (learning only);
 * - (F[8]) `--arm-file`: external agent arms invoked as a command — validated, and a real trial over a private suite;
 * - (coverage[14]) `--suite-dir`: the customer/private layer;
 * - (F[11], stubs[5]) `--judge config` (the configuration's routes), `--judge-packets`, `eval calibrate`, `eval calibrate label`;
 * - (F[12], item 18) `eval bridge` writes a bridge report the gate accepts (`eval gate --bridge`);
 * - (row 321) `eval gate --max-critical-false-release`: the product SLO is configurable and enforced.
 */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import * as ev from '@hypertest/eval';
import type { EvalSuite, EvalTrial, LlmJudge, SuiteOptions, SuiteResult } from '@hypertest/eval';
import { tempDir } from '@hypertest/testkit';
import type { EvalModuleLike } from '../src/index.ts';
import { cli, parseJson, writeProject } from './helpers.ts';

const FAKE_AGENT = fileURLToPath(new URL('../../eval/test/fixtures/fake-external-agent.mjs', import.meta.url));

interface Captured {
  suite: EvalSuite;
  options: SuiteOptions;
}

/** The real eval module with `runSuite` replaced by a recorder (every trial passes, graded by nothing). */
function recording(extra: Record<string, unknown> = {}): { module: EvalModuleLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const module: EvalModuleLike = {
    ...(ev as unknown as EvalModuleLike),
    async runSuite(suite: EvalSuite, options: SuiteOptions): Promise<SuiteResult> {
      calls.push({ suite, options });
      const trials: EvalTrial[] = suite.tasks.slice(0, 1).flatMap((t) => options.arms.map((a) => ({
        taskId: t.taskId, armId: a.armId, trial: 0, seed: 's', result: 'pass' as const, graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 1,
      })));
      return { suiteId: suite.suiteId, revision: suite.revision, trials, perArm: {}, comparisons: [] };
    },
    ...extra,
  };
  return { module, calls };
}

describe('hypertest eval: tiers, tracks, external arms, private suites', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-eval-platform-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('(coverage[15]) --tier selects suite, trials and mode; an explicit suite, --trials or --mode overrides; unknown tiers are refused', async () => {
    for (const [tier, suiteId, trials, mode] of [['release-core', 'core', 5, 'in-process'], ['failure-recovery', 'failure-recovery', 10, 'child-process'], ['pr-smoke', 'pr-smoke', 1, 'in-process'], ['deep', 'deep', 5, 'in-process']] as const) {
      const rec = recording();
      const r = await cli(['eval', 'run', '--tier', tier, '--arms', 'scripted-multi-llm', '--json'], { cwd: dir.path, loadEval: async () => rec.module });
      assert.equal(r.code, 0, r.stderr);
      const { suite, options } = rec.calls[0]!;
      assert.deepEqual([suite.suiteId, options.trials, options.mode, options.tier], [suiteId, trials, mode, tier], tier);
      assert.ok(suite.tasks.length > 0, `${tier}: the tier's suite has tasks`);
    }
    const rec = recording();
    const r = await cli(['eval', 'run', 'context-freshness', '--tier', 'release-core', '--trials', '2', '--mode', 'child-process', '--arms', 'scripted-multi-llm'], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([rec.calls[0]!.suite.suiteId, rec.calls[0]!.options.trials, rec.calls[0]!.options.mode, rec.calls[0]!.options.tier], ['context-freshness', 2, 'child-process', 'release-core']);
    assert.match(r.stderr, /eval context-freshness \(tier release-core\)/);
    // (review) without --arms every tier runs the default model arms — the scripted multi/single arms: the opt-in arms
    // (causal, product, the three-provider-class arm, which has no child spec) are never added behind the operator's back;
    // before, `--tier failure-recovery` (child-process) failed up front on the three-provider-class arm
    for (const tier of ['failure-recovery', 'release-core']) {
      const d = recording();
      const dr = await cli(['eval', 'run', '--tier', tier], { cwd: dir.path, loadEval: async () => d.module });
      assert.equal(dr.code, 0, dr.stderr);
      assert.deepEqual(d.calls[0]!.options.arms.map((a) => a.armId), ['scripted-multi-llm', 'scripted-single'], tier);
      if (d.calls[0]!.options.mode === 'child-process') assert.ok(d.calls[0]!.options.arms.every((a) => a.child !== undefined), 'every default arm can run as a child process');
    }
    for (const [argv, re] of [
      [['eval', 'run', '--tier', 'nightly'], /unknown eval tier "nightly" \(pr-smoke, release-core, deep, failure-recovery\)/],
      [['eval', 'run'], /eval run: name a suite or a --tier/],
    ] as Array<[string[], RegExp]>) {
      const u = await cli(argv, { cwd: dir.path, loadEval: async () => recording().module });
      assert.equal(u.code, 2, u.stderr);
      assert.match(u.stderr, re);
    }
  });

  test('(coverage[16]) cold track by default; --track learning admits --experience (learning only); malformed inputs are refused', async () => {
    let rec = recording();
    let r = await cli(['eval', 'run', 'context-freshness', '--arms', 'scripted-multi-llm'], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rec.calls[0]!.options.track, undefined, 'the platform default (cold) applies');
    const exp = join(dir.path, 'experience.json');
    await writeFile(exp, JSON.stringify({ items: [{ kind: 'lesson', status: 'approved', content: 'restart kv-service before load' }, { kind: 'pitfall', status: 'proposed', content: 'unreviewed' }] }));
    rec = recording();
    r = await cli(['eval', 'run', 'context-freshness', '--arms', 'scripted-multi-llm', '--track', 'learning', '--experience', exp], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rec.calls[0]!.options.track, 'learning');
    assert.deepEqual(rec.calls[0]!.options.experience?.map((x) => x.status), ['approved', 'proposed'], 'the platform admits the approved ones only (seedExperience)');
    assert.match(r.stderr, /track learning/);
    await writeFile(join(dir.path, 'bad-exp.json'), JSON.stringify({ lesson: 'x' }));
    for (const [argv, re] of [
      [['eval', 'run', 'context-freshness', '--experience', exp], /--experience seeds approved experience on the learning track only/],
      [['eval', 'run', 'context-freshness', '--track', 'hot'], /--track must be cold or learning/],
      [['eval', 'run', 'context-freshness', '--track', 'learning', '--experience', 'bad-exp.json'], /must be a list of experience items/],
    ] as Array<[string[], RegExp]>) {
      const u = await cli(argv, { cwd: dir.path, loadEval: async () => recording().module });
      assert.equal(u.code, 2, u.stderr);
      assert.match(u.stderr, re);
    }
  });

  test('(F[13], review) the deployment arm keeps the release\'s configuration but never its own targets (environments, URL allowlist)', async () => {
    const cwd = join(dir.path, 'deployment');
    await mkdir(cwd, { recursive: true });
    const project = await writeProject(cwd, {
      environments: [{ environmentId: 'prod-api', environmentClass: 'production', baseUrl: 'https://api.prod.example.invalid', generation: 1 }],
      tools: { httpAllowlist: ['https://api.prod.example.invalid'], urlEnvironmentClass: 'production' },
      policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read'] }, decision: 'allow' }] },
    });
    try {
      const rec = recording();
      const r = await cli(['eval', 'run', 'context-freshness', '--arms', 'deployment'], { cwd, env: project.env, loadEval: async () => rec.module });
      assert.equal(r.code, 0, r.stderr);
      const arm = rec.calls[0]!.options.arms.find((a) => a.armId === 'deployment')!;
      const base = ev.trialBaseConfig(join(cwd, 'trial'));
      const trial = arm.config(base, { workDir: join(cwd, 'trial'), seed: 's', trial: 0 });
      // the trial runs on the task's fixtures only: no environment of the deployment, no allowlisted URL target
      assert.deepEqual([trial.environments, trial.tools?.httpAllowlist, trial.tools?.urlEnvironmentClass], [undefined, [], undefined]);
      // … while everything the RuntimeManifest pins stays the deployment's (its policy here) and the trial stays isolated
      assert.deepEqual(trial.policy?.rules?.map((x) => x.id), ['site.allow-reads']);
      assert.deepEqual([trial.project.dataDir, trial.store, trial.artifacts], [base.project.dataDir, base.store, base.artifacts]);
      assert.deepEqual(ev.isolationProblems(trial, join(cwd, 'trial')), []);
    } finally {
      await project.dispose();
    }
  });

  test('(F[8]) --arm-file defines external agent arms: validated, then a real trial of the command is graded on its outcome only', async () => {
    const arms = join(dir.path, 'arms.json');
    await writeFile(arms, JSON.stringify({ arms: [{ armId: 'fake-green', description: 'a product that always says pass', external: { command: process.execPath, args: [FAKE_AGENT, 'green', '{sutUrl}', '{report}'], envPassthrough: ['FAKE_AGENT_TOKEN'], timeoutMs: 30_000 } }] }));
    const rec = recording();
    let r = await cli(['eval', 'run', 'context-freshness', '--arm-file', arms, '--arms', 'fake-green'], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 0, r.stderr);
    const handed = rec.calls[0]!.options.arms[0]!;
    assert.deepEqual([handed.armId, handed.family, handed.external?.command, handed.external?.envPassthrough], ['fake-green', 'product', process.execPath, ['FAKE_AGENT_TOKEN']]);
    for (const [doc, re] of [
      [{ arms: [{ armId: 'x', external: { command: 'claude', args: ['-p', '{goal}'] } }] }, /an argument must name \{report\}/],
      [{ arms: [{ armId: 'x', external: { command: 'claude', args: ['{report}'], envPassthrough: ['sk-live-123'] } }] }, /envPassthrough must be a list of variable NAMES/],
      [{ arms: [{ armId: 'scripted-multi-llm', external: { command: 'claude', args: ['{report}'] } }] }, /arm scripted-multi-llm already exists/],
      [{ arms: [{ armId: 'x', external: { command: 'claude', args: ['{report}'], shell: true } }] }, /unknown key shell/],
      [{ arms: 'claude' }, /must be \{"arms": \[/],
    ] as Array<[unknown, RegExp]>) {
      await writeFile(join(dir.path, 'bad-arms.json'), JSON.stringify(doc));
      const u = await cli(['eval', 'run', 'context-freshness', '--arm-file', 'bad-arms.json'], { cwd: dir.path, loadEval: async () => recording().module });
      assert.equal(u.code, 2, `${JSON.stringify(doc)}: ${u.stderr}`);
      assert.match(u.stderr, re);
    }

    // a REAL trial (the platform's runSuite) of a private suite with the external arm: the product said pass on a task
    // whose candidate is broken — graded fail, its claims count as no evidence
    const suites = join(dir.path, 'private');
    await mkdir(join(suites, 'base'), { recursive: true });
    await mkdir(join(suites, 'cand'), { recursive: true });
    await writeFile(join(suites, 'base', 'lib.js'), 'export const add = (a, b) => a + b;\n');
    await writeFile(join(suites, 'cand', 'lib.js'), 'export const add = (a, b) => a - b;\n');
    await writeFile(join(suites, 'acme.suite.json'), JSON.stringify({
      suiteId: 'acme-private', revision: 'acme-1',
      tasks: [{ taskId: 'add-regression', goal: 'Is add still correct?', repo: { base: 'base', candidate: 'cand' }, expectedVerdict: 'fail', hiddenFaults: [{ faultId: 'add-sub', description: 'add subtracts', severity: 'P1', detectionHints: ['add'] }] }],
    }));
    r = await cli(['eval', 'run', 'acme-private', '--suite-dir', suites, '--arm-file', arms, '--arms', 'fake-green', '--json'], { cwd: dir.path });
    assert.equal(r.code, 1, r.stderr);
    const result = parseJson<SuiteResult>(r);
    assert.equal(result.suiteId, 'acme-private');
    assert.match(result.suiteFingerprint ?? '', /^[0-9a-f]{64}$/);
    const trial = result.trials[0]!;
    assert.deepEqual([trial.armId, trial.result, trial.verdict, trial.outcomeMetrics['criticalFalseRelease'], trial.outcomeMetrics['evidenceCompleteness']], ['fake-green', 'fail', 'pass', 1, 0]);
    assert.ok(trial.graders.some((g) => g.graderId === 'externalVerdict' && !g.pass), JSON.stringify(trial.graders));
    // an unknown private suite lists what the directory holds
    const unknown = await cli(['eval', 'run', 'acme-other', '--suite-dir', suites], { cwd: dir.path });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown suite "acme-other" \(in .*: acme-private\)/);
    // (review) a private suite never takes the id of a built-in suite: a directory's `core` would otherwise run instead of
    // the CORE eval (its result named "core" — the only suite a release gate accepts)
    const shadowing = join(dir.path, 'private-core');
    await mkdir(join(shadowing, 'base'), { recursive: true });
    await writeFile(join(shadowing, 'base', 'lib.js'), 'export const add = (a, b) => a + b;\n');
    await writeFile(join(shadowing, 'core.suite.json'), JSON.stringify({
      suiteId: 'core', revision: 'core-2',
      tasks: [{ taskId: 'trivial', goal: 'Is add correct?', repo: { base: 'base', candidate: 'base' }, expectedVerdict: 'pass' }],
    }));
    const rec2 = recording();
    for (const suiteArg of ['core', 'context-freshness']) {
      const s = await cli(['eval', 'run', suiteArg, '--suite-dir', shadowing, '--arms', 'scripted-multi-llm'], { cwd: dir.path, loadEval: async () => rec2.module });
      assert.equal(s.code, 2, s.stderr);
      assert.match(s.stderr, /--suite-dir .*: private suite "core" reuses the id of a built-in suite/);
    }
    assert.deepEqual(rec2.calls, [], 'nothing ran');
  });
});

describe('hypertest eval run: cancellation reaches the real platform (F[14])', () => {
  test('--timeout cancels the running trial through SuiteOptions.signal: exit 1, the partial result is kept and marked, the trial cancelled', async () => {
    const dir = await tempDir('ht-cli-eval-cancel-');
    try {
      const started = Date.now();
      const r = await cli(['eval', 'run', 'context-freshness', '--arms', 'scripted-multi-llm', '--timeout', '3000', '--out', 'partial.json', '--json'], { cwd: dir.path });
      assert.equal(r.code, 1, r.stderr);
      assert.ok(Date.now() - started < 60_000, 'the platform stopped at the cancellation (no wait for the trial to finish)');
      assert.match(r.stderr, /the evaluation exceeded --timeout 3000 ms: cancelled after 0 completed trial\(s\); the partial result is kept/);
      const partial = JSON.parse(await readFile(join(dir.path, 'partial.json'), 'utf8')) as SuiteResult;
      assert.equal(partial.cancelled, true);
      assert.deepEqual(partial.trials.map((t) => [t.taskId, t.result, t.cancelled]), [['context-freshness', 'infra_error', true]]);
      // a cancelled result never gates anything
      const gate = await cli(['eval', 'gate', '--baseline', 'partial.json', '--candidate', 'partial.json'], { cwd: dir.path });
      assert.equal(gate.code, 2);
      assert.match(gate.stderr, /is a CANCELLED \(partial\) suite result: it never gates a release/);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('hypertest eval: the configured judge and its human calibration', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-eval-judge-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('(F[11]) --judge config builds the judge over the configuration\'s routes (narrowed by --judge-route), appends llmRubric last, records packets', async () => {
    const project = await writeProject(dir.path);
    try {
      const seen: Array<{ routes: unknown; providers: unknown; brains: boolean }> = [];
      const judge: LlmJudge = { identity: 'judge[sim-large]', judge: async () => { throw new Error('unused'); }, calibrate: async () => { throw new Error('unused'); }, calibration: async () => undefined };
      const rec = recording({
        configuredJudge: async (config: { models: { providers: unknown[] } }, o: { routeIds?: string[]; scriptedBrains?: unknown }) => {
          seen.push({ routes: o.routeIds, providers: config.models.providers, brains: o.scriptedBrains !== undefined });
          return judge;
        },
      });
      const r = await cli(['eval', 'run', 'context-freshness', '--arms', 'scripted-multi-llm', '--judge', 'config', '--judge-route', 'sim-large', '--judge-packets', 'packets'], { cwd: dir.path, env: project.env, loadEval: async () => rec.module });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(seen, [{ routes: ['sim-large'], providers: [{ id: 'sim', kind: 'scripted' }], brains: false }]);
      const { suite, options } = rec.calls[0]!;
      assert.ok(suite.tasks.every((t) => t.graders.at(-1) === 'llmRubric'), 'the judge grades last');
      assert.notEqual(options.judge, judge, 'wrapped by the packet recorder');
      assert.equal(options.judge?.identity, judge.identity, 'recording changes nothing about the judgement');
      const u = await cli(['eval', 'run', 'context-freshness', '--judge', 'scripted', '--judge-route', 'sim-large'], { cwd: dir.path, env: project.env, loadEval: async () => rec.module });
      assert.equal(u.code, 2);
      assert.match(u.stderr, /--judge-route selects routes of the configuration \(--judge config\)/);
    } finally {
      await project.dispose();
    }
  });

  test('(F[11]) eval calibrate measures the judge against the expert labels; calibrate label adds a HUMAN label (a new set revision)', async () => {
    let r = await cli(['eval', 'calibrate', '--json'], { cwd: dir.path });
    assert.equal(r.code, 0, r.stderr);
    const report = parseJson<{ meetsThreshold: boolean; n: number; agreement: number; calibrationSetId: string }>(r);
    assert.equal(report.meetsThreshold, true);
    assert.ok(report.n > 0 && report.agreement >= 0.8, JSON.stringify(report));
    r = await cli(['eval', 'calibrate'], { cwd: dir.path });
    assert.match(r.stdout, /CALIBRATED: the judge's results count/);

    // a recorded packet (eval run --judge-packets) labelled by a human
    const item = ev.loadCalibrationSet().items[0]!;
    const packetFile = join(dir.path, 'packet.json');
    await writeFile(packetFile, JSON.stringify({ rubric: ev.VERDICT_CONSISTENCY_RUBRIC, packet: item.packet }));
    const setFile = join(dir.path, 'labels.json');
    // (review) a label is a human decision: refused from inside a Hypertest sandbox (an agent never calibrates its judge)
    r = await cli(['eval', 'calibrate', 'label', '--set', setFile, '--packet', packetFile, '--label', item.label, '--by', 'ana'], { cwd: dir.path, env: { HYPERTEST_SANDBOX: '1' } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /eval calibrate label is a human decision and cannot be taken from inside a Hypertest sandbox/);
    await assert.rejects(readFile(setFile, 'utf8'), /ENOENT/, 'nothing was written');
    r = await cli(['eval', 'calibrate', 'label', '--set', setFile, '--packet', packetFile, '--label', item.label, '--by', 'ana', '--note', 'checked the report by hand', '--json'], { cwd: dir.path });
    assert.equal(r.code, 0, r.stderr);
    const labelled = parseJson<{ revision: string; items: number }>(r);
    assert.deepEqual([labelled.revision, labelled.items], ['2', 1]);
    const set = JSON.parse(await readFile(setFile, 'utf8')) as { items: Array<{ labelledBy: string; label: string }> };
    assert.deepEqual(set.items.map((i) => [i.labelledBy, i.label]), [['human:ana', item.label]]);
    r = await cli(['eval', 'calibrate', 'label', '--set', setFile, '--packet', packetFile, '--label', item.label, '--by', 'bo'], { cwd: dir.path });
    assert.equal(r.code, 2, 'a packet is labelled once per set');
    assert.match(r.stderr, /already labels this packet/);
    r = await cli(['eval', 'calibrate', 'label', '--set', setFile, '--packet', packetFile, '--label', 'great', '--by', 'bo'], { cwd: dir.path });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /label must be one of pass, fail, unknown/);
    // the judge measured on the human set (one item): too few labels to calibrate ⇒ its results never count (exit 1)
    r = await cli(['eval', 'calibrate', '--set', setFile], { cwd: dir.path });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /NOT CALIBRATED: the judge's results are reported but never counted/);
  });
});

describe('hypertest eval: bridges and the product SLO in the gate', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-eval-bridge-');
  });
  after(async () => {
    await dir.cleanup();
  });

  const METRICS = { criticalFalseRelease: 0, defectRecall: 1, policyViolations: 0, securityViolations: 0, duplicateSideEffects: 0, evidenceCompleteness: 1, evidenceVerified: 1 };
  function result(revisions: Record<string, string>, metrics: (i: number) => Record<string, number> = () => ({})): SuiteResult {
    const trials: EvalTrial[] = Array.from({ length: 4 }, (_, i) => ({
      taskId: `task-${i}`, armId: 'scripted-multi-llm', trial: 0, seed: `s${i}`, result: 'pass', verdict: 'fail', graders: [], outcomeMetrics: { ...METRICS, ...metrics(i) }, trajectoryMetrics: {}, durationMs: 1,
      graderRevisions: revisions,
    }));
    return { suiteId: 'core', revision: 'core-2', trials, perArm: {}, comparisons: [] };
  }

  test('(F[12], item 18) eval bridge grades with the retained revision too and writes the report; the gate accepts the change only through it', async () => {
    // the platform ran the suite with the retained generatedTestsGoverned@1 next to the current revision 2
    const rec = recording({
      async runSuite(suite: EvalSuite, options: SuiteOptions): Promise<SuiteResult> {
        rec.calls.push({ suite, options });
        const trials: EvalTrial[] = ['test-generation', 'test-generation-defect'].map((taskId) => ({
          taskId, armId: 'scripted-multi-llm', trial: 0, seed: 's', result: 'pass', graders: [{ graderId: 'generatedTestsGoverned', pass: true, score: 1, detail: 'ok', revision: '2' }],
          bridge: [{ graderId: 'generatedTestsGoverned', pass: true, score: 1, detail: 'ok', revision: '1' }], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 1,
        }));
        return { suiteId: suite.suiteId, revision: suite.revision, trials, perArm: {}, comparisons: [] };
      },
    });
    let r = await cli(['eval', 'bridge', 'core', '--grader', 'generatedTestsGoverned@1', '--arms', 'scripted-multi-llm', '--out', 'bridge.json'], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(rec.calls[0]!.options.bridge?.['generatedTestsGoverned'], 'the retained revision grades every trial too');
    const bridge = JSON.parse(await readFile(join(dir.path, 'bridge.json'), 'utf8')) as { reports: Array<{ graderId: string; fromRevision: string; toRevision: string; pairs: number; discontinuity: boolean }> };
    assert.deepEqual(bridge.reports.map((b) => [b.graderId, b.fromRevision, b.toRevision, b.pairs, b.discontinuity]), [['generatedTestsGoverned', '1', '2', 2, false]]);
    r = await cli(['eval', 'bridge', 'context-freshness', '--grader', 'generatedTestsGoverned@1', '--out', 'b2.json'], { cwd: dir.path, loadEval: async () => rec.module });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no task of context-freshness is graded by generatedTestsGoverned/);

    await writeFile(join(dir.path, 'baseline.json'), JSON.stringify(result({ verdict: '1', generatedTestsGoverned: '1' })));
    await writeFile(join(dir.path, 'candidate.json'), JSON.stringify(result({ verdict: '1', generatedTestsGoverned: '2' })));
    const GATE = ['eval', 'gate', '--baseline', 'baseline.json', '--candidate', 'candidate.json'];
    r = await cli(GATE, { cwd: dir.path });
    assert.equal(r.code, 1, 'a changed grader without a bridge is not comparable');
    assert.match(r.stdout, /generatedTestsGoverned 1 → 2 has no bridge comparison/);
    r = await cli([...GATE, '--bridge', 'bridge.json'], { cwd: dir.path });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Bridged grader revisions: generatedTestsGoverned 1 → 2 \(2 pair\(s\), no discontinuity\)/);
    await writeFile(join(dir.path, 'not-bridge.json'), JSON.stringify({ reports: [{ graderId: 'x' }] }));
    r = await cli([...GATE, '--bridge', 'not-bridge.json'], { cwd: dir.path });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /is not a bridge report/);
    assert.deepEqual(await readdir(dir.path).then((f) => f.includes('b2.json')), false);
  });

  test('(row 321) the critical false release SLO: default 0, configurable with --max-critical-false-release, enforced on the candidate rate', async () => {
    // one critical false release in four trials, in BOTH results (not worse on the pairs): only the SLO decides
    const cfr = (i: number) => ({ criticalFalseRelease: i === 0 ? 1 : 0 });
    await writeFile(join(dir.path, 'baseline.json'), JSON.stringify(result({ verdict: '1' }, cfr)));
    await writeFile(join(dir.path, 'candidate.json'), JSON.stringify(result({ verdict: '1' }, cfr)));
    const GATE = ['eval', 'gate', '--baseline', 'baseline.json', '--candidate', 'candidate.json', '--json'];
    let r = await cli(GATE, { cwd: dir.path });
    assert.equal(r.code, 1);
    let report = parseJson<{ checks: Array<{ checkId: string; pass: boolean; values: Record<string, number> }> }>(r);
    const slo = report.checks.find((c) => c.checkId === 'critical_false_release_slo')!;
    assert.deepEqual([slo.pass, slo.values['rate'], slo.values['slo']], [false, 0.25, 0]);
    assert.deepEqual(report.checks.filter((c) => !c.pass).map((c) => c.checkId), ['critical_false_release_slo']);
    r = await cli([...GATE, '--max-critical-false-release', '0.25'], { cwd: dir.path });
    assert.equal(r.code, 0, r.stdout);
    report = parseJson(r);
    assert.equal(report.checks.find((c) => c.checkId === 'critical_false_release_slo')!.pass, true);
    r = await cli([...GATE, '--max-critical-false-release', '0.2'], { cwd: dir.path });
    assert.equal(r.code, 1);
    for (const bad of ['-0.1', '2', 'lots']) {
      const u = await cli([...GATE, `--max-critical-false-release=${bad}`], { cwd: dir.path });
      assert.equal(u.code, 2, bad);
      assert.match(u.stderr, /--max-critical-false-release must be a rate in \[0, 1\]/);
    }
  });
});
