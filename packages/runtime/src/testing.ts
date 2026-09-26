import { HypertestError, jsonClone, type JsonSchema, type JsonValue } from '@hypertest/core';
import { estimateTokens, type AssistantMessage, type ChatMessage, type ContextSnapshot, type DomainEventSink, type EventContext, type ToolCall, type ToolDefinition } from '@hypertest/domain';
import type { ModelUsage } from '@hypertest/model';
import type { ContextProvider, DispatchResult, EngineHost, ModelInvocation, ModelInvoker, SessionStore, TerminalSignal, ToolDispatcher, TurnContext } from './contracts.ts';

/**
 * Test doubles for engines' tests (exported so every engine package can run the shared contract suite).
 * They are deterministic and record everything they receive.
 */

// ----------------------------------------------------------------------------- model

export type FakeReply =
  | {
      text?: string;
      toolCalls?: Array<{ id?: string; name: string; arguments?: JsonValue; rawArguments?: string }>;
      reasoning?: AssistantMessage['reasoning'];
      usage?: Partial<ModelUsage>;
      stopReason?: string;
    }
  | { boundary: Extract<ModelInvocation, { ok: false }>['boundary']; message?: string }
  /** Resolves `{ ok: false, boundary: 'cancelled' }` only when the request's signal aborts. */
  | { hangUntilAborted: true }
  | { throws: Error };

export type FakeInvokeRequest = Parameters<ModelInvoker['invoke']>[0];
export type FakeScript = FakeReply[] | ((request: FakeInvokeRequest, callIndex: number) => FakeReply | Promise<FakeReply>);

/** Scripted ModelInvoker. Tool call ids default to `call_<callIndex+1>_<k+1>`; a missing reply is an internal fault. */
export class FakeModelInvoker implements ModelInvoker {
  /** Every request, with messages/tools deep-copied at call time. */
  readonly requests: Array<{ messages: ChatMessage[]; tools: ToolDefinition[]; turn: number; snapshotId?: string; responseFormat?: { name: string; schema: JsonSchema } }> = [];
  readonly #script: FakeScript;
  readonly #routeId: string;
  readonly #epochId: string;

  constructor(script: FakeScript, options: { routeId?: string; epochId?: string } = {}) {
    this.#script = script;
    this.#routeId = options.routeId ?? 'route_fake';
    this.#epochId = options.epochId ?? 'ep_fake';
  }

  get callCount(): number {
    return this.requests.length;
  }

  async invoke(request: FakeInvokeRequest): Promise<ModelInvocation> {
    const index = this.requests.length;
    const rec: FakeModelInvoker['requests'][number] = { messages: jsonClone(request.messages), tools: jsonClone(request.tools ?? []), turn: request.turn };
    if (request.snapshotId !== undefined) rec.snapshotId = request.snapshotId;
    if (request.responseFormat !== undefined) rec.responseFormat = jsonClone(request.responseFormat);
    this.requests.push(rec);
    const reply = typeof this.#script === 'function' ? await this.#script(request, index) : this.#script[index];
    if (!reply) throw new HypertestError('internal', `FakeModelInvoker: no scripted reply for call #${index} (turn ${request.turn})`);
    if ('throws' in reply) throw reply.throws;
    if ('hangUntilAborted' in reply) {
      return new Promise<ModelInvocation>((resolve) => {
        const done = () => resolve({ ok: false, boundary: 'cancelled', message: 'aborted while waiting for the model' });
        if (request.signal.aborted) done();
        else request.signal.addEventListener('abort', done, { once: true });
      });
    }
    if ('boundary' in reply) return { ok: false, boundary: reply.boundary, message: reply.message ?? `fake ${reply.boundary}` };
    const message: AssistantMessage = { role: 'assistant', content: reply.text ? [{ type: 'text', text: reply.text }] : [] };
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      message.toolCalls = reply.toolCalls.map((c, k) => {
        const call: ToolCall = { id: c.id ?? `call_${index + 1}_${k + 1}`, name: c.name, arguments: c.arguments ?? {} };
        if (c.rawArguments !== undefined) {
          call.rawArguments = c.rawArguments;
          call.arguments = c.arguments ?? null;
        }
        return call;
      });
    }
    if (reply.reasoning !== undefined) message.reasoning = reply.reasoning;
    const usage: ModelUsage = { inputTokens: estimateTokens(request.messages, request.tools), outputTokens: 8, cachedInputTokens: 0, ...reply.usage };
    return { ok: true, message, usage, routeId: this.#routeId, epochId: this.#epochId, stopReason: reply.stopReason ?? (message.toolCalls ? 'tool_use' : 'end_turn') };
  }
}

// ----------------------------------------------------------------------------- tools

export type FakeToolOutcome = { content?: string; isError?: boolean; terminal?: TerminalSignal; pendingOperationId?: string };
export type FakeToolHandler = (call: ToolCall, meta: Parameters<ToolDispatcher['dispatch']>[1]) => FakeToolOutcome | void | Promise<FakeToolOutcome | void>;

export interface FakeToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  parallelSafe?: boolean;
  handler?: FakeToolHandler;
}

export interface FakeDispatchRecord {
  name: string;
  toolCallId: string;
  arguments: JsonValue;
  sessionId: string;
  turn: number;
  invocationId?: string;
}

/**
 * Recording ToolDispatcher. Unknown tools yield an error result (the dispatcher, not the engine, decides).
 * `log` holds `start:<name>:<id>` / `end:<name>:<id>` in real order; `maxInFlight` the peak concurrency.
 */
export class FakeDispatcher implements ToolDispatcher {
  readonly calls: FakeDispatchRecord[] = [];
  readonly log: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly #tools: Map<string, FakeToolSpec>;

  constructor(tools: FakeToolSpec[]) {
    this.#tools = new Map(tools.map((t) => [t.name, t]));
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((t) => ({ name: t.name, description: t.description ?? `fake tool ${t.name}`, inputSchema: t.inputSchema ?? { type: 'object' } }));
  }

  isParallelSafe(toolName: string): boolean {
    return this.#tools.get(toolName)?.parallelSafe === true;
  }

  async dispatch(call: ToolCall, meta: Parameters<ToolDispatcher['dispatch']>[1]): Promise<DispatchResult> {
    const rec: FakeDispatchRecord = { name: call.name, toolCallId: call.id, arguments: jsonClone(call.arguments ?? null), sessionId: meta.sessionId, turn: meta.turn };
    if (meta.invocationId !== undefined) rec.invocationId = meta.invocationId;
    this.calls.push(rec);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.log.push(`start:${call.name}:${call.id}`);
    try {
      const spec = this.#tools.get(call.name);
      if (!spec) return { message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: `unknown tool ${call.name}`, isError: true } };
      const out = (spec.handler ? await spec.handler(call, meta) : undefined) ?? {};
      const result: DispatchResult = { message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: out.content ?? `ok:${call.name}` } };
      if (out.isError !== undefined) result.message.isError = out.isError;
      if (out.terminal !== undefined) result.terminal = out.terminal;
      if (out.pendingOperationId !== undefined) result.pendingOperationId = out.pendingOperationId;
      return result;
    } finally {
      this.inFlight--;
      this.log.push(`end:${call.name}:${call.id}`);
    }
  }
}

/** A `complete_work`-style tool: arguments {summary, output?, evidenceRefs?, recordRefs?} → terminal complete. */
export function completeWorkTool(name = 'complete_work'): FakeToolSpec {
  return {
    name,
    handler: (call) => {
      const a = (call.arguments ?? {}) as { summary?: string; output?: JsonValue; evidenceRefs?: string[]; recordRefs?: string[] };
      const terminal: TerminalSignal = { kind: 'complete', summary: a.summary ?? '', evidenceRefs: a.evidenceRefs ?? [], recordRefs: a.recordRefs ?? [] };
      if (a.output !== undefined) terminal.output = a.output;
      return { content: 'work completed', terminal };
    },
  };
}

/** A `fail_work`-style tool: arguments {reason, message} → terminal fail. */
export function failWorkTool(name = 'fail_work'): FakeToolSpec {
  return {
    name,
    handler: (call) => {
      const a = (call.arguments ?? {}) as { reason?: string; message?: string };
      return { content: 'work failed', terminal: { kind: 'fail', reason: a.reason ?? 'failed', message: a.message ?? '' } };
    },
  };
}

// ----------------------------------------------------------------------------- context

export function fakeSnapshot(runId: string, snapshotId: string): ContextSnapshot {
  return {
    snapshotId,
    runId,
    eventSeq: 0,
    blackboardRevision: 0,
    planRevision: 0,
    runtimeManifestId: 'rm_fake',
    oracleRevisions: {},
    experimentRevisions: {},
    policyRevision: 'policy_fake',
    evidenceRootHash: '0'.repeat(64),
    readSet: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface FakeContextOptions {
  tools?: ToolDefinition[] | (() => ToolDefinition[]);
  system?: string;
  runId?: string;
  responseFormat?: { name: string; schema: JsonSchema };
  snapshotId?: (sessionId: string, turn: number) => string;
}

/**
 * ContextProvider over the portable transcript: [system?] + (latest compaction summary) + transcript messages.
 * The snapshot id is `cs_fake_<sessionId>_<turn>` unless `snapshotId` is given.
 */
export class FakeContextProvider implements ContextProvider {
  readonly calls: Array<{ sessionId: string; turn: number; transcriptLength: number }> = [];
  readonly #options: FakeContextOptions;

  constructor(options: FakeContextOptions = {}) {
    this.#options = options;
  }

  async assemble(input: Parameters<ContextProvider['assemble']>[0]): Promise<TurnContext> {
    this.calls.push({ sessionId: input.sessionId, turn: input.turn, transcriptLength: input.transcript.length });
    const messages: ChatMessage[] = [];
    if (this.#options.system) messages.push({ role: 'system', content: this.#options.system });
    const last = input.compactions.at(-1);
    const entries = last ? input.transcript.filter((e) => e.turn > last.upToTurn) : input.transcript;
    if (last) messages.push({ role: 'user', content: `[summary of turns 0..${last.upToTurn}] ${last.summary}` });
    for (const e of entries) messages.push(e.message);
    const tools = typeof this.#options.tools === 'function' ? this.#options.tools() : (this.#options.tools ?? []);
    const snapshotId = this.#options.snapshotId?.(input.sessionId, input.turn) ?? `cs_fake_${input.sessionId}_${input.turn}`;
    const ctx: TurnContext = { messages, tools, snapshot: fakeSnapshot(this.#options.runId ?? 'run_fake', snapshotId) };
    if (this.#options.responseFormat) ctx.responseFormat = this.#options.responseFormat;
    return ctx;
  }
}

/** Assembles an EngineHost from fakes (any member can be replaced). */
export function fakeHost(input: { sessions: SessionStore; model: ModelInvoker; tools: ToolDispatcher; context?: ContextProvider; events?: DomainEventSink; eventContext?: EventContext }): EngineHost {
  const host: EngineHost = {
    model: input.model,
    tools: input.tools,
    context: input.context ?? new FakeContextProvider({ tools: () => input.tools.definitions() }),
    sessions: input.sessions,
    eventContext: input.eventContext ?? { runId: 'run_fake', correlationId: 'corr_fake', actorId: 'system:test' },
  };
  if (input.events) host.events = input.events;
  return host;
}
