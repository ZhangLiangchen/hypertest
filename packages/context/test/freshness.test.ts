import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sha256Hex } from '@hypertest/core';
import { collabMigrations, createBlackboard, createEventStore, createSpecRepository } from '@hypertest/collab';
import { InMemoryEventSink, type ContextSnapshot, type ReadSetEntry } from '@hypertest/domain';
import { eventCtx, tempDir } from '@hypertest/testkit';
import {
  contextMigrations,
  createFreshnessGuard,
  createResolverRegistry,
  createSnapshotStore,
  environmentResolver,
  experimentResolver,
  fileResolver,
  functionResolver,
  leaseResolver,
  oracleResolver,
  recordResolver,
  type FreshnessGuard,
  type ResourceVersionResolver,
  type SnapshotStore,
} from '../src/index.ts';
import { entry, openDb, rejectsWith, type Db } from './helpers.ts';

let env: Db;
let store: SnapshotStore;
let sink: InMemoryEventSink;

before(async () => {
  env = await openDb([...collabMigrations, ...contextMigrations]);
  store = createSnapshotStore(env.deps);
  sink = new InMemoryEventSink();
});
after(async () => {
  await env.dispose();
});

async function snapshot(runId: string, readSet: ReadSetEntry[]): Promise<ContextSnapshot> {
  return store.create(
    { runId, eventSeq: 1, blackboardRevision: 1, planRevision: 1, runtimeManifestId: 'rm_1', oracleRevisions: {}, experimentRevisions: {}, policyRevision: 'p', evidenceRootHash: 'r', readSet },
    eventCtx(runId),
  );
}

/** A mutable world + resolvers that count their calls. */
function world() {
  const envs = new Map<string, { generation: number; buildDigest?: string }>([['env-1', { generation: 3, buildDigest: 'sha256:b1' }]]);
  const oracles = new Map<string, number>([['or-1', 2]]);
  const files = new Map<string, string>([['src/a.ts', 'v1']]);
  let calls = 0;
  const count = (r: ResourceVersionResolver): ResourceVersionResolver => ({
    resourceType: r.resourceType,
    currentVersion: (id) => {
      calls++;
      return r.currentVersion(id);
    },
  });
  const guard = (resolvers: ResourceVersionResolver[] = [
    environmentResolver((id) => envs.get(id)),
    oracleResolver(async (id) => (oracles.has(id) ? { revision: oracles.get(id)! } : undefined)),
    functionResolver('file', (id) => files.get(id)),
  ]): FreshnessGuard => createFreshnessGuard({ ...env.deps, events: sink, snapshots: store, resolvers: createResolverRegistry(resolvers.map(count)) });
  return { envs, oracles, files, guard, calls: () => calls };
}

const readSet = (): ReadSetEntry[] => [
  entry('environment', 'env-1', '3:sha256:b1'),
  entry('oracle', 'or-1', '2'),
  entry('file', 'src/a.ts', 'v1'),
  entry('commit', 'abc123', 'abc123', { kind: 'immutable' }),
];

test('environment generation bump ⇒ stale for a mutating action; read-only actions are unaffected and call no resolver', async () => {
  const w = world();
  const g = w.guard();
  const snap = await snapshot('run_env', readSet());
  const deploy = { tool: 'env.deploy', resources: ['env-1'], mutating: true };
  const read = { tool: 'http.request', resources: ['env-1'], mutating: false };

  assert.deepEqual(await g.validate(snap, deploy, eventCtx('run_env')), { fresh: true, checked: 2 });
  w.envs.set('env-1', { generation: 4, buildDigest: 'sha256:b1' });
  const before = w.calls();
  assert.deepEqual(await g.validate(snap.snapshotId, read, eventCtx('run_env')), { fresh: true, checked: 0 });
  assert.equal(w.calls(), before, 'read-only validation makes no resolver call');

  const r = await g.validate(snap.snapshotId, deploy, eventCtx('run_env'));
  assert.deepEqual(r, {
    fresh: false,
    checked: 2,
    stale: [{ resourceType: 'environment', resourceId: 'env-1', observedVersion: '3:sha256:b1', currentVersion: '4:sha256:b1', reason: 'version_changed' }],
  });
  const ev = sink.ofType('context.stale_rejected').at(-1)!;
  assert.equal(ev.runId, 'run_env');
  assert.equal(ev.aggregateId, snap.snapshotId);
  assert.deepEqual((ev.payload as { stale: unknown[] }).stale, r.fresh ? [] : r.stale);
  assert.equal((ev.payload as { tool: string }).tool, 'env.deploy');

  // A build digest change with the same generation is also stale.
  w.envs.set('env-1', { generation: 3, buildDigest: 'sha256:b2' });
  const r2 = await g.validate(snap, deploy, eventCtx('run_env'));
  assert.equal(r2.fresh, false);
  // Read-only actions do not even need the snapshot.
  assert.deepEqual(await g.validate('cs_nope', read, eventCtx('run_env')), { fresh: true, checked: 0 });
});

test('a snapshot object edited after creation is not trusted: the stored snapshot decides', async () => {
  const w = world();
  const g = w.guard();
  const snap = await snapshot('run_forged', readSet());
  w.envs.set('env-1', { generation: 9, buildDigest: 'sha256:b1' });
  // Someone "refreshes" the observed version in a copy instead of building a new snapshot.
  const forged = { ...snap, readSet: snap.readSet.map((e) => (e.resourceType === 'environment' ? { ...e, observedVersion: '9:sha256:b1' } : e)) };
  const r = await g.validate(forged, { tool: 'env.deploy', resources: [], mutating: true }, eventCtx('run_forged'));
  assert.deepEqual(r.fresh ? [] : r.stale.map((s) => [s.resourceType, s.observedVersion, s.reason]), [['environment', '3:sha256:b1', 'version_changed']]);
  // A hand-made object that was never stored fails closed.
  const handMade = { ...forged, snapshotId: 'cs_handmade' };
  const r2 = await g.validate(handMade, { tool: 'env.deploy', resources: [], mutating: true }, eventCtx('run_forged'));
  assert.deepEqual(r2.fresh ? [] : r2.stale, [{ resourceType: 'context_snapshot', resourceId: 'cs_handmade', observedVersion: 'cs_handmade', reason: 'missing' }]);
});

test('a mutating action on an unknown snapshot id fails closed (missing context_snapshot)', async () => {
  const g = world().guard();
  const r = await g.validate('cs_does_not_exist', { tool: 'env.restart', resources: [], mutating: true }, eventCtx('run_unknown'));
  assert.deepEqual(r, { fresh: false, checked: 0, stale: [{ resourceType: 'context_snapshot', resourceId: 'cs_does_not_exist', observedVersion: 'cs_does_not_exist', reason: 'missing' }] });
  assert.equal(sink.ofType('context.stale_rejected').at(-1)!.runId, 'run_unknown');
});

test('max_age entries expire by the clock (boundary inclusive), independent of resolvers', async () => {
  const w = world();
  const g = w.guard([]);
  const observedAt = env.deps.clock.isoNow();
  const snap = await snapshot('run_age', [entry('metric_window', 'p95', 'w1', { kind: 'max_age', milliseconds: 30_000 }, observedAt)]);
  const act = { tool: 'load.start', resources: ['p95'], mutating: true };
  env.deps.clock.advance(30_000);
  assert.deepEqual(await g.validate(snap, act, eventCtx('run_age')), { fresh: true, checked: 1 });
  env.deps.clock.advance(1);
  assert.deepEqual(await g.validate(snap, act, eventCtx('run_age')), { fresh: false, checked: 1, stale: [{ resourceType: 'metric_window', resourceId: 'p95', observedVersion: 'w1', reason: 'expired' }] });
  assert.equal(w.calls(), 0);
});

test('a type that must be checked but has no resolver fails closed with no_resolver', async () => {
  const w = world();
  const g = w.guard([environmentResolver((id) => w.envs.get(id))]); // no oracle resolver
  const snap = await snapshot('run_nores', readSet());
  const r = await g.validate(snap, { tool: 'fs.write', resources: [], mutating: true }, eventCtx('run_nores'));
  assert.deepEqual(r, { fresh: false, checked: 2, stale: [{ resourceType: 'oracle', resourceId: 'or-1', observedVersion: '2', reason: 'no_resolver' }] });
  // Registering the resolver on the guard's registry fixes it.
  g.resolvers.register(oracleResolver((id) => (w.oracles.has(id) ? { revision: w.oracles.get(id)! } : undefined)));
  assert.deepEqual(await g.validate(snap, { tool: 'fs.write', resources: [], mutating: true }, eventCtx('run_nores')), { fresh: true, checked: 2 });
  // Default guard (no registry given) is empty ⇒ every exact check fails closed.
  const bare = createFreshnessGuard({ ...env.deps, snapshots: store });
  const r2 = await bare.validate(snap, { tool: 'fs.write', resources: [], mutating: true }, eventCtx('run_nores'));
  assert.equal(r2.fresh, false);
  assert.deepEqual(r2.fresh ? [] : r2.stale.map((s) => s.reason), ['no_resolver', 'no_resolver']);
});

test('resource-specific entries are only checked when named by action.resources; immutable entries never', async () => {
  const w = world();
  const g = w.guard();
  const snap = await snapshot('run_res', readSet());
  w.files.set('src/a.ts', 'v2');
  const ctx = eventCtx('run_res');
  // Not named ⇒ the changed file does not block an unrelated mutation.
  assert.deepEqual(await g.validate(snap, { tool: 'fs.write', resources: ['src/b.ts'], mutating: true }, ctx), { fresh: true, checked: 2 });
  const stale = [{ resourceType: 'file', resourceId: 'src/a.ts', observedVersion: 'v1', currentVersion: 'v2', reason: 'version_changed' }];
  for (const resource of ['src/a.ts', 'file:src/a.ts', 'src']) {
    assert.deepEqual(await g.validate(snap, { tool: 'fs.write', resources: [resource], mutating: true }, ctx), { fresh: false, checked: 3, stale }, resource);
  }
  // The immutable commit entry is never checked, even when named (no resolver for `commit` is needed).
  assert.deepEqual(await g.validate(snap, { tool: 'git.commit', resources: ['abc123'], mutating: true }, ctx), { fresh: true, checked: 2 });
  // Deleted resource ⇒ missing; throwing resolver ⇒ resolver_error (fail closed).
  w.files.delete('src/a.ts');
  const r = await g.validate(snap, { tool: 'fs.write', resources: ['src/a.ts'], mutating: true }, ctx);
  assert.deepEqual(r.fresh ? [] : r.stale, [{ resourceType: 'file', resourceId: 'src/a.ts', observedVersion: 'v1', reason: 'missing' }]);
  const broken = w.guard([
    environmentResolver((id) => w.envs.get(id)),
    functionResolver('oracle', () => {
      throw new Error('spec store down');
    }),
  ]);
  const r3 = await broken.validate(snap, { tool: 'fs.write', resources: [], mutating: true }, ctx);
  assert.deepEqual(r3.fresh ? [] : r3.stale, [{ resourceType: 'oracle', resourceId: 'or-1', observedVersion: '2', reason: 'resolver_error', error: 'spec store down' }]);
});

test('built-in resolvers over real ports: oracle revision, superseded finding, lease owner, file content', async () => {
  const runId = 'run_builtin';
  const ctx = eventCtx(runId);
  const events = createEventStore(env.deps);
  const board = createBlackboard({ ...env.deps, events });
  const specs = createSpecRepository({ ...env.deps, events });
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'src'));
    await writeFile(join(dir.path, 'src', 'a.ts'), 'export const a = 1;\n');
    const outside = await tempDir();
    await writeFile(join(outside.path, 'secret.txt'), 'x');
    await symlink(join(outside.path, 'secret.txt'), join(dir.path, 'escape.txt'));

    const oracleSpec = {
      oracleId: 'or-builtin', scope: { components: ['c'], description: 'd' }, assertions: [], authorities: [],
      judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
      changePolicy: { agentMayPropose: true, selfApprove: false as const, invalidatesPriorDecisions: true, approvers: ['human' as const] },
      status: 'approved' as const,
      approvedBy: [{ kind: 'human' as const, id: 'alice' }],
    };
    const oracle = await specs.saveOracle(oracleSpec, ctx);
    const finding = await board.postRecord({ runId, recordType: 'finding', createdBy: 'agent-x', payload: { title: 't', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp' } }, ctx);
    let lease: { owner: string; fencingToken: number } | undefined = { owner: 'worker-a', fencingToken: 7 };

    const g = createFreshnessGuard({
      ...env.deps,
      snapshots: store,
      resolvers: createResolverRegistry([
        oracleResolver((id) => specs.getOracle(id)),
        recordResolver((id) => board.head(id), { resourceType: 'finding' }),
        leaseResolver(async () => lease),
        fileResolver(dir.path),
      ]),
    });
    const snap = await snapshot(runId, [
      entry('oracle', 'or-builtin', String(oracle.revision)),
      entry('finding', finding.lineageId, finding.recordId),
      entry('lease', 'env/checkout', 'worker-a:7'),
      entry('file', 'src/a.ts', sha256Hex('export const a = 1;\n')),
    ]);
    const all = { tool: 'env.inject_fault', resources: [finding.lineageId, 'src/a.ts'], mutating: true };
    assert.deepEqual(await g.validate(snap, all, ctx), { fresh: true, checked: 4 });

    await specs.saveOracle({ ...oracleSpec, scope: { components: ['c'], description: 'revised' } }, ctx);
    await board.postRecord({ runId, recordType: 'finding', createdBy: 'agent-y', supersedes: finding.recordId, payload: { title: 't', description: 'd', severity: 'P1', category: 'product_defect', status: 'rejected', fingerprint: 'fp' } }, ctx);
    lease = { owner: 'worker-b', fencingToken: 8 };
    await writeFile(join(dir.path, 'src', 'a.ts'), 'export const a = 2;\n');
    const r = await g.validate(snap, all, ctx);
    assert.equal(r.fresh, false);
    const stale = r.fresh ? [] : r.stale;
    assert.deepEqual(stale.map((s) => [s.resourceType, s.reason]), [['file', 'version_changed'], ['finding', 'version_changed'], ['lease', 'version_changed'], ['oracle', 'version_changed']]);
    assert.equal(stale.find((s) => s.resourceType === 'oracle')!.currentVersion, String(oracle.revision + 1));
    assert.equal(stale.find((s) => s.resourceType === 'lease')!.currentVersion, 'worker-b:8');
    assert.equal(stale.find((s) => s.resourceType === 'file')!.currentVersion, sha256Hex('export const a = 2;\n'));

    // fileResolver root confinement: `..`, absolute paths and symlink escapes are refused, missing files are undefined.
    const fr = fileResolver(dir.path);
    await rejectsWith(fr.currentVersion('../etc/passwd'), 'invalid_argument');
    await rejectsWith(fr.currentVersion('/etc/passwd'), 'invalid_argument');
    await rejectsWith(fr.currentVersion('escape.txt'), 'permission_denied');
    assert.equal(await fr.currentVersion('src/missing.ts'), undefined);
    assert.equal(await fr.currentVersion('src'), undefined, 'a directory has no content version');
    await outside.cleanup();
  } finally {
    await dir.cleanup();
  }
});

test('registry rejects malformed resolvers and replaces by type', () => {
  const reg = createResolverRegistry();
  assert.throws(() => reg.register({ resourceType: '', currentVersion: async () => 'x' }), /resourceType/);
  reg.register(functionResolver('x', () => '1'));
  reg.register(functionResolver('x', () => '2'));
  assert.deepEqual(reg.types(), ['x']);
});

test('a malformed action is invalid_argument — never mistaken for a read-only action (fail closed)', async () => {
  const w = world();
  const g = w.guard();
  const snap = await snapshot('run_malformed', readSet());
  w.envs.set('env-1', { generation: 99 });
  const ctx = eventCtx('run_malformed');
  // `mutating` missing / not a boolean would otherwise read as "read-only" and skip every check.
  await rejectsWith(g.validate(snap, { tool: 'env.deploy', resources: [] } as never, ctx), 'invalid_argument');
  await rejectsWith(g.validate(snap, { tool: 'env.deploy', resources: [], mutating: 'yes' } as never, ctx), 'invalid_argument');
  await rejectsWith(g.validate(snap, { tool: 'env.deploy', resources: 'env-1', mutating: true } as never, ctx), 'invalid_argument');
  await rejectsWith(g.validate(snap, { tool: '', resources: [], mutating: true }, ctx), 'invalid_argument');
  await rejectsWith(g.validate(null as never, { tool: 'env.deploy', resources: [], mutating: true }, ctx), 'invalid_argument');
  // The well-formed mutating action is rejected as stale.
  const r = await g.validate(snap, { tool: 'env.deploy', resources: [], mutating: true }, ctx);
  assert.deepEqual(r.fresh ? [] : r.stale.map((s) => [s.resourceType, s.reason]), [['environment', 'version_changed']]);
});

test("the snapshot's pinned environment / oracle / experiment versions are re-validated even without read-set entries", async () => {
  const runId = 'run_pinned';
  const ctx = eventCtx(runId);
  const envs = new Map([['env-9', { generation: 1, buildDigest: 'sha256:x' }]]);
  const oracles = new Map([['or-9', 4]]);
  const experiments = new Map([['exp-9', 2]]);
  const resolvers = [
    environmentResolver((id) => envs.get(id)),
    oracleResolver((id) => (oracles.has(id) ? { revision: oracles.get(id)! } : undefined)),
    experimentResolver((id) => (experiments.has(id) ? { revision: experiments.get(id)! } : undefined)),
  ];
  const g = createFreshnessGuard({ ...env.deps, events: sink, snapshots: store, resolvers: createResolverRegistry(resolvers) });
  // Created directly through the store (not the builder): the read set does not mention the pinned versions.
  const snap = await store.create(
    { runId, eventSeq: 1, blackboardRevision: 1, planRevision: 1, runtimeManifestId: 'rm_1', oracleRevisions: { 'or-9': 4 }, experimentRevisions: { 'exp-9': 2 }, policyRevision: 'p', evidenceRootHash: 'r', environment: { environmentId: 'env-9', generation: 1, buildDigest: 'sha256:x' }, readSet: [] },
    ctx,
  );
  const act = { tool: 'load.start', resources: [], mutating: true };
  assert.deepEqual(await g.validate(snap, act, ctx), { fresh: true, checked: 3 });

  envs.set('env-9', { generation: 2, buildDigest: 'sha256:x' });
  oracles.set('or-9', 5);
  experiments.set('exp-9', 3);
  const r = await g.validate(snap.snapshotId, act, ctx);
  assert.deepEqual(r, {
    fresh: false,
    checked: 3,
    stale: [
      { resourceType: 'environment', resourceId: 'env-9', observedVersion: '1:sha256:x', currentVersion: '2:sha256:x', reason: 'version_changed' },
      { resourceType: 'experiment', resourceId: 'exp-9', observedVersion: '2', currentVersion: '3', reason: 'version_changed' },
      { resourceType: 'oracle', resourceId: 'or-9', observedVersion: '4', currentVersion: '5', reason: 'version_changed' },
    ],
  });
  // No experiment resolver registered ⇒ the pinned experiment revision fails closed.
  const partial = createFreshnessGuard({ ...env.deps, snapshots: store, resolvers: createResolverRegistry(resolvers.slice(0, 2)) });
  envs.set('env-9', { generation: 1, buildDigest: 'sha256:x' });
  oracles.set('or-9', 4);
  const r2 = await partial.validate(snap, act, ctx);
  assert.deepEqual(r2.fresh ? [] : r2.stale, [{ resourceType: 'experiment', resourceId: 'exp-9', observedVersion: '2', reason: 'no_resolver' }]);

  // A read-set entry that disagrees with the pinned field does not shadow it: both are checked, one is stale.
  const inconsistent = await store.create(
    { runId, eventSeq: 2, blackboardRevision: 1, planRevision: 1, runtimeManifestId: 'rm_1', oracleRevisions: { 'or-9': 3 }, experimentRevisions: {}, policyRevision: 'p', evidenceRootHash: 'r', readSet: [entry('oracle', 'or-9', '4')] },
    ctx,
  );
  const r3 = await g.validate(inconsistent, act, ctx);
  assert.deepEqual(r3, { fresh: false, checked: 2, stale: [{ resourceType: 'oracle', resourceId: 'or-9', observedVersion: '3', currentVersion: '4', reason: 'version_changed' }] });
});

test('typed action resources also match hierarchically (file:src names file src/a.ts), other types never', async () => {
  const w = world();
  const g = w.guard();
  const snap = await snapshot('run_typed', readSet());
  w.files.set('src/a.ts', 'v2');
  const ctx = eventCtx('run_typed');
  for (const resource of ['file:src', 'file:src/a.ts', 'file:src/a.ts/x']) {
    const r = await g.validate(snap, { tool: 'fs.write', resources: [resource], mutating: true }, ctx);
    assert.deepEqual(r.fresh ? [] : r.stale.map((s) => `${s.resourceType}:${s.resourceId}`), ['file:src/a.ts'], resource);
  }
  for (const resource of ['file:', 'oracle:src', 'file:sr', 'files:src']) {
    assert.deepEqual(await g.validate(snap, { tool: 'fs.write', resources: [resource], mutating: true }, ctx), { fresh: true, checked: 2 }, resource);
  }
});
