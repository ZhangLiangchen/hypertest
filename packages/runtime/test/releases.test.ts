import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import {
  buildRuntimeManifest, canaryBucket, canarySelectionProblems, canarySelects, createRuntimeReleaseRegistry, runtimeCompatibility, runtimeMigrations,
  type RuntimeRelease, type RuntimeReleaseRegistry,
} from '../src/index.ts';
import { baseDeps } from './helpers.ts';

const code = (c: string) => (e: unknown) => isHypertestError(e, c as never);
const BY = 'human:alice';

function manifest(tag: string, overrides: Partial<Omit<RuntimeManifest, 'manifestId' | 'createdAt'>> = {}): RuntimeManifest {
  return buildRuntimeManifest(
    {
      hypertest: { version: '0.3.0', sourceDigest: tag },
      agentEngines: [{ kind: 'native', version: '0.3.0' }, { kind: 'pi', version: '1.2.0', adapter: { package: '@hypertest/runtime-pi', version: '0.3.0' } }],
      defaultEngine: 'native',
      providerAdapters: [{ provider: 'sim', package: '@hypertest/model#scripted', version: '0.3.0' }],
      modelCatalogRevision: 'mc_1',
      schemas: { event: 'collab/005', contextSnapshot: 'context/003', tool: 'tools/1', operation: 'operation/004', evidence: 'evidence/002' },
      policyBundleRevision: 'policy_1',
      roleCatalogRevision: 'roles_1',
      toolCatalogRevision: 'tc_1',
      protocol: { id: 'bugate', version: '2', digest: 'sha256:aa' },
      ...overrides,
    },
    '2026-01-01T00:00:00.000Z',
  );
}

describe('runtime release registry (SQL)', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let reg: RuntimeReleaseRegistry;
  let deps: ReturnType<typeof baseDeps>;

  // a fresh database per test: the registry holds one active pointer per deployment
  beforeEach(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps();
    reg = createRuntimeReleaseRegistry({ ...deps, db });
  });
  afterEach(async () => dispose());

  async function passSuites(manifestId: string): Promise<void> {
    await reg.recordSuiteResult({ manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', suiteRevision: '1', passed: true, summary: { total: 21, failed: 0 }, by: 'ci:github' });
    await reg.recordSuiteResult({ manifestId, kind: 'replay', suiteId: 'poc-a-whitebox', suiteRevision: 'poc-1', passed: true, summary: { total: 3, failed: 0 }, by: 'ci:github' });
  }

  async function activate(m: RuntimeManifest, canary: { percentage?: number; labels?: Record<string, string> } = { percentage: 10 }): Promise<RuntimeRelease> {
    await reg.register(m, { by: BY });
    await passSuites(m.manifestId);
    await reg.promote(m.manifestId, { by: BY, reason: 'contract suite green' });
    await reg.promote(m.manifestId, { by: BY, reason: 'replay green', canary });
    return (await reg.promote(m.manifestId, { by: BY, reason: 'release gate green' })).release;
  }

  test('register: a verified manifest becomes a candidate (idempotent); a tampered manifest is refused', async () => {
    const m = manifest('a');
    const first = await reg.register(m, { by: BY });
    assert.equal(first.created, true);
    assert.deepEqual([first.release.state, first.release.rolledBack, first.release.registeredBy, first.release.manifest], ['candidate', false, BY, m]);
    const again = await reg.register(m, { by: 'human:bob' });
    assert.equal(again.created, false);
    assert.equal(again.release.registeredBy, BY, 'the first registration stands');
    await assert.rejects(reg.register({ ...m, toolCatalogRevision: 'tc_evil' }, { by: BY }), code('integrity_violation'));
    await assert.rejects(reg.register(m, { by: ' ' }), code('invalid_argument'));
    await assert.rejects(reg.register(manifest('b'), { by: BY, allowedMigrations: [{ schema: 'event', from: 'x', to: 'x' }] }), code('invalid_argument'));
    await assert.rejects(reg.register(m, { by: BY, allowedMigrations: [{ schema: 'event', from: 'collab/004', to: 'collab/005' }] }), code('conflict'), 'a registered release is immutable');
    assert.deepEqual((await reg.history(m.manifestId)).map((t) => [t.action, t.toState, t.actor]), [['register', 'candidate', BY]]);
  });

  test('promotion needs the LATEST engine-contract AND replay results of this manifest to pass', async () => {
    const m = manifest('a');
    await reg.register(m, { by: BY });
    await assert.rejects(reg.promote(m.manifestId, { by: BY, reason: 'no suites yet' }), (e: unknown) => {
      assert.ok(isHypertestError(e, 'precondition_failed'));
      assert.match(e.message, /no engine_contract suite result is recorded/);
      assert.match(e.message, /no replay suite result is recorded/);
      return true;
    });
    await reg.recordSuiteResult({ manifestId: m.manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', passed: true, summary: { total: 21, failed: 0 }, by: 'ci' });
    await assert.rejects(reg.promote(m.manifestId, { by: BY, reason: 'replay missing' }), /no replay suite result is recorded/);
    await reg.recordSuiteResult({ manifestId: m.manifestId, kind: 'replay', suiteId: 'poc-a-whitebox', passed: false, summary: { total: 3, failed: 1 }, by: 'ci' });
    await assert.rejects(reg.promote(m.manifestId, { by: BY, reason: 'replay failed' }), /the latest replay suite result \(poc-a-whitebox, rsr_\d+\) failed/);
    await reg.recordSuiteResult({ manifestId: m.manifestId, kind: 'replay', suiteId: 'poc-a-whitebox', passed: true, summary: { total: 3, failed: 0 }, by: 'ci' });
    const ready = await reg.promotionReadiness(m.manifestId);
    assert.deepEqual([ready.ready, ready.problems, ready.latest.replay?.passed], [true, [], true]);
    const shadow = await reg.promote(m.manifestId, { by: BY, reason: 'green' });
    assert.equal(shadow.release.state, 'shadow');
    assert.deepEqual(shadow.transition.details['suiteResultIds'], [ready.latest.engine_contract!.resultId, ready.latest.replay!.resultId]);
    // a later failing result blocks the NEXT promotion (latest wins, never "any pass")
    await reg.recordSuiteResult({ manifestId: m.manifestId, kind: 'engine_contract', suiteId: 'agent-engine-abi', passed: false, summary: { total: 21, failed: 2 }, by: 'ci' });
    await assert.rejects(reg.promote(m.manifestId, { by: BY, reason: 'x', canary: { percentage: 5 } }), /latest engine_contract suite result .* failed/);
    assert.equal((await reg.get(m.manifestId))!.state, 'shadow');
  });

  test('suite results cannot claim a pass over failures or an empty run; unknown manifests and kinds are refused', async () => {
    const m = manifest('a');
    await reg.register(m, { by: BY });
    const bad: Array<[string, Parameters<RuntimeReleaseRegistry['recordSuiteResult']>[0], string]> = [
      ['pass with failures', { manifestId: m.manifestId, kind: 'replay', suiteId: 's', passed: true, summary: { total: 3, failed: 1 }, by: 'ci' }, 'invalid_argument'],
      ['pass with nothing run', { manifestId: m.manifestId, kind: 'replay', suiteId: 's', passed: true, summary: { total: 0 }, by: 'ci' }, 'invalid_argument'],
      ['failed > total', { manifestId: m.manifestId, kind: 'replay', suiteId: 's', passed: false, summary: { total: 1, failed: 2 }, by: 'ci' }, 'invalid_argument'],
      ['unknown kind', { manifestId: m.manifestId, kind: 'vibes' as never, suiteId: 's', passed: true, by: 'ci' }, 'invalid_argument'],
      ['bad digest', { manifestId: m.manifestId, kind: 'replay', suiteId: 's', passed: true, reportDigest: 'abc', by: 'ci' }, 'invalid_argument'],
      ['unregistered', { manifestId: 'rm_unknown', kind: 'replay', suiteId: 's', passed: true, by: 'ci' }, 'not_found'],
    ];
    for (const [what, input, c] of bad) await assert.rejects(reg.recordSuiteResult(input), code(c), what);
    assert.deepEqual(await reg.suiteResults(m.manifestId), []);
  });

  test('candidate → shadow → canary → active, one step at a time; entering canary needs a selection; one canary at a time', async () => {
    const a = manifest('a');
    const b = manifest('b');
    for (const m of [a, b]) {
      await reg.register(m, { by: BY });
      await passSuites(m.manifestId);
      await reg.promote(m.manifestId, { by: BY, reason: 'r' });
    }
    await assert.rejects(reg.promote(a.manifestId, { by: BY, reason: 'r' }), code('invalid_argument'), 'canary needs a selection');
    await assert.rejects(reg.promote(a.manifestId, { by: BY, reason: 'r', canary: { percentage: 0 } }), /a canary must select runs/);
    await assert.rejects(reg.promote(a.manifestId, { by: BY, reason: 'r', canary: { percentage: 101 } }), code('invalid_argument'));
    const canary = await reg.promote(a.manifestId, { by: BY, reason: 'r', canary: { percentage: 25, labels: { team: 'payments' } } });
    assert.deepEqual([canary.release.state, canary.release.canary], ['canary', { percentage: 25, labels: { team: 'payments' } }]);
    await assert.rejects(reg.promote(b.manifestId, { by: BY, reason: 'r', canary: { percentage: 5 } }), code('conflict'), 'one canary at a time');
    await assert.rejects(reg.promote(a.manifestId, { by: BY, reason: 'r', canary: { percentage: 5 } }), code('invalid_argument'), 'a selection only when entering canary');
    const active = await reg.promote(a.manifestId, { by: BY, reason: 'gate green' });
    assert.deepEqual([active.release.state, active.release.canary, active.retiring], ['active', undefined, undefined]);
    assert.deepEqual(active.pointer, { manifestId: a.manifestId, revision: 1, updatedAt: active.pointer!.updatedAt });
    await assert.rejects(reg.promote(a.manifestId, { by: BY, reason: 'again' }), code('precondition_failed'));
    // the second release takes over: the previous active one is retiring and the pointer remembers it
    await reg.promote(b.manifestId, { by: BY, reason: 'r', canary: { labels: { canary: 'yes' } } });
    const next = await reg.promote(b.manifestId, { by: BY, reason: 'gate green' });
    assert.equal(next.retiring?.manifestId, a.manifestId);
    assert.equal((await reg.get(a.manifestId))!.state, 'retiring');
    assert.deepEqual(await reg.activePointer(), { manifestId: b.manifestId, previousManifestId: a.manifestId, revision: 2, updatedAt: next.pointer!.updatedAt });
    assert.deepEqual((await reg.list({ states: ['active'] })).map((r) => r.manifestId), [b.manifestId]);
    assert.deepEqual((await reg.history(a.manifestId)).map((t) => `${t.action}:${t.fromState ?? '-'}→${t.toState}`), [
      'register:-→candidate', 'promote:candidate→shadow', 'promote:shadow→canary', 'promote:canary→active', 'retire:active→retiring',
    ]);
    // retire: only a retiring release, and only explicitly
    await assert.rejects(reg.retire(b.manifestId, { by: BY, reason: 'x' }), code('precondition_failed'));
    assert.equal((await reg.retire(a.manifestId, { by: 'system:hypertest', reason: 'no live runs' })).state, 'retired');
  });

  test('admission: unmanaged until a release is active; then only the active release or a canary that selects the run', async () => {
    const a = manifest('a');
    const b = manifest('b');
    assert.deepEqual(await reg.admit({ manifestId: a.manifestId, runId: 'run_1' }), { allowed: true, mode: 'unmanaged' });
    const strict = await reg.admit({ manifestId: a.manifestId, runId: 'run_1', requireActive: true });
    assert.equal(strict.allowed, false);
    await activate(a);
    assert.deepEqual(await reg.admit({ manifestId: a.manifestId, runId: 'run_1' }), { allowed: true, mode: 'active', activeManifestId: a.manifestId });
    const unregistered = await reg.admit({ manifestId: b.manifestId, runId: 'run_1' });
    assert.equal(unregistered.allowed, false);
    assert.match(!unregistered.allowed ? unregistered.reason : '', /is not a registered release: new runs are created only under the active release/);
    await reg.register(b, { by: BY });
    const candidate = await reg.admit({ manifestId: b.manifestId, runId: 'run_1' });
    assert.deepEqual([candidate.allowed, !candidate.allowed && candidate.state], [false, 'candidate']);
    await passSuites(b.manifestId);
    await reg.promote(b.manifestId, { by: BY, reason: 'r' });
    await reg.promote(b.manifestId, { by: BY, reason: 'r', canary: { labels: { canary: 'yes' } } });
    assert.deepEqual(await reg.admit({ manifestId: b.manifestId, runId: 'run_1', labels: { canary: 'yes', team: 'x' } }), { allowed: true, mode: 'canary', activeManifestId: a.manifestId });
    const notSelected = await reg.admit({ manifestId: b.manifestId, runId: 'run_1', labels: { canary: 'no' } });
    assert.equal(notSelected.allowed, false);
    assert.match(!notSelected.allowed ? notSelected.reason : '', /is the canary and its selection \(labels canary=yes\) does not pick run run_1/);
    // the active release still takes every run (the canary is optional exposure)
    assert.equal((await reg.admit({ manifestId: a.manifestId, runId: 'run_2', labels: { canary: 'yes' } })).allowed, true);
  });

  test('canary percentage selection is a deterministic bucket of the run id', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `run_${String(i).padStart(4, '0')}`);
    for (const id of ids) assert.equal(canaryBucket(id), canaryBucket(id));
    const picked = ids.filter((id) => canarySelects({ percentage: 25 }, { runId: id }));
    assert.ok(picked.length > 60 && picked.length < 140, `about a quarter selected: ${picked.length}`);
    assert.deepEqual(ids.filter((id) => canarySelects({ percentage: 100 }, { runId: id })), ids);
    assert.equal(ids.some((id) => canarySelects({ percentage: 0 }, { runId: id })), false);
    assert.equal(canarySelects(undefined, { runId: 'run_1' }), false);
    assert.equal(canarySelects({ labels: { a: '1', b: '2' } }, { runId: 'run_1', labels: { a: '1' } }), false, 'every label must match');
    assert.equal(canarySelects({ labels: { toString: 'x' } }, { runId: 'run_1', labels: {} }), false, 'inherited properties never match');
    assert.deepEqual(canarySelectionProblems({ percentage: 5, extra: 1 }), ["canary selection: unknown key 'extra'"]);
    assert.deepEqual(canarySelectionProblems({ labels: {} }), ['a canary must select runs: a percentage above 0 and/or labels']);
  });

  test('rollback of the active release: the pointer moves back, the release is retired for good and never promoted again', async () => {
    const a = manifest('a');
    const b = manifest('b');
    await activate(a);
    await activate(b, { labels: { canary: 'yes' } });
    const rb = await reg.rollback({ by: BY, reason: 'critical false release in canary replay' });
    assert.equal(rb.rolledBack.manifestId, b.manifestId);
    assert.deepEqual([rb.fromState, rb.rolledBack.state, rb.rolledBack.rolledBack], ['active', 'retired', true]);
    assert.equal(rb.restored?.manifestId, a.manifestId);
    assert.equal((await reg.get(a.manifestId))!.state, 'active');
    assert.deepEqual(await reg.activePointer(), { manifestId: a.manifestId, revision: 3, updatedAt: rb.pointer!.updatedAt });
    assert.deepEqual((await reg.history()).slice(-2).map((t) => [t.action, t.manifestId, t.toState]), [['restore', a.manifestId, 'active'], ['rollback', b.manifestId, 'retired']]);
    // the rolled-back runtime creates no runs, not even after the registry forgets nothing
    const admitted = await reg.admit({ manifestId: b.manifestId, runId: 'run_9' });
    assert.equal(admitted.allowed, false);
    await passSuites(b.manifestId);
    await assert.rejects(reg.promote(b.manifestId, { by: BY, reason: 'retry' }), code('precondition_failed'));
    assert.match((await reg.promotionReadiness(b.manifestId)).problems.join(';'), /was rolled back: it is never promoted again/);
    // nothing left to roll back to
    await assert.rejects(reg.rollback({ by: BY, reason: 'again' }), /nothing to roll back/);
    await assert.rejects(reg.rollback({ by: BY, reason: 'again', manifestId: a.manifestId }), /no previous release to return to/);
  });

  test('rollback without a manifest stops the canary first (the active pointer does not move); explicit rollbacks of a candidate', async () => {
    const a = manifest('a');
    const b = manifest('b');
    const c = manifest('c');
    await activate(a);
    await reg.register(b, { by: BY });
    await passSuites(b.manifestId);
    await reg.promote(b.manifestId, { by: BY, reason: 'r' });
    await reg.promote(b.manifestId, { by: BY, reason: 'r', canary: { percentage: 50 } });
    const rb = await reg.rollback({ by: BY, reason: 'canary regressed' });
    assert.deepEqual([rb.rolledBack.manifestId, rb.fromState, rb.rolledBack.canary, rb.restored], [b.manifestId, 'canary', undefined, undefined]);
    assert.equal((await reg.activePointer())!.manifestId, a.manifestId);
    await reg.register(c, { by: BY });
    const rc = await reg.rollback({ by: BY, reason: 'bad build', manifestId: c.manifestId });
    assert.deepEqual([rc.fromState, rc.rolledBack.state, rc.rolledBack.rolledBack], ['candidate', 'retired', true]);
    await assert.rejects(reg.rollback({ by: BY, reason: 'x', manifestId: c.manifestId }), code('precondition_failed'), 'a retired release is not rolled back twice');
    // unmanaged admission never admits a rolled-back runtime either
    assert.equal((await reg.admit({ manifestId: c.manifestId, runId: 'run_1' })).allowed, false);
  });

  test('history tables are append-only and a registered manifest is immutable (database triggers)', async () => {
    const m = manifest('a');
    await reg.register(m, { by: BY });
    await passSuites(m.manifestId);
    await reg.recordEpoch({
      runId: 'run_1', fromManifestId: 'rm_old', toManifestId: m.manifestId, snapshotId: 'cs_1',
      reconciliation: { examined: 0, verified: [], notApplied: [], manualReview: [], stillPending: [], failed: [] },
      compatibility: [{ check: 'target_state', ok: true, detail: 'active' }], statusBefore: 'paused', statusAfter: 'running', migratedBy: BY, reason: 'r',
    });
    const refused = /append-only|immutable|never deleted|stays rolled back/;
    await assert.rejects(db.query('UPDATE ht_runtime_suite_results SET passed = NOT passed'), refused);
    await assert.rejects(db.query('DELETE FROM ht_runtime_suite_results'), refused);
    await assert.rejects(db.query("UPDATE ht_runtime_release_transitions SET actor = 'human:mallory'"), refused);
    await assert.rejects(db.query('DELETE FROM ht_runtime_epochs'), refused);
    await assert.rejects(db.query(`UPDATE ht_runtime_releases SET manifest = '{}'::jsonb WHERE manifest_id = $1`, [m.manifestId]), refused);
    await assert.rejects(db.query('DELETE FROM ht_runtime_releases'), refused);
    await assert.rejects(db.query('TRUNCATE ht_runtime_suite_results'), refused);
    await reg.rollback({ by: BY, reason: 'x', manifestId: m.manifestId });
    await assert.rejects(db.query('UPDATE ht_runtime_releases SET rolled_back = false WHERE manifest_id = $1', [m.manifestId]), refused);
    assert.equal((await reg.suiteResults(m.manifestId)).length, 2);
  });

  test('runtime epochs: seq and previous epoch per run; the chain must continue from the last target', async () => {
    const base = {
      snapshotId: 'cs_1', reconciliation: { examined: 1, verified: ['op_1'], notApplied: [], manualReview: [], stillPending: [], failed: [] },
      compatibility: [{ check: 'target_state', ok: true, detail: 'active' }], statusBefore: 'paused', statusAfter: 'running', migratedBy: BY, reason: 'r',
    };
    const e1 = await reg.recordEpoch({ ...base, runId: 'run_1', fromManifestId: 'rm_a', toManifestId: 'rm_b' });
    assert.deepEqual([e1.seq, e1.previousEpochId], [1, undefined]);
    await assert.rejects(reg.recordEpoch({ ...base, runId: 'run_1', fromManifestId: 'rm_a', toManifestId: 'rm_c' }), code('conflict'));
    const e2 = await reg.recordEpoch({ ...base, runId: 'run_1', fromManifestId: 'rm_b', toManifestId: 'rm_a' });
    assert.deepEqual([e2.seq, e2.previousEpochId], [2, e1.epochId]);
    assert.deepEqual((await reg.epochs('run_1')).map((e) => e.epochId), [e1.epochId, e2.epochId]);
    assert.deepEqual(await reg.epochs('run_other'), []);
    await assert.rejects(reg.recordEpoch({ ...base, runId: 'run_2', fromManifestId: 'rm_a', toManifestId: 'rm_a' }), code('invalid_argument'));
    await assert.rejects(reg.recordEpoch({ ...base, compatibility: [{ check: 'schema.event', ok: false, detail: 'x' }], runId: 'run_2', fromManifestId: 'rm_a', toManifestId: 'rm_b' }), code('precondition_failed'));
  });

  test('concurrent promotions of two releases to canary: exactly one wins (serialized registry mutations)', async () => {
    const a = manifest('a');
    const b = manifest('b');
    for (const m of [a, b]) {
      await reg.register(m, { by: BY });
      await passSuites(m.manifestId);
      await reg.promote(m.manifestId, { by: BY, reason: 'r' });
    }
    const results = await Promise.allSettled([a, b].map((m) => reg.promote(m.manifestId, { by: BY, reason: 'r', canary: { percentage: 10 } })));
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await reg.list({ states: ['canary'] })).length, 1);
  });

  test('lock: a transaction holding the registry lock sees no rollback commit before it ends (the migration re-check)', async () => {
    const m = manifest('a');
    await reg.register(m, { by: BY });
    await passSuites(m.manifestId);
    await reg.promote(m.manifestId, { by: BY, reason: 'r' });
    await reg.promote(m.manifestId, { by: BY, reason: 'r', canary: { percentage: 10 } });
    const order: string[] = [];
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    // registered outside the transaction's async context (a call from inside it would join the transaction): started once
    // the lock is held, it waits for the transaction (PostgreSQL: the lock row; PGlite: its single connection)
    const rollback = taken.then(() => reg.rollback({ by: BY, reason: 'bad canary', manifestId: m.manifestId })).then(() => order.push('rollback'));
    await db.transaction(async (tx) => {
      await reg.lock(tx);
      lockTaken();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await reg.get(m.manifestId, tx))!.state, 'canary', 'the release is unchanged while the lock is held');
      order.push('locked transaction');
    });
    await rollback;
    assert.deepEqual(order, ['locked transaction', 'rollback']);
    assert.deepEqual([(await reg.get(m.manifestId))!.state, (await reg.get(m.manifestId))!.rolledBack], ['retired', true]);
    await assert.rejects(reg.lock(undefined as never), code('invalid_argument'), 'the lock needs the caller\'s transaction');
  });
});

describe('runtimeCompatibility (migration check)', () => {
  const source = manifest('a');
  const release = (m: RuntimeManifest, extra: Partial<RuntimeRelease> = {}): RuntimeRelease => ({
    manifestId: m.manifestId, manifest: m, state: 'active', rolledBack: false, allowedMigrations: [], registeredBy: BY, registeredAt: '', updatedAt: '', ...extra,
  });
  const failing = (checks: ReturnType<typeof runtimeCompatibility>) => checks.filter((c) => !c.ok).map((c) => c.check);

  test('same schemas, pinned engines and protocol: compatible', () => {
    const checks = runtimeCompatibility(source, release(manifest('b')), { usedEngines: ['native', 'pi'] });
    assert.deepEqual(failing(checks), []);
    assert.deepEqual(checks.map((c) => c.check), ['target_state', 'target_integrity', 'source_differs', 'schema.event', 'schema.contextSnapshot', 'schema.tool', 'schema.operation', 'schema.evidence', 'engine.native', 'engine.pi', 'protocol']);
  });

  test('a changed schema needs an explicit allowed migration of the target', () => {
    const newer = manifest('b', { schemas: { event: 'collab/006', contextSnapshot: 'context/003', tool: 'tools/1', operation: 'operation/004', evidence: 'evidence/002' } });
    assert.deepEqual(failing(runtimeCompatibility(source, release(newer))), ['schema.event']);
    assert.deepEqual(failing(runtimeCompatibility(source, release(newer, { allowedMigrations: [{ schema: 'event', from: 'collab/005', to: 'collab/006' }] }))), []);
    assert.deepEqual(failing(runtimeCompatibility(source, release(newer, { allowedMigrations: [{ schema: 'event', from: 'collab/004', to: 'collab/006' }] }))), ['schema.event'], 'from must match the run');
  });

  test('refused: target not active/canary, rolled back, altered, missing engine, other protocol, same manifest', () => {
    const b = manifest('b');
    assert.deepEqual(failing(runtimeCompatibility(source, release(b, { state: 'shadow' }))), ['target_state']);
    assert.deepEqual(failing(runtimeCompatibility(source, release(b, { state: 'canary', rolledBack: true }))), ['target_state']);
    assert.deepEqual(failing(runtimeCompatibility(source, release({ ...b, policyBundleRevision: 'evil' }))), ['target_integrity']);
    const nativeOnly = manifest('b', { agentEngines: [{ kind: 'native', version: '0.3.0' }] });
    assert.deepEqual(failing(runtimeCompatibility(source, release(nativeOnly), { usedEngines: ['pi'] })), ['engine.pi']);
    assert.deepEqual(failing(runtimeCompatibility(source, release(manifest('b', { protocol: { id: 'other', version: '1', digest: 'd' } })))), ['protocol']);
    assert.deepEqual(failing(runtimeCompatibility(source, release(source))), ['source_differs']);
  });
});
