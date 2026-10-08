/**
 * (item 6) The scripted wire transport (hermetic): wire formats decode into the neutral request the brains read, replies
 * encode back per provider class (OpenAI JSON/SSE, Anthropic JSON), scripted errors become HTTP statuses, every exchange
 * is logged, and a request to any other host is refused (nothing leaves the process).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicProvider, OpenAICompatibleProvider, PiAiProvider } from '@hypertest/model';
import type { ModelCallRequest } from '@hypertest/model';
import { fromAnthropicMessages, fromOpenAIMessages, scriptedWireFetch, wireHost, type WireCall } from '../src/index.ts';

const HEADER = '[hypertest role=executor work_item=wi_1 kind=task run=run_1]\nYou are the executor.';
const tools = [{ name: 'http.request', description: 'probe', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

function brainSaw(into: ModelCallRequest[]) {
  return (request: ModelCallRequest) => {
    into.push(request);
    return request.messages.some((m) => m.role === 'tool') ? { text: 'done' } : { toolCalls: [{ name: 'http__request', arguments: { path: '/health' } }] };
  };
}

test('the three adapters talk to the transport over their own wire formats; the brain sees the same neutral request', async () => {
  for (const [kind, make] of [
    ['anthropic', (f: typeof fetch) => new AnthropicProvider({ providerId: 'a', baseUrl: `http://${wireHost('a')}`, apiKey: 'k', fetchImpl: f })],
    ['openai-compatible', (f: typeof fetch) => new OpenAICompatibleProvider({ providerId: 'a', baseUrl: `http://${wireHost('a')}/v1`, fetchImpl: f })],
    ['pi-ai', (f: typeof fetch) => new PiAiProvider({ providerId: 'a', piProvider: 'wire', baseUrl: `http://${wireHost('a')}/v1`, fetchImpl: f })],
  ] as const) {
    const seen: ModelCallRequest[] = [];
    const log: WireCall[] = [];
    const provider = make(scriptedWireFetch({ a: brainSaw(seen) }, [{ provider: 'a', wireClass: kind }], log));
    const first = await provider.complete({ model: 'm-1', messages: [{ role: 'system', content: HEADER }, { role: 'user', content: 'go' }], tools });
    assert.deepEqual(first.message.toolCalls?.map((c) => [c.name, c.arguments]), [['http.request', { path: '/health' }]], kind);
    const call = first.message.toolCalls![0]!;
    const second = await provider.complete({
      model: 'm-1',
      messages: [{ role: 'system', content: HEADER }, { role: 'user', content: 'go' }, first.message, { role: 'tool', toolCallId: call.id, toolName: 'http.request', content: 'HTTP 200', isError: false }],
      tools,
    });
    assert.equal(second.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''), 'done', kind);
    assert.ok(second.usage.inputTokens > 0, kind);
    // the brain saw the agent header, the tool and the tool result (with its tool name) — whatever the wire class
    assert.match(String(seen[1]!.messages[0]!.content), /\[hypertest role=executor/, kind);
    assert.deepEqual(seen[1]!.tools?.map((t) => t.name), ['http.request'], kind);
    const result = seen[1]!.messages.find((m) => m.role === 'tool');
    assert.deepEqual(result && result.role === 'tool' ? [result.toolName.split('__').join('.'), result.content] : [], ['http.request', 'HTTP 200'], kind);
    assert.deepEqual(log.map((l) => [l.wireClass, l.role, l.status]), [[kind, 'executor', 200], [kind, 'executor', 200]], kind);
  }
});

test('a scripted provider error becomes the HTTP status of its class; any other host is refused', async () => {
  const log: WireCall[] = [];
  const f = scriptedWireFetch({ a: () => ({ error: 'unavailable', message: 'scripted outage' }) }, [{ provider: 'a', wireClass: 'openai-compatible' }], log);
  const res = await f(`http://${wireHost('a')}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: HEADER }] }) });
  assert.equal(res.status, 503);
  assert.deepEqual(log.map((l) => l.status), [503]);
  await assert.rejects(f('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }), /answers only its endpoints/);
  const provider = new OpenAICompatibleProvider({ providerId: 'a', baseUrl: `http://${wireHost('a')}/v1`, fetchImpl: f });
  await assert.rejects(provider.complete({ model: 'm', messages: [{ role: 'system', content: HEADER }] }), (e: Error & { code?: string }) => e.code === 'unavailable');
});

test('wire decoding: OpenAI and Anthropic histories become the same neutral messages', () => {
  const openai = fromOpenAIMessages([
    { role: 'system', content: 'S' }, { role: 'user', content: 'U' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs__read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '[tool error] boom' },
  ]);
  const anthropic = fromAnthropicMessages('S', [
    { role: 'user', content: [{ type: 'text', text: 'U' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fs__read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }] },
  ]);
  assert.deepEqual(openai, anthropic);
  assert.deepEqual(openai.at(-1), { role: 'tool', toolCallId: 'c1', toolName: 'fs__read', content: 'boom', isError: true });
});
