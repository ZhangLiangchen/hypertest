import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson } from '@hypertest/core';
import type { AssistantMessage, ChatMessage } from '@hypertest/domain';
import { normalizeContext, type AssistantMessage as PiAssistantMessage, type AssistantMessageEvent, type Message as PiMessage } from '@earendil-works/pi-ai';
import {
  HOST_API, HOST_PROVIDER, TRANSCRIPT_MODEL, fromPiAssistant, fromPiMessage, fromPiMessages, fromPiUsage, toPiAssistant, toPiMessage, toPiMessages, toPiUsage,
} from '../src/convert.ts';
import { assistantMessageStream, failedMessageStream } from '../src/stream.ts';

const TS = 1_780_000_000_000;

/** Every IR shape the engine persists or assembles, including degenerate ones. */
const CORPUS: Array<[string, ChatMessage]> = [
  ['system', { role: 'system', content: 'You are the executor.' }],
  ['empty system', { role: 'system', content: '' }],
  ['user text', { role: 'user', content: 'check the login flow' }],
  ['user empty parts', { role: 'user', content: [] }],
  ['user base64 image', { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }] }],
  ['user artifact image (no inline data)', { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/ab12' }] }],
  ['user image with data and uri', { role: 'user', content: [{ type: 'image', mimeType: 'image/webp', dataBase64: 'UklGRg==', artifactUri: 'artifact://sha256/cd34' }] }],
  ['user image with empty data', { role: 'user', content: [{ type: 'image', mimeType: 'image/gif', dataBase64: '' }] }],
  ['assistant text', { role: 'assistant', content: [{ type: 'text', text: 'looking' }] }],
  ['assistant empty', { role: 'assistant', content: [] }],
  ['assistant empty text part', { role: 'assistant', content: [{ type: 'text', text: '' }] }],
  [
    'assistant tool calls',
    { role: 'assistant', content: [{ type: 'text', text: 'probing' }], toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'a.txt', opts: { lines: [1, 2] } } }, { id: 'c2', name: 'http.request', arguments: {} }] },
  ],
  ['assistant explicit empty toolCalls', { role: 'assistant', content: [{ type: 'text', text: 'x' }], toolCalls: [] }],
  [
    'assistant malformed + non-object arguments',
    {
      role: 'assistant',
      content: [],
      toolCalls: [
        { id: 'm1', name: 'probe', arguments: null, rawArguments: '{"path": "a.txt"' },
        { id: 'm2', name: 'probe', arguments: [1, 'two'] },
        { id: 'm3', name: 'probe', arguments: 'scalar' },
        { id: 'm4', name: 'probe', arguments: { a: 1 }, rawArguments: '{"a":1,}' },
      ],
    },
  ],
  ['assistant reasoning text', { role: 'assistant', content: [{ type: 'text', text: 'answer' }], reasoning: { text: 'because' } }],
  ['assistant reasoning empty text', { role: 'assistant', content: [], reasoning: { text: '' } }],
  ['assistant opaque reasoning', { role: 'assistant', content: [], reasoning: { opaque: { compatibilityClass: 'anthropic:claude', data: { blocks: [{ thinking: 't', signature: 'sig' }] } } } }],
  [
    'assistant reasoning text + opaque + calls',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [{ id: 't1', name: 'test.run', arguments: { suite: 'unit' } }],
      reasoning: { text: 'plan', opaque: { compatibilityClass: 'pi-ai:openai-responses:openai:gpt', data: ['enc', 1, null] } },
    },
  ],
  ['assistant empty reasoning object', { role: 'assistant', content: [{ type: 'text', text: 'x' }], reasoning: {} }],
  [
    'assistant images interleaved with text',
    {
      role: 'assistant',
      content: [
        { type: 'image', mimeType: 'image/png', dataBase64: 'AAA=' },
        { type: 'text', text: 'between' },
        { type: 'image', mimeType: 'image/png', artifactUri: 'artifact://x' },
        { type: 'text', text: 'end' },
      ],
    },
  ],
  ['tool result', { role: 'tool', toolCallId: 'c1', toolName: 'fs.read', content: 'hello' }],
  ['tool result error', { role: 'tool', toolCallId: 'c2', toolName: 'probe', content: 'not executed', isError: true }],
  ['tool result explicit not-error', { role: 'tool', toolCallId: 'c3', toolName: 'probe', content: '', isError: false }],
];

describe('IR ⇄ pi-ai conversion', () => {
  for (const [name, message] of CORPUS) {
    test(`round-trips exactly: ${name}`, () => {
      const pi = toPiMessage(message, TS);
      const back = fromPiMessage(pi);
      assert.deepEqual(back, message);
      assert.equal(canonicalJson(back), canonicalJson(message));
      // pi objects are JSON (they are persisted/serialized by pi harnesses): the extension survives a JSON round-trip
      assert.deepEqual(fromPiMessage(JSON.parse(JSON.stringify(pi)) as PiMessage), message);
    });
  }

  test('whole transcripts round-trip and are accepted by pi-ai’s normalizeContext', () => {
    const transcript = CORPUS.map(([, m]) => m);
    const pi = toPiMessages(transcript, TS);
    assert.deepEqual(fromPiMessages(pi), transcript);
    assert.equal(normalizeContext({ messages: pi }).messages.length, transcript.length);
  });

  test('native pi mapping (extension only where pi has no slot)', () => {
    assert.deepEqual(toPiMessage({ role: 'user', content: [{ type: 'image', mimeType: 'image/png', dataBase64: 'AAA=' }] }, TS), {
      role: 'user',
      content: [{ type: 'image', data: 'AAA=', mimeType: 'image/png' }],
      timestamp: TS,
    });
    assert.deepEqual(toPiMessage({ role: 'tool', toolCallId: 'c1', toolName: 'probe', content: 'out' }, TS), {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'probe',
      content: [{ type: 'text', text: 'out' }],
      isError: false,
      timestamp: TS,
    });
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [{ id: 'c1', name: 'probe', arguments: { a: 1 } }], reasoning: { text: 'why' } };
    assert.deepEqual(toPiAssistant(assistant, { timestamp: TS, model: 'route_x', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningTokens: 5, costUsd: 0.25 } }), {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'hi' }, { type: 'toolCall', id: 'c1', name: 'probe', arguments: { a: 1 } }],
      api: HOST_API,
      provider: HOST_PROVIDER,
      model: 'route_x',
      usage: { input: 70, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 120, reasoning: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } },
      stopReason: 'toolUse',
      timestamp: TS,
    });
    const history = toPiMessage({ role: 'assistant', content: [{ type: 'text', text: 'bye' }] }, TS) as PiAssistantMessage;
    assert.equal(history.model, TRANSCRIPT_MODEL);
    assert.equal(history.stopReason, 'stop');
    assert.equal('hypertest' in history, false);
  });

  test('the recorded arguments are copied, so pi can never mutate the recorded response', () => {
    const args = { nested: { n: 1 } };
    const pi = toPiAssistant({ role: 'assistant', content: [], toolCalls: [{ id: 'c', name: 'x', arguments: args }] }, { timestamp: TS });
    const call = pi.content[0];
    assert.ok(call?.type === 'toolCall');
    (call.arguments['nested'] as { n: number }).n = 2;
    assert.equal(args.nested.n, 1);
  });

  test('pi-native messages (no extension) map naturally', () => {
    const fromProvider: PiAssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'a', thinkingSignature: 'sig' },
        { type: 'thinking', thinking: 'b' },
        { type: 'text', text: 'answer' },
        { type: 'toolCall', id: 'x1', name: 'probe', arguments: { q: 'z' }, thoughtSignature: 'ts' },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: toPiUsage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }),
      stopReason: 'toolUse',
      timestamp: TS,
    };
    assert.deepEqual(fromPiAssistant(fromProvider), { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [{ id: 'x1', name: 'probe', arguments: { q: 'z' } }], reasoning: { text: 'a\nb' } });
    // pi's tool-declaration system messages are pi bookkeeping: no IR form
    const declaration: PiMessage = { role: 'system', content: '', toolsAdded: [{ name: 'probe', description: 'd', parameters: {} as never }], timestamp: TS };
    assert.equal(fromPiMessage(declaration), undefined);
    assert.deepEqual(fromPiMessages([declaration, { role: 'user', content: 'hi', timestamp: TS }]), [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(fromPiMessage({ role: 'system', content: [{ type: 'text', text: 'base' }], sections: { rules: '<rules>x</rules>', gone: null }, timestamp: TS }), { role: 'system', content: 'base\n\n<rules>x</rules>' });
    assert.deepEqual(
      fromPiMessage({ role: 'toolResult', toolCallId: 't', toolName: 'shot', content: [{ type: 'text', text: 'see ' }, { type: 'image', data: 'AAA=', mimeType: 'image/png' }], isError: false, timestamp: TS }),
      { role: 'tool', toolCallId: 't', toolName: 'shot', content: 'see [image image/png]' },
    );
    assert.deepEqual(fromPiMessage({ role: 'user', content: [{ type: 'image', data: 'AAA=', mimeType: 'image/png' }], timestamp: TS }), { role: 'user', content: [{ type: 'image', mimeType: 'image/png', dataBase64: 'AAA=' }] });
  });

  test('a malformed extension is ignored, never trusted', () => {
    const pi = { role: 'assistant', content: [{ type: 'text', text: 'x' }], api: HOST_API, provider: HOST_PROVIDER, model: 'm', usage: toPiUsage(undefined), stopReason: 'stop', timestamp: TS, hypertest: { images: [{ at: 'zero', part: { type: 'image' } }, { at: 0, part: { type: 'text', text: 'not an image' } }], opaque: 'nope' } } as unknown as PiMessage;
    assert.deepEqual(fromPiMessage(pi), { role: 'assistant', content: [{ type: 'text', text: 'x' }] });
  });

  test('usage converts both ways (the IR counts cached input in inputTokens)', () => {
    const usage = { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 200, reasoningTokens: 40, costUsd: 0.0125 };
    assert.deepEqual(fromPiUsage(toPiUsage(usage)), usage);
    assert.deepEqual(fromPiUsage(toPiUsage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });
});

describe('StreamFn shim streams', () => {
  async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
    const out: AssistantMessageEvent[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  test('a host response is replayed through pi-ai’s streaming protocol and resolves to the same message', async () => {
    const message = toPiAssistant(
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], reasoning: { text: 'why' }, toolCalls: [{ id: 'c1', name: 'probe', arguments: { a: 1 } }] },
      { timestamp: TS, model: 'route_x' },
    );
    const stream = assistantMessageStream(message);
    const events = await collect(stream);
    assert.deepEqual(events.map((e) => e.type), ['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
    const deltas = events.flatMap((e) => ('delta' in e ? [e.delta] : []));
    assert.deepEqual(deltas, ['why', 'hi', '{"a":1}']);
    const done = events.at(-1)!;
    assert.ok(done.type === 'done');
    assert.equal(done.reason, 'toolUse');
    assert.equal(done.message, message);
    assert.equal(await stream.result(), message);
    const end = events.find((e) => e.type === 'toolcall_end');
    assert.ok(end?.type === 'toolcall_end');
    assert.deepEqual(end.toolCall, message.content[2]);
  });

  test('a request without a response ends with an error event (no generation)', async () => {
    const stream = failedMessageStream('error', 'route A unavailable', TS);
    const events = await collect(stream);
    assert.deepEqual(events.map((e) => e.type), ['error']);
    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
    assert.equal(result.errorMessage, 'route A unavailable');
    assert.deepEqual(result.content, []);
    assert.equal((await failedMessageStream('aborted', 'stop', TS).result()).stopReason, 'aborted');
  });
});
