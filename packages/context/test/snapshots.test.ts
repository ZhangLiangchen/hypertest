import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canonicalJson, sha256Hex } from '@hypertest/core';
import { collabMigrations, createBlackboard, createEventStore, createRunRepository, createSpecRepository, type EventStore } from '@hypertest/collab';
import { DEFAULT_BUDGET, type DomainEventInput, type DomainEventSink, type TestRun } from '@hypertest/domain';
import { MemoryArtifactStore, createEvidenceLedger, evidenceMigrations } from '@hypertest/evidence';
import { eventCtx } from '@hypertest/testkit';
import { contextMigrations, createResolverRegistry, createSnapshotBuilder, createSnapshotStore, snapshotIdFor, type SnapshotContent, type SnapshotSources, type SnapshotStore } from '../src/index.ts';
import { entry, openDb, rejectsWith, type Db } from './helpers.ts';

let env: Db;
let events: EventStore;
let store: SnapshotStore;

before(async () => {
  env = await openDb([...collabMigrations, ...evidenceMigrations, ...contextMigrations]);
  events = createEventStore(env.deps);
  store = createSnapshotStore({ ...env.deps, events });
});
after(async () => {
  await env.dispose();
});

function content(runId: string, overrides: Partial<SnapshotContent> = {}): SnapshotContent {
  return {
    runId,
    eventSeq: 7,
    blackboardRevision: 3,
    planRevision: 1,
    runtimeManifestId: 'rm_1',
    oracleRevisions: { 'or-a': 1, 'or-b': 2 },
    experimentRevisions: {},
    policyRevision: 'pol_1',
    evidenceRootHash: 'root-1',
    readSet: [entry('file', 'src/a.ts', 'sha-a', { kind: 'immutable' })],
    ...overrides,
  };
}

async function count(sql: string, params: string[]): Promise<number> {
  const r = await env.db.query<{ n: unknown }>(sql, params);
  return Number(r.rows[0]!.n);
}

test('create: the id is the content address cs_ + sha256(canonical content)[0..40]', async () => {
  const c = content('run_addr');
  const snap = await store.create(c, eventCtx('run_addr'));
  const expected = 'cs_' + sha256Hex(canonicalJson(c)).slice(0, 40);
  assert.equal(snap.snapshotId, expected);
  assert.equal(snapshotIdFor(c), expected);
  assert.equal(snap.snapshotId.length, 43);
  assert.equal(snap.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual({ ...snap, snapshotId: undefined, createdAt: undefined }, { ...c, snapshotId: undefined, createdAt: undefined });
});

test('create is idempotent: identical content ⇒ same id, stored createdAt, one row, one event', async () => {
  const runId = 'run_idem';
  const first = await store.create(content(runId), eventCtx(runId));
  env.deps.clock.advance(60_000);
  // Same content with a different key order and an explicit snapshotId/createdAt (ignored).
  const reordered = { ...content(runId), oracleRevisions: { 'or-b': 2, 'or-a': 1 }, snapshotId: 'cs_forged', createdAt: '1999-01-01T00:00:00.000Z' } as SnapshotContent;
  const second = await store.create(reordered, eventCtx(runId));
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.createdAt, first.createdAt, 'the stored snapshot is returned, not a new one');
  assert.equal(await count('SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1', [runId]), 1);
  const created = await events.read(runId, { types: ['context.snapshot_created'] });
  assert.equal(created.length, 1, 'context.snapshot_created only when newly inserted');
  assert.equal(created[0]!.aggregateType, 'context');
  assert.equal(created[0]!.aggregateId, first.snapshotId);
  assert.deepEqual(created[0]!.payload, { snapshotId: first.snapshotId, eventSeq: 7, blackboardRevision: 3, planRevision: 1, evidenceRootHash: 'root-1', readSetSize: 1 });
  // Different content ⇒ different id.
  const third = await store.create(content(runId, { eventSeq: 8 }), eventCtx(runId));
  assert.notEqual(third.snapshotId, first.snapshotId);
});

test('get / latest: latest is the most recently created snapshot (insertion order breaks time ties)', async () => {
  const runId = 'run_latest';
  assert.equal(await store.latest(runId), undefined);
  const a = await store.create(content(runId, { eventSeq: 1 }), eventCtx(runId));
  const b = await store.create(content(runId, { eventSeq: 2 }), eventCtx(runId)); // same clock millisecond
  assert.equal((await store.latest(runId))!.snapshotId, b.snapshotId);
  env.deps.clock.advance(1);
  const c = await store.create(content(runId, { eventSeq: 3 }), eventCtx(runId));
  assert.equal((await store.latest(runId))!.snapshotId, c.snapshotId);
  // Re-creating an older snapshot does not make it "latest".
  await store.create(content(runId, { eventSeq: 1 }), eventCtx(runId));
  assert.equal((await store.latest(runId))!.snapshotId, c.snapshotId);
  assert.deepEqual(await store.get(a.snapshotId), a);
  assert.equal(await store.get('cs_unknown'), undefined);
});

test('snapshots are immutable projections: frozen objects, and a row edited behind the store is integrity_violation', async () => {
  const runId = 'run_tamper';
  const snap = await store.create(content(runId), eventCtx(runId));
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.readSet) && Object.isFrozen(snap.readSet[0]));
  assert.throws(() => {
    (snap as { eventSeq: number }).eventSeq = 99;
  }, TypeError);
  await env.db.query(`UPDATE ht_context_snapshots SET content = jsonb_set(content, '{eventSeq}', '99'::jsonb) WHERE snapshot_id = $1`, [snap.snapshotId]);
  const err = await rejectsWith(store.get(snap.snapshotId), 'integrity_violation');
  assert.equal(err.details['snapshotId'], snap.snapshotId);
});

test('create rejects malformed content with invalid_argument and writes nothing', async () => {
  const runId = 'run_invalid';
  await rejectsWith(store.create(content(runId, { runId: '' }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(store.create(content(runId, { eventSeq: -1 }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(store.create(content(runId, { readSet: [{ ...entry('file', 'a', 'v'), freshness: { kind: 'forever' } as never }] }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(store.create(content(runId, { readSet: [entry('file', 'a', 'v', { kind: 'max_age', milliseconds: -5 })] }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(store.create(content(runId, { policyRevision: 'nul\u0000byte' }), eventCtx(runId)), 'invalid_argument');
  assert.equal(await count('SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1', [runId]), 0);
});

test('the snapshot row and its event are atomic: a failing event sink stores nothing', async () => {
  const runId = 'run_atomic';
  let fail = true;
  const sink: DomainEventSink = {
    async emit(evs: DomainEventInput<unknown>[], tx?: unknown) {
      if (fail) throw new Error('sink down (injected)');
      return events.append(evs, tx as never);
    },
  };
  const s = createSnapshotStore({ ...env.deps, events: sink });
  await assert.rejects(s.create(content(runId), eventCtx(runId)), /sink down/);
  assert.equal(await count('SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1', [runId]), 0);
  fail = false;
  const snap = await s.create(content(runId), eventCtx(runId));
  assert.equal((await events.read(runId, { types: ['context.snapshot_created'] })).length, 1);
  assert.equal((await s.get(snap.snapshotId))!.snapshotId, snap.snapshotId);
});

test('builder: reads canonical sources (collab + evidence) and always records oracle + environment read entries', async () => {
  const runId = 'run_builder';
  const ctx = eventCtx(runId);
  const runs = createRunRepository({ ...env.deps, events });
  const board = createBlackboard({ ...env.deps, events });
  const specs = createSpecRepository({ ...env.deps, events });
  const artifacts = new MemoryArtifactStore();
  const ledger = createEvidenceLedger({ ...env.deps, artifacts, events });
  const run: TestRun = {
    runId,
    goal: 'assess releasability',
    target: { repoPath: '/repo', commit: 'abc' },
    status: 'created',
    budget: DEFAULT_BUDGET,
    runtimeManifestId: 'rm_builder',
    policyRevision: 'pol_7',
    currentPlanRevision: 2,
    systemModelRevision: 4,
    oracleRevisions: { 'or-checkout': 3, 'or-auth': 1 },
    experimentIds: [],
    labels: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await runs.create(run, ctx);
  await board.postRecord({ runId, recordType: 'note', payload: { text: 'hello' }, createdBy: 'agent-a' }, ctx);
  const art = await artifacts.put('out', { mimeType: 'text/plain' });
  await ledger.append({ runId, evidenceType: 'stdout', artifact: art, summary: 's', producer: { workerId: 'w', runtimeManifestId: 'rm_builder' }, provenance: {} });

  const sources: SnapshotSources = {
    getRun: (id) => runs.get(id),
    lastEventSeq: (id) => events.lastSeq(id),
    blackboardRevision: (id) => board.revision(id),
    evidenceRoot: (id) => ledger.rootHash(id),
    experimentRevisions: async (id) => Object.fromEntries((await specs.listExperiments(id)).map((e) => [e.experimentId, e.revision])),
  };
  const builder = createSnapshotBuilder({ ...env.deps, events, snapshots: store, sources, resolvers: createResolverRegistry() });
  const callerEntry = entry('metric_window', 'p95_latency', 'w-10', { kind: 'max_age', milliseconds: 60_000 });
  const snap = await builder.build({ runId, modelEpochId: 'ep_1', environment: { environmentId: 'env-1', generation: 5, buildDigest: 'sha256:b1' }, readSet: [callerEntry, callerEntry] }, ctx);

  const lastSeqBefore = await events.lastSeq(runId);
  const root = await ledger.rootHash(runId);
  assert.equal(snap.runId, runId);
  assert.equal(snap.eventSeq, lastSeqBefore - 1, 'eventSeq is the L0 position observed before the snapshot event itself');
  assert.equal(snap.blackboardRevision, await board.revision(runId));
  assert.equal(snap.planRevision, 2);
  assert.equal(snap.runtimeManifestId, 'rm_builder');
  assert.equal(snap.policyRevision, 'pol_7');
  assert.equal(snap.systemModelRevision, 4);
  assert.equal(snap.modelEpochId, 'ep_1');
  assert.equal(snap.evidenceRootHash, root.rootHash);
  assert.deepEqual(snap.oracleRevisions, { 'or-auth': 1, 'or-checkout': 3 });
  assert.deepEqual(snap.environment, { environmentId: 'env-1', generation: 5, buildDigest: 'sha256:b1' });
  assert.deepEqual(
    snap.readSet.map((e) => [e.resourceType, e.resourceId, e.observedVersion, e.freshness.kind]),
    [
      ['environment', 'env-1', '5:sha256:b1', 'exact_version'],
      ['metric_window', 'p95_latency', 'w-10', 'max_age'],
      ['oracle', 'or-auth', '1', 'exact_version'],
      ['oracle', 'or-checkout', '3', 'exact_version'],
    ],
    'sorted, de-duplicated, oracle + environment entries always present',
  );
  assert.equal(snap.readSet[0]!.observedAt, env.deps.clock.isoNow());
  assert.deepEqual(snap.readSet[1], callerEntry, 'caller entries are kept verbatim');

  // L0 advanced by the snapshot's own event: the next build observes eventSeq + 1 (a new projection).
  const again = await builder.build({ runId, modelEpochId: 'ep_1', environment: { environmentId: 'env-1', generation: 5, buildDigest: 'sha256:b1' }, readSet: [callerEntry] }, ctx);
  assert.equal(again.eventSeq, snap.eventSeq + 1);
  assert.notEqual(again.snapshotId, snap.snapshotId);

  await rejectsWith(builder.build({ runId: 'run_missing' }, eventCtx('run_missing')), 'not_found');
  await rejectsWith(builder.build({ runId, readSet: [{ ...callerEntry, observedAt: 'yesterday' }] }, ctx), 'invalid_argument');
});

test('concurrent creates of identical content converge on one row and one event', async () => {
  const runId = 'run_concurrent';
  const c = content(runId, { eventSeq: 42 });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.create(c, eventCtx(runId))));
  assert.equal(new Set(results.map((r) => r.snapshotId)).size, 1);
  assert.equal(new Set(results.map((r) => r.createdAt)).size, 1);
  assert.equal(await count('SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1', [runId]), 1);
  assert.equal((await events.read(runId, { types: ['context.snapshot_created'] })).length, 1);
});

test('content with a __proto__ key is stored and hashed as an own key (never silently dropped)', async () => {
  const runId = 'run_proto';
  const oracleRevisions = JSON.parse('{"__proto__": 3, "or-a": 1}') as Record<string, number>;
  const withProto = content(runId, { oracleRevisions });
  const plain = content(runId, { oracleRevisions: { 'or-a': 1 } });
  const snap = await store.create(withProto, eventCtx(runId));
  assert.notEqual(snap.snapshotId, snapshotIdFor(plain), 'the key takes part in the content address');
  assert.equal(snap.snapshotId, snapshotIdFor(withProto));
  assert.deepEqual(Object.keys(snap.oracleRevisions).sort(), ['__proto__', 'or-a']);
  const stored = await store.get(snap.snapshotId);
  assert.deepEqual(Object.keys(stored!.oracleRevisions).sort(), ['__proto__', 'or-a'], 'round-trips through jsonb and still matches its id');
});
