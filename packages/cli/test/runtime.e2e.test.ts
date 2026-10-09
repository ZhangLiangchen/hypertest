/**
 * `hypertest runtime` over the real stack (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres): register the
 * installed runtime and walk it through the per-stage release gates (F[0]) with the CLI alone — engine contract
 * (attested with its report) + compatibility (an eval SuiteResult whose trials ran under THIS manifest, e2e[5]) →
 * shadow; the shadow mirrors a finished production run dry-run (`runtime shadow`) and the production replay is recorded
 * from the comparisons → canary; the release gate of the CORE eval against the committed baseline → active. List/show
 * it, refuse decisions from a sandbox and malformed command lines, roll back, and migrate a live run pinned to another
 * runtime onto the active one.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, loadConfig, type HypertestConfig, type HypertestInstance } from '@hypertest/app';
import type { RuntimeManifest, TestRun } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type TestProject } from './helpers.ts';
import { scenarioBrain } from './fixtures/brains.ts';

/** The committed baseline of the core eval (the release gate compares a core candidate with it). */
const CORE_BASELINE = fileURLToPath(new URL('../../eval/baselines/core-scripted-multi-llm.json', import.meta.url));
const ATTESTED = 'a'.repeat(64);

/** A core-suite candidate: the committed baseline's trials, re-run (here: relabelled) under `manifestId`, optionally altered. */
async function coreCandidate(manifestId: string, alter: (t: Record<string, unknown>, i: number) => void = () => undefined): Promise<string> {
  const doc = JSON.parse(await readFile(CORE_BASELINE, 'utf8')) as { trials: Array<Record<string, unknown>> };
  doc.trials.forEach((t, i) => {
    t['runtimeManifestId'] = manifestId;
    alter(t, i);
  });
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Walks the release of `ht` through every gate with the release API (test setup of releases this installation's CLI does
 * not run: another runtime's manifest). The production replay comes from a recorded shadow comparison.
 */
async function activateViaApi(ht: HypertestInstance): Promise<void> {
  const id = ht.manifest.manifestId;
  const by = 'ci:github';
  await ht.releases.register({ by: 'human:alice' });
  await ht.releases.recordSuite({ manifestId: id, kind: 'engine_contract', suiteId: 'agent-engine-abi', passed: true, summary: { total: 21, failed: 0 }, reportDigest: ATTESTED, binding: { kind: 'attested' }, by });
  await ht.releases.recordEvalSuite({ manifestId: id, kind: 'compatibility', digest: ATTESTED, by, result: { suiteId: 'poc-a-whitebox', revision: 'poc-2', trials: [{ taskId: 't', armId: 'deployment', trial: 0, result: 'pass', runtimeManifestId: id }] } });
  await ht.releases.promote(id, { by: 'human:alice', reason: 'compatibility green' });
  const c = await ht.releases.registry.recordShadowComparison({ manifestId: id, sourceRunId: `run_src_${id.slice(3, 11)}`, sourceManifestId: 'rm_production', shadowRunId: `run_src_${id.slice(3, 11)}.shadow`, sourceVerdict: 'pass', shadowVerdict: 'pass', divergences: [], recordedBy: 'ci:shadow' });
  await ht.releases.registry.recordSuiteResult({ manifestId: id, kind: 'production_replay', suiteId: 'shadow-mirror', passed: true, summary: { total: 1, failed: 0 }, binding: { kind: 'shadow_comparisons', comparisonIds: [c.comparisonId] }, by: 'ci:shadow' });
  await ht.releases.promote(id, { by: 'human:alice', reason: 'production replay green', canary: { percentage: 100 } });
  const candidate = { suiteId: 'core', revision: 'core-2', trials: [{ taskId: 'context-freshness', armId: 'deployment', trial: 0, result: 'pass', runtimeManifestId: id }] };
  await ht.releases.recordReleaseGate({ manifestId: id, candidate, candidateDigest: 'c'.repeat(64), baselineDigest: 'b'.repeat(64), report: { pass: true, suiteId: 'core', checks: [] }, by });
  await ht.releases.promote(id, { by: 'human:alice', reason: 'release gate green' });
}

/** Another runtime of this installation (one more policy rule ⇒ another manifest). */
function otherRuntime(base: HypertestConfig): HypertestConfig {
  return { ...base, policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read' as const] }, decision: 'allow' as const }] } };
}

describe('hypertest runtime', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;
  let foreignRun: TestRun;
  let foreignManifest: string;
  let productionRun: TestRun;

  before(async () => {
    dir = await tempDir('ht-cli-runtime-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env };
    const base = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    const other = otherRuntime(base);
    // a FINISHED run of another runtime of this installation (the production run a shadow of this runtime mirrors)
    {
      const ht = await createHypertest(other, { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: scenarioBrain('pass') as never } });
      try {
        const o = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 120_000 });
        assert.deepEqual([o.status, o.decision?.verdict], ['completed', 'pass']);
        productionRun = (await ht.status(o.runId))!;
      } finally {
        await ht.close();
      }
    }
    // a live run of ANOTHER runtime of this installation (one more policy rule), created while the store is unmanaged,
    // paused by an operator once its lead's first turn gave its claim back
    let entered!: () => void;
    const inLead = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ht = await createHypertest(other, {
      env: { ...process.env, ...env },
      logger: new MemoryLogger(),
      scriptedBrains: { sim: async () => (entered(), await gate, { text: 'noted' }) },
    });
    try {
      foreignManifest = ht.manifest.manifestId;
      foreignRun = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
      await inLead;
      await ht.control.pauseRun(foreignRun.runId, 'operator');
      release();
      for (let i = 0; i < 300; i++) {
        if ((await ht.services.blackboard.listWorkItems({ runId: foreignRun.runId, states: ['claimed', 'running'] })).length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      release();
      await ht.close();
    }
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('register → record suites → promote step by step to active; list and show; migrate a foreign live run onto it', async () => {
    const run = (argv: string[], extra: Record<string, string> = {}) => cli(argv, { cwd: dir.path, env: { ...env, ...extra } });
    let r = await run(['runtime', 'list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const listed = parseJson<{ current: string; releases: unknown[] }>(r);
    const current = listed.current;
    assert.match(current, /^rm_[0-9a-f]{64}$/);
    assert.notEqual(current, foreignManifest);
    assert.deepEqual(listed.releases, []);
    r = await run(['runtime', 'list']);
    assert.match(r.stdout, new RegExp(`^no runtime releases registered \\(unmanaged\\); this runtime is ${current}`));

    // the BOM of this runtime
    r = await run(['runtime', 'show', '--json']);
    const manifest = parseJson<RuntimeManifest>(r);
    assert.equal(manifest.manifestId, current);
    assert.equal(manifest.defaultEngine, 'native');
    assert.ok(manifest.agentEngines.every((e) => e.adapter !== undefined), 'every engine names its adapter');
    assert.match(manifest.toolCatalogRevision, /^tc_[0-9a-f]{64}$/);
    r = await run(['runtime', 'show']);
    assert.match(r.stdout, /^manifest {3}rm_[0-9a-f]{64} \(this runtime\)\nstate {6}not registered\n/);
    assert.match(r.stdout, /\nengine {5}native \S+ \(adapter @hypertest\/runtime \S+\) \[default\]\n/);

    // not registered: nothing to promote; decisions from a sandbox are refused; usage errors
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not registered/);
    r = await run(['runtime', 'register', '--by', 'alice'], { HYPERTEST_SANDBOX: '1' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /permission_denied|cannot be taken from inside a Hypertest sandbox/);
    for (const [argv, pattern] of [
      [['runtime'], /missing sub-command/],
      [['runtime', 'deploy'], /unknown sub-command runtime deploy/],
      [['runtime', 'register', '--by', ' '], /--by is required/],
      [['runtime', 'register', '--by', 'robot;rm -rf'], /--by must be a person's name/],
      [['runtime', 'register', '--by', 'alice', '--allow-migration', 'events:a=>b'], /--allow-migration must be <schema>:<from>=><to>/],
      // (F[0], e2e[5]) a pass is never a bare claim: each suite kind takes its own evidence
      [['runtime', 'record-suite', 'current', '--kind', 'replay', '--suite', 's', '--by', 'ci:gh'], /give exactly one of --passed, --failed, --run, --from-eval or --from-shadow/],
      [['runtime', 'record-suite', 'current', '--kind', 'engine_contract', '--suite', 's', '--passed', '--failed', '--by', 'ci:gh'], /give exactly one of --passed, --failed, --run, --from-eval or --from-shadow/],
      [['runtime', 'record-suite', 'current', '--kind', 'vibes', '--suite', 's', '--passed', '--by', 'ci:gh'], /--kind must be one of engine_contract, compatibility, production_replay, release_gate/],
      [['runtime', 'record-suite', 'current', '--kind', 'engine_contract', '--suite', 's', '--passed', '--by', 'ci:gh'], /engine_contract --passed attests a CI report: give it with --report <file>/],
      [['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--suite', 's', '--passed', '--by', 'ci:gh'], /compatibility: --from-eval <SuiteResult\.json> of an eval run on this runtime/],
      [['runtime', 'record-suite', 'current', '--kind', 'production_replay', '--suite', 's', '--passed', '--by', 'ci:gh'], /production_replay: --from-shadow/],
      [['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--suite', 's', '--passed', '--by', 'ci:gh'], /release_gate: --from-eval <core SuiteResult\.json> --baseline/],
      [['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', 'x.json', '--baseline', 'b.json', '--by', 'ci:gh'], /--baseline belongs to --kind release_gate/],
      [['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', 'x.json', '--candidate-arm', 'deployment', '--by', 'ci:gh'], /--candidate-arm belongs to --kind release_gate/],
      [['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r', '--canary-label', 'nokey'], /--canary-label must be key=value/],
      [['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r', '--canary-percent', '101'], /--canary-percent must be an integer between 0 and 100/],
      [['runtime', 'migrate', 'run_x', '--by', 'alice', '--reason', 'r'], /--to is required/],
    ] as Array<[string[], RegExp]>) {
      const u = await run(argv);
      assert.equal(u.code, 2, `${argv.join(' ')}: ${u.stderr}`);
      assert.match(u.stderr, pattern, argv.join(' '));
    }

    r = await run(['runtime', 'register', '--by', 'alice', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const reg = parseJson<{ created: boolean; release: { manifestId: string; state: string; registeredBy: string } }>(r);
    assert.deepEqual([reg.created, reg.release.manifestId, reg.release.state, reg.release.registeredBy], [true, current, 'candidate', 'human:alice']);

    // → shadow: the engine contract (a CI attestation names its report) AND a compatibility eval run under THIS manifest
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be promoted to shadow: no engine_contract suite result is recorded/);
    // executed here: the AgentEngine contract suite of the engines this runtime pins (bound: executed under this manifest)
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'engine_contract', '--run', '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const executed = parseJson<{ passed: boolean; suiteId: string; binding: { kind: string; manifestIds: string[] }; summary: { total: number; failed: number; detail: string }; reportDigest: string }>(r);
    assert.deepEqual([executed.passed, executed.suiteId, executed.binding, executed.summary.failed], [true, 'agent-engine-contract', { kind: 'executed', manifestIds: [current] }, 0]);
    assert.ok(executed.summary.total > 0, 'the contract suite ran cases');
    assert.match(executed.summary.detail, /executed here: .*native-engine\.test\.ts/);
    assert.match(executed.reportDigest, /^[0-9a-f]{64}$/);
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'engine_contract', '--run', '--report', 'x.tap', '--passed', '--by', 'ci:github']);
    assert.equal(r.code, 2, 'executed here, or attested: never both');
    assert.match(r.stderr, /give exactly one of --passed, --failed, --run, --from-eval or --from-shadow/);
    const ciReport = join(dir.path, 'engine-contract.tap');
    await writeFile(ciReport, 'TAP version 13\n# pass 21\n# fail 0\n');
    r = await run(['runtime', 'record-suite', current.slice(0, 14), '--kind', 'engine_contract', '--suite', 'agent-engine-abi', '--revision', '1', '--passed', '--report', ciReport, '--total', '21', '--failures', '0', '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const contract = parseJson<{ passed: boolean; binding: { kind: string }; reportDigest: string; recordedBy: string }>(r);
    assert.deepEqual([contract.passed, contract.binding.kind, contract.recordedBy], [true, 'attested', 'ci:github'], 'a unique prefix names the manifest');
    assert.match(contract.reportDigest, /^[0-9a-f]{64}$/);
    // a suite result that reports failures is never recorded as a pass
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'engine_contract', '--suite', 'agent-engine-abi', '--passed', '--report', ciReport, '--total', '3', '--failures', '1', '--by', 'ci:github']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a result with 1 failed case\(s\) cannot be recorded as passed/);
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no compatibility suite result is recorded/);
    // from an eval suite result: one failing trial ⇒ FAIL (bound to the file by its digest), promotion refused
    const failing = join(dir.path, 'suite-fail.json');
    await writeFile(failing, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-2', trials: [{ result: 'pass', runtimeManifestId: current }, { result: 'infra_error', runtimeManifestId: current }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', failing, '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const failed = parseJson<{ passed: boolean; suiteId: string; suiteRevision: string; summary: { total: number; failed: number }; reportDigest: string }>(r);
    assert.deepEqual([failed.passed, failed.suiteId, failed.suiteRevision, failed.summary.total, failed.summary.failed], [false, 'poc-a-whitebox', 'poc-2', 2, 1]);
    assert.match(failed.reportDigest, /^[0-9a-f]{64}$/);
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the latest compatibility suite result \(poc-a-whitebox@poc-2, rsr_\w+\) failed/);
    // (e2e[5] repro) a passing eval result whose trials ran under ANOTHER manifest certifies nothing here; neither does one
    // whose trials name no manifest (a hand-written file)
    const foreignEval = join(dir.path, 'suite-foreign.json');
    await writeFile(foreignEval, JSON.stringify({ suiteId: 'core', revision: 'core-2', trials: [{ taskId: 't', armId: 'a', trial: 0, result: 'pass', runtimeManifestId: foreignManifest }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', foreignEval, '--by', 'ci:github']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`the eval result does not certify ${current}: its trials ran under ${foreignManifest}`));
    const handWritten = join(dir.path, 'suite-hand.json');
    await writeFile(handWritten, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-2', trials: [{ result: 'pass' }, { result: 'pass' }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', handWritten, '--by', 'ci:github']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /trials without a recorded runtime manifest/);
    // (review) the partial result of an interrupted `eval run` (marked cancelled; every trial that ran passed) never certifies
    const partial = join(dir.path, 'suite-cancelled.json');
    await writeFile(partial, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-2', cancelled: true, trials: [{ result: 'pass', runtimeManifestId: current }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', partial, '--by', 'ci:github']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /CANCELLED \(partial\) eval suite result: it never certifies a release/);
    const passing = join(dir.path, 'suite-pass.json');
    await writeFile(passing, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-2', trials: [{ result: 'pass', runtimeManifestId: current }, { result: 'pass', runtimeManifestId: current }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'replay', '--from-eval', passing, '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /--kind replay is the legacy name of compatibility/);
    const compat = parseJson<{ kind: string; passed: boolean; binding: { kind: string; manifestIds: string[] } }>(r);
    assert.deepEqual([compat.kind, compat.passed, compat.binding], ['compatibility', true, { kind: 'eval_trials', manifestIds: [current] }]);

    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'contract suite green']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted candidate → shadow/);

    // → canary: the production replay — a finished production run (of the other runtime) mirrored dry-run on this shadow
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'replay green', '--canary-percent', '10']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be promoted to canary: no production_replay suite result is recorded/);
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'production_replay', '--from-shadow', '--by', 'ci:shadow']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /production_replay suite shadow-mirror recorded for rm_\w+: FAIL \(rsr_\w+\)\n  0 mirrored run\(s\), 1 required/);
    r = await run(['runtime', 'shadow', '--by', 'ci:shadow', '--scripted-brains', BRAINS]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no production run to mirror/, 'nothing is selected without an active release');
    r = await run(['runtime', 'shadow', productionRun.runId, '--by', 'ci:shadow', '--scripted-brains', BRAINS, '--timeout-ms', '120000'], { HT_CLI_SCENARIO: 'pass' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${productionRun.runId} → ${productionRun.runId}\\.shadow-\\w+: equivalent \\[verdict pass → pass\\]\\n`));
    const shadowRunId = /→ (\S+):/.exec(r.stdout)![1]!;
    r = await run(['status', shadowRunId, '--json']);
    const mirrored = parseJson<{ run: TestRun }>(r).run;
    assert.deepEqual([mirrored.status, mirrored.runtimeManifestId, mirrored.labels['hypertest.shadow_of']], ['completed', current, productionRun.runId]);
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'production_replay', '--from-shadow', '--by', 'ci:shadow', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const replay = parseJson<{ passed: boolean; summary: { total: number; failed: number }; binding: { kind: string; comparisonIds: string[] } }>(r);
    assert.deepEqual([replay.passed, replay.summary.total, replay.summary.failed, replay.binding.kind, replay.binding.comparisonIds.length], [true, 1, 0, 'shadow_comparisons', 1]);
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'replay green']);
    assert.equal(r.code, 1, 'entering canary needs a selection');
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'replay green', '--canary-label', 'canary=yes', '--canary-percent', '10']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted shadow → canary/);

    // → active: the release gate of the CORE eval (trials under THIS manifest) against the committed baseline
    r = await run(['runtime', 'promote', 'current', '--by', 'ci:release-gate', '--reason', 'release gate green']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be promoted to active: no release_gate suite result is recorded/);
    const notCore = join(dir.path, 'poc-candidate.json');
    await writeFile(notCore, JSON.stringify({ ...JSON.parse(await coreCandidate(current)), suiteId: 'poc-all' }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', notCore, '--baseline', CORE_BASELINE, '--by', 'ci:github']);
    assert.equal(r.code, 1, 'another suite never opens canary → active');
    assert.match(r.stderr, /the release gate runs the core eval: candidate suite "poc-all" does not count/);
    // (review) "core" is the BUILT-IN core suite at its current revision and content: a result named core of other content
    // (e.g. a private suite named core, or an older revision) never opens canary → active — as candidate or as baseline
    // (before: a candidate AND a baseline of the same other content compared as comparable, and the gate PASSED)
    const fakeCore = join(dir.path, 'core-fake.json');
    await writeFile(fakeCore, JSON.stringify({ ...JSON.parse(await coreCandidate(current)), suiteFingerprint: 'f'.repeat(64) }));
    const fakeBaseline = join(dir.path, 'core-fake-baseline.json');
    await writeFile(fakeBaseline, JSON.stringify({ ...JSON.parse(await readFile(CORE_BASELINE, 'utf8')), suiteFingerprint: 'f'.repeat(64) }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', fakeCore, '--baseline', fakeBaseline, '--by', 'ci:github']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /--from-eval .*core-fake\.json is not the built-in core suite \(core@core-\d+, content fingerprint [0-9a-f]{12}…\): its result has fingerprint ffffffffffff/);
    const oldCore = join(dir.path, 'core-old.json');
    await writeFile(oldCore, JSON.stringify({ ...JSON.parse(await readFile(CORE_BASELINE, 'utf8')), revision: 'core-1' }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', await (async () => { const f = join(dir.path, 'core-ok.json'); await writeFile(f, await coreCandidate(current)); return f; })(), '--baseline', oldCore, '--by', 'ci:github']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /--baseline .*core-old\.json is not the built-in core suite \(core@core-\d+/);
    const candidateFile = join(dir.path, 'core-candidate.json');
    await writeFile(candidateFile, await coreCandidate(current));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', candidateFile, '--baseline', candidateFile, '--by', 'ci:github']);
    assert.equal(r.code, 1, 'a candidate gated against itself');
    assert.match(r.stderr, /the release gate compared the candidate with itself/);
    // a gate check that fails (a critical false release in the candidate) records a FAILING release gate
    const regressed = join(dir.path, 'core-regressed.json');
    await writeFile(regressed, await coreCandidate(current, (t, i) => {
      if (i === 0) t['outcomeMetrics'] = { ...(t['outcomeMetrics'] as Record<string, number>), criticalFalseRelease: 1 };
    }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', regressed, '--baseline', CORE_BASELINE, '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const gateFail = parseJson<{ passed: boolean; summary: { detail: string }; binding: { kind: string } }>(r);
    assert.deepEqual([gateFail.passed, gateFail.binding.kind], [false, 'eval_gate']);
    assert.match(gateFail.summary.detail, /gate checks failed: .*critical_false_release/);
    r = await run(['runtime', 'promote', 'current', '--by', 'ci:release-gate', '--reason', 'release gate green']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the latest release_gate suite result \(core@core-\d+, rsr_\w+\) failed/);
    // a lenient product SLO is still applied by the same gate (row 321): the baseline itself had none, so the pair check fails
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', regressed, '--baseline', CORE_BASELINE, '--max-critical-false-release', '0.5', '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<{ passed: boolean }>(r).passed, false, 'critical false release worse than the baseline fails whatever the SLO');
    // the release's own deployment arm against the baseline's scripted arm (the release-eval CI job's comparison)
    const deploymentFile = join(dir.path, 'core-deployment.json');
    await writeFile(deploymentFile, await coreCandidate(current, (t) => void (t['armId'] = 'deployment')));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', deploymentFile, '--baseline', CORE_BASELINE, '--baseline-arm', 'scripted-multi-llm', '--candidate-arm', 'deployment', '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const gate = parseJson<{ passed: boolean; suiteId: string; binding: { kind: string; manifestIds: string[]; candidateDigest: string; baselineDigest: string } }>(r);
    assert.deepEqual([gate.passed, gate.suiteId, gate.binding.kind, gate.binding.manifestIds], [true, 'core', 'eval_gate', [current]]);
    assert.notEqual(gate.binding.candidateDigest, gate.binding.baselineDigest);
    r = await run(['runtime', 'promote', 'current', '--by', 'ci:release-gate', '--reason', 'release gate green']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted canary → active/);
    r = await run(['runtime', 'show']);
    assert.match(r.stdout, /\nsuite {6}release_gate core@core-\d+ PASS \(ci:github, /);
    r = await run(['runtime', 'list']);
    assert.match(r.stdout, new RegExp(`\\n\\* ${current}\\s+active\\s+yes\\s+`));
    r = await run(['runtime', 'rollback', '--by', 'alice', '--reason', 'nothing to go back to']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing to roll back/);

    // the foreign run (another runtime, paused by an operator, no claim held) is migrated onto the active release
    r = await run(['runtime', 'migrate', foreignRun.runId, '--to', 'current', '--by', 'alice', '--reason', 'consolidate on the active runtime', '--checkpoint-timeout-ms', '5000']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^run ${foreignRun.runId} migrated ${foreignManifest} → ${current} \\(runtime epoch 1, rte_\\w+\\)\\nstatus paused \\(operator\\); checkpoint snapshot cs_`));
    r = await run(['status', foreignRun.runId, '--json']);
    const status = parseJson<{ run: TestRun }>(r).run;
    assert.deepEqual([status.runtimeManifestId, status.status, status.pauseReason], [current, 'paused', 'operator']);
    r = await run(['events', foreignRun.runId, '--types', 'run.migrated', '--json']);
    const migrated = JSON.parse(r.stdout.trim().split('\n')[0]!) as { payload: { fromManifestId: string; toManifestId: string; by: string } };
    assert.deepEqual([migrated.payload.fromManifestId, migrated.payload.toManifestId, migrated.payload.by], [foreignManifest, current, 'human:alice']);
    // a second migration onto the same manifest is refused (nothing changes)
    r = await run(['runtime', 'migrate', foreignRun.runId, '--to', 'current', '--by', 'alice', '--reason', 'again']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /source_differs: the run is already pinned to the target manifest/);

    // --abort releases only the checkpoint of an abandoned migration
    r = await run(['runtime', 'migrate', foreignRun.runId, '--abort', '--to', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--abort releases an abandoned checkpoint: do not combine it with --to/);
    r = await run(['runtime', 'migrate', foreignRun.runId, '--abort', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1, 'an operator pause is not a migration checkpoint');
    assert.match(r.stderr, /is paused \(operator\): only a run held at a migration checkpoint \(paused migrating\) is released/);
    r = await run(['runtime', 'migrate', foreignRun.runId, '--abort', '--by', 'alice', '--reason', 'r'], { HYPERTEST_SANDBOX: '1' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be taken from inside a Hypertest sandbox/);
    // the state a migration leaves when its process dies after the checkpoint: paused migrating
    {
      const cfg = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
      const ht = await createHypertest(cfg, { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: async () => ({ text: 'noted' }) } });
      try {
        const ctx = { runId: foreignRun.runId, correlationId: 'test', actorId: 'system:test' };
        await ht.services.db.transaction(async (tx) => {
          await ht.services.runs.update(foreignRun.runId, { status: 'running' }, ctx, tx);
          await ht.services.runs.update(foreignRun.runId, { status: 'paused', pauseReason: 'migrating' }, ctx, tx);
        });
      } finally {
        await ht.close();
      }
    }
    r = await run(['runtime', 'migrate', foreignRun.runId, '--abort', '--by', 'alice', '--reason', 'the migrating process died']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `run ${foreignRun.runId}: the checkpoint of the abandoned migration is released; status running, still pinned to ${current}\nresume it with \`hypertest resume\`\n`);
    r = await run(['events', foreignRun.runId, '--types', 'run.migration_released', '--json']);
    const releasedEvent = JSON.parse(r.stdout.trim().split('\n')[0]!) as { actorId: string; payload: { by: string; reason: string } };
    assert.deepEqual([releasedEvent.actorId, releasedEvent.payload.by, releasedEvent.payload.reason], ['human:alice', 'human:alice', 'the migrating process died']);
    await run(['cancel', foreignRun.runId, '--reason', 'test done']);
  });
});

describe('hypertest runtime rollback', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;
  let previousFile: string;
  let previous: string;

  before(async () => {
    dir = await tempDir('ht-cli-rollback-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env };
    // the manifest of an earlier runtime of this installation (one more policy rule), exported as `runtime show --json` would
    const base = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    const ht = await createHypertest(otherRuntime(base), { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: async () => ({ text: 'noted' }) } });
    try {
      previous = ht.manifest.manifestId;
      previousFile = join(dir.path, 'previous-manifest.json');
      await writeFile(previousFile, JSON.stringify(ht.manifest));
    } finally {
      await ht.close();
    }
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('rollback of the active release: the pointer returns to the previous release, live runs are quarantined, the rolled-back runtime starts no run', async () => {
    const run = (argv: string[]) => cli(argv, { cwd: dir.path, env });
    // the earlier runtime was active (registered here from its exported manifest); this runtime replaced it — each walked
    // through every stage gate by its own instance (the gates themselves are exercised by the test above)
    let r = await run(['runtime', 'register', '--manifest', previousFile, '--by', 'alice']);
    assert.equal(r.code, 0, r.stderr);
    const base = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    for (const cfg of [otherRuntime(base), base]) {
      const ht = await createHypertest(cfg, { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: async () => ({ text: 'noted' }) } });
      try {
        await activateViaApi(ht);
      } finally {
        await ht.close();
      }
    }
    r = await run(['runtime', 'list', '--json']);
    const current = parseJson<{ current: string }>(r).current;
    assert.notEqual(current, previous);

    // a live run of this runtime (its lead's first turn never answers; the instance goes away with the run still running)
    const cfg = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    let entered!: () => void;
    const inLead = new Promise<void>((resolve) => (entered = resolve));
    const ht = await createHypertest(cfg, { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: () => (entered(), new Promise(() => undefined)) } });
    let live: TestRun;
    try {
      live = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
      assert.equal(live.runtimeManifestId, current);
      await inLead;
    } finally {
      await ht.close();
    }

    r = await run(['runtime', 'rollback', '--by', 'alice', '--reason', 'replay regression in production']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^runtime ${current} rolled back \\(active → retired\\)\\nactive release is ${previous} again\\nquarantined runs: ${live.runId} \\(migrate them`));
    r = await run(['status', live.runId, '--json']);
    const status = parseJson<{ run: TestRun }>(r).run;
    assert.deepEqual([status.status, status.pauseReason, status.runtimeManifestId], ['paused', 'quarantined', current], 'the run keeps its pin');
    r = await run(['report', live.runId]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /## Runtime release\n\*\*This run is QUARANTINED\*\*/);
    assert.match(r.stdout, new RegExp(`QUARANTINED: runtime release ${current} was rolled back by human:alice \\(replay regression in production\\); the active release is ${previous} again`));
    r = await run(['runtime', 'list', '--json']);
    const views = parseJson<{ releases: Array<{ manifestId: string; state: string; rolledBack: boolean; active: boolean }> }>(r).releases;
    assert.deepEqual(views.map((v) => [v.manifestId, v.state, v.rolledBack, v.active]).sort(), [[current, 'retired', true, false], [previous, 'active', false, true]].sort());

    // the rolled-back runtime (this installation's current one) creates no new run; nothing was created
    r = await run(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /runtime release: runtime rm_\w+… is a retired \(rolled back\) release: new runs are created only under the active release/);
    r = await run(['status', '--json']);
    assert.deepEqual(parseJson<Array<{ runId: string }>>(r).map((x) => x.runId), [live.runId], 'the refused start created no run');
    await run(['cancel', live.runId, '--reason', 'test done']);
  });
});
