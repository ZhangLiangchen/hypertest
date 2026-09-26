/**
 * The PoC acceptance graders on synthetic trial data (the shapes the real stores return): each passes on a faithful
 * trajectory and fails on the violation it owns; a missing probe makes the trial ungradable (precondition_failed).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { BlackboardRecord, Hypothesis, Review, TestArtifact, WorkItem } from '@hypertest/domain';
import type { RunReport } from '@hypertest/control';
import {
  GRADERS, POC_GRADERS, causalChainGrader, contextIsolationGrader, independentReviewGrader, insufficientDataNotPassedGrader, loadJobReattachedGrader, maxConcurrent,
  modelFallbackGrader, noOrphanOperationsGrader, offloadBoundedGrader, pocAWorkflowGrader, pocBWorkflowGrader, pocCWorkflowGrader, recoveryAuditGrader,
  reportTracesToEvidenceGrader, resolveGrader, runningIntervals, singleLeaseOwnerGrader, testChangeGovernedGrader, type BrainObservation, type Grader, type GraderResult,
} from '../src/index.ts';
import { Log, RUN_ID, T0, ctx, data, decision, evidence, finding, operation, task } from './helpers.ts';

interface Stores {
  reviews?: Array<BlackboardRecord<Review>>;
  hypotheses?: Array<BlackboardRecord<Hypothesis>>;
  artifacts?: TestArtifact[];
  approvals?: Array<{ approvalId: string; kind: string; status: string }>;
  proposals?: Array<{ proposalId: string; status: string }>;
}

/** A grading instance stub: the blackboard/spec/approval reads the PoC graders use. */
function fakeHt(s: Stores = {}): unknown {
  return {
    listApprovals: async () => s.approvals ?? [],
    services: {
      blackboard: {
        query: async (q: { recordType: string }) => (q.recordType === 'review' ? (s.reviews ?? []) : q.recordType === 'hypothesis' ? (s.hypotheses ?? []) : []),
      },
      specs: { listTestArtifacts: async () => s.artifacts ?? [], listOracleProposals: async () => s.proposals ?? [] },
    },
  };
}

function record<T>(recordId: string, recordType: string, payload: T, extra: Partial<BlackboardRecord<T>> = {}): BlackboardRecord<T> {
  return { recordId, lineageId: recordId, recordType: recordType as never, runId: RUN_ID, revision: 1, version: 1, createdBy: 'ag_rev', evidenceRefs: [], createdAt: new Date(T0).toISOString(), payload, ...extra };
}

function review(recordId: string, verdict: Review['verdict'], provider: string, subject: Review['subjectRef'], checked: string[] = ['ev_tr']): BlackboardRecord<Review> {
  return record(recordId, 'review', { subjectRef: subject, verdict, rationale: 'r', checkedEvidenceRefs: checked, reviewerRole: 'reviewer', modelProvider: provider }, { createdBy: 'ag_rev' });
}

function item(workItemId: string, role: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId, runId: RUN_ID, kind: 'task', origin: { kind: 'plan', planRevision: 1, localId: workItemId }, title: workItemId, objective: 'o', role, objectiveIds: [],
    capabilityRequirements: [], inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 } as never, priority: 50,
    state: 'completed', depth: 0, fingerprint: `fp_${workItemId}`, resourceClaims: [], attempts: 0, waitingOn: [], createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    ...extra,
  };
}

function artifact(artifactId: string, agentId: string): TestArtifact {
  return {
    artifactId, runId: RUN_ID, revision: 1, path: 'test/x.test.js', artifactDigest: 'd', sourceType: 'generated', generatedBy: { agentId }, oracleRefs: [], runner: { framework: 'node_test', selector: 'x' },
    validations: {}, approvalState: 'validated', createdAt: new Date(T0).toISOString(),
  };
}

async function grade(grader: Grader, c: Parameters<Grader>[0]): Promise<GraderResult> {
  return grader(c);
}

function obs(extra: Partial<BrainObservation>): BrainObservation {
  return { provider: 'p', role: 'executor', workItemId: 'wi_x', kind: 'task', step: 0, requestBytes: 1000, maxMessageBytes: 500, assistantMessages: 0, toolMessages: 0, sawLeadTrace: false, ...extra };
}

describe('registry', () => {
  test('every PoC grader is resolvable by id from GRADERS', () => {
    for (const id of Object.keys(POC_GRADERS)) {
      assert.equal(GRADERS[id], POC_GRADERS[id], id);
      assert.equal(resolveGrader(id).id, id);
    }
    assert.deepEqual(Object.keys(POC_GRADERS).sort(), [
      'causalChain', 'contextIsolation', 'independentReview', 'insufficientDataNotPassed', 'loadJobReattached', 'modelFallback', 'noOrphanOperations', 'offloadBounded',
      'pocAWorkflow', 'pocBWorkflow', 'pocCWorkflow', 'recoveryAudit', 'reportTracesToEvidence', 'singleLeaseOwner', 'testChangeGoverned',
    ]);
  });
});

describe('running intervals and concurrency (L0 seq order)', () => {
  test('intervals open on running and close on any other state; concurrency is counted over the given items only', () => {
    const log = new Log().work('a', 'running').work('b', 'running').work('c', 'running').work('a', 'completed').work('b', 'waiting').work('b', 'running').work('b', 'completed');
    const iv = runningIntervals(log.events);
    assert.deepEqual(iv.get('a'), [[1, 4]]);
    assert.deepEqual(iv.get('b'), [[2, 5], [6, 7]]);
    assert.deepEqual(iv.get('c'), [[3, Number.MAX_SAFE_INTEGER]], 'still running');
    assert.equal(maxConcurrent(log.events, new Set(['a', 'b', 'c'])), 3);
    assert.equal(maxConcurrent(log.events, new Set(['a', 'b'])), 2);
    assert.equal(maxConcurrent(log.events, new Set(['a'])), 1);
    assert.equal(maxConcurrent(log.events, new Set()), 0);
  });
});

describe('singleLeaseOwner', () => {
  const claimed = (log: Log, id: string, token: number, from = 'ready') => log.add('work.claimed', { workItemId: id, from, to: 'claimed', fencingToken: token, ownerId: 'w' });
  const moved = (log: Log, id: string, from: string, to: string, token?: number) => log.add(to === 'running' ? 'work.started' : `work.${to}`, { workItemId: id, from, to, ...(token !== undefined ? { fencingToken: token } : {}) });

  test('claims from ready with increasing tokens, transitions under the current claim, requeue drops the claim', async () => {
    const log = new Log();
    claimed(log, 'wi_1', 1);
    moved(log, 'wi_1', 'claimed', 'running', 1);
    log.add('work.requeued', { workItemId: 'wi_1', from: 'running', to: 'ready' });
    claimed(log, 'wi_1', 2);
    moved(log, 'wi_1', 'claimed', 'running', 2);
    moved(log, 'wi_1', 'running', 'waiting', 2);
    // observeWaiting re-takes the waiting item's claim (a new token through work.updated)
    log.add('work.updated', { workItemId: 'wi_1', from: 'waiting', to: 'waiting', fencingToken: 3 });
    moved(log, 'wi_1', 'waiting', 'running', 3);
    moved(log, 'wi_1', 'running', 'completed', 3);
    const r = await grade(singleLeaseOwnerGrader, ctx(data({ events: log.events })));
    assert.deepEqual([r.pass, r.detail], [true, '2 claim(s), one owner at a time, monotonic fencing']);
  });

  test('a claim while another lives, a stale writer and a non-increasing token are each reported', async () => {
    const log = new Log();
    claimed(log, 'wi_1', 5);
    moved(log, 'wi_1', 'claimed', 'running', 5);
    claimed(log, 'wi_1', 6, 'running');
    moved(log, 'wi_1', 'running', 'completed', 5);
    log.add('work.requeued', { workItemId: 'wi_2', from: 'running', to: 'ready' });
    claimed(log, 'wi_2', 3);
    log.add('work.requeued', { workItemId: 'wi_2', from: 'claimed', to: 'ready' });
    claimed(log, 'wi_2', 3);
    const r = await grade(singleLeaseOwnerGrader, ctx(data({ events: log.events })));
    assert.equal(r.pass, false);
    assert.equal(r.detail, 'wi_1 claimed from running (seq 3); wi_1 work.completed with token 5 while the claim holds 6 (seq 4); wi_2 re-claimed with a non-increasing token 3 (seq 8)');
  });
});

describe('side effects and recovery', () => {
  test('noOrphanOperations: settled operations pass; an acknowledged one and an orphaned late receipt fail', async () => {
    assert.equal((await grade(noOrphanOperationsGrader, ctx(data({ operations: [operation('op_1', 'verified'), operation('op_2', 'not_applied')] })))).pass, true);
    const bad = await grade(noOrphanOperationsGrader, ctx(data({ operations: [operation('op_1', 'acknowledged')], events: new Log().add('operation.late_receipt', { operationId: 'op_9', disposition: 'orphaned' }).events })));
    assert.deepEqual([bad.pass, bad.detail], [false, 'op_1 (env.restart, acknowledged); op_9 (late receipt after a re-dispatch: orphaned external job)']);
  });

  test('loadJobReattached: one completed job with one worker per verified load.start operation; a re-created job or an unsettled one fails; no probe ⇒ ungradable', async () => {
    const ops = [operation('op_load', 'verified', { operationType: 'load.start' })];
    const good = await grade(loadJobReattachedGrader, ctx(data({ operations: ops, probes: { loadJobs: [{ operationId: 'op_load', pid: 42, state: 'completed' }] } })));
    assert.deepEqual([good.pass, good.detail], [true, 'all 4 checks passed']);
    const recreated = await grade(loadJobReattachedGrader, ctx(data({ operations: ops, probes: { loadJobs: [{ operationId: 'op_load', pid: 42, state: 'completed' }, { operationId: 'op_other', pid: 43, state: 'completed' }] } })));
    assert.deepEqual([recreated.pass, recreated.detail], [false, '1/4 checks failed: one job directory per load.start operation: 2 job(s) for 1 operation(s)']);
    const running = await grade(loadJobReattachedGrader, ctx(data({ operations: [operation('op_load', 'acknowledged', { operationType: 'load.start' })], probes: { loadJobs: [{ operationId: 'op_load', pid: 42, state: 'running' }] } })));
    assert.equal(running.detail, '1/4 checks failed: every load job completed and its operation verified: op_load acknowledged, job op_load running');
    await assert.rejects(Promise.resolve().then(() => loadJobReattachedGrader(ctx(data()))), (e: { code?: string; message: string }) => e.code === 'precondition_failed' && /needs the fixture probe 'loadJobs'/.test(e.message));
  });

  test('recoveryAudit: a restart explained by the report and settled operations; no restart or an empty recovery log fails', async () => {
    const report = { recovery: [{ at: 'x', detail: 'work.requeued wi_1' }] } as unknown as RunReport;
    const harness = { restarts: 1, injectedModelTimeouts: 0, duplicateDelivery: false, timedOut: false };
    assert.equal((await grade(recoveryAuditGrader, ctx(data({ report, harness, operations: [operation('op_1', 'verified')] })))).pass, true);
    const none = await grade(recoveryAuditGrader, ctx(data({ report: { recovery: [] } as unknown as RunReport })));
    assert.equal(none.detail, '2/3 checks failed: the process was killed and resumed: 0 restart(s); the report explains the recovery (requeues, reconciliations): empty recovery log');
  });
});

describe('context and model routing', () => {
  test('offloadBounded: offloaded tool output + bounded requests after it pass; an unbounded request or no offload fails', async () => {
    const t = task({ chaos: { largeOutputBytes: 2_000_000 } });
    const ev = [evidence('ev_out', 'stdout', { artifact: { uri: 'u', sha256: 's', size: 2_100_000, mimeType: 'text/plain' } }), evidence('ev_off', 'tool-output', { artifact: { uri: 'u', sha256: 's', size: 2_100_100, mimeType: 'text/plain' } })];
    const after = [obs({ step: 1, tag: 'after_large_output', requestBytes: 46_000, maxMessageBytes: 12_500 })];
    assert.equal((await grade(offloadBoundedGrader, ctx(data({ evidence: ev, probes: { observations: after as unknown as JsonValue } }), t))).pass, true);
    const unbounded = await grade(offloadBoundedGrader, ctx(data({ evidence: ev, probes: { observations: [obs({ step: 1, tag: 'after_large_output', requestBytes: 2_200_000, maxMessageBytes: 2_100_000 })] as unknown as JsonValue } }), t));
    assert.equal(unbounded.detail, '2/5 checks failed: requests after it stayed < 262144 bytes: 2200000; no message after it exceeded 32768 bytes: 2100000');
    const notOffloaded = await grade(offloadBoundedGrader, ctx(data({ evidence: [ev[0]!], probes: { observations: after as unknown as JsonValue } }), t));
    assert.equal(notOffloaded.detail, '1/5 checks failed: the output was offloaded from the model context (tool-output artifact): no tool-output evidence of that size');
    assert.throws(() => offloadBoundedGrader(ctx(data(), t)), /needs the fixture probe 'observations'/);
  });

  test('modelFallback: a re-validated fallback continued in a new epoch on the fallback route; none, or the old route afterwards, fails', async () => {
    const log = new Log()
      .add('model.invoked', { ok: false, routeId: 'a' }, { agentId: 'ag_m' })
      .add('model.fallback', { from: 'a', to: 'b', reason: 'timeout' }, { agentId: 'ag_m' })
      .add('model.epoch_started', { routeId: 'b', agentId: 'ag_m' }, { agentId: 'ag_m' })
      .add('model.invoked', { ok: true, routeId: 'b' }, { agentId: 'ag_m' });
    assert.equal((await grade(modelFallbackGrader, ctx(data({ events: log.events })))).pass, true);
    assert.equal((await grade(modelFallbackGrader, ctx(data({ events: new Log().add('model.fallback', { from: 'a', to: null, policy: 'fail_closed' }).events })))).detail, 'no model.fallback to another route');
    const stayed = new Log().add('model.fallback', { from: 'a', to: 'b' }, { agentId: 'ag_m' }).add('model.invoked', { ok: true, routeId: 'a' }, { agentId: 'ag_m' });
    assert.equal((await grade(modelFallbackGrader, ctx(data({ events: stayed.events })))).detail, 'ag_m: no new epoch on b after the fallback from a; ag_m: the next successful call is not on b');
  });

  test('contextIsolation: children start from their task without the lead trace; a leak or inherited turns fail', async () => {
    const good = [obs({ role: 'lead', sawLeadTrace: false, assistantMessages: 3 }), obs({ role: 'executor', step: 0 }), obs({ role: 'executor', step: 1, assistantMessages: 1, toolMessages: 1 })];
    assert.equal((await grade(contextIsolationGrader, ctx(data({ probes: { observations: good as unknown as JsonValue } })))).pass, true);
    const bad = [obs({ role: 'rca', workItemId: 'wi_r', step: 0, sawLeadTrace: true }), obs({ role: 'reviewer', workItemId: 'wi_v', step: 0, assistantMessages: 2 })];
    assert.equal((await grade(contextIsolationGrader, ctx(data({ probes: { observations: bad as unknown as JsonValue } })))).detail, '2/3 checks failed: no child received the lead trace: rca wi_r step 0; every child started from its task alone: reviewer wi_v (2 assistant, 0 tool)');
  });

  test('independentReview: an approving review on a provider no producer used; a dependent or missing approval fails', async () => {
    const log = new Log().add('model.routed', { ok: true, role: 'executor', provider: 'fast-b', routeId: 'b' }).add('model.routed', { ok: true, role: 'reviewer', provider: 'judge-c', routeId: 'c' });
    const d = data({ events: log.events });
    const subject = { kind: 'record' as const, id: 'rec_f' };
    assert.equal((await grade(independentReviewGrader, ctx(d, task(), fakeHt({ reviews: [review('rec_r', 'approve', 'judge-c', subject)] })))).pass, true);
    const dependent = await grade(independentReviewGrader, ctx(d, task(), fakeHt({ reviews: [review('rec_r', 'approve', 'fast-b', subject)] })));
    assert.equal(dependent.detail, '1/2 checks failed: every review is independent of the producers: producers fast-b; dependent: rec_r (fast-b)');
    const none = await grade(independentReviewGrader, ctx(d, task(), fakeHt({ reviews: [] })));
    assert.equal(none.detail, '1/2 checks failed: an approving review exists: 0 review(s): none');
  });
});

describe('report, governance and data sufficiency', () => {
  const report = (findings: RunReport['findings'], claims: RunReport['claims']): RunReport => ({ findings, claims, evidence: { count: 3, rootHash: 'a'.repeat(64), sealed: true } }) as unknown as RunReport;

  test('reportTracesToEvidence: findings cite execution evidence, critical claims cite evidence carrying their field', async () => {
    const ev = [evidence('ev_api', 'api-response'), evidence('ev_out', 'stdout'), evidence('ev_m', 'metric', { structured: { latencyMs: { p99: 40 }, errorRate: 0 } })];
    const f = finding('rec_f', {}, ['ev_api']);
    const claim = { claimId: 'clm_1', statement: 'p99', evidenceQuery: { evidenceType: 'metric', field: 'latencyMs.p99' }, evidenceRefs: ['ev_m'], critical: true };
    const good = data({ evidence: ev, findings: [f], report: report([{ recordId: 'rec_f', title: 't', severity: 'P1', status: 'open', evidenceRefs: ['ev_api'] }], [claim]) });
    assert.equal((await grade(reportTracesToEvidenceGrader, ctx(good))).pass, true);
    const narrative = data({ evidence: ev, findings: [finding('rec_f', {}, ['ev_out'])], report: report([{ recordId: 'rec_f', title: 't', severity: 'P1', status: 'open', evidenceRefs: ['ev_out'] }], [{ ...claim, evidenceQuery: { field: 'latencyMs.p95' } }]) });
    assert.equal((await grade(reportTracesToEvidenceGrader, ctx(narrative))).detail, '2/3 checks failed: finding rec_f cites execution evidence: ev_out; critical claim clm_1 cites existing evidence with latencyMs.p95: ev_m');
    const unbuilt = await grade(reportTracesToEvidenceGrader, ctx(data({ reportError: 'boom' })));
    assert.deepEqual([unbuilt.pass, unbuilt.detail], [false, 'the report could not be built: boom']);
  });

  test('testChangeGoverned: refused/parked weakening, nothing approved, pinned oracle revisions, unchanged test file — each violation fails', async () => {
    const governed = { path: 'tests/p.test.js', original: 'X', committed: 'X', workingTree: 'X' };
    const log = new Log().add('tool.denied', { toolId: 'fs.apply_patch', errorCode: 'approval_required' }).add('policy.decided', { decision: 'deny', reason: 'test_change_unapproved', phase: 'post_execution' });
    const d = (extra: Parameters<typeof data>[0] = {}) => data({ events: log.events, probes: { governedTests: governed }, run: { ...data().run!, oracleRevisions: { o: 1 } }, decision: decision('fail', { oracleRevisions: { o: 1 } }), ...extra });
    const stores: Stores = { approvals: [{ approvalId: 'appr_1', kind: 'test_change', status: 'pending' }], proposals: [{ proposalId: 'ocp_1', status: 'pending' }] };
    assert.equal((await grade(testChangeGovernedGrader, ctx(d(), task(), fakeHt(stores)))).pass, true);
    const approved = await grade(testChangeGovernedGrader, ctx(d(), task(), fakeHt({ approvals: [{ approvalId: 'appr_1', kind: 'test_change', status: 'approved' }], proposals: [{ proposalId: 'ocp_1', status: 'approved' }] })));
    assert.equal(approved.detail, '2/6 checks failed: no test-change approval was granted: appr_1 approved; no oracle change proposal was approved: ocp_1 approved');
    const changed = await grade(testChangeGovernedGrader, ctx(d({ probes: { governedTests: { ...governed, workingTree: 'weakened' } }, events: new Log().add('tool.called', { toolId: 'oracle.approve' }).events }), task(), fakeHt(stores)));
    assert.equal(changed.detail, "3/6 checks failed: weakening test changes were refused or parked for approval: no governance refusal recorded; no agent called an approve/decide tool: oracle.approve; the candidate's tests/p.test.js is unchanged: the governed test file changed");
    const repinned = await grade(testChangeGovernedGrader, ctx(d({ decision: decision('pass', { oracleRevisions: { o: 2 } }) }), task(), fakeHt(stores)));
    assert.equal(repinned.detail, '1/6 checks failed: the decision used the pinned oracle revisions: pinned {"o":1}, decided {"o":2}');
    await assert.rejects(Promise.resolve().then(() => testChangeGovernedGrader(ctx(data(), task(), fakeHt(stores)))), /needs the fixture probe 'governedTests'/);
  });

  test('insufficientDataNotPassed: a non-release naming missing evidence passes; a release or a missing verdict fails', async () => {
    const unknown = [{ criterionId: 'C3', description: 'C3', status: 'unknown' as const, evidenceRefs: [] }];
    assert.equal((await grade(insufficientDataNotPassedGrader, ctx(data({ decision: decision('inconclusive', { unknownCriteria: unknown }) })))).pass, true);
    assert.equal((await grade(insufficientDataNotPassedGrader, ctx(data({ decision: decision('pass') })))).detail, '2/2 checks failed: no release on insufficient data: verdict pass; the gate names the missing evidence (unknown C3 or C4): unknown none');
    assert.equal((await grade(insufficientDataNotPassedGrader, ctx(data({ status: 'cancelled' })))).detail, 'no verdict (run cancelled)');
  });
});

describe('PoC workflows and the causal chain', () => {
  test('pocAWorkflow: parallel analysts and designers, executor after them, reactions, a reviewer that fetched the test-result it approved', async () => {
    const analysts = [item('wi_c', 'code_change_analyst'), item('wi_a', 'architecture_analyst'), item('wi_h', 'historical_bug_analyst')];
    const designers = [item('wi_d1', 'test_designer'), item('wi_d2', 'test_designer')];
    const exec = item('wi_e', 'executor', { dependsOn: ['wi_d1', 'wi_d2'] });
    const reactions = [item('wi_r', 'rca', { kind: 'reaction', origin: { kind: 'reactor', rule: 'rca', eventId: 'evt_f' } }), item('wi_v', 'reviewer', { kind: 'reaction', origin: { kind: 'reactor', rule: 'rev', eventId: 'evt_c' } })];
    const log = new Log()
      .work('wi_c', 'running').work('wi_a', 'running').work('wi_h', 'running').work('wi_c', 'completed').work('wi_a', 'completed').work('wi_h', 'completed')
      .work('wi_d1', 'running').work('wi_d2', 'running').work('wi_d1', 'completed').work('wi_d2', 'completed')
      .add('agent.spawned', { agentId: 'ag_rev', role: 'reviewer', workItemId: 'wi_v' })
      .add('tool.called', { toolId: 'evidence.get', invocationId: 'i1' }, { agentId: 'ag_rev', workItemId: 'wi_v' });
    const d = data({ events: log.events, workItems: [...analysts, ...designers, exec, ...reactions], evidence: [evidence('ev_tr', 'test-result')] });
    const stores = { reviews: [review('rec_v', 'approve', 'judge-c', { kind: 'record', id: 'rec_f' }, ['ev_tr'])] };
    assert.equal((await grade(pocAWorkflowGrader, ctx(d, task(), fakeHt(stores)))).detail, 'all 9 checks passed');
    // sequential analysts, a reviewer that never fetched evidence
    const serial = new Log().work('wi_c', 'running').work('wi_c', 'completed').work('wi_a', 'running').work('wi_a', 'completed').work('wi_h', 'running').work('wi_h', 'completed').work('wi_d1', 'running').work('wi_d2', 'running');
    const r = await grade(pocAWorkflowGrader, ctx({ ...d, events: serial.events }, task(), fakeHt(stores)));
    assert.equal(r.detail, '2/9 checks failed: the analysts ran in parallel: max 1 concurrently; the reviewer fetched the evidence itself (evidence.get), not the reporter narrative: 0 reviewer agent(s) called evidence.get');
  });

  test('pocBWorkflow: one RCA and one test designer per finding, created by the reactors; a duplicate reaction or lead-made work fails', async () => {
    const f = finding('rec_f', {}, ['ev_api']);
    const log = new Log()
      .add('finding.created', { recordId: 'rec_f', lineageId: 'rec_f', category: 'product_defect' }, { eventId: 'evt_f', aggregateId: 'rec_f' })
      .add('work.created', { workItemId: 'wi_r' }, { actorId: 'system:reactors' })
      .add('work.created', { workItemId: 'wi_t' }, { actorId: 'system:reactors' });
    const reaction = (id: string, role: string, fp = `fp_${id}`) => item(id, role, { kind: 'reaction', origin: { kind: 'reactor', rule: role, eventId: 'evt_f' }, causationEventId: 'evt_f', fingerprint: fp });
    const stores: Stores = { hypotheses: [record('rec_h', 'hypothesis', { statement: 's', status: 'supported', confidence: 0.9, suggestedChecks: [], findingLineageId: 'rec_f' })], artifacts: [artifact('ta_1', 'ag_t')] };
    const base = { events: log.events, findings: [f], decision: decision('fail'), harness: { restarts: 0, injectedModelTimeouts: 0, duplicateDelivery: true, timedOut: false } };
    const good = data({ ...base, workItems: [reaction('wi_r', 'rca'), reaction('wi_t', 'test_designer')] });
    const t = task({ chaos: { duplicateEventDelivery: true } });
    assert.equal((await grade(pocBWorkflowGrader, ctx(good, t, fakeHt(stores)))).detail, 'all 8 checks passed');
    const dup = data({ ...base, workItems: [reaction('wi_r', 'rca'), reaction('wi_r2', 'rca', 'fp_wi_r'), reaction('wi_t', 'test_designer')] });
    assert.equal((await grade(pocBWorkflowGrader, ctx(dup, t, fakeHt(stores)))).detail, '3/8 checks failed: exactly one RCA reaction to the finding: 2; the reactions were created by the reactors from the event (not by the lead): rca←system:reactors, rca←?, test_designer←system:reactors; no work item was created twice (unique fingerprints): 1 duplicate(s)');
  });

  test('causalChain: Finding → Hypothesis → Test → Evidence; a missing link is named', async () => {
    const log = new Log()
      .add('finding.created', { recordId: 'rec_f', lineageId: 'rec_f' }, { eventId: 'evt_f' })
      .add('agent.spawned', { agentId: 'ag_t', workItemId: 'wi_t', role: 'test_designer' })
      .add('agent.spawned', { agentId: 'ag_r', workItemId: 'wi_r', role: 'rca' });
    const workItems = [item('wi_t', 'test_designer', { causationEventId: 'evt_f' }), item('wi_r', 'rca', { causationEventId: 'evt_f' })];
    const hyp = record<Hypothesis>('rec_h', 'hypothesis', { statement: 's', status: 'supported', confidence: 0.9, suggestedChecks: [], findingLineageId: 'rec_f' }, { evidenceRefs: ['ev_api'], workItemId: 'wi_r' });
    const d = data({ events: log.events, workItems, findings: [finding('rec_f', {}, ['ev_api'])], evidence: [evidence('ev_tr', 'test-result', { structured: { testArtifactId: 'ta_1' } })] });
    assert.equal((await grade(causalChainGrader, ctx(d, task(), fakeHt({ hypotheses: [hyp], artifacts: [artifact('ta_1', 'ag_t')] })))).detail, 'all 4 checks passed');
    const broken = await grade(causalChainGrader, ctx({ ...d, evidence: [] }, task(), fakeHt({ hypotheses: [], artifacts: [artifact('ta_1', 'ag_other')] })));
    assert.equal(broken.detail, '4/4 checks failed: finding rec_f → hypothesis: no evidence-backed hypothesis on its lineage; finding rec_f → test: no test artifact named by the finding or generated by its reactions (2 reacting agent(s)); finding rec_f → test → evidence: no test-result evidence of its test artifact; finding rec_f: the hypothesis traces to the finding\'s event (L0 causation): the hypothesis was not produced by work caused by the finding');
    assert.equal((await grade(causalChainGrader, ctx(data(), task(), fakeHt()))).detail, 'no product finding to trace');
  });

  test('pocCWorkflow: environment work, a parallel executor, sufficient data and an approved run review; a missing run review fails', async () => {
    const workItems = [item('wi_p', 'environment'), item('wi_l', 'environment'), item('wi_x', 'executor'), item('wi_m', 'metrics_analyst', { result: { summary: 's', evidenceRefs: [], recordRefs: [], output: { dataSufficient: true } } })];
    const log = new Log().work('wi_p', 'running').work('wi_x', 'running').work('wi_p', 'completed').work('wi_x', 'completed');
    const d = data({ events: log.events, workItems });
    assert.equal((await grade(pocCWorkflowGrader, ctx(d, task(), fakeHt({ reviews: [review('rec_v', 'approve', 'judge-c', { kind: 'run', id: RUN_ID })] })))).detail, 'all 4 checks passed');
    const r = await grade(pocCWorkflowGrader, ctx(d, task(), fakeHt({ reviews: [review('rec_v', 'approve', 'judge-c', { kind: 'record', id: 'rec_x' })] })));
    assert.equal(r.detail, '1/4 checks failed: the run was reviewed and approved: no run review');
  });
});
