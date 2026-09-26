import { HypertestError, canonicalJson, truncateUtf8 } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type AssistantMessage, type ChatMessage, type ToolCall, type ToolResultMessage } from '@hypertest/domain';
import type { TranscriptEntry } from '@hypertest/context';
import type { ModelUsage } from '@hypertest/model';
import type {
  AgentEngine, ChildRef, CreateSessionRequest, DispatchResult, EngineCapabilities, EngineHost, EngineSessionRef, EngineSessionState, InterruptRequest,
  NativeEngineDeps, ResumeChildRequest, RunTurnRequest, RunTurnResult, RunTurnStatus, SessionStatus, SessionStore, SpawnChildRequest, TerminalSignal,
  ToolCallRecord, TurnLimits, TurnOutcome, TurnRecord,
} from './contracts.ts';
import { assertNonEmpty, zeroUsage } from './util.ts';
import { RUNTIME_PACKAGE_VERSION } from './version.ts';

export const NATIVE_ENGINE_KIND = 'native';

/** Queued as the next input after a text-only assistant turn (role `user` for provider portability). */
export const TEXT_ONLY_NUDGE = 'You must call complete_work (with the required output) or fail_work, or continue using tools.';
/** Tool result text for calls beyond `limits.maxToolCallsPerTurn` (not dispatched). */
export const TOO_MANY_TOOL_CALLS = 'too many tool calls in one turn';
/** Prefix of the tool result for calls whose arguments were not valid JSON (not dispatched). */
export const MALFORMED_ARGUMENTS = 'malformed tool arguments';
/** Failure reason when the last `repetitionThreshold` turns issued identical tool calls. */
export const REPETITIVE_LOOP = 'repetitive_loop';
/** Maximum parallel-safe tool calls in flight within one turn. */
export const PARALLEL_TOOL_CONCURRENCY = 4;

const CLOSED: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'disposed', 'interrupted']);
const FINAL: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'disposed']);

function sessionStatusFor(status: RunTurnStatus): SessionStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'waiting':
      return 'waiting';
    default:
      return 'active';
  }
}

/** Deterministic id of the `agent.turn_completed` event of a committed (tool-dispatching) turn. */
export function turnCompletedEventId(sessionId: string, turn: number): string {
  return `evt_${sessionId}_t${turn}_completed`;
}

export function validateLimits(limits: TurnLimits): void {
  if (!limits || !Number.isSafeInteger(limits.maxToolCallsPerTurn) || limits.maxToolCallsPerTurn < 0) {
    throw new HypertestError('invalid_argument', `limits.maxToolCallsPerTurn must be a non-negative integer (got ${String(limits?.maxToolCallsPerTurn)})`);
  }
  const r = limits.repetitionThreshold;
  if (!Number.isSafeInteger(r) || r < 0 || r === 1) {
    throw new HypertestError('invalid_argument', `limits.repetitionThreshold must be 0 (disabled) or an integer >= 2 (got ${String(r)})`);
  }
}

/** Signature of a turn's tool calls (name + canonical arguments, in order); undefined for a text-only turn. */
export function toolCallSignature(response: AssistantMessage | undefined): string | undefined {
  const calls = response?.toolCalls ?? [];
  if (calls.length === 0) return undefined;
  return canonicalJson(calls.map((c) => ({ name: c.name, arguments: c.arguments ?? null, rawArguments: c.rawArguments })));
}

/**
 * Gives every tool call a non-empty id unique within the response (providers occasionally repeat or omit ids);
 * the normalized response is what gets persisted, so replay and the transcript stay consistent.
 */
export function normalizeResponse(message: AssistantMessage, turn: number): AssistantMessage {
  if (!message || message.role !== 'assistant') throw new HypertestError('internal', 'model invoker returned a non-assistant message');
  const out: AssistantMessage = { role: 'assistant', content: Array.isArray(message.content) ? message.content : [] };
  if (message.reasoning !== undefined) out.reasoning = message.reasoning;
  const calls = message.toolCalls ?? [];
  if (calls.length > 0) {
    const seen = new Set<string>();
    out.toolCalls = calls.map((c, i) => {
      let id = typeof c.id === 'string' && c.id.length > 0 && !seen.has(c.id) ? c.id : `call_t${turn}_${i}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      const call: ToolCall = { id, name: String(c.name ?? ''), arguments: c.arguments === undefined ? null : c.arguments };
      if (c.rawArguments !== undefined) call.rawArguments = c.rawArguments;
      return call;
    });
  }
  return out;
}

function errorResult(call: ToolCall, content: string): DispatchResult {
  return { message: { role: 'tool', toolCallId: call.id, toolName: call.name, content, isError: true } };
}

function fromRecord(record: ToolCallRecord): DispatchResult {
  const r: DispatchResult = { message: record.result! };
  if (record.terminal !== undefined) r.terminal = record.terminal;
  if (record.pendingOperationId !== undefined) r.pendingOperationId = record.pendingOperationId;
  return r;
}

function validTerminal(t: unknown): t is TerminalSignal {
  if (!t || typeof t !== 'object') return false;
  const k = (t as { kind?: unknown }).kind;
  if (k === 'complete') {
    const c = t as { summary?: unknown; evidenceRefs?: unknown; recordRefs?: unknown };
    return typeof c.summary === 'string' && Array.isArray(c.evidenceRefs) && Array.isArray(c.recordRefs);
  }
  if (k === 'fail') {
    const f = t as { reason?: unknown; message?: unknown };
    return typeof f.reason === 'string' && typeof f.message === 'string';
  }
  return false;
}

interface TurnState {
  sessionId: string;
  agentId: string;
  turn: number;
  host: EngineHost;
  limits: TurnLimits;
  signal: AbortSignal;
  appended: TranscriptEntry[];
  usage: ModelUsage;
  replayed: boolean;
  /** Input handed to a replayed turn: queued for the next turn with the completion. */
  carryInput: ChatMessage[];
}

/**
 * The Hypertest agent loop. Turn = one model response + dispatch of all its tool calls:
 *   inputs → context (snapshot fixed) → beginTurn → model (host invoker; boundary ⇒ nothing executes) →
 *   response persisted with pending tool-call rows → dispatch (parallel-safe calls concurrently, bounded; others in
 *   order), each result settled immediately → transcript + turn completion in one transaction.
 * A turn left `model_responded` (crash/abort mid-dispatch) is replayed: no model call, only unsettled calls are
 * dispatched, with their recorded invocation ids.
 */
export class NativeEngine implements AgentEngine {
  readonly kind: string = NATIVE_ENGINE_KIND;
  readonly version: string = RUNTIME_PACKAGE_VERSION;
  readonly capabilities: EngineCapabilities = {
    providerSwitch: true,
    continuableChild: true,
    backgroundChild: false,
    peerMessaging: true,
    structuredOutput: true,
    sandboxProfiles: false,
    nativeCompaction: false,
    nativeComputerUse: false,
  };
  readonly #deps: NativeEngineDeps;
  readonly #inflight = new Map<string, Set<AbortController>>();

  constructor(deps: NativeEngineDeps) {
    if (!deps?.sessions) throw new HypertestError('invalid_argument', 'NativeEngine requires a SessionStore');
    this.#deps = deps;
  }

  async createSession(request: CreateSessionRequest): Promise<EngineSessionRef> {
    assertNonEmpty(request?.runId, 'runId');
    assertNonEmpty(request.agentId, 'agentId');
    if (!Array.isArray(request.initialMessages)) throw new HypertestError('invalid_argument', 'initialMessages must be an array');
    request.initialMessages.forEach((m, i) => {
      if (m?.role !== 'system' && m?.role !== 'user') throw new HypertestError('invalid_argument', `initialMessages[${i}] must be a system or user message (turn 0 input)`);
    });
    const sessionId = this.#deps.ids.next('sess');
    const record: Parameters<SessionStore['create']>[0] = { sessionId, runId: request.runId, agentId: request.agentId, engineKind: this.kind };
    if (request.outputSchema !== undefined) record.outputSchema = request.outputSchema;
    // The session row and its turn-0 task input are written in one transaction.
    await this.#deps.sessions.create(record, request.initialMessages.map((message) => ({ turn: 0, message })));
    this.#deps.logger.debug('native session created', { sessionId, agentId: request.agentId });
    return { sessionId, engineKind: this.kind };
  }

  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    validateLimits(request?.limits);
    const ref = request.session;
    if (ref?.engineKind !== this.kind) throw new HypertestError('invalid_argument', `session ${ref?.sessionId} belongs to engine ${ref?.engineKind}, not ${this.kind}`);
    const sessions = request.host.sessions;
    // Register the abort handle BEFORE reading the status: an interrupt() either sees this handle (and aborts it) or
    // committed its status first (and the read below refuses the turn) — no window in which both are missed.
    const ctrl = new AbortController();
    let set = this.#inflight.get(ref.sessionId);
    if (!set) this.#inflight.set(ref.sessionId, (set = new Set()));
    set.add(ctrl);
    try {
      const record = await sessions.get(ref.sessionId);
      if (!record) throw new HypertestError('not_found', `session ${ref.sessionId} not found`, { details: { sessionId: ref.sessionId } });
      if (record.engineKind !== this.kind) throw new HypertestError('invalid_argument', `session ${ref.sessionId} is a ${record.engineKind} session`);
      if (CLOSED.has(record.status)) {
        throw new HypertestError('precondition_failed', `session ${ref.sessionId} is ${record.status}; no turn may run${record.status === 'interrupted' ? ' until it is resumed' : ''}`, {
          details: { sessionId: ref.sessionId, status: record.status },
        });
      }
      const signal = AbortSignal.any([request.signal, ctrl.signal]);
      return await this.#runTurn(request, record.agentId, signal);
    } finally {
      set.delete(ctrl);
      if (set.size === 0) this.#inflight.delete(ref.sessionId);
    }
  }

  async #runTurn(request: RunTurnRequest, agentId: string, signal: AbortSignal): Promise<RunTurnResult> {
    const { host, limits } = request;
    const sessions = host.sessions;
    const sessionId = request.session.sessionId;
    const last = await sessions.lastTurn(sessionId);

    if (last?.status === 'model_responded') {
      // Replay: the response is already persisted; never call the model again for this turn. Input given to the
      // replay is queued for the next turn atomically with this turn's completion (a retried replay queues it once).
      this.#deps.logger.info('replaying turn', { sessionId, turn: last.turn, pending: last.toolCalls.filter((c) => c.status === 'pending').length });
      return this.#dispatchAndFinish({ sessionId, agentId, turn: last.turn, host, limits, signal, appended: [], usage: zeroUsage(), replayed: true, carryInput: request.input ?? [] }, last);
    }

    const turn = last?.status === 'started' ? last.turn : (last?.turn ?? 0) + 1;
    if (signal.aborted) return this.#interrupted(turn, [], [], zeroUsage(), false);

    // A retried attempt of this turn (crash/abort before its response) already recorded its inputs: do not append the
    // same request input twice (queued inputs are drained exactly once by construction).
    const prior = await sessions.transcript(sessionId);
    const recorded = prior.filter((e) => e.turn === turn).map((e) => canonicalJson(e.message));
    const extra = (request.input ?? []).filter((m) => {
      const i = recorded.indexOf(canonicalJson(m));
      if (i < 0) return true;
      recorded.splice(i, 1);
      return false;
    });
    const appended = sessions.drainInputInto
      ? await sessions.drainInputInto(sessionId, turn, extra)
      : await (async () => {
          const entries = [...(await sessions.drainInput(sessionId)), ...extra].map((message) => ({ turn, message }));
          if (entries.length > 0) await sessions.appendTranscript(sessionId, entries);
          return entries;
        })();

    const transcript = [...prior, ...appended];
    const compactions = await sessions.compactions(sessionId);
    let ctx: Awaited<ReturnType<EngineHost['context']['assemble']>>;
    try {
      ctx = await host.context.assemble({ sessionId, turn, transcript, compactions, signal });
    } catch (e) {
      // A provider that honours the signal throws on abort: that is an interruption, not a fault (nothing recorded yet).
      if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);
      throw e;
    }
    if (!ctx || !Array.isArray(ctx.messages) || !Array.isArray(ctx.tools) || typeof ctx.snapshot?.snapshotId !== 'string' || ctx.snapshot.snapshotId.length === 0) {
      throw new HypertestError('internal', 'context provider returned an invalid TurnContext (messages, tools and snapshot.snapshotId are required)');
    }
    if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);

    await sessions.beginTurn(sessionId, turn, { snapshotId: ctx.snapshot.snapshotId });
    await this.#emit(host, EVENT_TYPES.agentTurnStarted, agentId, { sessionId, turn, snapshotId: ctx.snapshot.snapshotId, retried: last?.status === 'started' });

    const invokeRequest: Parameters<EngineHost['model']['invoke']>[0] = { messages: ctx.messages, tools: ctx.tools, signal, turn, snapshotId: ctx.snapshot.snapshotId };
    if (ctx.responseFormat) invokeRequest.responseFormat = ctx.responseFormat;
    let invocation: Awaited<ReturnType<EngineHost['model']['invoke']>>;
    try {
      invocation = await host.model.invoke(invokeRequest);
    } catch (e) {
      // An invoker that throws on abort: the turn stays `started` (nothing recorded) and is re-run next time.
      if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);
      throw e;
    }
    if (!invocation.ok) {
      // Interrupted: the turn stays `started` (nothing recorded) and is re-run from scratch next time.
      if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);
      await this.#emit(host, EVENT_TYPES.agentTurnCompleted, agentId, { sessionId, turn, status: 'boundary', boundary: invocation.boundary, message: invocation.message, replayed: false });
      await sessions.completeTurn(sessionId, turn, 'boundary', { sessionStatus: 'active', outcome: { status: 'boundary', boundary: invocation.boundary } });
      this.#deps.logger.info('turn ended at a model boundary', { sessionId, turn, boundary: invocation.boundary });
      return { status: 'boundary', turn, appended, toolResults: [], boundary: invocation.boundary, usage: zeroUsage(), replayed: false };
    }

    // Persist the response (and one pending row per tool call) BEFORE any tool runs.
    const response = normalizeResponse(invocation.message, turn);
    const rows = (response.toolCalls ?? []).map((c) => ({ toolCallId: c.id, name: c.name, invocationId: `${sessionId}:${turn}:${c.id}` }));
    // The snapshot of THIS attempt produced the response (a retried `started` turn may have assembled a newer one).
    const recordedTurn = await sessions.recordModelResponse(sessionId, turn, response, invocation.usage, rows, { epochId: invocation.epochId, routeId: invocation.routeId, snapshotId: ctx.snapshot.snapshotId });
    if (signal.aborted) return this.#interrupted(turn, appended, [], invocation.usage, false);
    return this.#dispatchAndFinish({ sessionId, agentId, turn, host, limits, signal, appended, usage: invocation.usage, replayed: false, carryInput: [] }, recordedTurn);
  }

  async #dispatchAndFinish(state: TurnState, record: TurnRecord): Promise<RunTurnResult> {
    const { sessionId, turn, host, limits, signal } = state;
    const sessions = host.sessions;
    const response = record.response;
    if (!response) throw new HypertestError('internal', `turn ${turn} of session ${sessionId} is model_responded without a response`);
    const calls = response.toolCalls ?? [];
    const byId = new Map(record.toolCalls.map((c) => [c.toolCallId, c]));
    const results: Array<DispatchResult | undefined> = calls.map((c) => {
      const r = byId.get(c.id);
      return r?.status === 'settled' ? fromRecord(r) : undefined;
    });
    const repetitive = await this.#isRepetitive(sessions, sessionId, turn, response, limits.repetitionThreshold);

    const settle = async (i: number, r: DispatchResult): Promise<void> => {
      const call = calls[i]!;
      const settled: Parameters<SessionStore['settleToolCall']>[3] = { result: r.message };
      if (r.pendingOperationId !== undefined) settled.pendingOperationId = r.pendingOperationId;
      if (r.terminal !== undefined) settled.terminal = r.terminal;
      await sessions.settleToolCall(sessionId, turn, call.id, settled);
      results[i] = r;
    };

    // Deterministic engine decisions first (never dispatched): repetition, per-turn cap, malformed arguments.
    const toDispatch: number[] = [];
    for (const [i, call] of calls.entries()) {
      if (results[i]) continue;
      if (repetitive) await settle(i, errorResult(call, `not executed: ${REPETITIVE_LOOP} detected (the last ${limits.repetitionThreshold} turns issued identical tool calls)`));
      else if (i >= limits.maxToolCallsPerTurn) await settle(i, errorResult(call, `${TOO_MANY_TOOL_CALLS} (limit ${limits.maxToolCallsPerTurn}); ${call.name} was not executed`));
      else if (call.rawArguments !== undefined) {
        const raw = truncateUtf8(call.rawArguments, 512).text;
        await settle(i, errorResult(call, `${MALFORMED_ARGUMENTS} for ${call.name}: the arguments are not valid JSON, so the tool was not executed. Raw arguments: ${raw}`));
      } else toDispatch.push(i);
    }

    const aborted = await this.#dispatchAll(state, calls, toDispatch, (i) => byId.get(calls[i]!.id)!.invocationId, settle);
    if (aborted || signal.aborted) {
      return this.#interrupted(turn, state.appended, results.filter((r): r is DispatchResult => r !== undefined), state.usage, state.replayed);
    }

    const toolResults = results as DispatchResult[];
    const entries: TranscriptEntry[] = [{ turn, message: response }, ...toolResults.map((r) => ({ turn, message: r.message as ChatMessage }))];
    const result: RunTurnResult = { status: 'continue', turn, appended: [...state.appended, ...entries], toolResults, usage: state.usage, replayed: state.replayed };
    const enqueue: ChatMessage[] = [...state.carryInput];
    if (repetitive) {
      result.status = 'failed';
      result.failure = { reason: REPETITIVE_LOOP, message: `the last ${limits.repetitionThreshold} turns issued identical tool calls` };
    } else {
      const terminals = toolResults.map((r) => r.terminal).filter((t): t is TerminalSignal => t !== undefined);
      const complete = terminals.find((t): t is Extract<TerminalSignal, { kind: 'complete' }> => t.kind === 'complete');
      const fail = terminals.find((t): t is Extract<TerminalSignal, { kind: 'fail' }> => t.kind === 'fail');
      const pending = toolResults.map((r) => r.pendingOperationId).filter((p): p is string => p !== undefined);
      if (complete) {
        result.status = 'completed';
        result.completion = complete;
      } else if (fail) {
        result.status = 'failed';
        result.failure = { reason: fail.reason, message: fail.message };
      } else if (pending.length > 0) {
        result.status = 'waiting';
        result.waitingOn = pending;
      } else if (calls.length === 0) {
        enqueue.push({ role: 'user', content: TEXT_ONLY_NUDGE });
      }
    }

    const payload: Record<string, unknown> = { sessionId, turn, status: result.status, replayed: state.replayed, toolCalls: calls.length };
    if (result.failure) payload['failure'] = result.failure;
    if (result.waitingOn) payload['waitingOn'] = result.waitingOn;
    // Emitted before the commit: a failed emit leaves the turn replayable (no model call, no re-dispatch). The outcome is
    // fully determined by the recorded response and settlements, so the event id is deterministic: a replay after a
    // failed commit re-appends the SAME event (an idempotent L0 store keeps one), never a second completion.
    await this.#emit(host, EVENT_TYPES.agentTurnCompleted, state.agentId, payload, turnCompletedEventId(sessionId, turn));
    const outcome: TurnOutcome = { status: result.status };
    if (result.completion) outcome.completion = result.completion;
    if (result.failure) outcome.failure = result.failure;
    if (result.waitingOn) outcome.waitingOn = result.waitingOn;
    const options: Parameters<SessionStore['completeTurn']>[3] = { append: entries, sessionStatus: sessionStatusFor(result.status), outcome };
    if (enqueue.length > 0) options.enqueue = enqueue;
    await sessions.completeTurn(sessionId, turn, 'completed', options);
    return result;
  }

  /** Dispatches in order: consecutive parallel-safe calls run concurrently (bounded), every other call alone. */
  async #dispatchAll(
    state: TurnState,
    calls: readonly ToolCall[],
    indices: readonly number[],
    invocationIdOf: (i: number) => string,
    settle: (i: number, r: DispatchResult) => Promise<void>,
  ): Promise<boolean> {
    const { sessionId, turn, host, signal } = state;
    let aborted = false;

    const runOne = async (i: number): Promise<void> => {
      if (signal.aborted) {
        aborted = true;
        return;
      }
      const call = calls[i]!;
      let r: DispatchResult;
      try {
        r = await host.tools.dispatch(call, { sessionId, turn, signal, invocationId: invocationIdOf(i) });
      } catch (e) {
        if (signal.aborted) {
          aborted = true;
          return;
        }
        throw e;
      }
      // A result produced while the turn was being aborted is not trusted as final: the call stays pending and is
      // re-dispatched (same invocation id ⇒ side effects reconcile) on replay. No partial fabricated results.
      if (signal.aborted) {
        aborted = true;
        return;
      }
      await settle(i, this.#normalizeDispatch(r, call, sessionId));
    };

    const runBatch = async (batch: number[]): Promise<void> => {
      let next = 0;
      let failure: { error: unknown } | undefined;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (failure || signal.aborted) return;
          const k = next++;
          if (k >= batch.length) return;
          try {
            await runOne(batch[k]!);
          } catch (e) {
            failure ??= { error: e };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_TOOL_CONCURRENCY, batch.length) }, worker));
      if (failure) throw failure.error;
    };

    let batch: number[] = [];
    for (const i of indices) {
      if (signal.aborted) return true;
      if (host.tools.isParallelSafe(calls[i]!.name)) {
        batch.push(i);
        continue;
      }
      if (batch.length > 0) {
        await runBatch(batch);
        batch = [];
        if (aborted || signal.aborted) return true;
      }
      await runOne(i);
      if (aborted) return true;
    }
    if (batch.length > 0) await runBatch(batch);
    return aborted;
  }

  #normalizeDispatch(r: DispatchResult, call: ToolCall, sessionId: string): DispatchResult {
    const m = r?.message as ToolResultMessage | undefined;
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') {
      throw new HypertestError('internal', `tool dispatcher returned no tool result message for ${call.name} (${call.id})`, { details: { sessionId, toolCallId: call.id } });
    }
    if (r.terminal !== undefined && !validTerminal(r.terminal)) {
      throw new HypertestError('internal', `tool dispatcher returned a malformed terminal signal for ${call.name}`, { details: { sessionId, toolCallId: call.id } });
    }
    if (r.pendingOperationId !== undefined && (typeof r.pendingOperationId !== 'string' || r.pendingOperationId.length === 0)) {
      throw new HypertestError('internal', `tool dispatcher returned an invalid pendingOperationId for ${call.name}`);
    }
    if (m.toolCallId !== call.id || m.toolName !== call.name) {
      this.#deps.logger.warn('tool result message ids corrected to the dispatched call', { sessionId, toolCallId: call.id, returned: m.toolCallId });
    }
    const message: ToolResultMessage = { role: 'tool', toolCallId: call.id, toolName: call.name, content: m.content };
    if (m.isError !== undefined) message.isError = m.isError;
    const out: DispatchResult = { ...r, message };
    return out;
  }

  /**
   * True when this response and the previous `threshold - 1` model responses issued identical tool calls. Turns that
   * ended at a model boundary without a response are skipped (no model decision was made there): a flapping provider
   * must not reset the count and hide a loop.
   */
  async #isRepetitive(sessions: SessionStore, sessionId: string, turn: number, response: AssistantMessage, threshold: number): Promise<boolean> {
    if (threshold < 2 || turn < threshold) return false;
    const signature = toolCallSignature(response);
    if (signature === undefined) return false;
    let needed = threshold - 1;
    for (let t = turn - 1; t >= 1 && needed > 0; t--) {
      const previous = await sessions.getTurn(sessionId, t);
      if (!previous) return false;
      if (previous.status === 'boundary' && previous.response === undefined) continue;
      if (previous.status !== 'completed' || toolCallSignature(previous.response) !== signature) return false;
      needed -= 1;
    }
    return needed === 0;
  }

  #interrupted(turn: number, appended: TranscriptEntry[], toolResults: DispatchResult[], usage: ModelUsage, replayed: boolean): RunTurnResult {
    return { status: 'interrupted', turn, appended, toolResults, usage, replayed };
  }

  async #emit(host: EngineHost, type: string, agentId: string, payload: Record<string, unknown>, eventId?: string): Promise<void> {
    if (!host.events) return;
    const ctx = host.eventContext.agentId === undefined ? { ...host.eventContext, agentId } : host.eventContext;
    const event = eventFrom(ctx, type, 'agent', agentId, payload);
    if (eventId !== undefined) event.eventId = eventId;
    await host.events.emit([event]);
  }

  async spawnChild(request: SpawnChildRequest): Promise<ChildRef> {
    const parent = await this.#deps.sessions.get(request?.parent?.sessionId);
    if (!parent) throw new HypertestError('not_found', `parent session ${request?.parent?.sessionId} not found`);
    if (request.child.runId !== parent.runId) throw new HypertestError('invalid_argument', `child run ${request.child.runId} differs from the parent's run ${parent.runId}`);
    // The child receives ONLY its own task context: nothing from the parent's transcript is copied.
    const session = await this.createSession(request.child);
    return { session, agentId: request.child.agentId };
  }

  async resumeChild(request: ResumeChildRequest): Promise<RunTurnResult> {
    const record = await this.#deps.sessions.get(request?.child?.sessionId);
    if (!record) throw new HypertestError('not_found', `child session ${request?.child?.sessionId} not found`);
    // Validate everything runTurn would refuse BEFORE reactivating: a misrouted or malformed resume must never
    // un-interrupt a session without running a turn.
    if (request.child.engineKind !== this.kind || record.engineKind !== this.kind) {
      throw new HypertestError('invalid_argument', `session ${record.sessionId} is a ${record.engineKind} session (ref says ${request.child.engineKind}); ${this.kind} cannot resume it`, {
        details: { sessionId: record.sessionId, engineKind: record.engineKind },
      });
    }
    validateLimits(request.limits);
    if (record.status === 'interrupted' || record.status === 'waiting') await this.#deps.sessions.setStatus(record.sessionId, 'active');
    const run: RunTurnRequest = { session: request.child, host: request.host, limits: request.limits, signal: request.signal };
    if (request.input !== undefined) run.input = request.input;
    return this.runTurn(run);
  }

  async interrupt(request: InterruptRequest): Promise<void> {
    const record = await this.#deps.sessions.get(request?.session?.sessionId);
    if (!record) throw new HypertestError('not_found', `session ${request?.session?.sessionId} not found`);
    if (!FINAL.has(record.status)) await this.#deps.sessions.setStatus(record.sessionId, 'interrupted');
    this.#abortInflight(record.sessionId, request.reason);
  }

  async inspect(ref: EngineSessionRef): Promise<EngineSessionState> {
    const record = await this.#deps.sessions.get(ref?.sessionId);
    if (!record) throw new HypertestError('not_found', `session ${ref?.sessionId} not found`);
    const last = await this.#deps.sessions.lastTurn(record.sessionId);
    const state: EngineSessionState = { session: { sessionId: record.sessionId, engineKind: record.engineKind }, status: record.status, turnCount: record.turnCount };
    if (last) state.lastTurnStatus = last.status;
    if (record.currentEpochId !== undefined) state.currentEpochId = record.currentEpochId;
    return state;
  }

  async dispose(ref: EngineSessionRef): Promise<void> {
    const record = await this.#deps.sessions.get(ref?.sessionId);
    if (!record) throw new HypertestError('not_found', `session ${ref?.sessionId} not found`);
    this.#abortInflight(record.sessionId, 'disposed');
    await this.#deps.sessions.setStatus(record.sessionId, 'disposed');
  }

  #abortInflight(sessionId: string, reason: string): void {
    for (const c of this.#inflight.get(sessionId) ?? []) c.abort(new HypertestError('cancelled', `session ${sessionId} interrupted: ${reason}`));
  }
}
