import type { BaseDeps, SqlDatabase } from '@hypertest/core';
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
 *   class InMemoryVectorIndex implements VectorIndex; createPgVectorIndex(db, dims) (pgvector; throws unsupported if unavailable)
 *   class HybridRetriever implements Retriever (reciprocal-rank fusion over child retrievers)
 *   createExperienceStore(deps: ContextDeps): DurableMemory
 *   class PowerContextClient implements DurableMemory ({ baseUrl, apiKey?, timeoutMs })
 *   createProvenanceService(deps: ProvenanceDeps): ProvenanceService
 *   contextMigrations: Migration[] (ht_context_snapshots, ht_experience, ht_vectors (only if vector ext))
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
}

export interface BuildSnapshotInput {
  runId: string;
  modelEpochId?: string;
  environment?: { environmentId: string; generation: number; buildDigest?: string };
  /** Extra read-set entries observed by the caller (files read, findings consulted, metric windows). */
  readSet?: ReadSetEntry[];
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
  reason: 'version_changed' | 'expired' | 'missing' | 'no_resolver';
}

export type FreshnessResult = { fresh: true; checked: number } | { fresh: false; checked: number; stale: StaleEntry[] };

export interface FreshnessGuard {
  readonly resolvers: ResolverRegistry;
  /**
   * For mutating actions validates every non-immutable read-set entry whose type is environment, build,
   * oracle, experiment or lease, plus entries whose resourceId appears in action.resources. max_age
   * entries expire by time. Read-only actions always pass. Emits context.stale_rejected when stale.
   */
  validate(snapshot: ContextSnapshot | string, action: ProposedAction, ctx: EventContext): Promise<FreshnessResult>;
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

export interface WorkingContextManager {
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

/**
 * Candidate → review/eval → approved → published. Only approved/published items are ever retrieved
 * (agent hallucinations must not become future testing policy). Reviewer ≠ creator.
 */
export interface DurableMemory {
  readonly kind: 'sql' | 'powercontext';
  propose(item: Omit<ExperienceItem, 'experienceId' | 'status' | 'createdAt' | 'updatedAt' | 'reviewedBy'>, ctx: EventContext): Promise<ExperienceItem>;
  review(experienceId: string, decision: 'approve' | 'publish' | 'reject' | 'quarantine', reviewer: string, ctx: EventContext): Promise<ExperienceItem>;
  retrieve(query: { text: string; scope?: ExperienceItem['scope']; limit?: number }): Promise<ExperienceItem[]>;
  list(filter: { status?: ExperienceStatus[]; sourceRunId?: string }): Promise<ExperienceItem[]>;
}

// ----------------------------------------------------------------------------- L5 provenance

export interface ProvenanceNode {
  ref: Ref;
  label: string;
  detail?: Record<string, unknown>;
}

export interface ProvenanceTrace {
  root: Ref;
  nodes: ProvenanceNode[];
  edges: Array<{ from: string; to: string; relation: 'produced_by' | 'derived_from' | 'executed_in' | 'caused_by' | 'cites' | 'operation' | 'commit' }>;
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
