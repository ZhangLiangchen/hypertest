import { hashCanonical, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { AgentRole, ModelPolicy, ToolPolicy } from './agent.ts';
import type { Ref, Severity, ToolEffect } from './common.ts';
import type { ResourceClaim } from './operation.ts';

export interface Objective {
  objectiveId: string;
  description: string;
  priority: Severity;
  riskRefs: string[];
  acceptanceCriteria: string[];
  status: 'open' | 'satisfied' | 'unsatisfiable' | 'dropped';
}

export interface Assumption {
  statement: string;
  status: 'unverified' | 'verified' | 'refuted';
}

/** Evidence a work item must attach before it may complete (checked deterministically). */
export interface EvidenceRequirement {
  evidenceType: string;
  /** Minimum number of evidence records of that type. */
  minCount: number;
  description?: string;
  /** Critical requirements gate the final QualityDecision. */
  critical?: boolean;
}

export interface CapabilityRequirement {
  effect: ToolEffect;
  resourceScopes: string[];
  environmentClass?: string;
}

export interface WorkBudget {
  maxTurns: number;
  maxTokens: number;
  maxCostUsd?: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

export const DEFAULT_WORK_BUDGET: WorkBudget = {
  maxTurns: 40,
  maxTokens: 400_000,
  maxToolCalls: 150,
  maxWallClockMs: 30 * 60 * 1000,
};

/** A work item as proposed inside a PlanRevision (typed Plan IR — never code). */
export interface PlannedWorkItem {
  /** Plan-local id used by dependsOn within the same revision. */
  localId: string;
  title: string;
  objective: string;
  role: AgentRole;
  /** localIds from this revision or existing workItemIds. */
  dependsOn: string[];
  objectiveIds: string[];
  inputRefs?: Ref[];
  expectedOutput?: JsonSchema;
  evidenceRequirements?: EvidenceRequirement[];
  budget?: Partial<WorkBudget>;
  priority?: number;
  toolPolicy?: ToolPolicy;
  modelPolicy?: ModelPolicy;
  resourceClaims?: ResourceClaim[];
  capabilityRequirements?: CapabilityRequirement[];
}

export type PlanStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';

/** A continuously revised plan (Plan v1 → v2 → …); never a static DAG. */
export interface PlanRevision {
  planId: string;
  runId: string;
  revision: number;
  parentRevision?: number;
  status: PlanStatus;
  rationale: string;
  objectives: Objective[];
  workItems: PlannedWorkItem[];
  /** Existing work items to cancel (must not be running side effects). */
  cancelWorkItems: string[];
  assumptions: Assumption[];
  /** Lead's statement that no further work is needed before the gate. */
  readyForGate: boolean;
  createdFromSnapshot: string;
  proposedBy: string;
  validationIssues: string[];
  createdAt: string;
  decidedAt?: string;
}

export type WorkItemKind = 'initial_plan' | 'replan' | 'task' | 'reaction' | 'delegation' | 'review';

export type WorkOrigin =
  | { kind: 'plan'; planRevision: number; localId: string }
  | { kind: 'reactor'; rule: string; eventId: string }
  | { kind: 'delegation'; parentWorkItemId: string; parentAgentId: string }
  | { kind: 'system'; reason: string };

export type WorkItemState = 'proposed' | 'ready' | 'blocked' | 'claimed' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type WorkFailureReason =
  | 'budget_exhausted'
  | 'model_unavailable'
  | 'policy_denied'
  | 'invalid_output'
  | 'agent_failed'
  | 'dependency_failed'
  | 'lease_lost'
  | 'cancelled'
  | 'manual_review'
  | 'internal_error';

export interface WorkClaim {
  ownerId: string;
  leaseId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface WorkResult {
  summary: string;
  output?: JsonValue;
  evidenceRefs: string[];
  recordRefs: string[];
}

export interface WorkItem {
  workItemId: string;
  runId: string;
  kind: WorkItemKind;
  origin: WorkOrigin;
  title: string;
  objective: string;
  role: AgentRole;
  objectiveIds: string[];
  modelPolicy?: ModelPolicy;
  toolPolicy?: ToolPolicy;
  capabilityRequirements: CapabilityRequirement[];
  inputRefs: Ref[];
  expectedOutput?: JsonSchema;
  evidenceRequirements: EvidenceRequirement[];
  dependsOn: string[];
  budget: WorkBudget;
  priority: number;
  state: WorkItemState;
  planRevision?: number;
  parentWorkItemId?: string;
  depth: number;
  /** Deterministic dedupe key: identical work is never created twice (I5). */
  fingerprint: string;
  resourceClaims: ResourceClaim[];
  claim?: WorkClaim;
  agentId?: string;
  result?: WorkResult;
  failure?: { reason: WorkFailureReason; message: string };
  attempts: number;
  waitingOn: string[];
  causationEventId?: string;
  createdAt: string;
  updatedAt: string;
}

const WORK_TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  proposed: ['ready', 'blocked', 'cancelled'],
  blocked: ['ready', 'cancelled', 'failed'],
  ready: ['claimed', 'blocked', 'cancelled'],
  claimed: ['running', 'ready', 'cancelled', 'failed'],
  running: ['waiting', 'completed', 'failed', 'cancelled', 'ready'],
  waiting: ['running', 'failed', 'cancelled', 'ready'],
  completed: [],
  failed: ['ready'],
  cancelled: [],
};

export function canTransitionWorkItem(from: WorkItemState, to: WorkItemState): boolean {
  return WORK_TRANSITIONS[from].includes(to);
}
export function isTerminalWorkState(s: WorkItemState): boolean {
  return s === 'completed' || s === 'cancelled' || s === 'failed';
}
export function isActiveWorkState(s: WorkItemState): boolean {
  return s === 'claimed' || s === 'running' || s === 'waiting';
}

/**
 * Deterministic work fingerprint: same run + role + normalized objective + origin key + inputs ⇒ same
 * fingerprint. Reactors pass the triggering subject (e.g. finding record id) so duplicate event
 * deliveries map to the same work item.
 */
export function workItemFingerprint(input: { runId: string; role: string; objective: string; originKey: string; inputRefs?: Ref[] }): string {
  const normalized = input.objective.trim().toLowerCase().replace(/\s+/g, ' ');
  const refs = (input.inputRefs ?? []).map((r) => `${r.kind}:${r.id}`).sort();
  return hashCanonical({ r: input.runId, role: input.role, o: normalized, k: input.originKey, refs }).slice(0, 32);
}
