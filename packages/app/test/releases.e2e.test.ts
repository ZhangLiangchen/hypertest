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

async function greenSuites(ht: HypertestInstance, manifestId: string): Promise<void> {
  await ht.releases.recordSuite({ manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', suiteRevision: '1', passed: true, summary: { total: 21, failed: 0 }, by: 'ci:github' });
  await ht.releases.recordSuite({ manifestId, kind: 'replay', suiteId: 'poc-a-whitebox', suiteRevision: 'poc-1', passed: true, summary: { total: 3, failed: 0 }, by: 'ci:github' });
}

async function toCanary(ht: HypertestInstance, manifestId: string, canary: { percentage?: number; labels?: Record<string, string> }): Promise<void> {
  if (manifestId === ht.manifest.manifestId) await ht.releases.register({ by: ALICE });
  await greenSuites(ht, manifestId);
  await ht.releases.promote(manifestId, { by: ALICE, reason: 'compatibility suite green' });
  await ht.releases.promote(manifestId, { by: ALICE, reason: 'production replay green', canary });
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
        const active = await ht.releases.promote(oldId, { by: ALICE, reason: 'release gate green' });
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
        const promoted = await ht.releases.promote(newId, { by: ALICE, reason: 'canary healthy' });
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
    for (const [i, reason] of ['contract', 'replay', 'gate'].entries()) await ht.releases.promote(here, { by: ALICE, reason, ...(i === 1 ? { canary: { percentage: 5 } } : {}) });
    const canary = otherManifest('canary');
    await ht.releases.register({ manifest: canary, by: ALICE });
    await greenSuites(ht, canary.manifestId);
    await ht.releases.promote(canary.manifestId, { by: ALICE, reason: 'r' });
    await ht.releases.promote(canary.manifestId, { by: ALICE, reason: 'r', canary: { labels: { canary: 'yes' } } });
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
        await ht.releases.promote(first, { by: ALICE, reason: 'gate' });
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
      const p = await ht.releases.promote(ht.manifest.manifestId, { by: ALICE, reason: 'gate' });
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
