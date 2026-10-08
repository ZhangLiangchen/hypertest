import { HypertestError, sha256Hex, type JsonValue } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, ContentPart, ToolCall } from '@hypertest/domain';
import type { ModelCallRequest, ModelCallResponse, ModelProvider, ModelUsage, OpenAICompatibleProviderOptions, ProviderAvailability, StopReason, StreamDelta } from './contracts.ts';
import { codeForHttpStatus, credentialAvailability, missingCredentialError, providerFault, secretsOf, type ProviderErrorCode } from './errors.ts';
import { ToolNameMap } from './tool-names.ts';
import { DEFAULT_TIMEOUT_MS, guardDelta, isEventStream, monoMs, normalizeTransportError, parseJsonPayload, postJson, readSse, withDeadline } from './transport.ts';
import { estimatedUsage, nonNegInt } from './usage.ts';
import { MODEL_PACKAGE_NAME, MODEL_PACKAGE_VERSION } from './version.ts';

type Json = Record<string, unknown>;

/** Body fields owned by Hypertest; profile `extra` may not override them. */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'response_format']);

/**
 * OpenAI chat.completions-compatible provider (OpenAI, DeepSeek, vLLM, llama.cpp, Ollama, OpenRouter …).
 * Streams with SSE (`stream_options.include_usage`), also accepts a plain JSON response. Tool names are
 * mapped `.`→`__` per request and mapped back exactly. Profile `extra` fields are merged into the body
 * (a `null` value deletes a default field, e.g. `{ "max_tokens": null, "max_completion_tokens": 8000 }`).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly providerId: string;
  readonly adapterInfo = { package: `${MODEL_PACKAGE_NAME}#openai-compatible`, version: MODEL_PACKAGE_VERSION };
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #credential: ProviderAvailability;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!options.providerId) throw new HypertestError('invalid_argument', 'OpenAICompatibleProvider: providerId is required');
    if (!options.baseUrl) throw new HypertestError('invalid_argument', 'OpenAICompatibleProvider: baseUrl is required');
    this.providerId = options.providerId;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const body = buildOpenAIBody(request, names);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
    if (this.#apiKey) headers['authorization'] = `Bearer ${this.#apiKey}`;
    Object.assign(headers, this.#headers);
    const secrets = secretsOf(this.#apiKey, this.#headers);
    const provider = this.providerId;
    return withDeadline(
      { timeoutMs: request.timeoutMs ?? this.#timeoutMs, signal: request.signal, what: `${provider} ${request.model}`, normalize: normalizeTransportError(provider, secrets) },
      async (signal) => {
        const res = await postJson(this.#fetch, `${this.#baseUrl}/chat/completions`, body, headers, signal, provider, secrets);
        const acc = new OpenAIAccumulator(provider, names, guardDelta(options.onDelta), toolCallIdSeed(request.messages));
        if (isEventStream(res)) {
          for await (const ev of readSse(res.body, provider)) {
            if (ev.data === '[DONE]') {
              acc.done = true;
              break;
            }
            acc.applyChunk(parseJsonPayload(provider, ev.data));
          }
          if (!acc.done && acc.finishReason === undefined) {
            throw providerFault('unavailable', `${provider}: stream ended before completion`, { provider });
          }
        } else {
          acc.applyJson(parseJsonPayload(provider, await res.text()));
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

export function buildOpenAIBody(request: ModelCallRequest, names: ToolNameMap): Json {
  const body: Json = { model: request.model };
  const tools = request.tools?.map((t) => ({ type: 'function', function: { name: names.encode(t.name), description: t.description, parameters: t.inputSchema } }));
  body['messages'] = toOpenAIMessages(request.messages, names);
  if (tools && tools.length > 0) body['tools'] = tools;
  if (request.toolChoice !== undefined) {
    body['tool_choice'] = typeof request.toolChoice === 'string' ? request.toolChoice : { type: 'function', function: { name: names.encode(request.toolChoice.name) } };
  }
  if (request.responseFormat) {
    body['response_format'] = { type: 'json_schema', json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } };
  }
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.reasoningEffort !== undefined) body['reasoning_effort'] = request.reasoningEffort;
  body['stream'] = true;
  body['stream_options'] = { include_usage: true };
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (PROTECTED_BODY_KEYS.has(k)) continue;
    if (v === null) delete body[k];
    else body[k] = v;
  }
  return body;
}

export function toOpenAIMessages(messages: readonly ChatMessage[], names: ToolNameMap): Json[] {
  return messages.map((m): Json => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(openAIUserPart) };
      case 'assistant': {
        const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
        const hasCalls = !!m.toolCalls && m.toolCalls.length > 0;
        // `null` content is only valid next to tool_calls; a bare empty assistant turn needs ''.
        const out: Json = { role: 'assistant', content: text.length > 0 ? text : hasCalls ? null : '' };
        if (m.toolCalls && hasCalls) {
          out['tool_calls'] = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: names.encode(c.name), arguments: JSON.stringify(c.arguments ?? {}) } }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `[tool error] ${m.content}` : m.content };
    }
  });
}

function openAIUserPart(p: ContentPart): Json {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.dataBase64) return { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` } };
  if (p.artifactUri && /^https?:\/\//.test(p.artifactUri)) return { type: 'image_url', image_url: { url: p.artifactUri } };
  return { type: 'text', text: `[image ${p.mimeType}${p.artifactUri ? ` ${p.artifactUri}` : ''} not inlined]` };
}

// ----------------------------------------------------------------------------- response mapping

interface ToolAcc {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export class OpenAIAccumulator {
  text = '';
  reasoning = '';
  finishReason: string | undefined;
  done = false;
  #usage: ModelUsage | undefined;
  #responseId: string | undefined;
  readonly #tools = new Map<number, ToolAcc>();
  readonly #provider: string;
  readonly #names: ToolNameMap;
  readonly #onDelta: ((d: StreamDelta) => void) | undefined;
  readonly #idSeed: string;

  /** `idSeed` makes generated tool-call ids (server sent none) unique per request/turn yet deterministic. */
  constructor(provider: string, names: ToolNameMap, onDelta?: (d: StreamDelta) => void, idSeed = '000000000000') {
    this.#provider = provider;
    this.#names = names;
    this.#onDelta = onDelta;
    this.#idSeed = idSeed;
  }

  applyChunk(raw: unknown): void {
    const chunk = obj(raw);
    if (!chunk) throw new HypertestError('provider_error', `${this.#provider}: stream chunk is not an object`, { retryable: false });
    if (chunk['error'] !== undefined && chunk['error'] !== null) throw this.#inStreamError(chunk['error']);
    this.#responseId ??= str(chunk['id']);
    const usage = mapOpenAIUsage(chunk['usage']);
    if (usage) this.#usage = usage;
    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    for (const c of choices) {
      const choice = obj(c);
      if (!choice) continue;
      if ((typeof choice['index'] === 'number' ? choice['index'] : 0) !== 0) continue;
      const delta = obj(choice['delta']) ?? {};
      const content = str(delta['content']);
      if (content) {
        this.text += content;
        this.#onDelta?.({ type: 'text', text: content });
      }
      const reasoning = str(delta['reasoning_content']) ?? str(delta['reasoning']);
      if (reasoning) {
        this.reasoning += reasoning;
        this.#onDelta?.({ type: 'reasoning', text: reasoning });
      }
      const toolCalls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
      toolCalls.forEach((t, position) => this.#applyToolDelta(obj(t) ?? {}, position));
      const finish = str(choice['finish_reason']);
      if (finish) this.finishReason = finish;
    }
  }

  #applyToolDelta(t: Json, position: number): void {
    const fn = obj(t['function']) ?? {};
    const id = str(t['id']) || undefined; // '' is as good as absent
    let index = typeof t['index'] === 'number' ? t['index'] : undefined;
    if (index === undefined && id !== undefined) for (const [i, acc] of this.#tools) if (acc.id === id) index = i;
    if (index === undefined) index = id !== undefined ? (this.#tools.size === 0 ? 0 : Math.max(...this.#tools.keys()) + 1) : position;
    let acc = this.#tools.get(index);
    if (!acc) {
      acc = { id: id ?? `call_${this.#idSeed}_${index}`, name: '', args: '', started: false };
      this.#tools.set(index, acc);
    } else if (id && !acc.started) acc.id = id;
    const name = str(fn['name']);
    // Names arrive once (some servers repeat them on every chunk; never append after the call started).
    if (name && !acc.started) acc.name += name;
    if (!acc.started && acc.name) {
      acc.started = true;
      this.#onDelta?.({ type: 'tool_call_start', id: acc.id, name: this.#names.decode(acc.name) });
    }
    const args = str(fn['arguments']);
    if (args) {
      acc.args += args;
      this.#onDelta?.({ type: 'tool_call_args', id: acc.id, text: args });
    }
  }

  /** Non-streaming `application/json` completion. */
  applyJson(raw: unknown): void {
    const body = obj(raw);
    if (!body) throw new HypertestError('provider_error', `${this.#provider}: response is not an object`, { retryable: false });
    if (body['error'] !== undefined && body['error'] !== null) throw this.#inStreamError(body['error']);
    this.#responseId = str(body['id']);
    const usage = mapOpenAIUsage(body['usage']);
    if (usage) this.#usage = usage;
    const choice = obj(Array.isArray(body['choices']) ? body['choices'][0] : undefined);
    if (!choice) throw new HypertestError('provider_error', `${this.#provider}: response has no choices`, { retryable: false });
    const message = obj(choice['message']) ?? {};
    const content = message['content'];
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => str(obj(p)?.['text']) ?? '').join('') : '';
    if (text) {
      this.text = text;
      this.#onDelta?.({ type: 'text', text });
    }
    const reasoning = str(message['reasoning_content']) ?? str(message['reasoning']);
    if (reasoning) this.reasoning = reasoning;
    const toolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
    toolCalls.forEach((t, i) => {
      const tc = obj(t) ?? {};
      const fn = obj(tc['function']) ?? {};
      const argsRaw = fn['arguments'];
      this.#applyToolDelta({ index: i, id: tc['id'], function: { name: fn['name'], arguments: typeof argsRaw === 'string' ? argsRaw : argsRaw === undefined ? '' : JSON.stringify(argsRaw) } }, i);
    });
    this.finishReason = str(choice['finish_reason']) ?? 'stop';
    this.done = true;
  }

  result(request: ModelCallRequest): { message: AssistantMessage; stopReason: StopReason; usage: ModelUsage; responseId?: string } {
    const message: AssistantMessage = { role: 'assistant', content: this.text ? [{ type: 'text', text: this.text }] : [] };
    const calls = [...this.#tools.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => toToolCall(acc, this.#names));
    if (calls.length > 0) message.toolCalls = calls;
    if (this.reasoning) message.reasoning = { text: this.reasoning };
    const out: { message: AssistantMessage; stopReason: StopReason; usage: ModelUsage; responseId?: string } = {
      message,
      stopReason: mapFinishReason(this.finishReason, calls.length > 0),
      usage: this.#usage ?? estimatedUsage(request.messages, request.tools, message),
    };
    if (this.#responseId) out.responseId = this.#responseId;
    return out;
  }

  #inStreamError(e: unknown): HypertestError {
    const err = obj(e) ?? {};
    const message = str(err['message']) ?? (typeof e === 'string' ? e : 'provider error');
    const code = classifyInStreamError(err);
    return providerFault(code, `${this.#provider}: ${message.slice(0, 500)}`, { provider: this.#provider, inStream: true });
  }
}

const BAD_REQUEST_HINTS = ['invalid', 'bad_request', 'badrequest', 'context_length', 'authentication', 'permission', 'not_found', 'notfound', 'unprocessable'];

/**
 * Error objects inside a 200 stream/body. A numeric (HTTP-like) `code`/`status` wins (vLLM sends `code: 400`);
 * otherwise type/code keywords. A request the server rejected must never look retryable (it would be retried and
 * then masked by a fallback model); unknown errors are treated as availability faults.
 */
export function classifyInStreamError(err: Record<string, unknown>): ProviderErrorCode {
  for (const k of ['code', 'status']) {
    const v = err[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) ? Number(v) : undefined;
    if (n !== undefined && n >= 400 && n <= 599) return codeForHttpStatus(n);
  }
  const kind = `${str(err['type']) ?? ''} ${String(err['code'] ?? '')}`.toLowerCase();
  if (kind.includes('rate') || kind.includes('quota')) return 'rate_limited';
  if (BAD_REQUEST_HINTS.some((h) => kind.includes(h))) return 'provider_error';
  return 'unavailable';
}

/**
 * Seed for tool-call ids a server did not provide: derived from the conversation so far, so ids differ on every
 * turn (a static `call_0` would repeat across the conversation) but are reproducible for the same request.
 */
export function toolCallIdSeed(messages: readonly ChatMessage[]): string {
  return sha256Hex(JSON.stringify(messages)).slice(0, 12);
}

function toToolCall(acc: ToolAcc, names: ToolNameMap): ToolCall {
  const call: ToolCall = { id: acc.id, name: names.decode(acc.name), arguments: {} };
  if (acc.args.trim() === '') return call;
  try {
    call.arguments = JSON.parse(acc.args) as JsonValue;
  } catch {
    call.rawArguments = acc.args;
  }
  return call;
}

export function mapFinishReason(finish: string | undefined, hasToolCalls: boolean): StopReason {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

export function mapOpenAIUsage(raw: unknown): ModelUsage | undefined {
  const u = obj(raw);
  if (!u) return undefined;
  const usage: ModelUsage = {
    inputTokens: nonNegInt(u['prompt_tokens']) ?? 0,
    outputTokens: nonNegInt(u['completion_tokens']) ?? 0,
    cachedInputTokens: nonNegInt(obj(u['prompt_tokens_details'])?.['cached_tokens']) ?? nonNegInt(u['prompt_cache_hit_tokens']) ?? 0,
  };
  const reasoning = nonNegInt(obj(u['completion_tokens_details'])?.['reasoning_tokens']);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}
