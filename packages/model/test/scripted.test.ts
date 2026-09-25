import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import { estimateTokens } from '@hypertest/domain';
import { ScriptedProvider, type ModelCallRequest, type StreamDelta } from '../src/index.ts';

const req = (model = 'm1', extra: Partial<ModelCallRequest> = {}): ModelCallRequest => ({ model, messages: [{ role: 'user', content: 'hello world' }], ...extra });

test('scripted: brain receives request, 0-based callIndex and routeModel; replies map to AssistantMessage', async () => {
  const seen: Array<[number, string]> = [];
  const p = new ScriptedProvider({
    brain: (r, info) => {
      seen.push([info.callIndex, info.routeModel]);
      return info.callIndex === 0 ? { text: `echo:${r.messages.length}` } : { toolCalls: [{ name: 'fs.read', arguments: { path: 'a' } }, { name: 'git.diff', arguments: {}, id: 'mine' }] };
    },
  });
  assert.equal(p.providerId, 'scripted');
  const r1 = await p.complete(req('m1'));
  assert.deepEqual(r1.message, { role: 'assistant', content: [{ type: 'text', text: 'echo:1' }] });
  assert.equal(r1.stopReason, 'end_turn');
  const r2 = await p.complete(req('m2'));
  assert.deepEqual(r2.message.content, []);
  assert.deepEqual(r2.message.toolCalls, [
    { id: 'call_1', name: 'fs.read', arguments: { path: 'a' } },
    { id: 'mine', name: 'git.diff', arguments: {} },
  ]);
  assert.equal(r2.stopReason, 'tool_use');
  assert.deepEqual(seen, [[0, 'm1'], [1, 'm2']]);
  assert.equal(p.callCount, 2);
  const r3 = await p.complete(req('m1'));
  assert.deepEqual(r3.message.toolCalls?.map((c) => c.id), ['call_2', 'mine']);
});

test('scripted: brains keyed by model take precedence; missing brain is a non-retryable not_found', async () => {
  const p = new ScriptedProvider({ providerId: 'fake', brains: { big: () => ({ text: 'big' }) } });
  assert.equal((await p.complete(req('big'))).message.content[0]?.type, 'text');
  await assert.rejects(p.complete(req('small')), (e: unknown) => e instanceof HypertestError && e.code === 'not_found' && e.retryable === false);
  const q = new ScriptedProvider({ brain: () => ({ text: 'default' }), brains: { big: () => ({ text: 'big' }) } });
  assert.deepEqual((await q.complete(req('other'))).message.content, [{ type: 'text', text: 'default' }]);
});

test('scripted: error replies throw HypertestErrors with matching codes and retryability', async () => {
  const cases = [
    ['timeout', true],
    ['rate_limited', true],
    ['unavailable', true],
    ['provider_error', false],
  ] as const;
  for (const [code, retryable] of cases) {
    const p = new ScriptedProvider({ brain: () => ({ error: code, message: `boom ${code}` }) });
    await assert.rejects(p.complete(req()), (e: unknown) => e instanceof HypertestError && e.code === code && e.retryable === retryable && e.message === `boom ${code}`);
  }
  const p = new ScriptedProvider({ brain: () => ({ error: 'unavailable' }) });
  await assert.rejects(p.complete(req()), /scripted unavailable/);
});

test('scripted: usage defaults are estimated from estimateTokens; explicit usage overrides; latency measured', async () => {
  const p = new ScriptedProvider({ brain: () => ({ text: 'x'.repeat(40) }), latencyMs: 15 });
  const r = await p.complete(req());
  assert.deepEqual(r.usage, { inputTokens: estimateTokens(req().messages), outputTokens: 10, cachedInputTokens: 0 });
  assert.ok(r.latencyMs >= 14, `latency ${r.latencyMs}`);
  const q = new ScriptedProvider({ brain: () => ({ text: 'x', usage: { inputTokens: 7, cachedInputTokens: 3, costUsd: 0.5 } }) });
  assert.deepEqual((await q.complete(req())).usage, { inputTokens: 7, outputTokens: 1, cachedInputTokens: 3, costUsd: 0.5 });
});

test('scripted: deltas are streamed; explicit stopReason is honored', async () => {
  const p = new ScriptedProvider({ brain: () => ({ text: 'hi', toolCalls: [{ name: 't', arguments: [1] }], stopReason: 'max_tokens' }) });
  const deltas: StreamDelta[] = [];
  const r = await p.complete(req(), { onDelta: (d) => deltas.push(d) });
  assert.equal(r.stopReason, 'max_tokens');
  assert.deepEqual(deltas, [
    { type: 'text', text: 'hi' },
    { type: 'tool_call_start', id: 'call_1', name: 't' },
    { type: 'tool_call_args', id: 'call_1', text: '[1]' },
  ]);
});

test('scripted: timeoutMs and caller abort are enforced while the brain is thinking', async () => {
  const slow = new ScriptedProvider({ latencyMs: 5_000, brain: () => ({ text: 'late' }) });
  const t0 = Date.now();
  await assert.rejects(slow.complete(req('m', { timeoutMs: 30 })), (e: unknown) => e instanceof HypertestError && e.code === 'timeout' && e.retryable);
  assert.ok(Date.now() - t0 < 2000);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(slow.complete(req('m', { signal: ctrl.signal })), (e: unknown) => e instanceof HypertestError && e.code === 'cancelled' && !e.retryable);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(new ScriptedProvider({ brain: () => ({ text: 'x' }) }).complete(req('m', { signal: pre.signal })), (e: unknown) => e instanceof HypertestError && e.code === 'cancelled');
});

test('scripted: a throwing brain surfaces as a non-retryable internal error', async () => {
  const p = new ScriptedProvider({
    brain: () => {
      throw new Error('brain bug');
    },
  });
  await assert.rejects(p.complete(req()), (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /brain bug/.test(e.message));
});

test('scripted: a brain returning a non-object reply (brain bug) is a non-retryable internal HypertestError, not a raw TypeError', async () => {
  for (const bad of [undefined, null, 'text', 42]) {
    const p = new ScriptedProvider({ brain: () => bad as never });
    await assert.rejects(p.complete(req()), (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /brain returned/.test(e.message), String(bad));
  }
});

test('scripted: an exception thrown by the caller onDelta callback is a non-retryable internal fault', async () => {
  const p = new ScriptedProvider({ brain: () => ({ text: 'hi' }) });
  await assert.rejects(
    p.complete(req(), { onDelta: () => { throw new Error('ui bug'); } }),
    (e: unknown) => e instanceof HypertestError && e.code === 'internal' && !e.retryable && /onDelta/.test(e.message),
  );
});
