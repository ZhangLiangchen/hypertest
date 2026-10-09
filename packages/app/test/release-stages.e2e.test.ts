/**
 * F[0] the per-stage release gates over the real stack (PGlite, or PostgreSQL with HYPERTEST_TEST_DB=postgres), F[1] the
 * verified drive of a migrated run, and item 17 (a model-paused run migrates):
 *
 * - shadow: a SHADOW runtime mirrors finished production runs (new runs labelled `hypertest.shadow_of`, admitted only by a
 *   shadow release), dry-runs every external effect through the SideEffectGateway (recorded `not_applied: dry_run`,
 *   never dispatched), compares the decisions and records the comparisons; the production replay passes only without a
 *   divergence, and only it opens shadow → canary;
 * - the eval results that open the gates are bound to the manifest they certify (trials under another manifest refused);
 *   canary → active needs the CORE release gate;
 * - migrate(drive): `driven` is true only when this runtime's loop really took the run over (`run.migration_driven`);
 *   a durable runtime whose start is a no-op (the Temporal case of a previous workflow still open) is reported, not hidden.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger, SequentialIdGenerator, FixedClock, isHypertestError } from '@hypertest/core';
import { createTestDatabase, openDatabase } from '@hypertest/store';
import { AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, operationMigrations, type SideEffectAdapter } from '@hypertest/operation';
import type { ScriptedBrain } from '@hypertest/model';
import { infraEnv, skipUnless, tempDir } from '@hypertest/testkit';
import { createHypertest, shadowDryRunAdapters, shadowDivergences, shadowRunId, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { call, evidenceIds, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type RoleBrain } from './helpers.ts';

const GOAL = 'Is the sum module releasable?';
const ALICE = 'human:alice';
const DIGEST = 'd'.repeat(64);

function config(dataDir: string, store: HypertestConfig['store'] | undefined, extra: Record<string, unknown> = {}): HypertestConfig {
  const c = scriptedConfig(dataDir, { gate: { requireIndependentReview: false }, ...extra });
  return store ? { ...c, store } : c;
}

/** Another runtime of the same installation (one more policy rule ⇒ another manifest). */
function upgraded(c: HypertestConfig, tag = 'site.allow-reads'): HypertestConfig {
  return { ...c, policy: { rules: [{ id: tag, description: 'site rule', match: { effects: ['read'] }, decision: 'allow' }] } };
}

async function open(cfg: HypertestConfig, brains: Record<string, RoleBrain> | ScriptedBrain): Promise<HypertestInstance> {
  return createHypertest(cfg, { scriptedBrains: { sim: typeof brains === 'function' ? brains : roleRouter(brains) }, logger: new MemoryLogger(), env: { ...process.env } as Record<string, string> });
}

async function compatGate(ht: HypertestInstance, manifestId: string): Promise<void> {
  await ht.releases.recordSuite({ manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', passed: true, summary: { total: 21, failed: 0 }, reportDigest: DIGEST, binding: { kind: 'attested' }, by: 'ci:github' });
  await ht.releases.recordEvalSuite({ manifestId, kind: 'compatibility', digest: DIGEST, by: 'ci:github', result: { suiteId: 'poc-a-whitebox', revision: 'poc-1', trials: [{ taskId: 't', armId: 'a', trial: 0, result: 'pass', runtimeManifestId: manifestId }] } });
}

/** Activates the release of `ht` through every gate (the production runtime of these tests). */
async function activateHere(ht: HypertestInstance): Promise<string> {
  const id = ht.manifest.manifestId;
  await ht.releases.register({ by: ALICE });
  await compatGate(ht, id);
  await ht.releases.promote(id, { by: ALICE, reason: 'compatibility green' });
  const reg = ht.releases.registry;
  const c = await reg.recordShadowComparison({ manifestId: id, sourceRunId: 'run_bootstrap', sourceManifestId: 'rm_bootstrap', shadowRunId: `run_bootstrap.shadow-${id.slice(3, 10)}`, sourceVerdict: null, shadowVerdict: null, divergences: [], recordedBy: 'ci:shadow' });
  await reg.recordSuiteResult({ manifestId: id, kind: 'production_replay', suiteId: 'shadow-mirror', passed: true, summary: { total: 1, failed: 0 }, binding: { kind: 'shadow_comparisons', comparisonIds: [c.comparisonId] }, by: 'ci:shadow' });
  await ht.releases.promote(id, { by: ALICE, reason: 'replay green', canary: { percentage: 5 } });
  const core = { suiteId: 'core', revision: 'core-2', trials: [{ taskId: 'context-freshness', armId: 'deployment', trial: 0, result: 'pass', runtimeManifestId: id }] };
  await ht.releases.recordReleaseGate({ manifestId: id, candidate: core, candidateDigest: DIGEST, baselineDigest: 'e'.repeat(64), report: { pass: true, suiteId: 'core', checks: [] }, by: 'ci:github' });
  await ht.releases.promote(id, { by: ALICE, reason: 'release gate green' });
  return id;
}

/** NEW runtime's brains: the executor reports a defect the production runtime did not (a behavioural regression). */
function regressedBrains(): Record<string, RoleBrain> {
  const tiny = tinyRunBrains();
  return {
    ...tiny,
    executor: (v) => {
      if (v.step === 0) return call('test.run', { framework: 'node_test' });
      const ids = evidenceIds(v.toolResults[0]!.content);
      if (v.step === 1) {
        return call('blackboard.post_finding', {
          title: 'sum rounds negative inputs', description: 'the new runtime reports a defect', severity: 'P1', category: 'product_defect', evidenceRefs: ids,
        });
      }
      return call('complete_work', { summary: 'a defect was reported', evidenceRefs: ids, output: { summary: 'defect', executed: [{ selector: 'test/sum.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] } });
    },
  };
}

describe('F[0] shadow mirroring and the per-stage gates (real stack)', { concurrency: false }, () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-stages-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('a shadow mirrors finished production runs dry-run, compares decisions; only a divergence-free production replay opens canary', async () => {
    const base = config(dir.path, db.store);
    const target = { repoPath: repo.path, commit: repo.head };
    let prodId: string;
    let r1: string;
    let r2: string;
    // production (OLD): active through every gate; two finished runs
    {
      const ht = await open(base, tinyRunBrains());
      try {
        prodId = await activateHere(ht);
        const o1 = await ht.run({ goal: GOAL, target, labels: { team: 'payments' } }, { timeoutMs: 120_000 });
        const o2 = await ht.run({ goal: GOAL, target }, { timeoutMs: 120_000 });
        assert.deepEqual([o1.status, o1.decision?.verdict, o2.decision?.verdict], ['completed', 'pass', 'pass']);
        r1 = o1.runId;
        r2 = o2.runId;
        // the production runtime does not mirror (it is not a shadow)
        await assert.rejects(ht.releases.mirror(r1, { by: ALICE }), /only a shadow release mirrors production runs/);
      } finally {
        await ht.close();
      }
    }
    // the shadow (NEW, same behaviour): registered, compatibility gate, shadow
    const shadowCfg = { ...upgraded(base), runtime: { shadow: { labels: { team: 'payments' }, minRuns: 1 } } } as HypertestConfig;
    {
      const ht = await open(shadowCfg, tinyRunBrains());
      try {
        const id = ht.manifest.manifestId;
        assert.notEqual(id, prodId);
        await ht.releases.register({ by: ALICE });
        // the compatibility eval must have run under THIS manifest
        await assert.rejects(
          ht.releases.recordEvalSuite({ manifestId: id, kind: 'compatibility', digest: DIGEST, by: 'ci:github', result: { suiteId: 'core', trials: [{ taskId: 't', result: 'pass', runtimeManifestId: prodId }] } }),
          (e: unknown) => isHypertestError(e, 'precondition_failed') && /does not certify .*its trials ran under/.test((e as Error).message),
        );
        // (review) a CANCELLED (partial) result — interrupted between two trials, every trial that ran passed and is bound —
        // never certifies a release (before the check it was recorded as a passing compatibility result)
        const partial = { suiteId: 'core', revision: 'core-2', cancelled: true, trials: [{ taskId: 't', armId: 'deployment', trial: 0, result: 'pass', runtimeManifestId: id }] };
        await assert.rejects(
          ht.releases.recordEvalSuite({ manifestId: id, kind: 'compatibility', digest: DIGEST, by: 'ci:github', result: partial }),
          (e: unknown) => isHypertestError(e, 'precondition_failed') && /CANCELLED \(partial\) eval suite result: it never certifies a release/.test((e as Error).message),
        );
        await assert.rejects(
          ht.releases.recordReleaseGate({ manifestId: id, candidate: partial, candidateDigest: DIGEST, baselineDigest: 'e'.repeat(64), report: { pass: true, suiteId: 'core', checks: [] }, by: 'ci:github' }),
          (e: unknown) => isHypertestError(e, 'precondition_failed') && /the core eval candidate is a CANCELLED/.test((e as Error).message),
        );
        assert.deepEqual(await ht.releases.registry.suiteResults(id), [], 'nothing was recorded');
        await compatGate(ht, id);
        await ht.releases.promote(id, { by: ALICE, reason: 'compatibility green' });
        // a shadow creates no ordinary run
        await assert.rejects(ht.start({ goal: GOAL, target }), (e: unknown) => e instanceof HypertestError && /is a shadow release/.test(e.message));
        // shadow → canary is refused until a production replay was recorded
        await assert.rejects(ht.releases.promote(id, { by: ALICE, reason: 'r', canary: { percentage: 5 } }), /no production_replay suite result is recorded/);
        const failing = await ht.releases.recordProductionReplay({ by: 'ci:shadow' });
        assert.deepEqual([failing.passed, failing.summary.total], [false, 0], 'no mirrored run: no production replay pass');
        // runtime.shadow selects the labelled run only
        assert.deepEqual(await ht.releases.shadowCandidates(), [r1]);
        const m = await ht.releases.mirror(r1, { by: 'ci:shadow', timeoutMs: 120_000 });
        assert.equal(m.shadowRunId, shadowRunId(r1, id));
        assert.deepEqual([m.created, m.comparison.diverged, m.comparison.sourceVerdict, m.comparison.shadowVerdict, m.comparison.sourceManifestId], [true, false, 'pass', 'pass', prodId]);
        const shadowRun = (await ht.status(m.shadowRunId))!;
        assert.deepEqual([shadowRun.runtimeManifestId, shadowRun.labels['hypertest.shadow_of'], shadowRun.status], [id, r1, 'completed']);
        const again = await ht.releases.mirror(r1, { by: 'ci:shadow' });
        assert.deepEqual([again.created, again.comparison.comparisonId], [false, m.comparison.comparisonId], 'a run is mirrored once');
        assert.deepEqual(await ht.releases.shadowCandidates(), [], 'mirrored runs are not candidates again');
        await assert.rejects(ht.releases.mirror(m.shadowRunId, { by: 'ci:shadow' }), /is itself a shadow run/);
        const replay = await ht.releases.recordProductionReplay({ by: 'ci:shadow' });
        assert.deepEqual([replay.passed, replay.summary.total, replay.summary.failed, replay.binding?.kind], [true, 1, 0, 'shadow_comparisons']);
        const canary = await ht.releases.promote(id, { by: ALICE, reason: 'production replay green', canary: { percentage: 5 } });
        assert.deepEqual([canary.release.state, canary.transition.details['gate']], ['canary', ['engine_contract', 'compatibility', 'production_replay']]);
        // canary → active: only the CORE release gate bound to this manifest
        await assert.rejects(ht.releases.promote(id, { by: ALICE, reason: 'r' }), /no release_gate suite result is recorded/);
        await assert.rejects(
          ht.releases.recordReleaseGate({ manifestId: id, candidate: { suiteId: 'poc-all', trials: [{ result: 'pass', runtimeManifestId: id }] }, candidateDigest: DIGEST, baselineDigest: DIGEST, report: { pass: true, suiteId: 'poc-all' }, by: 'ci:github' }),
          /the release gate runs the core eval/,
        );
        await assert.rejects(
          ht.releases.recordReleaseGate({ manifestId: id, candidate: { suiteId: 'core', trials: [{ result: 'pass', runtimeManifestId: prodId }] }, candidateDigest: DIGEST, baselineDigest: DIGEST, report: { pass: true, suiteId: 'core' }, by: 'ci:github' }),
          /does not certify/,
        );
        // a release is never gated against itself: the candidate as its own baseline, or a baseline that ran under it
        await assert.rejects(
          ht.releases.recordReleaseGate({ manifestId: id, candidate: { suiteId: 'core', trials: [{ result: 'pass', runtimeManifestId: id }] }, candidateDigest: DIGEST, baselineDigest: DIGEST, report: { pass: true, suiteId: 'core' }, by: 'ci:github' }),
          (e: unknown) => isHypertestError(e, 'precondition_failed') && /compared the candidate with itself/.test((e as Error).message),
        );
        await assert.rejects(
          ht.releases.recordReleaseGate({
            manifestId: id, candidate: { suiteId: 'core', trials: [{ result: 'pass', runtimeManifestId: id }] }, baseline: { suiteId: 'core', trials: [{ result: 'pass', runtimeManifestId: id }] },
            candidateDigest: DIGEST, baselineDigest: 'e'.repeat(64), report: { pass: true, suiteId: 'core' }, by: 'ci:github',
          }),
          (e: unknown) => isHypertestError(e, 'precondition_failed') && /the baseline ran under .* itself/.test((e as Error).message),
        );
        const gateFail = await ht.releases.recordReleaseGate({ manifestId: id, candidate: { suiteId: 'core', trials: [{ result: 'pass', runtimeManifestId: id }] }, candidateDigest: DIGEST, baselineDigest: 'e'.repeat(64), report: { pass: false, suiteId: 'core', checks: [{ checkId: 'defect_recall', pass: false }] }, by: 'ci:github' });
        assert.equal(gateFail.passed, false);
        assert.match(gateFail.summary.detail ?? '', /gate checks failed: defect_recall/);
        await assert.rejects(ht.releases.promote(id, { by: ALICE, reason: 'r' }), /the latest release_gate suite result .* failed/);
      } finally {
        await ht.close();
      }
    }
    // a REGRESSED shadow runtime: its mirror of r2 diverges (verdict pass → fail); the production replay fails; canary refused
    {
      const ht = await open(upgraded(base, 'site.other-rule'), regressedBrains());
      try {
        const id = ht.manifest.manifestId;
        await ht.releases.register({ by: ALICE });
        await compatGate(ht, id);
        await ht.releases.promote(id, { by: ALICE, reason: 'compatibility green' });
        // (review) the reference decision is production's: a finished run of a runtime that is NOT the active release is
        // refused (before the check, its decision was taken as the production reference)
        const foreign = { ...(await ht.status(r2))!, runId: `${r2}_foreign`, runtimeManifestId: `rm_${'f'.repeat(64)}` };
        await ht.services.db.query('INSERT INTO ht_runs (run_id, status, goal, run, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [foreign.runId, foreign.status, foreign.goal, JSON.stringify(foreign), foreign.createdAt, foreign.updatedAt]);
        await assert.rejects(ht.releases.mirror(foreign.runId, { by: 'ci:shadow' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /not under the active release .*: a shadow is compared with the decisions of the active release/.test((e as Error).message));
        assert.deepEqual(await ht.releases.registry.shadowComparisons(id), [], 'nothing was mirrored or recorded');
        const m = await ht.releases.mirror(r2, { by: 'ci:shadow', timeoutMs: 120_000 });
        assert.equal(m.comparison.diverged, true);
        assert.deepEqual([m.comparison.sourceVerdict, m.comparison.shadowVerdict], ['pass', 'fail']);
        assert.ok(m.comparison.divergences.some((d) => /^verdict pass → fail$/.test(d)), m.comparison.divergences.join('; '));
        const replay = await ht.releases.recordProductionReplay({ by: 'ci:shadow' });
        assert.deepEqual([replay.passed, replay.summary.total, replay.summary.failed], [false, 1, 1]);
        await assert.rejects(ht.releases.promote(id, { by: ALICE, reason: 'r', canary: { percentage: 5 } }), /the latest production_replay suite result .* failed/);
      } finally {
        await ht.close();
      }
    }
  });
});

describe('F[0] dry-run effects of mirrored runs (the real SideEffectGateway)', () => {
  test('a shadow run is never dispatched (not_applied: dry_run, recorded); a production run is', async () => {
    const { db, dispose } = await createTestDatabase({ migrations: operationMigrations });
    try {
      const deps = { db, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger: new MemoryLogger() };
      const ledger = createOperationLedger(deps);
      const leases = createLeaseService(deps);
      const dispatched: string[] = [];
      const adapter: SideEffectAdapter = {
        adapterId: 'fake.write',
        capabilities: { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: true, reconciliationClass: 'deterministic', riskClass: 'medium' },
        prepare: async (op) => ({ desiredState: { ok: true }, desiredStateHash: 'h', target: op.operation.target }),
        dispatch: async (_p, op) => {
          dispatched.push(op.operation.runId);
          return { accepted: true, receipt: 'r' };
        },
        observe: async () => ({ state: 'present', observation: { ok: true } }),
        verify: async () => ({ status: 'verified', result: { written: true } }),
        compensate: async () => ({ compensated: true }),
      };
      const shadowRuns = new Set(['run_shadow']);
      const gateway = createSideEffectGateway({ ...deps, ledger, leases, adapters: shadowDryRunAdapters(new AdapterRegistry([adapter]), async (runId) => shadowRuns.has(runId)) });
      const req = (runId: string) => ({
        runId, workItemId: 'wi_1', toolInvocationId: `${runId}:1:c1`, operationType: 'fake.write', adapterId: 'fake.write', input: { key: 'k', value: 1 },
        target: { resourceKey: 'svc/k', kind: 'http_endpoint' }, ctx: { runId, correlationId: runId, actorId: 'agent:x' }, signal: AbortSignal.timeout(10_000), verifyWithinMs: 1000,
      });
      const shadow = await gateway.run(req('run_shadow'));
      assert.equal(shadow.status, 'not_applied');
      assert.match('reason' in shadow ? shadow.reason : '', /^dry_run: run run_shadow mirrors a production run on a shadow release/);
      assert.deepEqual(dispatched, [], 'nothing was dispatched for the shadow run');
      const recorded = await ledger.get(shadow.operation.operationId);
      assert.equal(recorded?.status, 'not_applied', 'the ledger keeps what WOULD have been done');
      // a retry of the same shadow call is not dispatched either
      const retry = await gateway.run(req('run_shadow'));
      assert.equal(retry.status, 'not_applied');
      assert.deepEqual(dispatched, []);
      const prod = await gateway.run(req('run_prod'));
      assert.equal(prod.status, 'verified');
      assert.deepEqual(dispatched, ['run_prod']);
    } finally {
      await dispose();
    }
  });

  test('shadowDivergences compares outcome, verdict, criteria and human review', () => {
    const run = (status: string) => ({ status }) as never;
    const decision = (verdict: string, violated: string[] = [], human = false) => ({ verdict, violatedCriteria: violated.map((criterionId) => ({ criterionId })), unknownCriteria: [], requiresHumanReview: human }) as never;
    assert.deepEqual(shadowDivergences({ run: run('completed'), decision: decision('fail', ['C2']) }, { run: run('completed'), decision: decision('fail', ['C2']) }), []);
    assert.deepEqual(shadowDivergences({ run: run('completed'), decision: decision('fail', ['C2']) }, { run: run('completed'), decision: decision('pass', [], true) }), [
      'verdict fail → pass', 'violated criteria [C2] → []', 'requiresHumanReview false → true',
    ]);
    assert.deepEqual(shadowDivergences({ run: run('completed'), decision: decision('pass') }, { run: run('failed') }), ['run status completed → failed', 'verdict pass → none']);
  });
});

describe('F[1] / item 17: a migration reports a drive only when it happened; a model-paused run migrates', { concurrency: false }, () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  // each test owns its store (on PostgreSQL a shared schema would carry the first test's active release into the second)
  let dbB: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-drive-');
    repo = await sumRepo();
    db = await testStore();
    dbB = await testStore();
  });
  after(async () => {
    await db.dispose();
    await dbB.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('a run waiting only on a model pause is migrated (its pause carried over), driven by the target and completes', async () => {
    const base = config(join(dir.path, 'a'), db.store);
    const target = { repoPath: repo.path, commit: repo.head };
    let runId: string;
    let itemId: string;
    // OLD: the provider is down for every call — the lead's item pauses on model:<agent>
    {
      const down: ScriptedBrain = () => ({ error: 'timeout', message: 'provider down' });
      const ht = await open(base, down);
      try {
        const run = await ht.start({ goal: GOAL, target });
        runId = run.runId;
        const until = Date.now() + 60_000;
        for (;;) {
          const waiting = await ht.services.blackboard.listWorkItems({ runId, states: ['waiting'] });
          const paused = waiting.find((w) => w.waitingOn.some((x) => x.startsWith('model:')));
          if (paused) {
            itemId = paused.workItemId;
            break;
          }
          if (Date.now() > until) throw new Error('the lead never paused on the model');
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await ht.close();
      }
    }
    // NEW (active) migrates the run: previously refused ("waiting on operations or children"), now carried over
    {
      const ht = await open(upgraded(base), tinyRunBrains());
      try {
        await activateHere(ht);
        const m = await ht.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'move off the old runtime', drive: true, checkpointTimeoutMs: 10_000 });
        assert.deepEqual(m.epoch.carriedModelPauses, [itemId]);
        assert.equal(m.driven, true, m.driveProblem);
        const migrated = (await ht.events(runId, { types: ['run.migrated'] })).at(-1)!.payload as { carriedModelPauses?: string[] };
        assert.deepEqual(migrated.carriedModelPauses, [itemId]);
        const drivenEv = await ht.events(runId, { types: ['run.migration_driven'] });
        assert.deepEqual(drivenEv.map((e) => (e.payload as { epochId: string }).epochId), [m.epoch.epochId], 'the target loop recorded its drive once');
        // the carried pause is released by an operator resume on the new runtime; the run completes there
        await ht.resume(runId);
        const outcome = await ht.durable.awaitCompletion(runId, { timeoutMs: 120_000 });
        assert.deepEqual([outcome.status, outcome.decision?.verdict, outcome.decision?.runtimeManifestId], ['completed', 'pass', ht.manifest.manifestId]);
        const report = await ht.report(runId);
        assert.match(report.markdown, /the target runtime .* drives the migrated run \(epoch 1/);
      } finally {
        await ht.close();
      }
    }
  });

  test('a durable start that does not take effect (a previous loop still open) is reported: driven false with the remedy', async () => {
    const base = config(join(dir.path, 'b'), dbB.store);
    const target = { repoPath: repo.path, commit: repo.head };
    let runId: string;
    {
      // the provider is down: the lead's item waits on its model pause (no claim held); then the process stops
      const ht = await open(base, () => ({ error: 'timeout', message: 'provider down' }));
      try {
        runId = (await ht.start({ goal: GOAL, target })).runId;
        const until = Date.now() + 60_000;
        while (!(await ht.services.blackboard.listWorkItems({ runId, states: ['waiting'] })).some((w) => w.waitingOn.some((x) => x.startsWith('model:')))) {
          if (Date.now() > until) throw new Error('the lead never paused on the model');
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await ht.close();
      }
    }
    {
      const ht = await open(upgraded(base, 'site.third'), tinyRunBrains());
      try {
        await activateHere(ht);
        // the Temporal case without a cluster: the previous workflow of the run is still open, so startRun is a no-op
        const durable = ht.durable as unknown as { startRun: (id: string) => Promise<void>; signal: (id: string, s: unknown) => Promise<void> };
        const signals: string[] = [];
        durable.startRun = async () => undefined;
        durable.signal = async (_id, s) => void signals.push((s as { type: string }).type);
        // item 17's limit: only a wait on a model pause migrates — an item ALSO waiting on a child (or an operation) keeps
        // refusing the migration, and the run is left as it was
        const waiting = (await ht.services.blackboard.listWorkItems({ runId, states: ['waiting'] }))[0]!;
        const setWait = (w: string[]) => ht.services.db.query("UPDATE ht_work_items SET item = jsonb_set(item, '{waitingOn}', $2::jsonb) WHERE work_item_id = $1", [waiting.workItemId, JSON.stringify(w)]);
        const before = (await ht.status(runId))!;
        await setWait([...waiting.waitingOn, 'child:wi_other']);
        await assert.rejects(ht.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'consolidate', checkpointTimeoutMs: 10_000 }), (e: unknown) => {
          assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
          assert.match((e as Error).message, new RegExp(`waiting on operations or children \\(${waiting.workItemId} on model:\\S+\\+child:wi_other\\)`));
          return true;
        });
        const after = (await ht.status(runId))!;
        assert.deepEqual([after.status, after.pauseReason, after.runtimeManifestId], [before.status, before.pauseReason, before.runtimeManifestId]);
        assert.deepEqual(await ht.releases.epochs(runId), []);
        await setWait(waiting.waitingOn);
        const m = await ht.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'consolidate', drive: true, driveTimeoutMs: 3000, checkpointTimeoutMs: 10_000 });
        assert.equal(m.driven, false, 'no loop took the run over: never reported as driven');
        assert.match(m.driveProblem ?? '', /did not take it over within 3000 ms: its previous loop is probably still open \(Temporal: workflow run-.* on the task queue of rm_/);
        assert.ok(signals.includes('wake'), 'the previous loop was woken so its next tick can end it');
        assert.deepEqual(await ht.events(runId, { types: ['run.migration_driven'] }), []);
        assert.equal((await ht.status(runId))!.runtimeManifestId, ht.manifest.manifestId, 'the migration itself stands');
        // the take-over later (drive) is just as honest, and `resume` never hides it behind a no-op start
        const later = await ht.releases.drive(runId, { timeoutMs: 1500 });
        assert.deepEqual([later.needed, later.driven], [true, false]);
        assert.match(later.problem ?? '', /did not take it over within 1500 ms/);
        const drive = ht.releases.drive;
        ht.releases.drive = (id, input) => drive(id, { ...input, timeoutMs: 1500 });
        await assert.rejects(ht.resume(runId), (e: unknown) => isHypertestError(e, 'unavailable') && /did not take it over within 1500 ms/.test((e as Error).message));
        // resumeIncomplete (hypertest resume without a run id, serve) never reports a run it did not take over as resumed
        ht.releases.drive = (id, input) => drive(id, { ...input, timeoutMs: 1500 });
        assert.deepEqual(await ht.resumeIncomplete(), [], 'a migrated run whose take-over did not happen is not "resumed"');
        ht.releases.drive = drive;
        assert.deepEqual(await ht.events(runId, { types: ['run.migration_driven'] }), []);
      } finally {
        await ht.close();
      }
    }
  });
});

describe('F[1] migration drive on Temporal (live cluster)', { concurrency: false }, () => {
  const infra = infraEnv();
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const c of cleanups.reverse()) await c().catch(() => undefined);
  });

  async function temporalBase(tag: string): Promise<HypertestConfig> {
    const d = await tempDir(`ht-app-drive-temporal-${tag}-`);
    cleanups.push(d.cleanup);
    const suffix = randomBytes(4).toString('hex');
    const schema = `ht_drive_${suffix}`;
    cleanups.push(async () => {
      const pg = await openDatabase({ kind: 'postgres', url: infra.pgUrl! });
      try {
        await pg.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pg.close();
      }
    });
    return {
      ...config(join(d.path, 'data'), { kind: 'postgres', url: infra.pgUrl!, schema }),
      durable: { kind: 'temporal', address: infra.temporalAddress!, namespace: 'default', taskQueue: `ht-drive-${suffix}` },
    } as HypertestConfig;
  }

  async function modelPausedRun(ht: HypertestInstance, target: { repoPath: string; commit: string }): Promise<string> {
    const runId = (await ht.start({ goal: GOAL, target })).runId;
    const until = Date.now() + 90_000;
    while (!(await ht.services.blackboard.listWorkItems({ runId, states: ['waiting'] })).some((w) => w.waitingOn.some((x) => x.startsWith('model:')))) {
      if (Date.now() > until) throw new Error('the lead never paused on the model');
      await new Promise((r) => setTimeout(r, 200));
    }
    return runId;
  }

  test(
    'the source runtime still runs a worker: its open workflow is woken, ends at the pin refusal, and the target takes the run over (driven) to completion',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const repo = await sumRepo();
      cleanups.push(repo.cleanup);
      const base = await temporalBase('alive');
      const old = await open(base, () => ({ error: 'timeout', message: 'provider down' }));
      cleanups.push(() => old.close());
      const runId = await modelPausedRun(old, { repoPath: repo.path, commit: repo.head });
      // NEW on its own task queue; OLD keeps its embedded worker (its workflow of the run stays open and idle)
      const neu = await open(upgraded(base), tinyRunBrains());
      try {
        await activateHere(neu);
        const m = await neu.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'temporal handover', drive: true, driveTimeoutMs: 60_000, checkpointTimeoutMs: 30_000 });
        assert.equal(m.driven, true, m.driveProblem);
        await neu.resume(runId);
        const outcome = await neu.durable.awaitCompletion(runId, { timeoutMs: 120_000 });
        assert.deepEqual([outcome.status, outcome.decision?.runtimeManifestId], ['completed', neu.manifest.manifestId]);
      } finally {
        await neu.close();
      }
    },
  );

  test(
    'a migration without drive, then `resume` on the target (source runtime gone): resume takes the run over through the handover, never a silent no-op',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const repo = await sumRepo();
      cleanups.push(repo.cleanup);
      const base = await temporalBase('resume');
      let runId: string;
      {
        const old = await open(base, () => ({ error: 'timeout', message: 'provider down' }));
        try {
          runId = await modelPausedRun(old, { repoPath: repo.path, commit: repo.head });
        } finally {
          await old.close(); // the run workflow stays open on the old queue, nobody polls it
        }
      }
      const neu = await open(upgraded(base), tinyRunBrains());
      try {
        await activateHere(neu);
        // `hypertest runtime migrate` (no drive): re-pinned, not driven yet
        const m = await neu.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'temporal handover via resume', checkpointTimeoutMs: 30_000 });
        assert.equal(m.driven, false);
        assert.deepEqual(await neu.events(runId, { types: ['run.migration_driven'] }), []);
        // the audit's silent no-op: startRun of the open workflow did nothing. `resume` now takes the run over for real
        await neu.resume(runId);
        assert.equal((await neu.events(runId, { types: ['run.migration_driven'] })).length, 1, 'the target loop drives the migrated run');
        const outcome = await neu.durable.awaitCompletion(runId, { timeoutMs: 120_000 });
        assert.deepEqual([outcome.status, outcome.decision?.runtimeManifestId], ['completed', neu.manifest.manifestId]);
      } finally {
        await neu.close();
        const cli = fileURLToPath(new URL('../../../.infra/bin/temporal', import.meta.url));
        if (existsSync(cli)) {
          await new Promise<void>((resolve) => execFile(cli, ['workflow', 'terminate', '--workflow-id', `run-${runId}`, '--address', infra.temporalAddress!, '--namespace', 'default', '--reason', 'test cleanup'], () => resolve()));
        }
      }
    },
  );

  test(
    'a migration without drive, then `resumeIncomplete` (hypertest resume / serve) on the target with the source gone: the run is taken over, never a silent no-op start',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const repo = await sumRepo();
      cleanups.push(repo.cleanup);
      const base = await temporalBase('incomplete');
      let runId: string;
      {
        const old = await open(base, () => ({ error: 'timeout', message: 'provider down' }));
        try {
          runId = await modelPausedRun(old, { repoPath: repo.path, commit: repo.head });
        } finally {
          await old.close(); // the run workflow stays open on the old queue, nobody polls it
        }
      }
      const neu = await open(upgraded(base), tinyRunBrains());
      try {
        await activateHere(neu);
        const m = await neu.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'temporal handover via resumeIncomplete', checkpointTimeoutMs: 30_000 });
        assert.equal(m.driven, false);
        // the audit's reproduction: resumeIncomplete listed the run as resumed while startRun of the open workflow did
        // nothing (0 run.migration_driven, the run never progressed). Now the run is taken over before it is reported.
        const resumed = await neu.resumeIncomplete();
        assert.deepEqual(resumed, [runId]);
        assert.equal((await neu.events(runId, { types: ['run.migration_driven'] })).length, 1, 'the target loop drives the migrated run');
        // the carried model pause is released by the operator resume; the run completes on the target
        await neu.resume(runId);
        const outcome = await neu.durable.awaitCompletion(runId, { timeoutMs: 120_000 });
        assert.deepEqual([outcome.status, outcome.decision?.runtimeManifestId], ['completed', neu.manifest.manifestId]);
      } finally {
        await neu.close();
        const cli = fileURLToPath(new URL('../../../.infra/bin/temporal', import.meta.url));
        if (existsSync(cli)) {
          await new Promise<void>((resolve) => execFile(cli, ['workflow', 'terminate', '--workflow-id', `run-${runId}`, '--address', infra.temporalAddress!, '--namespace', 'default', '--reason', 'test cleanup'], () => resolve()));
        }
      }
    },
  );

  test(
    'the source runtime is gone (no worker polls its queue): the target hands the open workflow over and drives the run to completion',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const repo = await sumRepo();
      cleanups.push(repo.cleanup);
      const base = await temporalBase('gone');
      let runId: string;
      {
        const old = await open(base, () => ({ error: 'timeout', message: 'provider down' }));
        try {
          runId = await modelPausedRun(old, { repoPath: repo.path, commit: repo.head });
        } finally {
          await old.close(); // its worker stops: the run workflow stays open on the old queue (the audit's scenario)
        }
      }
      const neu = await open(upgraded(base), tinyRunBrains());
      try {
        await activateHere(neu);
        // the audit saw driven=true here while the run was never driven: now it is driven for real, or reported
        const m = await neu.releases.migrate(runId, { to: 'current', by: ALICE, reason: 'temporal handover', drive: true, driveTimeoutMs: 60_000, checkpointTimeoutMs: 30_000 });
        assert.equal(m.driven, true, m.driveProblem);
        assert.equal((await neu.events(runId, { types: ['run.migration_driven'] })).length, 1);
        assert.deepEqual(await neu.releases.drive(runId), { needed: false, driven: true }, 'a driven epoch is not taken over twice');
        await neu.resume(runId);
        const outcome = await neu.durable.awaitCompletion(runId, { timeoutMs: 120_000 });
        assert.deepEqual([outcome.status, outcome.decision?.runtimeManifestId], ['completed', neu.manifest.manifestId]);
      } finally {
        await neu.close();
        // nothing may stay open on the old queue (a failed handover would leave the workflow; terminate it then)
        const cli = fileURLToPath(new URL('../../../.infra/bin/temporal', import.meta.url));
        if (existsSync(cli)) {
          await new Promise<void>((resolve) => execFile(cli, ['workflow', 'terminate', '--workflow-id', `run-${runId}`, '--address', infra.temporalAddress!, '--namespace', 'default', '--reason', 'test cleanup'], () => resolve()));
        }
      }
    },
  );
});
