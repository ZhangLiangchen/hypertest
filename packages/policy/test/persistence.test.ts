import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hashCanonical, type SqlDatabase } from '@hypertest/core';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, testDeps } from '@hypertest/testkit';
import { createApprovalService, createPolicyDecisionLog, policyRequestHash, type ActionPermit, type ApprovalService, type PolicyDecisionLog } from '../src/index.ts';
import { SqlEventSink, migrations, request } from './helpers.ts';

let db: SqlDatabase;
let dispose: () => Promise<void>;
let sink: SqlEventSink;
let log: PolicyDecisionLog;
let approvals: ApprovalService;

before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations }));
  sink = new SqlEventSink(db);
  const deps = { ...testDeps(), db, events: sink };
  log = createPolicyDecisionLog(deps);
  approvals = createApprovalService(deps);
});
after(async () => {
  await dispose();
});

const permit = (decisionId: string, decision: ActionPermit['decision'] = 'allow'): ActionPermit => ({ decision, decisionId, reasons: ['rule:x: y'], policyRevision: 'builtin@1' });

// ----------------------------------------------------------------------------- decision log

test('decision log: record stores the request hash and emits policy.decided in the same transaction', async () => {
  const runId = 'run_dlog_1';
  const req = request({ runId, capability: { ...request().capability, runId } });
  const rec = await log.record(req, permit('pdec_a1', 'approval_required'), eventCtx(runId));
  assert.equal(rec.requestHash, hashCanonical(req));
  assert.equal(rec.requestHash, policyRequestHash(req));
  assert.equal(rec.decidedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(await log.get('pdec_a1'), rec);
  assert.deepEqual(await log.list(runId), [rec]);
  const events = await sink.rows(runId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event_type, 'policy.decided');
  assert.equal(events[0]!.aggregate_id, 'pdec_a1');
  assert.equal(events[0]!.payload['decision'], 'approval_required');
  assert.equal(events[0]!.payload['requestHash'], rec.requestHash);
});

test('decision log: re-recording the same decision is idempotent (no second event); a different request conflicts', async () => {
  const runId = 'run_dlog_2';
  const req = request({ runId });
  const first = await log.record(req, permit('pdec_b1'), eventCtx(runId));
  const again = await log.record(req, permit('pdec_b1'), eventCtx(runId));
  assert.deepEqual(again, first);
  assert.equal((await sink.rows(runId)).length, 1);
  await assert.rejects(log.record(request({ runId, tool: 'fs.write' }), permit('pdec_b1'), eventCtx(runId)), { code: 'conflict' });
  await assert.rejects(log.record(req, permit('pdec_b1', 'deny'), eventCtx(runId)), { code: 'conflict' });
});

test('decision log: an event-sink failure rolls back the decision row (atomic audit)', async () => {
  const runId = 'run_dlog_3';
  sink.failNext = true;
  await assert.rejects(log.record(request({ runId }), permit('pdec_c1'), eventCtx(runId)), /sink failure/);
  assert.equal(await log.get('pdec_c1'), undefined);
  assert.deepEqual(await log.list(runId), []);
});

test('decision log: rows are append-only at the database level', async () => {
  const runId = 'run_dlog_4';
  await log.record(request({ runId }), permit('pdec_d1'), eventCtx(runId));
  await assert.rejects(db.query(`UPDATE ht_policy_decisions SET decision = 'allow' WHERE decision_id = 'pdec_d1'`), /append-only/);
  await assert.rejects(db.query(`DELETE FROM ht_policy_decisions WHERE decision_id = 'pdec_d1'`), /append-only/);
  assert.equal((await log.get('pdec_d1'))?.permit.decision, 'allow');
});

test('decision log: list is ordered by recording order and scoped by run', async () => {
  const runId = 'run_dlog_5';
  for (const id of ['pdec_z', 'pdec_a', 'pdec_m']) await log.record(request({ runId, requestId: id }), permit(id), eventCtx(runId));
  assert.deepEqual((await log.list(runId)).map((r) => r.decisionId), ['pdec_z', 'pdec_a', 'pdec_m']);
  await assert.rejects(log.record(request({ runId: 'run_other' }), permit('pdec_x'), eventCtx(runId)), { code: 'invalid_argument' });
});

// ----------------------------------------------------------------------------- approvals

const executor = { kind: 'agent' as const, id: 'agent_exec', role: 'executor', modelProvider: 'openai' };
const human = { kind: 'human' as const, id: 'user_alice' };

test('approvals: request emits approval.requested; decide by another actor emits approval.granted', async () => {
  const runId = 'run_appr_1';
  const a = await approvals.request({ runId, kind: 'action', subject: { tool: 'load.start', env: 'staging' }, requestedBy: executor }, eventCtx(runId));
  assert.equal(a.status, 'pending');
  assert.match(a.approvalId, /^appr_/);
  assert.deepEqual(await approvals.get(a.approvalId), a);
  const decided = await approvals.decide(a.approvalId, true, human, 'load window agreed', eventCtx(runId, { actorId: human.id }));
  assert.equal(decided.status, 'approved');
  assert.deepEqual(decided.decidedBy, human);
  assert.equal(decided.rationale, 'load window agreed');
  assert.equal(decided.decidedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(await approvals.get(a.approvalId), decided);
  assert.deepEqual((await sink.rows(runId)).map((e) => e.event_type), ['approval.requested', 'approval.granted']);
});

test('approvals: the requester can never decide their own request (permission_denied), state unchanged', async () => {
  const runId = 'run_appr_2';
  const a = await approvals.request({ runId, kind: 'oracle_change', subject: { proposalId: 'ocp_1' }, requestedBy: executor }, eventCtx(runId));
  await assert.rejects(approvals.decide(a.approvalId, true, { ...executor, role: 'reviewer' }, 'self', eventCtx(runId)), { code: 'permission_denied' });
  assert.equal((await approvals.get(a.approvalId))?.status, 'pending');
  assert.deepEqual((await sink.rows(runId)).map((e) => e.event_type), ['approval.requested']);
});

test('approvals: deciding twice is precondition_failed; denial emits approval.denied', async () => {
  const runId = 'run_appr_3';
  const a = await approvals.request({ runId, kind: 'test_change', subject: { diff: 'x' }, requestedBy: executor }, eventCtx(runId));
  const denied = await approvals.decide(a.approvalId, false, human, 'weakens assertion', eventCtx(runId));
  assert.equal(denied.status, 'denied');
  await assert.rejects(approvals.decide(a.approvalId, true, human, 'changed my mind', eventCtx(runId)), { code: 'precondition_failed' });
  await assert.rejects(approvals.decide(a.approvalId, true, { kind: 'human', id: 'user_bob' }, 'override', eventCtx(runId)), { code: 'precondition_failed' });
  assert.equal((await approvals.get(a.approvalId))?.status, 'denied');
  assert.deepEqual((await sink.rows(runId)).map((e) => e.event_type), ['approval.requested', 'approval.denied']);
});

test('approvals: unknown id is not_found; invalid input is rejected', async () => {
  await assert.rejects(approvals.decide('appr_missing', true, human, 'x', eventCtx('run_appr_4')), { code: 'not_found' });
  await assert.rejects(approvals.request({ runId: 'run_appr_4', kind: 'teleport' as never, subject: {}, requestedBy: executor }, eventCtx('run_appr_4')), { code: 'invalid_argument' });
  await assert.rejects(approvals.request({ runId: 'run_appr_4', kind: 'action', subject: {}, requestedBy: executor, decidedBy: human }, eventCtx('run_appr_4')), { code: 'invalid_argument' });
  const a = await approvals.request({ runId: 'run_appr_4', kind: 'budget', subject: {}, requestedBy: executor }, eventCtx('run_appr_4'));
  await assert.rejects(approvals.decide(a.approvalId, true, human, '   ', eventCtx('run_appr_4')), { code: 'invalid_argument' });
});

test('approvals: a sink failure rolls back the decision (still pending)', async () => {
  const runId = 'run_appr_5';
  const a = await approvals.request({ runId, kind: 'manual_review', subject: { op: 'op_1' }, requestedBy: { kind: 'system', id: 'system:reconciler' } }, eventCtx(runId));
  sink.failNext = true;
  await assert.rejects(approvals.decide(a.approvalId, true, human, 'ok', eventCtx(runId)), /sink failure/);
  assert.equal((await approvals.get(a.approvalId))?.status, 'pending');
  assert.equal((await approvals.decide(a.approvalId, true, human, 'ok', eventCtx(runId))).status, 'approved');
});

test('approvals: database guard forbids re-deciding or deleting a decided approval', async () => {
  const runId = 'run_appr_6';
  const a = await approvals.request({ runId, kind: 'action', subject: {}, requestedBy: executor }, eventCtx(runId));
  await approvals.decide(a.approvalId, false, human, 'no', eventCtx(runId));
  await assert.rejects(db.query(`UPDATE ht_approvals SET status = 'approved' WHERE approval_id = $1`, [a.approvalId]), /already denied/);
  await assert.rejects(db.query(`DELETE FROM ht_approvals WHERE approval_id = $1`, [a.approvalId]), /DELETE is not permitted/);
});

test('approvals: list filters by run and status', async () => {
  const runId = 'run_appr_7';
  const a1 = await approvals.request({ runId, kind: 'action', subject: { n: 1 }, requestedBy: executor }, eventCtx(runId));
  const a2 = await approvals.request({ runId, kind: 'action', subject: { n: 2 }, requestedBy: executor }, eventCtx(runId));
  await approvals.decide(a1.approvalId, true, human, 'ok', eventCtx(runId));
  assert.deepEqual((await approvals.list({ runId })).map((a) => a.approvalId), [a1.approvalId, a2.approvalId]);
  assert.deepEqual((await approvals.list({ runId, status: ['pending'] })).map((a) => a.approvalId), [a2.approvalId]);
  assert.deepEqual((await approvals.list({ runId, status: ['approved', 'denied'] })).map((a) => a.approvalId), [a1.approvalId]);
  assert.deepEqual(await approvals.list({ runId, status: [] }), []);
  assert.ok((await approvals.list({ status: ['pending'] })).some((a) => a.approvalId === a2.approvalId));
});

// ----------------------------------------------------------------------------- adversarial review regressions

test('approvals: agents can never decide action / budget / manual_review approvals (human-in-the-loop kinds)', async () => {
  const runId = 'run_appr_8';
  const independent = { kind: 'agent' as const, id: 'agent_rev', role: 'reviewer', modelProvider: 'anthropic' };
  for (const kind of ['action', 'budget', 'manual_review'] as const) {
    const a = await approvals.request({ runId, kind, subject: { kind }, requestedBy: executor }, eventCtx(runId));
    await assert.rejects(approvals.decide(a.approvalId, true, independent, 'looks fine', eventCtx(runId)), (e: { code?: string; details?: { rule?: string } }) => e.code === 'permission_denied' && e.details?.rule === 'agent_decider');
    assert.equal((await approvals.get(a.approvalId))?.status, 'pending');
  }
  assert.deepEqual((await sink.rows(runId)).map((e) => e.event_type), ['approval.requested', 'approval.requested', 'approval.requested']);
});

test('approvals: an agent may decide a test_change approval only when independent of the agent requester', async () => {
  const runId = 'run_appr_9';
  const rule = (r: string) => (e: { code?: string; details?: { rule?: string } }) => e.code === 'permission_denied' && e.details?.rule === r;
  const a = await approvals.request({ runId, kind: 'test_change', subject: { diff: 'expect 5 → 6' }, requestedBy: executor }, eventCtx(runId));
  await assert.rejects(approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_twin', role: 'reviewer', modelProvider: 'openai' }, 'ok', eventCtx(runId)), rule('same_provider'));
  await assert.rejects(approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_peer', role: 'executor', modelProvider: 'anthropic' }, 'ok', eventCtx(runId)), rule('same_role'));
  await assert.rejects(approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_anon', role: 'reviewer' }, 'ok', eventCtx(runId)), rule('provider_unknown'));
  await assert.rejects(approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_norole', modelProvider: 'anthropic' }, 'ok', eventCtx(runId)), rule('role_unknown'));
  assert.equal((await approvals.get(a.approvalId))?.status, 'pending');
  const ok = await approvals.decide(a.approvalId, false, { kind: 'agent', id: 'agent_rev', role: 'reviewer', modelProvider: 'anthropic' }, 'weakens the oracle', eventCtx(runId));
  assert.equal(ok.status, 'denied');
});

test('approvals: the requester rationale survives in approval.requested after the decider replaces the row rationale', async () => {
  const runId = 'run_appr_11';
  const a = await approvals.request({ runId, kind: 'action', subject: { tool: 'load.start' }, requestedBy: executor, rationale: 'need staging load for the SLO oracle' }, eventCtx(runId));
  const d = await approvals.decide(a.approvalId, true, human, 'window agreed', eventCtx(runId));
  assert.equal(d.rationale, 'window agreed');
  const requested = (await sink.rows(runId)).find((e) => e.event_type === 'approval.requested')!;
  assert.equal(requested.payload['rationale'], 'need staging load for the SLO oracle');
});

test('approvals: the event context must belong to the approval run', async () => {
  await assert.rejects(approvals.request({ runId: 'run_appr_10', kind: 'action', subject: {}, requestedBy: executor }, eventCtx('run_other')), { code: 'invalid_argument' });
  assert.deepEqual(await approvals.list({ runId: 'run_appr_10' }), []);
});

test('decision log / approvals: NUL characters in agent-influenced data never make the audit write fail', async () => {
  const runId = 'run_nul_1';
  const req = request({ runId, input: { content: 'a\u0000b', ['k\u0000']: ['\u0000'] } });
  const rec = await log.record(req, permit('pdec_nul_1'), eventCtx(runId));
  assert.deepEqual(rec.request.input, { content: 'a�b', 'k�': ['�'] });
  assert.equal(rec.requestHash, policyRequestHash(req));
  assert.equal(rec.requestHash, hashCanonical(rec.request), 'the stored row re-verifies');
  assert.deepEqual(await log.get('pdec_nul_1'), rec);
  assert.deepEqual(await log.record(req, permit('pdec_nul_1'), eventCtx(runId)), rec, 'idempotent re-record');
  const a = await approvals.request({ runId, kind: 'test_change', subject: { diff: 'x\u0000y' }, requestedBy: executor, rationale: 'r\u0000' }, eventCtx(runId));
  assert.deepEqual(await approvals.get(a.approvalId), a);
  const d = await approvals.decide(a.approvalId, false, human, 'no\u0000pe', eventCtx(runId));
  assert.equal(d.rationale, 'no�pe');
  assert.deepEqual(await approvals.get(a.approvalId), d);
});
