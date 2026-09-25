import type { ActorRef, Ref, Severity } from './common.ts';
import type { EvidenceRequirement } from './plan.ts';
import type { ResourceClaim } from './operation.ts';
import type { BudgetEnvelope } from './run.ts';

// ---------------------------------------------------------------------------------------------
// SystemModel — what the system is. Versioned; may propose test hypotheses but is never an oracle.
// ---------------------------------------------------------------------------------------------

export interface ComponentModel {
  componentId: string;
  name: string;
  kind: 'service' | 'library' | 'module' | 'database' | 'queue' | 'ui' | 'cli' | 'external' | 'other';
  paths: string[];
  description?: string;
  riskTags: string[];
}

export interface InterfaceModel {
  interfaceId: string;
  componentId: string;
  kind: 'http' | 'grpc' | 'cli' | 'library_api' | 'event' | 'ui' | 'db' | 'other';
  name: string;
  spec?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'calls' | 'reads' | 'writes' | 'publishes' | 'subscribes' | 'imports';
}

export interface StateMachineModel {
  name: string;
  states: string[];
  transitions: Array<{ from: string; to: string; trigger: string }>;
}

export interface SystemModel {
  systemModelId: string;
  runId: string;
  revision: number;
  supersedes?: number;
  subject: { repoRefs: string[]; commitDigests: string[]; buildDigests: string[] };
  components: ComponentModel[];
  interfaces: InterfaceModel[];
  dependencies: DependencyEdge[];
  stateMachines: StateMachineModel[];
  invariants: string[];
  changedComponents: string[];
  riskTags: string[];
  sources: Ref[];
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// OracleSpec — what is correct. Only governed revisions; agents may propose, never self-approve.
// ---------------------------------------------------------------------------------------------

/** Ordered from strongest to weakest for gate weighting. */
export type OracleKind = 'deterministic_invariant' | 'requirement' | 'differential' | 'metamorphic' | 'statistical' | 'llm_semantic';
export const ORACLE_STRENGTH: Record<OracleKind, number> = {
  deterministic_invariant: 5,
  requirement: 4,
  differential: 4,
  metamorphic: 3,
  statistical: 3,
  llm_semantic: 1,
};
export function isDeterministicOracle(kind: OracleKind): boolean {
  return kind !== 'llm_semantic';
}

export type Comparator = '<' | '<=' | '>' | '>=' | '==' | '!=';

/** Machine-checkable form of an assertion, evaluated by the QualityGate against evidence. */
export type OracleCheck =
  | { type: 'test_outcome'; testSelector: string; expected: 'pass' }
  | { type: 'metric_threshold'; metric: string; comparator: Comparator; threshold: number; aggregation?: 'avg' | 'p50' | 'p95' | 'p99' | 'max' | 'min' | 'rate' }
  | { type: 'http_expectation'; method: string; path: string; expectStatus?: number; expectBodyContains?: string }
  | { type: 'evidence_predicate'; evidenceType: string; field: string; comparator: Comparator; value: number | string | boolean }
  | { type: 'llm_rubric'; rubric: string };

export interface OracleAssertion {
  assertionId: string;
  description: string;
  kind: OracleKind;
  severity: Severity;
  check?: OracleCheck;
}

export type OracleAuthority = 'formal_spec' | 'approved_requirement' | 'business_rule' | 'known_good_reference' | 'differential_reference' | 'expert_approved';

export interface OracleSpec {
  oracleId: string;
  revision: number;
  supersedes?: number;
  systemModelRevision?: number;
  scope: { components: string[]; description: string };
  assertions: OracleAssertion[];
  authorities: Array<{ sourceRef: string; authority: OracleAuthority }>;
  judgePolicy: {
    deterministicRequiredForCritical: boolean;
    allowLlmOnlyDecision: boolean;
    independentReviewerRequired: boolean;
  };
  changePolicy: {
    agentMayPropose: boolean;
    selfApprove: false;
    invalidatesPriorDecisions: boolean;
    /** Who may approve: humans, or an independent agent (different agent AND different model provider). */
    approvers: Array<'human' | 'independent_agent'>;
  };
  status: 'draft' | 'approved' | 'invalid';
  approvedBy: ActorRef[];
  approvedAt?: string;
  createdAt: string;
}

export interface OracleChangeProposal {
  proposalId: string;
  runId: string;
  oracleId: string;
  fromRevision: number;
  /** The complete proposed next revision's assertions (full replacement, not a patch). */
  proposedAssertions: OracleAssertion[];
  rationale: string;
  proposedBy: ActorRef;
  /** Evidence of the failure that motivated the change; flipping a recorded failure needs independent approval. */
  relatedEvidenceRefs: string[];
  wouldFlipRecordedFailure: boolean;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: ActorRef;
  decisionRationale?: string;
  createdAt: string;
  decidedAt?: string;
}

// ---------------------------------------------------------------------------------------------
// ExperimentSpec — under which conditions. Without it, evidence has no experimental validity.
// ---------------------------------------------------------------------------------------------

export interface EnvironmentRef {
  environmentId: string;
  environmentClass: string;
  generation: number;
  buildDigest?: string;
  topologyRef?: string;
  dependencyDigests?: string[];
}

export interface WorkloadSpec {
  kind: 'http_load' | 'custom';
  targetUrl?: string;
  ratePerSecond?: number;
  durationMs?: number;
  concurrency?: number;
  scenario?: string;
}

export interface FaultSpec {
  kind: 'process_kill' | 'restart' | 'latency' | 'error_rate' | 'partition' | 'custom';
  target: string;
  atMs?: number;
  params?: Record<string, number | string | boolean>;
}

export interface StopCondition {
  kind: 'duration' | 'error_rate_above' | 'metric_threshold' | 'manual';
  value?: number;
  metric?: string;
}

export interface ContaminationRule {
  description: string;
  /** Resource keys that must not be written by any other experiment during this one. */
  exclusiveResources: string[];
}

export interface ExperimentSpec {
  experimentId: string;
  runId: string;
  revision: number;
  supersedes?: number;
  systemModelRevision?: number;
  oracleRefs: Array<{ oracleId: string; revision: number }>;
  hypothesis: string;
  subjects: Array<{ role: 'baseline' | 'candidate' | 'reference'; buildDigest: string; commit?: string }>;
  environment: EnvironmentRef;
  fixtures: string[];
  workload?: WorkloadSpec;
  faultPlan: FaultSpec[];
  randomSeeds: string[];
  isolation: { mode: 'shared_readonly' | 'exclusive_write' | 'dedicated_environment'; resourceClaims: ResourceClaim[] };
  budget?: Partial<BudgetEnvelope>;
  evidenceRequirements: EvidenceRequirement[];
  stopConditions: StopCondition[];
  contaminationRules: ContaminationRule[];
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// TestArtifact — how it was tested. A test with no demonstrated sensitivity is not eligible evidence.
// ---------------------------------------------------------------------------------------------

export interface RunnerSpec {
  framework: 'node_test' | 'vitest' | 'jest' | 'pytest' | 'go_test' | 'http' | 'command' | (string & {});
  selector: string;
  command?: string[];
  workingDirectory?: string;
}

export interface TestValidation {
  status: 'passed' | 'failed' | 'not_run';
  evidenceRefs: string[];
  detail?: string;
}

export type TestArtifactApproval = 'draft' | 'validated' | 'approved' | 'quarantined' | 'retired';

export interface TestArtifact {
  artifactId: string;
  runId: string;
  revision: number;
  supersedes?: number;
  path: string;
  artifactDigest: string;
  sourceType: 'existing' | 'generated' | 'repaired' | 'mutated';
  generatedBy?: { agentId: string; modelEpochId?: string; contextSnapshotId?: string };
  systemModelRevision?: number;
  oracleRefs: Array<{ oracleId: string; revision: number; assertionIds: string[] }>;
  experimentId?: string;
  runner: RunnerSpec;
  validations: {
    /** Must pass on known-good code (e.g. base commit or reference). */
    knownGood?: TestValidation;
    /** Must fail on known-bad code (seeded defect / mutation). */
    knownBad?: TestValidation;
    mutationScore?: number;
  };
  approvalState: TestArtifactApproval;
  createdAt: string;
}

/** A generated test is eligible as gate evidence only after it demonstrated sensitivity. */
export function isEligibleTestArtifact(a: TestArtifact): boolean {
  if (a.approvalState === 'quarantined' || a.approvalState === 'retired' || a.approvalState === 'draft') return false;
  if (a.sourceType === 'existing') return true;
  const sensitive = a.validations.knownBad?.status === 'passed' || (a.validations.mutationScore ?? 0) > 0;
  const good = a.validations.knownGood === undefined || a.validations.knownGood.status === 'passed';
  return sensitive && good;
}

// ---------------------------------------------------------------------------------------------
// Gates and QualityDecision — what may be claimed. Only the QualityGate produces decisions.
// ---------------------------------------------------------------------------------------------

export type QualityVerdict = 'pass' | 'fail' | 'conditional' | 'inconclusive';

export interface GateSpec {
  gateId: string;
  description: string;
  /** Minimum severity of unresolved findings that fails the gate (default P1: P0/P1 fail). */
  failOnUnresolvedSeverity: Severity;
  /** Unresolved risks at or above this level make the verdict at best `conditional`. */
  conditionalOnRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiredEvidence: EvidenceRequirement[];
  /** Critical oracle assertions (P0/P1) need deterministic evidence (I7). */
  requireDeterministicForCritical: boolean;
  requireIndependentReview: boolean;
  minCoverage?: { lines?: number; branches?: number };
}

export interface CriterionResult {
  criterionId: string;
  description: string;
  status: 'satisfied' | 'violated' | 'unknown';
  evidenceRefs: string[];
  detail?: string;
}

export interface ReviewerDecision {
  reviewRecordId: string;
  reviewerAgentId: string;
  verdict: 'approve' | 'reject' | 'needs_more_evidence' | 'unknown';
  modelProvider?: string;
}

export interface ApprovedException {
  criterionId: string;
  approvedBy: ActorRef;
  rationale: string;
  expiresAt?: string;
}

export interface QualityDecision {
  decisionId: string;
  runId: string;
  revision: number;
  supersedes?: string;
  gateId: string;
  scope: { description: string; objectiveIds: string[] };
  verdict: QualityVerdict;
  requiresHumanReview: boolean;
  systemModelRevision?: number;
  oracleRevisions: Record<string, number>;
  experimentRevisions: Record<string, number>;
  evidenceRootHash: string;
  evidenceCount: number;
  satisfiedCriteria: CriterionResult[];
  violatedCriteria: CriterionResult[];
  unknownCriteria: CriterionResult[];
  unresolvedFindings: string[];
  unresolvedRisks: string[];
  exceptions: ApprovedException[];
  reviewerDecisions: ReviewerDecision[];
  /** Human-readable reasons, in rule order. */
  reasons: string[];
  runtimeManifestId: string;
  policyRevision: string;
  signature?: { keyId: string; algorithm: string; value: string };
  decidedAt: string;
}
