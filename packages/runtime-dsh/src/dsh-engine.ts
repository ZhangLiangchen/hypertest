import { HypertestError, canonicalJson, truncateUtf8, type JsonValue } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type AssistantMessage, type ChatMessage, type ToolCall, type ToolResultMessage } from '@hypertest/domain';
import type { ModelUsage } from '@hypertest/model';
import {
  MALFORMED_ARGUMENTS, PARALLEL_TOOL_CONCURRENCY, REPETITIVE_LOOP, TEXT_ONLY_NUDGE, TOO_MANY_TOOL_CALLS, normalizeResponse, toolCallSignature, turnCompletedEventId, validateLimits,
  type AgentEngine, type ChildRef, type CreateSessionRequest, type DispatchResult, type EngineCapabilities, type EngineHost, type EngineSessionRef, type EngineSessionState,
  type InterruptRequest, type ModelInvocation, type ResumeChildRequest, type RunTurnRequest, type RunTurnResult, type RunTurnStatus, type SessionStatus, type SessionStore,
  type SpawnChildRequest, type TerminalSignal, type ToolCallRecord, type TurnContext, type TurnLimits, type TurnOutcome, type TurnRecord,
} from '@hypertest/runtime';
import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as DshAgent, AgentHandle as DshAgentHandle, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { DSH_ENGINE_KIND, type DshEngineDeps } from './contracts.ts';
import { projectTranscript, responseChunks, toDshArguments, toDshToolName, turnMarker, viewOfTurn, type DshTurnView } from './convert.ts';
import { DshKernel, type StepHandler } from './kernel.ts';
import { DSH_AGENT_VERSION, RUNTIME_DSH_PACKAGE_VERSION, assertSupportedDsh, installedDshVersions } from './version.ts';

type TranscriptEntry = RunTurnResult['appended'][number];

const CLOSED: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'disposed', 'interrupted']);
const FINAL: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'disposed']);

/** DSH-side reason of a call not dispatched after a fault (never settled: the call stays pending and is replayed). */
const NOT_RUN_AFTER_FAULT = 'not executed: an earlier fault ended the turn (the call stays pending for the replay)';

function zeroUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

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

function assertNonEmpty(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new HypertestError('invalid_argument', `${what} must be a non-empty string`);
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The canonical value a DSH tool body returns for a settled Hypertest call (DSH renders `content`; errors are blocked). */
interface HostToolValue {
  [key: string]: JsonValue;
  content: string;
  isError: boolean;
}

function hostToolValue(r: DispatchResult): HostToolValue {
  return { content: r.message.content, isError: r.message.isError === true };
}

function isHostToolValue(v: unknown): v is HostToolValue {
  return typeof v === 'object' && v !== null && typeof (v as { content?: unknown }).content === 'string' && typeof (v as { isError?: unknown }).isError === 'boolean';
}

/**
 * A terminal DSH chunk: the request produced no response (host boundary, abort, refused second request). DSH's failure
 * facts carry a non-empty message, so an empty host message is replaced by the code.
 */
function failedFinish(kind: 'error' | 'aborted', message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind, failure: { message: message.length > 0 ? message : code, code } } };
}

/** What one DSH turn produced. */
interface LoopOutcome {
  /** A fault to rethrow; the turn stays as recorded (`started`, or `model_responded` with its settled calls). */
  fault?: unknown;
  /** The model request ended without a response: a host boundary, or an abort (`boundary` undefined). */
  noResponse?: { boundary?: Extract<ModelInvocation, { ok: false }> };
  /** The recorded turn whose calls DSH executed. */
  record?: TurnRecord;
  results: Array<DispatchResult | undefined>;
  repetitive: boolean;
  usage: ModelUsage;
  /** Model requests DSH made (the host model is invoked for the first one only). */
  streamRequests: number;
  /** DSH's own record of the live turn (its session log after the seed), cross-checked against the IR. */
  view?: DshTurnView;
  /** Failures DSH reported for the turn (`agent/error`), for diagnostics. */
  dshErrors: string[];
}

type LoopMode =
  | { kind: 'fresh'; ctx: TurnContext; transcript: TranscriptEntry[] }
  | { kind: 'replay'; record: TurnRecord; transcript: TranscriptEntry[] };

type Step = 'settled' | 'dispatch';

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
 * AgentEngine over the DeepSeek Harness agent loop (kind `dsh`). One Hypertest turn = one DSH turn of exactly one step:
 *   inputs → context (snapshot fixed) → beginTurn → a fresh DSH agent over a session seeded with the projection of the
 *   portable transcript, entering its step with the turn's input; DSH assembles its request and calls the `hypertest`
 *   LlmAdapter route, whose handler invokes `host.model` exactly once with the host-assembled TurnContext (boundary ⇒ the
 *   step fails without tools), records the response with its pending tool-call rows and settles the engine decisions
 *   BEFORE DSH sees the response, then streams it through DSH's chunk protocol → DSH's scheduler executes the calls
 *   through agent-scoped DSH tools that dispatch via `host.tools` (parallel-safe calls in DSH's bounded rolling pool,
 *   every other call alone, in order), each result settled immediately → `agent/pre-step` rejects a second step →
 *   transcript + turn completion in one transaction; the DSH agent and its session are disposed.
 * A turn left `model_responded` (crash/abort mid-dispatch) is replayed through DSH with the recorded response and no model
 * call; only unsettled calls are dispatched, with their recorded invocation ids. Persistence, events and outcomes are
 * exactly NativeEngine's, so sessions are portable between engines at turn boundaries.
 */
export class DshEngine implements AgentEngine {
  readonly kind: string = DSH_ENGINE_KIND;
  /** The pinned `@deepseek-ai/dsh-agent` version (RuntimeManifest pinning, I11). */
  readonly version: string = DSH_AGENT_VERSION;
  /** Version of this adapter (@hypertest/runtime-dsh). */
  readonly adapterVersion: string = RUNTIME_DSH_PACKAGE_VERSION;
  readonly capabilities: EngineCapabilities = {
    // The host ModelInvoker routes and starts epochs at turn boundaries; DSH only sees the `hypertest` route.
    providerSwitch: true,
    continuableChild: true,
    backgroundChild: false,
    // Peer/wake-up messages arrive through the SessionStore input queue, drained at turn start.
    peerMessaging: true,
    // responseFormat is passed through to the host ModelInvoker.
    structuredOutput: true,
    sandboxProfiles: false,
    // Compaction is Hypertest's context layer; no DSH compaction plugin is loaded.
    nativeCompaction: false,
    nativeComputerUse: false,
  };
  readonly #deps: DshEngineDeps;
  readonly #inflight = new Map<string, Set<AbortController>>();
  #kernel: Promise<DshKernel> | undefined;
  #nonce = 0;

  constructor(deps: DshEngineDeps) {
    if (!deps?.sessions) throw new HypertestError('invalid_argument', 'DshEngine requires a SessionStore');
    if (!deps.ids || !deps.clock || !deps.logger) throw new HypertestError('invalid_argument', 'DshEngine requires ids, clock and logger');
    // Pin + adapter: the adapter depends on the loop behaviour of the pinned DSH train (fail closed on any other).
    assertSupportedDsh(installedDshVersions());
    this.#deps = deps;
  }

  /** (additive) Disposes the DSH kernel (its cordis root); a later turn boots a new one. Idempotent. */
  async close(): Promise<void> {
    const kernel = this.#kernel;
    this.#kernel = undefined;
    if (kernel) await (await kernel.catch(() => undefined))?.close();
  }

  /** (additive, diagnostics) DSH sessions alive in the kernel: 0 between turns (every turn disposes its DSH agent). */
  async liveDshSessions(): Promise<number> {
    const kernel = this.#kernel ? await this.#kernel.catch(() => undefined) : undefined;
    return kernel?.liveSessions() ?? 0;
  }

  #bootKernel(): Promise<DshKernel> {
    if (!this.#kernel) {
      const booting = DshKernel.boot({ maxParallelToolCalls: PARALLEL_TOOL_CONCURRENCY, logger: this.#deps.logger });
      this.#kernel = booting;
      // A failed boot is not memoized: the next turn tries again.
      booting.catch(() => {
        if (this.#kernel === booting) this.#kernel = undefined;
      });
    }
    return this.#kernel;
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
    this.#deps.logger.debug('dsh session created', { sessionId, agentId: request.agentId });
    return { sessionId, engineKind: this.kind };
  }

  async runTurn(request: RunTurnRequest): Promise<RunTurnResult> {
    validateLimits(request?.limits);
    const ref = request.session;
    if (ref?.engineKind !== this.kind) throw new HypertestError('invalid_argument', `session ${ref?.sessionId} belongs to engine ${ref?.engineKind}, not ${this.kind}`);
    const sessions = request.host.sessions;
    // The abort handle is registered BEFORE the status is read: an interrupt() either sees it or committed first.
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
      // Replay through DSH with the recorded response: the host model is never called again for this turn.
      this.#deps.logger.info('replaying turn', { sessionId, turn: last.turn, pending: last.toolCalls.filter((c) => c.status === 'pending').length, engine: this.kind });
      const state: TurnState = { sessionId, agentId, turn: last.turn, host, limits, signal, appended: [], usage: zeroUsage(), replayed: true, carryInput: request.input ?? [] };
      const transcript = await sessions.transcript(sessionId);
      return this.#afterLoop(state, await this.#runDshTurn(state, { kind: 'replay', record: last, transcript }));
    }

    const turn = last?.status === 'started' ? last.turn : (last?.turn ?? 0) + 1;
    if (signal.aborted) return this.#interrupted(turn, [], [], zeroUsage(), false);

    // A retried attempt of this turn already recorded its inputs: never append the same request input twice.
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
    let ctx: TurnContext;
    try {
      ctx = await host.context.assemble({ sessionId, turn, transcript, compactions, signal });
    } catch (e) {
      if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);
      throw e;
    }
    if (!ctx || !Array.isArray(ctx.messages) || !Array.isArray(ctx.tools) || typeof ctx.snapshot?.snapshotId !== 'string' || ctx.snapshot.snapshotId.length === 0) {
      throw new HypertestError('internal', 'context provider returned an invalid TurnContext (messages, tools and snapshot.snapshotId are required)');
    }
    if (signal.aborted) return this.#interrupted(turn, appended, [], zeroUsage(), false);

    await sessions.beginTurn(sessionId, turn, { snapshotId: ctx.snapshot.snapshotId });
    await this.#emit(host, EVENT_TYPES.agentTurnStarted, agentId, { sessionId, turn, snapshotId: ctx.snapshot.snapshotId, retried: last?.status === 'started' });

    const state: TurnState = { sessionId, agentId, turn, host, limits, signal, appended, usage: zeroUsage(), replayed: false, carryInput: [] };
    return this.#afterLoop(state, await this.#runDshTurn(state, { kind: 'fresh', ctx, transcript }));
  }

  /**
   * Runs ONE DSH turn over a fresh DSH agent. DSH owns the loop mechanics (turn/step lifecycle, request assembly, chunk
   * assembly, tool scheduling and the execution pipeline); the Hypertest invariants are enforced at DSH's public seams:
   * the `hypertest` LlmAdapter route (one host model call; response persisted and engine decisions settled before DSH
   * sees it), agent-scoped tools (host dispatch + settlement), `tools/post-execute` (DSH's error flag = the settled
   * result's) and `agent/pre-step` (the turn's input enters step 1; any further step is rejected). DSH's thrown-tool-error
   * convention is used only to report non-dispatch to DSH; faults are captured, stop the DSH agent, and are rethrown by
   * the engine after DSH has drained.
   */
  async #runDshTurn(state: TurnState, mode: LoopMode): Promise<LoopOutcome> {
    const { sessionId, turn, host, limits, signal } = state;
    const sessions = host.sessions;
    const logger = this.#deps.logger;
    const out: LoopOutcome = { results: [], repetitive: false, usage: zeroUsage(), streamRequests: 0, dshErrors: [] };

    let calls: ToolCall[] = [];
    let steps: Step[] = [];
    let invocationIds: string[] = [];
    let indexById = new Map<string, number>();
    let agent: DshAgent | undefined;
    const fault = (e: unknown): void => {
      out.fault ??= e;
      // Nothing more happens in this turn: DSH starts no further call (in-flight calls drain and settle).
      agent?.cancel({ kind: 'hook', reason: 'hypertest: fault' });
    };

    const settle = async (i: number, r: DispatchResult): Promise<void> => {
      const settled: Parameters<SessionStore['settleToolCall']>[3] = { result: r.message };
      if (r.pendingOperationId !== undefined) settled.pendingOperationId = r.pendingOperationId;
      if (r.terminal !== undefined) settled.terminal = r.terminal;
      await sessions.settleToolCall(sessionId, turn, calls[i]!.id, settled);
      out.results[i] = r;
    };

    const indexOf = (toolCallId: string, what: string): number => {
      const i = indexById.get(toolCallId);
      if (i === undefined) throw new HypertestError('internal', `DSH ${what} tool call ${toolCallId}, which is not in the recorded response`, { details: { sessionId, turn, toolCallId } });
      return i;
    };

    /**
     * Plans the recorded response: settled calls (replay) answer from the record; the deterministic engine decisions
     * (repetition, per-turn cap, malformed arguments) are settled now, in call order, BEFORE anything is dispatched (as in
     * NativeEngine: a failed settlement stops the turn and later decisions stay unsettled); the rest are dispatched.
     */
    const plan = async (record: TurnRecord): Promise<void> => {
      const response = record.response;
      if (!response) throw new HypertestError('internal', `turn ${turn} of session ${sessionId} is model_responded without a response`);
      calls = response.toolCalls ?? [];
      const rows = new Map(record.toolCalls.map((c) => [c.toolCallId, c]));
      out.results = calls.map((c) => {
        const row = rows.get(c.id);
        return row?.status === 'settled' ? fromRecord(row) : undefined;
      });
      invocationIds = calls.map((c) => {
        const row = rows.get(c.id);
        if (!row) throw new HypertestError('internal', `turn ${turn} of session ${sessionId} has no tool-call row for ${c.id}`);
        return row.invocationId;
      });
      indexById = new Map(calls.map((c, i) => [c.id, i]));
      out.record = record;
      out.repetitive = await this.#isRepetitive(sessions, sessionId, turn, response, limits.repetitionThreshold);
      steps = calls.map((): Step => 'dispatch');
      for (const [i, call] of calls.entries()) {
        if (out.results[i]) {
          steps[i] = 'settled';
          continue;
        }
        let reason: string | undefined;
        if (out.repetitive) reason = `not executed: ${REPETITIVE_LOOP} detected (the last ${limits.repetitionThreshold} turns issued identical tool calls)`;
        else if (i >= limits.maxToolCallsPerTurn) reason = `${TOO_MANY_TOOL_CALLS} (limit ${limits.maxToolCallsPerTurn}); ${call.name} was not executed`;
        else if (call.rawArguments !== undefined) {
          reason = `${MALFORMED_ARGUMENTS} for ${call.name}: the arguments are not valid JSON, so the tool was not executed. Raw arguments: ${truncateUtf8(call.rawArguments, 512).text}`;
        }
        if (reason === undefined) continue;
        await settle(i, errorResult(call, reason));
        steps[i] = 'settled';
      }
    };

    /**
     * DSH classifies parallel safety per tool; a call that only answers from the record (settled or engine-decided) is
     * never dispatched, so a tool whose every call in this turn is such a call is parallel-safe (it neither splits a batch
     * of parallel-safe calls nor overlaps an exclusive one: DSH runs exclusive calls alone either way).
     */
    const parallelSafe = (name: string): boolean => {
      const indices = calls.flatMap((c, i) => (c.name === name ? [i] : []));
      if (indices.length > 0 && indices.every((i) => steps[i] === 'settled')) return true;
      return host.tools.isParallelSafe(name);
    };

    const execute = async (toolCallId: string): Promise<HostToolValue> => {
      let i: number;
      try {
        i = indexOf(toolCallId, 'executed');
        if (steps[i] === 'settled') return hostToolValue(out.results[i]!);
      } catch (e) {
        fault(e);
        throw e;
      }
      // After a fault the turn does nothing more (like NativeEngine, which stops at its first fault).
      if (out.fault !== undefined) throw new Error(NOT_RUN_AFTER_FAULT);
      if (signal.aborted) throw new Error('not dispatched: the turn was aborted');
      const call = calls[i]!;
      let r: DispatchResult;
      try {
        r = await host.tools.dispatch(call, { sessionId, turn, signal, invocationId: invocationIds[i]! });
      } catch (e) {
        if (!signal.aborted) fault(e);
        throw e;
      }
      // A result produced while the turn is being aborted is not trusted as final: the call stays pending and is
      // re-dispatched (same invocation id ⇒ side effects reconcile) on replay. No partial fabricated results.
      if (signal.aborted) throw new Error('not settled: the turn was aborted');
      try {
        const normalized = this.#normalizeDispatch(r, call, sessionId);
        await settle(i, normalized);
        return hostToolValue(normalized);
      } catch (e) {
        fault(e);
        throw e;
      }
    };

    // DSH tools: the declared tools, plus (once the response is known) any other name it calls, so every call reaches
    // the host dispatcher (unknown tools are the dispatcher's decision, never DSH's UNKNOWN_TOOL). Parameters are open:
    // argument validation is the host's (DSH validates only `defineTool` schemas, never these raw ones).
    const registered = new Set<string>();
    const registerTool = (ctx: DshContext, name: string, description: string): void => {
      const dshName = toDshToolName(name);
      if (registered.has(dshName)) return;
      registered.add(dshName);
      ctx.tools.register({
        name: dshName,
        description,
        parameters: {},
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: isHostToolValue(value) ? value.content : '' }] },
        isConcurrencySafe: () => parallelSafe(name),
        execute: (_args, exec) => execute(exec.callId),
      });
    };
    // A fresh turn declares the host-assembled tools. A replay knows the response up front and needs exactly the tools it
    // calls; like NativeEngine's replay it depends only on the record and the dispatcher's dispatch/isParallelSafe.
    // DSH's tool listing never reaches a model (the host invoker gets `ctx.tools` untouched), so a definition DSH could not
    // log (a description that is not a string) must not stop the turn before the model is asked: DSH gets a string.
    const declared = mode.kind === 'fresh'
      ? mode.ctx.tools.map((d) => ({ name: d.name, description: typeof d.description === 'string' ? d.description : `tool ${d.name}` }))
      : (mode.record.response?.toolCalls ?? []).map((c) => ({ name: c.name, description: `tool ${c.name}` }));

    // The model step of this turn (the `hypertest` route of the DSH kernel serves it).
    const serveStep: StepHandler = async function* () {
      out.streamRequests += 1;
      if (out.streamRequests > 1) {
        // One Hypertest turn = one DSH step (agent/pre-step rejects any other). Should DSH ever ask again, the host model
        // is NOT called: the request fails without a response and DSH stops.
        logger.warn('DSH requested a second model response in one turn; refused', { sessionId, turn });
        yield failedFinish('error', 'one model response per Hypertest turn', 'HYPERTEST_ONE_STEP');
        return;
      }
      if (mode.kind === 'replay') {
        try {
          await plan(mode.record);
        } catch (e) {
          fault(e);
          throw e;
        }
        yield* responseChunks(mode.record.response!);
        return;
      }

      const ctx = mode.ctx;
      const invokeRequest: Parameters<EngineHost['model']['invoke']>[0] = { messages: ctx.messages, tools: ctx.tools, signal, turn, snapshotId: ctx.snapshot.snapshotId };
      if (ctx.responseFormat) invokeRequest.responseFormat = ctx.responseFormat;
      let invocation: ModelInvocation;
      try {
        invocation = await host.model.invoke(invokeRequest);
      } catch (e) {
        // An invoker that throws on abort: the turn stays `started` (nothing recorded) and is re-run next time.
        if (signal.aborted) {
          out.noResponse = {};
          yield failedFinish('aborted', messageOf(e), 'ABORTED');
          return;
        }
        fault(e);
        throw e;
      }
      if (!invocation.ok) {
        out.noResponse = signal.aborted ? {} : { boundary: invocation };
        yield signal.aborted ? failedFinish('aborted', invocation.message, 'ABORTED') : failedFinish('error', invocation.message, `HYPERTEST_BOUNDARY_${invocation.boundary.toUpperCase()}`);
        return;
      }
      // Persist the response (and one pending row per tool call) BEFORE DSH sees it, hence before any tool runs.
      let record: TurnRecord;
      try {
        const response = normalizeResponse(invocation.message, turn);
        const rows = (response.toolCalls ?? []).map((c) => ({ toolCallId: c.id, name: c.name, invocationId: `${sessionId}:${turn}:${c.id}` }));
        record = await sessions.recordModelResponse(sessionId, turn, response, invocation.usage, rows, { epochId: invocation.epochId, routeId: invocation.routeId, snapshotId: ctx.snapshot.snapshotId });
      } catch (e) {
        fault(e);
        throw e;
      }
      out.usage = invocation.usage;
      out.record = record;
      if (signal.aborted) {
        yield failedFinish('aborted', 'the turn was aborted after the response was recorded', 'ABORTED');
        return;
      }
      try {
        await plan(record);
        if (!agent) throw new HypertestError('internal', 'DSH requested a model response before its agent was published');
        for (const c of calls) registerTool(agent.ctx, c.name, `tool ${c.name}`);
      } catch (e) {
        fault(e);
        throw e;
      }
      yield* responseChunks(record.response!);
    };

    if (signal.aborted) return out;
    let kernel: DshKernel;
    try {
      kernel = await this.#bootKernel();
    } catch (e) {
      fault(e);
      return out;
    }
    const { seed, inputs, turns } = projectTranscript(mode.transcript, this.#deps.clock.nowMs());
    const liveTurn = turns + 1;
    const marker = turnMarker(turn);
    const entering = inputs.length > 0 ? inputs : [marker];
    this.#nonce += 1;
    const dshSessionId = `${sessionId}#t${turn}#${this.#nonce}`;
    let handle: DshAgentHandle;
    try {
      handle = await kernel.createAgent({
        sessionId: dshSessionId,
        seed,
        step: serveStep,
        setup: (ctx) => {
          for (const d of declared) registerTool(ctx, d.name, d.description);
          // The turn's input enters step 1 (replacing the wake-up marker DSH claimed); every other step is rejected.
          ctx.on('agent/pre-step', async (payload): Promise<PreStepDecision> => (payload.turn === liveTurn && payload.step === 1 ? { kind: 'enter', messages: entering } : { kind: 'reject' }));
          // DSH's error flag = the settled result's (a Hypertest tool error is a failed outcome, not a fault).
          ctx.on('tools/post-execute', async (_exec, result, next) => {
            if (!result.isError && isHostToolValue(result.value) && result.value.isError) return { kind: 'block', feedback: [{ type: 'text', text: result.value.content }] };
            return next();
          });
          ctx.on('agent/error', ({ error }) => {
            out.dshErrors.push(messageOf(error));
          });
        },
      });
    } catch (e) {
      kernel.release(dshSessionId);
      fault(new HypertestError('internal', `DSH refused the agent of turn ${turn} of session ${sessionId}: ${messageOf(e)}`, { details: { sessionId, turn }, cause: e }));
      return out;
    }
    agent = handle.agent;
    const running = agent;
    const onAbort = (): void => running.cancel({ kind: 'parent' });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (!signal.aborted) {
        running.followup(marker);
        await running.whenIdle();
      }
      out.view = viewOfTurn(running.session.events, seed.length);
    } catch (e) {
      if (!signal.aborted) fault(e);
    } finally {
      signal.removeEventListener('abort', onAbort);
      kernel.release(dshSessionId);
      try {
        await handle.dispose();
      } catch (e) {
        logger.warn('DSH agent disposal failed', { sessionId, turn, error: messageOf(e) });
      }
    }
    logger.debug('dsh turn trace', { sessionId, turn, engine: this.kind, streamRequests: out.streamRequests, steps: out.view?.steps ?? 0, events: out.view?.trace ?? [], dshErrors: out.dshErrors });
    return out;
  }

  async #afterLoop(state: TurnState, loop: LoopOutcome): Promise<RunTurnResult> {
    const { sessionId, agentId, turn, host, signal } = state;
    if (loop.fault !== undefined) throw loop.fault;
    const record = loop.record;
    if (!record) {
      const boundary = loop.noResponse?.boundary;
      if (boundary) {
        await this.#emit(host, EVENT_TYPES.agentTurnCompleted, agentId, { sessionId, turn, status: 'boundary', boundary: boundary.boundary, message: boundary.message, replayed: false });
        await host.sessions.completeTurn(sessionId, turn, 'boundary', { sessionStatus: 'active', outcome: { status: 'boundary', boundary: boundary.boundary } });
        this.#deps.logger.info('turn ended at a model boundary', { sessionId, turn, boundary: boundary.boundary });
        return { status: 'boundary', turn, appended: state.appended, toolResults: [], boundary: boundary.boundary, usage: zeroUsage(), replayed: false };
      }
      // Interrupted before a response: the turn stays `started` (nothing recorded) and is re-run next time.
      if (loop.noResponse || signal.aborted) return this.#interrupted(turn, state.appended, [], zeroUsage(), state.replayed);
      throw new HypertestError('internal', `DSH ended turn ${turn} of session ${sessionId} without requesting a model response${loop.dshErrors.length > 0 ? `: ${loop.dshErrors.join('; ')}` : ''}`, {
        details: { sessionId, turn, dshErrors: loop.dshErrors },
      });
    }
    const usage = state.replayed ? state.usage : loop.usage;
    if (signal.aborted) return this.#interrupted(turn, state.appended, loop.results.filter((r): r is DispatchResult => r !== undefined), usage, state.replayed);

    const response = record.response!;
    const calls = response.toolCalls ?? [];
    const missing = calls.filter((_, i) => loop.results[i] === undefined).map((c) => c.id);
    if (missing.length > 0) {
      // DSH finished the turn without routing these calls through the engine: nothing is fabricated, the turn stays
      // model_responded and is replayed (the replay declares every called tool up front).
      throw new HypertestError('internal', `DSH finished turn ${turn} without executing ${missing.join(', ')} through the Hypertest dispatcher${loop.dshErrors.length > 0 ? ` (${loop.dshErrors.join('; ')})` : ''}`, {
        details: { sessionId, turn, missing, dshErrors: loop.dshErrors },
      });
    }
    const toolResults = loop.results as DispatchResult[];
    this.#crossCheck(sessionId, turn, loop, response, toolResults);
    return this.#finish({ ...state, usage }, response, toolResults, loop.repetitive);
  }

  /** DSH's view of the turn must be one step with the recorded calls and settled results; a divergence is logged (IR wins). */
  #crossCheck(sessionId: string, turn: number, loop: LoopOutcome, response: AssistantMessage, toolResults: DispatchResult[]): void {
    const view = loop.view;
    if (!view) {
      this.#deps.logger.warn('DSH recorded no view of the turn', { sessionId, turn });
      return;
    }
    const calls = (response.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: toDshArguments(c) }));
    const results = toolResults.map((r) => ({ toolCallId: r.message.toolCallId, content: r.message.content, isError: r.message.isError === true }));
    if (view.steps !== 1 || canonicalJson(view.calls) !== canonicalJson(calls) || canonicalJson(view.results) !== canonicalJson(results)) {
      this.#deps.logger.warn('DSH turn state diverged from the recorded turn (the recorded turn is committed)', { sessionId, turn, steps: view.steps, events: view.trace });
    }
  }

  async #finish(state: TurnState, response: AssistantMessage, toolResults: DispatchResult[], repetitive: boolean): Promise<RunTurnResult> {
    const { sessionId, turn, host, limits } = state;
    const calls = response.toolCalls ?? [];
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
    // Emitted before the commit with a deterministic id: a failed emit leaves the turn replayable, and a replay after a
    // failed commit re-appends the SAME event (an idempotent L0 store keeps one).
    await this.#emit(host, EVENT_TYPES.agentTurnCompleted, state.agentId, payload, turnCompletedEventId(sessionId, turn));
    const outcome: TurnOutcome = { status: result.status };
    if (result.completion) outcome.completion = result.completion;
    if (result.failure) outcome.failure = result.failure;
    if (result.waitingOn) outcome.waitingOn = result.waitingOn;
    const options: Parameters<SessionStore['completeTurn']>[3] = { append: entries, sessionStatus: sessionStatusFor(result.status), outcome };
    if (enqueue.length > 0) options.enqueue = enqueue;
    await host.sessions.completeTurn(sessionId, turn, 'completed', options);
    return result;
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
    return { ...r, message };
  }

  /**
   * True when this response and the previous `threshold - 1` model responses issued identical tool calls. Turns that
   * ended at a model boundary without a response are skipped (no model decision was made there).
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
    // Validate everything runTurn would refuse BEFORE reactivating the session: a misrouted (another engine's session)
    // or malformed resume must never un-interrupt a session without running a turn.
    if (request.child.engineKind !== this.kind || record.engineKind !== this.kind) {
      throw new HypertestError('invalid_argument', `session ${record.sessionId} is a ${record.engineKind} session (ref says ${request.child.engineKind}); ${this.kind} cannot resume it`, {
        details: { sessionId: record.sessionId, engineKind: record.engineKind },
      });
    }
    validateLimits(request.limits);
    // A[4]: the engine resumes its child — an interrupted or waiting session, or a continuable child's completed task
    // (the host resumes it only for continuable children); a failed or disposed session is never reactivated
    if (record.status === 'failed' || record.status === 'disposed') {
      throw new HypertestError('precondition_failed', `child session ${record.sessionId} is ${record.status}; it cannot be resumed`, { details: { sessionId: record.sessionId, status: record.status } });
    }
    if (record.status === 'interrupted' || record.status === 'waiting' || record.status === 'completed') await this.#deps.sessions.setStatus(record.sessionId, 'active');
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
