import type { BaseDeps, JsonSchema, JsonValue, SqlDatabase } from '@hypertest/core';
import type {
  ActionCapability, AgentInstance, AgentRole, AssistantMessage, ChatMessage, ContextSnapshot, DataClassification, DomainEventSink,
  EventContext, ModelEpoch, ModelPolicy, RiskClass, RuntimeManifest, ToolCall, ToolDefinition, ToolPolicy, ToolResultMessage, WorkBudget,
} from '@hypertest/domain';
import type { Compaction, TranscriptEntry } from '@hypertest/context';
import type { ModelUsage, ModelRouter, RouteRequest } from '@hypertest/model';
import type { ToolExecutionResult } from '@hypertest/tools';

/**
 * @hypertest/runtime — the Hypertest-owned Agent Runtime ABI (runtime ownership) and its native engine.
 *
 * Division of labour:
 *   - Hypertest (host) owns: routing + ModelEpochs, context assembly, tool policy/execution, budgets,
 *     persistence (SessionStore), identity (AgentInstance), subagent semantics.
 *   - An AgentEngine owns only loop mechanics: how a turn turns model output into tool dispatches and
 *     when the loop stops. Engines receive an EngineHost and never talk to providers or tools directly.
 *   - Engine-specific ids/types never cross this boundary (no DSH/Pi types in contracts).
 *
 * Turn = one model response + dispatch of all its tool calls (the only safe model-switch boundary).
 * The assistant response is persisted BEFORE any tool executes; a retried turn replays the stored
 * response and dispatches only unsettled tool calls with the same invocation ids.
 *
 * Implementations to export from src/index.ts:
 *   class NativeEngine implements AgentEngine          (Hypertest loop; repetition detection; parallel read-only calls)
 *   createSessionStore(deps: RuntimeDeps): SessionStore
 *   createAgentRepository(deps: RuntimeDeps): AgentRepository
 *   createEpochManager(deps: EpochDeps): EpochManager
 *   createModelInvoker(deps: InvokerDeps): ModelInvoker   (per agent; routes at boundaries, budget reserve/settle)
 *   createSubagentRuntime(deps: SubagentDeps): SubagentRuntime
 *   createAgentRunner(deps: RunnerDeps): AgentRunner
 *   buildRuntimeManifest(input: Omit<RuntimeManifest, 'manifestId' | 'createdAt'>, createdAt: string): RuntimeManifest
 *   EngineRegistry (register(engine), get(kind))
 *   engineContractSuite(name: string, makeEngine: (deps) => AgentEngine): void   (node:test suite shared by all engines)
 *   runtimeMigrations: Migration[] (ht_agents, ht_sessions, ht_transcript, ht_turns, ht_tool_calls, ht_epochs,
 *                                   ht_compactions, ht_agent_inbox)
 */

export interface EngineCapabilities {
  providerSwitch: boolean;
  continuableChild: boolean;
  backgroundChild: boolean;
  peerMessaging: boolean;
  structuredOutput: boolean;
  sandboxProfiles: boolean;
  nativeCompaction: boolean;
  nativeComputerUse: boolean;
}

export interface EngineSessionRef {
  sessionId: string;
  engineKind: string;
}

// ----------------------------------------------------------------------------- host services

export type ModelInvocation =
  | { ok: true; message: AssistantMessage; usage: ModelUsage; routeId: string; epochId: string; stopReason: string }
  /** The turn must end without executing anything; the host starts a new epoch (or pauses) before the next turn. */
  | { ok: false; boundary: 'retry_next_turn' | 'budget_exhausted' | 'model_unavailable' | 'cancelled'; message: string };

export interface ModelInvoker {
  invoke(request: { messages: ChatMessage[]; tools: ToolDefinition[]; responseFormat?: { name: string; schema: JsonSchema }; signal: AbortSignal; turn: number }): Promise<ModelInvocation>;
}

export type TerminalSignal =
  | { kind: 'complete'; summary: string; output?: JsonValue; evidenceRefs: string[]; recordRefs: string[] }
  | { kind: 'fail'; reason: string; message: string };

export interface DispatchResult {
  /** Tool result message appended to the transcript (already bounded/offloaded). */
  message: ToolResultMessage;
  execution?: ToolExecutionResult;
  terminal?: TerminalSignal;
  /** Long-running operation started; the work item waits for it. */
  pendingOperationId?: string;
}

export interface ToolDispatcher {
  definitions(): ToolDefinition[];
  /** Tools that are safe to run concurrently within a turn (read-only). */
  isParallelSafe(toolName: string): boolean;
  dispatch(call: ToolCall, meta: { sessionId: string; turn: number; signal: AbortSignal }): Promise<DispatchResult>;
}

export interface TurnContext {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  snapshot: ContextSnapshot;
  responseFormat?: { name: string; schema: JsonSchema };
}

export interface ContextProvider {
  /** Builds L1 (+L2 view) for this turn and fixes the ContextSnapshot the turn runs against. */
  assemble(input: { sessionId: string; turn: number; transcript: TranscriptEntry[]; compactions: Compaction[]; signal: AbortSignal }): Promise<TurnContext>;
}

export interface EngineHost {
  model: ModelInvoker;
  tools: ToolDispatcher;
  context: ContextProvider;
  sessions: SessionStore;
  eventContext: EventContext;
  events?: DomainEventSink;
}

// ----------------------------------------------------------------------------- engine ABI

export interface CreateSessionRequest {
  runId: string;
  agentId: string;
  /** Initial task messages (portable IR) appended as turn 0 input. */
  initialMessages: ChatMessage[];
  outputSchema?: JsonSchema;
}

export interface TurnLimits {
  maxToolCallsPerTurn: number;
  /** Consecutive identical tool calls (name+args) before the engine stops the loop as repetitive. */
  repetitionThreshold: number;
}

export interface RunTurnRequest {
  session: EngineSessionRef;
  host: EngineHost;
  /** New inputs (wake-up notes, operation results, peer messages) appended before the turn. */
  input?: ChatMessage[];
  limits: TurnLimits;
  signal: AbortSignal;
}

export type RunTurnStatus = 'continue' | 'completed' | 'failed' | 'waiting' | 'interrupted' | 'boundary';

export interface RunTurnResult {
  status: RunTurnStatus;
  turn: number;
  appended: TranscriptEntry[];
  toolResults: DispatchResult[];
  completion?: Extract<TerminalSignal, { kind: 'complete' }>;
  failure?: { reason: string; message: string };
  waitingOn?: string[];
  /** For status=boundary: why the turn ended before tools ran. */
  boundary?: Extract<ModelInvocation, { ok: false }>['boundary'];
  usage: ModelUsage;
  replayed: boolean;
}

export interface SpawnChildRequest {
  parent: EngineSessionRef;
  child: CreateSessionRequest;
}

export interface ChildRef {
  session: EngineSessionRef;
  agentId: string;
}

export interface ResumeChildRequest {
  child: EngineSessionRef;
  host: EngineHost;
  input?: ChatMessage[];
  limits: TurnLimits;
  signal: AbortSignal;
}

export interface InterruptRequest {
  session: EngineSessionRef;
  reason: string;
}

export interface EngineSessionState {
  session: EngineSessionRef;
  status: SessionStatus;
  turnCount: number;
  lastTurnStatus?: TurnRecord['status'];
  currentEpochId?: string;
}

export interface AgentEngine {
  readonly kind: string;
  readonly version: string;
  readonly capabilities: EngineCapabilities;
  createSession(request: CreateSessionRequest): Promise<EngineSessionRef>;
  runTurn(request: RunTurnRequest): Promise<RunTurnResult>;
  spawnChild(request: SpawnChildRequest): Promise<ChildRef>;
  resumeChild(request: ResumeChildRequest): Promise<RunTurnResult>;
  interrupt(request: InterruptRequest): Promise<void>;
  inspect(ref: EngineSessionRef): Promise<EngineSessionState>;
  dispose(ref: EngineSessionRef): Promise<void>;
}

// ----------------------------------------------------------------------------- persistence

export type SessionStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'disposed';

export interface SessionRecord {
  sessionId: string;
  runId: string;
  agentId: string;
  engineKind: string;
  status: SessionStatus;
  turnCount: number;
  currentEpochId?: string;
  outputSchema?: JsonSchema;
  nativeState?: { compatibilityClass: string; data: JsonValue };
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  invocationId: string;
  status: 'pending' | 'settled';
  result?: ToolResultMessage;
  pendingOperationId?: string;
  terminal?: TerminalSignal;
}

export interface TurnRecord {
  sessionId: string;
  turn: number;
  status: 'started' | 'model_responded' | 'completed' | 'boundary' | 'failed';
  epochId?: string;
  routeId?: string;
  snapshotId?: string;
  response?: AssistantMessage;
  toolCalls: ToolCallRecord[];
  usage?: ModelUsage;
  startedAt: string;
  completedAt?: string;
}

export interface SessionStore {
  create(record: Omit<SessionRecord, 'createdAt' | 'updatedAt' | 'turnCount' | 'status'>): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
  setNativeState(sessionId: string, state: SessionRecord['nativeState']): Promise<void>;
  appendTranscript(sessionId: string, entries: TranscriptEntry[]): Promise<void>;
  transcript(sessionId: string): Promise<TranscriptEntry[]>;
  /** Idempotent: returns the existing record when the turn already started. */
  beginTurn(sessionId: string, turn: number, meta: { epochId?: string; routeId?: string; snapshotId?: string }): Promise<TurnRecord>;
  recordModelResponse(sessionId: string, turn: number, response: AssistantMessage, usage: ModelUsage, toolCalls: Array<Pick<ToolCallRecord, 'toolCallId' | 'name' | 'invocationId'>>): Promise<TurnRecord>;
  settleToolCall(sessionId: string, turn: number, toolCallId: string, settled: Pick<ToolCallRecord, 'result' | 'pendingOperationId' | 'terminal'>): Promise<void>;
  completeTurn(sessionId: string, turn: number, status: 'completed' | 'boundary' | 'failed'): Promise<void>;
  getTurn(sessionId: string, turn: number): Promise<TurnRecord | undefined>;
  lastTurn(sessionId: string): Promise<TurnRecord | undefined>;
  addCompaction(sessionId: string, compaction: Compaction): Promise<void>;
  compactions(sessionId: string): Promise<Compaction[]>;
  /** Queued inputs for the next turn (peer messages, wake-ups); drained atomically. */
  enqueueInput(sessionId: string, messages: ChatMessage[]): Promise<void>;
  drainInput(sessionId: string): Promise<ChatMessage[]>;
}

export interface AgentRepository {
  create(agent: AgentInstance): Promise<AgentInstance>;
  get(agentId: string): Promise<AgentInstance | undefined>;
  byWorkItem(workItemId: string): Promise<AgentInstance | undefined>;
  update(agentId: string, patch: Partial<Pick<AgentInstance, 'status' | 'sessionId' | 'updatedAt'>>): Promise<AgentInstance>;
  children(parentAgentId: string): Promise<AgentInstance[]>;
  list(filter: { runId: string; status?: AgentInstance['status'][] }): Promise<AgentInstance[]>;
}

export interface RuntimeDeps extends BaseDeps {
  db: SqlDatabase;
  events?: DomainEventSink;
}

// ----------------------------------------------------------------------------- epochs + invoker

export interface EpochManager {
  current(sessionId: string): Promise<ModelEpoch | undefined>;
  /** Starts a new epoch at a safe boundary; validates the previous turn is settled (throws precondition_failed otherwise). */
  start(input: Omit<ModelEpoch, 'epochId' | 'startedAt'>, ctx: EventContext): Promise<ModelEpoch>;
  list(sessionId: string): Promise<ModelEpoch[]>;
  /** Providers used by agents of the given roles in the run (reviewer heterogeneity input). */
  providersUsedByRoles(runId: string, roles: string[]): Promise<string[]>;
}

export interface EpochDeps extends RuntimeDeps {
  sessions: SessionStore;
}

/** Budget port (implemented structurally by @hypertest/operation BudgetLedger). */
export interface BudgetPort {
  reserve(scopes: string[], amounts: { tokens?: number; costUsd?: number }, reason: string): Promise<{ ok: true; reservationId: string } | { ok: false; exhausted: unknown }>;
  settle(reservationId: string, actual: { tokens?: number; costUsd?: number }): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface InvokerDeps extends BaseDeps {
  router: ModelRouter;
  epochs: EpochManager;
  sessions: SessionStore;
  budget?: BudgetPort;
  budgetScopes: string[];
  agent: { agentId: string; runId: string; role: AgentRole; sessionId: string };
  policy: ModelPolicy;
  taskType: string;
  dataClassification: DataClassification;
  actionRisk: RiskClass;
  maxOutputTokens: number;
  eventContext: EventContext;
  /** Resolves providers used by independentFromRoles at routing time. */
  routeRequestExtras?: () => Promise<Partial<RouteRequest>>;
}

// ----------------------------------------------------------------------------- subagents

export interface SpawnRequest {
  runId: string;
  workItemId: string;
  role: AgentRole;
  parentAgentId?: string;
  /** Parent depth + 1; rejected when > maxDepth (I12). */
  depth: number;
  maxDepth: number;
  capability: ActionCapability;
  modelPolicy: ModelPolicy;
  toolPolicy: ToolPolicy;
  contextSnapshotId: string;
  initialMessages: ChatMessage[];
  outputSchema?: JsonSchema;
  continuable: boolean;
  background: boolean;
  budget: WorkBudget;
  engineKind?: string;
}

export interface SubagentResult {
  agentId: string;
  status: AgentInstance['status'];
  /** Only the summary/structured output reaches the parent (no child trace). */
  summary?: string;
  output?: JsonValue;
  evidenceRefs: string[];
  recordRefs: string[];
  failure?: { reason: string; message: string };
}

export interface SubagentRuntime {
  spawn(request: SpawnRequest, ctx: EventContext): Promise<AgentInstance>;
  resume(agentId: string): Promise<AgentInstance>;
  message(agentId: string, message: ChatMessage): Promise<void>;
  /** Cascades to all descendants. */
  interrupt(agentId: string, reason: string, ctx: EventContext): Promise<void>;
  collect(agentId: string): Promise<SubagentResult>;
  children(agentId: string): Promise<AgentInstance[]>;
  dispose(agentId: string, ctx: EventContext): Promise<void>;
  /** Records the terminal outcome of an agent (called by the runner). */
  settle(agentId: string, result: Omit<SubagentResult, 'agentId' | 'status'> & { status: 'completed' | 'failed' | 'interrupted' }, ctx: EventContext): Promise<void>;
}

export interface SubagentDeps extends RuntimeDeps {
  agents: AgentRepository;
  sessions: SessionStore;
  engines: EngineRegistryLike;
  defaultEngineKind: string;
  maxAgentsPerRun: number;
}

export interface EngineRegistryLike {
  get(kind: string): AgentEngine;
  list(): AgentEngine[];
}

// ----------------------------------------------------------------------------- runner

export interface StepOutcome {
  result: RunTurnResult;
  agent: AgentInstance;
}

export interface AgentRunner {
  /** Executes exactly one turn (the durable activity unit). */
  step(agentId: string, host: EngineHost, options: { limits: TurnLimits; signal: AbortSignal }): Promise<StepOutcome>;
  /** Loops turns until completed/failed/waiting/boundary-pause or the work budget is exhausted. */
  run(agentId: string, hostFactory: () => Promise<EngineHost>, options: { limits: TurnLimits; budget: WorkBudget; signal: AbortSignal }): Promise<StepOutcome>;
}

export interface RunnerDeps extends RuntimeDeps {
  agents: AgentRepository;
  sessions: SessionStore;
  engines: EngineRegistryLike;
  subagents: SubagentRuntime;
}

export type { RuntimeManifest };
