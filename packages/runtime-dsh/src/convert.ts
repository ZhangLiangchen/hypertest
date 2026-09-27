/**
 * Hypertest message IR → DeepSeek Harness session projection (package-private: DSH types never leave
 * @hypertest/runtime-dsh).
 *
 * DSH derives every model request from its session log. In a Hypertest turn DSH never reaches a provider (the host
 * ModelInvoker answers through the `hypertest` LlmAdapter route with the host-assembled context), so DSH's log is a
 * disposable per-turn PROJECTION of the portable SessionStore transcript, rebuilt every turn and never read back as
 * truth. It is faithful on everything DSH acts on — turn/step structure, tool-call ids, names and argument text, tool
 * results with their error flags — and approximates what DSH has no core slot for:
 *   - system messages become `user/message`s with a `plugin` source (`hypertest`, form `instructions`);
 *   - image parts become text placeholders `[image <mime> <artifactUri?>]` (DSH images need its attachment service);
 *   - opaque reasoning (provider continuation state) is not projected: route compatibility is the host's (projectForRoute);
 *   - the string/parts distinction of user content is not kept (both are text blocks).
 * DSH turns are cut at model responses: the inputs since the previous response (turn-0 task input, wake-ups, the text-only
 * nudge, inputs of turns that ended at a model boundary) enter the step whose response follows them, as DSH itself would
 * have logged it. What follows the last response is the live turn's input.
 */
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { AssistantMessage as DshAssistantMessage, ContentBlock, StreamChunk, ToolResultMessage as DshToolResultMessage, UserMessage as DshUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { AssistantMessage, ChatMessage, ContentPart, ToolCall, ToolResultMessage } from '@hypertest/domain';

/** The DSH provider route served by the Hypertest host (the only route registered in the adapter's DSH kernel). */
export const HOST_PROVIDER = 'hypertest';
/** The DSH model id of every request (the host ModelInvoker picks the real route; DSH never sees it). */
export const HOST_MODEL = 'hypertest-host';
/** `plugin` of DSH message sources produced by this adapter. */
export const HYPERTEST_PLUGIN = 'hypertest';

/** DSH reserves this tool name for its Code Mode transport; it is escaped like the escape prefix itself. */
const RESERVED_TOOL = 'run_code';
const ESCAPE = 'hypertest:';
/** Tool result text projected for a call the IR transcript holds no result for (an incomplete foreign transcript). */
export const NO_RECORDED_RESULT = 'no result was recorded for this tool call in the Hypertest transcript';

/** Bijective DSH name of a Hypertest tool (reserved and empty names get the escape prefix; so does the prefix itself). */
export function toDshToolName(name: string): string {
  return name === RESERVED_TOOL || name === '' || name.startsWith(ESCAPE) ? ESCAPE + name : name;
}

export function fromDshToolName(name: string): string {
  return name.startsWith(ESCAPE) ? name.slice(ESCAPE.length) : name;
}

/**
 * The raw argument text DSH records and parses: the provider's unparsable text, else the JSON of the IR arguments.
 * Re-serializing (never forwarding provider text) keeps it lossless JSON (`-0` becomes `0`), so DSH's argument snapshot
 * always admits the call and it reaches the Hypertest tool body.
 */
export function toDshArguments(call: Pick<ToolCall, 'arguments' | 'rawArguments'>): string {
  return call.rawArguments ?? JSON.stringify(call.arguments ?? null);
}

function partText(part: ContentPart): string {
  if (part.type === 'text') return part.text;
  return part.artifactUri ? `[image ${part.mimeType} ${part.artifactUri}]` : `[image ${part.mimeType}]`;
}

function textBlocks(content: string | readonly ContentPart[]): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((p) => ({ type: 'text', text: partText(p) }));
}

/** A system or user IR message as a DSH user-role input. */
export function toDshInput(message: Extract<ChatMessage, { role: 'system' | 'user' }>): DshUserMessage {
  if (message.role === 'system') {
    return createUserMessage({ content: textBlocks(message.content), source: { kind: 'plugin', plugin: HYPERTEST_PLUGIN, form: 'instructions' } });
  }
  return createUserMessage({ content: textBlocks(message.content), source: { kind: 'user' } });
}

/** A tool result without a matching call in the preceding response (never produced by the engines): kept as a notice. */
function orphanResult(message: ToolResultMessage): DshUserMessage {
  const text = `[tool result ${message.toolName} ${message.toolCallId}${message.isError === true ? ' (error)' : ''}] ${message.content}`;
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: HYPERTEST_PLUGIN, form: 'notice', summary: `orphan tool result ${message.toolCallId}`.slice(0, 120) } });
}

/** The DSH message of an IR response: reasoning text, content parts, then one tool-call block per call (in order). */
export function toDshAssistant(message: AssistantMessage): DshAssistantMessage {
  const content: ContentBlock[] = [];
  if (typeof message.reasoning?.text === 'string' && message.reasoning.text.length > 0) content.push({ type: 'reasoning', text: message.reasoning.text });
  for (const p of message.content ?? []) content.push({ type: 'text', text: partText(p) });
  for (const c of message.toolCalls ?? []) content.push({ type: 'tool-call', id: CallId(c.id), name: toDshToolName(c.name), arguments: toDshArguments(c) });
  return createAssistantMessage({ content, source: { provider: HOST_PROVIDER, model: HOST_MODEL } });
}

export function toDshToolResult(result: Pick<ToolResultMessage, 'toolCallId' | 'content' | 'isError'>): DshToolResultMessage {
  return createToolResultMessage({ callId: CallId(result.toolCallId), content: [{ type: 'text', text: result.content }], isError: result.isError === true });
}

/** The input a live DSH turn enters with when the Hypertest turn has no new input (DSH enters a step only with input). */
export function turnMarker(turn: number): DshUserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `[Hypertest turn ${turn}]` }],
    source: { kind: 'plugin', plugin: HYPERTEST_PLUGIN, form: 'notice', summary: `Hypertest turn ${turn}` },
  });
}

export interface DshProjection {
  /** Completed DSH turns (one per IR model response), contiguous from seq 0, with no open turn/step or dangling call. */
  seed: SessionEvent[];
  /** Inputs after the last response: what the live DSH turn enters its step with (may be empty). */
  inputs: DshUserMessage[];
  /** Number of seeded DSH turns (the live DSH turn is `turns + 1`). */
  turns: number;
}

interface OpenTurn {
  inputs: DshUserMessage[];
  response: AssistantMessage;
  results: Map<string, ToolResultMessage>;
}

/**
 * The `time` of a seeded DSH event. DSH's session boundary refuses any seed event whose time is not a safe integer, while
 * a Hypertest `Clock` may legitimately report fractional (e.g. `performance`-based) or out-of-range milliseconds: the
 * stamp is truncated and clamped (a non-finite one is 0), so the clock can never make DSH refuse a turn's agent. The
 * stamp is DSH-internal bookkeeping of a disposable projection; nothing Hypertest records depends on it.
 */
export function seedTime(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(Number.MIN_SAFE_INTEGER, Math.trunc(ms))) || 0;
}

/**
 * Rebuilds the DSH session projection of a portable transcript (see the module comment). `time` stamps every event
 * (normalized by {@link seedTime}).
 */
export function projectTranscript(entries: ReadonlyArray<{ turn: number; message: ChatMessage }>, time: number): DshProjection {
  time = seedTime(time);
  const seed: SessionEvent[] = [];
  let turns = 0;
  let pending: DshUserMessage[] = [];
  let open: OpenTurn | undefined;
  const push = (event: Omit<SessionEvent, 'seq' | 'time'>): number => {
    const seq = seed.length;
    seed.push({ ...event, seq, time } as SessionEvent);
    return seq;
  };
  const close = (): void => {
    if (!open) return;
    turns += 1;
    const turn = turns;
    push({ type: 'turn/start', data: { turn } });
    push({ type: 'step/start', data: { turn, step: 1 } });
    for (const m of open.inputs) push({ type: 'user/message', data: m, surfaceOp: 'append' } as Omit<SessionEvent, 'seq' | 'time'>);
    push({ type: 'assistant/message', data: { turn, step: 1, message: toDshAssistant(open.response) }, surfaceOp: 'append' } as Omit<SessionEvent, 'seq' | 'time'>);
    for (const call of open.response.toolCalls ?? []) {
      const callSeq = push({ type: 'tool/call', data: { turn, step: 1, callId: CallId(call.id), name: toDshToolName(call.name), arguments: toDshArguments(call) } });
      const result = open.results.get(call.id) ?? { toolCallId: call.id, content: NO_RECORDED_RESULT, isError: true };
      push({ type: 'tool/result', data: { turn, step: 1, message: toDshToolResult(result) }, surfaceOp: 'append', sourceEventSeqs: [callSeq] } as Omit<SessionEvent, 'seq' | 'time'>);
    }
    push({ type: 'step/end', data: { turn, step: 1 } });
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    open = undefined;
  };
  for (const { message } of entries) {
    if (message.role === 'tool') {
      const current = open;
      if (current && !current.results.has(message.toolCallId) && (current.response.toolCalls ?? []).some((c) => c.id === message.toolCallId)) {
        current.results.set(message.toolCallId, message);
        continue;
      }
      close();
      pending.push(orphanResult(message));
      continue;
    }
    close();
    if (message.role === 'assistant') {
      open = { inputs: pending, response: message, results: new Map() };
      pending = [];
    } else {
      pending.push(toDshInput(message));
    }
  }
  close();
  return { seed, inputs: pending, turns };
}

/** The recorded response streamed through DSH's chunk protocol (block start/delta/end per block, then finish). */
export function responseChunks(response: AssistantMessage): StreamChunk[] {
  const message = toDshAssistant(response);
  const chunks: StreamChunk[] = [];
  message.content.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type });
    if (block.type === 'text') chunks.push({ type: 'text-delta', index, text: block.text });
    else if (block.type === 'reasoning') chunks.push({ type: 'reasoning-delta', index, text: block.text });
    else if (block.type === 'tool-call') chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments });
    chunks.push({ type: 'block-end', index, block });
  });
  // Never `max-tokens`: DSH would skip the calls of a length-limited response, and tool policy is the host's.
  chunks.push({ type: 'finish', reason: { kind: (response.toolCalls ?? []).length > 0 ? 'tool-calls' : 'stop' } });
  return chunks;
}

/** DSH's own record of the live turn (events after the seed), for the cross-check against the IR record. */
export interface DshTurnView {
  /** Steps DSH entered in the live turn (`step/start` events; one Hypertest turn must be exactly one step). */
  steps: number;
  /** Tool calls of DSH's assembled response, in order (names unescaped). */
  calls: Array<{ id: string; name: string; arguments: string }>;
  /** Tool results DSH committed, in order. */
  results: Array<{ toolCallId: string; content: string; isError: boolean }>;
  /** How DSH closed the live turn (`turn/end` reason kind). */
  end?: string;
  /** Compact event trace (diagnostics). */
  trace: string[];
}

export function viewOfTurn(events: readonly SessionEvent[], fromSeq: number): DshTurnView {
  const view: DshTurnView = { steps: 0, calls: [], results: [], trace: [] };
  let chunks = 0;
  const flushChunks = (): void => {
    if (chunks > 0) view.trace.push(`assistant/chunk×${chunks}`);
    chunks = 0;
  };
  for (const e of events) {
    if (e.seq < fromSeq) continue;
    if (e.type === 'assistant/chunk') {
      chunks += 1;
      continue;
    }
    flushChunks();
    switch (e.type) {
      case 'step/start':
        view.steps += 1;
        view.trace.push(e.type);
        break;
      case 'assistant/message':
        for (const b of e.data.message.content) if (b.type === 'tool-call') view.calls.push({ id: b.id, name: fromDshToolName(b.name), arguments: b.arguments });
        view.trace.push(e.type);
        break;
      case 'tool/call':
        view.trace.push(`${e.type}:${e.data.callId}`);
        break;
      case 'tool/result': {
        const block = e.data.message.content[0];
        const content = block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
        view.results.push({ toolCallId: block.toolCallId, content, isError: block.isError === true });
        view.trace.push(`${e.type}:${block.toolCallId}${block.isError === true ? ':error' : ''}`);
        break;
      }
      case 'turn/end':
        view.end = e.data.reason.kind;
        view.trace.push(`${e.type}:${e.data.reason.kind}`);
        break;
      default:
        view.trace.push(e.type);
    }
  }
  flushChunks();
  return view;
}
