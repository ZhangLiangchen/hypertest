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

/** (additive, coverage-12) A data asset of the system (architecture-improvements §SystemModel `dataAssets`). */
export interface DataAssetModel {
  assetId: string;
  name: string;
  kind: 'database' | 'table' | 'collection' | 'bucket' | 'queue' | 'topic' | 'cache' | 'file' | 'secret' | 'other';
  /** The component that owns / stores it. */
  componentId?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  description?: string;
}

/** (additive, coverage-12) A security boundary of the system (§SystemModel `securityBoundaries`). */
export interface SecurityBoundary {
  boundaryId: string;
  name: string;
  kind: 'network' | 'authentication' | 'authorization' | 'tenant' | 'process' | 'trust' | 'other';
  /** Components inside the boundary. */
  components: string[];
  description?: string;
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
  /** (additive, coverage-12) Data assets; absent only on revisions recorded before the field existed. */
  dataAssets?: DataAssetModel[];
  /** (additive, coverage-12) Security boundaries; absent only on revisions recorded before the field existed. */
  securityBoundaries?: SecurityBoundary[];
  changedComponents: string[];
  riskTags: string[];
  /** Provenance of the model (evidence ids, files, commits it was derived from). */
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
  /**
   * (additive, D-10) On a revision whose status is `invalid`: the earlier revision it declares invalid (append-only: the
   * invalid revision is a new row, history is never updated), why, and by which human/system authority.
   */
  invalidation?: { revision: number; reason: string; by: ActorRef; at: string };
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
  /**
   * (additive, wave 3) + the container faults of docker environments (`pause`, `kill`, `network_disconnect`, `netem`)
   * and Kubernetes environments (`pod_delete`, `scale_zero`, `network_deny`) that env.inject_fault injects.
   */
  kind: 'process_kill' | 'restart' | 'latency' | 'error_rate' | 'partition' | 'custom' | 'pause' | 'kill' | 'network_disconnect' | 'netem' | 'pod_delete' | 'scale_zero' | 'network_deny';
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

/**
 * (additive, coverage-13) A deterministic contamination check the QualityGate applies to an experiment (criterion
 * experiment_validity): `foreign_operations` — no operation of another work item/experiment touched `resources` during the
 * experiment; `environment_generation` — the environment's generation stayed the experiment's (only its own declared
 * restarts/deploys may bump it); `exclusive_claims` — its admission claims never lapsed.
 */
export interface ContaminationCheck {
  kind: 'foreign_operations' | 'environment_generation' | 'exclusive_claims';
  resources?: string[];
}

/**
 * (additive, coverage-13) The isolation plan of architecture-improvements §并发实验隔离: claims plus what the environment
 * dedicates to the experiment. `dedicated*` are taken from the environment's registration (never claimed by an agent).
 */
export interface IsolationPlan {
  dedicatedEnvironment: boolean;
  dedicatedNamespace?: string;
  dedicatedDatabase?: string;
  dedicatedAccount?: string;
  contaminationChecks: ContaminationCheck[];
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
  isolation: { mode: 'shared_readonly' | 'exclusive_write' | 'dedicated_environment'; resourceClaims: ResourceClaim[]; plan?: IsolationPlan };
  /** Per-experiment budget (maxToolCalls, maxWallClockMs, maxExternalQps, maxComputeMinutes are enforced on its actions). */
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
  /**
   * (additive, conformance-10) The tree digest of the code the validating run executed (its evidence's
   * `workspaceDelta.treeDigest`): known-good and known-bad must have run on different code.
   */
  codeDigest?: string;
  /** (additive, D-0) The artifact content digest the validating evidence executed (its `executedTests` entry). */
  artifactDigest?: string;
  /** (additive, D-1) Which code the run executed: the candidate workspace, or the base (known-good) revision. */
  revision?: 'workspace' | 'base';
}

export type TestArtifactApproval = 'draft' | 'validated' | 'approved' | 'quarantined' | 'retired';

/**
 * (additive, D-1) The oracle consistency review of an artifact: an approving review by an agent/role other than its
 * creator, against the oracle revisions in force (approvalState `approved`), or a rejection (back to `draft`).
 */
export interface TestArtifactReview {
  reviewRecordId: string;
  reviewerAgentId: string;
  reviewerRole: string;
  modelProvider?: string;
  verdict: 'approve' | 'reject';
  /** The content digest that was reviewed. */
  artifactDigest: string;
  /** oracleId → revision of every oracle the artifact's oracleRefs name, as in force at the review. */
  oracleRevisions: Record<string, number>;
  at: string;
}

export interface TestArtifact {
  artifactId: string;
  runId: string;
  revision: number;
  supersedes?: number;
  path: string;
  artifactDigest: string;
  sourceType: 'existing' | 'generated' | 'repaired' | 'mutated';
  /** (additive) `role`: the creator's role (the oracle consistency review must come from another role). */
  generatedBy?: { agentId: string; role?: string; modelEpochId?: string; contextSnapshotId?: string };
  systemModelRevision?: number;
  oracleRefs: Array<{ oracleId: string; revision: number; assertionIds: string[] }>;
  experimentId?: string;
  runner: RunnerSpec;
  validations: {
    /** (additive, D-1) Syntax/static validation of exactly this content (node --check, TS strip, py_compile, gofmt -e). */
    static?: TestValidation;
    /** Must pass on known-good code (e.g. base commit or reference). */
    knownGood?: TestValidation;
    /**
     * (additive, D-1) Why no known-good revision can exist (e.g. a new behaviour the base lacks and no fix exists yet):
     * the artifact may become eligible gate evidence, but never supports or violates a P0/P1 assertion.
     */
    knownGoodUnavailable?: { reason: string; recordedBy: string; at: string };
    /** Must fail on known-bad code (seeded defect / mutation). */
    knownBad?: TestValidation;
    /** (additive, D-0) The bound mutation run (executed exactly this artifact's file and content). */
    mutation?: TestValidation & { killed?: number; score?: number };
    mutationScore?: number;
  };
  approvalState: TestArtifactApproval;
  /** (additive, D-1) The oracle consistency review that approved (or rejected) this content. */
  oracleReview?: TestArtifactReview;
  createdAt: string;
}

/**
 * A generated (repaired, mutated) test is eligible as gate evidence only after it completed EVERY lifecycle stage of
 * architecture-improvements §TestArtifact: static validation passed, known-good passed (or an explicit reason why no
 * known-good revision can exist), known-bad or mutation failed (sensitivity), and an approving oracle consistency review
 * (`approved`). This is the structural pre-check of the recorded state; the QualityGate re-derives every stage from the
 * cited evidence and review records (policy `artifactEligibility`) and never trusts these fields alone.
 */
export function isEligibleTestArtifact(a: TestArtifact): boolean {
  if (a.approvalState === 'quarantined' || a.approvalState === 'retired' || a.approvalState === 'draft') return false;
  if (a.sourceType === 'existing') return true;
  if (a.approvalState !== 'approved' || a.oracleReview?.verdict !== 'approve' || a.oracleReview.artifactDigest !== a.artifactDigest) return false;
  const v = a.validations;
  const statics = v.static?.status === 'passed';
  const good = v.knownGood?.status === 'passed' || (v.knownGood === undefined && v.knownGoodUnavailable !== undefined && v.knownGoodUnavailable.reason.trim() !== '');
  const sensitive = v.knownBad?.status === 'passed' || v.mutation?.status === 'passed';
  return statics && good && sensitive;
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
  /**
   * (additive, conformance-1) A verdict other than `inconclusive` needs an oracle in force (criterion C0): at least one
   * approved oracle pinned by the run with at least one deterministic P0/P1 assertion. Absent means true; only an explicit
   * `false` (a recorded gate override) clears it.
   */
  requireOracle?: boolean;
  /**
   * (additive, coverage-1) "OracleSpec + ExperimentSpec + QualityDecision are not optional" (criterion C12
   * domain_contracts): the run must have a SystemModel revision (recorded by analysis, with at least one component) and
   * every write / fault-injection / load action (an operation of an external or destructive tool) must belong to an
   * ExperimentSpec. Absent means true; only an explicit `false` (a recorded gate override) clears it.
   */
  requireContracts?: boolean;
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
  /** (additive, coverage-1) The SystemModel the revision belongs to (with systemModelRevision: locatable). */
  systemModelId?: string;
  /** (additive, D-9) Build identities the decision judged (the SystemModel subject and the experiments' subjects). */
  buildDigests?: string[];
  oracleRevisions: Record<string, number>;
  experimentRevisions: Record<string, number>;
  /** (additive, coverage-1) artifactId → latest revision of every TestArtifact of the run at the gate. */
  testArtifactRevisions?: Record<string, number>;
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
  /**
   * (additive, conformance-9) sha256 of the canonical JSON of the effective GateSpec that produced this verdict — signed
   * with the decision, so the gate is bound to it, not only its `gateId`.
   */
  gateSpecDigest?: string;
  /**
   * (additive, conformance-9) The effective GateSpec fields that differ from the default gate, as `field=value`
   * (canonical JSON values): a weakened run-level override is visible in the signed decision and the report.
   */
  gateOverrides?: string[];
  signature?: { keyId: string; algorithm: string; value: string };
  decidedAt: string;
}
