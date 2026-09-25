import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import type { ChatMessage } from '@hypertest/domain';
import { AnthropicProvider, STRUCTURED_OUTPUT_TOOL, type StreamDelta } from '../src/index.ts';
import { startMockServer, writeAnthropicSse, writeJson, type MockServer } from './helpers.ts';

const KEY = 'sk-ant-SECRET-abcdef';
const MODEL = 'claude-x';

async function withServer(handler: Parameters<typeof startMockServer>[0], fn: (s: MockServer, p: AnthropicProvider) => Promise<void>): Promise<void> {
  const s = await startMockServer(handler);
  try {
    await fn(s, new AnthropicProvider({ baseUrl: s.url, apiKey: KEY, timeoutMs: 5000, headers: { 'anthropic-beta': 'x' } }));
  } finally {
    await s.close();
  }
}

const streamEvents = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need to ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'read.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG==' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Reading now.' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'fs__read', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'toolu_2', name: 'git__status', input: {} } },
  { type: 'content_block_stop', index: 4 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 77 } },
  { type: 'message_stop' },
];

test('anthropic SSE: thinking (+signature, redacted) → reasoning text + opaque, text, tool_use with streamed JSON, cumulative usage', async () => {
  await withServer(
    (_req, res) => writeAnthropicSse(res, streamEvents),
    async (s, p) => {
      const deltas: StreamDelta[] = [];
      const r = await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }, { onDelta: (d) => deltas.push(d) });
      assert.equal(s.requests[0]!.url, '/v1/messages');
      assert.equal(s.requests[0]!.headers['x-api-key'], KEY);
      assert.equal(s.requests[0]!.headers['anthropic-version'], '2023-06-01');
      assert.equal(s.requests[0]!.headers['anthropic-beta'], 'x');
      assert.deepEqual(r.message, {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading now.' }],
        toolCalls: [
          { id: 'toolu_1', name: 'fs.read', arguments: { path: 'a.ts' } },
          { id: 'toolu_2', name: 'git.status', arguments: {} },
        ],
        reasoning: {
          text: 'Need to read.',
          opaque: {
            compatibilityClass: `anthropic:${MODEL}`,
            data: [
              { type: 'thinking', thinking: 'Need to read.', signature: 'SIG==' },
              { type: 'redacted_thinking', data: 'ENCRYPTED' },
            ],
          },
        },
      });
      assert.equal(r.stopReason, 'tool_use');
      assert.deepEqual(r.usage, { inputTokens: 260, outputTokens: 77, cachedInputTokens: 200 });
      assert.equal(r.providerResponseId, 'msg_1');
      assert.deepEqual(deltas, [
        { type: 'reasoning', text: 'Need to ' },
        { type: 'reasoning', text: 'read.' },
        { type: 'text', text: 'Reading now.' },
        { type: 'tool_call_start', id: 'toolu_1', name: 'fs.read' },
        { type: 'tool_call_args', id: 'toolu_1', text: '{"path":' },
        { type: 'tool_call_args', id: 'toolu_1', text: '"a.ts"}' },
        { type: 'tool_call_start', id: 'toolu_2', name: 'git.status' },
      ]);
    },
  );
});

test('anthropic request: system string, merged tool results (first), tool_use blocks, opaque replay only for the same class', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'A' },
    { role: 'user', content: 'q' },
    { role: 'system', content: 'B' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [
        { id: 't1', name: 'fs.read', arguments: { path: 'a' } },
        { id: 't2', name: 'git.diff', arguments: 'not-an-object' },
      ],
      reasoning: { text: 'prev', opaque: { compatibilityClass: `anthropic:${MODEL}`, data: [{ type: 'thinking', thinking: 'prev', signature: 'S1' }, { type: 'bogus' }] } },
    },
    { role: 'tool', toolCallId: 't1', toolName: 'fs.read', content: 'ENOENT', isError: true },
    { role: 'user', content: [{ type: 'text', text: 'next' }, { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }] },
    { role: 'tool', toolCallId: 't2', toolName: 'git.diff', content: 'diff' },
    { role: 'assistant', content: [{ type: 'text', text: 'other' }], reasoning: { text: 'foreign', opaque: { compatibilityClass: 'anthropic:other-model', data: [{ type: 'thinking', thinking: 'x', signature: 'S2' }] } } },
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: 'final' },
  ];
  await withServer(
    (_req, res) => writeAnthropicSse(res, [{ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]),
    async (s, p) => {
      const r = await p.complete({
        model: MODEL,
        messages,
        tools: [
          { name: 'fs.read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'git.diff', description: 'diff', inputSchema: { type: 'object' } },
        ],
        toolChoice: 'required',
        temperature: 0,
        extra: { thinking: { type: 'enabled', budget_tokens: 2048 }, model: 'hijack', stream: false, temperature: null },
      });
      assert.deepEqual(r.message, { role: 'assistant', content: [] });
      assert.equal(r.stopReason, 'end_turn');
      assert.deepEqual(s.requests[0]!.body, {
        model: MODEL,
        max_tokens: 4096,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'prev', signature: 'S1' },
              { type: 'text', text: 'calling' },
              { type: 'tool_use', id: 't1', name: 'fs__read', input: { path: 'a' } },
              { type: 'tool_use', id: 't2', name: 'git__diff', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'ENOENT', is_error: true },
              { type: 'tool_result', tool_use_id: 't2', content: 'diff' },
              { type: 'text', text: 'next' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'other' }] },
          { role: 'user', content: [{ type: 'text', text: 'final' }] },
        ],
        system: 'A\n\nB',
        tools: [
          { name: 'fs__read', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'git__diff', description: 'diff', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'any' },
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 2048 },
      });
    },
  );
});

test('anthropic tool_choice mapping: auto/none/{name}', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  await withServer(
    (req, res) => {
      bodies.push(req.body);
      writeAnthropicSse(res, [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]);
    },
    async (_s, p) => {
      const tools = [{ name: 'http.request', description: 'h', inputSchema: { type: 'object' } }];
      for (const toolChoice of ['auto', 'none', { name: 'http.request' }] as const) {
        await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }], tools, toolChoice, maxOutputTokens: 100 });
      }
      assert.deepEqual(bodies.map((b) => b['tool_choice']), [{ type: 'auto' }, { type: 'none' }, { type: 'tool', name: 'http__request' }]);
      assert.deepEqual(bodies.map((b) => b['max_tokens']), [100, 100, 100]);
    },
  );
});

test('anthropic responseFormat: emulated with a forced structured_output tool; its input becomes the text answer', async () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  await withServer(
    (_req, res) =>
      writeAnthropicSse(res, [
        { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 9, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name: STRUCTURED_OUTPUT_TOOL, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"verdict":"fail"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]),
    async (s, p) => {
      const deltas: StreamDelta[] = [];
      const r = await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'judge' }], responseFormat: { type: 'json_schema', name: 'decision', schema } }, { onDelta: (d) => deltas.push(d) });
      const body = s.requests[0]!.body;
      assert.deepEqual(body['tools'], [{ name: STRUCTURED_OUTPUT_TOOL, description: 'Return the final answer (decision) as structured JSON matching the input schema.', input_schema: schema }]);
      assert.deepEqual(body['tool_choice'], { type: 'tool', name: STRUCTURED_OUTPUT_TOOL });
      assert.deepEqual(r.message, { role: 'assistant', content: [{ type: 'text', text: '{"verdict":"fail"}' }] });
      assert.equal(r.stopReason, 'end_turn');
      assert.deepEqual(deltas, [{ type: 'text', text: '{"verdict":"fail"}' }]);
    },
  );
});

test('anthropic responseFormat with a non-object schema wraps as {value} and unwraps; with other tools the model must call some tool', async () => {
  await withServer(
    (_req, res) =>
      writeAnthropicSse(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name: STRUCTURED_OUTPUT_TOOL, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":[1,2]}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]),
    async (s, p) => {
      const r = await p.complete({
        model: MODEL,
        messages: [{ role: 'user', content: 'list' }],
        tools: [{ name: 'fs.list', description: 'ls', inputSchema: { type: 'object' } }],
        responseFormat: { type: 'json_schema', name: 'ids', schema: { type: 'array', items: { type: 'number' } } },
      });
      const body = s.requests[0]!.body;
      assert.deepEqual((body['tools'] as Array<Record<string, unknown>>)[1], {
        name: STRUCTURED_OUTPUT_TOOL,
        description: 'Return the final answer (ids) as structured JSON matching the input schema.',
        input_schema: { type: 'object', properties: { value: { type: 'array', items: { type: 'number' } } }, required: ['value'] },
      });
      assert.deepEqual(body['tool_choice'], { type: 'any' });
      assert.deepEqual(r.message.content, [{ type: 'text', text: '[1,2]' }]);
      assert.equal(r.message.toolCalls, undefined);
    },
  );
  const p = new AnthropicProvider({ apiKey: 'k' });
  await assert.rejects(
    p.complete({ model: MODEL, messages: [], tools: [{ name: STRUCTURED_OUTPUT_TOOL, description: '', inputSchema: {} }], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } }),
    (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument',
  );
});

test('anthropic in-stream error events: overloaded → unavailable (retryable), rate_limit → rate_limited, invalid_request → provider_error', async () => {
  let type = 'overloaded_error';
  await withServer(
    (_req, res) =>
      writeAnthropicSse(res, [
        { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } },
        { type: 'error', error: { type, message: `server says ${type}` } },
      ]),
    async (_s, p) => {
      const expectations: Array<[string, string, boolean]> = [
        ['overloaded_error', 'unavailable', true],
        ['rate_limit_error', 'rate_limited', true],
        ['invalid_request_error', 'provider_error', false],
        ['brand_new_error', 'unavailable', true],
      ];
      for (const [t, code, retryable] of expectations) {
        type = t;
        await assert.rejects(p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === code && e.retryable === retryable && e.details['errorType'] === t);
      }
    },
  );
});

test('anthropic HTTP errors: 429/529/400 mapping; truncated stream ⇒ unavailable', async () => {
  let mode: number | 'truncated' = 429;
  await withServer(
    (_req, res) => {
      if (mode === 'truncated') return writeAnthropicSse(res, [{ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } }]);
      return writeJson(res, mode, { type: 'error', error: { type: 'x', message: `bad ${KEY}` } });
    },
    async (_s, p) => {
      const call = () => p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
      for (const [st, code] of [[429, 'rate_limited'], [529, 'unavailable'], [400, 'provider_error'], [401, 'provider_error']] as const) {
        mode = st;
        await assert.rejects(call(), (e: unknown) => e instanceof HypertestError && e.code === code && e.details['status'] === st && !e.message.includes(KEY));
      }
      mode = 'truncated';
      await assert.rejects(call(), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && /before message_stop/.test(e.message));
    },
  );
});

test('anthropic non-streaming JSON message is supported (thinking, text, tool_use input object)', async () => {
  await withServer(
    (_req, res) =>
      writeJson(res, 200, {
        id: 'msg_json',
        type: 'message',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'S' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tu', name: 'fs__read', input: { path: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    async (_s, p) => {
      const r = await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
      assert.deepEqual(r.message, {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        toolCalls: [{ id: 'tu', name: 'fs.read', arguments: { path: 'x' } }],
        reasoning: { text: 'hmm', opaque: { compatibilityClass: `anthropic:${MODEL}`, data: [{ type: 'thinking', thinking: 'hmm', signature: 'S' }] } },
      });
      assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 6, cachedInputTokens: 0 });
      assert.equal(r.stopReason, 'tool_use');
    },
  );
});

test('anthropic stop reasons: max_tokens, refusal → content_filter; invalid tool JSON → {} + rawArguments', async () => {
  let reason = 'max_tokens';
  await withServer(
    (_req, res) =>
      writeAnthropicSse(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu', name: 'x', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    async (_s, p) => {
      let r = await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.stopReason, 'max_tokens');
      assert.deepEqual(r.message.toolCalls, [{ id: 'tu', name: 'x', arguments: {}, rawArguments: '{"a":' }]);
      reason = 'refusal';
      r = await p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.stopReason, 'content_filter');
    },
  );
});

test('anthropic: a stream cut mid-JSON with a clean EOF is a retryable unavailable (truncation), not a non-retryable provider_error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
      res.end('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"te');
    },
    async (_s, p) => {
      await assert.rejects(p.complete({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && e.retryable && /before message_stop/.test(e.message));
    },
  );
});

test('anthropic: model_context_window_exceeded maps to max_tokens (truncated output), not a normal end_turn', async () => {
  const { mapStopReason } = await import('../src/anthropic.ts');
  assert.equal(mapStopReason('model_context_window_exceeded', false, false), 'max_tokens');
  assert.equal(mapStopReason('pause_turn', false, false), 'end_turn');
  assert.equal(mapStopReason('stop_sequence', true, false), 'tool_use');
});

test('anthropic: an exception thrown by the caller onDelta callback is a non-retryable internal fault', async () => {
  await withServer(
    (_req, res) => writeAnthropicSse(res, streamEvents),
    async (_s, p) => {
      await assert.rejects(
        p.complete({ model: MODEL, messages: [{ role: 'user', content: 'go' }] }, { onDelta: () => { throw new Error('ui bug'); } }),
        (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /onDelta/.test(e.message),
      );
    },
  );
});
