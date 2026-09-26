import type { BaseDeps, Clock, IdGenerator, JsonSchema, JsonValue, Logger, Migration, SqlDatabase } from '@hypertest/core';
import type {
  ActionCapability, AgentInstance, AgentRole, AssistantMessage, ChatMessage, ContextSnapshot, DataClassification, DomainEventSink,
  EventContext, ModelEpoch, ModelPolicy, ModelSwitchReason, RiskClass, RuntimeManifest, ToolCall, ToolDefinition, ToolPolicy, ToolResultMessage, WorkBudget,
} from '@hypertest/domain';
import type { Compaction, TranscriptEntry } from '@hypertest/context';
import type { ModelUsage, ModelRouter, RouteDecision, RouteRequest } from '@hypertest/model';
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
 *   engineContractSuite(name: string, makeEngine: (deps) => AgentEngine, options: EngineContractSuiteOptions): void
 *                                                        (node:test suite shared by all engines; `options` is additive:
 *                                                         src may not depend on @hypertest/store, so the caller supplies
 *                                                         the database factory, e.g. `createTestDatabase`)
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
  /**
   * `snapshotId` (additive, optional) is the ContextSnapshot the turn runs against (TurnContext.snapshot); it is the
   * snapshot routing decisions and new epochs are pinned to (I3: snapshot fixed at the boundary).
   */
  invoke(request: { messages: ChatMessage[]; tools: ToolDefinition[]; responseFormat?: { name: string; schema: JsonSchema }; signal: AbortSignal; turn: number; snapshotId?: string }): Promise<ModelInvocation>;
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
  /**
   * `invocationId` (additive, optional in the type; engines always pass it) is the recorded, retry-stable id
   * `${sessionId}:${turn}:${toolCall.id}` — the idempotency key of the tool invocation (ToolExecutionRequest.invocationId).
   */
  dispatch(call: ToolCall, meta: { sessionId: string; turn: number; signal: AbortSignal; invocationId?: string }): Promise<DispatchResult>;
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
  /** (additive) The engine's decision for this turn, recorded atomically with its completion (see CompleteTurnOptions.outcome). */
  outcome?: TurnOutcome;
}

/**
 * (additive) What a finished turn decided (the terminal fields of its RunTurnResult). Recorded with the turn completion
 * so a durable retry can recover a completed/failed agent whose result was never settled (crash after the commit).
 */
export type TurnOutcome = Pick<RunTurnResult, 'status' | 'completion' | 'failure' | 'waitingOn' | 'boundary'>;

export interface SessionStore {
  /**
   * `initialTranscript` (additive, optional) is appended in the SAME transaction as the session row (e.g. the turn-0
   * task input), so a crash can never leave a session without its task context.
   */
  create(record: Omit<SessionRecord, 'createdAt' | 'updatedAt' | 'turnCount' | 'status'>, initialTranscript?: TranscriptEntry[]): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
  setNativeState(sessionId: string, state: SessionRecord['nativeState']): Promise<void>;
  appendTranscript(sessionId: string, entries: TranscriptEntry[]): Promise<void>;
  transcript(sessionId: string): Promise<TranscriptEntry[]>;
  /** Idempotent: returns the existing record when the turn already started. */
  beginTurn(sessionId: string, turn: number, meta: { epochId?: string; routeId?: string; snapshotId?: string }): Promise<TurnRecord>;
  /**
   * Persists the response AND creates one pending row per tool call in ONE transaction and moves the turn to
   * model_responded. `toolCalls` must list exactly the response's tool calls, in order. Idempotent for the same
   * response; a different response ⇒ conflict. `meta` (additive) records the epoch/route/snapshot that produced it
   * (`snapshotId` replaces the one recorded by beginTurn: a retried `started` turn may run against a newer snapshot).
   */
  recordModelResponse(
    sessionId: string,
    turn: number,
    response: AssistantMessage,
    usage: ModelUsage,
    toolCalls: Array<Pick<ToolCallRecord, 'toolCallId' | 'name' | 'invocationId'>>,
    meta?: { epochId?: string; routeId?: string; snapshotId?: string },
  ): Promise<TurnRecord>;
  /** Idempotent: re-settling with the same outcome is a no-op; a different outcome ⇒ conflict. `result` is required. */
  settleToolCall(sessionId: string, turn: number, toolCallId: string, settled: Pick<ToolCallRecord, 'result' | 'pendingOperationId' | 'terminal'>): Promise<void>;
  /**
   * 'completed' requires a recorded response with every tool call settled (precondition_failed otherwise);
   * 'boundary'/'failed' may end a turn with unsettled calls. Idempotent for the same status (a repeated call
   * applies none of `options`); a different terminal status ⇒ conflict. `options` (additive) are applied in the
   * same transaction: transcript entries appended, inputs queued for the next turn, the session status set, the turn
   * outcome recorded. An `interrupted` session (interrupted while the turn ran, possibly by another process) is never
   * reactivated by `sessionStatus` 'active'/'waiting' — only a terminal 'completed'/'failed' replaces it; `disposed`
   * is never replaced.
   */
  completeTurn(sessionId: string, turn: number, status: 'completed' | 'boundary' | 'failed', options?: CompleteTurnOptions): Promise<void>;
  getTurn(sessionId: string, turn: number): Promise<TurnRecord | undefined>;
  lastTurn(sessionId: string): Promise<TurnRecord | undefined>;
  addCompaction(sessionId: string, compaction: Compaction): Promise<void>;
  compactions(sessionId: string): Promise<Compaction[]>;
  /** Queued inputs for the next turn (peer messages, wake-ups); drained atomically. */
  enqueueInput(sessionId: string, messages: ChatMessage[]): Promise<void>;
  drainInput(sessionId: string): Promise<ChatMessage[]>;
  /**
   * (additive, optional) Drains the queued inputs and appends them, followed by `extra`, to the transcript at
   * `turn` in ONE transaction (a crash can neither lose nor duplicate an input). Returns the appended entries.
   */
  drainInputInto?(sessionId: string, turn: number, extra: ChatMessage[]): Promise<TranscriptEntry[]>;
}

/** (additive) Side effects applied atomically with SessionStore.completeTurn. */
export interface CompleteTurnOptions {
  append?: TranscriptEntry[];
  /** Inputs queued for the next turn (e.g. the text-only nudge). */
  enqueue?: ChatMessage[];
  sessionStatus?: SessionStatus;
  /** (additive) The engine's decision for the turn (TurnRecord.outcome). */
  outcome?: TurnOutcome;
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
  /**
   * Starts a new epoch at a safe boundary; validates the previous turn is settled (throws precondition_failed otherwise).
   * Safe boundary (I3): every turn before `startedAtTurn` is completed/boundary/failed and `startedAtTurn` itself has no
   * recorded model response (it may be `started`: begun, nothing produced yet). A `model_responded` turn always refuses.
   * `previousEpochId`, when given, must be the session's current epoch (conflict otherwise); omitted ⇒ filled in.
   * `options` (additive): the full route decision (reused on later turns of the epoch), the routes that already
   * failed in this epoch sequence, and whether the start consumes the session's pending fallback (same transaction).
   */
  start(input: Omit<ModelEpoch, 'epochId' | 'startedAt'>, ctx: EventContext, options?: StartEpochOptions): Promise<ModelEpoch>;
  list(sessionId: string): Promise<ModelEpoch[]>;
  /** Providers used by agents of the given roles in the run (reviewer heterogeneity input). */
  providersUsedByRoles(runId: string, roles: string[]): Promise<string[]>;
  /** (additive, optional) Routing data stored with an epoch by start(options). */
  routing?(epochId: string): Promise<EpochRouting | undefined>;
  /** (additive, optional) Records the fallback of a failed invoke; used only at the NEXT turn boundary. Replaces any earlier one. */
  setPendingFallback?(sessionId: string, fallback: Omit<PendingFallback, 'createdAt'>): Promise<void>;
  /** (additive, optional) The session's pending fallback, if any. */
  pendingFallback?(sessionId: string): Promise<PendingFallback | undefined>;
}

/** (additive) An ok RouteDecision (what ModelRouter.invoke takes). */
export type OkRouteDecision = Extract<RouteDecision, { ok: true }>;

/** (additive) Options of EpochManager.start. */
export interface StartEpochOptions {
  decision?: OkRouteDecision;
  /** Routes that already failed in this epoch sequence (passed to the router as excludeRoutes on failure). */
  excludedRoutes?: string[];
  /** Deletes the session's pending fallback in the same transaction as the epoch insert. */
  consumeFallback?: boolean;
}

/** (additive) Routing data stored with an epoch. */
export interface EpochRouting {
  decision?: OkRouteDecision;
  excludedRoutes: string[];
}

/** (additive) A re-validated fallback computed by the router after a failed invoke, applied at the next boundary. */
export interface PendingFallback {
  decision: OkRouteDecision;
  reason: ModelSwitchReason;
  fromRouteId: string;
  fromEpochId?: string;
  error: { code: string; message: string };
  /** Routes that failed in this epoch sequence (including fromRouteId). */
  excludedRoutes: string[];
  createdAt: string;
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
  /**
   * Resolves providers used by independentFromRoles at routing time. Extras may only tighten the request:
   * providersToAvoid/excludeRoutes/requiredCapabilities/structuredOutput are added, actionRisk/dataClassification take
   * the stricter of deps and extras; identity, role, taskType, policy, snapshot and token estimate are never overridden.
   */
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
  /** The depth cap; a child's effective cap is min(maxDepth, the parent's recorded cap) — a spawn can never raise it. */
  maxDepth: number;
  /**
   * The capability granted to the new agent; its `subjectAgentId` must equal the new agentId (permission_denied
   * otherwise). Additive: a factory receiving the generated agentId (the id is generated before the spawn).
   * A child's capability must be attenuated from the parent's recorded capability (I2: `parentCapabilityId` names it
   * and every grant — tools, resource scopes, effects, credential scopes, environment classes, risk, expiry — is
   * covered by the parent's); otherwise permission_denied. The granted capability is recorded with the agent.
   */
  capability: ActionCapability | ((agentId: string) => ActionCapability);
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
  /** (additive, optional) The capability granted to the agent at spawn (as recorded; undefined for agents not created by spawn). */
  capabilityOf?(agentId: string): Promise<ActionCapability | undefined>;
  /** Records the terminal outcome of an agent (called by the runner). */
  settle(agentId: string, result: Omit<SubagentResult, 'agentId' | 'status'> & { status: 'completed' | 'failed' | 'interrupted' }, ctx: EventContext): Promise<void>;
}

export interface SubagentDeps extends RuntimeDeps {
  agents: AgentRepository;
  sessions: SessionStore;
  engines: EngineRegistryLike;
  defaultEngineKind: string;
  maxAgentsPerRun: number;
  /**
   * (additive, optional) HMAC secret of capability tokens (policy.signCapability). When set, spawn refuses a capability
   * whose signature does not verify (permission_denied). Non-amplification (I2) is checked structurally either way.
   */
  capabilitySecret?: string;
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

// ----------------------------------------------------------------------------- native engine + contract suite (additive)

/** (additive) Dependencies of NativeEngine (and of any engine built by the contract suite). */
export interface NativeEngineDeps {
  /** Used by createSession/spawnChild/interrupt/inspect/dispose (runTurn uses host.sessions). */
  sessions: SessionStore;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  events?: DomainEventSink;
}

/** (additive) What engineContractSuite passes to makeEngine. */
export interface EngineContractDeps {
  db: SqlDatabase;
  sessions: SessionStore;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  events: DomainEventSink;
}

/** (additive) Options of engineContractSuite. */
export interface EngineContractSuiteOptions {
  /**
   * Opens a fresh database migrated with `migrations` (the suite passes runtimeMigrations), e.g.
   * `(migrations) => createTestDatabase({ migrations })` from @hypertest/store.
   */
  openDatabase(migrations: readonly Migration[]): Promise<{ db: SqlDatabase; dispose(): Promise<void> }>;
}

export type { RuntimeManifest };
