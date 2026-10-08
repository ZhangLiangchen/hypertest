import { HypertestError, type JsonSchema, type JsonValue } from '@hypertest/core';
import { projectForRoute, type AssistantMessage, type ChatMessage, type ContentPart, type ToolCall } from '@hypertest/domain';
import type { AnthropicProviderOptions, ModelCallRequest, ModelCallResponse, ModelProvider, ModelUsage, ProviderAvailability, StopReason, StreamDelta } from './contracts.ts';
import { credentialAvailability, missingCredentialError, providerFault, secretsOf, type ProviderErrorCode } from './errors.ts';
import { ToolNameMap } from './tool-names.ts';
import { DEFAULT_TIMEOUT_MS, guardDelta, isEventStream, monoMs, normalizeTransportError, parseJsonPayload, postJson, readSse, withDeadline } from './transport.ts';
import { estimatedUsage, nonNegInt } from './usage.ts';
import { MODEL_PACKAGE_NAME, MODEL_PACKAGE_VERSION } from './version.ts';

type Json = Record<string, unknown>;

/** Reserved tool used to emulate `responseFormat` (forced tool call whose input is the structured answer). */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'stream']);

/** Continuation class of Anthropic opaque thinking blocks. */
export function anthropicCompatibilityClass(model: string): string {
  return `anthropic:${model}`;
}

/**
 * Anthropic Messages API provider (fetch + SSE). Thinking blocks become `reasoning.text` plus
 * `reasoning.opaque` (`anthropic:<model>`), and are replayed only to the same continuation class.
 * Extended thinking is configured through the route profile `extra` (e.g. `{ "thinking": { "type":
 * "enabled", "budget_tokens": 4096 } }`); `reasoningEffort` is not mapped implicitly.
 */
export class AnthropicProvider implements ModelProvider {
  readonly providerId: string;
  readonly adapterInfo = { package: `${MODEL_PACKAGE_NAME}#anthropic`, version: MODEL_PACKAGE_VERSION };
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #version: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #defaultMaxTokens: number;
  readonly #fetch: typeof fetch;
  readonly #credential: ProviderAvailability;

  constructor(options: AnthropicProviderOptions = {}) {
    this.providerId = options.providerId ?? 'anthropic';
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#version = options.version ?? '2023-06-01';
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#credential = credentialAvailability(this.providerId, options.requireApiKey, options.apiKey, options.apiKeySource);
  }

  /** Unavailable when a required API key is missing (the router never routes to it; complete() refuses locally). */
  availability(): ProviderAvailability {
    return this.#credential;
  }

  async complete(request: ModelCallRequest, options: { onDelta?: (d: StreamDelta) => void } = {}): Promise<ModelCallResponse> {
    if (!this.#credential.ok) throw missingCredentialError(this.providerId, this.#credential.reason);
    const started = monoMs();
    const names = new ToolNameMap();
    const { body, structured } = buildAnthropicBody(request, names, this.#defaultMaxTokens);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream, application/json', 'anthropic-version': this.#version };
    if (this.#apiKey) headers['x-api-key'] = this.#apiKey;
    Object.assign(headers, this.#headers);
    const secrets = secretsOf(this.#apiKey, this.#headers);
    const provider = this.providerId;
    return withDeadline(
      { timeoutMs: request.timeoutMs ?? this.#timeoutMs, signal: request.signal, what: `${provider} ${request.model}`, normalize: normalizeTransportError(provider, secrets) },
      async (signal) => {
        const res = await postJson(this.#fetch, `${this.#baseUrl}/v1/messages`, body, headers, signal, provider, secrets);
        const acc = new AnthropicAccumulator(provider, request.model, names, structured, guardDelta(options.onDelta));
        if (isEventStream(res)) {
          for await (const ev of readSse(res.body, provider)) {
            acc.applyEvent(parseJsonPayload(provider, ev.data));
            if (acc.stopped) break;
          }
          if (!acc.stopped && acc.stopReason === undefined) throw providerFault('unavailable', `${provider}: stream ended before message_stop`, { provider });
        } else {
          acc.applyMessage(parseJsonPayload(provider, await res.text()));
        }
        const { message, stopReason, usage, responseId } = acc.result(request);
        const out: ModelCallResponse = { message, stopReason, usage, latencyMs: Math.round(monoMs() - started) };
        if (responseId) out.providerResponseId = responseId;
        return out;
      },
    );
  }
}

// ----------------------------------------------------------------------------- request mapping

export interface StructuredMode {
  /** The schema was not an object schema and was wrapped as `{ value: schema }`. */
  wrapped: boolean;
}

export function buildAnthropicBody(request: ModelCallRequest, names: ToolNameMap, defaultMaxTokens: number): { body: Json; structured?: StructuredMode } {
  const compat = anthropicCompatibilityClass(request.model);
  const tools: Json[] = (request.tools ?? []).map((t) => ({ name: names.encode(t.name), description: t.description, input_schema: t.inputSchema }));
  let structured: StructuredMode | undefined;
  let toolChoice: Json | undefined = mapToolChoice(request.toolChoice, names);
  if (request.responseFormat) {
    if (tools.some((t) => t['name'] === STRUCTURED_OUTPUT_TOOL)) {
      throw new HypertestError('invalid_argument', `tool name ${STRUCTURED_OUTPUT_TOOL} is reserved when responseFormat is requested`);
    }
    const schema = request.responseFormat.schema;
    const wrapped = schema['type'] !== 'object';
    const inputSchema: JsonSchema = wrapped ? { type: 'object', properties: { value: schema }, required: ['value'] } : schema;
    const hasOtherTools = tools.length > 0 && request.toolChoice !== 'none';
    tools.push({ name: STRUCTURED_OUTPUT_TOOL, description: `Return the final answer (${request.responseFormat.name}) as structured JSON matching the input schema.`, input_schema: inputSchema });
    structured = { wrapped };
    if (!hasOtherTools) toolChoice = { type: 'tool', name: STRUCTURED_OUTPUT_TOOL };
    else if (request.toolChoice === undefined || request.toolChoice === 'auto' || request.toolChoice === 'required') toolChoice = { type: 'any' };
  }
  const { system, messages } = toAnthropicMessages(request.messages, compat, names);
  const body: Json = { model: request.model, max_tokens: request.maxOutputTokens ?? defaultMaxTokens, messages };
  if (system) body['system'] = system;
  if (tools.length > 0) body['tools'] = tools;
  if (toolChoice) body['tool_choice'] = toolChoice;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  body['stream'] = true;
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (PROTECTED_BODY_KEYS.has(k)) continue;
    if (v === null) delete body[k];
    else body[k] = v;
  }
  return structured ? { body, structured } : { body };
}

function mapToolChoice(choice: ModelCallRequest['toolChoice'], names: ToolNameMap): Json | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: names.encode(choice.name) };
}

interface AnthropicTurn {
  role: 'user' | 'assistant';
  content: Json[];
}

/**
 * system → top-level string; tool results → user `tool_result` blocks; consecutive same-role messages
 * merged (tool_result blocks first); opaque thinking replayed only for the matching class.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[], compatibilityClass: string, names: ToolNameMap): { system?: string; messages: AnthropicTurn[] } {
  const projected = projectForRoute(messages, compatibilityClass);
  const system: string[] = [];
  const turns: AnthropicTurn[] = [];
  const push = (role: 'user' | 'assistant', blocks: Json[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const m of projected) {
    switch (m.role) {
      case 'system':
        if (m.content) system.push(m.content);
        break;
      case 'user':
        push('user', typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : m.content.map(anthropicUserPart).filter((b): b is Json => b !== undefined));
        break;
      case 'assistant': {
        const blocks: Json[] = [];
        if (m.reasoning?.opaque && m.reasoning.opaque.compatibilityClass === compatibilityClass) blocks.push(...thinkingBlocks(m.reasoning.opaque.data));
        for (const p of m.content) if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        for (const c of m.toolCalls ?? []) {
          const input = c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments) ? c.arguments : {};
          blocks.push({ type: 'tool_use', id: c.id, name: names.encode(c.name), input });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool': {
        const block: Json = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        if (m.isError) block['is_error'] = true;
        push('user', [block]);
        break;
      }
    }
  }
  for (const t of turns) {
    if (t.role === 'user') t.content = [...t.content.filter((b) => b['type'] === 'tool_result'), ...t.content.filter((b) => b['type'] !== 'tool_result')];
  }
  const out: { system?: string; messages: AnthropicTurn[] } = { messages: turns };
  if (system.length > 0) out.system = system.join('\n\n');
  return out;
}

function anthropicUserPart(p: ContentPart): Json | undefined {
  if (p.type === 'text') return p.text ? { type: 'text', text: p.text } : undefined;
  if (p.dataBase64) return { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.dataBase64 } };
  if (p.artifactUri && /^https?:\/\//.test(p.artifactUri)) return { type: 'image', source: { type: 'url', url: p.artifactUri } };
  return { type: 'text', text: `[image ${p.mimeType}${p.artifactUri ? ` ${p.artifactUri}` : ''} not inlined]` };
}

/** Rebuilds Anthropic thinking / redacted_thinking blocks from opaque data (malformed entries dropped). */
function thinkingBlocks(data: JsonValue): Json[] {
  if (!Array.isArray(data)) return [];
  const out: Json[] = [];
  for (const b of data) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (b['type'] === 'thinking' && typeof b['thinking'] === 'string' && typeof b['signature'] === 'string') {
      out.push({ type: 'thinking', thinking: b['thinking'], signature: b['signature'] });
    } else if (b['type'] === 'redacted_thinking' && typeof b['data'] === 'string') {
      out.push({ type: 'redacted_thinking', data: b['data'] });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- response mapping

type BlockState =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string; input?: unknown }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'other' };

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export class AnthropicAccumulator {
  stopReason: string | undefined;
  stopped = false;
  readonly #blocks = new Map<number, BlockState>();
  #responseId: string | undefined;
  #usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, seen: false };
  readonly #provider: string;
  readonly #model: string;
  readonly #names: ToolNameMap;
  readonly #structured: StructuredMode | undefined;
  readonly #onDelta: ((d: StreamDelta) => void) | undefined;

  constructor(provider: string, model: string, names: ToolNameMap, structured: StructuredMode | undefined, onDelta?: (d: StreamDelta) => void) {
    this.#provider = provider;
    this.#model = model;
    this.#names = names;
    this.#structured = structured;
    this.#onDelta = onDelta;
  }

  applyEvent(raw: unknown): void {
    const ev = obj(raw);
    if (!ev) throw new HypertestError('provider_error', `${this.#provider}: stream event is not an object`, { retryable: false });
    switch (ev['type']) {
      case 'message_start': {
        const msg = obj(ev['message']) ?? {};
        this.#responseId = str(msg['id']);
        this.#applyUsage(msg['usage']);
        break;
      }
      case 'content_block_start': {
        const index = typeof ev['index'] === 'number' ? ev['index'] : this.#blocks.size;
        this.#blocks.set(index, this.#startBlock(obj(ev['content_block']) ?? {}));
        break;
      }
      case 'content_block_delta': {
        const index = typeof ev['index'] === 'number' ? ev['index'] : -1;
        const block = this.#blocks.get(index);
        const delta = obj(ev['delta']) ?? {};
        if (!block) throw new HypertestError('provider_error', `${this.#provider}: delta for unknown content block ${index}`, { retryable: false });
        this.#applyDelta(block, delta);
        break;
      }
      case 'message_delta': {
        const d = obj(ev['delta']) ?? {};
        const reason = str(d['stop_reason']);
        if (reason) this.stopReason = reason;
        this.#applyUsage(ev['usage']);
        break;
      }
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error':
        throw anthropicError(this.#provider, ev['error']);
      default:
        break; // ping, content_block_stop, unknown future events
    }
  }

  #startBlock(cb: Json): BlockState {
    switch (cb['type']) {
      case 'text': {
        const text = str(cb['text']) ?? '';
        if (text) this.#onDelta?.({ type: 'text', text });
        return { type: 'text', text };
      }
      case 'tool_use': {
        const id = str(cb['id']) ?? `toolu_${this.#blocks.size}`;
        const name = str(cb['name']) ?? '';
        const input = cb['input'];
        const state: BlockState = { type: 'tool_use', id, name, json: '' };
        if (input && typeof input === 'object' && Object.keys(input).length > 0) state.input = input;
        if (!this.#isStructured(name)) this.#onDelta?.({ type: 'tool_call_start', id, name: this.#names.decode(name) });
        return state;
      }
      case 'thinking': {
        const thinking = str(cb['thinking']) ?? '';
        if (thinking) this.#onDelta?.({ type: 'reasoning', text: thinking });
        return { type: 'thinking', thinking, signature: str(cb['signature']) ?? '' };
      }
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: str(cb['data']) ?? '' };
      default:
        return { type: 'other' };
    }
  }

  #applyDelta(block: BlockState, delta: Json): void {
    switch (delta['type']) {
      case 'text_delta':
        if (block.type === 'text') {
          const t = str(delta['text']) ?? '';
          block.text += t;
          if (t) this.#onDelta?.({ type: 'text', text: t });
        }
        break;
      case 'input_json_delta':
        if (block.type === 'tool_use') {
          const t = str(delta['partial_json']) ?? '';
          block.json += t;
          if (t) this.#onDelta?.(this.#isStructured(block.name) ? { type: 'text', text: t } : { type: 'tool_call_args', id: block.id, text: t });
        }
        break;
      case 'thinking_delta':
        if (block.type === 'thinking') {
          const t = str(delta['thinking']) ?? '';
          block.thinking += t;
          if (t) this.#onDelta?.({ type: 'reasoning', text: t });
        }
        break;
      case 'signature_delta':
        if (block.type === 'thinking') block.signature += str(delta['signature']) ?? '';
        break;
      default:
        break;
    }
  }

  #isStructured(wireName: string): boolean {
    return this.#structured !== undefined && wireName === STRUCTURED_OUTPUT_TOOL;
  }

  #applyUsage(raw: unknown): void {
    const u = obj(raw);
    if (!u) return;
    const input = nonNegInt(u['input_tokens']);
    const output = nonNegInt(u['output_tokens']);
    const cacheRead = nonNegInt(u['cache_read_input_tokens']);
    const cacheCreation = nonNegInt(u['cache_creation_input_tokens']);
    // message_delta usage is cumulative; later values replace earlier ones.
    if (input !== undefined) this.#usage.input = input;
    if (output !== undefined) this.#usage.output = output;
    if (cacheRead !== undefined) this.#usage.cacheRead = cacheRead;
    if (cacheCreation !== undefined) this.#usage.cacheCreation = cacheCreation;
    if (input !== undefined || output !== undefined) this.#usage.seen = true;
  }

  /** Non-streaming `application/json` message. */
  applyMessage(raw: unknown): void {
    const msg = obj(raw);
    if (!msg) throw new HypertestError('provider_error', `${this.#provider}: response is not an object`, { retryable: false });
    if (msg['type'] === 'error') throw anthropicError(this.#provider, msg['error']);
    this.#responseId = str(msg['id']);
    const content = Array.isArray(msg['content']) ? msg['content'] : [];
    content.forEach((c, i) => {
      const cb = obj(c) ?? {};
      const state = this.#startBlock(cb);
      if (state.type === 'tool_use' && cb['input'] !== undefined) state.input = cb['input'];
      this.#blocks.set(i, state);
    });
    this.stopReason = str(msg['stop_reason']) ?? 'end_turn';
    this.#applyUsage(msg['usage']);
    this.stopped = true;
  }

  result(request: ModelCallRequest): { message: AssistantMessage; stopReason: StopReason; usage: ModelUsage; responseId?: string } {
    const message: AssistantMessage = { role: 'assistant', content: [] };
    const calls: ToolCall[] = [];
    const thinkingText: string[] = [];
    const opaque: JsonValue[] = [];
    let structuredEmitted = false;
    const blocks = [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    for (const b of blocks) {
      if (b.type === 'text' && b.text) message.content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') {
        if (b.thinking) thinkingText.push(b.thinking);
        opaque.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
      } else if (b.type === 'redacted_thinking') opaque.push({ type: 'redacted_thinking', data: b.data });
      else if (b.type === 'tool_use') {
        const call = parseToolInput(b, this.#names);
        if (this.#isStructured(b.name)) {
          let value: JsonValue = call.arguments;
          if (this.#structured?.wrapped && value && typeof value === 'object' && !Array.isArray(value)) value = (value as Record<string, JsonValue>)['value'] ?? null;
          message.content.push({ type: 'text', text: call.rawArguments ?? JSON.stringify(value) });
          structuredEmitted = true;
        } else calls.push(call);
      }
    }
    if (calls.length > 0) message.toolCalls = calls;
    if (thinkingText.length > 0 || opaque.length > 0) {
      const reasoning: NonNullable<AssistantMessage['reasoning']> = {};
      if (thinkingText.length > 0) reasoning.text = thinkingText.join('\n');
      if (opaque.length > 0) reasoning.opaque = { compatibilityClass: anthropicCompatibilityClass(this.#model), data: opaque };
      message.reasoning = reasoning;
    }
    const usage: ModelUsage = this.#usage.seen
      ? { inputTokens: this.#usage.input + this.#usage.cacheRead + this.#usage.cacheCreation, outputTokens: this.#usage.output, cachedInputTokens: this.#usage.cacheRead }
      : estimatedUsage(request.messages, request.tools, message);
    const out: { message: AssistantMessage; stopReason: StopReason; usage: ModelUsage; responseId?: string } = {
      message,
      stopReason: mapStopReason(this.stopReason, calls.length > 0, structuredEmitted),
      usage,
    };
    if (this.#responseId) out.responseId = this.#responseId;
    return out;
  }
}

function parseToolInput(b: Extract<BlockState, { type: 'tool_use' }>, names: ToolNameMap): ToolCall {
  const call: ToolCall = { id: b.id, name: names.decode(b.name), arguments: {} };
  if (b.json.trim() !== '') {
    try {
      call.arguments = JSON.parse(b.json) as JsonValue;
    } catch {
      call.rawArguments = b.json;
    }
  } else if (b.input !== undefined) call.arguments = b.input as JsonValue;
  return call;
}

export function mapStopReason(reason: string | undefined, hasToolCalls: boolean, structured: boolean): StopReason {
  switch (reason) {
    case 'tool_use':
      return hasToolCalls ? 'tool_use' : structured ? 'end_turn' : 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

const ERROR_TYPES: Record<string, ProviderErrorCode> = {
  rate_limit_error: 'rate_limited',
  overloaded_error: 'unavailable',
  api_error: 'unavailable',
  timeout_error: 'unavailable',
  invalid_request_error: 'provider_error',
  authentication_error: 'provider_error',
  permission_error: 'provider_error',
  not_found_error: 'provider_error',
  request_too_large: 'provider_error',
};

function anthropicError(provider: string, raw: unknown): HypertestError {
  const e = obj(raw) ?? {};
  const type = str(e['type']) ?? 'unknown_error';
  const code = (Object.hasOwn(ERROR_TYPES, type) ? ERROR_TYPES[type] : undefined) ?? 'unavailable';
  return providerFault(code, `${provider}: ${type}: ${(str(e['message']) ?? '').slice(0, 500)}`, { provider, errorType: type, inStream: true });
}
