/**
 * createHypertest end to end on the real stack (PGlite, or PostgreSQL with HYPERTEST_TEST_DB=postgres): a scripted
 * provider + route drives a tiny run (lead plan → executor runs a real node:test suite in a temp git repo → lead
 * readyForGate → QualityGate), pinned to the RuntimeManifest; failure paths of the composition root; crash/restart
 * resume over the same data directory; close() releasing every handle (child-process exit probe); cancellation,
 * human approvals and oracle decisions through the facade.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger, canonicalJson } from '@hypertest/core';
import { recordEvidence, verifyEd25519 } from '@hypertest/evidence';
import type { Finding } from '@hypertest/domain';
import { collabMigrations } from '@hypertest/collab';
import { RUNTIME_PACKAGE_VERSION, toolCatalogRevision, verifyRuntimeManifest } from '@hypertest/runtime';
import { PI_AGENT_CORE_VERSION, RUNTIME_PI_PACKAGE_VERSION } from '@hypertest/runtime-pi';
import { tempDir } from '@hypertest/testkit';
import type { RunOutcome } from '@hypertest/durable';
import { createHypertest, hypertestGitSha, startApiServer, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type BrainView } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const GOAL = 'Is the sum module releasable?';

function config(dataDir: string, store: HypertestConfig['store'] | undefined, extra: Record<string, unknown> = {}): HypertestConfig {
  const c = scriptedConfig(dataDir, { gate: { requireIndependentReview: false }, ...extra });
  return store ? { ...c, store } : c;
}

describe('createHypertest: a tiny run end to end', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance;
  let outcome: RunOutcome;
  const calls: BrainView[] = [];

  before(async () => {
    dir = await tempDir('ht-app-e2e-');
    repo = await sumRepo();
    db = await testStore();
    ht = await createHypertest(config(dir.path, db.store), { scriptedBrains: { sim: roleRouter(tinyRunBrains(), calls) }, logger: new MemoryLogger() });
    outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head }, labels: { project: 'calc' } }, { timeoutMs: 90_000 });
  });
  after(async () => {
    await ht?.close();
    await db?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('the QualityGate computes the verdict: pass, signed over its content, bound to the sealed evidence root', async () => {
    assert.equal(outcome.status, 'completed');
    const d = outcome.decision!;
    assert.equal(d.verdict, 'pass');
    assert.deepEqual(d.violatedCriteria, []);
    assert.deepEqual(d.unknownCriteria, []);
    const { signature, ...unsigned } = d;
    assert.equal(signature!.keyId, ht.services.signer.keyId);
    assert.equal(verifyEd25519(ht.services.signer.publicKeyPem(), canonicalJson(unsigned), signature!.value), true);
    const seal = await ht.services.evidence.latestSeal(outcome.runId);
    assert.equal(seal!.rootHash, d.evidenceRootHash);
    assert.deepEqual(await ht.verifyEvidence(outcome.runId), { ok: true, problems: [] });
    const run = (await ht.status(outcome.runId))!;
    assert.equal(run.decisionId, d.decisionId);
    const report = await ht.report(outcome.runId);
    assert.equal(report.verdict, 'pass');
    assert.deepEqual(report.models.map((m) => [m.role, m.routeId]).sort(), [['executor', 'sim-large'], ['lead', 'sim-large']]);
  });

  test('the product loop ran: plan v1 (executor) → real node:test suite with test-result evidence → plan v2 readyForGate', async () => {
    const items = await ht.services.blackboard.listWorkItems({ runId: outcome.runId });
    assert.deepEqual(items.map((w) => [w.kind, w.role, w.state]), [['initial_plan', 'lead', 'completed'], ['task', 'executor', 'completed'], ['replan', 'lead', 'completed']]);
    const results = await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'test-result' });
    assert.equal(results.length, 1);
    const s = results[0]!.structured as { passed: boolean; totals: { passed: number; failed: number } };
    assert.deepEqual([s.passed, s.totals.passed, s.totals.failed], [true, 2, 0]);
    const plans = await ht.services.blackboard.listPlans(outcome.runId);
    assert.deepEqual(plans.map((p) => [p.revision, p.readyForGate]), [[1, false], [2, true]]);
    assert.deepEqual([...new Set(calls.map((c) => c.role))].sort(), ['executor', 'lead']);
  });

  test('I11: the run is pinned to the RuntimeManifest built by the composition root', async () => {
    const m = ht.manifest;
    const run = (await ht.status(outcome.runId))!;
    assert.equal(run.runtimeManifestId, m.manifestId);
    assert.equal(outcome.decision!.runtimeManifestId, m.manifestId);
    assert.equal(verifyRuntimeManifest(m), true);
    const pinned = await ht.services.db.query<{ manifest_id: string }>('SELECT manifest_id FROM ht_manifests WHERE manifest_id = $1', [m.manifestId]);
    assert.equal(pinned.rows.length, 1);
    const rootVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    assert.equal(m.hypertest.version, rootVersion);
    // runtime BOM: each engine with the Hypertest package adapting it (runtime-pi adapter version), the default engine
    assert.deepEqual(m.agentEngines, [
      { kind: 'native', version: RUNTIME_PACKAGE_VERSION, adapter: { package: '@hypertest/runtime', version: RUNTIME_PACKAGE_VERSION } },
      { kind: 'pi', version: PI_AGENT_CORE_VERSION, adapter: { package: '@hypertest/runtime-pi', version: RUNTIME_PI_PACKAGE_VERSION } },
    ]);
    assert.equal(m.defaultEngine, 'native');
    const adapters = m.providerAdapters.map((a) => `${a.provider}|${a.package}|${a.version}`);
    assert.ok(adapters.includes(`engine:pi|@hypertest/runtime-pi|${RUNTIME_PI_PACKAGE_VERSION}`));
    assert.ok(adapters.includes(`engine:pi|@earendil-works/pi-agent-core|${PI_AGENT_CORE_VERSION}`));
    assert.ok(adapters.includes(`engine:native|@hypertest/runtime|${RUNTIME_PACKAGE_VERSION}`));
    assert.ok(adapters.some((a) => a.startsWith('sim|@hypertest/model#scripted|')));
    assert.equal(m.modelCatalogRevision, ht.services.catalog.revision);
    // the tool catalog revision pins every tool's timeout and side-effect binding and every adapter's capabilities
    assert.equal(m.toolCatalogRevision, toolCatalogRevision(ht.services.tools.list(), ht.services.adapters!.list()));
    assert.match(m.toolCatalogRevision, /^tc_[0-9a-f]{64}$/);
    assert.equal(m.policyBundleRevision, `${ht.services.policy.revision}+roles:${ht.services.roles.revision()}`);
    assert.equal(m.roleCatalogRevision, ht.services.roles.revision());
    // gitSha: HEAD of this installation when it is the top level of a git checkout (never invented otherwise); no image
    // digest is set in this test, so none is pinned
    assert.equal(m.hypertest.gitSha, hypertestGitSha());
    let head: string | undefined;
    try {
      const [top, sha] = execFileSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
      if (top && realpathSync(top) === realpathSync(ROOT)) head = sha;
    } catch {
      head = undefined; // not a checkout (e.g. an unpacked release): nothing to pin
    }
    assert.equal(m.hypertest.gitSha, head);
    assert.equal(m.hypertest.imageDigest, undefined);
    assert.deepEqual(m.protocol, { id: 'bugate', version: ht.services.protocol.binding.version, digest: ht.services.protocol.binding.digest });
    assert.equal(m.schemas.event, collabMigrations.map((x) => x.id).sort().at(-1));
    // the catalog completed the route with the defaults and the provider tag
    const route = ht.services.catalog.get('sim-large')!;
    assert.equal(route.continuationCompatibilityClass, 'sim:sim-1');
    assert.equal(route.contextWindow, 128_000);
    // every built-in and domain tool is in the pinned catalog
    for (const id of ['test.run', 'fs.read', 'load.start', 'plan.propose_revision', 'complete_work']) assert.ok(ht.services.tools.get(id), id);
  });

  test('L0 is readable through the facade (events(), listRuns())', async () => {
    const events = await ht.events(outcome.runId);
    const types = events.map((e) => e.eventType);
    assert.equal(types[0], 'run.created');
    for (const t of ['work.created', 'model.routed', 'tool.called', 'test.passed', 'gate.evaluated', 'gate.passed']) assert.ok(types.includes(t), t);
    const seqs = events.map((e) => e.seq!);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.deepEqual((await ht.events(outcome.runId, { afterSeq: seqs.at(-2)! })).map((e) => e.seq), [seqs.at(-1)]);
    assert.deepEqual((await ht.listRuns()).map((r) => r.runId), [outcome.runId]);
  });

  test('a finished run keeps its outcome: cancel() is a conflict; verifying an unknown run is not_found (never "ok")', async () => {
    await assert.rejects(ht.cancel(outcome.runId, 'too late'), (e: unknown) => e instanceof HypertestError && e.code === 'conflict' && e.message === `run ${outcome.runId} is already completed`);
    assert.equal((await ht.status(outcome.runId))!.status, 'completed');
    await assert.rejects(ht.verifyEvidence('run_does_not_exist'), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
  });

  // mutates the run's decision pointer: keep it last in this describe
  test('verifyEvidence checks the verdict itself: an altered, an unsigned or a re-bound decision is reported', async () => {
    const runId = outcome.runId;
    const ctx = { runId, correlationId: runId, actorId: 'human:mallory' };
    const genuine = (await ht.services.decisions.get((await ht.status(runId))!.decisionId!))!;
    // 1 content altered in the store, signature kept
    const altered = { ...genuine, decisionId: 'qd_forged_1', revision: genuine.revision + 1, supersedes: genuine.decisionId, reasons: ['looks fine to me'] };
    await ht.services.decisions.save(altered, ctx);
    await ht.services.runs.update(runId, { decisionId: altered.decisionId }, ctx);
    assert.deepEqual(await ht.verifyEvidence(runId), { ok: false, problems: ['decision_signature: the signature of decision qd_forged_1 does not verify (its content was altered)'] });
    // 2 unsigned
    const { signature: _sig, ...unsignedGenuine } = genuine;
    const unsigned = { ...unsignedGenuine, decisionId: 'qd_forged_2' };
    await ht.services.decisions.save(unsigned, ctx);
    await ht.services.runs.update(runId, { decisionId: unsigned.decisionId }, ctx);
    assert.deepEqual((await ht.verifyEvidence(runId)).problems, ['decision_signature: decision qd_forged_2 is not signed']);
    // 3 validly signed by the trusted key but bound to other evidence
    const rebound = { ...unsignedGenuine, decisionId: 'qd_forged_3', revision: genuine.revision + 3, supersedes: 'qd_forged_2', evidenceRootHash: 'f'.repeat(64) };
    const value = await ht.services.signer.sign(canonicalJson(rebound));
    await ht.services.decisions.save({ ...rebound, signature: { keyId: ht.services.signer.keyId, algorithm: 'ed25519', value } }, ctx);
    await ht.services.runs.update(runId, { decisionId: rebound.decisionId }, ctx);
    const v = await ht.verifyEvidence(runId);
    assert.equal(v.ok, false);
    assert.deepEqual(v.problems.map((p) => p.split(' is bound to')[0]), ['decision_root: decision qd_forged_3']);
    // the genuine decision still verifies
    await ht.services.runs.update(runId, { decisionId: genuine.decisionId }, ctx);
    assert.deepEqual(await ht.verifyEvidence(runId), { ok: true, problems: [] });
  });
});

describe('engines.default: pi', () => {
  test('the tiny run completes on the Pi engine (pi-agent-core adapter) with the same governance and verdict', async () => {
    const dir = await tempDir('ht-app-pi-');
    const repo = await sumRepo();
    const db = await testStore();
    const ht = await createHypertest({ ...config(dir.path, db.store), engines: { default: 'pi' } }, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
      assert.deepEqual([outcome.status, outcome.decision?.verdict], ['completed', 'pass']);
      const kinds = await ht.services.db.query<{ engine_kind: string }>('SELECT engine_kind FROM ht_agents ORDER BY created_at');
      assert.deepEqual(kinds.rows.map((r) => r.engine_kind), ['pi', 'pi', 'pi']);
    } finally {
      await ht.close();
      await db.dispose();
      await repo.cleanup();
      await dir.cleanup();
    }
  });
});

describe('composition failures fail fast and leave nothing open', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-fail-')));
  after(async () => dir.cleanup());

  test('invalid configuration ⇒ invalid_argument listing every problem', async () => {
    const bad = { ...scriptedConfig(join(dir.path, 'a')), engines: { default: 'openhands' }, bogus: 1 } as unknown as HypertestConfig;
    await assert.rejects(createHypertest(bad, { scriptedBrains: {} }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'invalid_argument');
      assert.deepEqual((e.details as { errors: string[] }).errors, [
        "unknown configuration key 'bogus' (expected one of version, project, store, bus, durable, artifacts, models, roles, budget, gate, policy, bugate, engines, sandbox, environments, tools, signing, memory, observability, oracles, runtime)",
        'engines.default: "openhands" is not a registered engine (native, pi, dsh)',
      ]);
      return true;
    });
    assert.equal(existsSync(join(dir.path, 'a')), false, 'nothing was created');
  });

  test('a scripted provider without a brain ⇒ invalid_argument before any resource is opened', async () => {
    await assert.rejects(
      createHypertest(scriptedConfig(join(dir.path, 'b')), { scriptedBrains: {}, logger: new MemoryLogger() }),
      (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && e.message === "models.providers (sim): scripted provider has no brain; pass overrides.scriptedBrains['sim']",
    );
    assert.equal(existsSync(join(dir.path, 'b')), false, 'no data directory, database or key was created');
  });

  test('no routes ⇒ start() fails fast with a clear error and creates no run; an unroutable lead likewise', async () => {
    const noRoutes = { ...scriptedConfig(join(dir.path, 'c')), models: { providers: [{ id: 'sim', kind: 'scripted' as const }], routes: [] } };
    const ht = await createHypertest(noRoutes, { scriptedBrains: { sim: roleRouter({}) }, logger: new MemoryLogger() });
    try {
      await assert.rejects(ht.start({ goal: GOAL, target: {} }), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /no model routes are configured/.test(e.message));
      assert.deepEqual(await ht.listRuns(), []);
    } finally {
      await ht.close();
    }
    const weak = { ...noRoutes, models: { ...noRoutes.models, routes: [{ routeId: 'plain', provider: 'sim', model: 'm', capabilities: ['reasoning' as const] }] } };
    const ht2 = await createHypertest(weak, { scriptedBrains: { sim: roleRouter({}) }, logger: new MemoryLogger() });
    try {
      await assert.rejects(ht2.start({ goal: GOAL, target: {} }), (e: unknown) => {
        assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
        assert.match(e.message, /^no configured route can serve the lead role \(plain: capability — /);
        return true;
      });
      assert.deepEqual(await ht2.listRuns(), []);
    } finally {
      await ht2.close();
    }
  });
});

describe('restart: resumeIncomplete over the same data directory', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-restart-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('a run interrupted by close() mid-turn is found by the next instance, resumed and completed', async () => {
    let entered!: () => void;
    const inLead = new Promise<void>((resolve) => (entered = resolve));
    // the first process "crashes" while its lead is thinking
    const stuck = roleRouter({
      lead: () => {
        entered();
        return new Promise(() => undefined);
      },
    });
    const cfg = config(dir.path, db.store);
    const first = await createHypertest(cfg, { scriptedBrains: { sim: stuck }, logger: new MemoryLogger() });
    const run = await first.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
    await inLead;
    await first.close();
    await first.close(); // idempotent
    await assert.rejects(first.start({ goal: GOAL, target: {} }), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable');

    const second = await createHypertest(cfg, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      assert.equal(second.manifest.manifestId, first.manifest.manifestId, 'the same runtime yields the same manifest id');
      assert.equal((await second.status(run.runId))!.status, 'running');
      assert.deepEqual(await second.resumeIncomplete(), [run.runId]);
      const outcome = await second.durable.awaitCompletion(run.runId, { timeoutMs: 90_000 });
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.decision!.verdict, 'pass');
      const items = await second.services.blackboard.listWorkItems({ runId: run.runId });
      assert.deepEqual(items.map((w) => [w.kind, w.state]), [['initial_plan', 'completed'], ['task', 'completed'], ['replan', 'completed']]);
      assert.deepEqual(await second.verifyEvidence(run.runId), { ok: true, problems: [] });
      assert.deepEqual(await second.resumeIncomplete(), [], 'nothing left to resume');
    } finally {
      await second.close();
    }
  });
});

describe('I11: a restart with another runtime never drives the runs pinned to the previous one', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-pin-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('another manifest skips the run (resumeIncomplete, start by runId, a direct durable start all refuse); the original runtime completes it', async () => {
    let entered!: () => void;
    const inLead = new Promise<void>((resolve) => (entered = resolve));
    const cfg = config(dir.path, db.store);
    const first = await createHypertest(cfg, { scriptedBrains: { sim: roleRouter({ lead: () => (entered(), new Promise(() => undefined)) }) }, logger: new MemoryLogger() });
    const run = await first.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
    await inLead;
    await first.close();

    // an "upgraded" runtime: one more policy rule ⇒ another policy bundle ⇒ another manifest
    const upgraded: HypertestConfig = { ...cfg, policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read'] }, decision: 'allow' }] } };
    const logger = new MemoryLogger();
    const other = await createHypertest(upgraded, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger });
    try {
      assert.notEqual(other.manifest.manifestId, first.manifest.manifestId);
      const eventsBefore = (await other.events(run.runId)).length;
      assert.deepEqual(await other.resumeIncomplete(), [], 'not resumed by a runtime it is not pinned to');
      const warn = logger.entries.find((e) => e.msg === 'incomplete runs pinned to another runtime manifest are not resumed by this runtime (I11)');
      assert.deepEqual(warn?.fields?.['runs'], [{ runId: run.runId, runtimeManifestId: first.manifest.manifestId }]);
      await assert.rejects(other.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head }, runId: run.runId }), (e: unknown) => {
        assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
        assert.match(e.message, new RegExp(`^run ${run.runId} is pinned to runtime manifest ${first.manifest.manifestId}; this runtime is ${other.manifest.manifestId} \\(I11`));
        return true;
      });
      // even a direct durable start (bypassing the facade) is refused at the control boundary
      await other.durable.startRun(run.runId);
      await assert.rejects(other.durable.awaitCompletion(run.runId, { timeoutMs: 30_000 }), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed');
      assert.equal((await other.status(run.runId))!.status, 'running');
      assert.equal((await other.events(run.runId)).length, eventsBefore, 'the other runtime did not act on the run');
    } finally {
      await other.close();
    }

    const original = await createHypertest(cfg, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      assert.equal(original.manifest.manifestId, first.manifest.manifestId);
      assert.deepEqual(await original.resumeIncomplete(), [run.runId]);
      const outcome = await original.durable.awaitCompletion(run.runId, { timeoutMs: 90_000 });
      assert.deepEqual([outcome.status, outcome.decision?.verdict, outcome.decision?.runtimeManifestId], ['completed', 'pass', first.manifest.manifestId]);
    } finally {
      await original.close();
    }
  });
});

describe('facade robustness: run ids, a durable start that fails, best-effort wake after a decision', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const logger = new MemoryLogger();
  before(async () => {
    dir = await tempDir('ht-app-robust-');
    db = await testStore();
    ht = await createHypertest(config(dir.path, db.store), {
      scriptedBrains: { sim: roleRouter({ lead: async () => (await released, { toolCalls: [{ name: 'fail_work', arguments: { reason: 'cancelled', message: 'stop' } }] }) }) },
      logger,
    });
  });
  after(async () => {
    release();
    await ht.close();
    await db.dispose();
    await dir.cleanup();
  });

  test('an unsafe runId or an invalid gate/budget override is refused before any run exists', async () => {
    for (const runId of ['../escape', 'a/b', '', 'x'.repeat(129)]) {
      await assert.rejects(ht.start({ goal: GOAL, target: {}, runId }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /^runId must match/.test(e.message), runId);
    }
    await assert.rejects(ht.start({ goal: GOAL, target: {}, gate: { failOnUnresolvedSeverity: 'P9' as never } }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'invalid_argument');
      assert.deepEqual((e.details as { errors: string[] }).errors, ['gate.failOnUnresolvedSeverity must be one of P0, P1, P2, P3, got "P9"']);
      return true;
    });
    assert.deepEqual(await ht.listRuns(), []);
  });

  test('a durable start that fails names the created run; resumeIncomplete drives it later', async () => {
    const durable = ht.durable as unknown as { startRun: (runId: string) => Promise<void> };
    durable.startRun = async () => {
      throw new HypertestError('unavailable', 'Temporal frontend unreachable');
    };
    let created = '';
    try {
      await assert.rejects(ht.start({ goal: GOAL, target: {}, runId: 'run_app_robust_1' }), (e: unknown) => {
        assert.ok(e instanceof HypertestError && e.code === 'unavailable');
        assert.equal(e.message, 'run run_app_robust_1 was created but its durable loop could not be started: Temporal frontend unreachable; resumeIncomplete() (hypertest resume) drives it');
        created = (e.details as { runId: string }).runId;
        return true;
      });
    } finally {
      delete (durable as { startRun?: unknown }).startRun; // the prototype's method again
    }
    assert.equal(created, 'run_app_robust_1');
    assert.equal((await ht.status(created))!.status, 'running');
    assert.deepEqual(await ht.resumeIncomplete(), [created]);
  });

  test('a decision is recorded even when waking the run fails (logged, never reported as a failed decision)', async () => {
    const runId = 'run_app_robust_1';
    const approval = await ht.services.approvals.request({ runId, kind: 'manual_review', subject: { what: 'deploy' }, requestedBy: { kind: 'agent', id: 'ag_x' } }, { runId, correlationId: runId, actorId: 'agent:ag_x' });
    const durable = ht.durable as unknown as { signal: (...a: unknown[]) => Promise<void> };
    durable.signal = async () => {
      throw new HypertestError('unavailable', 'could not signal');
    };
    try {
      await ht.approve(approval.approvalId, true, { kind: 'human', id: 'alice' }, 'ok');
    } finally {
      delete (durable as { signal?: unknown }).signal;
    }
    assert.equal((await ht.services.approvals.get(approval.approvalId))!.status, 'approved');
    const warn = logger.entries.find((e) => e.msg === 'could not wake the run after a decision; its loop picks the decision up on its next tick');
    assert.deepEqual(warn?.fields, { runId, error: 'could not signal' });
    await ht.cancel(runId, 'test done');
  });
});

describe('facade operations: cancel, approvals, oracle decisions', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  before(async () => {
    dir = await tempDir('ht-app-facade-');
    db = await testStore();
    ht = await createHypertest(config(dir.path, db.store), {
      scriptedBrains: { sim: roleRouter({ lead: async () => (await released, { toolCalls: [{ name: 'fail_work', arguments: { reason: 'cancelled', message: 'stop' } }] }) }) },
      logger: new MemoryLogger(),
    });
  });
  after(async () => {
    release();
    await ht.close();
    await db.dispose();
    await dir.cleanup();
  });

  test('cancel(): the control plane cancels the run and its work; the durable loop reports it final', async () => {
    const run = await ht.start({ goal: GOAL, target: {} });
    const done = ht.durable.awaitCompletion(run.runId, { timeoutMs: 30_000 });
    await ht.cancel(run.runId, 'operator abort');
    const outcome = await done;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.decision, undefined, 'a cancelled run has no verdict');
    const items = await ht.services.blackboard.listWorkItems({ runId: run.runId });
    assert.deepEqual(items.map((w) => w.state), ['cancelled']);
    await assert.rejects(ht.cancel('run_missing', 'x'), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
  });

  test('approve(): a human decides an agent request; the requester cannot; unknown ids are not_found', async () => {
    const [run] = await ht.listRuns();
    const ctx = { runId: run!.runId, correlationId: run!.runId, actorId: 'agent:ag_x' };
    const requested = await ht.services.approvals.request({ runId: run!.runId, kind: 'manual_review', subject: { what: 'deploy' }, requestedBy: { kind: 'agent', id: 'ag_x' } }, ctx);
    await ht.approve(requested.approvalId, true, { kind: 'human', id: 'alice' }, 'looks safe');
    const decided = (await ht.services.approvals.get(requested.approvalId))!;
    assert.deepEqual([decided.status, decided.decidedBy, decided.rationale], ['approved', { kind: 'human', id: 'alice' }, 'looks safe']);
    assert.deepEqual((await ht.listApprovals({ runId: run!.runId })).map((a) => a.approvalId), [requested.approvalId]);
    await assert.rejects(ht.approve('apr_missing', true, { kind: 'human', id: 'alice' }, 'x'), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
  });

  test('decideOracleProposal(): human approval creates a revision; a change flipping a recorded failure needs a human (agents refused)', async () => {
    const [run] = await ht.listRuns();
    const runId = run!.runId;
    const ctx = { runId, correlationId: runId, actorId: 'human:qa-lead' };
    const assertion = (severity: 'P1' | 'P3', assertionId = 'discount-10', testSelector = '*discount*') => ({
      assertionId, description: `${assertionId} holds`, kind: 'deterministic_invariant' as const, severity, check: { type: 'test_outcome' as const, testSelector, expected: 'pass' as const },
    });
    await ht.services.oracles.establish(
      {
        oracleId: 'oracle.pricing', scope: { components: ['pricing'], description: 'REQ-7' }, assertions: [assertion('P1')], authorities: [{ sourceRef: 'REQ-7', authority: 'approved_requirement' }],
        judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
        changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human', 'independent_agent'] },
      } as never,
      { kind: 'human', id: 'qa-lead' },
      ctx,
    );
    // a recorded failure of this run cites the assertion
    await ht.services.blackboard.postRecord(
      { runId, recordType: 'finding', createdBy: 'ag_exec', payload: { title: 'discount doubled', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp', oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'discount-10' } } },
      ctx,
    );
    const proposer = { kind: 'agent' as const, id: 'ag_exec', role: 'executor', modelProvider: 'sim' };
    const weaken = await ht.services.oracles.propose({ runId, oracleId: 'oracle.pricing', fromRevision: 1, proposedAssertions: [assertion('P3')], rationale: 'downgrade it to get green', relatedEvidenceRefs: [] }, proposer, ctx);
    assert.equal(weaken.wouldFlipRecordedFailure, true);
    await assert.rejects(
      // an independent agent (other provider, other role) would be acceptable — but not for a flip
      ht.services.oracles.decide(weaken.proposalId, true, { kind: 'agent', id: 'ag_rev', role: 'reviewer', modelProvider: 'other' }, 'fine', ctx),
      (e: unknown) => e instanceof HypertestError && e.code === 'permission_denied' && /would flip a recorded failure; a human approver is required/.test(e.message),
    );
    await ht.decideOracleProposal(weaken.proposalId, false, { kind: 'human', id: 'qa-lead' }, 'REQ-7 still holds');
    assert.equal((await ht.services.specs.getOracleProposal(weaken.proposalId))!.status, 'rejected');
    const tighten = await ht.services.oracles.propose(
      { runId, oracleId: 'oracle.pricing', fromRevision: 1, proposedAssertions: [assertion('P1'), assertion('P1', 'discount-0', '*zero*')], rationale: 'cover 0%', relatedEvidenceRefs: [] },
      proposer,
      ctx,
    );
    assert.equal(tighten.wouldFlipRecordedFailure, false, 'adding an assertion flips nothing');
    await ht.decideOracleProposal(tighten.proposalId, true, { kind: 'human', id: 'qa-lead' }, 'more coverage');
    assert.equal((await ht.services.specs.getOracle('oracle.pricing'))!.revision, 2);
    await assert.rejects(ht.decideOracleProposal('ocp_missing', true, { kind: 'human', id: 'qa-lead' }, 'x'), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
  });

  test('the composed flip detector reads the record, not what the proposer cites: superseded findings and the run\'s failed test cases count', async () => {
    const [run] = await ht.listRuns();
    const runId = run!.runId;
    const ctx = { runId, correlationId: runId, actorId: 'agent:ag_exec' };
    const proposer = { kind: 'agent' as const, id: 'ag_exec', role: 'executor', modelProvider: 'sim' };
    const rev2 = (await ht.services.specs.getOracle('oracle.pricing'))!; // discount-10 (*discount*) + discount-0 (*zero*)
    assert.equal(rev2.revision, 2);
    const keep = (id: string) => rev2.assertions.filter((a) => a.assertionId === id);
    // (a) the finding citing discount-10 was later marked rejected: its earlier revision still recorded the failure
    const [finding] = await ht.services.blackboard.query<Finding>({ runId, recordType: 'finding' });
    await ht.services.blackboard.postRecord({ runId, recordType: 'finding', createdBy: 'ag_exec', payload: { ...finding!.payload, status: 'rejected' }, supersedes: finding!.recordId }, ctx);
    const dropTen = await ht.services.oracles.propose({ runId, oracleId: 'oracle.pricing', fromRevision: 2, proposedAssertions: keep('discount-0'), rationale: 'finding rejected', relatedEvidenceRefs: [] }, proposer, ctx);
    assert.equal(dropTen.wouldFlipRecordedFailure, true);
    // (b) no finding cites discount-0, the proposer cites nothing — but the run recorded a failed test case it covers
    await recordEvidence(ht.services.evidence, ht.services.artifacts, {
      runId, evidenceType: 'test-result', data: '{"cases":[]}', mimeType: 'application/json', summary: '1 failed',
      structured: { passed: false, cases: [{ id: 'test/pricing.test.js::zero discount keeps the price', status: 'failed' }] },
      producer: { workerId: ht.services.workerId, runtimeManifestId: ht.manifest.manifestId }, provenance: {},
    });
    const dropZero = await ht.services.oracles.propose({ runId, oracleId: 'oracle.pricing', fromRevision: 2, proposedAssertions: keep('discount-10'), rationale: 'flaky', relatedEvidenceRefs: [] }, proposer, ctx);
    assert.equal(dropZero.wouldFlipRecordedFailure, true);
    await assert.rejects(
      ht.services.oracles.decide(dropZero.proposalId, true, { kind: 'agent', id: 'ag_rev', role: 'reviewer', modelProvider: 'other' }, 'fine', ctx),
      (e: unknown) => e instanceof HypertestError && e.code === 'permission_denied' && /a human approver is required/.test(e.message),
    );
  });
});

describe('REST API over a real instance', () => {
  test('POST /runs → SSE event stream until the run ends → report and evidence verification', async () => {
    const dir = await tempDir('ht-app-api-');
    const repo = await sumRepo();
    const db = await testStore();
    const ht = await createHypertest(config(dir.path, db.store), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    const api = await startApiServer(ht, { port: 0, eventPollMs: 50 });
    try {
      const post = await fetch(`${api.url}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }) });
      assert.equal(post.status, 202);
      const { run } = (await post.json()) as { run: { runId: string; status: string } };
      assert.equal(run.status, 'running');
      const sse = await fetch(`${api.url}/runs/${run.runId}/events`);
      assert.equal(sse.status, 200);
      const text = await sse.text(); // the stream ends by itself once the run is terminal
      const frames = text.split('\n\n').filter((f) => f.startsWith('id: '));
      const types = frames.map((f) => /\nevent: (\S+)/.exec(f)![1]);
      assert.equal(types[0], 'run.created');
      assert.ok(types.includes('gate.evaluated') && types.includes('run.completed'), types.join(','));
      const seqs = frames.map((f) => Number(/^id: (\d+)/.exec(f)![1]));
      assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'every L0 event once, in seq order');
      assert.match(text, new RegExp(`event: end\ndata: \\{"runId":"${run.runId}","status":"completed","lastSeq":${seqs.at(-1)}\\}`));
      const report = (await (await fetch(`${api.url}/runs/${run.runId}/report`)).json()) as { verdict: string };
      assert.equal(report.verdict, 'pass');
      assert.deepEqual(await (await fetch(`${api.url}/runs/${run.runId}/evidence/verify`)).json(), { ok: true, problems: [] });
      const health = (await (await fetch(`${api.url}/health`)).json()) as { manifestId: string };
      assert.equal(health.manifestId, ht.manifest.manifestId);
    } finally {
      await api.close();
      await ht.close();
      await db.dispose();
      await repo.cleanup();
      await dir.cleanup();
    }
  });
});

describe('close() releases every handle', () => {
  test('a process that composed Hypertest, ran a run and closed it exits on its own', async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'exit-probe.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    const exitedAt = Date.now();
    clearTimeout(killer);
    assert.equal(signal, null, `killed: ${stderr}`);
    assert.equal(code, 0, stderr);
    const m = /^closed completed pass (\d+)$/m.exec(stdout);
    assert.ok(m, stdout + stderr);
    assert.ok(exitedAt - Number(m[1]) < 3000, `the process lingered ${exitedAt - Number(m[1])} ms after close()`);
  });
});
