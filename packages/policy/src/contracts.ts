import type { BaseDeps, JsonValue, SqlDatabase } from '@hypertest/core';
import type {
  ActionCapability, ActorRef, ApprovedException, BlackboardRecord, CoverageGap, DomainEventSink, EventContext, EvidenceRecord,
  ExperimentSpec, Finding, GateSpec, Objective, OracleAssertion, OracleChangeProposal, OracleSpec, PermissionProfile, QualityDecision,
  ReportClaim, Review, Risk, RiskClass, TestArtifact, TestRun, ToolEffect, WorkItem,
} from '@hypertest/domain';

/**
 * @hypertest/policy — governance outside the model: capabilities (I2), action permits (I1), oracle
 * governance and self-heal classification (I8), the deterministic QualityGate (I7), and the BUGate
 * Protocol binding.
 *
 * Implementations to export from src/index.ts:
 *   capabilities: createRootCapability, attenuateCapability, capabilityAllows, signCapability,
 *                 verifyCapability, matchesPattern, PERMISSION_PROFILES (read_only, analyst, test_author,
 *                 test_executor, environment_operator, product_fixer)
 *   class BuiltinPolicyEngine implements PolicyEngine   (constructor(rules: PolicyRule[], revision: string))
 *   DEFAULT_POLICY_RULES: PolicyRule[]
 *   class OpaPolicyEngine implements PolicyEngine        ({ url, path: 'hypertest/authz', timeoutMs, revision });
 *                                                         OPA unavailable ⇒ deny (fail closed)
 *   class CompositePolicyEngine implements PolicyEngine  (deny > approval_required > allow; constraints intersected)
 *   createPolicyDecisionLog(deps): PolicyDecisionLog
 *   createApprovalService(deps): ApprovalService
 *   createOracleGovernance(deps: OracleGovernanceDeps): OracleGovernance
 *   classifyTestChange(diff: string, options?: ClassifyOptions): TestChangeClassification
 *   class QualityGate { evaluate(input: GateInput): QualityDecision }   (pure, deterministic)
 *   DEFAULT_GATE_SPEC: GateSpec
 *   resolveProtocolBinding(options: { bugatePath?: string }): Promise<ResolvedProtocol>
 *   prepareProtocolContext(protocol: ResolvedProtocol, request: ProtocolContextRequest): PreparedProtocolContext
 *   policyMigrations: Migration[]  (ht_policy_decisions, ht_approvals)
 */

// ----------------------------------------------------------------------------- capabilities

export interface CapabilityConstraints {
  tools?: string[];
  resourceScopes?: string[];
  allowedEffects?: ToolEffect[];
  credentialScopes?: string[];
  maxRiskClass?: RiskClass;
  environmentClasses?: string[];
  expiresAt?: string;
}

export interface CapabilityCheckRequest {
  tool: string;
  effect: ToolEffect;
  riskClass: RiskClass;
  /** Concrete resource keys the action touches (e.g. `workspace/wt_1/src/a.ts`, `env/staging`). */
  resources: string[];
  environmentClass?: string;
  credentialScopes?: string[];
  now: string;
}

export type CapabilityCheck = { allowed: true } | { allowed: false; reason: string };

// ----------------------------------------------------------------------------- permits

export interface ActionRequest {
  requestId: string;
  runId: string;
  workItemId?: string;
  agentId?: string;
  role?: string;
  tool: string;
  effect: ToolEffect;
  riskClass: RiskClass;
  resources: string[];
  environmentClass?: string;
  capability: ActionCapability;
  /** Redacted tool input (secrets removed) for policy evaluation and decision logs. */
  input?: JsonValue;
  phase?: 'before_action' | 'after_action' | 'before_transition' | 'before_acceptance';
  snapshotId?: string;
}

export interface PermitConstraints {
  allowedPaths?: string[];
  allowedHosts?: string[];
  allowedCommands?: string[];
  credentialScope?: string[];
  maxDurationMs?: number;
}

export interface ActionPermit {
  decision: 'allow' | 'deny' | 'approval_required';
  decisionId: string;
  reasons: string[];
  constraints?: PermitConstraints;
  policyRevision: string;
  /** Present when decision = approval_required. */
  approvalId?: string;
}

export interface PolicyEngine {
  readonly revision: string;
  evaluate(request: ActionRequest): Promise<ActionPermit>;
}

/** Declarative built-in rule: first matching rule with the most restrictive decision wins. */
export interface PolicyRule {
  id: string;
  description: string;
  match: {
    tools?: string[];
    effects?: ToolEffect[];
    minRisk?: RiskClass;
    roles?: string[];
    environmentClasses?: string[];
    resources?: string[];
  };
  decision: 'allow' | 'deny' | 'approval_required';
  constraints?: PermitConstraints;
}

export interface PolicyDecisionRecord {
  decisionId: string;
  runId: string;
  requestHash: string;
  request: ActionRequest;
  permit: ActionPermit;
  decidedAt: string;
}

export interface PolicyDecisionLog {
  record(request: ActionRequest, permit: ActionPermit, ctx: EventContext): Promise<PolicyDecisionRecord>;
  get(decisionId: string): Promise<PolicyDecisionRecord | undefined>;
  list(runId: string): Promise<PolicyDecisionRecord[]>;
}

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  kind: 'action' | 'oracle_change' | 'test_change' | 'budget' | 'manual_review';
  subject: JsonValue;
  requestedBy: ActorRef;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy?: ActorRef;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ApprovalService {
  request(input: Omit<ApprovalRequest, 'approvalId' | 'status' | 'createdAt'>, ctx: EventContext): Promise<ApprovalRequest>;
  /** The requester can never approve their own request. */
  decide(approvalId: string, approve: boolean, decidedBy: ActorRef, rationale: string, ctx: EventContext): Promise<ApprovalRequest>;
  get(approvalId: string): Promise<ApprovalRequest | undefined>;
  list(filter: { runId?: string; status?: ApprovalRequest['status'][] }): Promise<ApprovalRequest[]>;
}

export interface PolicyDeps extends BaseDeps {
  db: SqlDatabase;
  events?: DomainEventSink;
}

// ----------------------------------------------------------------------------- oracle governance

/** Storage port implemented structurally by @hypertest/collab SpecRepository/DecisionRepository. */
export interface OracleStorePort {
  saveOracle(spec: Omit<OracleSpec, 'revision' | 'createdAt' | 'supersedes'> & { revision?: number }, ctx: EventContext): Promise<OracleSpec>;
  getOracle(oracleId: string, revision?: number): Promise<OracleSpec | undefined>;
  saveOracleProposal(p: OracleChangeProposal, ctx: EventContext): Promise<OracleChangeProposal>;
  getOracleProposal(proposalId: string): Promise<OracleChangeProposal | undefined>;
}

export interface DecisionInvalidationPort {
  findByOracleRevision(oracleId: string, revision: number): Promise<QualityDecision[]>;
  markNeedsReassessment(decisionId: string, reason: string, ctx: EventContext): Promise<void>;
}

export interface OracleGovernanceDeps extends BaseDeps {
  store: OracleStorePort;
  decisions?: DecisionInvalidationPort;
  events?: DomainEventSink;
  /** Returns true when applying the proposal would turn an already recorded failure into a pass. */
  wouldFlipRecordedFailure?: (proposal: OracleChangeProposal) => Promise<boolean>;
}

export interface OracleGovernance {
  /** Imports/creates an approved oracle from an authority (human, requirement import). Agents cannot call this. */
  establish(spec: Omit<OracleSpec, 'revision' | 'createdAt' | 'supersedes' | 'status' | 'approvedBy' | 'approvedAt'>, approver: ActorRef, ctx: EventContext): Promise<OracleSpec>;
  propose(input: { runId: string; oracleId: string; fromRevision: number; proposedAssertions: OracleAssertion[]; rationale: string; relatedEvidenceRefs: string[] }, proposedBy: ActorRef, ctx: EventContext): Promise<OracleChangeProposal>;
  /**
   * Rejects (permission_denied) self-approval, approval by an agent sharing the proposer's model provider,
   * and approver kinds not listed in changePolicy.approvers. Approval creates a new OracleSpec revision and,
   * when invalidatesPriorDecisions, marks decisions based on the old revision needs_reassessment.
   */
  decide(proposalId: string, approve: boolean, decidedBy: ActorRef, rationale: string, ctx: EventContext): Promise<{ proposal: OracleChangeProposal; newRevision?: OracleSpec; invalidatedDecisions: string[] }>;
}

// ----------------------------------------------------------------------------- self-heal classification

export type TestChangeCategory =
  | 'locator'
  | 'environment_setup'
  | 'fixture'
  | 'test_implementation'
  | 'timeout'
  | 'assertion'
  | 'threshold'
  | 'product_code'
  | 'test_deleted'
  | 'test_skipped'
  | 'exception_swallowed'
  | 'unknown';

export type SelfHealDecision = 'auto_allowed' | 'conditional' | 'approval_required' | 'forbidden';

export interface TestChangeFinding {
  file: string;
  line?: number;
  category: TestChangeCategory;
  detail: string;
}

export interface TestChangeClassification {
  /** Most restrictive decision across all findings. */
  decision: SelfHealDecision;
  categories: TestChangeCategory[];
  findings: TestChangeFinding[];
}

export interface ClassifyOptions {
  /** Globs identifying test files (default: common test naming across JS/TS/Python/Go). */
  testPathPatterns?: string[];
  /** Product changes are allowed only when the agent holds a product_fixer capability. */
  productFixAuthorized?: boolean;
}

// ----------------------------------------------------------------------------- quality gate

export interface GateInput {
  run: TestRun;
  gate: GateSpec;
  objectives: Objective[];
  oracles: OracleSpec[];
  experiments: ExperimentSpec[];
  findings: BlackboardRecord<Finding>[];
  risks: BlackboardRecord<Risk>[];
  reviews: BlackboardRecord<Review>[];
  coverageGaps: BlackboardRecord<CoverageGap>[];
  testArtifacts: TestArtifact[];
  evidence: EvidenceRecord[];
  evidenceRoot: { rootHash: string; count: number };
  workItems: WorkItem[];
  claims: ReportClaim[];
  exceptions: ApprovedException[];
  runtimeManifestId: string;
  policyRevision: string;
  decisionId: string;
  now: string;
}

// ----------------------------------------------------------------------------- BUGate protocol

/** Mirrors BUGate protocol/v2/schemas/prepared_protocol_context.schema.json. */
export type QualityPosture = 'unclaimed' | 'draft' | 'candidate' | 'satisfactory' | 'needs_improvement' | 'incomplete' | 'uncertain';

export interface PreparedProtocolContext {
  apiVersion: 'bugate.io/v2';
  kind: 'PreparedProtocolContext';
  protocol: { id: 'bugate'; version: string; digest: string };
  workspace: { task_id: string; workspace_digest?: string | null };
  quality_posture: Record<string, QualityPosture>;
  active_concerns: Array<{ code: string; subject?: string | null; severity?: string | null; message?: string | null }>;
  render: { media_type: 'text/markdown' | 'text/plain'; bytes: number; content: string };
}

export interface ResolvedProtocol {
  binding: { protocolId: 'bugate'; version: string; digest: string; source: { kind: 'bugate_checkout'; path: string } | { kind: 'embedded' } };
  /** Methodology sections keyed by topic (principles, layers, oracle discipline, evidence discipline, …). */
  methodology: Record<string, string>;
  /** JSON schema used to validate PreparedProtocolContext (from the checkout when present, else embedded). */
  contextSchema: Record<string, unknown>;
}

export interface ProtocolContextRequest {
  taskId: string;
  role: string;
  phase: 'analysis' | 'design' | 'implementation' | 'execution' | 'diagnosis' | 'review' | 'acceptance';
  qualityPosture?: Record<string, QualityPosture>;
  activeConcerns?: PreparedProtocolContext['active_concerns'];
  maxBytes?: number;
}

export type { PermissionProfile };
