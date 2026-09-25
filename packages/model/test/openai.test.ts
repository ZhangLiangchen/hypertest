import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import { estimateTokens, type ChatMessage } from '@hypertest/domain';
import { OpenAICompatibleProvider, type ModelCallRequest, type StreamDelta } from '../src/index.ts';
import { startMockServer, writeJson, writeSse, type MockServer } from './helpers.ts';

const KEY = 'sk-test-SECRET-0123456789';

async function withServer(handler: Parameters<typeof startMockServer>[0], fn: (s: MockServer, p: OpenAICompatibleProvider) => Promise<void>, timeoutMs = 5000): Promise<void> {
  const s = await startMockServer(handler);
  try {
    await fn(s, new OpenAICompatibleProvider({ providerId: 'oai', baseUrl: `${s.url}/v1/`, apiKey: KEY, headers: { 'x-team': 'qa' }, timeoutMs }));
  } finally {
    await s.close();
  }
}

const history: ChatMessage[] = [
  { role: 'system', content: 'You are a tester.' },
  { role: 'user', content: [{ type: 'text', text: 'Look:' }, { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }, { type: 'image', mimeType: 'image/png', artifactUri: 'artifact://sha256/abc' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }], toolCalls: [{ id: 'call_0', name: 'fs.read', arguments: { path: 'a.ts' } }] },
  { role: 'tool', toolCallId: 'call_0', toolName: 'fs.read', content: 'ENOENT', isError: true },
  { role: 'user', content: 'continue' },
];

test('openai SSE: request mapping, text + parallel tool calls across split chunks, usage with cached/reasoning tokens', async () => {
  const id = 'chatcmpl-42';
  await withServer(
    (_req, res) =>
      writeSse(
        res,
        [
          { id, choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
          { id, choices: [{ index: 0, delta: { content: 'check.' } }] },
          { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'fs__read', arguments: '' } }] } }] },
          { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'git__diff', arguments: '{"ref":' } }] } }] },
          { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/a.ts"}' } }] } }] },
          { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"HEAD"}' } }] } }] },
          { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { id, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 12 } } },
        ],
        { split: true },
      ),
    async (s, p) => {
      const deltas: StreamDelta[] = [];
      const request: ModelCallRequest = {
        model: 'gpt-x',
        messages: history,
        tools: [
          { name: 'fs.read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'git.diff', description: 'diff', inputSchema: { type: 'object' } },
        ],
        toolChoice: { name: 'fs.read' },
        responseFormat: { type: 'json_schema', name: 'verdict', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
        maxOutputTokens: 256,
        temperature: 0.1,
        reasoningEffort: 'high',
        extra: { top_p: 0.5, max_tokens: null, max_completion_tokens: 100, model: 'hijack', stream: false },
      };
      const r = await p.complete(request, { onDelta: (d) => deltas.push(d) });

      const sent = s.requests[0]!;
      assert.equal(sent.url, '/v1/chat/completions');
      assert.equal(sent.headers['authorization'], `Bearer ${KEY}`);
      assert.equal(sent.headers['x-team'], 'qa');
      assert.deepEqual(sent.body, {
        model: 'gpt-x',
        messages: [
          { role: 'system', content: 'You are a tester.' },
          { role: 'user', content: [{ type: 'text', text: 'Look:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '[image image/png artifact://sha256/abc not inlined]' }] },
          { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'fs__read', arguments: '{"path":"a.ts"}' } }] },
          { role: 'tool', tool_call_id: 'call_0', content: '[tool error] ENOENT' },
          { role: 'user', content: 'continue' },
        ],
        tools: [
          { type: 'function', function: { name: 'fs__read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
          { type: 'function', function: { name: 'git__diff', description: 'diff', parameters: { type: 'object' } } },
        ],
        tool_choice: { type: 'function', function: { name: 'fs__read' } },
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, strict: true } },
        temperature: 0.1,
        reasoning_effort: 'high',
        stream: true,
        stream_options: { include_usage: true },
        top_p: 0.5,
        max_completion_tokens: 100,
      });

      assert.deepEqual(r.message, {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check.' }],
        toolCalls: [
          { id: 'call_a', name: 'fs.read', arguments: { path: 'src/a.ts' } },
          { id: 'call_b', name: 'git.diff', arguments: { ref: 'HEAD' } },
        ],
      });
      assert.equal(r.stopReason, 'tool_use');
      assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 12 });
      assert.equal(r.providerResponseId, id);
      assert.ok(r.latencyMs >= 0);
      assert.deepEqual(deltas, [
        { type: 'text', text: 'Let me ' },
        { type: 'text', text: 'check.' },
        { type: 'tool_call_start', id: 'call_a', name: 'fs.read' },
        { type: 'tool_call_start', id: 'call_b', name: 'git.diff' },
        { type: 'tool_call_args', id: 'call_b', text: '{"ref":' },
        { type: 'tool_call_args', id: 'call_a', text: '{"path":"src/a.ts"}' },
        { type: 'tool_call_args', id: 'call_b', text: '"HEAD"}' },
      ]);
    },
  );
});

test('openai SSE: DeepSeek-style reasoning_content → reasoning.text; missing usage is estimated (never zero)', async () => {
  await withServer(
    (_req, res) =>
      writeSse(res, [
        { id: 'r1', choices: [{ index: 0, delta: { reasoning_content: 'think ' } }] },
        { id: 'r1', choices: [{ index: 0, delta: { reasoning_content: 'hard' } }] },
        { id: 'r1', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] },
      ]),
    async (_s, p) => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'q'.repeat(400) }];
      const deltas: StreamDelta[] = [];
      const r = await p.complete({ model: 'deepseek-reasoner', messages }, { onDelta: (d) => deltas.push(d) });
      assert.deepEqual(r.message, { role: 'assistant', content: [{ type: 'text', text: 'answer' }], reasoning: { text: 'think hard' } });
      assert.equal(r.stopReason, 'end_turn');
      assert.equal(r.usage.inputTokens, estimateTokens(messages));
      assert.ok(r.usage.outputTokens > 0);
      assert.deepEqual(deltas.filter((d) => d.type === 'reasoning'), [{ type: 'reasoning', text: 'think ' }, { type: 'reasoning', text: 'hard' }]);
    },
  );
});

test('openai JSON (non-stream) response is supported, incl. tool calls with object arguments', async () => {
  await withServer(
    (_req, res) =>
      writeJson(res, 200, {
        id: 'cmpl-json',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'http__request', arguments: '{"url":"http://x"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 },
      }),
    async (_s, p) => {
      const r = await p.complete({ model: 'local', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'http.request', description: 'h', inputSchema: { type: 'object' } }] });
      assert.deepEqual(r.message, { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'http.request', arguments: { url: 'http://x' } }] });
      assert.equal(r.stopReason, 'tool_use');
      assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 });
      assert.equal(r.providerResponseId, 'cmpl-json');
    },
  );
});

test('openai HTTP errors: 429 rate_limited (retry-after), 408/500/503 unavailable, 400/401/404/422 provider_error; key never leaks', async () => {
  const cases: Array<[number, string, boolean]> = [
    [429, 'rate_limited', true],
    [408, 'unavailable', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
    [400, 'provider_error', false],
    [401, 'provider_error', false],
    [404, 'provider_error', false],
    [422, 'provider_error', false],
  ];
  let status = 0;
  await withServer(
    (_req, res) => writeJson(res, status, { error: { message: `bad things with key ${KEY}` } }, status === 429 ? { 'retry-after': '3' } : {}),
    async (s, p) => {
      for (const [st, code, retryable] of cases) {
        status = st;
        await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
          assert.ok(e instanceof HypertestError);
          assert.equal(e.code, code, `status ${st}`);
          assert.equal(e.retryable, retryable, `status ${st}`);
          assert.equal(e.details['status'], st);
          assert.ok(!e.message.includes(KEY), 'api key must be scrubbed');
          assert.ok(e.message.includes('[redacted]'));
          if (st === 429) assert.equal(e.details['retryAfterMs'], 3000);
          return true;
        });
      }
      assert.equal(s.requests.length, cases.length, 'provider itself never retries');
    },
  );
});

test('openai: whole-call timeout (server stalls mid-stream) ⇒ timeout; caller abort ⇒ cancelled', async () => {
  await withServer(
    async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`);
      // Stall until the client gives up (the connection closes); no dangling timers.
      await new Promise((r) => res.on('close', r));
    },
    async (_s, p) => {
      const t0 = Date.now();
      await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], timeoutMs: 100 }), (e: unknown) => e instanceof HypertestError && e.code === 'timeout' && e.retryable);
      assert.ok(Date.now() - t0 < 3000);
      const ctrl = new AbortController();
      const deltas: StreamDelta[] = [];
      const pending = p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }, { onDelta: (d) => {
        deltas.push(d);
        ctrl.abort();
      } });
      await assert.rejects(pending, (e: unknown) => e instanceof HypertestError && e.code === 'cancelled' && !e.retryable);
      assert.deepEqual(deltas, [{ type: 'text', text: 'partial' }]);
    },
  );
});

test('openai: invalid tool-call JSON ⇒ arguments {} + rawArguments; length/content_filter finish reasons', async () => {
  let finish = 'length';
  await withServer(
    (_req, res) =>
      writeSse(res, [
        { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs__write', arguments: '{"path": "a", "content": "unterminated' } }] } }] },
        { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      ]),
    async (_s, p) => {
      const r = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'fs.write', description: '', inputSchema: {} }] });
      assert.deepEqual(r.message.toolCalls, [{ id: 'c', name: 'fs.write', arguments: {}, rawArguments: '{"path": "a", "content": "unterminated' }]);
      assert.equal(r.stopReason, 'max_tokens');
      finish = 'content_filter';
      assert.equal((await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).stopReason, 'content_filter');
    },
  );
});

test('openai: stream that ends without finish_reason or [DONE] ⇒ unavailable; in-stream error chunks are mapped', async () => {
  let mode = 'truncated';
  await withServer(
    (_req, res) => {
      if (mode === 'truncated') return writeSse(res, [{ id: 'x', choices: [{ index: 0, delta: { content: 'half' } }] }], { done: false });
      if (mode === 'rate') return writeSse(res, [{ error: { message: 'slow down', type: 'rate_limit_exceeded' } }], { done: false });
      return writeSse(res, [{ error: { message: 'bad schema', type: 'invalid_request_error' } }], { done: false });
    },
    async (_s, p) => {
      const call = () => p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
      await assert.rejects(call(), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && /before completion/.test(e.message));
      mode = 'rate';
      await assert.rejects(call(), (e: unknown) => e instanceof HypertestError && e.code === 'rate_limited');
      mode = 'invalid';
      await assert.rejects(call(), (e: unknown) => e instanceof HypertestError && e.code === 'provider_error' && !e.retryable);
    },
  );
});

test('openai: malformed JSON in the stream is a non-retryable provider_error', async () => {
  await withServer(
    (_req, res) => writeSse(res, ['{not json']),
    async (_s, p) => {
      await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'provider_error' && !e.retryable);
    },
  );
});

test('openai: connection refused ⇒ unavailable (retryable)', async () => {
  const s = await startMockServer(() => undefined);
  const url = s.url;
  await s.close();
  const p = new OpenAICompatibleProvider({ providerId: 'down', baseUrl: url, timeoutMs: 3000 });
  await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && e.retryable);
});

test('openai: requests without apiKey send no authorization header; tool ids are generated when absent or empty, unique per turn', async () => {
  const s = await startMockServer((_req, res) =>
    writeSse(res, [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name: 'a__b', arguments: '{}' } }, { index: 1, function: { name: 'c', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  );
  try {
    const p = new OpenAICompatibleProvider({ providerId: 'local', baseUrl: s.url });
    const r = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s.requests[0]!.headers['authorization'], undefined);
    const ids = r.message.toolCalls!.map((c) => c.id);
    assert.deepEqual(r.message.toolCalls, [
      { id: ids[0], name: 'a.b', arguments: {} },
      { id: ids[1], name: 'c', arguments: {} },
    ]);
    for (const id of ids) assert.match(id, /^call_[0-9a-f]{12}_\d+$/);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(r.providerResponseId, undefined);
    // Deterministic for the same request (durable replay), different on the next turn (ids stay unique across
    // the conversation: session stores and Anthropic replay reject duplicate tool-call ids).
    const again = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(again.message.toolCalls!.map((c) => c.id), ids);
    const next = await p.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }, r.message, { role: 'tool', toolCallId: ids[0]!, toolName: 'a.b', content: 'ok' }, { role: 'tool', toolCallId: ids[1]!, toolName: 'c', content: 'ok' }],
    });
    const nextIds = next.message.toolCalls!.map((c) => c.id);
    assert.equal(new Set([...ids, ...nextIds]).size, 4, `ids must not repeat across turns: ${JSON.stringify([ids, nextIds])}`);
  } finally {
    await s.close();
  }
});

test('openai: redirects are refused, so the API key is never sent to the redirect target', async () => {
  const target = await startMockServer((_req, res) => writeJson(res, 200, { choices: [{ message: { content: 'stolen' } }] }));
  try {
    await withServer(
      (_req, res) => {
        res.writeHead(307, { location: `${target.url}/v1/chat/completions` });
        res.end();
      },
      async (_s, p) => {
        await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && !e.message.includes(KEY));
        assert.equal(target.requests.length, 0);
      },
    );
  } finally {
    await target.close();
  }
});

test('openai: a stream cut mid-JSON with a clean EOF is a retryable unavailable (truncation), not a non-retryable provider_error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'half' } }] })}\n\n`);
      res.end('data: {"id":"x","choices":[{"index":0,"delta":{"content":"tr');
    },
    async (_s, p) => {
      await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && e.retryable && /before completion/.test(e.message));
    },
  );
});

test('openai in-stream errors: numeric HTTP-like codes and bad-request types are never classified as retryable availability faults', async () => {
  let err: Record<string, unknown> = {};
  await withServer(
    (_req, res) => writeSse(res, [{ error: err }], { done: false }),
    async (_s, p) => {
      const cases: Array<[Record<string, unknown>, string, boolean]> = [
        // vLLM / OpenAI-compatible servers
        [{ object: 'error', message: 'max_tokens too large', type: 'BadRequestError', code: 400 }, 'provider_error', false],
        [{ message: 'context too long', code: 'context_length_exceeded' }, 'provider_error', false],
        [{ message: 'no auth', type: 'authentication_error' }, 'provider_error', false],
        [{ message: 'nope', code: '422' }, 'provider_error', false],
        [{ message: 'slow', code: 429 }, 'rate_limited', true],
        [{ message: 'quota', type: 'insufficient_quota' }, 'rate_limited', true],
        [{ message: 'boom', type: 'server_error', code: 500 }, 'unavailable', true],
        [{ message: 'overloaded', type: 'overloaded_error' }, 'unavailable', true],
        [{ message: 'mystery' }, 'unavailable', true],
      ];
      for (const [e, code, retryable] of cases) {
        err = e;
        await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (x: unknown) => x instanceof HypertestError && x.code === code && x.retryable === retryable, JSON.stringify(e));
      }
    },
  );
});

test('openai: an exception thrown by the caller onDelta callback is a non-retryable internal fault, never a provider availability error', async () => {
  await withServer(
    (_req, res) => writeSse(res, [{ id: 'x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
    async (s, p) => {
      await assert.rejects(
        p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { onDelta: () => { throw new TypeError('ui bug'); } }),
        (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /onDelta/.test(e.message) && /ui bug/.test(e.message),
      );
      assert.equal(s.requests.length, 1);
    },
  );
});

test('openai: credentials passed via custom headers (e.g. Azure api-key, gateway tokens) are scrubbed from error messages too', async () => {
  const s = await startMockServer((req, res) => writeJson(res, 401, { error: { message: `rejected api-key=${String(req.headers['api-key'])} token=${String(req.headers['x-gateway-token'])}` } }));
  try {
    const p = new OpenAICompatibleProvider({ providerId: 'azure', baseUrl: s.url, headers: { 'api-key': 'AZURE-SECRET-123456', 'x-gateway-token': 'GW-TOKEN-987654', 'x-team': 'qa-team' } });
    await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'provider_error');
      assert.ok(!e.message.includes('AZURE-SECRET-123456'), e.message);
      assert.ok(!e.message.includes('GW-TOKEN-987654'), e.message);
      return true;
    });
  } finally {
    await s.close();
  }
});

test('openai mapping: an assistant turn with neither text nor tool calls is sent with empty-string content (null is rejected by the API)', async () => {
  const { toOpenAIMessages, ToolNameMap } = await import('../src/index.ts');
  const out = toOpenAIMessages([{ role: 'assistant', content: [] }, { role: 'assistant', content: [], toolCalls: [{ id: 'c', name: 'a.b', arguments: {} }] }], new ToolNameMap());
  assert.deepEqual(out, [
    { role: 'assistant', content: '' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'a__b', arguments: '{}' } }] },
  ]);
});

test('openai: an explicit `error: null` field in normal chunks/bodies is not an error', async () => {
  let json = false;
  await withServer(
    (_req, res) =>
      json
        ? writeJson(res, 200, { id: 'j', error: null, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fine' } }] })
        : writeSse(res, [{ id: 'x', error: null, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    async (_s, p) => {
      assert.deepEqual((await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).message.content, [{ type: 'text', text: 'ok' }]);
      json = true;
      assert.deepEqual((await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).message.content, [{ type: 'text', text: 'fine' }]);
    },
  );
});
