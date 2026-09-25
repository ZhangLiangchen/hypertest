import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import type { ChatMessage } from '@hypertest/domain';
import { PiAiProvider, ToolNameMap, fromPiAssistant, mapPiStopReason, mapPiUsage, piCompatibilityClass, toPiContext, type StreamDelta } from '../src/index.ts';
import { startMockServer, writeAnthropicSse, writeJson, writeSse, type MockServer } from './helpers.ts';

const okStream = [
  { id: 'p1', choices: [{ index: 0, delta: { content: 'hello' } }] },
  { id: 'p1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'fs__read', arguments: '{"path":' } }] } }] },
  { id: 'p1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] },
  { id: 'p1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_y', type: 'function', function: { name: 'git__log', arguments: '{}' } }] } }] },
  { id: 'p1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { id: 'p1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } },
];

async function withServer(handler: Parameters<typeof startMockServer>[0], fn: (s: MockServer) => Promise<void>): Promise<void> {
  const s = await startMockServer(handler);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const tools = [
  { name: 'fs.read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'git.log', description: 'log', inputSchema: { type: 'object' } },
];

test('pi-ai (openai-completions via custom baseUrl): IR ⇄ pi mapping, dotted tool names round-trip, usage + deltas', async () => {
  await withServer(
    (_req, res) => writeSse(res, okStream),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi-local', piProvider: 'local', baseUrl: s.url, apiKey: 'k-123456' });
      assert.equal(p.adapterInfo.package, '@earendil-works/pi-ai');
      assert.equal(p.adapterInfo.version, '0.87.1');
      const history: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'reading' }], toolCalls: [{ id: 'c0', name: 'fs.read', arguments: { path: 'z' } }] },
        { role: 'tool', toolCallId: 'c0', toolName: 'fs.read', content: 'data', isError: false },
        { role: 'user', content: 'go on' },
      ];
      const deltas: StreamDelta[] = [];
      const r = await p.complete({ model: 'mock', messages: history, tools, maxOutputTokens: 50, temperature: 0.3 }, { onDelta: (d) => deltas.push(d) });
      assert.deepEqual(r.message, {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [
          { id: 'call_x', name: 'fs.read', arguments: { path: 'a' } },
          { id: 'call_y', name: 'git.log', arguments: {} },
        ],
      });
      assert.equal(r.stopReason, 'tool_use');
      assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 0 });
      assert.equal(r.providerResponseId, 'p1');
      assert.deepEqual(deltas.slice(0, 2), [{ type: 'text', text: 'hello' }, { type: 'tool_call_start', id: 'call_x', name: 'fs.read' }]);
      assert.ok(deltas.some((d) => d.type === 'tool_call_start' && d.name === 'git.log'));

      const body = s.requests[0]!.body;
      assert.equal(s.requests[0]!.headers['authorization'], 'Bearer k-123456');
      assert.equal(body['model'], 'mock');
      assert.equal(body['max_tokens'], 50);
      assert.equal(body['temperature'], 0.3);
      assert.deepEqual((body['tools'] as Array<{ function: { name: string } }>).map((t) => t.function.name), ['fs__read', 'git__log']);
      const msgs = body['messages'] as Array<Record<string, unknown>>;
      assert.deepEqual(msgs.map((m) => m['role']), ['system', 'user', 'assistant', 'tool', 'user']);
      assert.deepEqual((msgs[2]!['tool_calls'] as Array<{ id: string; function: { name: string; arguments: string } }>).map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [['c0', 'fs__read', { path: 'z' }]]);
      assert.equal(msgs[3]!['tool_call_id'], 'c0');
    },
  );
});

test('pi-ai: tool_choice required/{name} and response_format are applied to the openai-completions payload', async () => {
  await withServer(
    (_req, res) => writeSse(res, [{ id: 'x', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] }]),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: s.url });
      await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, toolChoice: { name: 'git.log' }, responseFormat: { type: 'json_schema', name: 'out', schema: { type: 'object' } } });
      await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, toolChoice: 'required' });
      assert.deepEqual(s.requests[0]!.body['tool_choice'], { type: 'function', function: { name: 'git__log' } });
      assert.deepEqual(s.requests[0]!.body['response_format'], { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } });
      assert.equal(s.requests[1]!.body['tool_choice'], 'required');
    },
  );
});

test('pi-ai: built-in catalog models are reused (deepseek) with a baseUrl override', async () => {
  await withServer(
    (_req, res) => writeSse(res, [{ id: 'd', choices: [{ index: 0, delta: { reasoning_content: 'hmm', content: 'ok' }, finish_reason: 'stop' }] }, { id: 'd', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }]),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'deepseek', piProvider: 'deepseek', baseUrl: s.url, apiKey: 'ds-key-0000' });
      const model = await p.resolveModel('deepseek-flash');
      assert.equal(model.api, 'openai-completions');
      assert.equal(model.baseUrl, s.url);
      const r = await p.complete({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'q' }] });
      assert.deepEqual(r.message.content, [{ type: 'text', text: 'ok' }]);
      assert.equal(r.message.reasoning?.text, 'hmm');
      assert.equal(s.requests[0]!.headers['authorization'], 'Bearer ds-key-0000');
    },
  );
});

test('pi-ai: unknown model without baseUrl is a configuration error (not retried, no fallback); unsupported API is refused', async () => {
  const p = new PiAiProvider({ providerId: 'pi', piProvider: 'deepseek' });
  await assert.rejects(p.complete({ model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && !e.retryable);
  const q = new PiAiProvider({ providerId: 'pi', piProvider: 'x', models: [{ id: 'm', api: 'telepathy-v1', baseUrl: 'http://127.0.0.1:1' }] });
  await assert.rejects(q.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'unsupported');
});

test('pi-ai: HTTP status is observed and mapped (429 rate_limited, 500 unavailable, 400 provider_error); pi-ai never retries', async () => {
  let status = 429;
  await withServer(
    (_req, res) => writeJson(res, status, { error: { message: 'nope', type: 'x' } }),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: s.url, apiKey: 'k-secret-9999' });
      for (const [st, code, retryable] of [[429, 'rate_limited', true], [500, 'unavailable', true], [400, 'provider_error', false]] as const) {
        status = st;
        await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === code && e.retryable === retryable && e.details['status'] === st);
      }
      assert.equal(s.requests.length, 3);
    },
  );
});

test('pi-ai: connection refused ⇒ unavailable; deadline ⇒ timeout; caller abort ⇒ cancelled', async () => {
  const dead = await startMockServer(() => undefined);
  const deadUrl = dead.url;
  await dead.close();
  const p0 = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: deadUrl });
  await assert.rejects(p0.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && e.retryable);

  await withServer(
    async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 's', choices: [{ index: 0, delta: { content: 'part' } }] })}\n\n`);
      await new Promise((r) => res.on('close', r));
    },
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: s.url, timeoutMs: 5000 });
      await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], timeoutMs: 150 }), (e: unknown) => e instanceof HypertestError && e.code === 'timeout');
      const ctrl = new AbortController();
      await assert.rejects(
        p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }, { onDelta: () => ctrl.abort() }),
        (e: unknown) => e instanceof HypertestError && e.code === 'cancelled',
      );
    },
  );
});

test('pi-ai (anthropic-messages): signed thinking becomes opaque reasoning and is replayed only to the same model', async () => {
  await withServer(
    (_req, res) =>
      writeAnthropicSse(res, [
        { type: 'message_start', message: { id: 'msg_pi', type: 'message', role: 'assistant', model: 'claude-mock', content: [], usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan it' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIGPI' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ]),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi-anthropic', piProvider: 'custom', apiKey: 'ant-key-1234', models: [{ id: 'claude-mock', api: 'anthropic-messages', baseUrl: s.url, reasoning: true }, { id: 'claude-other', api: 'anthropic-messages', baseUrl: s.url, reasoning: true }] });
      const r = await p.complete({ model: 'claude-mock', messages: [{ role: 'user', content: 'x' }] });
      const cls = piCompatibilityClass({ api: 'anthropic-messages', provider: 'custom', id: 'claude-mock' });
      assert.equal(cls, 'pi-ai:anthropic-messages:custom:claude-mock');
      assert.deepEqual(r.message, {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        reasoning: { text: 'plan it', opaque: { compatibilityClass: cls, data: { blocks: [{ thinking: 'plan it', signature: 'SIGPI' }] } } },
      });
      assert.equal(r.usage.inputTokens, 25);
      assert.equal(r.usage.cachedInputTokens, 5);
      assert.equal(r.usage.outputTokens, 9);

      const history: ChatMessage[] = [{ role: 'user', content: 'x' }, r.message, { role: 'user', content: 'again' }];
      await p.complete({ model: 'claude-mock', messages: history });
      await p.complete({ model: 'claude-other', messages: history });
      const assistantBlocks = (i: number) => ((s.requests[i]!.body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === 'assistant')?.content ?? []).map((b) => b['type']);
      assert.deepEqual(assistantBlocks(1), ['thinking', 'text'], 'same model: signed thinking replayed');
      assert.ok(!assistantBlocks(2).includes('thinking'), 'other model: thinking never replayed');
      const sameThinking = (s.requests[1]!.body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === 'assistant')!.content[0]!;
      assert.equal(sameThinking['signature'], 'SIGPI');
    },
  );
});

test('pi-ai mapping functions: toPiContext / fromPiAssistant / usage / stop reasons', () => {
  const names = new ToolNameMap();
  const model = { id: 'm', name: 'm', api: 'mistral-conversations', provider: 'mistral', baseUrl: 'http://x', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
  const ctx = toPiContext(
    {
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'u' }, { type: 'image', mimeType: 'image/png', dataBase64: 'QQ==' }, { type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://x' }] },
        { role: 'system', content: 'later' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }], toolCalls: [{ id: 't', name: 'x.y', arguments: [1] }], reasoning: { text: 'r', opaque: { compatibilityClass: 'pi-ai:other:p:m', data: { blocks: [{ thinking: 'r', signature: 's' }] } } } },
        { role: 'tool', toolCallId: 't', toolName: 'x.y', content: 'res', isError: true },
      ],
      tools: [{ name: 'x.y', description: 'd', inputSchema: { type: 'object' } }],
      responseFormat: { type: 'json_schema', name: 'o', schema: { type: 'object' } },
    },
    model,
    names,
  );
  assert.match(ctx.systemPrompt ?? '', /^S\n\nRespond ONLY with a JSON value/);
  assert.deepEqual(ctx.tools?.map((t) => t.name), ['x__y']);
  assert.deepEqual(ctx.messages.map((m) => m.role), ['user', 'system', 'assistant', 'toolResult']);
  const user = ctx.messages[0]!;
  assert.ok(user.role === 'user' && Array.isArray(user.content));
  if (user.role === 'user' && Array.isArray(user.content)) {
    assert.deepEqual(user.content, [{ type: 'text', text: 'u' }, { type: 'image', data: 'QQ==', mimeType: 'image/png' }, { type: 'text', text: '[image image/jpeg artifact://x not inlined]' }]);
  }
  const asst = ctx.messages[2]!;
  assert.ok(asst.role === 'assistant');
  if (asst.role === 'assistant') {
    assert.deepEqual(asst.content, [{ type: 'text', text: 'a' }, { type: 'toolCall', id: 't', name: 'x__y', arguments: {} }], 'foreign opaque thinking dropped; non-object args normalized');
    assert.equal(asst.provider, 'hypertest');
  }
  const tr = ctx.messages[3]!;
  assert.ok(tr.role === 'toolResult' && tr.isError === true && tr.toolName === 'x__y');

  const back = fromPiAssistant(
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'why' },
        { type: 'text', text: 'hi' },
        { type: 'toolCall', id: 'k', name: 'x__y', arguments: { a: 1 }, thoughtSignature: 'TS' },
      ],
      api: 'google-generative-ai',
      provider: 'google',
      model: 'g',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } },
      stopReason: 'stop',
      timestamp: 0,
    },
    names,
    'pi-ai:google-generative-ai:google:g',
  );
  assert.deepEqual(back.message, {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    toolCalls: [{ id: 'k', name: 'x.y', arguments: { a: 1 } }],
    reasoning: { text: 'why', opaque: { compatibilityClass: 'pi-ai:google-generative-ai:google:g', data: { blocks: [], toolSignatures: { k: 'TS' } } } },
  });
  assert.equal(back.stopReason, 'tool_use');
  assert.deepEqual(mapPiUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, reasoning: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } }), { inputTokens: 8, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: 1, costUsd: 0.25 });
  assert.equal(mapPiUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), undefined);
  assert.deepEqual(['stop', 'length', 'toolUse', 'aborted', 'error'].map((x) => mapPiStopReason(x as never, false)), ['end_turn', 'max_tokens', 'tool_use', 'aborted', 'error']);
});

test('pi-ai: route extra → sampling params (null entries dropped); redirects are refused so credentials never follow them', async () => {
  const target = await startMockServer((_req, res) => writeSse(res, okStream));
  try {
    await withServer(
      (req, res) => {
        if (req.url.startsWith('/redirect')) {
          res.writeHead(307, { location: `${target.url}/chat/completions` });
          res.end();
          return;
        }
        writeSse(res, [{ id: 'x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
      },
      async (s) => {
        const p = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: s.url, apiKey: 'k-redirect-1' });
        await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], extra: { top_k: 5, min_p: null } });
        assert.equal(s.requests[0]!.body['top_k'], 5);
        assert.equal('min_p' in s.requests[0]!.body, false);
        const r = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: `${s.url}/redirect`, apiKey: 'k-redirect-1' });
        await assert.rejects(r.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError);
        assert.equal(target.requests.length, 0, 'redirect target must never receive the request');
      },
    );
  } finally {
    await target.close();
  }
});

test('pi-ai: malformed opaque continuation data of the SAME class is sanitized (never replayed as garbage thinking blocks)', () => {
  const names = new ToolNameMap();
  const model = { id: 'c', name: 'c', api: 'anthropic-messages', provider: 'p', baseUrl: 'http://x', reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
  const cls = piCompatibilityClass(model);
  const assistantContent = (data: unknown) => {
    const ctx = toPiContext(
      { messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }], toolCalls: [{ id: 't1', name: 'x', arguments: {} }], reasoning: { opaque: { compatibilityClass: cls, data: data as never } } }] },
      model,
      names,
    );
    const m = ctx.messages[1]!;
    assert.ok(m.role === 'assistant');
    return m.role === 'assistant' ? m.content : [];
  };
  for (const garbage of [null, 'blocks', { blocks: 'abc' }, { blocks: [null, 7, { thinking: 5 }, { signature: 'only' }] }, { toolSignatures: 'x' }, { toolSignatures: { t1: 5 } }]) {
    assert.deepEqual(assistantContent(garbage), [{ type: 'text', text: 'a' }, { type: 'toolCall', id: 't1', name: 'x', arguments: {} }], JSON.stringify(garbage));
  }
  assert.deepEqual(assistantContent({ blocks: [{ thinking: 'ok', signature: 'S' }, { bogus: true }, { thinking: '', redacted: true, signature: 'R' }], toolSignatures: { t1: 'TS', other: 3 } }), [
    { type: 'thinking', thinking: 'ok', thinkingSignature: 'S' },
    { type: 'thinking', thinking: '', thinkingSignature: 'R', redacted: true },
    { type: 'text', text: 'a' },
    { type: 'toolCall', id: 't1', name: 'x', arguments: {}, thoughtSignature: 'TS' },
  ]);
});

test('pi-ai: an exception thrown by the caller onDelta callback is a non-retryable internal fault', async () => {
  await withServer(
    (_req, res) => writeSse(res, okStream),
    async (s) => {
      const p = new PiAiProvider({ providerId: 'pi', piProvider: 'local', baseUrl: s.url, apiKey: 'k-123456' });
      await assert.rejects(
        p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools }, { onDelta: () => { throw new Error('ui bug'); } }),
        (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /onDelta/.test(e.message),
      );
    },
  );
});
