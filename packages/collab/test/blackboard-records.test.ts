import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoverageGap, Finding, Hypothesis, Review, Risk } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { count, finding, openEnv, rejectsWith, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

const hypothesis = (status: Hypothesis['status']): Hypothesis => ({ statement: 'empty cart hits a null deref', status, confidence: 0.6, suggestedChecks: ['unit test cart=[]'] });

test('postRecord(finding) starts a lineage at version 1 and emits finding.created with a reactor-sized payload', async () => {
  const runId = 'bb-1';
  const rec = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec', workItemId: 'wi-exec', evidenceRefs: ['ev_1'] }, eventCtx(runId, { workItemId: 'wi-exec', agentId: 'agent-exec' }));
  assert.equal(rec.lineageId, rec.recordId);
  assert.equal(rec.version, 1);
  assert.equal(rec.revision, 1);
  assert.deepEqual(rec.evidenceRefs, ['ev_1']);
  assert.deepEqual(await env.board.getRecord(rec.recordId), rec);
  assert.deepEqual(await env.board.head(rec.lineageId), rec);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['finding.created']);
  assert.equal(evs[0]!.aggregateType, 'record');
  assert.equal(evs[0]!.aggregateId, rec.lineageId);
  assert.equal(evs[0]!.workItemId, 'wi-exec');
  assert.equal(evs[0]!.agentId, 'agent-exec');
  assert.deepEqual(evs[0]!.payload, {
    recordId: rec.recordId, lineageId: rec.lineageId, recordType: 'finding', version: 1, revision: 1, workItemId: 'wi-exec', status: 'open',
    severity: 'P1', category: 'product_defect', title: 'checkout returns 500 for empty cart', fingerprint: 'fp-checkout-500',
  });
});

test('supersede writes version+1 in the same lineage, moves the head and emits finding.updated (+ finding.confirmed on the status change)', async () => {
  const runId = 'bb-2';
  const ctx = eventCtx(runId);
  const v1 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, ctx);
  const v2 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ status: 'confirmed' }), createdBy: 'agent-rca', supersedes: v1.recordId }, ctx);
  assert.equal(v2.lineageId, v1.lineageId);
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.recordId);
  assert.equal(v2.revision, 2);
  assert.equal((await env.board.head<Finding>(v1.lineageId))!.recordId, v2.recordId);
  assert.equal((await env.board.getRecord(v1.recordId))!.version, 1, 'superseded versions stay readable (append-only)');
  // Updating a confirmed finding again (still confirmed) must not re-announce the confirmation.
  const v3 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ status: 'confirmed', severity: 'P0' }), createdBy: 'agent-rca', supersedes: v2.recordId }, ctx);
  const v4 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ status: 'rejected' }), createdBy: 'agent-review', supersedes: v3.recordId }, ctx);
  assert.equal(v4.version, 4);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['finding.created', 'finding.updated', 'finding.confirmed', 'finding.updated', 'finding.updated', 'finding.rejected']);
  assert.deepEqual(evs.map((e) => (e.payload as { previousStatus?: string }).previousStatus), [undefined, 'open', 'open', 'confirmed', 'confirmed', 'confirmed']);
  assert.equal((evs[3]!.payload as { severity: string }).severity, 'P0');
});

test('superseding a record that is not the current head is a conflict and changes nothing', async () => {
  const runId = 'bb-3';
  const ctx = eventCtx(runId);
  const v1 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'a' }, ctx);
  const v2 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ status: 'confirmed' }), createdBy: 'b', supersedes: v1.recordId }, ctx);
  const revBefore = await env.board.revision(runId);
  const eventsBefore = await env.events.lastSeq(runId);
  const err = await rejectsWith(env.board.postRecord({ runId, recordType: 'finding', payload: finding({ status: 'rejected' }), createdBy: 'stale', supersedes: v1.recordId }, ctx), 'conflict');
  assert.equal(err.details['head'], v2.recordId);
  assert.equal(err.details['lineageId'], v1.lineageId);
  assert.equal(await env.board.revision(runId), revBefore);
  assert.equal(await env.events.lastSeq(runId), eventsBefore);
  assert.equal((await env.board.head(v1.lineageId))!.recordId, v2.recordId);
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_records WHERE lineage_id = $1', [v1.lineageId]), 2);
});

test('superseding an unknown record is not_found; across record types or runs is invalid_argument', async () => {
  const runId = 'bb-4';
  const ctx = eventCtx(runId);
  await rejectsWith(env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'a', supersedes: 'rec_nope' }, ctx), 'not_found');
  const f = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'a' }, ctx);
  await rejectsWith(env.board.postRecord({ runId, recordType: 'note', payload: { text: 'x' }, createdBy: 'a', supersedes: f.recordId }, ctx), 'invalid_argument');
  const other = eventCtx('bb-4b');
  await rejectsWith(env.board.postRecord({ runId: 'bb-4b', recordType: 'finding', payload: finding(), createdBy: 'a', supersedes: f.recordId }, other), 'invalid_argument');
  assert.equal((await env.board.head(f.lineageId))!.recordId, f.recordId);
});

test('record writes are validated: context run mismatch, unknown type and non-object payload are rejected', async () => {
  await rejectsWith(env.board.postRecord({ runId: 'bb-5', recordType: 'finding', payload: finding(), createdBy: 'a' }, eventCtx('bb-other')), 'invalid_argument');
  await rejectsWith(env.board.postRecord({ runId: 'bb-5', recordType: 'bogus', payload: finding(), createdBy: 'a' } as never, eventCtx('bb-5')), 'invalid_argument');
  await rejectsWith(env.board.postRecord({ runId: 'bb-5', recordType: 'note', payload: null as never, createdBy: 'a' }, eventCtx('bb-5')), 'invalid_argument');
  assert.equal(await env.board.revision('bb-5'), 0);
  assert.equal(await env.events.lastSeq('bb-5'), 0);
});

test('type-specific events: hypothesis, coverage gap, risk, review and generic records', async () => {
  const runId = 'bb-6';
  const ctx = eventCtx(runId);
  const h1 = await env.board.postRecord({ runId, recordType: 'hypothesis', payload: hypothesis('open'), createdBy: 'rca' }, ctx);
  const h2 = await env.board.postRecord({ runId, recordType: 'hypothesis', payload: hypothesis('supported'), createdBy: 'rca', supersedes: h1.recordId }, ctx);
  await env.board.postRecord({ runId, recordType: 'hypothesis', payload: hypothesis('inconclusive'), createdBy: 'rca', supersedes: h2.recordId }, ctx);
  await env.board.postRecord({ runId, recordType: 'hypothesis', payload: hypothesis('refuted'), createdBy: 'rca' }, ctx);
  const gap: CoverageGap = { area: 'checkout/empty-cart', description: 'no test', status: 'open' };
  const g = await env.board.postRecord({ runId, recordType: 'coverage_gap', payload: gap, createdBy: 'designer' }, ctx);
  await env.board.postRecord({ runId, recordType: 'coverage_gap', payload: { ...gap, status: 'addressed' }, createdBy: 'designer', supersedes: g.recordId }, ctx);
  const risk: Risk = { title: 'payment regression', description: 'd', likelihood: 'high', impact: 'critical', level: 'critical', componentRefs: ['checkout'], source: 'change_analysis', status: 'open' };
  await env.board.postRecord({ runId, recordType: 'risk', payload: risk, createdBy: 'analyst' }, ctx);
  const review: Review = { subjectRef: { kind: 'record', id: h1.recordId }, verdict: 'approve', rationale: 'evidence checks out', checkedEvidenceRefs: ['ev_1'], reviewerRole: 'reviewer' };
  await env.board.postRecord({ runId, recordType: 'review', payload: review, createdBy: 'reviewer' }, ctx);
  await env.board.postRecord({ runId, recordType: 'note', payload: { text: 'fyi' }, createdBy: 'lead' }, ctx);
  await env.board.postRecord({ runId, recordType: 'test_strategy', payload: { objectiveIds: [], approach: 'hybrid', techniques: [], description: 'd' }, createdBy: 'lead' }, ctx);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), [
    'hypothesis.created', 'hypothesis.supported', 'record.posted', 'hypothesis.created', 'hypothesis.refuted',
    'coverage.gap_detected', 'record.posted', 'risk.identified', 'review.completed', 'record.posted', 'record.posted',
  ]);
  const riskEv = evs.find((e) => e.eventType === 'risk.identified')!;
  assert.deepEqual([(riskEv.payload as Record<string, unknown>)['level'], (riskEv.payload as Record<string, unknown>)['title']], ['critical', 'payment regression']);
  const reviewEv = evs.find((e) => e.eventType === 'review.completed')!;
  assert.deepEqual((reviewEv.payload as Record<string, unknown>)['subjectRef'], { kind: 'record', id: h1.recordId });
  assert.equal((reviewEv.payload as Record<string, unknown>)['verdict'], 'approve');
});

test('every write bumps the run revision exactly once; revisions are per run', async () => {
  const ctx = eventCtx('bb-7');
  const a = await env.board.postRecord({ runId: 'bb-7', recordType: 'note', payload: { text: '1' }, createdBy: 'x' }, ctx);
  const b = await env.board.postRecord({ runId: 'bb-7', recordType: 'note', payload: { text: '2' }, createdBy: 'x' }, ctx);
  const c = await env.board.postRecord({ runId: 'bb-7b', recordType: 'note', payload: { text: '3' }, createdBy: 'x' }, eventCtx('bb-7b'));
  assert.deepEqual([a.revision, b.revision, c.revision], [1, 2, 1]);
  assert.equal(await env.board.revision('bb-7'), 2);
  assert.equal(await env.board.revision('bb-7b'), 1);
  assert.equal(await env.board.revision('bb-never'), 0);
});

test('query filters by type, status, work item, revision window and head-ness, ordered by revision', async () => {
  const runId = 'bb-8';
  const ctx = eventCtx(runId);
  const f1 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ fingerprint: 'f1' }), createdBy: 'x', workItemId: 'wi-a' }, ctx); // r1
  const f2 = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ fingerprint: 'f2', status: 'confirmed' }), createdBy: 'x', workItemId: 'wi-b' }, ctx); // r2
  const h = await env.board.postRecord({ runId, recordType: 'hypothesis', payload: hypothesis('open'), createdBy: 'x', workItemId: 'wi-a' }, ctx); // r3
  const f1b = await env.board.postRecord({ runId, recordType: 'finding', payload: finding({ fingerprint: 'f1', status: 'fixed' }), createdBy: 'x', supersedes: f1.recordId }, ctx); // r4
  const ids = (rs: Array<{ recordId: string }>) => rs.map((r) => r.recordId);
  assert.deepEqual(ids(await env.board.query({ runId })), [f2.recordId, h.recordId, f1b.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, includeSuperseded: true })), [f1.recordId, f2.recordId, h.recordId, f1b.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, recordType: 'finding' })), [f2.recordId, f1b.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, recordType: ['finding', 'hypothesis'], status: ['open', 'confirmed'] })), [f2.recordId, h.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, workItemId: 'wi-a' })), [h.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, workItemId: 'wi-a', includeSuperseded: true })), [f1.recordId, h.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, afterRevision: 2 })), [h.recordId, f1b.recordId]);
  assert.deepEqual(ids(await env.board.query({ runId, limit: 1 })), [f2.recordId]);
  assert.deepEqual(await env.board.query({ runId: 'bb-empty' }), []);
});

test('record events carry the record workItemId when the context has none (I10); malformed refs are rejected', async () => {
  const runId = 'bb-9';
  const rec = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec', workItemId: 'wi-exec-9' }, eventCtx(runId));
  const [e] = await env.events.read(runId);
  assert.equal(e!.workItemId, 'wi-exec-9');
  assert.equal(e!.aggregateId, rec.lineageId);
  // An explicit context work item wins (the actor's work item is the audit subject).
  await env.board.postRecord({ runId, recordType: 'note', payload: { text: 'x' }, createdBy: 'a', workItemId: 'wi-rec' }, eventCtx(runId, { workItemId: 'wi-ctx' }));
  assert.equal((await env.events.read(runId))[1]!.workItemId, 'wi-ctx');
  await rejectsWith(env.board.postRecord({ runId, recordType: 'note', payload: { text: 'x' }, createdBy: 'a', evidenceRefs: [42] as never }, eventCtx(runId)), 'invalid_argument');
  await rejectsWith(env.board.postRecord({ runId, recordType: 'note', payload: { text: 'x' }, createdBy: 'a', evidenceRefs: 'ev_1' as never }, eventCtx(runId)), 'invalid_argument');
  assert.equal(await env.board.revision(runId), 2);
});
