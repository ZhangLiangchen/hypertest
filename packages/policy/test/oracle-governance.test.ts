import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEventSink, type ActorRef, type OracleAssertion, type OracleChangeProposal, type OracleSpec, type QualityDecision } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import { createOracleGovernance, type OracleGovernance } from '../src/index.ts';
import { MemoryDecisions, MemoryOracleStore } from './helpers.ts';

const human: ActorRef = { kind: 'human', id: 'user_alice' };
const system: ActorRef = { kind: 'system', id: 'system:requirements-import' };
const executor: ActorRef = { kind: 'agent', id: 'agent_exec', role: 'executor', modelProvider: 'openai' };
const reviewerOtherProvider: ActorRef = { kind: 'agent', id: 'agent_rev', role: 'reviewer', modelProvider: 'anthropic' };
const reviewerSameProvider: ActorRef = { kind: 'agent', id: 'agent_rev2', role: 'reviewer', modelProvider: 'openai' };
const executorPeer: ActorRef = { kind: 'agent', id: 'agent_exec2', role: 'executor', modelProvider: 'anthropic' };

const latency: OracleAssertion = { assertionId: 'p95', description: 'p95 latency below 200ms', kind: 'statistical', severity: 'P1', check: { type: 'metric_threshold', metric: 'http_latency_ms', comparator: '<', threshold: 200, aggregation: 'p95' } };
const weakened: OracleAssertion = { ...latency, description: 'p95 latency below 500ms', check: { type: 'metric_threshold', metric: 'http_latency_ms', comparator: '<', threshold: 500, aggregation: 'p95' } };

type SpecInput = Parameters<OracleGovernance['establish']>[0];
const spec = (changePolicy: Partial<OracleSpec['changePolicy']> = {}, oracleId = 'or_latency'): SpecInput => ({
  oracleId,
  scope: { components: ['api'], description: 'API latency' },
  assertions: [latency],
  authorities: [{ sourceRef: 'req://SLO-1', authority: 'approved_requirement' }],
  judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
  changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human', 'independent_agent'], ...changePolicy },
});

function setup(opts: { flip?: boolean } = {}) {
  const store = new MemoryOracleStore();
  const decisions = new MemoryDecisions();
  const events = new InMemoryEventSink();
  const gov = createOracleGovernance({ ...testDeps(), store, decisions, events, wouldFlipRecordedFailure: async () => opts.flip === true });
  return { store, decisions, events, gov };
}
const ctx = eventCtx('run_or');
const proposeWeakening = (gov: OracleGovernance, by: ActorRef = executor, fromRevision = 1, oracleId = 'or_latency') =>
  gov.propose({ runId: 'run_or', oracleId, fromRevision, proposedAssertions: [weakened], rationale: 'observed 350ms in staging', relatedEvidenceRefs: ['ev_metric_1'] }, by, ctx);

test('establish: human/system authorities create an approved revision 1; agents are refused', async () => {
  const { gov, store } = setup();
  const o = await gov.establish(spec(), human, ctx);
  assert.equal(o.status, 'approved');
  assert.equal(o.revision, 1);
  assert.deepEqual(o.approvedBy, [human]);
  assert.equal(o.approvedAt, '2026-01-01T00:00:00.000Z');
  assert.equal((await gov.establish(spec({}, 'or_other'), system, ctx)).status, 'approved');
  await assert.rejects(gov.establish(spec({}, 'or_agent'), executor, ctx), { code: 'permission_denied' });
  assert.equal(await store.getOracle('or_agent'), undefined);
});

test('establish: invalid specs are rejected', async () => {
  const { gov } = setup();
  await assert.rejects(gov.establish({ ...spec(), changePolicy: { ...spec().changePolicy, selfApprove: true as never } }, human, ctx), { code: 'invalid_argument' });
  await assert.rejects(gov.establish(spec({ approvers: [] }), human, ctx), { code: 'invalid_argument' });
  await assert.rejects(gov.establish({ ...spec(), assertions: [{ assertionId: 'x', description: '', kind: 'requirement', severity: 'P1' }] }, human, ctx), { code: 'schema_violation' });
});

test('propose: records a pending proposal, computes wouldFlipRecordedFailure and emits oracle.change_proposed', async () => {
  const { gov, events, store } = setup({ flip: true });
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  assert.equal(p.status, 'pending');
  assert.equal(p.wouldFlipRecordedFailure, true);
  assert.equal(p.fromRevision, 1);
  assert.deepEqual(p.proposedBy, executor);
  assert.match(p.proposalId, /^ocp_/);
  assert.deepEqual(await store.getOracleProposal(p.proposalId), p);
  const ev = events.ofType('oracle.change_proposed');
  assert.equal(ev.length, 1);
  assert.equal((ev[0]!.payload as { wouldFlipRecordedFailure: boolean }).wouldFlipRecordedFailure, true);
});

test('propose: default flip is false without the dependency', async () => {
  const store = new MemoryOracleStore();
  const gov = createOracleGovernance({ ...testDeps(), store });
  await gov.establish(spec(), human, ctx);
  assert.equal((await proposeWeakening(gov)).wouldFlipRecordedFailure, false);
});

test('propose: stale fromRevision ⇒ conflict; agentMayPropose=false ⇒ permission_denied for agents; bad input rejected', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  await assert.rejects(proposeWeakening(gov, executor, 0), { code: 'conflict' });
  await gov.establish(spec({ agentMayPropose: false }, 'or_locked'), human, ctx);
  await assert.rejects(proposeWeakening(gov, executor, 1, 'or_locked'), { code: 'permission_denied' });
  assert.equal((await proposeWeakening(gov, human, 1, 'or_locked')).status, 'pending', 'humans may still propose');
  await assert.rejects(proposeWeakening(gov, executor, 1, 'or_missing'), { code: 'not_found' });
  await assert.rejects(gov.propose({ runId: 'run_or', oracleId: 'or_latency', fromRevision: 1, proposedAssertions: [], rationale: 'x', relatedEvidenceRefs: [] }, executor, ctx), { code: 'invalid_argument' });
  await assert.rejects(gov.propose({ runId: 'run_or', oracleId: 'or_latency', fromRevision: 1, proposedAssertions: [latency, latency], rationale: 'x', relatedEvidenceRefs: [] }, executor, ctx), { code: 'invalid_argument' });
});

test('I8 decide: self-approval is forbidden and leaves the oracle unchanged', async () => {
  const { gov, store, events } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, executor, 'I think it is fine', ctx), { code: 'permission_denied', message: /self-approval/ });
  assert.equal((await store.getOracle('or_latency'))!.revision, 1);
  assert.equal((await store.getOracleProposal(p.proposalId))!.status, 'pending');
  assert.equal(events.ofType('oracle.change_approved').length, 0);
});

test('I8 decide: an agent sharing the proposer model provider cannot approve', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, reviewerSameProvider, 'looks right', ctx), (e: { code?: string; details?: { rule?: string } }) => e.code === 'permission_denied' && e.details?.rule === 'same_provider');
});

test('I8 decide: an agent with the proposer role cannot approve even from another provider', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, executorPeer, 'peer ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'same_role');
});

test('I8 decide: agents are refused when independent_agent is not an approver kind; agents without a provider are refused', async () => {
  const { gov } = setup();
  await gov.establish(spec({ approvers: ['human'] }), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, reviewerOtherProvider, 'ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'approver_kind');
  const { gov: gov2 } = setup();
  await gov2.establish(spec(), human, ctx);
  const p2 = await proposeWeakening(gov2);
  await assert.rejects(gov2.decide(p2.proposalId, true, { kind: 'agent', id: 'agent_anon', role: 'reviewer' }, 'ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'provider_unknown');
  await assert.rejects(gov2.decide(p2.proposalId, true, system, 'ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'system_approver');
});

test('I8 decide: humans are refused when not an approver kind', async () => {
  const { gov } = setup();
  await gov.establish(spec({ approvers: ['independent_agent'] }), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, { kind: 'human', id: 'user_bob' }, 'ok', ctx), { code: 'permission_denied' });
});

test('I8 decide: flipping a recorded failure requires a human when humans are approvers', async () => {
  const { gov, store } = setup({ flip: true });
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, reviewerOtherProvider, 'independent, but not enough', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'flip_requires_human');
  assert.equal((await store.getOracle('or_latency'))!.revision, 1);
  const r = await gov.decide(p.proposalId, true, { kind: 'human', id: 'user_bob' }, 'SLO renegotiated with product', ctx);
  assert.equal(r.newRevision!.revision, 2);
});

test('I8 decide: flipping a recorded failure with agent-only approvers needs an independent agent from another provider', async () => {
  const { gov } = setup({ flip: true });
  await gov.establish(spec({ approvers: ['independent_agent'] }), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, reviewerSameProvider, 'ok', ctx), { code: 'permission_denied' });
  const r = await gov.decide(p.proposalId, true, reviewerOtherProvider, 'independently verified the SLO document', ctx);
  assert.equal(r.proposal.status, 'approved');
});

test('approval creates a superseding revision and marks decisions on the old revision needs_reassessment', async () => {
  const { gov, store, decisions, events } = setup();
  await gov.establish(spec(), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_old_b', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision, { decisionId: 'dec_old_a', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision, { decisionId: 'dec_other', oracleRevisions: { or_x: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  const r = await gov.decide(p.proposalId, true, reviewerOtherProvider, 'SLO doc says 500ms', ctx);
  assert.equal(r.proposal.status, 'approved');
  assert.deepEqual(r.proposal.decidedBy, reviewerOtherProvider);
  assert.equal(r.proposal.decisionRationale, 'SLO doc says 500ms');
  assert.equal(r.newRevision!.revision, 2);
  assert.equal(r.newRevision!.supersedes, 1);
  assert.equal(r.newRevision!.status, 'approved');
  assert.deepEqual(r.newRevision!.approvedBy, [reviewerOtherProvider]);
  assert.deepEqual(r.newRevision!.assertions, [weakened]);
  // history is never rewritten
  assert.deepEqual((await store.getOracle('or_latency', 1))!.assertions, [latency]);
  assert.deepEqual(r.invalidatedDecisions, ['dec_old_a', 'dec_old_b']);
  assert.match(decisions.marked.get('dec_old_a')!, /revision 1 superseded by revision 2/);
  assert.equal(decisions.marked.has('dec_other'), false);
  const ev = events.ofType('oracle.change_approved');
  assert.equal(ev.length, 1);
  assert.deepEqual((ev[0]!.payload as { invalidatedDecisions: string[] }).invalidatedDecisions, ['dec_old_a', 'dec_old_b']);
});

test('approval without invalidatesPriorDecisions (and no flip) leaves prior decisions alone', async () => {
  const { gov, decisions } = setup();
  await gov.establish(spec({ invalidatesPriorDecisions: false }), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_keep', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  const r = await gov.decide(p.proposalId, true, human, 'ok', ctx);
  assert.deepEqual(r.invalidatedDecisions, []);
  assert.equal(decisions.marked.size, 0);
});

test('a flip invalidates prior decisions even when the change policy does not ask for it', async () => {
  const { gov, decisions } = setup({ flip: true });
  await gov.establish(spec({ invalidatesPriorDecisions: false }), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_fail', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  const r = await gov.decide(p.proposalId, true, human, 'ok', ctx);
  assert.deepEqual(r.invalidatedDecisions, ['dec_fail']);
});

test('decide twice ⇒ precondition_failed; rejection emits oracle.change_rejected and creates no revision', async () => {
  const { gov, store, events } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  const r = await gov.decide(p.proposalId, false, human, 'no evidence the SLO changed', ctx);
  assert.equal(r.proposal.status, 'rejected');
  assert.equal(r.newRevision, undefined);
  assert.equal((await store.getOracle('or_latency'))!.revision, 1);
  assert.equal(events.ofType('oracle.change_rejected').length, 1);
  await assert.rejects(gov.decide(p.proposalId, true, human, 'retry', ctx), { code: 'precondition_failed' });
  await assert.rejects(gov.decide('ocp_missing', true, human, 'x', ctx), { code: 'not_found' });
});

test('the proposer may withdraw (reject) its own proposal', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  assert.equal((await gov.decide(p.proposalId, false, executor, 'withdrawn', ctx)).proposal.status, 'rejected');
});

test('a stale proposal (oracle revised meanwhile) cannot be approved', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  const p1 = await proposeWeakening(gov);
  const p2 = await proposeWeakening(gov);
  await gov.decide(p1.proposalId, true, human, 'first', ctx);
  await assert.rejects(gov.decide(p2.proposalId, true, { kind: 'human', id: 'user_bob' }, 'second', ctx), { code: 'conflict' });
});

test('a store failure during approval leaves the proposal pending (no event emitted)', async () => {
  const { gov, store, events } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  store.failNextSave = true;
  await assert.rejects(gov.decide(p.proposalId, true, human, 'ok', ctx), /store failure/);
  assert.equal((await store.getOracleProposal(p.proposalId) as OracleChangeProposal).status, 'pending');
  assert.equal(events.ofType('oracle.change_approved').length, 0);
});

// ----------------------------------------------------------------------------- adversarial review regressions

test('I8 concurrency: two concurrent approvals of one proposal ⇒ exactly one revision, the other precondition_failed', async () => {
  const { gov, store, events } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  store.delayMs = 5;
  const results = await Promise.allSettled([
    gov.decide(p.proposalId, true, { kind: 'human', id: 'user_bob' }, 'ok', ctx),
    gov.decide(p.proposalId, true, { kind: 'human', id: 'user_carol' }, 'ok', ctx),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code?: string }).code, 'precondition_failed');
  assert.deepEqual(store.oracles.filter((o) => o.oracleId === 'or_latency').map((o) => o.revision), [1, 2]);
  assert.equal(events.ofType('oracle.change_approved').length, 1);
});

test('I8 concurrency: two governance instances (two processes) racing on one store ⇒ the store CAS lets one revision through', async () => {
  const store = new MemoryOracleStore();
  const shared = testDeps(); // one id space, as ULIDs would give two real processes
  const a = createOracleGovernance({ ...shared, store });
  const b = createOracleGovernance({ ...shared, store });
  await a.establish(spec(), human, ctx);
  const p1 = await proposeWeakening(a);
  const p2 = await b.propose({ runId: 'run_or', oracleId: 'or_latency', fromRevision: 1, proposedAssertions: [{ ...latency, description: 'other' }], rationale: 'r2', relatedEvidenceRefs: [] }, executor, ctx);
  store.delayMs = 10; // both deciders read revision 1 before either writes
  const results = await Promise.allSettled([
    a.decide(p1.proposalId, true, { kind: 'human', id: 'user_bob' }, 'ok', ctx),
    b.decide(p2.proposalId, true, { kind: 'human', id: 'user_carol' }, 'ok', ctx),
  ]);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0]!.reason as { code?: string }).code, 'conflict');
  assert.deepEqual(store.oracles.map((o) => o.revision), [1, 2]);
  const statuses = [(await store.getOracleProposal(p1.proposalId))!.status, (await store.getOracleProposal(p2.proposalId))!.status].sort();
  assert.deepEqual(statuses, ['approved', 'pending']);
});

test('establish only creates: re-establishing an existing oracle is a conflict (changes go through propose/decide)', async () => {
  const { gov, store } = setup();
  await gov.establish(spec(), human, ctx);
  await assert.rejects(gov.establish({ ...spec(), assertions: [weakened] }, { kind: 'system', id: 'system:import' }, ctx), { code: 'conflict' });
  assert.deepEqual(store.oracles.map((o) => o.revision), [1]);
  assert.deepEqual((await store.getOracle('or_latency'))!.assertions, [latency]);
});

test('I8: a failure recorded after the proposal is re-checked at decision time (flip requires a human, decisions invalidated)', async () => {
  let flip = false;
  const store = new MemoryOracleStore();
  const decisions = new MemoryDecisions();
  const events = new InMemoryEventSink();
  const gov = createOracleGovernance({ ...testDeps(), store, decisions, events, wouldFlipRecordedFailure: async () => flip });
  await gov.establish(spec({ invalidatesPriorDecisions: false }), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_fail_late', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  assert.equal(p.wouldFlipRecordedFailure, false);
  flip = true; // the failing latency run is recorded after the proposal
  await assert.rejects(gov.decide(p.proposalId, true, reviewerOtherProvider, 'looks fine', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'flip_requires_human');
  const r = await gov.decide(p.proposalId, true, { kind: 'human', id: 'user_bob' }, 'SLO renegotiated', ctx);
  assert.deepEqual(r.invalidatedDecisions, ['dec_fail_late']);
  assert.equal((events.ofType('oracle.change_approved')[0]!.payload as { wouldFlipRecordedFailure: boolean }).wouldFlipRecordedFailure, true);
  assert.equal(r.proposal.wouldFlipRecordedFailure, false, 'the stored proposal content is immutable');
});

test('I8: agent independence is fail-closed on unknown roles', async () => {
  const { gov } = setup();
  await gov.establish(spec(), human, ctx);
  const p = await proposeWeakening(gov);
  await assert.rejects(gov.decide(p.proposalId, true, { kind: 'agent', id: 'agent_norole', modelProvider: 'anthropic' }, 'ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'role_unknown');
  const q = await proposeWeakening(gov, { kind: 'agent', id: 'agent_x', modelProvider: 'openai' });
  await assert.rejects(gov.decide(q.proposalId, true, reviewerOtherProvider, 'ok', ctx), (e: { details?: { rule?: string } }) => e.details?.rule === 'role_unknown');
});

test('an approval interrupted after the revision write is resumed by the same approver (no second revision)', async () => {
  const { gov, store, decisions, events } = setup();
  await gov.establish(spec(), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_r', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  store.failNextProposalSave = true;
  await assert.rejects(gov.decide(p.proposalId, true, human, 'ok', ctx), /proposal store failure/);
  assert.equal((await store.getOracleProposal(p.proposalId))!.status, 'pending');
  assert.deepEqual(store.oracles.map((o) => o.revision), [1, 2]);
  assert.ok(decisions.marked.has('dec_r'), 'invalidation happens before the proposal is closed');
  // someone else cannot complete it (the revision now differs from the proposal base)
  await assert.rejects(gov.decide(p.proposalId, true, { kind: 'human', id: 'user_bob' }, 'ok', ctx), { code: 'conflict' });
  const r = await gov.decide(p.proposalId, true, human, 'ok (retry)', ctx);
  assert.equal(r.proposal.status, 'approved');
  assert.equal(r.newRevision!.revision, 2);
  assert.deepEqual(store.oracles.map((o) => o.revision), [1, 2]);
  assert.equal(events.ofType('oracle.change_approved').length, 1);
});

test('a failed invalidation leaves the proposal pending so a retry completes it', async () => {
  const { gov, store, decisions } = setup();
  await gov.establish(spec(), human, ctx);
  decisions.decisions.push({ decisionId: 'dec_x', oracleRevisions: { or_latency: 1 } } as unknown as QualityDecision);
  const p = await proposeWeakening(gov);
  decisions.failNextMark = true;
  await assert.rejects(gov.decide(p.proposalId, true, human, 'ok', ctx), /decision store failure/);
  assert.equal((await store.getOracleProposal(p.proposalId))!.status, 'pending');
  const r = await gov.decide(p.proposalId, true, human, 'ok', ctx);
  assert.deepEqual(r.invalidatedDecisions, ['dec_x']);
  assert.ok(decisions.marked.has('dec_x'));
});
