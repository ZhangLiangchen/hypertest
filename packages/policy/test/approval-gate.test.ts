/**
 * E[8] / coverage[0]: the human approval loop of action permits. approval_required ⇒ an approval request bound to the
 * exact action digest; an independent human/system approval is consumed EXACTLY ONCE by the policy engine (the request
 * carries or finds it by digest) ⇒ allow; a denial or an expiry ⇒ deny; agents never decide action approvals.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FixedClock, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  ApprovalGatedPolicyEngine, BuiltinPolicyEngine, DEFAULT_POLICY_RULES, actionDigest, approvalActionDigest, createApprovalService, type ActionRequest, type ApprovalService,
} from '../src/index.ts';
import { SqlEventSink, cap, migrations, request } from './helpers.ts';

let db: SqlDatabase;
let dispose: () => Promise<void>;
let sink: SqlEventSink;
let approvals: ApprovalService;
let clock: FixedClock;
let gate: ApprovalGatedPolicyEngine;

before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations }));
  sink = new SqlEventSink(db);
  const deps = testDeps();
  clock = deps.clock as FixedClock;
  approvals = createApprovalService({ ...deps, db, events: sink });
  let n = 0;
  const inner = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@gate', { clock, newId: () => `pdec_${++n}` });
  gate = new ApprovalGatedPolicyEngine(inner, { approvals, clock, approvalTtlMs: 60_000 });
});
after(async () => {
  await dispose();
});

/** env.deploy on a local environment: destructive/critical ⇒ approve-critical-risk ⇒ approval_required. */
function deploy(runId: string, requestId: string, buildRef = 'registry.local/app@sha256:abc'): ActionRequest {
  return request({
    requestId, runId, capability: cap({ runId }), tool: 'env.deploy', effect: 'destructive', riskClass: 'critical', resources: ['env/svc'], environmentClass: 'local',
    input: { environmentId: 'svc', buildRef },
  });
}

const human = (id: string) => ({ kind: 'human' as const, id });

test('approval_required ⇒ an approval request bound to the exact action digest (tool, args digest, target, risk, run, work item); a retry before the decision reuses it', async () => {
  const req = deploy('run_gate_1', 'sess:1:c1');
  const p = await gate.evaluate(req);
  assert.equal(p.decision, 'approval_required');
  assert.ok(p.approvalId, 'the permit names the approval request');
  assert.ok(p.reasons.some((r) => r.includes('rule:approve-critical-risk')));
  const a = (await approvals.get(p.approvalId))!;
  assert.equal(a.kind, 'action');
  assert.equal(a.status, 'pending');
  assert.equal(approvalActionDigest(a), actionDigest(req));
  const subject = a.subject as Record<string, unknown>;
  assert.deepEqual([subject['tool'], subject['riskClass'], subject['effect'], subject['resources'], subject['workItemId'], subject['requestId']], ['env.deploy', 'critical', 'destructive', ['env/svc'], 'wi_1', 'sess:1:c1']);
  assert.deepEqual(subject['input'], { environmentId: 'svc', buildRef: 'registry.local/app@sha256:abc' }, 'the decider sees the (redacted) arguments');
  assert.equal(a.requestedBy.id, 'agent_1');
  // the same action again (a retry while pending): the same request, no duplicate
  const again = await gate.evaluate(deploy('run_gate_1', 'sess:2:c1'));
  assert.equal(again.decision, 'approval_required');
  assert.equal(again.approvalId, p.approvalId);
  assert.equal((await approvals.list({ runId: 'run_gate_1' })).length, 1);
  // another action (other arguments) is another approval
  const other = await gate.evaluate(deploy('run_gate_1', 'sess:3:c1', 'registry.local/app@sha256:def'));
  assert.notEqual(other.approvalId, p.approvalId);
});

test('an independent human approval is consumed EXACTLY ONCE: the approved action is allowed (approvalId on the permit); a replay of the same request stays allowed; any other request needs a new approval', async () => {
  const runId = 'run_gate_2';
  const first = await gate.evaluate(deploy(runId, 'sess:1:c1'));
  await assert.rejects(approvals.decide(first.approvalId!, true, { kind: 'agent', id: 'agent_reviewer', role: 'reviewer', modelProvider: 'other' }, 'looks fine', eventCtx(runId)), (e) => isHypertestError(e, 'permission_denied'), 'agents never decide action approvals');
  await assert.rejects(approvals.decide(first.approvalId!, true, { kind: 'human', id: 'agent_1' }, 'self', eventCtx(runId)), (e) => isHypertestError(e, 'permission_denied'), 'the requester never decides its own request');
  await approvals.decide(first.approvalId!, true, human('alice'), 'deploy the fixed build', eventCtx(runId));

  const allowed = await gate.evaluate(deploy(runId, 'sess:4:c1'));
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.approvalId, first.approvalId);
  assert.ok(allowed.reasons.some((r) => r.includes(`approval:${first.approvalId}: granted by human:alice`)));
  const consumed = (await approvals.consumption!(first.approvalId!))!;
  assert.deepEqual([consumed.consumedBy, consumed.digest], ['sess:4:c1', actionDigest(deploy(runId, 'sess:4:c1'))]);
  const events = (await sink.rows(runId)).map((e) => e.event_type);
  assert.ok(events.includes('approval.consumed'));
  // a durable replay of the SAME call (same request id) finds its own consumption: still allowed
  assert.equal((await gate.evaluate(deploy(runId, 'sess:4:c1'))).decision, 'allow');
  // a second, different call of the same action: the approval is spent ⇒ a new approval request
  const second = await gate.evaluate(deploy(runId, 'sess:5:c1'));
  assert.equal(second.decision, 'approval_required');
  assert.notEqual(second.approvalId, first.approvalId);
});

test('two concurrent consumers of one approval: exactly one wins (the other needs its own approval)', async () => {
  const runId = 'run_gate_race';
  const p = await gate.evaluate(deploy(runId, 'sess:1:c1'));
  await approvals.decide(p.approvalId!, true, human('bob'), 'ok', eventCtx(runId));
  const outs = await Promise.all([approvals.consume!(p.approvalId!, { requestId: 'r-a', digest: 'd' }, eventCtx(runId)), approvals.consume!(p.approvalId!, { requestId: 'r-b', digest: 'd' }, eventCtx(runId))]);
  assert.deepEqual(outs.map((o) => o.consumed).sort(), [false, true]);
  // the consumption is append-only: no UPDATE / DELETE
  await assert.rejects(db.query(`DELETE FROM ht_approval_consumptions WHERE approval_id = $1`, [p.approvalId!]), /append-only/);
  await assert.rejects(db.query(`UPDATE ht_approval_consumptions SET consumed_by = 'x' WHERE approval_id = $1`, [p.approvalId!]), /append-only/);
});

test('reject ⇒ denied (a retry of the same action is denied, never re-requested); a named approval of another action is refused', async () => {
  const runId = 'run_gate_3';
  const p = await gate.evaluate(deploy(runId, 'sess:1:c1'));
  await approvals.decide(p.approvalId!, false, human('carol'), 'not this build', eventCtx(runId));
  const denied = await gate.evaluate(deploy(runId, 'sess:2:c1'));
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.reasons.some((r) => r.includes(`approval_denied: approval ${p.approvalId} of this action was denied by human:carol (not this build)`)));
  assert.equal((await approvals.list({ runId })).length, 1, 'no new request after a denial');
  // a request naming an approval of ANOTHER action (other arguments) is refused with the exact reason
  const other = await gate.evaluate({ ...deploy(runId, 'sess:3:c1', 'registry.local/app@sha256:999'), approvalId: p.approvalId! });
  assert.equal(other.decision, 'deny');
  assert.ok(other.reasons.some((r) => r.startsWith(`approval_mismatch: approval ${p.approvalId} authorizes another action`)));
});

test('expiry ⇒ denied: a pending request past its window is recorded expired; an approval decided after… is refused too', async () => {
  const runId = 'run_gate_4';
  const p = await gate.evaluate(deploy(runId, 'sess:1:c1'));
  clock.advance(60_001);
  const late = await gate.evaluate(deploy(runId, 'sess:2:c1'));
  assert.equal(late.decision, 'deny');
  assert.ok(late.reasons.some((r) => r.includes(`approval_expired: approval ${p.approvalId}`)));
  assert.equal((await approvals.get(p.approvalId!))!.status, 'expired');
  assert.ok((await sink.rows(runId)).some((e) => e.event_type === 'approval.expired'));
  await assert.rejects(approvals.decide(p.approvalId!, true, human('dave'), 'too late', eventCtx(runId)), (e) => isHypertestError(e, 'precondition_failed'));
  // an approved approval whose window ended is not usable either
  const q = await gate.evaluate(deploy('run_gate_5', 'sess:1:c1'));
  await approvals.decide(q.approvalId!, true, human('erin'), 'ok', eventCtx('run_gate_5'));
  clock.advance(60_001);
  const stale = await gate.evaluate(deploy('run_gate_5', 'sess:2:c1'));
  assert.equal(stale.decision, 'deny');
  assert.ok(stale.reasons.some((r) => r.startsWith(`approval_expired: approval ${q.approvalId}`)));
});

test('only approval_required before_action decisions are gated: allow and deny pass through unchanged, and the revision is the inner engine\'s', async () => {
  const read = await gate.evaluate(request({ requestId: 'r-read' }));
  assert.equal(read.decision, 'allow');
  assert.equal(read.approvalId, undefined);
  const prod = await gate.evaluate(request({ requestId: 'r-prod', tool: 'env.restart', effect: 'destructive', riskClass: 'high', resources: ['env/p'], environmentClass: 'production' }));
  assert.equal(prod.decision, 'deny');
  assert.equal(gate.revision, 'builtin@gate');
});

test('(review) a forged action approval never authorizes another action: an agent-filed request whose subject DESCRIBES a harmless call but carries the digest of a critical one is refused even after a human approves what it shows', async () => {
  const runId = 'run_gate_forged';
  const target = deploy(runId, 'sess:1:c1');
  const digest = actionDigest(target);
  // the agent files an `action` approval (request_approval): the decider sees a harmless GET — the digest is the deploy's
  const forged = await approvals.request(
    {
      runId, kind: 'action', requestedBy: { kind: 'agent', id: 'agent_1', role: 'environment' }, rationale: 'read the health page',
      subject: { actionDigest: digest, tool: 'http.request', effect: 'read', riskClass: 'low', resources: ['env/svc'], workItemId: 'wi_1', environmentClass: 'local', input: { method: 'GET', environmentId: 'svc', path: '/health' }, expiresAt: '2099-01-01T00:00:00.000Z' },
    },
    eventCtx(runId),
  );
  await approvals.decide(forged.approvalId, true, human('alice'), 'a GET of /health is fine', eventCtx(runId));
  // looked up by digest: the forged approval is not usable — the deploy needs (and gets) its own approval request
  const p = await gate.evaluate(target);
  assert.equal(p.decision, 'approval_required', 'the forged approval does not authorize the deploy');
  assert.notEqual(p.approvalId, forged.approvalId);
  assert.equal(await approvals.consumption!(forged.approvalId), undefined, 'never consumed');
  // named explicitly: refused with the exact reason
  const named = await gate.evaluate({ ...deploy(runId, 'sess:2:c1'), approvalId: forged.approvalId });
  assert.equal(named.decision, 'deny');
  assert.ok(named.reasons.some((r) => r.startsWith(`approval_mismatch: approval ${forged.approvalId} does not describe the action it is bound to`)), named.reasons.join('; '));
  // an approval without a decision window is not usable either (fail closed)
  const windowless = await approvals.request(
    { runId, kind: 'action', requestedBy: { kind: 'agent', id: 'agent_1' }, rationale: 'deploy', subject: { actionDigest: digest, tool: 'env.deploy', effect: 'destructive', riskClass: 'critical', resources: ['env/svc'], workItemId: 'wi_1', environmentClass: 'local', input: { environmentId: 'svc', buildRef: 'registry.local/app@sha256:abc' } } },
    eventCtx(runId),
  );
  await approvals.decide(windowless.approvalId, true, human('alice'), 'ok', eventCtx(runId));
  const w = await gate.evaluate({ ...deploy(runId, 'sess:3:c1'), approvalId: windowless.approvalId });
  assert.equal(w.decision, 'deny');
  assert.ok(w.reasons.some((r) => r.includes('has no decision window')), w.reasons.join('; '));
  // the gate's own (truthful) request for the deploy is still the one a human can approve
  await approvals.decide(p.approvalId!, true, human('bob'), 'deploy it', eventCtx(runId));
  const ok = await gate.evaluate(deploy(runId, 'sess:4:c1'));
  assert.deepEqual([ok.decision, ok.approvalId], ['allow', p.approvalId]);
});

test('(review) the action digest is computed over the stored form of the arguments: an input with U+0000 still matches its own approval', async () => {
  const runId = 'run_gate_nul';
  const req = deploy(runId, 'sess:1:c1', 'registry.local/app\u0000@sha256:abc');
  const p = await gate.evaluate(req);
  assert.equal(p.decision, 'approval_required');
  await approvals.decide(p.approvalId!, true, human('alice'), 'ok', eventCtx(runId));
  const ok = await gate.evaluate(deploy(runId, 'sess:2:c1', 'registry.local/app\u0000@sha256:abc'));
  assert.deepEqual([ok.decision, ok.approvalId], ['allow', p.approvalId]);
});
