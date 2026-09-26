/**
 * Builders of synthetic trial data for hermetic grader/metric tests: events in seq order, a run, findings, evidence,
 * operations, plans, policy decisions and session turns — the shapes the real stores return.
 */
import type { JsonValue } from '@hypertest/core';
import type {
  BlackboardRecord, DomainEvent, EvidenceRecord, Finding, OperationRecord, OperationStatus, PlanRevision, QualityDecision, RuntimeManifest, TestRun,
} from '@hypertest/domain';
import type { PolicyDecisionRecord } from '@hypertest/policy';
import { buildRuntimeManifest } from '@hypertest/runtime';
import type { EvalTask, GraderContext, TrialData } from '../src/index.ts';

export const RUN_ID = 'run_syn';
export const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export function manifest(): RuntimeManifest {
  return buildRuntimeManifest(
    {
      hypertest: { version: '0.3.0-test' },
      agentEngines: [{ kind: 'native', version: '0' }],
      providerAdapters: [],
      modelCatalogRevision: 'cat-1',
      schemas: { event: 'e', contextSnapshot: 'c', tool: 't', operation: 'o', evidence: 'v' },
      policyBundleRevision: 'p',
      toolCatalogRevision: 'tc',
    },
    '2026-01-01T00:00:00.000Z',
  );
}

/** A tiny event log builder: seq and occurredAt (1 s apart) assigned in order. */
export class Log {
  readonly events: DomainEvent<unknown>[] = [];
  add(eventType: string, payload: Record<string, JsonValue>, extra: Partial<DomainEvent<unknown>> = {}): this {
    const seq = this.events.length + 1;
    this.events.push({
      eventId: `evt_${seq}`,
      eventType,
      aggregateType: 'run',
      aggregateId: extra.aggregateId ?? String(payload['invocationId'] ?? payload['operationId'] ?? payload['workItemId'] ?? payload['decisionId'] ?? RUN_ID),
      runId: RUN_ID,
      seq,
      correlationId: RUN_ID,
      actorId: 'system:test',
      schemaVersion: '1',
      payload,
      occurredAt: new Date(T0 + seq * 1000).toISOString(),
      ...extra,
    });
    return this;
  }
  /** model.routed(ok) + model.invoked(ok) for an agent/role/route with usage. */
  model(agentId: string, role: string, routeId: string, usage = { inputTokens: 100, outputTokens: 10, costUsd: 0.01 }): this {
    this.add('model.routed', { ok: true, role, routeId, agentId, provider: 'p', model: 'm' }, { aggregateId: agentId, agentId });
    return this.add('model.invoked', { ok: true, routeId, provider: 'p', model: 'm', usage, attempts: 1 }, { aggregateId: agentId, agentId });
  }
  /** tool.called (allow permit) + tool.completed. */
  tool(invocationId: string, toolId: string, permitDecisionId: string, extra: Partial<DomainEvent<unknown>> = { workItemId: 'wi_1', agentId: 'ag_1' }): this {
    this.add('tool.called', { toolId, invocationId, effect: 'read', riskClass: 'low', resources: [], permitDecisionId }, extra);
    return this.add('tool.completed', { toolId, invocationId, status: 'success' }, extra);
  }
  work(workItemId: string, to: string, role = 'executor'): this {
    return this.add(`work.${to === 'running' ? 'started' : to}`, { workItemId, to, role });
  }
}

export function run(extra: Partial<TestRun> = {}): TestRun {
  return {
    runId: RUN_ID, goal: 'g', target: {}, status: 'completed',
    budget: { maxWallClockMs: 1, maxAgentConcurrency: 1, maxModelTokens: 1, maxToolCalls: 1, maxWorkItems: 1, maxAgentDepth: 1, maxPlanRevisions: 1 },
    runtimeManifestId: manifest().manifestId, policyRevision: 'p', currentPlanRevision: 2, oracleRevisions: {}, experimentIds: [], labels: {},
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), ...extra,
  };
}

export function decision(verdict: QualityDecision['verdict'], extra: Partial<QualityDecision> = {}): QualityDecision {
  return {
    decisionId: 'qd_1', runId: RUN_ID, revision: 1, gateId: 'g', scope: { description: '', objectiveIds: [] }, verdict, requiresHumanReview: false,
    oracleRevisions: {}, experimentRevisions: {}, evidenceRootHash: 'r'.repeat(64), evidenceCount: 1, satisfiedCriteria: [], violatedCriteria: [], unknownCriteria: [],
    unresolvedFindings: [], unresolvedRisks: [], exceptions: [], reviewerDecisions: [], reasons: [], runtimeManifestId: manifest().manifestId, policyRevision: 'p',
    decidedAt: new Date(T0).toISOString(), ...extra,
  };
}

export function evidence(evidenceId: string, evidenceType: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId, runId: RUN_ID, seq: 1, evidenceType, artifact: { uri: 'cas://sha256/x', sha256: 'x', size: 1, mimeType: 'text/plain' }, summary: 's',
    producer: { workerId: 'w', runtimeManifestId: 'rm' }, provenance: {}, parentEvidenceIds: [], classification: 'internal', retentionPolicy: 'r',
    capturedAt: new Date(T0).toISOString(), metadataHash: 'm', recordHash: 'h', ...extra,
  };
}

export function finding(recordId: string, payload: Partial<Finding>, evidenceRefs: string[]): BlackboardRecord<Finding> {
  return {
    recordId, lineageId: recordId, recordType: 'finding', runId: RUN_ID, revision: 1, version: 1, createdBy: 'ag_1', evidenceRefs, createdAt: new Date(T0).toISOString(),
    payload: { title: 't', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: recordId, ...payload },
  };
}

export function operation(operationId: string, status: OperationStatus, extra: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId, runId: RUN_ID, workItemId: 'wi_1', operationType: 'env.restart', adapterId: 'env.control', target: { resourceKey: 'env/x', kind: 'environment' },
    desiredStateHash: 'd', inputHash: 'i', idempotencyKey: operationId, status, attempt: 1, evidenceRefs: [], createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    ...extra,
  };
}

export function plan(revision: number, status: PlanRevision['status']): PlanRevision {
  return {
    planId: `pl_${revision}`, runId: RUN_ID, revision, status, rationale: 'r', objectives: [], workItems: [], cancelWorkItems: [], assumptions: [], readyForGate: false,
    createdFromSnapshot: 's', proposedBy: 'ag', validationIssues: [], createdAt: new Date(T0).toISOString(),
  };
}

export function permit(decisionId: string, decision: 'allow' | 'deny' | 'approval_required'): PolicyDecisionRecord {
  return {
    decisionId, runId: RUN_ID, requestHash: 'h', decidedAt: new Date(T0).toISOString(),
    request: { requestId: 'r', runId: RUN_ID, workItemId: 'wi_1', agentId: 'ag_1', tool: 't', effect: 'read', riskClass: 'low', resources: [], phase: 'before_action' } as never,
    permit: { decision, decisionId, reasons: [], policyRevision: 'p' },
  };
}

export function data(extra: Partial<TrialData> = {}): TrialData {
  const d: TrialData = {
    runId: RUN_ID, run: run(), status: 'completed', decisions: [], events: [], operations: [], findings: [], evidence: [], plans: [], workItems: [], policyDecisions: [],
    sessionTurns: [], probes: {}, harness: { restarts: 0, injectedModelTimeouts: 0, duplicateDelivery: false, timedOut: false }, manifest: manifest(),
    verification: { ok: true, runId: RUN_ID, count: 0, rootHash: 'r', problems: [] }, verifyEvidence: { ok: true, problems: [] },
    ...extra,
  };
  if (d.decision && d.decisions.length === 0) d.decisions = [d.decision];
  return d;
}

export function task(extra: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: 't1', suiteRevision: 'r1', title: 'task', goal: 'goal', hiddenFaults: [], expectedVerdict: 'fail', graders: ['verdict'],
    setup: async () => ({ target: {}, cleanup: async () => undefined }), ...extra,
  };
}

/** A grader context without a live instance (graders that need `ht` get the stub given). */
export function ctx(d: TrialData, t: EvalTask = task(), ht: unknown = {}): GraderContext {
  return { task: t, armId: 'a', trial: { workDir: '/tmp/x', seed: 's', trial: 0 }, fixture: { target: {}, cleanup: async () => undefined }, data: d, ht: ht as GraderContext['ht'] };
}
