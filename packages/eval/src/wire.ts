/**
 * (item 6, row 299 build) A scripted WIRE transport: a fake `fetch` that answers the real HTTP model adapters —
 * OpenAI-compatible chat completions (JSON or SSE), the Anthropic Messages API (JSON) and pi-ai's openai-completions
 * client (SSE) — from the same scripted brains the eval arms use. Each request is decoded from its wire format into the
 * neutral ModelCallRequest the brains read, the brain's reply is encoded back into that provider class's wire format,
 * and every exchange is logged (the ground truth the audit grader compares with L0). Nothing leaves the process: the
 * endpoints are `http://<provider>.wire.invalid/...` and only this fetch answers them.
 *
 * The live three-provider-class acceptance replaces this transport with the real providers (a separately budgeted
 * validation phase); this transport proves the arm, the adapters, the routing and the audit with no network.
 */
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { ChatMessage } from '@hypertest/domain';
import type { ModelCallRequest, ScriptedBrain, ScriptedReply } from '@hypertest/model';

/** The wire class a provider endpoint speaks. */
export type WireClass = 'openai-compatible' | 'anthropic' | 'pi-ai';

export interface WireEndpoint {
  /** The provider id of the route (the brains are keyed by it). */
  provider: string;
  wireClass: WireClass;
}

/** One exchange the transport answered. */
export interface WireCall {
  provider: string;
  wireClass: WireClass;
  role: string;
  /** HTTP status the transport answered with. */
  status: number;
  stream: boolean;
}

/** Host of a provider's fake endpoint. */
export function wireHost(provider: string): string {
  return `${provider}.wire.invalid`;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof obj(p)['text'] === 'string' ? (obj(p)['text'] as string) : '')).join('');
  return '';
}

function args(raw: unknown): JsonValue {
  if (typeof raw !== 'string') return (raw ?? {}) as JsonValue;
  try {
    return JSON.parse(raw === '' ? '{}' : raw) as JsonValue;
  } catch {
    return {};
  }
}

/** OpenAI chat messages → neutral messages (tool results get their tool name from the calls that requested them). */
export function fromOpenAIMessages(messages: unknown[]): ChatMessage[] {
  const names = new Map<string, string>();
  const out: ChatMessage[] = [];
  for (const raw of messages) {
    const m = obj(raw);
    switch (m['role']) {
      case 'system':
        out.push({ role: 'system', content: text(m['content']) });
        break;
      case 'user':
        out.push({ role: 'user', content: text(m['content']) });
        break;
      case 'assistant': {
        const calls = (Array.isArray(m['tool_calls']) ? m['tool_calls'] : []).map((c) => {
          const f = obj(obj(c)['function']);
          const id = String(obj(c)['id'] ?? '');
          names.set(id, String(f['name'] ?? ''));
          return { id, name: String(f['name'] ?? ''), arguments: args(f['arguments']) };
        });
        const t = text(m['content']);
        out.push({ role: 'assistant', content: t ? [{ type: 'text', text: t }] : [], ...(calls.length > 0 ? { toolCalls: calls } : {}) });
        break;
      }
      case 'tool': {
        const id = String(m['tool_call_id'] ?? '');
        const content = text(m['content']);
        const isError = content.startsWith('[tool error] ');
        out.push({ role: 'tool', toolCallId: id, toolName: names.get(id) ?? 'unknown', content: isError ? content.slice('[tool error] '.length) : content, isError });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Anthropic system + turns → neutral messages. */
export function fromAnthropicMessages(system: unknown, turns: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sys = text(system);
  if (sys) out.push({ role: 'system', content: sys });
  const names = new Map<string, string>();
  for (const raw of turns) {
    const t = obj(raw);
    const blocks = Array.isArray(t['content']) ? (t['content'] as unknown[]).map(obj) : [{ type: 'text', text: text(t['content']) }];
    if (t['role'] === 'assistant') {
      const calls = blocks.filter((b) => b['type'] === 'tool_use').map((b) => {
        names.set(String(b['id']), String(b['name']));
        return { id: String(b['id']), name: String(b['name']), arguments: (b['input'] ?? {}) as JsonValue };
      });
      const tx = blocks.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('');
      out.push({ role: 'assistant', content: tx ? [{ type: 'text', text: tx }] : [], ...(calls.length > 0 ? { toolCalls: calls } : {}) });
    } else {
      for (const b of blocks.filter((x) => x['type'] === 'tool_result')) {
        const id = String(b['tool_use_id']);
        out.push({ role: 'tool', toolCallId: id, toolName: names.get(id) ?? 'unknown', content: text(b['content']), isError: b['is_error'] === true });
      }
      const tx = blocks.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('');
      if (tx) out.push({ role: 'user', content: tx });
    }
  }
  return out;
}

/** The role named in a request's agent header (`[hypertest role=… …]`), for the log. */
function roleOf(messages: readonly ChatMessage[]): string {
  const sys = messages[0]?.role === 'system' ? messages[0].content : '';
  return /\[hypertest role=([\w-]+)/.exec(typeof sys === 'string' ? sys : '')?.[1] ?? 'unknown';
}

const STATUS_OF: Record<string, number> = { timeout: 504, rate_limited: 429, unavailable: 503, provider_error: 500 };

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')}`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The fake fetch: `brains` by provider id, `endpoints` by host. Unknown hosts are refused (a request that would have left
 * the process is a fault, never answered).
 */
export function scriptedWireFetch(brains: Readonly<Record<string, ScriptedBrain>>, endpoints: readonly WireEndpoint[], log: WireCall[]): typeof fetch {
  const byHost = new Map(endpoints.map((e) => [wireHost(e.provider), e]));
  let seq = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const endpoint = byHost.get(url.host);
    if (!endpoint) throw new HypertestError('permission_denied', `the scripted wire transport answers only its endpoints (${[...byHost.keys()].join(', ')}), not ${url.host}`);
    const brain = brains[endpoint.provider];
    if (!brain) throw new HypertestError('not_found', `no scripted brain for provider ${endpoint.provider}`);
    const rawBody = typeof init?.body === 'string' ? init.body : init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '';
    const body = obj(JSON.parse(rawBody || '{}'));
    const anthropic = url.pathname.endsWith('/v1/messages');
    if (!anthropic && !url.pathname.endsWith('/chat/completions')) return json(404, { error: { message: `no route ${url.pathname}` } });
    const messages = anthropic ? fromAnthropicMessages(body['system'], Array.isArray(body['messages']) ? body['messages'] : []) : fromOpenAIMessages(Array.isArray(body['messages']) ? body['messages'] : []);
    const tools = (Array.isArray(body['tools']) ? body['tools'] : []).map((t) => {
      const o = obj(t);
      const f = anthropic ? o : obj(o['function']);
      return { name: String(f['name'] ?? '').split('__').join('.'), description: String(f['description'] ?? ''), inputSchema: obj(anthropic ? o['input_schema'] : f['parameters']) as never };
    });
    const request: ModelCallRequest = { model: String(body['model'] ?? ''), messages, ...(tools.length > 0 ? { tools } : {}) };
    const stream = body['stream'] === true;
    const entry: WireCall = { provider: endpoint.provider, wireClass: endpoint.wireClass, role: roleOf(messages), status: 200, stream };
    const reply: ScriptedReply = await brain(request, { callIndex: seq, routeModel: request.model });
    if ('error' in reply) {
      entry.status = STATUS_OF[reply.error] ?? 500;
      log.push(entry);
      return anthropic
        ? json(entry.status, { type: 'error', error: { type: reply.error === 'rate_limited' ? 'rate_limit_error' : 'overloaded_error', message: reply.message ?? reply.error } })
        : json(entry.status, { error: { message: reply.message ?? reply.error, type: reply.error } });
    }
    log.push(entry);
    const id = `wire_${++seq}`;
    const calls = (reply.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${seq}_${i}`, name: c.name, arguments: c.arguments }));
    const inputTokens = Math.max(1, Math.ceil(rawBody.length / 4));
    const outputTokens = Math.max(1, Math.ceil(JSON.stringify(reply).length / 4));
    if (anthropic) {
      const content: unknown[] = [];
      if (reply.text) content.push({ type: 'text', text: reply.text });
      for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      return json(200, { id, type: 'message', role: 'assistant', model: request.model, content, stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn', usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
    }
    const finish = calls.length > 0 ? 'tool_calls' : 'stop';
    if (!stream) {
      return json(200, {
        id, object: 'chat.completion', model: request.model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}) }, finish_reason: finish }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      });
    }
    const chunks: unknown[] = [];
    if (reply.text) chunks.push({ id, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] });
    calls.forEach((c, i) => chunks.push({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }] } }] }));
    chunks.push({ id, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    chunks.push({ id, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } });
    chunks.push('[DONE]');
    return sse(chunks);
  }) as typeof fetch;
}
