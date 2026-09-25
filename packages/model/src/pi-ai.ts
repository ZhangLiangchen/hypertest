import { readFileSync } from 'node:fs';
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, ContentPart, ToolCall } from '@hypertest/domain';
import {
  normalizeContext,
  type Api as PiApi,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type ImageContent as PiImageContent,
  type Message as PiMessage,
  type Model as PiModel,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TextContent as PiTextContent,
  type ThinkingContent as PiThinkingContent,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
  type TSchema,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy';
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy';
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { ModelCallRequest, ModelCallResponse, ModelProvider, ModelUsage, PiAiModelDefinition, PiAiProviderOptions, StopReason, StreamDelta } from './contracts.ts';
import { httpStatusError, providerFault, scrubSecrets, secretsOf } from './errors.ts';
import { ToolNameMap } from './tool-names.ts';
import { DEFAULT_TIMEOUT_MS, guardDelta, monoMs, normalizeTransportError, withDeadline } from './transport.ts';
import { estimatedUsage } from './usage.ts';

/**
 * Stream implementations by pi-ai API id. Dispatching on `model.api` directly (instead of pi-ai's
 * `Models`/credential machinery) keeps auth explicit: pi-ai never reads API keys from the environment
 * on our behalf, so a key can only reach the endpoint it was configured for.
 */
const PI_APIS: Record<string, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'azure-openai-responses': azureOpenAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
  'google-vertex': googleVertexApi,
  'mistral-conversations': mistralConversationsApi,
  'bedrock-converse-stream': bedrockConverseStreamApi,
};

function piAiVersion(): string {
  try {
    const entry = new URL(import.meta.resolve('@earendil-works/pi-ai'));
    const pkg = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Continuation class for pi-ai opaque reasoning (thinking signatures are model-specific). */
export function piCompatibilityClass(model: Pick<PiModel<PiApi>, 'api' | 'provider' | 'id'>): string {
  return `pi-ai:${model.api}:${model.provider}:${model.id}`;
}

type BuiltinModule = { getBuiltinModels(provider: string): Array<PiModel<PiApi>> };
let builtins: Promise<BuiltinModule> | undefined;
function loadBuiltins(): Promise<BuiltinModule> {
  builtins ??= import('@earendil-works/pi-ai/providers/all') as unknown as Promise<BuiltinModule>;
  return builtins;
}

/**
 * Adapter over @earendil-works/pi-ai for the long tail of providers. Models are resolved from custom
 * definitions, then pi-ai's built-in catalog (`piProvider`), then — when `baseUrl` is set — synthesized
 * with `defaultApi` (a local OpenAI-compatible server). Retries are disabled inside pi-ai; the router owns
 * retry/fallback. HTTP status is observed through an injected fetch so errors map to the shared taxonomy.
 */
export class PiAiProvider implements ModelProvider {
  readonly providerId: string;
  readonly adapterInfo = { package: '@earendil-works/pi-ai', version: piAiVersion() };
  readonly #piProvider: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #models: ReadonlyMap<string, PiAiModelDefinition>;
  readonly #defaultApi: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #apis = new Map<string, ProviderStreams>();

  constructor(options: PiAiProviderOptions) {
    if (!options.providerId || !options.piProvider) throw new HypertestError('invalid_argument', 'PiAiProvider: providerId and piProvider are required');
    this.providerId = options.providerId;
    this.#piProvider = options.piProvider;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl?.replace(/\/+$/, '');
    this.#headers = options.headers ?? {};
    this.#models = new Map((options.models ?? []).map((m) => [m.id, m]));
    this.#defaultApi = options.defaultApi ?? 'openai-completions';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Resolves the pi-ai model definition for a model id (custom → built-in catalog → synthesized). */
  async resolveModel(modelId: string): Promise<PiModel<PiApi>> {
    const custom = this.#models.get(modelId);
    if (custom) return this.#customModel(custom);
    const builtin = (await loadBuiltins()).getBuiltinModels(this.#piProvider).find((m) => m.id === modelId);
    if (builtin) {
      const m: PiModel<PiApi> = { ...builtin };
      if (this.#baseUrl) m.baseUrl = this.#baseUrl;
      return m;
    }
    if (this.#baseUrl) return this.#customModel({ id: modelId, api: this.#defaultApi });
    throw new HypertestError('invalid_argument', `pi-ai: model ${modelId} is not defined for provider ${this.#piProvider} (no custom definition, not in catalog, no baseUrl)`, {
      retryable: false,
      details: { piProvider: this.#piProvider, model: modelId },
    });
  }

  #customModel(d: PiAiModelDefinition): PiModel<PiApi> {
    const baseUrl = d.baseUrl ?? this.#baseUrl;
    if (!baseUrl) throw new HypertestError('invalid_argument', `pi-ai: model ${d.id} needs a baseUrl`, { retryable: false });
    const model: PiModel<PiApi> = {
      id: d.id,
      name: d.id,
      api: d.api,
      provider: this.#piProvider,
      baseUrl,
      reasoning: d.reasoning ?? false,
      input: d.input ?? ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: d.contextWindow ?? 128_000,
      maxTokens: d.maxTokens ?? 8192,
    };
    if (d.headers) model.headers = d.headers;
    const compat = d.compat ?? (d.api === 'openai-completions' ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsStrictMode: false } : undefined);
    if (compat) (model as { compat?: unknown }).compat = compat;
    return model;
  }

  #api(api: string): ProviderStreams {
    let impl = this.#apis.get(api);
    if (!impl) {
      const factory = Object.hasOwn(PI_APIS, api) ? PI_APIS[api] : undefined;
      if (!factory) throw new HypertestError('unsupported', `pi-ai: API ${api} is not supported by PiAiProvider`, { retryable: false });
      impl = factory();
      this.#apis.set(api, impl);
    }
    return impl;
  }

  async complete(request: ModelCallRequest, options: { onDelta?: (d: StreamDelta) => void } = {}): Promise<ModelCallResponse> {
    const started = monoMs();
    const model = await this.resolveModel(request.model);
    const api = this.#api(model.api);
    const names = new ToolNameMap();
    const compatClass = piCompatibilityClass(model);
    const context = toPiContext(request, model, names);
    const secrets = secretsOf(this.#apiKey, this.#headers);
    const http: { status?: number; retryAfter?: string | null; body?: string } = {};
    const baseFetch = this.#fetch;
    const observedFetch: typeof fetch = async (input, init) => {
      // Never follow redirects with credentials attached (same policy as the native providers).
      const res = await baseFetch(input, { ...init, redirect: 'error' });
      http.status = res.status;
      http.retryAfter = res.headers.get('retry-after');
      return res;
    };
    const onDelta = guardDelta(options.onDelta);
    const what = `${this.providerId} ${request.model}`;
    return withDeadline({ timeoutMs: request.timeoutMs ?? this.#timeoutMs, signal: request.signal, what, normalize: normalizeTransportError(this.providerId, secrets) }, async (signal) => {
      const opts: SimpleStreamOptions = { signal, maxRetries: 0, fetch: observedFetch };
      // Keyless local servers still need a bearer value for pi-ai's OpenAI client.
      const apiKey = this.#apiKey ?? (model.api === 'openai-completions' && this.#baseUrl ? 'no-key' : undefined);
      if (apiKey !== undefined) opts.apiKey = apiKey;
      if (Object.keys(this.#headers).length > 0) opts.headers = this.#headers;
      if (request.temperature !== undefined) opts.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) opts.maxTokens = request.maxOutputTokens;
      if (request.reasoningEffort !== undefined) opts.reasoning = request.reasoningEffort;
      if (request.extra) {
        // `null` means "remove a default field" for native providers; pi-ai cannot delete fields, so drop them.
        const sampling = Object.fromEntries(Object.entries(request.extra).filter(([, v]) => v !== null));
        if (Object.keys(sampling).length > 0) opts.samplingParams = sampling;
      }
      if (request.toolChoice === 'auto' || request.toolChoice === 'none') opts.toolChoice = request.toolChoice;
      if ((request.toolChoice !== undefined && typeof request.toolChoice !== 'string') || request.toolChoice === 'required' || request.responseFormat) {
        opts.onPayload = (payload) => patchPayload(model.api, payload, request, names);
      }
      let final: PiAssistantMessage | undefined;
      let failure: PiAssistantMessage | undefined;
      const stream = api.streamSimple(model, normalizeContext(context), opts);
      for await (const ev of stream) {
        switch (ev.type) {
          case 'text_delta':
            if (ev.delta) onDelta?.({ type: 'text', text: ev.delta });
            break;
          case 'thinking_delta':
            if (ev.delta) onDelta?.({ type: 'reasoning', text: ev.delta });
            break;
          case 'toolcall_start': {
            const block = ev.partial.content[ev.contentIndex];
            if (block?.type === 'toolCall') onDelta?.({ type: 'tool_call_start', id: block.id, name: names.decode(block.name) });
            break;
          }
          case 'toolcall_delta': {
            const block = ev.partial.content[ev.contentIndex];
            if (block?.type === 'toolCall' && ev.delta) onDelta?.({ type: 'tool_call_args', id: block.id, text: ev.delta });
            break;
          }
          case 'done':
            final = ev.message;
            break;
          case 'error':
            failure = ev.error;
            break;
          default:
            break;
        }
      }
      if (failure || !final) throw this.#mapFailure(failure, http, secrets);
      const { message, stopReason } = fromPiAssistant(final, names, compatClass);
      const usage = mapPiUsage(final.usage) ?? estimatedUsage(request.messages, request.tools, message);
      const out: ModelCallResponse = { message, stopReason, usage, latencyMs: Math.round(monoMs() - started) };
      if (final.responseId) out.providerResponseId = final.responseId;
      return out;
    });
  }

  #mapFailure(failure: PiAssistantMessage | undefined, http: { status?: number; retryAfter?: string | null }, secrets: ReadonlyArray<string | undefined>): HypertestError {
    const msg = scrubSecrets(failure?.errorMessage ?? 'pi-ai stream ended without a result', secrets);
    if (http.status !== undefined && (http.status < 200 || http.status >= 300)) return httpStatusError(this.providerId, http.status, msg, secrets, http.retryAfter);
    if (/no api key/i.test(msg)) return new HypertestError('provider_error', `${this.providerId}: ${msg}`, { retryable: false, details: { provider: this.providerId } });
    return providerFault('unavailable', `${this.providerId}: ${msg.slice(0, 500)}`, { provider: this.providerId, status: http.status ?? null });
  }
}

// ----------------------------------------------------------------------------- IR → pi-ai

interface PiOpaque {
  blocks: Array<{ thinking: string; signature?: string; redacted?: boolean }>;
  toolSignatures?: Record<string, string>;
}

const ZERO_USAGE: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Maps the Hypertest IR to a pi-ai Context for `model`; opaque thinking is replayed only for the same class. */
export function toPiContext(request: Pick<ModelCallRequest, 'messages' | 'tools' | 'responseFormat'>, model: PiModel<PiApi>, names: ToolNameMap): PiContext {
  const compatClass = piCompatibilityClass(model);
  const tools: PiTool[] = (request.tools ?? []).map((t) => ({ name: names.encode(t.name), description: t.description, parameters: t.inputSchema as unknown as TSchema }));
  const messages: PiMessage[] = [];
  let systemPrompt: string | undefined;
  request.messages.forEach((m: ChatMessage, i) => {
    const timestamp = i;
    switch (m.role) {
      case 'system':
        if (i === 0) systemPrompt = m.content;
        else messages.push({ role: 'system', content: m.content, timestamp });
        break;
      case 'user':
        messages.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(piUserPart), timestamp });
        break;
      case 'assistant': {
        const content: PiAssistantMessage['content'] = [];
        const opaque = m.reasoning?.opaque && m.reasoning.opaque.compatibilityClass === compatClass ? sanitizeOpaque(m.reasoning.opaque.data) : undefined;
        for (const b of opaque?.blocks ?? []) {
          const block: PiThinkingContent = { type: 'thinking', thinking: b.thinking };
          if (b.signature !== undefined) block.thinkingSignature = b.signature;
          if (b.redacted) block.redacted = true;
          content.push(block);
        }
        for (const p of m.content) if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        for (const c of m.toolCalls ?? []) {
          const call: PiToolCall = { type: 'toolCall', id: c.id, name: names.encode(c.name), arguments: isObject(c.arguments) ? (c.arguments as PiToolCall['arguments']) : {} };
          const sig = opaque?.toolSignatures && Object.hasOwn(opaque.toolSignatures, c.id) ? opaque.toolSignatures[c.id] : undefined;
          if (sig !== undefined) call.thoughtSignature = sig;
          content.push(call);
        }
        const same = opaque !== undefined;
        messages.push({
          role: 'assistant',
          content,
          api: same ? model.api : 'hypertest',
          provider: same ? model.provider : 'hypertest',
          model: same ? model.id : 'portable-history',
          usage: ZERO_USAGE,
          stopReason: m.toolCalls?.length ? 'toolUse' : 'stop',
          timestamp,
        });
        break;
      }
      case 'tool':
        messages.push({ role: 'toolResult', toolCallId: m.toolCallId, toolName: names.encode(m.toolName), content: [{ type: 'text', text: m.content }], isError: m.isError === true, timestamp });
        break;
    }
  });
  if (request.responseFormat && !NATIVE_STRUCTURED.has(model.api)) {
    const instruction = `Respond ONLY with a JSON value (no prose, no code fences) that validates against this JSON Schema (${request.responseFormat.name}):\n${JSON.stringify(request.responseFormat.schema)}`;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
  }
  const ctx: PiContext = { messages };
  if (systemPrompt !== undefined) ctx.systemPrompt = systemPrompt;
  if (tools.length > 0) ctx.tools = tools;
  return ctx;
}

/** Opaque data comes back from session storage: keep only well-formed entries (malformed ones are dropped). */
function sanitizeOpaque(data: JsonValue): PiOpaque {
  const out: PiOpaque = { blocks: [] };
  if (!isObject(data)) return out;
  const d = data as Record<string, JsonValue>;
  if (Array.isArray(d['blocks'])) {
    for (const b of d['blocks']) {
      if (!isObject(b)) continue;
      const x = b as Record<string, JsonValue>;
      if (typeof x['thinking'] !== 'string') continue;
      const block: PiOpaque['blocks'][number] = { thinking: x['thinking'] };
      if (typeof x['signature'] === 'string') block.signature = x['signature'];
      if (x['redacted'] === true) block.redacted = true;
      out.blocks.push(block);
    }
  }
  if (isObject(d['toolSignatures'])) {
    for (const [id, sig] of Object.entries(d['toolSignatures'] as Record<string, JsonValue>)) {
      if (typeof sig === 'string') (out.toolSignatures ??= {})[id] = sig;
    }
  }
  return out;
}

const NATIVE_STRUCTURED = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses']);

function piUserPart(p: ContentPart): PiTextContent | PiImageContent {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.dataBase64) return { type: 'image', data: p.dataBase64, mimeType: p.mimeType };
  return { type: 'text', text: `[image ${p.mimeType}${p.artifactUri ? ` ${p.artifactUri}` : ''} not inlined]` };
}

function isObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Applies tool_choice / response_format that pi-ai's simple options cannot express, per wire API. */
function patchPayload(api: string, payload: unknown, request: ModelCallRequest, names: ToolNameMap): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const choice = request.toolChoice;
  if (api === 'openai-completions') {
    if (choice === 'required') p['tool_choice'] = 'required';
    else if (choice && typeof choice === 'object') p['tool_choice'] = { type: 'function', function: { name: names.encode(choice.name) } };
    if (request.responseFormat) p['response_format'] = { type: 'json_schema', json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } };
  } else if (api === 'openai-responses' || api === 'azure-openai-responses') {
    if (choice === 'required') p['tool_choice'] = 'required';
    else if (choice && typeof choice === 'object') p['tool_choice'] = { type: 'function', name: names.encode(choice.name) };
    if (request.responseFormat) p['text'] = { format: { type: 'json_schema', name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } };
  } else if (api === 'anthropic-messages') {
    if (choice === 'required') p['tool_choice'] = { type: 'any' };
    else if (choice && typeof choice === 'object') p['tool_choice'] = { type: 'tool', name: names.encode(choice.name) };
  }
  return p;
}

// ----------------------------------------------------------------------------- pi-ai → IR

/** Maps a pi-ai AssistantMessage back to the IR (names decoded, thinking → reasoning (+opaque when signed)). */
export function fromPiAssistant(msg: PiAssistantMessage, names: ToolNameMap, compatibilityClass: string): { message: AssistantMessage; stopReason: StopReason } {
  const message: AssistantMessage = { role: 'assistant', content: [] };
  const calls: ToolCall[] = [];
  const thinking: string[] = [];
  const opaque: PiOpaque = { blocks: [] };
  for (const block of msg.content) {
    if (block.type === 'text') {
      if (block.text) message.content.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      if (block.thinking) thinking.push(block.thinking);
      if (block.thinkingSignature !== undefined || block.redacted) {
        const b: PiOpaque['blocks'][number] = { thinking: block.thinking };
        if (block.thinkingSignature !== undefined) b.signature = block.thinkingSignature;
        if (block.redacted) b.redacted = true;
        opaque.blocks.push(b);
      }
    } else if (block.type === 'toolCall') {
      calls.push({ id: block.id, name: names.decode(block.name), arguments: (block.arguments ?? {}) as JsonValue });
      if (block.thoughtSignature !== undefined) (opaque.toolSignatures ??= {})[block.id] = block.thoughtSignature;
    }
  }
  if (calls.length > 0) message.toolCalls = calls;
  if (thinking.length > 0 || opaque.blocks.length > 0 || opaque.toolSignatures) {
    const reasoning: NonNullable<AssistantMessage['reasoning']> = {};
    if (thinking.length > 0) reasoning.text = thinking.join('\n');
    if (opaque.blocks.length > 0 || opaque.toolSignatures) reasoning.opaque = { compatibilityClass, data: opaque as unknown as JsonValue };
    message.reasoning = reasoning;
  }
  return { message, stopReason: mapPiStopReason(msg.stopReason, calls.length > 0) };
}

export function mapPiStopReason(reason: PiAssistantMessage['stopReason'], hasToolCalls: boolean): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'toolUse':
      return 'tool_use';
    case 'aborted':
      return 'aborted';
    case 'error':
      return 'error';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

/** pi-ai `input` excludes cache reads/writes; the IR's inputTokens includes them (OpenAI convention). */
export function mapPiUsage(u: PiUsage | undefined): ModelUsage | undefined {
  if (!u || u.input + u.output + u.cacheRead + u.cacheWrite === 0) return undefined;
  const usage: ModelUsage = { inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output, cachedInputTokens: u.cacheRead };
  if (u.reasoning !== undefined) usage.reasoningTokens = u.reasoning;
  if (u.cost.total > 0) usage.costUsd = u.cost.total;
  return usage;
}
