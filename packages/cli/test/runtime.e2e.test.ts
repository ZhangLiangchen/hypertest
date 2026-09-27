/**
 * `hypertest runtime` over the real stack (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres): register the
 * installed runtime, record compatibility suites (explicit and from an eval SuiteResult), promote it step by step to
 * active, list/show it, refuse decisions from a sandbox and malformed command lines, roll back, and migrate a live run
 * pinned to another runtime onto the active one.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, loadConfig } from '@hypertest/app';
import type { RuntimeManifest, TestRun } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type TestProject } from './helpers.ts';

describe('hypertest runtime', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;
  let foreignRun: TestRun;
  let foreignManifest: string;

  before(async () => {
    dir = await tempDir('ht-cli-runtime-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env };
    // a live run of ANOTHER runtime of this installation (one more policy rule), created while the store is unmanaged,
    // paused by an operator once its lead's first turn gave its claim back
    const base = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    const other = { ...base, policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read' as const] }, decision: 'allow' as const }] } };
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
      [['runtime', 'record-suite', 'current', '--kind', 'replay', '--suite', 's', '--by', 'ci:gh'], /exactly one of --passed, --failed or --from-eval/],
      [['runtime', 'record-suite', 'current', '--kind', 'replay', '--suite', 's', '--passed', '--failed', '--by', 'ci:gh'], /exactly one of --passed, --failed or --from-eval/],
      [['runtime', 'record-suite', 'current', '--kind', 'vibes', '--suite', 's', '--passed', '--by', 'ci:gh'], /--kind must be one of engine_contract, replay/],
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

    // promotion needs passing suites
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be promoted to shadow: no engine_contract suite result is recorded/);
    r = await run(['runtime', 'record-suite', current.slice(0, 14), '--kind', 'engine_contract', '--suite', 'agent-engine-abi', '--revision', '1', '--passed', '--total', '21', '--failures', '0', '--by', 'ci:github']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^engine_contract suite agent-engine-abi@1 recorded for ${current}: PASS \\(rsr_`), 'a unique prefix names the manifest');
    // a suite result that reports failures is never recorded as a pass
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'replay', '--suite', 'poc-a', '--passed', '--total', '3', '--failures', '1', '--by', 'ci:github']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a result with 1 failed case\(s\) cannot be recorded as passed/);
    // from an eval suite result: one failing trial ⇒ FAIL (bound to the file by its digest), promotion refused
    const failing = join(dir.path, 'suite-fail.json');
    await writeFile(failing, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-1', trials: [{ result: 'pass' }, { result: 'infra_error' }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'replay', '--from-eval', failing, '--by', 'ci:github', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const failed = parseJson<{ passed: boolean; suiteId: string; suiteRevision: string; summary: { total: number; failed: number }; reportDigest: string }>(r);
    assert.deepEqual([failed.passed, failed.suiteId, failed.suiteRevision, failed.summary.total, failed.summary.failed], [false, 'poc-a-whitebox', 'poc-1', 2, 1]);
    assert.match(failed.reportDigest, /^[0-9a-f]{64}$/);
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'r']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the latest replay suite result \(poc-a-whitebox@poc-1, rsr_\w+\) failed/);
    const passing = join(dir.path, 'suite-pass.json');
    await writeFile(passing, JSON.stringify({ suiteId: 'poc-a-whitebox', revision: 'poc-1', trials: [{ result: 'pass' }, { result: 'pass' }], perArm: {}, comparisons: [] }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'replay', '--from-eval', passing, '--by', 'ci:github']);
    assert.equal(r.code, 0, r.stderr);

    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'contract suite green']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted candidate → shadow/);
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'replay green']);
    assert.equal(r.code, 1, 'entering canary needs a selection');
    r = await run(['runtime', 'promote', 'current', '--by', 'alice', '--reason', 'replay green', '--canary-label', 'canary=yes', '--canary-percent', '10']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted shadow → canary/);
    r = await run(['runtime', 'promote', 'current', '--by', 'ci:release-gate', '--reason', 'release gate green']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted canary → active/);
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
    const other = { ...base, policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read' as const] }, decision: 'allow' as const }] } };
    const ht = await createHypertest(other, { env: { ...process.env, ...env }, logger: new MemoryLogger(), scriptedBrains: { sim: async () => ({ text: 'noted' }) } });
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
    const activate = async (ref: string, extra: string[] = []) => {
      let r = await run(['runtime', 'register', ...extra, '--by', 'alice']);
      assert.equal(r.code, 0, r.stderr);
      for (const kind of ['engine_contract', 'replay']) {
        r = await run(['runtime', 'record-suite', ref, '--kind', kind, '--suite', `${kind}-suite`, '--passed', '--total', '3', '--failures', '0', '--by', 'ci:github']);
        assert.equal(r.code, 0, r.stderr);
      }
      for (const step of [[], ['--canary-percent', '100'], []]) {
        r = await run(['runtime', 'promote', ref, '--by', 'alice', '--reason', 'suites green', ...step]);
        assert.equal(r.code, 0, r.stderr);
      }
    };
    // the earlier runtime was active; this runtime replaced it
    await activate(previous, ['--manifest', previousFile]);
    await activate('current');
    let r = await run(['runtime', 'list', '--json']);
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
