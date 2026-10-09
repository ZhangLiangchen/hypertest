/**
 * Runtime release management over the real stack (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres): admission of
 * new runs (active release / selected canary only), promotion gated by recorded compatibility suites, rollback that moves
 * the active pointer back, leaves old runs on their pinned manifest and quarantines the rolled-back release's runs, and
 * the explicit migration of a live run onto another release (checkpoint → snapshot → reconciliation → compatibility →
 * RuntimeEpoch + re-pin → resume), including its refusals.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger, isHypertestError } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import { buildRuntimeManifest } from '@hypertest/runtime';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type RoleBrain } from './helpers.ts';

const GOAL = 'Is the sum module releasable?';
const ALICE = 'human:alice';

function config(dataDir: string, store: HypertestConfig['store'] | undefined, extra: Record<string, unknown> = {}): HypertestConfig {
  const c = scriptedConfig(dataDir, { gate: { requireIndependentReview: false }, ...extra });
  return store ? { ...c, store } : c;
}

/** Another runtime of the same installation: one more policy rule ⇒ another policy bundle ⇒ another manifest. */
function upgraded(c: HypertestConfig): HypertestConfig {
  return { ...c, policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read'] }, decision: 'allow' }] } };
}

async function open(cfg: HypertestConfig, brains: Record<string, RoleBrain>, env: Record<string, string> = {}): Promise<HypertestInstance> {
  return createHypertest(cfg, { scriptedBrains: { sim: roleRouter(brains) }, logger: new MemoryLogger(), env: { ...process.env, ...env } });
}

const DIGEST = 'c'.repeat(64);

/** The gate of candidate → shadow (as CI records it): the engine contract suite (attested) + a compatibility eval bound to the manifest. */
async function greenSuites(ht: HypertestInstance, manifestId: string): Promise<void> {
  await ht.releases.recordSuite({ manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', suiteRevision: '1', passed: true, summary: { total: 21, failed: 0 }, reportDigest: DIGEST, binding: { kind: 'attested' }, by: 'ci:github' });
  await ht.releases.recordSuite({ manifestId, kind: 'compatibility', suiteId: 'poc-a-whitebox', suiteRevision: 'poc-1', passed: true, summary: { total: 3, failed: 0 }, binding: { kind: 'eval_trials', manifestIds: [manifestId] }, by: 'ci:github' });
}

/**
 * (F[0]) Promotion through the stage gates: records the NEXT stage's gate the way the release pipeline does (shadow →
 * canary: one equivalent mirrored run as a production replay; canary → active: the core release gate), then promotes.
 */
async function gatedPromote(ht: HypertestInstance, manifestId: string, input: Parameters<HypertestInstance['releases']['promote']>[1]) {
  const reg = ht.releases.registry;
  const release = await reg.get(manifestId);
  if (release?.state === 'shadow') {
    const c = await reg.recordShadowComparison({ manifestId, sourceRunId: `run_prod_${manifestId.slice(3, 11)}`, sourceManifestId: 'rm_production', shadowRunId: `run_mirror_${manifestId.slice(3, 11)}_${Date.now()}`, sourceVerdict: 'fail', shadowVerdict: 'fail', divergences: [], recordedBy: 'ci:shadow' });
    await reg.recordSuiteResult({ manifestId, kind: 'production_replay', suiteId: 'shadow-mirror', passed: true, summary: { total: 1, failed: 0 }, binding: { kind: 'shadow_comparisons', comparisonIds: [c.comparisonId] }, by: 'ci:shadow' });
  } else if (release?.state === 'canary') {
    await reg.recordSuiteResult({ manifestId, kind: 'release_gate', suiteId: 'core', suiteRevision: 'core-2', passed: true, summary: { total: 7, failed: 0 }, reportDigest: DIGEST, binding: { kind: 'eval_gate', manifestIds: [manifestId], candidateDigest: DIGEST, baselineDigest: 'b'.repeat(64) }, by: 'ci:github' });
  }
  return ht.releases.promote(manifestId, input);
}

async function toCanary(ht: HypertestInstance, manifestId: string, canary: { percentage?: number; labels?: Record<string, string> }): Promise<void> {
  if (manifestId === ht.manifest.manifestId) await ht.releases.register({ by: ALICE });
  await greenSuites(ht, manifestId);
  await gatedPromote(ht, manifestId, { by: ALICE, reason: 'compatibility suite green' });
  await gatedPromote(ht, manifestId, { by: ALICE, reason: 'production replay green', canary });
}

/** Resolves when no work item of the run holds a live claim (every in-flight turn gave its claim back). */
async function quiescent(ht: HypertestInstance, runId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const held = (await ht.services.blackboard.listWorkItems({ runId, states: ['claimed', 'running'] })).length;
    if (held === 0) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} still holds ${held} claims`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const refusedStart = (pattern: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HypertestError && e.code === 'precondition_failed', String(e));
  assert.match(e.message, pattern);
  return true;
};

describe('runtime releases e2e: admission, promotion, rollback + quarantine, migration', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-releases-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('canary admission, rollback of the active release (pointer back, old runs untouched, candidate runs quarantined), migration of a quarantined run', async () => {
    const cfgOld = config(dir.path, db.store);
    const target = { repoPath: repo.path, commit: repo.head };

    // 1 OLD: unmanaged until activated; register → suites → shadow → canary → active; start R0 (its lead never answers)
    let entered0!: () => void;
    const inLead0 = new Promise<void>((resolve) => (entered0 = resolve));
    let oldId: string;
    let r0: string;
    {
      const ht = await open(cfgOld, { lead: () => (entered0(), new Promise(() => undefined)) });
      try {
        oldId = ht.manifest.manifestId;
        await toCanary(ht, oldId, { percentage: 10 });
        const active = await gatedPromote(ht, oldId, { by: ALICE, reason: 'release gate green' });
        assert.deepEqual([active.release.state, active.pointer?.manifestId], ['active', oldId]);
        r0 = (await ht.start({ goal: GOAL, target })).runId;
        await inLead0;
      } finally {
        await ht.close();
      }
    }

    // 2 NEW: refused until registered and selected; canary by label; then active (OLD retiring, R0 still live on it)
    let entered1!: () => void;
    const inExecutor1 = new Promise<void>((resolve) => (entered1 = resolve));
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => (release1 = resolve));
    const tiny = tinyRunBrains();
    const newBrains: Record<string, RoleBrain> = {
      ...tiny,
      executor: async (v) => {
        if (v.step === 0) {
          entered1();
          await gate1;
        }
        return tiny.executor!(v);
      },
    };
    let newId: string;
    let r1: string;
    {
      const ht = await open(upgraded(cfgOld), newBrains);
      try {
        newId = ht.manifest.manifestId;
        assert.notEqual(newId, oldId);
        await assert.rejects(ht.start({ goal: GOAL, target }), refusedStart(new RegExp(`^runtime release: runtime ${newId.slice(0, 19)}… is not a registered release: new runs are created only under the active release ${oldId.slice(0, 19)}`)));
        await ht.releases.register({ by: ALICE });
        await assert.rejects(ht.start({ goal: GOAL, target }), refusedStart(/is a candidate release/));
        assert.deepEqual((await ht.listRuns()).map((r) => r.runId), [r0], 'refused starts created no run');
        await toCanary(ht, newId, { labels: { canary: 'yes' } });
        await assert.rejects(ht.start({ goal: GOAL, target, labels: { canary: 'no' } }), refusedStart(/is the canary and its selection \(labels canary=yes\) does not pick run/));
        const run1 = await ht.start({ goal: GOAL, target, labels: { canary: 'yes' } });
        r1 = run1.runId;
        assert.equal(run1.runtimeManifestId, newId, 'a canary-selected run is created under the canary');
        await inExecutor1;

        // promotion to active: OLD retires but keeps R0 (a live run pinned to it) — it is not retired while R0 lives
        const promoted = await gatedPromote(ht, newId, { by: ALICE, reason: 'canary healthy' });
        assert.deepEqual([promoted.release.state, promoted.retiring?.manifestId, promoted.retired], ['active', oldId, []]);
        const listed = await ht.releases.list();
        const oldView = listed.find((r) => r.manifestId === oldId)!;
        assert.deepEqual([oldView.state, oldView.liveRuns, oldView.active], ['retiring', 1, false]);
        assert.deepEqual(await ht.releases.registry.admit({ manifestId: oldId, runId: 'run_probe' }).then((a) => a.allowed), false, 'a retiring release creates no new runs');

        // rollback of the active release: pointer back to OLD, NEW retired for good, its live runs quarantined
        const rb = await ht.releases.rollback({ by: ALICE, reason: 'critical false release in canary replay' });
        assert.deepEqual([rb.rolledBack.manifestId, rb.fromState, rb.restored?.manifestId, rb.quarantined], [newId, 'active', oldId, [r1]]);
        assert.equal((await ht.releases.registry.activePointer())?.manifestId, oldId);
        const q = (await ht.status(r1))!;
        assert.deepEqual([q.status, q.pauseReason, q.runtimeManifestId], ['paused', 'quarantined', newId]);
        const r0Now = (await ht.status(r0))!;
        assert.deepEqual([r0Now.status, r0Now.pauseReason, r0Now.runtimeManifestId], ['running', undefined, oldId], 'old runs are untouched on their pinned manifest');
        assert.deepEqual((await ht.events(r0, { types: ['run.quarantined'] })).length, 0);
        const qe = (await ht.events(r1, { types: ['run.quarantined'] }))[0]!;
        assert.deepEqual(qe.payload, { runId: r1, manifestId: newId, transitionId: rb.transition.transitionId, previousStatus: 'running', by: ALICE, reason: 'critical false release in canary replay', restoredManifestId: oldId });
        // the rolled-back runtime creates nothing more; a quarantined run cannot simply be resumed
        await assert.rejects(ht.start({ goal: GOAL, target, labels: { canary: 'yes' } }), refusedStart(/retired \(rolled back\) release/));
        await assert.rejects(ht.control.resumeRun(r1), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is quarantined/.test((e as Error).message));
        // the report says so
        const report = await ht.report(r1);
        assert.match(report.markdown, /## Runtime release\n\*\*This run is QUARANTINED\*\*/);
        assert.ok(report.recovery.some((r) => r.detail.startsWith(`QUARANTINED: runtime release ${newId} was rolled back by ${ALICE}`)));
        assert.equal((report.json as { runtimeRelease?: { quarantined: boolean } }).runtimeRelease?.quarantined, true);

        // the in-flight executor turn finishes and gives its claim back (a pause never costs an attempt)
        release1();
        await quiescent(ht, r1);
        assert.equal((await ht.status(r1))!.status, 'paused');
      } finally {
        release1();
        await ht.close();
      }
    }

    // 3 OLD again (the restored active release): R0 resumes on its pinned manifest; R1 is migrated explicitly and completes
    {
      const ht = await open(cfgOld, tinyRunBrains());
      try {
        assert.equal(ht.manifest.manifestId, oldId);
        assert.deepEqual(await ht.resumeIncomplete(), [r0], 'the quarantined run is not resumed by anyone');
        const views = await ht.releases.list();
        assert.deepEqual(views.map((v) => [v.manifestId, v.state, v.rolledBack, v.current]).sort(), [[newId, 'retired', true, false], [oldId, 'active', false, true]].sort());

        const migrated = await ht.releases.migrate(r1, { to: 'current', by: ALICE, reason: 'move off the rolled-back runtime', drive: true });
        assert.equal(migrated.driven, true);
        assert.deepEqual([migrated.run.status, migrated.run.runtimeManifestId, migrated.run.pauseReason], ['running', oldId, undefined]);
        const epoch = migrated.epoch;
        assert.deepEqual([epoch.seq, epoch.fromManifestId, epoch.toManifestId, epoch.statusBefore, epoch.statusAfter, epoch.migratedBy], [1, newId, oldId, 'paused', 'running', ALICE]);
        assert.match(epoch.snapshotId, /^cs_/);
        assert.ok(epoch.compatibility.length > 0 && epoch.compatibility.every((c) => c.ok), JSON.stringify(epoch.compatibility));
        assert.ok(epoch.compatibility.some((c) => c.check === 'engine.native'), 'the engines the run used are checked');
        assert.deepEqual(await ht.releases.epochs(r1), [epoch]);

        const [o0, o1] = await Promise.all([ht.durable.awaitCompletion(r0, { timeoutMs: 120_000 }), ht.durable.awaitCompletion(r1, { timeoutMs: 120_000 })]);
        assert.deepEqual([o0.status, o0.decision?.verdict, o0.decision?.runtimeManifestId], ['completed', 'pass', oldId]);
        assert.deepEqual([o1.status, o1.decision?.verdict, o1.decision?.runtimeManifestId], ['completed', 'pass', oldId], 'the migrated run completes on its new runtime');
        const types = (await ht.events(r1)).map((e) => e.eventType);
        const iq = types.indexOf('run.quarantined');
        const im = types.indexOf('run.migrated');
        assert.ok(iq > 0 && im > iq && types.indexOf('run.resumed', im) > im, types.join(','));
        const report = await ht.report(r1);
        assert.match(report.markdown, new RegExp(`runtime migration \\(epoch 1, ${epoch.epochId}\\) by ${ALICE}: ${newId} → ${oldId}`));
        assert.doesNotMatch(report.markdown, /This run is QUARANTINED/, 'no longer quarantined');
        // the manifest the run is pinned to now is stored like any pinned manifest
        const stored = await ht.services.db.query('SELECT manifest_id FROM ht_manifests WHERE manifest_id = $1', [oldId]);
        assert.equal(stored.rows.length, 1);
      } finally {
        await ht.close();
      }
    }
  });
});

describe('runtime migration refusals and governance pauses', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance;
  let entered!: () => void;
  const inLead = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  before(async () => {
    dir = await tempDir('ht-app-migrate-');
    repo = await sumRepo();
    db = await testStore();
    const tiny = tinyRunBrains();
    ht = await open(config(dir.path, db.store), {
      ...tiny,
      lead: async (v) => {
        if (v.kind === 'initial_plan' && v.step === 0) {
          entered();
          await gate;
        }
        return tiny.lead!(v);
      },
      executor: () => new Promise(() => undefined),
    });
  });
  after(async () => {
    release();
    await ht.close();
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  /** A synthetic other runtime (another policy bundle) registered and promoted to canary: a migration target nobody drives. */
  function otherManifest(tag: string): RuntimeManifest {
    const { manifestId: _i, createdAt: _c, ...content } = JSON.parse(JSON.stringify(ht.manifest)) as RuntimeManifest;
    return buildRuntimeManifest({ ...content, policyBundleRevision: `${content.policyBundleRevision}+${tag}` }, '2026-01-01T00:00:00.000Z');
  }

  test('checkpoint timeout, unknown ids, a non-promoted target and unsettled operations are refused; the run is left as it was', async () => {
    const here = ht.manifest.manifestId;
    await ht.releases.register({ by: ALICE });
    await greenSuites(ht, here);
    for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, here, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
    const canary = otherManifest('canary');
    await ht.releases.register({ manifest: canary, by: ALICE });
    await greenSuites(ht, canary.manifestId);
    await gatedPromote(ht, canary.manifestId, { by: ALICE, reason: 'r' });
    await gatedPromote(ht, canary.manifestId, { by: ALICE, reason: 'r', canary: { labels: { canary: 'yes' } } });
    const candidate = otherManifest('candidate');
    await ht.releases.register({ manifest: candidate, by: ALICE });

    const run = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
    await inLead;
    // 1 the lead's turn holds its claim: the checkpoint is not reached in time; the checkpoint is released again
    await assert.rejects(ht.releases.migrate(run.runId, { to: canary.manifestId, by: ALICE, reason: 'r', checkpointTimeoutMs: 300 }), (e: unknown) => isHypertestError(e, 'timeout') && /did not reach a checkpoint/.test((e as Error).message));
    let now = (await ht.status(run.runId))!;
    assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['running', undefined, here]);
    // 2 unknown run / unknown target / a target that is only a candidate (refused before anything is touched)
    await assert.rejects(ht.releases.migrate('run_missing', { to: canary.manifestId, by: ALICE, reason: 'r' }), (e: unknown) => isHypertestError(e, 'not_found'));
    await assert.rejects(ht.releases.migrate(run.runId, { to: 'rm_ffffffffffff', by: ALICE, reason: 'r' }), (e: unknown) => isHypertestError(e, 'not_found'));
    await assert.rejects(ht.releases.migrate(run.runId, { to: candidate.manifestId, by: ALICE, reason: 'r' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /target_state: release .* is candidate/.test((e as Error).message));
    await assert.rejects(ht.releases.migrate(run.runId, { to: canary.manifestId, by: 'alice', reason: 'r' }), (e: unknown) => isHypertestError(e, 'invalid_argument'), 'the actor is <kind>:<id>');
    now = (await ht.status(run.runId))!;
    assert.deepEqual([now.status, now.pauseReason], ['running', undefined]);

    // 3 an operator pause: the turn finishes, its claim is given back
    await ht.control.pauseRun(run.runId, 'operator');
    release();
    await quiescent(ht, run.runId);
    // an unsettled operation of the run blocks the migration (it would be dispatched or reconciled by another runtime)
    const items = await ht.services.blackboard.listWorkItems({ runId: run.runId });
    const ctx = { runId: run.runId, correlationId: run.runId, actorId: 'system:test' };
    const op = await ht.services.operations.prepare(
      { runId: run.runId, workItemId: items[0]!.workItemId, operationType: 'env.restart', adapterId: 'record:http', target: { kind: 'environment', resourceKey: 'env/shop' }, desiredStateHash: 'h', inputHash: 'i' },
      ctx,
    );
    await assert.rejects(ht.releases.migrate(run.runId, { to: canary.manifestId, by: ALICE, reason: 'r' }), (e: unknown) => {
      assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
      assert.match((e as Error).message, new RegExp(`unsettled operations \\(${op.operationId} prepared\\)`));
      return true;
    });
    now = (await ht.status(run.runId))!;
    assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['paused', 'operator', here], 'a pause the migration did not take is kept');
    assert.deepEqual(await ht.releases.epochs(run.runId), []);
    assert.deepEqual(await ht.events(run.runId, { types: ['run.migrated'] }), []);

    // 4 settled: the migration re-pins; the operator's pause belongs to other governance and is kept
    await ht.services.operations.transition(op.operationId, 'not_applied', {}, ctx);
    const m = await ht.releases.migrate(run.runId, { to: canary.manifestId, by: ALICE, reason: 'try the canary' });
    assert.deepEqual([m.run.runtimeManifestId, m.run.status, m.run.pauseReason, m.driven, m.epoch.statusAfter], [canary.manifestId, 'paused', 'operator', false, 'paused']);
    assert.ok(m.epoch.compatibility.every((c) => c.ok));
    // this runtime no longer drives it (I11 after the re-pin; the pin cache was evicted)
    await assert.rejects(ht.control.tick(run.runId), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is pinned to runtime manifest rm_/.test((e as Error).message));
    // and back again: a second epoch continues the chain
    const back = await ht.releases.migrate(run.runId, { to: 'current', by: ALICE, reason: 'back' });
    assert.deepEqual([back.epoch.seq, back.epoch.previousEpochId, back.epoch.fromManifestId, back.run.runtimeManifestId], [2, m.epoch.epochId, canary.manifestId, here]);
    await ht.cancel(run.runId, 'test done');
    await assert.rejects(ht.releases.migrate(run.runId, { to: canary.manifestId, by: ALICE, reason: 'r' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /only a live run is migrated/.test((e as Error).message));
  });
});

describe('a rollback that commits between the admission and the creation of a run', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-release-race-');
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await dir.cleanup();
  });

  test('the run escapes the rollback sweep but its creator quarantines it and the start is refused; the re-check is idempotent', async () => {
    const ht = await open(config(dir.path, db.store), { lead: () => new Promise(() => undefined) });
    try {
      // OLD (a synthetic earlier runtime) active, then THIS runtime promoted over it: a rollback returns to OLD
      const { manifestId: _i, createdAt: _c, ...content } = JSON.parse(JSON.stringify(ht.manifest)) as RuntimeManifest;
      const old = buildRuntimeManifest({ ...content, policyBundleRevision: `${content.policyBundleRevision}+old` }, '2026-01-01T00:00:00.000Z');
      await ht.releases.register({ manifest: old, by: ALICE });
      await greenSuites(ht, old.manifestId);
      for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, old.manifestId, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
      const here = ht.manifest.manifestId;
      await toCanary(ht, here, { percentage: 100 });
      await gatedPromote(ht, here, { by: ALICE, reason: 'gate' });
      const before = await ht.start({ goal: GOAL, target: {} });
      assert.equal(before.runtimeManifestId, here);

      // the race: the registry admits the run, then the rollback commits (both of its sweeps run before the run exists)
      const registry = ht.releases.registry;
      const admit = registry.admit.bind(registry);
      let rollback: Awaited<ReturnType<HypertestInstance['releases']['rollback']>> | undefined;
      registry.admit = async (input) => {
        const admission = await admit(input);
        rollback ??= await ht.releases.rollback({ by: ALICE, reason: 'replay regression' });
        return admission;
      };
      let raced = '';
      try {
        await assert.rejects(ht.start({ goal: GOAL, target: {} }), (e: unknown) => {
          assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
          assert.match((e as Error).message, new RegExp(`^runtime release: runtime ${here} was rolled back while run (run_\\S+) was being created — the run is quarantined`));
          raced = String((e as HypertestError).details['runId']);
          assert.equal((e as HypertestError).details['quarantined'], true);
          return true;
        });
      } finally {
        registry.admit = admit;
      }
      assert.ok(rollback);
      assert.deepEqual([rollback.rolledBack.manifestId, rollback.restored?.manifestId, rollback.quarantined], [here, old.manifestId, [before.runId]], 'the sweeps saw only the earlier run');
      const run = (await ht.status(raced))!;
      assert.deepEqual([run.status, run.pauseReason, run.runtimeManifestId], ['paused', 'quarantined', here]);
      const [q] = await ht.events(raced, { types: ['run.quarantined'] });
      assert.deepEqual(q?.payload, {
        runId: raced, manifestId: here, transitionId: rollback.transition.transitionId, previousStatus: 'running', by: ALICE, reason: 'replay regression', restoredManifestId: old.manifestId,
      });
      assert.match((await ht.report(raced)).markdown, /\*\*This run is QUARANTINED\*\*/);
      // nothing else to do: already quarantined, unknown, or a run whose release was not rolled back
      assert.equal(await ht.releases.quarantineIfRolledBack(raced), false);
      assert.equal(await ht.releases.quarantineIfRolledBack('run_unknown'), false);
      assert.equal((await ht.events(raced, { types: ['run.quarantined'] })).length, 1);
      await assert.rejects(ht.releases.quarantineIfRolledBack(' '), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    } finally {
      await ht.close();
    }
  });

  test('concurrent quarantines of one run (a rollback sweep racing its creator\'s re-check) record exactly one quarantine', async () => {
    const own = await testStore();
    const ht = await open(config(join(dir.path, 'concurrent'), own.store), { lead: () => new Promise(() => undefined) }).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      const here = ht.manifest.manifestId;
      const run = await ht.start({ goal: GOAL, target: {} }); // unmanaged: created under this (unregistered) runtime
      await ht.releases.register({ by: ALICE });
      // the registry's rollback alone (no sweep): the run is still live on the rolled-back candidate
      const rb = await ht.releases.registry.rollback({ by: ALICE, reason: 'bad candidate', manifestId: here });
      assert.equal((await ht.status(run.runId))!.status, 'running');
      const results = await Promise.all(Array.from({ length: 4 }, () => ht.releases.quarantineIfRolledBack(run.runId)));
      assert.deepEqual(results.filter(Boolean).length, 1, JSON.stringify(results));
      const events = await ht.events(run.runId, { types: ['run.quarantined'] });
      assert.equal(events.length, 1, 'one quarantine, one event');
      assert.deepEqual(events[0]!.payload, { runId: run.runId, manifestId: here, transitionId: rb.transition.transitionId, previousStatus: 'running', by: ALICE, reason: 'bad candidate' });
      const now = (await ht.status(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason], ['paused', 'quarantined']);
      assert.equal((await ht.events(run.runId, { types: ['run.paused'] })).length, 1, 'paused once');
      await ht.cancel(run.runId, 'done');
    } finally {
      await ht.close();
      await own.dispose();
    }
  });

  test('quarantineIfRolledBack leaves runs of releases that were not rolled back alone', async () => {
    // a store of its own: this one has no release registered yet (unmanaged)
    const own = await testStore();
    const ht = await open(config(join(dir.path, 'plain'), own.store), { lead: () => new Promise(() => undefined) }).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      const run = await ht.start({ goal: GOAL, target: {} }); // unmanaged: no release registered
      assert.equal(await ht.releases.quarantineIfRolledBack(run.runId), false);
      await ht.releases.register({ by: ALICE });
      assert.equal(await ht.releases.quarantineIfRolledBack(run.runId), false, 'a candidate is not rolled back');
      assert.deepEqual([(await ht.status(run.runId))!.status, (await ht.events(run.runId, { types: ['run.quarantined'] })).length], ['running', 0]);
      await ht.cancel(run.runId, 'done');
    } finally {
      await ht.close();
      await own.dispose();
    }
  });
});

describe('runtime.requireActiveRelease, drained releases retire, image digest in the BOM', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-release-strict-');
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await dir.cleanup();
  });

  test('no run before a release is active; promotion over a drained release retires it', async () => {
    const cfg = config(dir.path, db.store, { runtime: { requireActiveRelease: true } });
    const digest = `sha256:${'ab'.repeat(32)}`;
    let first: string;
    {
      const ht = await open(cfg, {}, { HYPERTEST_IMAGE_DIGEST: digest });
      try {
        first = ht.manifest.manifestId;
        assert.equal(ht.manifest.hypertest.imageDigest, digest);
        await assert.rejects(ht.start({ goal: GOAL, target: {} }), refusedStart(/^runtime release: no runtime release is active \(runtime\.requireActiveRelease\)/));
        assert.deepEqual(await ht.listRuns(), []);
        await toCanary(ht, first, { percentage: 100 });
        await gatedPromote(ht, first, { by: ALICE, reason: 'gate' });
        const run = await ht.start({ goal: GOAL, target: {} });
        assert.equal(run.runtimeManifestId, first);
        await ht.cancel(run.runId, 'not needed');
      } finally {
        await ht.close();
      }
    }
    // the same installation built into another image is another runtime; promoting it retires the drained first one
    const ht = await open(cfg, {}, { HYPERTEST_IMAGE_DIGEST: `sha256:${'cd'.repeat(32)}` });
    try {
      assert.notEqual(ht.manifest.manifestId, first);
      await toCanary(ht, ht.manifest.manifestId, { percentage: 50 });
      const p = await gatedPromote(ht, ht.manifest.manifestId, { by: ALICE, reason: 'gate' });
      assert.deepEqual([p.retiring?.manifestId, p.retired], [first, [first]]);
      assert.equal((await ht.releases.registry.get(first))!.state, 'retired');
      assert.deepEqual((await ht.releases.registry.history(first)).map((t) => t.action).slice(-2), ['retire', 'retire']);
    } finally {
      await ht.close();
    }
  });

  test('a malformed HYPERTEST_IMAGE_DIGEST fails the composition before anything is created', async () => {
    const fresh = join(dir.path, 'fresh');
    await assert.rejects(open(config(fresh, undefined), {}, { HYPERTEST_IMAGE_DIGEST: 'latest' }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /HYPERTEST_IMAGE_DIGEST must be an OCI image digest/.test((e as Error).message));
    assert.equal(existsSync(fresh), false);
  });
});

/** A synthetic other runtime of `ht` (another policy bundle): a release nobody drives. */
function otherRuntime(ht: HypertestInstance, tag: string): RuntimeManifest {
  const { manifestId: _i, createdAt: _c, ...content } = JSON.parse(JSON.stringify(ht.manifest)) as RuntimeManifest;
  return buildRuntimeManifest({ ...content, policyBundleRevision: `${content.policyBundleRevision}+${tag}` }, '2026-01-01T00:00:00.000Z');
}

async function registerCanary(ht: HypertestInstance, m: RuntimeManifest): Promise<void> {
  await ht.releases.register({ manifest: m, by: ALICE });
  await greenSuites(ht, m.manifestId);
  await gatedPromote(ht, m.manifestId, { by: ALICE, reason: 'contract' });
  await gatedPromote(ht, m.manifestId, { by: ALICE, reason: 'replay', canary: { labels: { canary: 'yes' } } });
}

/** Per-run gates of the lead's first turn: the test decides when each run's planning turn may finish. */
function leadGates() {
  const gates = new Map<string, { inLead: Promise<void>; entered: () => void; gate: Promise<void>; release: () => void }>();
  const of = (runId: string) => {
    let g = gates.get(runId);
    if (!g) {
      let entered!: () => void;
      let release!: () => void;
      const inLead = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      g = { inLead, entered, gate, release };
      gates.set(runId, g);
    }
    return g;
  };
  const tiny = tinyRunBrains();
  const brains: Record<string, RoleBrain> = {
    ...tiny,
    lead: async (v) => {
      if (v.kind === 'initial_plan' && v.step === 0) {
        const g = of(v.runId);
        g.entered();
        await g.gate;
      }
      return tiny.lead!(v);
    },
    executor: () => new Promise(() => undefined),
  };
  return { of, brains, releaseAll: () => gates.forEach((g) => g.release()) };
}

describe('migration races and crash windows', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  before(async () => {
    dir = await tempDir('ht-app-release-windows-');
    repo = await sumRepo();
  });
  after(async () => {
    await repo.cleanup();
    await dir.cleanup();
  });

  test('a rollback of the target committing after the migration\'s compatibility check refuses the re-pin; one committing after the re-pin quarantines the migrated run', async () => {
    const own = await testStore();
    const gates = leadGates();
    const ht = await open(config(join(dir.path, 'target-race'), own.store), gates.brains).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      const here = ht.manifest.manifestId;
      await ht.releases.register({ by: ALICE });
      await greenSuites(ht, here);
      for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, here, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
      const canary = otherRuntime(ht, 'canary');
      await registerCanary(ht, canary);
      const run = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
      await gates.of(run.runId).inLead;
      await ht.control.pauseRun(run.runId, 'operator');
      gates.of(run.runId).release();
      await quiescent(ht, run.runId);

      // the race: the canary is rolled back right after the migration's last check before its transaction read it
      // (reconciliation lists the run's operations just before that check)
      const registry = ht.releases.registry;
      const get = registry.get.bind(registry);
      const ledger = ht.services.operations;
      const list = ledger.list.bind(ledger);
      let armed = false;
      let rolledBack: Awaited<ReturnType<HypertestInstance['releases']['rollback']>> | undefined;
      ledger.list = async (...args: Parameters<typeof list>) => {
        armed = true;
        return list(...args);
      };
      registry.get = async (id, tx) => {
        const release = await get(id, tx);
        if (armed && tx === undefined && id === canary.manifestId) {
          armed = false;
          rolledBack = await ht.releases.rollback({ by: ALICE, reason: 'canary regression', manifestId: canary.manifestId });
        }
        return release; // the view from before the rollback
      };
      try {
        await assert.rejects(ht.releases.migrate(run.runId, { to: canary.manifestId, by: ALICE, reason: 'try the canary' }), (e: unknown) => {
          assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
          assert.match((e as Error).message, /target_state: release .* is retired \(rolled back\)/);
          return true;
        });
      } finally {
        registry.get = get;
        ledger.list = list;
      }
      assert.ok(rolledBack, 'the rollback ran inside the window');
      assert.deepEqual(rolledBack.quarantined, [], 'the run was not on the canary when the rollback swept it');
      let now = (await ht.status(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['paused', 'operator', here], 'never re-pinned onto the rolled-back release');
      assert.deepEqual(await ht.releases.epochs(run.runId), []);
      assert.deepEqual(await ht.events(run.runId, { types: ['run.migrated'] }), []);

      // the other order: the re-pin commits first, then the rollback of its target finds the migrated run and quarantines it
      const canary2 = otherRuntime(ht, 'canary2');
      await registerCanary(ht, canary2);
      const m = await ht.releases.migrate(run.runId, { to: canary2.manifestId, by: ALICE, reason: 'try the second canary' });
      assert.equal(m.run.runtimeManifestId, canary2.manifestId);
      const rb2 = await ht.releases.rollback({ by: ALICE, reason: 'second canary regression' });
      assert.deepEqual([rb2.rolledBack.manifestId, rb2.quarantined], [canary2.manifestId, [run.runId]]);
      now = (await ht.status(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['paused', 'quarantined', canary2.manifestId]);
      // migrated back to the active release, the operator's pause (from before the quarantine) is restored
      const back = await ht.releases.migrate(run.runId, { to: 'current', by: ALICE, reason: 'back to the active release' });
      assert.deepEqual([back.run.runtimeManifestId, back.run.status, back.run.pauseReason, back.epoch.seq], [here, 'paused', 'operator', 2]);
      await ht.cancel(run.runId, 'test done');
    } finally {
      gates.releaseAll();
      await ht.close();
      await own.dispose();
    }
  });

  test('a quarantine committing after the migration read the run is never overwritten by its checkpoint, nor resumed when the migration fails', async () => {
    const own = await testStore();
    const gates = leadGates();
    const ht = await open(config(join(dir.path, 'checkpoint-overwrite'), own.store), gates.brains).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      // OLD (synthetic) active, THIS runtime promoted over it (a rollback returns to OLD), a synthetic canary as the target
      const old = otherRuntime(ht, 'old');
      await ht.releases.register({ manifest: old, by: ALICE });
      await greenSuites(ht, old.manifestId);
      for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, old.manifestId, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
      const here = ht.manifest.manifestId;
      await toCanary(ht, here, { percentage: 100 });
      await gatedPromote(ht, here, { by: ALICE, reason: 'gate' });
      const target = otherRuntime(ht, 'target');
      await registerCanary(ht, target);
      const run = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
      await gates.of(run.runId).inLead; // its planning turn holds a claim: the checkpoint is not reached in time

      // THIS runtime is rolled back right after the migration read the run (running) — while it reads the source manifest
      const registry = ht.releases.registry;
      const get = registry.get.bind(registry);
      let rb: Awaited<ReturnType<HypertestInstance['releases']['rollback']>> | undefined;
      let fired = false;
      registry.get = async (id, tx) => {
        if (!fired && tx === undefined && id === here) {
          fired = true;
          rb = await ht.releases.rollback({ by: ALICE, reason: 'replay regression', manifestId: here });
        }
        return get(id, tx);
      };
      try {
        await assert.rejects(ht.releases.migrate(run.runId, { to: target.manifestId, by: ALICE, reason: 'move', checkpointTimeoutMs: 300 }), (e: unknown) => isHypertestError(e, 'timeout'));
      } finally {
        registry.get = get;
      }
      assert.deepEqual(rb?.quarantined, [run.runId], 'the rollback swept the run');
      const now = (await ht.status(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['paused', 'quarantined', here], 'the failed migration left the quarantine in place');
      const types = (await ht.events(run.runId)).map((e) => e.eventType);
      assert.equal(types.filter((t) => t === 'run.quarantined').length, 1);
      assert.equal(types.slice(types.indexOf('run.quarantined')).filter((t) => t === 'run.resumed').length, 0, 'never resumed after the quarantine');
      await ht.cancel(run.runId, 'test done');
    } finally {
      gates.releaseAll();
      await ht.close();
      await own.dispose();
    }
  });

  test('a quarantine racing the release of a failed migration\'s checkpoint is kept (the release happens under the run\'s lock)', async () => {
    const own = await testStore();
    const gates = leadGates();
    const ht = await open(config(join(dir.path, 'checkpoint-release-race'), own.store), gates.brains).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      // OLD (synthetic) active — the migration target; THIS runtime the canary the run is created under
      const old = otherRuntime(ht, 'old');
      await ht.releases.register({ manifest: old, by: ALICE });
      await greenSuites(ht, old.manifestId);
      for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, old.manifestId, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
      const here = ht.manifest.manifestId;
      await toCanary(ht, here, { labels: { canary: 'yes' } });
      const run = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head }, labels: { canary: 'yes' } });
      assert.equal(run.runtimeManifestId, here);
      await gates.of(run.runId).inLead;
      // an unsettled operation of the run makes the migration fail after its checkpoint (which it then releases)
      const items = await ht.services.blackboard.listWorkItems({ runId: run.runId });
      const opCtx = { runId: run.runId, correlationId: run.runId, actorId: 'system:test' };
      const op = await ht.services.operations.prepare(
        { runId: run.runId, workItemId: items[0]!.workItemId, operationType: 'env.restart', adapterId: 'record:http', target: { kind: 'environment', resourceKey: 'env/shop' }, desiredStateHash: 'h', inputHash: 'i' },
        opCtx,
      );

      // the canary's rollback, started from outside any transaction once the release of the checkpoint begins
      let go!: () => void;
      const started = new Promise<void>((resolve) => (go = resolve));
      const rollbackDone = started.then(() => ht.releases.rollback({ by: ALICE, reason: 'canary regression' }));
      const bb = ht.services.blackboard;
      const listWorkItems = bb.listWorkItems.bind(bb);
      const ledger = ht.services.operations;
      const list = ledger.list.bind(ledger);
      const runsRepo = ht.services.runs;
      const update = runsRepo.update.bind(runsRepo);
      let armed = false;
      bb.listWorkItems = async (filter) => {
        if (filter?.runId === run.runId && (await ht.status(run.runId))?.pauseReason === 'migrating') gates.of(run.runId).release();
        return listWorkItems(filter);
      };
      // reconciliation lists the operations after the checkpoint: the next change of the run is the checkpoint's release
      ledger.list = async (...args: Parameters<typeof list>) => {
        if (args[0]?.runId === run.runId) armed = true;
        return list(...args);
      };
      runsRepo.update = async (id, patch, ctx, tx) => {
        if (armed && id === run.runId) {
          if (tx === undefined && patch.status === 'running') {
            // a release that reads the run and then resumes it outside a lock: the rollback lands in between
            armed = false;
            go();
            await rollbackDone;
          } else if (tx !== undefined && Object.keys(patch).length === 0) {
            // the release reads the run under its lock: the rollback starts now and must wait for this transaction
            armed = false;
            const locked = await update(id, patch, ctx, tx);
            go();
            await new Promise((resolve) => setTimeout(resolve, 150));
            return locked;
          }
        }
        return update(id, patch, ctx, tx);
      };
      try {
        await assert.rejects(ht.releases.migrate(run.runId, { to: old.manifestId, by: ALICE, reason: 'move off the canary' }), (e: unknown) => {
          assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
          assert.match((e as Error).message, new RegExp(`unsettled operations \\(${op.operationId} prepared\\)`));
          return true;
        });
      } finally {
        bb.listWorkItems = listWorkItems;
        ledger.list = list;
        runsRepo.update = update;
      }
      const rb = await rollbackDone;
      assert.deepEqual([rb.rolledBack.manifestId, rb.quarantined], [here, [run.runId]]);
      const now = (await ht.status(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason, now.runtimeManifestId], ['paused', 'quarantined', here], 'the quarantine is not undone by the checkpoint\'s release');
      assert.deepEqual(await ht.releases.epochs(run.runId), []);
      await ht.services.operations.transition(op.operationId, 'not_applied', {}, opCtx);
      await ht.cancel(run.runId, 'test done');
    } finally {
      gates.releaseAll();
      await ht.close();
      await own.dispose();
    }
  });

  test('runs whose creator died before re-checking them are quarantined by the first loop that would drive them, by resumeIncomplete and by an operator resume', async () => {
    const own = await testStore();
    const cfg = config(join(dir.path, 'creator-died'), own.store);
    let here: string;
    let a: string;
    let b: string;
    let c: string;
    let d: string;
    let transitionId: string;
    try {
      {
        const ht = await open(cfg, { lead: () => new Promise(() => undefined) });
        try {
          here = ht.manifest.manifestId;
          // unmanaged: three runs of this runtime; C is paused by an operator
          a = (await ht.start({ goal: GOAL, target: {} })).runId;
          b = (await ht.start({ goal: GOAL, target: {} })).runId;
          c = (await ht.start({ goal: GOAL, target: {} })).runId;
          await ht.control.pauseRun(c, 'operator');
          // D is held at the checkpoint of a migration whose process died
          d = (await ht.start({ goal: GOAL, target: {} })).runId;
          await ht.control.pauseRun(d, 'migrating');
          await ht.releases.register({ by: ALICE });
          // the registry's rollback without the release service's sweep: what is left when the creators of these runs
          // died after the rollback's sweep and before their own re-check
          transitionId = (await ht.releases.registry.rollback({ by: ALICE, reason: 'bad candidate', manifestId: here })).transition.transitionId;
          for (const id of [a, b]) assert.equal((await ht.status(id))!.status, 'running');
        } finally {
          await ht.close();
        }
      }
      const ht = await open(cfg, { lead: () => new Promise(() => undefined) });
      try {
        assert.equal(ht.manifest.manifestId, here);
        const quarantined = async (id: string, previousStatus: string) => {
          const r = (await ht.status(id))!;
          assert.deepEqual([r.status, r.pauseReason, r.runtimeManifestId], ['paused', 'quarantined', here], id);
          const q = await ht.events(id, { types: ['run.quarantined'] });
          assert.equal(q.length, 1, `${id}: one quarantine`);
          const p = q[0]!.payload as Record<string, unknown>;
          assert.deepEqual([p['manifestId'], p['transitionId'], p['by'], p['reason'], p['previousStatus']], [here, transitionId, ALICE, 'bad candidate', previousStatus]);
        };
        // 1 an idempotent start of A starts a loop: its recover quarantines A before anything is driven
        const again = await ht.start({ goal: GOAL, target: {}, runId: a });
        assert.equal(again.runId, a);
        const deadline = Date.now() + 30_000;
        while ((await ht.status(a))!.pauseReason !== 'quarantined') {
          if (Date.now() > deadline) assert.fail(`run ${a} was driven by the rolled-back runtime instead of being quarantined`);
          await new Promise((r) => setTimeout(r, 50));
        }
        await quarantined(a, 'running');
        // 2 resumeIncomplete quarantines B instead of resuming it
        assert.deepEqual(await ht.resumeIncomplete(), [], 'nothing of the rolled-back release is resumed');
        await quarantined(b, 'running');
        // 3 the operator's resume of C quarantines it and is refused
        await assert.rejects(ht.control.resumeRun(c), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is quarantined/.test((e as Error).message));
        await quarantined(c, 'paused');
        assert.match((await ht.report(c)).markdown, /\*\*This run is QUARANTINED\*\*/);
        // 4 releasing D's abandoned checkpoint would resume it on the rolled-back runtime: it is quarantined instead
        await assert.rejects(ht.releases.releaseCheckpoint(d, { by: ALICE, reason: 'the migrating process died' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is quarantined/.test((e as Error).message));
        await quarantined(d, 'paused');
        assert.deepEqual(await ht.events(d, { types: ['run.migration_released'] }), []);
        for (const id of [a, b, c, d]) await ht.cancel(id, 'test done');
      } finally {
        await ht.close();
      }
    } finally {
      await own.dispose();
    }
  });

  test('the checkpoint of an abandoned migration is released explicitly; a live migration whose checkpoint is left fails and re-pins nothing', async () => {
    const own = await testStore();
    const gates = leadGates();
    const ht = await open(config(join(dir.path, 'checkpoint'), own.store), gates.brains).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      const here = ht.manifest.manifestId;
      await ht.releases.register({ by: ALICE });
      await greenSuites(ht, here);
      for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await gatedPromote(ht, here, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
      const canary = otherRuntime(ht, 'canary');
      await registerCanary(ht, canary);
      const target = { repoPath: repo.path, commit: repo.head };

      // 1 an abandoned checkpoint (the migrating process died after pausing the run): resume is refused, release is explicit
      const abandoned = await ht.start({ goal: GOAL, target });
      await gates.of(abandoned.runId).inLead;
      await ht.control.pauseRun(abandoned.runId, 'migrating');
      await assert.rejects(ht.control.resumeRun(abandoned.runId), (e: unknown) => isHypertestError(e, 'precondition_failed') && /--abort/.test((e as Error).message));
      await assert.rejects(ht.releases.releaseCheckpoint(abandoned.runId, { by: 'alice', reason: 'r' }), (e: unknown) => isHypertestError(e, 'invalid_argument'), 'the actor is <kind>:<id>');
      await assert.rejects(ht.releases.releaseCheckpoint(abandoned.runId, { by: ALICE, reason: ' ' }), (e: unknown) => isHypertestError(e, 'invalid_argument'), 'a reason is required');
      await assert.rejects(ht.releases.releaseCheckpoint('run_missing', { by: ALICE, reason: 'r' }), (e: unknown) => isHypertestError(e, 'not_found'));
      const released = await ht.releases.releaseCheckpoint(abandoned.runId, { by: ALICE, reason: 'the migrating process died' });
      assert.deepEqual([released.status, released.pauseReason, released.runtimeManifestId], ['running', undefined, here]);
      const [ev] = await ht.events(abandoned.runId, { types: ['run.migration_released'] });
      assert.deepEqual(ev?.payload, { runId: abandoned.runId, manifestId: here, by: ALICE, reason: 'the migrating process died' });
      assert.equal(ev?.actorId, ALICE);
      assert.match((await ht.report(abandoned.runId)).markdown, /abandoned runtime migration: its checkpoint was released by human:alice \(the migrating process died\)/);
      await assert.rejects(ht.releases.releaseCheckpoint(abandoned.runId, { by: ALICE, reason: 'again' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /only a run held at a migration checkpoint/.test((e as Error).message));
      gates.of(abandoned.runId).release();
      await ht.cancel(abandoned.runId, 'test done');

      // the live migrations below reach their checkpoint once the run's planning turn is let go after the pause
      const bb = ht.services.blackboard;
      const listWorkItems = bb.listWorkItems.bind(bb);
      const ledger = ht.services.operations;
      const list = ledger.list.bind(ledger);
      const interfere = async (runId: string, during: () => Promise<void>, expected: RegExp) => {
        let once = true;
        bb.listWorkItems = async (filter) => {
          if (filter?.runId === runId && (await ht.status(runId))?.pauseReason === 'migrating') gates.of(runId).release();
          return listWorkItems(filter);
        };
        ledger.list = async (...args: Parameters<typeof list>) => {
          if (once && args[0]?.runId === runId) {
            once = false;
            await during();
          }
          return list(...args);
        };
        try {
          await assert.rejects(ht.releases.migrate(runId, { to: canary.manifestId, by: ALICE, reason: 'try the canary' }), (e: unknown) => {
            assert.ok(isHypertestError(e, 'conflict'), String(e));
            assert.match((e as Error).message, expected);
            return true;
          });
        } finally {
          bb.listWorkItems = listWorkItems;
          ledger.list = list;
        }
        const now = (await ht.status(runId))!;
        assert.equal(now.runtimeManifestId, here, 'nothing re-pinned');
        assert.deepEqual(await ht.releases.epochs(runId), []);
        assert.deepEqual(await ht.events(runId, { types: ['run.migrated'] }), []);
        return now;
      };

      // 2 the checkpoint of a migration in progress is released: the migration finds the run running and stops
      const live = await ht.start({ goal: GOAL, target });
      await gates.of(live.runId).inLead;
      const afterRelease = await interfere(live.runId, async () => void (await ht.releases.releaseCheckpoint(live.runId, { by: ALICE, reason: 'looked abandoned' })), /left its checkpoint \(now running\)/);
      assert.equal(afterRelease.status, 'running');
      await ht.cancel(live.runId, 'test done');

      // 3 released and paused again (by anyone) before the re-pin: the run may have moved past the checkpoint's snapshot
      const repaused = await ht.start({ goal: GOAL, target });
      await gates.of(repaused.runId).inLead;
      const afterRepause = await interfere(
        repaused.runId,
        async () => {
          const ctx = { runId: repaused.runId, correlationId: repaused.runId, actorId: 'human:bob' };
          await ht.services.db.transaction(async (tx) => {
            await ht.services.runs.update(repaused.runId, { status: 'running' }, ctx, tx);
            await ht.services.runs.update(repaused.runId, { status: 'paused', pauseReason: 'operator' }, ctx, tx);
          });
        },
        /left its checkpoint during the migration \(paused operator, not migrating\)/,
      );
      assert.deepEqual([afterRepause.status, afterRepause.pauseReason], ['paused', 'operator'], 'the other pause is kept');
      await ht.cancel(repaused.runId, 'test done');
    } finally {
      gates.releaseAll();
      await ht.close();
      await own.dispose();
    }
  });
});
