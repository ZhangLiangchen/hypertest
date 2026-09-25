import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCtx } from '@hypertest/testkit';
import { openEnv, planInput, rejectsWith, testRun, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

test('proposePlan assigns revision max+1 per run with status proposed and emits plan.proposed', async () => {
  const runId = 'pl-1';
  const ctx = eventCtx(runId);
  const p1 = await env.board.proposePlan(planInput(runId), ctx);
  const p2 = await env.board.proposePlan(planInput(runId, { parentRevision: 1, rationale: 'replan after finding' }), ctx);
  const other = await env.board.proposePlan(planInput('pl-1b'), eventCtx('pl-1b'));
  assert.deepEqual([p1.revision, p2.revision, other.revision], [1, 2, 1]);
  assert.equal(p1.status, 'proposed');
  assert.deepEqual(p1.validationIssues, []);
  assert.equal(p1.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(await env.board.getPlan(runId, 2), p2);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['plan.proposed', 'plan.proposed']);
  assert.deepEqual(evs[1]!.payload, { planId: `plan-${runId}`, revision: 2, parentRevision: 1, status: 'proposed', proposedBy: 'agent-lead', workItems: 1, cancelWorkItems: 0, objectives: 1, readyForGate: false });
  assert.equal(await env.board.revision(runId), 2);
});

test('accepting a revision supersedes the previously accepted one (run.currentPlanRevision is not touched here)', async () => {
  const runId = 'pl-2';
  const ctx = eventCtx(runId);
  await env.runs.create(testRun(runId), ctx);
  await env.board.proposePlan(planInput(runId), ctx);
  await env.board.proposePlan(planInput(runId), ctx);
  const a1 = await env.board.decidePlan(runId, 1, 'accepted', [], ctx);
  assert.equal(a1.status, 'accepted');
  assert.equal(a1.decidedAt, '2026-01-01T00:00:00.000Z');
  assert.equal((await env.board.latestAcceptedPlan(runId))!.revision, 1);
  await env.board.decidePlan(runId, 2, 'accepted', [], ctx);
  assert.deepEqual((await env.board.listPlans(runId)).map((p) => `${p.revision}:${p.status}`), ['1:superseded', '2:accepted']);
  assert.equal((await env.board.latestAcceptedPlan(runId))!.revision, 2);
  assert.equal((await env.runs.get(runId))!.currentPlanRevision, 0);
  const accepted = (await env.events.read(runId, { types: ['plan.accepted'] })).map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(accepted.map((p) => [p['revision'], p['supersededRevisions']]), [[1, []], [2, [1]]]);
});

test('rejecting records the validation issues and emits plan.rejected with them', async () => {
  const runId = 'pl-3';
  const ctx = eventCtx(runId);
  await env.board.proposePlan(planInput(runId), ctx);
  const r = await env.board.decidePlan(runId, 1, 'rejected', ['cycle between a and b', 'unknown role'], ctx);
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.validationIssues, ['cycle between a and b', 'unknown role']);
  assert.equal(await env.board.latestAcceptedPlan(runId), undefined);
  const [ev] = await env.events.read(runId, { types: ['plan.rejected'] });
  assert.deepEqual((ev!.payload as Record<string, unknown>)['issues'], ['cycle between a and b', 'unknown role']);
});

test('a decided plan cannot be re-decided differently; repeating the same decision is idempotent', async () => {
  const runId = 'pl-4';
  const ctx = eventCtx(runId);
  await env.board.proposePlan(planInput(runId), ctx);
  await env.board.decidePlan(runId, 1, 'rejected', ['bad'], ctx);
  const seq = await env.events.lastSeq(runId);
  const err = await rejectsWith(env.board.decidePlan(runId, 1, 'accepted', [], ctx), 'precondition_failed');
  assert.equal(err.details['status'], 'rejected');
  const again = await env.board.decidePlan(runId, 1, 'rejected', ['bad'], ctx);
  assert.equal(again.status, 'rejected');
  assert.equal(await env.events.lastSeq(runId), seq, 'no event for the idempotent retry');
  await rejectsWith(env.board.decidePlan(runId, 9, 'accepted', [], ctx), 'not_found');
  await rejectsWith(env.board.decidePlan(runId, 1, 'maybe' as never, [], ctx), 'invalid_argument');
  await rejectsWith(env.board.proposePlan(planInput(runId), eventCtx('pl-elsewhere')), 'invalid_argument');
});

test('accepting a revision older than the accepted plan is refused; the newer plan stays accepted', async () => {
  const runId = 'pl-5';
  const ctx = eventCtx(runId);
  await env.board.proposePlan(planInput(runId), ctx);
  await env.board.proposePlan(planInput(runId, { parentRevision: 1 }), ctx);
  await env.board.decidePlan(runId, 2, 'accepted', [], ctx);
  const seq = await env.events.lastSeq(runId);
  const err = await rejectsWith(env.board.decidePlan(runId, 1, 'accepted', [], ctx), 'precondition_failed');
  assert.deepEqual([err.details['revision'], err.details['acceptedRevision']], [1, 2]);
  assert.deepEqual((await env.board.listPlans(runId)).map((p) => `${p.revision}:${p.status}`), ['1:proposed', '2:accepted']);
  assert.equal((await env.board.latestAcceptedPlan(runId))!.revision, 2);
  assert.equal(await env.events.lastSeq(runId), seq);
  // The stale proposal can still be rejected explicitly.
  assert.equal((await env.board.decidePlan(runId, 1, 'rejected', ['stale: revision 2 is accepted'], ctx)).status, 'rejected');
});
