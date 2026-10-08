/**
 * (F[5], F[6], F[7]) Hermetic tests of the extended-suite graders on synthetic trial data: each grader passes on the
 * behaviour it requires and FAILS on the defect it exists to catch (white-box tool in a black-box task, a fault window
 * the load never ran in, a tamper the verifier missed or over-reported, a delegation that did not run in parallel, a
 * duplicated finding, a tool call beyond the exhausted budget, overlapping competing faults, a re-sent unknown write).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DomainEvent, EvidenceRecord, WorkItem } from '@hypertest/domain';
import {
  blackBoxOnlyGrader, budgetExhaustionGrader, competingFaultsIsolatedGrader, convergenceGrader, delegationGrader, faultToleranceGrader, tamperDetectedGrader, unqueryableEscalatedGrader,
  type GraderResult, type TrialData,
} from '../src/index.ts';
import { Log, RUN_ID, T0, ctx, data, decision, evidence, finding, operation, run } from './helpers.ts';

const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

async function grade(g: (c: ReturnType<typeof ctx>) => GraderResult | Promise<GraderResult>, d: TrialData, ht: unknown = {}): Promise<GraderResult> {
  return g(ctx(d, undefined, ht));
}

function item(workItemId: string, role: string, origin: WorkItem['origin'], extra: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId, runId: RUN_ID, kind: 'task', role, state: 'completed', title: workItemId, objective: workItemId, objectiveIds: [], origin, capabilityRequirements: [], inputRefs: [],
    evidenceRequirements: [], dependsOn: [], budget: { maxModelCalls: 1, maxToolCalls: 1, maxTokens: 1, maxWallClockMs: 1 }, priority: 50, depth: 0, fingerprint: workItemId, resourceClaims: [],
    attempts: 1, revision: 1, createdAt: iso(0), updatedAt: iso(0), waitingOn: [], ...extra,
  } as unknown as WorkItem;
}

function spawned(log: Log, agentId: string, role: string, workItemId: string): void {
  log.add('agent.spawned', { agentId, role, workItemId }, { aggregateId: agentId });
}

describe('blackBoxOnly', () => {
  test('passes on interface calls only; fails when an agent read the source', async () => {
    const log = new Log();
    spawned(log, 'ag_1', 'executor', 'wi_1');
    log.tool('i1', 'http.request', 'pd_1');
    assert.equal((await grade(blackBoxOnlyGrader, data({ events: log.events }))).pass, true);
    log.tool('i2', 'fs.read', 'pd_2');
    const r = await grade(blackBoxOnlyGrader, data({ events: log.events }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /no white-box tool was used: fs\.read by executor/);
  });
});

describe('faultTolerance', () => {
  const ht = { services: { specs: { listExperiments: async () => [{ faultPlan: [{ kind: 'latency', target: 'kv' }] }] } } };
  const fault = { operationId: 'f1', fault: { kind: 'latency' }, requestedAt: iso(10), expiresAt: iso(20), state: 'expired' };
  const base = (jobWindow: [number, number], healthAt: number): TrialData => {
    const jobEv = evidence('ev_job', 'metric', { operationId: 'op_load' });
    const health = evidence('ev_h', 'api-response', { structured: { request: { method: 'GET', path: '/health' }, response: { status: 200 } }, capturedAt: iso(healthAt) } as Partial<EvidenceRecord>);
    return data({
      operations: [operation('op_f', 'verified', { operationType: 'env.inject_fault' })],
      evidence: [jobEv, health],
      decision: decision('pass', { satisfiedCriteria: [{ criterionId: 'C3', name: 'critical_oracles', status: 'satisfied', evidenceRefs: ['ev_job'], detail: '' }] as never }),
      probes: { faults: [fault], loadJobs: [{ operationId: 'op_load', state: 'completed', startedAt: iso(jobWindow[0]), finishedAt: iso(jobWindow[1]) }] },
    });
  };
  test('passes when the load ran inside the fault window and the service was checked after it', async () => {
    const r = await grade(faultToleranceGrader, base([12, 15], 21), ht);
    assert.equal(r.pass, true, r.detail);
  });
  test('fails when the load ran outside the fault (the invariant was not measured under it) or nobody checked recovery', async () => {
    const outside = await grade(faultToleranceGrader, base([21, 24], 25), ht);
    assert.equal(outside.pass, false);
    assert.match(outside.detail, /the load job ran inside the fault window/);
    const unchecked = await grade(faultToleranceGrader, base([12, 15], 18), ht);
    assert.equal(unchecked.pass, false);
    assert.match(unchecked.detail, /the service was checked after the fault expired: 0 GET \/health/);
  });
});

describe('tamperDetected', () => {
  const attacked = { tampered: ['ev_a', 'ev_b'], missing: ['ev_c'], rewritten: ['ev_d'], updateRefused: true };
  const verification = (problems: Array<{ kind: string; evidenceId: string }>) => ({ ok: problems.length === 0, problems: problems.map((p) => ({ ...p, detail: 'x' })) });
  const exact = [
    { kind: 'artifact_hash', evidenceId: 'ev_a' }, { kind: 'artifact_hash', evidenceId: 'ev_b' }, { kind: 'artifact_missing', evidenceId: 'ev_c' }, { kind: 'metadata_hash', evidenceId: 'ev_d' },
  ];
  test('passes when the verifier names exactly the affected records', async () => {
    const r = await grade(tamperDetectedGrader, data({ probes: { afterRun: attacked }, verification: verification(exact) as never, verifyEvidence: { ok: false, problems: ['x'] } }));
    assert.equal(r.pass, true, r.detail);
  });
  test('fails when a tamper is missed, when an untouched record is flagged, or when the plain rewrite was accepted', async () => {
    const missed = await grade(tamperDetectedGrader, data({ probes: { afterRun: attacked }, verification: verification(exact.slice(1)) as never, verifyEvidence: { ok: false, problems: ['x'] } }));
    assert.match(missed.detail, /every record of the tampered artifact is flagged artifact_hash/);
    const over = await grade(tamperDetectedGrader, data({ probes: { afterRun: attacked }, verification: verification([...exact, { kind: 'artifact_hash', evidenceId: 'ev_z' }]) as never, verifyEvidence: { ok: false, problems: ['x'] } }));
    assert.match(over.detail, /no untouched record is flagged: ev_z/);
    const accepted = await grade(tamperDetectedGrader, data({ probes: { afterRun: { ...attacked, updateRefused: false } }, verification: verification(exact) as never, verifyEvidence: { ok: false, problems: ['x'] } }));
    assert.match(accepted.detail, /append-only ledger refused/);
  });
  test('an attack that could not run cannot be graded (precondition_failed), never a pass', async () => {
    await assert.rejects(async () => grade(tamperDetectedGrader, data({ probes: { afterRun: { error: 'no evidence' } } })), /the attack could not run/);
  });
});

describe('delegation', () => {
  const build = (parallel: boolean): TrialData => {
    const log = new Log();
    log.add('work.started', { workItemId: 'c1', to: 'running' });
    if (!parallel) log.add('work.completed', { workItemId: 'c1', to: 'completed' });
    log.add('work.started', { workItemId: 'c2', to: 'running' });
    if (!parallel) log.add('work.completed', { workItemId: 'c2', to: 'completed' });
    log.add('work.started', { workItemId: 'c3', to: 'running' });
    if (parallel) for (const id of ['c1', 'c2']) log.add('work.completed', { workItemId: id, to: 'completed' });
    log.add('work.completed', { workItemId: 'c3', to: 'completed' });
    log.add('plan.proposed', { revision: 1 });
    const children = ['c1', 'c2', 'c3'].map((id) => item(id, 'code_change_analyst', { kind: 'delegation', parentWorkItemId: 'lead', parentAgentId: 'ag_l' } as never, { parentWorkItemId: 'lead' } as Partial<WorkItem>));
    return data({ events: log.events, workItems: [item('lead', 'lead', { kind: 'system' } as never), ...children, item('p1', 'executor', { kind: 'plan' } as never)], decision: decision('fail'), status: 'completed' });
  };
  test('passes when the delegated children ran in parallel and the run converged', async () => {
    const r = await grade(delegationGrader, build(true));
    assert.equal(r.pass, true, r.detail);
  });
  test('fails when the delegations ran one after the other', async () => {
    const r = await grade(delegationGrader, build(false));
    assert.match(r.detail, /the delegated sub-tasks ran in parallel: max 1 concurrently/);
  });
});

describe('convergence', () => {
  const base = (findings: ReturnType<typeof finding>[], created: number): TrialData => {
    const log = new Log();
    for (let i = 0; i < created; i++) log.add('finding.created', { lineageId: findings[i]?.lineageId ?? 'x' });
    const executors = ['e1', 'e2'].map((id) => item(id, 'executor', { kind: 'plan' } as never, { result: { summary: 's', recordRefs: [findings[0]!.recordId], evidenceRefs: [] } } as Partial<WorkItem>));
    return data({ events: log.events, findings, workItems: [...executors, item('r1', 'rca', { kind: 'reactor' } as never)], decision: decision('fail'), status: 'completed' });
  };
  test('passes when two agents converge on one finding with one RCA', async () => {
    const f = finding('rec_1', { category: 'product_defect', fingerprint: 'fp', status: 'confirmed' }, ['ev_1']);
    assert.equal((await grade(convergenceGrader, base([f], 1))).pass, true);
  });
  test('fails when the same symptom was recorded twice', async () => {
    const f1 = finding('rec_1', { category: 'product_defect', fingerprint: 'fp', status: 'open' }, ['ev_1']);
    const f2 = { ...finding('rec_2', { category: 'product_defect', fingerprint: 'fp', status: 'open' }, ['ev_2']), lineageId: 'rec_2' };
    const r = await grade(convergenceGrader, base([f1, f2], 2));
    assert.match(r.detail, /one finding lineage per symptom \(no duplicate findings\): 2 product finding\(s\), 1 duplicated symptom/);
  });
});

describe('budgetExhaustion', () => {
  const build = (charged: number): TrialData => {
    const log = new Log();
    for (let i = 0; i < charged; i++) log.tool(`i${i}`, 'http.request', 'pd');
    log.tool('done', 'complete_work', 'pd');
    log.add('budget.exhausted', { reason: 'tool_calls', scope: 'run:x' });
    return data({ events: log.events, run: run({ budget: { ...run().budget, maxToolCalls: 3 } }), decision: decision('inconclusive'), status: 'completed' });
  };
  test('passes when the charged calls stayed within the budget (terminal calls are free) and nothing was released', async () => {
    assert.equal((await grade(budgetExhaustionGrader, build(3))).pass, true);
  });
  test('fails when a charged call ran beyond the exhausted budget, or the run released', async () => {
    assert.match((await grade(budgetExhaustionGrader, build(4))).detail, /no more than maxToolCalls \(3\) charged tool calls completed: 4 completed/);
    const released = { ...build(2), decision: decision('pass') };
    assert.match((await grade(budgetExhaustionGrader, released)).detail, /no release on an exhausted budget/);
  });
});

describe('competingFaultsIsolated', () => {
  const ht = { services: { specs: { listExperiments: async () => [{ faultPlan: [{ kind: 'latency' }] }, { faultPlan: [{ kind: 'error_rate' }] }] } } };
  const build = (secondFaultAt: number): TrialData => {
    const log = new Log();
    log.add('admission.refused', { experimentId: 'exp_b', conflicts: ['env/kv@exp_a'] });
    const faults = [
      { operationId: 'fa', fault: { kind: 'latency' }, requestedAt: iso(0), expiresAt: iso(6), state: 'expired' },
      { operationId: 'fb', fault: { kind: 'error_rate' }, requestedAt: iso(secondFaultAt), expiresAt: iso(secondFaultAt + 6), state: 'expired' },
    ];
    const jobs = [
      { operationId: 'la', startedAt: iso(1), finishedAt: iso(4) },
      { operationId: 'lb', startedAt: iso(secondFaultAt + 1), finishedAt: iso(secondFaultAt + 4) },
    ];
    return data({ events: log.events, probes: { faults, loadJobs: jobs } });
  };
  test('passes when the faults were serialized and each load ran under one fault', async () => {
    const r = await grade(competingFaultsIsolatedGrader, build(7), ht);
    assert.equal(r.pass, true, r.detail);
  });
  test('fails when the competing faults overlapped (a load ran under both)', async () => {
    const r = await grade(competingFaultsIsolatedGrader, build(2), ht);
    assert.equal(r.pass, false);
    assert.match(r.detail, /the fault windows never overlapped: fa∩fb/);
  });
});

describe('unqueryableEscalated', () => {
  const build = (dispatches: number, writes: number, by = 'human:op'): TrialData => {
    const log = new Log();
    const ev = (t: string, p: Record<string, string> = {}) => log.add(t, { operationId: 'op_w', ...p }, { aggregateId: 'op_w' } as Partial<DomainEvent<unknown>>);
    for (let i = 0; i < dispatches; i++) ev('operation.dispatched');
    ev('operation.outcome_unknown');
    ev('operation.manual_review');
    ev('operation.resolved', { by, outcome: writes > 0 ? 'succeeded' : 'failed' });
    return data({
      events: log.events, operations: [operation('op_w', 'verified', { operationType: 'http.request' })], decision: decision('pass'), status: 'completed',
      probes: { writes: Array.from({ length: writes }, () => ({ idempotencyKey: 'op_w', key: 'maintenance' })) },
    });
  };
  test('passes when the unknown write went to a human once and was never re-sent', async () => {
    const r = await grade(unqueryableEscalatedGrader, build(1, 1));
    assert.equal(r.pass, true, r.detail);
  });
  test('fails when the write was re-sent blindly or resolved by an agent', async () => {
    assert.match((await grade(unqueryableEscalatedGrader, build(2, 2))).detail, /never re-sent \(dispatched once\): 2 dispatch\(es\)/);
    assert.match((await grade(unqueryableEscalatedGrader, build(1, 1, 'agent:x'))).detail, /a human resolved it with the true outcome/);
  });
});
