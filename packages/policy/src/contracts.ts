import type { BaseDeps, Clock, JsonValue, SqlDatabase } from '@hypertest/core';
import type {
  ActionCapability, ActorRef, ApprovedException, BlackboardRecord, CoverageGap, DomainEventSink, EventContext, EvidenceRecord,
  ExperimentSpec, Finding, GateSpec, Objective, OracleAssertion, OracleChangeProposal, OracleSpec, PermissionProfile, QualityDecision,
  QualityVerdict, ReportClaim, Review, Risk, RiskClass, TestArtifact, TestRun, ToolEffect, WorkItem,
} from '@hypertest/domain';

/**
 * @hypertest/policy — governance outside the model: capabilities (I2), action permits (I1), oracle
 * governance and self-heal classification (I8), the deterministic QualityGate (I7), and the BUGate
 * Protocol binding.
 *
 * Implementations to export from src/index.ts:
 *   capabilities: createRootCapability, attenuateCapability (optional 4th arg AttenuateOptions), capabilityAllows, signCapability,
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
 *   (additive, phases) POLICY_PHASES, requestPhase, flaggedActionsOf, IMPLICIT_EVIDENCE_TYPES, actionOutcomeFacts,
 *   acceptanceFacts, applyPhasePermit, withPolicyHold — the BUGate four time points (see PolicyPhase)
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

/**
 * Additive: pattern flavours. Tool patterns: exact id, trailing-`*` prefix glob (`git.*`, `oracle.approve*`)
 * or `*`. Resource patterns: `/`-separated segments; `*` matches exactly one segment, `**` zero or more.
 */
export type PatternKind = 'tool' | 'resource';

/** Additive: names of the built-in permission profiles (see PERMISSION_PROFILES). */
export type PermissionProfileName = 'read_only' | 'analyst' | 'test_author' | 'test_executor' | 'environment_operator' | 'product_fixer';

/** Additive: input of createRootCapability(input, secret). */
export interface RootCapabilityInput {
  runId: string;
  subjectAgentId: string;
  workItemId: string;
  /** A built-in profile name or an explicit profile. */
  profile: PermissionProfileName | PermissionProfile;
  /** Tool patterns (default `['*']`; the role tool policy narrows tools separately). */
  tools?: string[];
  expiresAt: string;
  /** Defaults to a fresh `cap_…` id. */
  capabilityId?: string;
}

/**
 * Additive: optional 4th argument of attenuateCapability. With `secret`, the parent's HMAC is verified
 * (permission_denied when invalid) and the child is returned signed with the same secret.
 */
export interface AttenuateOptions {
  secret?: string;
}

/** Additive: identity of the child produced by attenuateCapability(parent, constraints, child). */
export interface ChildCapabilityIdentity {
  subjectAgentId: string;
  workItemId: string;
  /** Defaults to a fresh `cap_…` id. */
  capabilityId?: string;
}

// ----------------------------------------------------------------------------- permits

/**
 * (additive) The four BUGate time points at which the PolicyEngine is evaluated (technology-selection §BUGate):
 *  - `before_action`     may this tool call run? (the ToolRuntime; the only phase that authorizes an effect);
 *  - `after_action`      what did the executed call produce? (e.g. evidence of a type its tool does not declare) — a
 *                        non-allow permit FLAGS the call (it already happened); flags feed the later phases;
 *  - `before_transition` may the work item complete / the plan be accepted / the run be gated?
 *  - `before_acceptance` may the run claim its gate verdict? (the gate input digest + the gate's verdict) — a non-allow
 *                        permit caps the verdict at `inconclusive` with requiresHumanReview, never `pass`.
 * A request without `phase` is `before_action`; a rule without `match.phases` applies to `before_action` only (every
 * rule set written before the phases existed keeps its meaning).
 */
export type PolicyPhase = 'before_action' | 'after_action' | 'before_transition' | 'before_acceptance';

/** (additive) after_action facts: what an executed tool call produced. */
export interface ActionOutcomeFacts {
  /** The tool call's status (success, failed, timeout, pending …). */
  status: string;
  /** Types of the evidence records written by this very call (sorted, unique). */
  evidenceTypes: string[];
  evidenceIds: string[];
  /**
   * The evidence types the tool declares (the runtime's implicit `tool-output` offload included); absent when the tool
   * declares none — its evidence is then not judged (`undeclaredEvidenceTypes` is empty).
   */
  declaredEvidenceTypes?: string[];
  /** evidenceTypes the tool does not declare (sorted, unique). */
  undeclaredEvidenceTypes: string[];
}

/** (additive) before_transition facts: the state change asked for. */
export interface TransitionFacts {
  subject: 'work_item' | 'plan' | 'run';
  subjectId: string;
  from: string;
  to: string;
  /** Calls of the subject (the work item's own, the run's for a plan or the run) flagged at after_action. */
  flaggedActions: number;
  /** The agent asking for the transition (absent for system transitions such as run gating). */
  requestedBy?: { agentId: string; role: string };
  details?: Record<string, JsonValue>;
}

/** (additive) before_acceptance facts: a bounded digest of the QualityGate input and the gate's own verdict. */
export interface AcceptanceFacts {
  gateId: string;
  gateSpecDigest?: string;
  /** `field=value` of each effective gate field that differs from DEFAULT_GATE_SPEC. */
  gateOverrides: string[];
  /** The recorded human/system authority of a weakened gate (conformance-9), when the run has one. */
  gateOverrideAuthority?: { by: ActorRef; rationale: string; weakened: string[] };
  /**
   * The verdict up for acceptance: the deterministic gate's, after any hold placed before acceptance (an unauthorized gate
   * weakening, a refused run gating — each listed in unknownCriteria); never raised by those holds.
   */
  verdict: QualityVerdict;
  requiresHumanReview: boolean;
  satisfiedCriteria: string[];
  violatedCriteria: string[];
  unknownCriteria: string[];
  evidence: { count: number; rootHash: string; byType: Record<string, number> };
  findings: { total: number; unresolved: string[] };
  risks: { total: number; unresolved: string[] };
  reviews: Array<{ recordId: string; verdict: string; modelProvider?: string }>;
  oracleRevisions: Record<string, number>;
  /** Work items by state. */
  workItems: Record<string, number>;
  claims: { total: number; critical: number };
  /** Criteria waived by an applied exception. */
  exceptions: string[];
  /** Calls of the run flagged at after_action. */
  flaggedActions: number;
}

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
  /** The BUGate time point (absent ⇒ `before_action`); see PolicyPhase. */
  phase?: PolicyPhase;
  snapshotId?: string;
  /** (additive) after_action: what the executed call produced. */
  outcome?: ActionOutcomeFacts;
  /** (additive) before_transition: the state change asked for. */
  transition?: TransitionFacts;
  /** (additive) before_acceptance: the gate input digest and the gate's verdict. */
  acceptance?: AcceptanceFacts;
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

/**
 * Additive: options of BuiltinPolicyEngine / CompositePolicyEngine / OpaPolicyEngine.
 * `newId` produces ActionPermit.decisionId (default `pdec_<ulid>`); `clock` supplies `now` for capability
 * expiry; `capabilitySecret`, when given, makes the engine verify the capability HMAC (deny when invalid).
 */
export interface PolicyEngineOptions {
  newId?: () => string;
  clock?: Clock;
  capabilitySecret?: string;
}

export interface OpaPolicyEngineOptions extends PolicyEngineOptions {
  url: string;
  /** Data path of the decision document (default `hypertest/authz`). */
  path?: string;
  timeoutMs?: number;
  revision: string;
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Declarative built-in rule: every matching rule is evaluated and the most restrictive decision wins
 * (deny > approval_required > allow); no matching rule ⇒ deny. A rule matches when every given `match`
 * field matches. `resources`: an allow rule requires a non-empty resource list fully covered by its
 * patterns; a deny/approval rule matches when any resource matches (fail closed either way).
 */
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
    /** (additive) The phases the rule applies to; absent ⇒ `['before_action']` (an action permit rule). */
    phases?: PolicyPhase[];
    /** (additive) before_transition: `<subject>:<to>` patterns with tool-pattern semantics (`work_item:completed`, `plan:*`). */
    transitions?: string[];
    /** (additive) after_action: true matches a call that produced evidence of a type its tool does not declare (false: none). */
    undeclaredEvidence?: boolean;
    /** (additive) before_transition / before_acceptance: true matches a subject with flagged calls (false: none). */
    flaggedActions?: boolean;
    /** (additive) before_acceptance: the deterministic gate verdicts the rule applies to. */
    verdicts?: QualityVerdict[];
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
  /**
   * `gate_exception` (additive, conformance-11): a waiver of one QualityGate criterion for the run — subject
   * `{ criterionId, expiresAt? }`. Only an approved one decided by a human/system actor is applied (never C1, never
   * expired; the gate enforces it).
   */
  kind: 'action' | 'oracle_change' | 'test_change' | 'budget' | 'manual_review' | 'gate_exception';
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
  /**
   * Additive: model providers of the agents that produced findings/tests/evidence in this run. An
   * approving review counts as independent only when its modelProvider is none of these.
   */
  producerProviders?: string[];
  /** Additive: QualityDecision.revision / supersedes (default 1 / none). */
  revision?: number;
  supersedes?: string;
  /**
   * (additive, conformance-4) The latest APPROVED revision of each oracle the run pins, when it is newer than the pinned
   * one: a pinned revision below it was superseded during the run, and C0 is unknown (the verdict would rest on a
   * replaced criterion).
   */
  currentOracleRevisions?: Record<string, number>;
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
  /** Additive: PreparedProtocolContext.workspace.workspace_digest. */
  workspaceDigest?: string | null;
}

export type { PermissionProfile };
