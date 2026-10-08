import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { sha256Hex } from '@hypertest/core';
import { InMemoryEventSink, type ContextSnapshot, type EventContext, type ReadSetEntry } from '@hypertest/domain';
import { eventCtx, tempDir } from '@hypertest/testkit';
import {
  ABSENT_VERSION,
  DEFAULT_METRIC_WINDOW_MS,
  UNVERIFIED_VERSION_PREFIX,
  planResourceId,
  contextMigrations,
  createFreshnessGuard,
  createObservationLog,
  createResolverRegistry,
  createSnapshotBuilder,
  createSnapshotStore,
  environmentResolver,
  metricWindowMs,
  observationsOf,
  observeToolRuntime,
  recordResolver,
  workspaceFileResolver,
  type FreshnessGuard,
  type ObservationLog,
  type ObservedEntry,
  type SnapshotStore,
} from '../src/index.ts';
import { entry, openDb, rejectsWith, type Db } from './helpers.ts';

/**
 * ReadSet from what agents OBSERVED (conformance: "P0 revision 2", "FreshnessGuard re-checks … metric window",
 * "mutation actions check the ReadSet"): tool results → observations → the next turn's snapshot → the FreshnessGuard,
 * which also sees the agent's own observations of the current turn.
 */
let env: Db;
let store: SnapshotStore;
let log: ObservationLog;
let ws: Awaited<ReturnType<typeof tempDir>>;
const WS = { workspaceId: 'ws_a', resourcePrefix: 'workspace/ws_a', root: '' };

before(async () => {
  env = await openDb(contextMigrations);
  store = createSnapshotStore(env.deps);
  log = createObservationLog(env.deps);
  ws = await tempDir('ht-obs-');
  WS.root = ws.path;
});
after(async () => {
  await ws.cleanup();
  await env.dispose();
});

async function put(rel: string, content: string): Promise<string> {
  const abs = join(ws.path, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return sha256Hex(content);
}

const fileId = (rel: string) => `workspace/ws_a/${rel}`;

/** A builder over a fixed run (no oracles, no environment) that joins the observer's observations. */
function builder(options: { observations?: ObservationLog; max?: number } = {}) {
  return createSnapshotBuilder({
    ...env.deps,
    snapshots: store,
    resolvers: createResolverRegistry(),
    ...(options.observations ? { observations: options.observations } : {}),
    ...(options.max !== undefined ? { maxObservedEntries: options.max } : {}),
    sources: {
      getRun: async () => ({ runtimeManifestId: 'rm_1', policyRevision: 'p1', currentPlanRevision: 1, oracleRevisions: {} }),
      lastEventSeq: async () => 1,
      blackboardRevision: async () => 1,
      evidenceRoot: async () => ({ rootHash: 'root' }),
      experimentRevisions: async () => ({}),
    },
  });
}

function guard(options: { observations?: ObservationLog | undefined; envs?: Map<string, { generation: number }> } = {}): FreshnessGuard {
  const resolvers = createResolverRegistry([
    workspaceFileResolver((id) => (id === WS.workspaceId ? WS.root : undefined)),
    recordResolver(() => undefined),
    environmentResolver((id) => options.envs?.get(id)),
  ]);
  const observations = 'observations' in options ? options.observations : log;
  return createFreshnessGuard({ ...env.deps, events: new InMemoryEventSink(), snapshots: store, resolvers, ...(observations ? { observations } : {}) });
}

const ctxOf = (runId: string, agentId: string): EventContext => eventCtx(runId, { agentId });

async function observe(runId: string, agentId: string, toolId: string, input: Record<string, unknown>, structured: unknown, snapshot?: ContextSnapshot, invocationId = `inv_${toolId}`): Promise<ObservedEntry[]> {
  const call = { toolId, input, runId, agentId, workItemId: 'wi_1', invocationId, workspace: WS, ...(snapshot ? { snapshot } : {}) };
  const entries = await observationsOf(call, { status: 'success', structured }, { now: () => env.deps.clock.isoNow() });
  await log.record({ runId, agentId, workItemId: 'wi_1', toolId, invocationId, ...(snapshot ? { snapshotId: snapshot.snapshotId } : {}) }, entries);
  return entries;
}

test('observationsOf: tool results become read-set entries (files, records, metric windows, environments); failures observe nothing', async () => {
  const sha = await put('src/a.ts', 'export const a = 1;\n');
  const call = (toolId: string, input: Record<string, unknown>) => ({ toolId, input, runId: 'run_map', agentId: 'ag_1', invocationId: 'i', workspace: WS });
  const now = () => '2026-01-01T00:00:00.000Z';
  const ok = (structured: unknown) => ({ status: 'success', structured });
  assert.deepEqual(await observationsOf(call('fs.read', { path: './src/a.ts' }), ok({ path: 'src/a.ts', sha256: sha }), { now }), [
    { kind: 'read', resourceType: 'file', resourceId: fileId('src/a.ts'), observedVersion: sha, observedAt: now(), freshness: { kind: 'exact_version' } },
  ]);
  // git.show pins the working-tree version only when the content it showed (whole) IS the current file; a committed
  // version that differs, output that did not reach the model whole, or a path the tree no longer has claim nothing
  const shownA = 'export const a = 1;\n';
  const show = (path: string, text: string | undefined, bytes: number) => observationsOf(call('git.show', { rev: 'HEAD~1', path }), { status: 'success', structured: { rev: 'HEAD~1', path, bytes }, ...(text !== undefined ? { modelText: text } : {}) }, { now });
  assert.deepEqual((await show('src/a.ts', shownA, Buffer.byteLength(shownA))).map((e) => [e.kind, e.resourceId, e.observedVersion]), [['read', fileId('src/a.ts'), sha]]);
  assert.deepEqual(await show('src/a.ts', 'export const a = 0;\n', 20), [], 'another version than the working tree');
  assert.deepEqual(await show('src/a.ts', shownA.slice(0, 10), Buffer.byteLength(shownA)), [], 'truncated');
  assert.deepEqual(await show('src/a.ts', undefined, Buffer.byteLength(shownA)), [], 'no model text');
  assert.deepEqual(await show('gone.ts', 'x', 1), [], 'not in the working tree');
  // own writes
  assert.deepEqual((await observationsOf(call('fs.write', { path: 'src/b.ts', content: 'b' }), ok({ path: 'src/b.ts', sha256: sha256Hex('b'), bytes: 1, created: true }), { now })).map((e) => [e.kind, e.resourceId, e.observedVersion]), [['write', fileId('src/b.ts'), sha256Hex('b')]]);
  const patched = await observationsOf(call('fs.apply_patch', { patch: '…' }), ok({ files: ['src/a.ts', 'src/deleted.ts'], applied: true }), { now });
  assert.deepEqual(patched.map((e) => [e.kind, e.resourceId, e.observedVersion]), [['write', fileId('src/a.ts'), sha], ['write', fileId('src/deleted.ts'), ABSENT_VERSION]]);
  assert.deepEqual(await observationsOf(call('fs.apply_patch', { patch: '…', check: true }), ok({ files: ['src/a.ts'], applied: false }), { now }), [], 'a check-only patch changes nothing');
  // records: read (findings are pinned as `finding`, always re-checked) and posted (own write of the new head)
  const read = await observationsOf(call('blackboard.read', { recordType: 'finding' }), ok({ records: [{ recordId: 'rec_2', lineageId: 'rec_1', recordType: 'finding' }, { recordId: 'rec_9', lineageId: 'rec_9', recordType: 'risk' }] }), { now });
  assert.deepEqual(read.map((e) => [e.kind, e.resourceType, e.resourceId, e.observedVersion]), [['read', 'finding', 'rec_1', 'rec_2'], ['read', 'record', 'rec_9', 'rec_9']]);
  const posted = await observationsOf(call('blackboard.post_finding', { title: 't' }), ok({ recordId: 'rec_3', lineageId: 'rec_1', version: 3 }), { now });
  // (B[2]) a posted finding also records its own withdrawal state (`active`; `withdrawn:<status>` when it rejects one)
  assert.deepEqual(posted.map((e) => [e.kind, e.resourceType, e.resourceId, e.observedVersion]), [['write', 'finding', 'rec_1', 'rec_3'], ['write', 'finding_withdrawal', 'rec_1', 'active']]);
  const rejecting = await observationsOf(call('blackboard.post_finding', { title: 't', status: 'rejected', updatesRecordId: 'rec_3' }), ok({ recordId: 'rec_4', lineageId: 'rec_1', version: 4 }), { now });
  assert.deepEqual(rejecting.map((e) => [e.resourceType, e.observedVersion]), [['finding', 'rec_4'], ['finding_withdrawal', 'withdrawn:rejected']]);
  // a finding read IN FULL refreshes its withdrawal state too
  const readFull = await observationsOf(call('blackboard.read', { lineageId: 'rec_1' }), ok({ records: [{ recordId: 'rec_4', lineageId: 'rec_1', recordType: 'finding', payload: { status: 'duplicate' } }] }), { now });
  assert.deepEqual(readFull.map((e) => [e.resourceType, e.observedVersion]), [['finding', 'rec_4'], ['finding_withdrawal', 'withdrawn:duplicate']]);
  assert.deepEqual((await observationsOf(call('blackboard.post_note', { text: 'n' }), ok({ recordId: 'rec_5', lineageId: 'rec_5' }), { now })).map((e) => e.resourceType), ['record']);
  // metric windows: max_age from the query window, one window per queried target (the latest metric data of it)
  const range = await observationsOf(call('metrics.query', { environmentId: 'kv', query: 'up', range: { start: 1_700_000_000, end: 1_700_000_600, step: 15 } }), ok({ evidenceId: 'ev_m1', series: [] }), { now });
  assert.equal(range.length, 1);
  assert.equal(range[0]!.resourceType, 'metric_window');
  assert.equal(range[0]!.resourceId, 'env/kv/metrics');
  assert.deepEqual([range[0]!.observedVersion, range[0]!.freshness], ['ev_m1', { kind: 'max_age', milliseconds: 600_000 }]);
  const scrape = await observationsOf(call('metrics.scrape', { url: 'http://Prom.Example:9090/metrics' }), { status: 'success', structured: {}, evidenceRefs: ['ev_s1'] }, { now });
  assert.equal(scrape[0]!.resourceId, 'url/prom.example:9090/metrics');
  assert.deepEqual(scrape[0]!.freshness, { kind: 'max_age', milliseconds: DEFAULT_METRIC_WINDOW_MS });
  assert.equal(metricWindowMs({ range: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:30:00Z', step: '15s' } }), 1_800_000);
  assert.equal(metricWindowMs({ range: { start: 'yesterday', end: 'now', step: 1 } }), DEFAULT_METRIC_WINDOW_MS, 'an unparsable window falls back to the default');
  assert.equal(metricWindowMs({ range: { start: 10, end: 20, step: 1 } }), DEFAULT_METRIC_WINDOW_MS, 'at least the default window');
  // environments: any call addressing one observes its generation/build; env.* tools are own writes
  const envVersion = (id: string) => (id === 'kv' ? '4:sha256:b' : undefined);
  assert.deepEqual((await observationsOf(call('http.request', { method: 'GET', environmentId: 'kv', path: '/' }), ok({}), { now, environmentVersion: envVersion })).map((e) => [e.kind, e.resourceType, e.resourceId, e.observedVersion]), [['read', 'environment', 'kv', '4:sha256:b']]);
  assert.deepEqual((await observationsOf(call('env.restart', { environmentId: 'kv' }), ok({}), { now, environmentVersion: envVersion })).map((e) => e.kind), ['write']);
  assert.deepEqual(await observationsOf(call('http.request', { method: 'GET', environmentId: 'other', path: '/' }), ok({}), { now, environmentVersion: envVersion }), [], 'an unknown environment cannot be versioned');
  // nothing is observed by a failed, denied, stale or pending call, nor by tools that observe no versioned resource
  for (const status of ['failed', 'denied', 'stale_context', 'pending', 'timeout']) {
    assert.deepEqual(await observationsOf(call('fs.read', { path: 'src/a.ts' }), { status, structured: { path: 'src/a.ts', sha256: sha } }, { now }), [], status);
  }
  assert.deepEqual(await observationsOf(call('test.run', {}), ok({ passed: true }), { now }), []);
});

test('(B[0]) every read the agent observes is pinned: search / symbol / reference hits and blame lines (content-verified), working-tree diffs (current version), evidence, the plan and oracles', async () => {
  const content = 'export function total(cents) {\n  return cents * 2;\n}\n';
  const sha = await put('src/total.ts', content);
  const call = (toolId: string, input: Record<string, unknown>) => ({ toolId, input, runId: 'run_more', agentId: 'ag_1', invocationId: `inv_${toolId}`, workspace: WS });
  const now = () => '2026-01-01T00:00:00.000Z';
  const ok = (structured: unknown) => ({ status: 'success', structured });
  const pins = (entries: ObservedEntry[]) => entries.map((e) => [e.resourceType, e.resourceId, e.observedVersion]);
  // fs.search: the shown lines still read the same ⇒ the file at its current sha; a line that no longer matches ⇒ UNVERIFIED
  assert.deepEqual(pins(await observationsOf(call('fs.search', { pattern: 'cents' }), ok({ matches: [{ path: 'src/total.ts', line: 1, text: 'export function total(cents) {' }, { path: 'src/total.ts', line: 2, text: '  return cents * 2;' }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  assert.deepEqual(pins(await observationsOf(call('fs.search', { pattern: 'cents' }), ok({ matches: [{ path: 'src/total.ts', line: 2, text: '  return cents * 3;' }] }), { now })), [['file', fileId('src/total.ts'), `${UNVERIFIED_VERSION_PREFIX}inv_fs.search`]]);
  assert.deepEqual(pins(await observationsOf(call('fs.search', { pattern: 'x' }), ok({ matches: [{ path: 'gone.ts', line: 1, text: 'x' }] }), { now })), [['file', fileId('gone.ts'), `${UNVERIFIED_VERSION_PREFIX}inv_fs.search`]], 'a hit in a file that is gone is unverified');
  // code.symbols (retrieval snippet or regex definition name) and code.references
  assert.deepEqual(pins(await observationsOf(call('code.symbols', { query: 'total' }), ok({ engine: 'retrieval', symbols: [{ path: 'src/total.ts', line: 1, snippet: 'export function total(cents) {', score: 1 }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  assert.deepEqual(pins(await observationsOf(call('code.symbols', { query: 'total' }), ok({ engine: 'regex', symbols: [{ name: 'total', kind: 'function', path: 'src/total.ts', line: 1 }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  assert.deepEqual(pins(await observationsOf(call('code.references', { symbol: 'cents' }), ok({ engine: 'regex', references: [{ path: 'src/total.ts', line: 2, text: 'return cents * 2;', isDefinition: false }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  // (B[6]) a symbol-graph row shows its line behind a `⟦usage in Owner.method⟧ ` annotation: the line itself is verified
  assert.deepEqual(pins(await observationsOf(call('code.references', { symbol: 'cents' }), ok({ engine: 'retrieval', references: [{ path: 'src/total.ts', line: 2, text: '⟦read in total⟧ return cents * 2;', score: 0.5 }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  assert.deepEqual(await observationsOf(call('code.references', { symbol: 'cents' }), ok({ engine: 'retrieval', references: [{ path: 'src/total.ts', line: 2, text: '⟦read in total⟧ return cents * 5;', score: 0.5 }] }), { now }), []);
  // a hit of an index that lags the working tree pins nothing (it never overrides what the agent knows, e.g. its own write)
  assert.deepEqual(await observationsOf(call('code.references', { symbol: 'cents' }), ok({ engine: 'retrieval', references: [{ path: 'src/total.ts', line: 2, text: 'return cents * 7;', score: 1 }] }), { now }), []);
  // git.blame: current lines pin the file; a blame at another revision whose lines differ claims nothing
  assert.deepEqual(pins(await observationsOf(call('git.blame', { path: 'src/total.ts', startLine: 2, endLine: 2 }), ok({ path: 'src/total.ts', lines: [{ line: 2, commit: 'c', author: 'a', date: 'd', summary: 's', content: '  return cents * 2;' }] }), { now })), [['file', fileId('src/total.ts'), sha]]);
  assert.deepEqual(await observationsOf(call('git.blame', { path: 'src/total.ts', startLine: 2, endLine: 2, rev: 'HEAD~3' }), ok({ path: 'src/total.ts', lines: [{ line: 2, commit: 'c', author: 'a', date: 'd', summary: 's', content: '  return cents;' }] }), { now }), []);
  // git.diff of the working tree shows the current changes: its files are pinned at their current version (gone ⇒ absent);
  // a diff between revisions is history
  assert.deepEqual(pins(await observationsOf(call('git.diff', {}), ok({ files: ['src/total.ts', 'src/gone.ts'], bytes: 10 }), { now })), [['file', fileId('src/total.ts'), sha], ['file', fileId('src/gone.ts'), ABSENT_VERSION]]);
  assert.deepEqual(await observationsOf(call('git.diff', { base: 'HEAD~1' }), ok({ files: ['src/total.ts'], bytes: 10 }), { now }), []);
  // evidence reads: immutable pins
  const ev = await observationsOf(call('evidence.query', {}), ok({ evidence: [{ evidenceId: 'ev_1' }, { evidenceId: 'ev_2' }], count: 2 }), { now });
  assert.deepEqual(ev.map((e) => [e.resourceType, e.resourceId, e.freshness.kind]), [['evidence', 'ev_1', 'immutable'], ['evidence', 'ev_2', 'immutable']]);
  assert.deepEqual(pins(await observationsOf(call('evidence.get', { evidenceId: 'ev_1' }), ok({ evidenceId: 'ev_1' }), { now })), [['evidence', 'ev_1', 'ev_1']]);
  // plan: the latest accepted revision read (a compare-and-set for plan.propose_revision), own write of an accepted revision
  assert.deepEqual(pins(await observationsOf(call('plan.read', {}), ok({ plan: { revision: 2 }, revisions: [{ revision: 1, status: 'superseded' }, { revision: 2, status: 'accepted' }, { revision: 3, status: 'rejected' }] }), { now })), [['plan', planResourceId('run_more'), '2']]);
  assert.deepEqual(pins(await observationsOf(call('plan.read', {}), ok({ plan: null, revisions: [] }), { now })), [['plan', planResourceId('run_more'), '0']]);
  assert.deepEqual(await observationsOf(call('plan.read', { revision: 1 }), ok({ plan: { revision: 1 }, revisions: [{ revision: 1, status: 'superseded' }, { revision: 2, status: 'accepted' }] }), { now }), [], 'an old revision claims nothing');
  assert.deepEqual(pins(await observationsOf(call('plan.propose_revision', {}), ok({ accepted: true, revision: 3 }), { now })), [['plan', planResourceId('run_more'), '3']]);
  assert.deepEqual(await observationsOf(call('plan.propose_revision', {}), ok({ accepted: false, revision: 3 }), { now }), []);
  // an experiment this agent defined (own write of its revision)
  assert.deepEqual(pins(await observationsOf(call('experiment.define', { hypothesis: 'h' }), ok({ experimentId: 'exp_1', revision: 2 }), { now })), [['experiment', 'exp_1', '2']]);
  // oracles
  assert.deepEqual(pins(await observationsOf(call('oracle.get', { oracleId: 'or_1' }), ok({ oracle: { oracleId: 'or_1', revision: 4 } }), { now })), [['oracle', 'or_1', '4']]);
  // (review) an explicitly requested revision the run does not use is history: pinning it (oracle is always re-checked) would
  // refuse every later action of the agent for good; the run's own revision read explicitly is pinned
  assert.deepEqual(await observationsOf(call('oracle.get', { oracleId: 'or_1', revision: 2 }), ok({ oracle: { oracleId: 'or_1', revision: 2 }, pinnedByRun: false }), { now }), []);
  assert.deepEqual(pins(await observationsOf(call('oracle.get', { oracleId: 'or_1', revision: 4 }), ok({ oracle: { oracleId: 'or_1', revision: 4 }, pinnedByRun: true }), { now })), [['oracle', 'or_1', '4']]);
  assert.deepEqual(pins(await observationsOf(call('oracle.list', {}), ok({ pinned: [{ oracleId: 'or_1', revision: 4 }], otherApproved: [{ oracleId: 'or_2', revision: 1 }] }), { now })), [['oracle', 'or_1', '4'], ['oracle', 'or_2', '1']]);
});

test('ObservationLog: latest observation per resource (newest first), per snapshot, bounded; validated; append-only', async () => {
  const runId = 'run_log';
  const e = (id: string, version: string, kind: ObservedEntry['kind'] = 'read'): ObservedEntry => ({ ...entry('file', id, version), kind });
  await log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: 'i1', snapshotId: 'cs_1' }, [e('f1', 'v1'), e('f2', 'v1')]);
  await log.record({ runId, agentId: 'ag_1', toolId: 'fs.write', invocationId: 'i2', snapshotId: 'cs_2' }, [e('f1', 'v2', 'write')]);
  await log.record({ runId, agentId: 'ag_2', toolId: 'fs.read', invocationId: 'i3', snapshotId: 'cs_2' }, [e('f1', 'v9')]);
  await log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: 'i4' }, []);
  const latest = await log.latest({ runId, agentId: 'ag_1' });
  assert.deepEqual(latest.map((o) => [o.resourceId, o.observedVersion, o.kind, o.snapshotId]), [['f1', 'v2', 'write', 'cs_2'], ['f2', 'v1', 'read', 'cs_1']]);
  assert.deepEqual((await log.latest({ runId, agentId: 'ag_1', snapshotId: 'cs_1' })).map((o) => [o.resourceId, o.observedVersion]), [['f2', 'v1'], ['f1', 'v1']]);
  assert.deepEqual((await log.latest({ runId, agentId: 'ag_1', limit: 1 })).map((o) => o.resourceId), ['f1']);
  assert.deepEqual(await log.latest({ runId: 'run_other', agentId: 'ag_1' }), []);
  assert.equal(latest[0]!.workItemId, undefined);
  await rejectsWith(log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: 'i5' }, [{ ...entry('file', 'f', 'v'), kind: 'peek' as never }]), 'invalid_argument');
  await rejectsWith(log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: 'i5' }, [{ ...entry('file', '', 'v'), kind: 'read' }]), 'invalid_argument');
  await rejectsWith(log.record({ runId, agentId: '', toolId: 'fs.read', invocationId: 'i5' }, []), 'invalid_argument');
  await rejectsWith(log.latest({ runId, agentId: 'ag_1', limit: Number.NaN }), 'invalid_argument');
  await assert.rejects(env.db.query("UPDATE ht_context_observations SET observed_version = 'forged' WHERE run_id = $1", [runId]), /append-only table/);
  // deleting the latest observation would roll an agent's pin back (or drop it: an unchecked mutation) — refused too
  await assert.rejects(env.db.query("DELETE FROM ht_context_observations WHERE run_id = $1 AND observed_version = 'v2'", [runId]), /append-only table/);
  await assert.rejects(env.db.query('TRUNCATE ht_context_observations'), /append-only table/);
  assert.equal((await log.latest({ runId, agentId: 'ag_1' }))[0]!.observedVersion, 'v2');
});

test('the NEXT turn\'s snapshot includes what the agent observed (latest per resource, none dropped); other agents\' observations stay out', async () => {
  const runId = 'run_build';
  const sha = await put('src/build.ts', 'one');
  await observe(runId, 'ag_1', 'fs.read', { path: 'src/build.ts' }, { path: 'src/build.ts', sha256: sha });
  await observe(runId, 'ag_2', 'fs.read', { path: 'src/other.ts' }, { path: 'src/other.ts', sha256: 'x' });
  const s1 = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  assert.deepEqual(s1.readSet.map((e) => [e.resourceType, e.resourceId, e.observedVersion]), [['file', fileId('src/build.ts'), sha]]);
  // no observer (or no log): nothing is joined; an observer without an agent id is invalid
  assert.deepEqual((await builder({ observations: log }).build({ runId }, eventCtx(runId))).readSet, []);
  assert.deepEqual((await builder().build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId))).readSet, []);
  await rejectsWith(builder({ observations: log }).build({ runId, observer: { agentId: '' } }, eventCtx(runId)), 'invalid_argument');
  // (B[0]) an explicit cap never drops observations: a build whose observer observed more resources fails closed
  await observe(runId, 'ag_1', 'fs.read', { path: 'src/c.ts' }, { path: 'src/c.ts', sha256: 'c1' }, undefined, 'inv_c');
  const refused = await rejectsWith(builder({ observations: log, max: 1 }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId)), 'precondition_failed');
  assert.match(refused.message, /observed 2 resources, more than maxObservedEntries 1/);
  const both = await builder({ observations: log, max: 2 }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  assert.deepEqual(both.readSet.map((e) => e.resourceId), [fileId('src/build.ts'), fileId('src/c.ts')]);
});

test('(B[0] audit reproduction) 300 observations: the snapshot pins ALL of them, so a write to the OLDEST one is still re-checked', async () => {
  const runId = 'run_cap300';
  const N = 300;
  for (let i = 0; i < N; i++) {
    await log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: `inv_cap_${i}` }, [
      { kind: 'read', resourceType: 'file', resourceId: `workspace/w/f${i}.ts`, observedVersion: 'v1', observedAt: '2026-01-01T00:00:00.000Z', freshness: { kind: 'exact_version' } },
    ]);
  }
  const current = new Map<string, string>();
  const resolvers = createResolverRegistry([{ resourceType: 'file', currentVersion: async (id: string) => current.get(id) ?? 'v1' }]);
  const snap = await createSnapshotBuilder({
    ...env.deps, snapshots: store, resolvers, observations: log,
    sources: {
      getRun: async () => ({ runtimeManifestId: 'rm_1', policyRevision: 'p1', currentPlanRevision: 1, oracleRevisions: {} }),
      lastEventSeq: async () => 1, blackboardRevision: async () => 1, evidenceRoot: async () => ({ rootHash: 'root' }), experimentRevisions: async () => ({}),
    },
  }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  const pinned = new Set(snap.readSet.map((e) => e.resourceId));
  assert.equal(snap.readSet.length, N, 'every observed resource is pinned (no silent cap)');
  assert.ok(pinned.has('workspace/w/f0.ts') && pinned.has('workspace/w/f299.ts'));
  // another agent changes the oldest and the newest file the agent read
  current.set('workspace/w/f0.ts', 'v2');
  current.set('workspace/w/f299.ts', 'v2');
  const g = createFreshnessGuard({ ...env.deps, events: new InMemoryEventSink(), snapshots: store, resolvers, observations: log });
  const ctx = eventCtx(runId, { agentId: 'ag_1' });
  for (const f of ['f0', 'f299']) {
    const r = await g.validate(snap, { tool: 'fs.write', mutating: true, resources: [`workspace/w/${f}.ts`] }, ctx);
    assert.equal(r.fresh, false, `a write to ${f} after another agent changed it is stale`);
    assert.equal(r.checked, 1);
  }
});

/** Turn N: the agent reads; turn N+1: the snapshot pins what it read. */
async function readThenSnapshot(runId: string, rel: string, content: string): Promise<{ snapshot: ContextSnapshot; sha: string }> {
  const sha = await put(rel, content);
  await observe(runId, 'ag_1', 'fs.read', { path: rel }, { path: rel, sha256: sha }, undefined, `inv_read_${rel}`);
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  assert.ok(snapshot.readSet.some((e) => e.resourceId === fileId(rel) && e.observedVersion === sha), 'the snapshot pins the file it read');
  return { snapshot, sha };
}

test('stale after a concurrent change: a file the agent read and another agent changed ⇒ stale_context for a mutation touching it', async () => {
  const runId = 'run_stale';
  const { snapshot } = await readThenSnapshot(runId, 'src/pay.ts', 'export function pay() { return 1; }\n');
  const g = guard();
  const write = { tool: 'fs.write', resources: [fileId('src/pay.ts')], mutating: true };
  assert.deepEqual(await g.validate(snapshot, write, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  // another agent (same workspace) rewrites the file behind the first agent's back
  const changed = await put('src/pay.ts', 'export function pay() { return 2; }\n');
  const r = await g.validate(snapshot, write, ctxOf(runId, 'ag_1'));
  assert.equal(r.fresh, false);
  assert.deepEqual(!r.fresh && r.stale, [{ resourceType: 'file', resourceId: fileId('src/pay.ts'), observedVersion: snapshot.readSet[0]!.observedVersion, currentVersion: changed, reason: 'version_changed' }]);
  // a whole-workspace action (test.run, shell.exec, git.commit) touches it too
  assert.equal((await g.validate(snapshot, { tool: 'test.run', resources: ['workspace/ws_a'], mutating: true }, ctxOf(runId, 'ag_1'))).fresh, false);
  // the file deleted meanwhile is `missing`
  await rm(join(ws.path, 'src/pay.ts'));
  const gone = await g.validate(snapshot, write, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!gone.fresh && gone.stale.map((s) => s.reason), ['missing']);
  // read-only actions are never blocked
  assert.deepEqual(await g.validate(snapshot, { tool: 'fs.read', resources: [fileId('src/pay.ts')], mutating: false }, ctxOf(runId, 'ag_1')), { fresh: true, checked: 0 });
});

test('an unrelated change does not block: other files changed, other workspaces and read files the action does not touch', async () => {
  const runId = 'run_unrelated';
  const { snapshot } = await readThenSnapshot(runId, 'src/keep.ts', 'keep');
  await put('src/other.ts', 'changed by someone else');
  await put('src/keep2.ts', 'x');
  const g = guard();
  assert.deepEqual(await g.validate(snapshot, { tool: 'fs.write', resources: [fileId('src/keep.ts')], mutating: true }, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  // the read file changes, but the action writes another file: not selected, not stale
  await put('src/keep.ts', 'now different');
  assert.deepEqual(await g.validate(snapshot, { tool: 'fs.write', resources: [fileId('src/keep2.ts')], mutating: true }, ctxOf(runId, 'ag_1')), { fresh: true, checked: 0 });
  assert.deepEqual(await g.validate(snapshot, { tool: 'env.restart', resources: ['env/kv'], mutating: true }, ctxOf(runId, 'ag_1')), { fresh: true, checked: 0 });
  assert.deepEqual(await g.validate(snapshot, { tool: 'fs.write', resources: ['workspace/ws_other/src/keep.ts'], mutating: true }, ctxOf(runId, 'ag_1')), { fresh: true, checked: 0 });
});

test('the agent\'s own writes and re-reads in the turn refine the snapshot; a change by anyone else after them is still caught', async () => {
  const runId = 'run_own';
  const { snapshot } = await readThenSnapshot(runId, 'src/own.ts', 'v1');
  const g = guard();
  const root = { tool: 'test.run', resources: ['workspace/ws_a'], mutating: true };
  // own write in this turn: fs.write, then test.run on the workspace — not a concurrent change
  const own = await put('src/own.ts', 'v2 by the agent');
  await observe(runId, 'ag_1', 'fs.write', { path: 'src/own.ts', content: 'v2 by the agent' }, { path: 'src/own.ts', sha256: own }, snapshot, 'inv_w1');
  assert.deepEqual(await g.validate(snapshot, root, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  // …but only for the agent that wrote it: another agent validating the same snapshot sees the change
  assert.equal((await g.validate(snapshot, root, ctxOf(runId, 'ag_2'))).fresh, false);
  // …and without the log (or without an acting agent) the snapshot alone decides
  assert.equal((await guard({ observations: undefined }).validate(snapshot, root, ctxOf(runId, 'ag_1'))).fresh, false);
  assert.equal((await g.validate(snapshot, root, eventCtx(runId))).fresh, false);
  // someone else overwrites the agent's write: stale again
  const theirs = await put('src/own.ts', 'v3 by another agent');
  const r = await g.validate(snapshot, root, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!r.fresh && r.stale.map((s) => [s.observedVersion, s.currentVersion]), [[own, theirs]]);
  // a re-read in the turn is the agent's current knowledge
  await observe(runId, 'ag_1', 'fs.read', { path: 'src/own.ts' }, { path: 'src/own.ts', sha256: theirs }, snapshot, 'inv_r2');
  assert.equal((await g.validate(snapshot, root, ctxOf(runId, 'ag_1'))).fresh, true);
  // the next turn's snapshot pins the latest observation (the re-read)
  const next = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  assert.deepEqual(next.readSet.filter((e) => e.resourceType === 'file').map((e) => e.observedVersion), [theirs]);
});

test('a resource first observed in the turn is validated too; a file the agent deleted stays fresh while absent', async () => {
  const runId = 'run_first';
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  assert.deepEqual(snapshot.readSet, []);
  const sha = await put('src/new.ts', 'first');
  await observe(runId, 'ag_1', 'fs.read', { path: 'src/new.ts' }, { path: 'src/new.ts', sha256: sha }, snapshot, 'inv_new');
  const g = guard();
  const write = { tool: 'fs.write', resources: [fileId('src/new.ts')], mutating: true };
  assert.deepEqual(await g.validate(snapshot, write, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  await put('src/new.ts', 'changed between the read and the write');
  assert.equal((await g.validate(snapshot, write, ctxOf(runId, 'ag_1'))).fresh, false);
  // the agent's own patch deleted a file: recorded ABSENT, fresh while absent, stale once it reappears
  await put('src/doomed.ts', 'x');
  await rm(join(ws.path, 'src/doomed.ts'));
  await observe(runId, 'ag_1', 'fs.apply_patch', { patch: '…' }, { files: ['src/doomed.ts'], applied: true }, snapshot, 'inv_patch');
  const touch = { tool: 'fs.write', resources: [fileId('src/doomed.ts')], mutating: true };
  assert.deepEqual(await g.validate(snapshot, touch, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  await put('src/doomed.ts', 'resurrected by someone else');
  const back = await g.validate(snapshot, touch, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!back.fresh && back.stale.map((s) => [s.observedVersion, s.reason]), [[ABSENT_VERSION, 'version_changed']]);
});

test('metric windows: an action on the observed target is refused once the metric data is older than its window; other targets are unaffected', async () => {
  const runId = 'run_metric';
  await observe(runId, 'ag_1', 'metrics.query', { environmentId: 'kv', query: 'rate(http_requests_total[1m])', range: { start: 1_700_000_000, end: 1_700_000_300, step: 15 } }, { evidenceId: 'ev_m' });
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  const metric = snapshot.readSet.find((e) => e.resourceType === 'metric_window')!;
  assert.deepEqual(metric.freshness, { kind: 'max_age', milliseconds: 300_000 });
  const g = guard();
  const load = { tool: 'load.start', resources: ['env/kv', 'loadgen/127.0.0.1:1'], mutating: true };
  assert.deepEqual(await g.validate(snapshot, load, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  env.deps.clock.advance(300_001);
  try {
    const r = await g.validate(snapshot, load, ctxOf(runId, 'ag_1'));
    assert.deepEqual(!r.fresh && r.stale.map((s) => [s.resourceType, s.reason]), [['metric_window', 'expired']]);
    // an action on another environment, or a workspace write, does not depend on these metrics
    assert.equal((await g.validate(snapshot, { tool: 'env.restart', resources: ['env/other'], mutating: true }, ctxOf(runId, 'ag_1'))).fresh, true);
    assert.equal((await g.validate(snapshot, { tool: 'fs.write', resources: [fileId('x.ts')], mutating: true }, ctxOf(runId, 'ag_1'))).fresh, true);
    // re-querying the metrics in the turn refreshes the window
    await observe(runId, 'ag_1', 'metrics.query', { environmentId: 'kv', query: 'rate(http_requests_total[1m])', range: { start: 1_700_000_000, end: 1_700_000_300, step: 15 } }, { evidenceId: 'ev_m2' }, snapshot, 'inv_m2');
    assert.equal((await g.validate(snapshot, load, ctxOf(runId, 'ag_1'))).fresh, true);
  } finally {
    env.deps.clock.set('2026-01-01T00:00:00.000Z');
  }
});

test('metric windows: a fresh query of the target with a NEW window refreshes an expired observation (one window per target: never a permanent block)', async () => {
  const runId = 'run_metric_refresh';
  const range = (start: number) => ({ start, end: start + 60, step: 15 });
  await observe(runId, 'ag_1', 'metrics.query', { environmentId: 'kv', query: 'up', range: range(1_700_000_000) }, { evidenceId: 'ev_w1' }, undefined, 'inv_w1');
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  const g = guard();
  const load = { tool: 'load.start', resources: ['env/kv'], mutating: true };
  env.deps.clock.advance(60_001);
  try {
    assert.equal((await g.validate(snapshot, load, ctxOf(runId, 'ag_1'))).fresh, false, 'the metric data is older than its window');
    // the realistic refresh: the same expression over the NEXT window (a new range) — the agent's metric view of kv is current again
    await observe(runId, 'ag_1', 'metrics.query', { environmentId: 'kv', query: 'up', range: range(1_700_000_060) }, { evidenceId: 'ev_w2' }, snapshot, 'inv_w2');
    assert.deepEqual(await g.validate(snapshot, load, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
    // the next turn's snapshot holds ONE metric window of the target (the latest), not one per query ever made
    const next = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
    assert.deepEqual(next.readSet.filter((e) => e.resourceType === 'metric_window').map((e) => [e.resourceId, e.observedVersion]), [['env/kv/metrics', 'ev_w2']]);
    // expired again later: any other fresh metric observation of kv (another expression, an instant query, a scrape) refreshes it
    env.deps.clock.advance(60_001);
    assert.equal((await g.validate(next, load, ctxOf(runId, 'ag_1'))).fresh, false);
    await observe(runId, 'ag_1', 'metrics.scrape', { environmentId: 'kv' }, { evidenceId: 'ev_w3' }, next, 'inv_w3');
    assert.deepEqual(await g.validate(next, load, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  } finally {
    env.deps.clock.set('2026-01-01T00:00:00.000Z');
  }
});

test('git.show never launders a concurrent change: only shown content that IS the current file is observed', async () => {
  const runId = 'run_show';
  const rel = 'src/show.ts';
  const { snapshot } = await readThenSnapshot(runId, rel, 'v1\n');
  const g = guard();
  const write = { tool: 'fs.write', resources: [fileId(rel)], mutating: true };
  const shown = async (text: string, bytes: number, invocationId: string) => {
    const call = { toolId: 'git.show', input: { rev: 'HEAD', path: rel }, runId, agentId: 'ag_1', workItemId: 'wi_1', invocationId, workspace: WS, snapshot };
    const entries = await observationsOf(call, { status: 'success', structured: { rev: 'HEAD', path: rel, bytes }, modelText: text }, { now: () => env.deps.clock.isoNow() });
    await log.record({ runId, agentId: 'ag_1', workItemId: 'wi_1', toolId: 'git.show', invocationId, snapshotId: snapshot.snapshotId }, entries);
    return entries;
  };
  // another agent rewrites the file; the agent then looks at the COMMITTED version: it never saw the current content
  const theirs = await put(rel, 'v2 by another agent\n');
  assert.deepEqual(await shown('v1\n', 3, 'inv_show1'), [], 'the committed content is not the working-tree file');
  const r = await g.validate(snapshot, write, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!r.fresh && r.stale.map((s) => [s.resourceId, s.currentVersion, s.reason]), [[fileId(rel), theirs, 'version_changed']], 'the write stays stale');
  // output that did not reach the model whole (truncated / offloaded) proves nothing either
  assert.deepEqual(await shown('v2 by another agent', 999, 'inv_show2'), []);
  assert.equal((await g.validate(snapshot, write, ctxOf(runId, 'ag_1'))).fresh, false);
  // content shown that is exactly the current file: observed at that version (a git.show can still refresh the view)
  assert.deepEqual((await shown('v2 by another agent\n', 20, 'inv_show3')).map((e) => [e.kind, e.resourceId, e.observedVersion]), [['read', fileId(rel), theirs]]);
  assert.deepEqual(await g.validate(snapshot, write, ctxOf(runId, 'ag_1')), { fresh: true, checked: 1 });
  // a path the working tree no longer has: nothing is claimed about it
  await rm(join(ws.path, rel));
  assert.deepEqual(await shown('v2 by another agent\n', 20, 'inv_show4'), []);
});

test('environment observations: another agent\'s redeploy after the observation is stale; the agent\'s own env action in the turn is not', async () => {
  const runId = 'run_env_obs';
  const envs = new Map([['kv', { generation: 1 }]]);
  const environmentVersion = (id: string) => (envs.has(id) ? `${envs.get(id)!.generation}:` : undefined);
  const call = { toolId: 'http.request', input: { method: 'GET', environmentId: 'kv', path: '/' }, runId, agentId: 'ag_1', invocationId: 'inv_h' };
  await log.record({ runId, agentId: 'ag_1', toolId: 'http.request', invocationId: 'inv_h' }, await observationsOf(call, { status: 'success', structured: {} }, { environmentVersion }));
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  const g = guard({ envs });
  const write = { tool: 'fs.write', resources: [fileId('a.ts')], mutating: true };
  assert.equal((await g.validate(snapshot, write, ctxOf(runId, 'ag_1'))).fresh, true);
  envs.set('kv', { generation: 2 }); // restarted by someone else
  const r = await g.validate(snapshot, write, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!r.fresh && r.stale.map((s) => [s.resourceType, s.resourceId, s.reason]), [['environment', 'kv', 'version_changed']]);
  // the agent restarts it itself in this turn (own write): its next action on it is fresh
  envs.set('kv', { generation: 3 });
  const restart = { toolId: 'env.restart', input: { environmentId: 'kv' }, runId, agentId: 'ag_1', invocationId: 'inv_r', snapshot };
  await log.record({ runId, agentId: 'ag_1', toolId: 'env.restart', invocationId: 'inv_r', snapshotId: snapshot.snapshotId }, await observationsOf(restart, { status: 'success' }, { environmentVersion }));
  assert.equal((await g.validate(snapshot, { tool: 'load.start', resources: ['env/kv'], mutating: true }, ctxOf(runId, 'ag_1'))).fresh, true);
  // the verified result names the generation the action produced: a later redeploy by another agent — landing between
  // the action and its observation — is never recorded as this agent's own write
  const restartedTo = (generation: number) => observationsOf({ ...restart, invocationId: `inv_g${generation}` }, { status: 'success', structured: { environmentId: 'kv', action: 'restart', generation } }, { environmentVersion });
  assert.deepEqual((await restartedTo(3)).map((e) => [e.kind, e.observedVersion]), [['write', '3:']], 'no one moved it since');
  envs.set('kv', { generation: 4 }); // another agent's deploy right after this agent's restart to generation 3
  assert.deepEqual(await restartedTo(3), [], 'generation 4 is not what this agent produced');
  await log.record({ runId, agentId: 'ag_1', toolId: 'env.restart', invocationId: 'inv_g3', snapshotId: snapshot.snapshotId }, await restartedTo(3));
  const after4 = await g.validate(snapshot, { tool: 'load.start', resources: ['env/kv'], mutating: true }, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!after4.fresh && after4.stale.map((s) => [s.resourceType, s.observedVersion, s.currentVersion]), [['environment', '3:', '4:']]);
});

test('fail closed: an unknown workspace is a resolver error; an unreadable observation log fails the validation', async () => {
  const runId = 'run_closed';
  await log.record({ runId, agentId: 'ag_1', toolId: 'fs.read', invocationId: 'inv_x' }, [{ ...entry('file', 'workspace/ws_gone/a.ts', 'v1'), kind: 'read' }]);
  const snapshot = await builder({ observations: log }).build({ runId, observer: { agentId: 'ag_1' } }, eventCtx(runId));
  const r = await guard().validate(snapshot, { tool: 'fs.write', resources: ['workspace/ws_gone/a.ts'], mutating: true }, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!r.fresh && r.stale.map((s) => s.reason), ['resolver_error']);
  const broken: ObservationLog = { record: async () => undefined, latest: async () => Promise.reject(new Error('observation store down')) };
  await assert.rejects(guard({ observations: broken }).validate(snapshot, { tool: 'fs.write', resources: ['workspace/ws_a/a.ts'], mutating: true }, ctxOf(runId, 'ag_1')), /observation store down/);
  // a malformed file resource id is invalid (never silently fresh)
  const bad = await store.create({ runId, eventSeq: 1, blackboardRevision: 1, planRevision: 1, runtimeManifestId: 'rm', oracleRevisions: {}, experimentRevisions: {}, policyRevision: 'p', evidenceRootHash: 'r', readSet: [entry('file', 'src/a.ts', 'v1')] }, eventCtx(runId));
  const rb = await guard().validate(bad, { tool: 'fs.write', resources: ['src/a.ts'], mutating: true }, ctxOf(runId, 'ag_1'));
  assert.deepEqual(!rb.fresh && rb.stale.map((s) => [s.reason, /workspace\/<workspaceId>/.test(s.error ?? '')]), [['resolver_error', true]]);
});

test('observeToolRuntime: every execution feeds the log before its result returns; a read that cannot be pinned is withheld (fail closed), an effect\'s result never changes', async () => {
  const runId = 'run_wrap';
  const sha = await put('src/wrap.ts', 'SECRET-CONTENT');
  const calls: string[] = [];
  const runtime = {
    registry: { marker: true },
    async execute(request: { toolId: string; input: unknown; runId: string; agentId: string; invocationId: string; workItemId: string; workspace: typeof WS; snapshot?: { snapshotId: string } }) {
      calls.push(request.toolId);
      return { toolId: request.toolId, invocationId: request.invocationId, status: 'success', structured: { path: 'src/wrap.ts', sha256: sha }, modelText: 'SECRET-CONTENT', artifactRefs: [{ uri: 'artifact://x' }], evidenceRefs: [] as string[], durationMs: 1 };
    },
  };
  const wrapped = observeToolRuntime(runtime, { log, logger: env.deps.logger, now: () => env.deps.clock.isoNow() });
  assert.equal(wrapped.registry, runtime.registry, 'other members are kept');
  const res = await wrapped.execute({ toolId: 'fs.read', input: { path: 'src/wrap.ts' }, runId, agentId: 'ag_w', invocationId: 'inv_w', workItemId: 'wi_w', workspace: WS, snapshot: { snapshotId: 'cs_w' } });
  assert.equal(res.modelText, 'SECRET-CONTENT');
  const [o] = await log.latest({ runId, agentId: 'ag_w' });
  assert.deepEqual([o!.resourceId, o!.observedVersion, o!.snapshotId, o!.workItemId, o!.toolId, o!.invocationId], [fileId('src/wrap.ts'), sha, 'cs_w', 'wi_w', 'fs.read', 'inv_w']);
  const failing = observeToolRuntime(runtime, { log: { record: async () => Promise.reject(new Error('disk full')), latest: async () => [] }, logger: env.deps.logger });
  // a READ the log could not record: the agent must not act on content its read set does not pin (a later change of the
  // file by another agent could not be caught) — the content is withheld, the call reports `unavailable`
  const res2 = await failing.execute({ toolId: 'fs.read', input: { path: 'src/wrap.ts' }, runId, agentId: 'ag_w', invocationId: 'inv_w2', workItemId: 'wi_w', workspace: WS });
  assert.equal(res2.status, 'failed');
  assert.equal((res2 as { error?: { code: string } }).error?.code, 'unavailable');
  assert.doesNotMatch(res2.modelText, /SECRET-CONTENT/);
  assert.match(res2.modelText, /^\[failed\] unavailable: .*disk full/);
  assert.equal((res2 as { structured?: unknown }).structured, undefined);
  assert.deepEqual((res2 as { artifactRefs: unknown[] }).artifactRefs, []);
  assert.ok(env.deps.logger.entries.some((e) => /read withheld/.test(e.msg)));
  // an EFFECT (a write, an env action, any http call) already happened: its result is returned as is (hiding it would
  // invite a duplicate); its missing observation only makes later checks stricter
  const res3 = await failing.execute({ toolId: 'fs.write', input: { path: 'src/wrap.ts', content: 'SECRET-CONTENT' }, runId, agentId: 'ag_w', invocationId: 'inv_w3', workItemId: 'wi_w', workspace: WS });
  assert.deepEqual([res3.status, res3.modelText], ['success', 'SECRET-CONTENT']);
  assert.ok(env.deps.logger.entries.some((e) => /tool observations could not be recorded/.test(e.msg)));
  assert.deepEqual(calls, ['fs.read', 'fs.read', 'fs.write']);
});

test('ReadSetEntry types used by observations are valid snapshot content', async () => {
  const entries: ReadSetEntry[] = [
    entry('file', fileId('a'), ABSENT_VERSION),
    entry('metric_window', 'env/kv/metrics/abc', 'ev_1', { kind: 'max_age', milliseconds: 60_000 }),
  ];
  const s = await store.create({ runId: 'run_valid', eventSeq: 1, blackboardRevision: 1, planRevision: 1, runtimeManifestId: 'rm', oracleRevisions: {}, experimentRevisions: {}, policyRevision: 'p', evidenceRootHash: 'r', readSet: entries }, eventCtx('run_valid'));
  assert.equal((await store.get(s.snapshotId))!.readSet.length, 2);
});
