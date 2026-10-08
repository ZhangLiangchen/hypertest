import type { BaseDeps, Logger, SqlDatabase } from '@hypertest/core';
import type { ArtifactRef, ChatMessage, ContextSnapshot, DomainEventSink, EventContext, ReadSetEntry, Ref, ReportClaim } from '@hypertest/domain';

/**
 * @hypertest/context — the layered Context Engine (L0–L5). The model never owns canonical state; it
 * sees projections that reference an immutable ContextSnapshot.
 *
 *   L0 Event Store         → @hypertest/collab EventStore (read here for rebuild/provenance)
 *   L1 Prompt Assembly     → PromptAssembler
 *   L2 Working Context     → WorkingContextManager + Condenser (soft/hard; reversible because L0 keeps all)
 *   L3 Retrieval Context   → ExactSearch, SymbolIndex, VectorIndex (+Embedder), HybridRetriever
 *   L4 Durable Context     → DurableMemory (ExperienceStore SQL; PowerContextClient HTTP)
 *   L5 Provenance Context  → ProvenanceService
 *
 * Implementations to export from src/index.ts:
 *   createSnapshotStore(deps: ContextDeps): SnapshotStore
 *   createSnapshotBuilder(deps: SnapshotBuilderDeps): SnapshotBuilder
 *   createFreshnessGuard(deps: ContextDeps & { snapshots: SnapshotStore }): FreshnessGuard
 *   class PromptAssembler (assemble(input: AssemblyInput): AssemblyResult)
 *   createWorkingContextManager(options?: { keepRecentTurns?: number; softRatio?: number; hardRatio?: number }): WorkingContextManager
 *   deterministicSummarizer: Summarizer   (extractive fallback: keeps tool names, errors, evidence refs, decisions)
 *   class ExactSearch implements Retriever (ripgrep when on PATH, else JS walker; respects .gitignore basics)
 *   class SymbolIndex implements Retriever (regex symbol extraction for ts/js/py/go; definitions + references)
 *   class HashEmbedder implements Embedder (deterministic feature hashing, 256 dims)
 *   class InMemoryVectorIndex implements VectorIndex; createPgVectorIndex(db, embedder): Promise<VectorIndex>
 *     (pgvector; throws unsupported if unavailable — the embedder supplies dims + modelId, see README)
 *   class HybridRetriever implements Retriever (reciprocal-rank fusion over child retrievers)
 *   createExperienceStore(deps: ContextDeps): DurableMemory
 *   class PowerContextClient implements DurableMemory ({ baseUrl, apiKey?, timeoutMs })
 *   createProvenanceService(deps: ProvenanceDeps): ProvenanceService
 *   contextMigrations: Migration[] (ht_context_snapshots, ht_experience, ht_vectors (only if vector ext))
 *
 * Additive exports (v0.3 implementation):
 *   createResolverRegistry(resolvers?: ResourceVersionResolver[]): ResolverRegistry
 *   functionResolver(resourceType, fn), environmentResolver(getEnv), oracleResolver(getOracle),
 *   experimentResolver(getExperiment), recordResolver(getHead, options?), leaseResolver(getLease),
 *   fileResolver(root, options?)                     — built-in ResourceVersionResolvers over structural ports
 *   snapshotIdFor(content): string                   — the content address used by SnapshotStore.create
 *   offloadToolResult(artifacts, message, options?)   — I9 helper: large tool output → artifact + bounded digest
 *   extractEvidenceIds(text), extractRecordIds(text) — id scanners used by condense()
 *   createFreshnessGuard also accepts `resolvers?: ResolverRegistry` (default: an empty registry ⇒ fail closed).
 *   createWorkingContextManager takes WorkingContextOptions (adds summaryRatio, maxToolResultTokens).
 *   ht_vectors is created lazily by createPgVectorIndex (never by contextMigrations); rows are keyed by
 *     (model_id, id) so indexes of different embedders never overwrite or remove each other's documents.
 *   pinnedEntries(snapshot)                          — the snapshot's pinned environment/oracle/experiment versions
 *                                                      as exact_version entries (FreshnessGuard checks them too)
 *   sameActor(a, b), creatorActing(createdBy, reviewer, ctx) — the reviewer ≠ creator rule (trimmed, case-insensitive;
 *                                                      the acting ctx.actorId/agentId counts as well)
 *   resolveLimit(limit, fallback)                    — result limits: non-finite ⇒ invalid_argument
 *   (context engine completion)
 *   createObservationLog(deps): ObservationLog         — what agents observed (ht_context_observations, append-only)
 *   observationsOf(call, result, ports?)              — tool results → read-set entries (files, records, metric windows, environments)
 *   observeToolRuntime(runtime, options)              — ToolRuntime wrapper: every execution feeds the ObservationLog
 *   workspaceFileResolver(getRoot)                    — `file` resources `workspace/<id>/<path>` (sha256)
 *   softCondensationDue(input, keepRecentTurns)       — SOFT condensation is due (≥ keepRecentTurns + 2 turns beyond the cut)
 *   WorkspaceVectorRetriever, chunkText, gitHeadCommit — lazily populated vector corpus per workspace + commit
 *   SymbolIndex.writers/callers/imports/importers, classifyUsage, extractImports, resolveImport — the symbol graph
 *
 * Behavioural clarifications (v0.3 review):
 *   FreshnessGuard.validate: a malformed action (mutating not a boolean, resources not string[]) is invalid_argument,
 *     never treated as read-only; the snapshot's pinned versions are validated even without read-set entries.
 *   DurableMemory.review: permission_denied also when ctx.actorId / ctx.agentId is the creator.
 *   RetrievalQuery.root is honoured by the vector indexes (documents whose path lies inside it).
 */
export interface ContextDeps extends BaseDeps {
  db: SqlDatabase;
  events?: DomainEventSink;
}

// ----------------------------------------------------------------------------- snapshots + freshness

export interface SnapshotStore {
  /** Content-addressed: snapshotId = 'cs_' + sha256(canonical content)[0..40]; identical content ⇒ same id. */
  create(snapshot: Omit<ContextSnapshot, 'snapshotId' | 'createdAt'>, ctx: EventContext): Promise<ContextSnapshot>;
  get(snapshotId: string): Promise<ContextSnapshot | undefined>;
  latest(runId: string): Promise<ContextSnapshot | undefined>;
}

/** Ports the builder uses to read canonical state (implemented by collab/evidence objects structurally). */
export interface SnapshotSources {
  getRun(runId: string): Promise<{ runtimeManifestId: string; policyRevision: string; currentPlanRevision: number; systemModelRevision?: number; oracleRevisions: Record<string, number> } | undefined>;
  lastEventSeq(runId: string): Promise<number>;
  blackboardRevision(runId: string): Promise<number>;
  evidenceRoot(runId: string): Promise<{ rootHash: string }>;
  experimentRevisions(runId: string): Promise<Record<string, number>>;
}

export interface SnapshotBuilderDeps extends ContextDeps {
  snapshots: SnapshotStore;
  sources: SnapshotSources;
  resolvers: ResolverRegistry;
  /**
   * Additive: what agents OBSERVED through their tool calls. When a build names an `observer`, that agent's latest
   * observation of EVERY resource joins the read set (none is dropped).
   */
  observations?: ObservationLog;
  /**
   * Additive: an optional upper bound on the observed resources of one snapshot. Default: none. (B[0]) It never drops
   * observations: a build whose observer observed more resources fails with `precondition_failed` (fail closed).
   */
  maxObservedEntries?: number;
}

export interface BuildSnapshotInput {
  runId: string;
  modelEpochId?: string;
  environment?: { environmentId: string; generation: number; buildDigest?: string };
  /** Extra read-set entries observed by the caller (files read, findings consulted, metric windows). */
  readSet?: ReadSetEntry[];
  /** Additive: the agent whose recorded observations (ObservationLog) join the read set. */
  observer?: { agentId: string };
}

export interface SnapshotBuilder {
  build(input: BuildSnapshotInput, ctx: EventContext): Promise<ContextSnapshot>;
}

export interface ResourceVersionResolver {
  readonly resourceType: string;
  /** Current version string, or undefined if the resource no longer exists. */
  currentVersion(resourceId: string): Promise<string | undefined>;
}

export interface ResolverRegistry {
  register(resolver: ResourceVersionResolver): void;
  get(resourceType: string): ResourceVersionResolver | undefined;
}

export interface ProposedAction {
  tool: string;
  resources: string[];
  mutating: boolean;
}

export interface StaleEntry {
  resourceType: string;
  resourceId: string;
  observedVersion: string;
  currentVersion?: string;
  /**
   * `resolver_error` (additive): the resolver threw — treated as stale (fail closed); `missing` is also used
   * for an unknown snapshot id (resourceType `context_snapshot`).
   */
  reason: 'version_changed' | 'expired' | 'missing' | 'no_resolver' | 'resolver_error';
  /** Additive: resolver error message when reason = resolver_error. */
  error?: string;
}

export type FreshnessResult = { fresh: true; checked: number } | { fresh: false; checked: number; stale: StaleEntry[] };

// ----------------------------------------------------------------------------- observations (additive)

/**
 * Additive: one resource version an agent observed through a tool call (`read`: fs.read, blackboard.read, a metric
 * query, …) or established itself (`write`: fs.write, fs.apply_patch, blackboard.post_*, env.*). A write is an
 * observation too: the agent knows the version it produced. `observedVersion` = ABSENT_VERSION records that the
 * resource did not exist (e.g. a file the agent's own patch deleted).
 */
export interface ObservedEntry extends ReadSetEntry {
  kind: 'read' | 'write';
}

/** Additive: where an observation came from. */
export interface ObservationSource {
  runId: string;
  agentId: string;
  workItemId?: string;
  /** The turn snapshot the observing tool call ran against. */
  snapshotId?: string;
  toolId: string;
  invocationId: string;
}

/** Additive: one recorded observation (append-only, ordered by `seq`). */
export interface Observation extends ObservedEntry, ObservationSource {
  seq: number;
}

/**
 * Additive: the per-agent observation collector, fed by every tool execution (tool results → read-set entries) and
 * read by the SnapshotBuilder (the NEXT turn's snapshot includes what the agent observed) and by the FreshnessGuard
 * (observations made under the validated snapshot — during the current turn — refine its read set, so the agent's own
 * writes and fresh re-reads are never mistaken for concurrent changes, while another agent's change still is).
 */
export interface ObservationLog {
  /** Appends observations (validated; an empty list is a no-op). */
  record(source: ObservationSource, entries: ObservedEntry[]): Promise<void>;
  /**
   * The latest observation per (resourceType, resourceId) of one agent in one run, newest first, at most `limit`
   * (default: all). With `snapshotId` only observations made under that snapshot count.
   */
  latest(scope: { runId: string; agentId: string; snapshotId?: string; limit?: number }): Promise<Observation[]>;
}

export interface FreshnessGuard {
  readonly resolvers: ResolverRegistry;
  /**
   * For mutating actions validates every non-immutable read-set entry whose type is environment, build,
   * oracle, experiment or lease, plus entries whose resourceId appears in action.resources. max_age
   * entries expire by time. Read-only actions always pass. Emits context.stale_rejected when stale.
   * (additive) With an ObservationLog, the acting agent's (`ctx.agentId`) observations made under this snapshot
   * replace the snapshot's entries of the same resource and add the resources it observed since.
   */
  validate(snapshot: ContextSnapshot | string, action: ProposedAction, ctx: EventContext): Promise<FreshnessResult>;
}

/** (B[1], additive) A record-effect tool call that passed the FreshnessGuard and took effect. */
export interface FreshnessPass {
  invocationId: string;
  runId: string;
  agentId: string;
  toolId: string;
  snapshotId?: string;
  /** Read-set entries the guard checked. */
  checked: number;
}

/**
 * (B[1], additive) Durable record of freshness passes (`ht_context_freshness_passes`, append-only), written in the SAME
 * transaction as the tool's effect: a durable replay of the invocation (crash after its effect committed, before the call
 * settled) is recognised, so its own write never makes it stale — it returns its recorded outcome instead of inviting a
 * duplicate. `createFreshnessPassLog(deps)`.
 */
export interface FreshnessPassLog {
  record(pass: FreshnessPass): Promise<void>;
  get(invocationId: string): Promise<(FreshnessPass & { passedAt: string }) | undefined>;
}

// ----------------------------------------------------------------------------- L1 prompt assembly

export interface PromptSection {
  id: string;
  title: string;
  content: string;
  /** Lower number = more important; sections are dropped from the least important when over budget. */
  priority: number;
  maxTokens?: number;
  /** Required sections are truncated but never dropped. */
  required?: boolean;
}

export interface AssemblyInput {
  rolePrompt: string;
  /** Rendered BUGate PreparedProtocolContext (injected into every agent, incl. subagents). */
  protocolContext?: string;
  policyNotes?: string[];
  sections: PromptSection[];
  /** L2 working view (already condensed/offloaded). */
  transcript: ChatMessage[];
  budgetTokens: number;
  snapshotId: string;
}

export interface AssemblyResult {
  messages: ChatMessage[];
  tokens: number;
  droppedSections: string[];
  truncatedSections: string[];
}

// ----------------------------------------------------------------------------- L2 working context

export interface TranscriptEntry {
  turn: number;
  message: ChatMessage;
}

export interface Compaction {
  compactionId: string;
  level: 'soft' | 'hard';
  /** Turns 0..upToTurn (inclusive) are represented by the summary in the working view. */
  upToTurn: number;
  summary: string;
  evidenceRefs: string[];
  summaryArtifact?: ArtifactRef;
  createdAt: string;
}

export interface WorkingView {
  messages: ChatMessage[];
  tokens: number;
  /** soft: condensation advisable (may defer); hard: cannot continue without condensation. */
  pressure: 'none' | 'soft' | 'hard';
}

export interface Summarizer {
  summarize(input: { messages: ChatMessage[]; instructions: string; maxTokens: number; signal?: AbortSignal }): Promise<string>;
}

/** Additive: options of createWorkingContextManager. */
export interface WorkingContextOptions {
  /** Turns kept verbatim after the cut (default 4). */
  keepRecentTurns?: number;
  /** tokens/budget ≥ softRatio ⇒ pressure 'soft' (default 0.7). */
  softRatio?: number;
  /** tokens/budget ≥ hardRatio ⇒ pressure 'hard' (default 0.95). */
  hardRatio?: number;
  /** Share of the budget given to the summary (default 0.2, at least 64 tokens). */
  summaryRatio?: number;
  /**
   * I9 defence in depth: a tool result larger than this is shown truncated in the view (L0/SessionStore keep
   * the full text). Default 8000 tokens; 0 disables.
   */
  maxToolResultTokens?: number;
}

export interface WorkingContextManager {
  /** (additive, optional) The resolved options (callers use keepRecentTurns to decide when SOFT condensation is due). */
  readonly options?: Readonly<Required<WorkingContextOptions>>;
  view(input: { transcript: TranscriptEntry[]; compactions: Compaction[]; budgetTokens: number }): WorkingView;
  condense(input: {
    transcript: TranscriptEntry[];
    compactions: Compaction[];
    level: 'soft' | 'hard';
    summarizer: Summarizer;
    budgetTokens: number;
    ids: { next(prefix: string): string };
    now: string;
    signal?: AbortSignal;
  }): Promise<Compaction>;
}

// ----------------------------------------------------------------------------- L3 retrieval

export type RetrievalKind = 'code' | 'test' | 'doc' | 'record' | 'evidence' | 'experience';

export interface RetrievalQuery {
  text: string;
  symbol?: string;
  kinds?: RetrievalKind[];
  root?: string;
  pathGlobs?: string[];
  limit?: number;
}

export interface RetrievalHit {
  source: 'exact' | 'symbol' | 'vector' | 'record' | 'experience';
  ref: Ref;
  path?: string;
  line?: number;
  snippet: string;
  score: number;
}

export interface Retriever {
  readonly name: string;
  search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]>;
}

/** Additive: options of ExactSearch. */
export interface ExactSearchOptions {
  root: string;
  /** 'auto' (default): ripgrep when on PATH, else the JS walker. false forces the JS walker; true requires rg. */
  ripgrep?: boolean | 'auto';
  /** Files larger than this are skipped (default 1 MiB). */
  maxFileBytes?: number;
  /** Default hit limit when the query has none (default 20). */
  defaultLimit?: number;
}

export type SymbolLanguage = 'ts' | 'js' | 'python' | 'go';

/** Additive: options of SymbolIndex. */
export interface SymbolIndexOptions {
  root: string;
  languages?: SymbolLanguage[];
  maxFileBytes?: number;
  defaultLimit?: number;
  /**
   * (additive, B[6]) PRIVATE directory of the compiled Go `go/ast` helper — one agent commands can neither read nor write
   * (the composition passes one under its state directory, hidden from every sandboxed command). Without it Go files use the
   * regex fallback: the helper runs outside the sandbox, so it is never cached at a shared, predictable temp path.
   */
  goHelperDir?: string;
}

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const_object' | 'variable' | 'method' | 'struct';

/** Additive: one extracted definition. */
export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  language: SymbolLanguage;
  path: string;
  line: number;
  /** Enclosing class (TS/JS/Python) or receiver type (Go) for methods. */
  container?: string;
  signature: string;
  /** (additive, B[6]) Last line of the definition's syntax-tree node (absent from the regex fallback): the enclosing span. */
  endLine?: number;
}

/** Additive: how a reference uses the name — from the file's syntax tree (B[6]), or the regex line classifier as fallback. */
export type SymbolUsage = 'import' | 'write' | 'call' | 'read';

/** Additive: one word-boundary occurrence of a name that is not its definition. */
export interface SymbolReference {
  name: string;
  path: string;
  line: number;
  snippet: string;
  /** (additive) import statement, assignment/increment (write), call, or any other use (read). */
  usage?: SymbolUsage;
  /** (additive) The nearest enclosing definition (`Container.name` or `name`), when one precedes the reference. */
  enclosing?: string;
}

/** Additive: one import edge of the symbol graph (`to` = the resolved repository file, when it is one). */
export interface ImportEdge {
  from: string;
  specifier: string;
  to?: string;
  line: number;
  language: SymbolLanguage;
}

export interface Embedder {
  readonly dims: number;
  readonly modelId: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorDocument {
  id: string;
  text: string;
  ref: Ref;
  path?: string;
  line?: number;
  namespace: string;
}

export interface VectorIndex extends Retriever {
  upsert(docs: VectorDocument[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

// ----------------------------------------------------------------------------- L4 durable memory

export type ExperienceStatus = 'candidate' | 'reviewed' | 'approved' | 'published' | 'quarantined' | 'rejected';

export interface ExperienceItem {
  experienceId: string;
  scope: { project?: string; role?: string; topic?: string };
  kind: 'lesson' | 'pattern' | 'pitfall' | 'test_idea' | 'skill_candidate';
  content: string;
  sourceRunId: string;
  evidenceRefs: string[];
  status: ExperienceStatus;
  createdBy: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Additive named type: the review decisions (`review` ⇒ status reviewed is additive). */
export type ExperienceDecision = 'review' | 'approve' | 'publish' | 'reject' | 'quarantine';

/** Additive: options of PowerContextClient. */
export interface PowerContextOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Endpoint paths (defaults below); `{id}` is replaced by the url-encoded experience id. */
  paths?: { propose?: string; review?: string; retrieve?: string; list?: string };
  logger?: Logger;
}

/**
 * Candidate → review/eval → approved → published. Only approved/published items are ever retrieved
 * (agent hallucinations must not become future testing policy). Reviewer ≠ creator.
 */
export interface DurableMemory {
  readonly kind: 'sql' | 'powercontext';
  propose(item: Omit<ExperienceItem, 'experienceId' | 'status' | 'createdAt' | 'updatedAt' | 'reviewedBy'>, ctx: EventContext): Promise<ExperienceItem>;
  /** `review` (additive) marks a candidate as reviewed (evaluated, not yet approved). */
  review(experienceId: string, decision: ExperienceDecision, reviewer: string, ctx: EventContext): Promise<ExperienceItem>;
  retrieve(query: { text: string; scope?: ExperienceItem['scope']; limit?: number }): Promise<ExperienceItem[]>;
  list(filter: { status?: ExperienceStatus[]; sourceRunId?: string }): Promise<ExperienceItem[]>;
}

// ----------------------------------------------------------------------------- skills (B[7], additive)

/**
 * Lifecycle of a skill revision (technology-selection §Learning: Approved Experience → Candidate Skill → Validation →
 * Published Skill): `candidate` (distilled from approved experience) → `validated` (a passing eval run bound to this exact
 * revision) → `published` (the active registry; injected into L1 prompts) → `retired`. `rejected`: a human refused it.
 */
export type SkillStatus = 'candidate' | 'validated' | 'published' | 'retired' | 'rejected';

/** One immutable revision of a skill (Agent Skills standard: a name, a description and the SKILL.md body). */
export interface SkillRevision {
  skillId: string;
  revision: number;
  /** Lowercase, hyphenated (Agent Skills `name`). */
  name: string;
  description: string;
  /** SKILL.md body: the procedure, in markdown. */
  body: string;
  scope: { project?: string; role?: string; topic?: string };
  /** sha256 of the canonical {name, description, body, scope}: what an eval validates and what is published. */
  digest: string;
  status: SkillStatus;
  /** The approved/published experience items it was distilled from (never a candidate). */
  sourceExperienceIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedBy?: string;
  retiredBy?: string;
}

/** The part of an eval SuiteResult a skill validation judges (structurally an @hypertest/eval SuiteResult). */
export interface SkillEvalResult {
  suiteId: string;
  revision: string;
  trials: Array<{ taskId: string; armId: string; trial: number; result: string }>;
}

/** One recorded validation of a skill revision by an eval run (append-only). */
export interface SkillValidation {
  validationId: string;
  skillId: string;
  revision: number;
  digest: string;
  suiteId: string;
  suiteRevision: string;
  /** The eval arm bound to the revision: skillArmId(revision). */
  armId: string;
  trials: number;
  passes: number;
  passRate: number;
  baselineArmId?: string;
  baselinePassRate?: number;
  minPassRate: number;
  minTrials: number;
  passed: boolean;
  reasons: string[];
  /** sha256 of the canonical eval result the validation was computed from. */
  resultDigest: string;
  recordedBy: string;
  recordedAt: string;
}

export interface SkillValidationOptions {
  recordedBy: string;
  /** Pass rate the skill arm needs (default 1). */
  minPassRate?: number;
  /** Graded trials the skill arm needs (default 1). */
  minTrials?: number;
  /** The cold-track arm (no skill) the skill arm must not be worse than (default: the result's only other arm, if any). */
  baselineArmId?: string;
}

/**
 * The Hypertest Skill Registry (store-enforced): a candidate skill is distilled from APPROVED experience only, enters the
 * ACTIVE registry (`published`) only with a passing eval validation bound to its exact revision digest — enforced by the
 * registry AND by database triggers — and only published skills reach L1 prompts (forPrompt).
 */
export interface SkillRegistry {
  /** A new candidate skill (or a new revision of `skillId`): every source experience must be approved or published. */
  propose(input: { skillId?: string; name: string; description: string; body: string; scope?: SkillRevision['scope']; sourceExperienceIds: string[]; createdBy: string }, ctx: EventContext): Promise<SkillRevision>;
  /** Records the eval validation of a candidate/validated revision from an eval result whose skill arm is bound to it. */
  recordValidation(skillId: string, revision: number, result: SkillEvalResult, options: SkillValidationOptions, ctx: EventContext): Promise<SkillValidation>;
  /** validated (a passing validation of this exact revision) → published; publisher ≠ creator; a previously published revision is retired. */
  publish(skillId: string, revision: number, publisher: string, ctx: EventContext): Promise<SkillRevision>;
  /** published → retired (the skill leaves the active registry). */
  retire(skillId: string, retiredBy: string, ctx: EventContext): Promise<SkillRevision>;
  /** candidate/validated → rejected (by a human ≠ creator). */
  reject(skillId: string, revision: number, rejectedBy: string, ctx: EventContext): Promise<SkillRevision>;
  get(skillId: string, revision?: number): Promise<SkillRevision | undefined>;
  list(filter?: { status?: SkillStatus[]; skillId?: string }): Promise<SkillRevision[]>;
  validations(skillId: string, revision?: number): Promise<SkillValidation[]>;
  /** The ACTIVE registry: published revisions only, scope-matched for the role, most relevant first. */
  forPrompt(query: { role?: string; text?: string; limit?: number }): Promise<SkillRevision[]>;
}

// ----------------------------------------------------------------------------- L5 provenance

/**
 * Additive: provenance-only node kinds that have no domain RefKind (tool invocations, L0 events, agents,
 * environments, report claims). ProvenanceRef is a supertype of Ref, so every Ref is still accepted.
 * Edge endpoints (`from`/`to`) are node keys `${ref.kind}:${ref.id}`.
 */
export type ProvenanceRefKind = Ref['kind'] | 'tool_invocation' | 'event' | 'agent' | 'environment' | 'claim';
export interface ProvenanceRef {
  kind: ProvenanceRefKind;
  id: string;
  note?: string;
}

export interface ProvenanceNode {
  ref: ProvenanceRef;
  label: string;
  detail?: Record<string, unknown>;
}

export interface ProvenanceTrace {
  root: ProvenanceRef;
  nodes: ProvenanceNode[];
  /** (additive) `observed` / `started_by`: evidence of an invocation that observed an operation another invocation started. */
  edges: Array<{ from: string; to: string; relation: 'produced_by' | 'derived_from' | 'executed_in' | 'caused_by' | 'cites' | 'operation' | 'commit' | 'observed' | 'started_by' }>;
  complete: boolean;
  gaps: string[];
}

/** Read ports (implemented structurally by collab EventStore/Blackboard and evidence EvidenceLedger). */
export interface ProvenanceDeps {
  evidence: { get(id: string): Promise<import('@hypertest/domain').EvidenceRecord | undefined> };
  events: { read(runId: string, options?: { types?: string[] }): Promise<import('@hypertest/domain').DomainEvent<unknown>[]>; get(eventId: string): Promise<import('@hypertest/domain').DomainEvent<unknown> | undefined> };
  records: { getRecord<T = unknown>(recordId: string): Promise<import('@hypertest/domain').BlackboardRecord<T> | undefined> };
}

export interface ProvenanceService {
  traceEvidence(evidenceId: string): Promise<ProvenanceTrace>;
  traceRecord(recordId: string): Promise<ProvenanceTrace>;
  traceClaim(claim: ReportClaim): Promise<ProvenanceTrace>;
}
