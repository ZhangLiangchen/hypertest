import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolNameMap, WIRE_TOOL_NAME, codeForHttpStatus } from '../src/index.ts';
import { readSse, withDeadline } from '../src/transport.ts';
import { httpStatusError, scrubSecrets } from '../src/errors.ts';
import { HypertestError } from '@hypertest/core';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const e of readSse(streamOf(chunks), 't')) out.push(e);
  return out;
}

test('sse: data/event fields, comments, CRLF, multi-line data, chunk splits, trailing complete line without blank line', async () => {
  const events = await collect([': keepalive\n\n', 'event: a\r', '\ndata: {"x":', '1}\r\n\r\n', 'data: line1\ndata: line2\n\n', 'data:nospace\n', '\n', 'data: tail\n']);
  assert.deepEqual(events, [{ event: 'a', data: '{"x":1}' }, { data: 'line1\nline2' }, { data: 'nospace' }, { data: 'tail' }]);
  // A line terminated by a lone CR at EOF is complete too.
  assert.deepEqual(await collect(['data: cr\r']), [{ data: 'cr' }]);
});

test('sse: a stream cut in the middle of a line at EOF drops the partial line (truncation is not a payload)', async () => {
  assert.deepEqual(await collect(['data: {"a":1}\n\n', 'data: {"b":']), [{ data: '{"a":1}' }]);
  // Earlier complete data lines of the same event survive; only the partial line is dropped.
  assert.deepEqual(await collect(['data: one\n', 'data: tw']), [{ data: 'one' }]);
  assert.deepEqual(await collect(['data: {"a":1}\n\n', 'event: x\ndata: {"b"']), [{ data: '{"a":1}' }]);
});

test('sse: multi-byte UTF-8 split across chunks is decoded correctly', async () => {
  const enc = new TextEncoder();
  const bytes = enc.encode('data: 测试✓\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 8));
      c.enqueue(bytes.slice(8));
      c.close();
    },
  });
  const out = [];
  for await (const e of readSse(body, 't')) out.push(e.data);
  assert.deepEqual(out, ['测试✓']);
});

test('tool names: dots map to __ and round-trip exactly; collisions and invalid names get unique hashed wire names', () => {
  const m = new ToolNameMap();
  assert.equal(m.encode('fs.read'), 'fs__read');
  assert.equal(m.encode('fs.read'), 'fs__read');
  const clash = m.encode('fs__read');
  assert.notEqual(clash, 'fs__read');
  assert.match(clash, WIRE_TOOL_NAME);
  const weird = m.encode('mcp:server/tool name!');
  assert.match(weird, WIRE_TOOL_NAME);
  const long = m.encode('a.'.repeat(40) + 'z');
  assert.match(long, WIRE_TOOL_NAME);
  for (const n of ['fs.read', 'fs__read', 'mcp:server/tool name!', 'a.'.repeat(40) + 'z']) assert.equal(m.decode(m.encode(n)), n);
  assert.equal(m.known('fs__read'), true);
  assert.equal(m.decode('git__diff'), 'git.diff');
  assert.equal(m.known('git__diff'), false);
});

test('http status taxonomy: 429 rate_limited, 408/5xx unavailable, other 4xx provider_error (non-retryable)', () => {
  assert.equal(codeForHttpStatus(429), 'rate_limited');
  for (const s of [408, 500, 502, 503, 504, 529]) assert.equal(codeForHttpStatus(s), 'unavailable');
  for (const s of [400, 401, 403, 404, 409, 413, 422]) assert.equal(codeForHttpStatus(s), 'provider_error');
  const e = httpStatusError('p', 400, 'bad key sk-SECRET-123 here', ['sk-SECRET-123'], null);
  assert.equal(e.retryable, false);
  assert.ok(!e.message.includes('sk-SECRET-123'));
  assert.equal(httpStatusError('p', 429, '', [], '2').details['retryAfterMs'], 2000);
  assert.equal(httpStatusError('p', 503, '', []).retryable, true);
  assert.equal(scrubSecrets('abc KEYX abc', ['KEYX', undefined, 'ab']), 'abc [redacted] abc'); // secrets shorter than 4 chars are ignored
});

test('withDeadline: timeout vs caller cancel vs other failures, even when fn ignores its signal', async () => {
  const never = () => new Promise<never>(() => undefined);
  const normalize = (e: unknown) => (e instanceof HypertestError ? e : new HypertestError('unavailable', String(e)));
  await assert.rejects(withDeadline({ timeoutMs: 20, what: 'x', normalize }, never), (e: unknown) => e instanceof HypertestError && e.code === 'timeout');
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  await assert.rejects(withDeadline({ timeoutMs: 5000, signal: c.signal, what: 'x', normalize }, never), (e: unknown) => e instanceof HypertestError && e.code === 'cancelled');
  await assert.rejects(
    withDeadline({ timeoutMs: 5000, what: 'x', normalize }, async () => {
      throw new TypeError('fetch failed');
    }),
    (e: unknown) => e instanceof HypertestError && e.code === 'unavailable',
  );
  assert.equal(await withDeadline({ timeoutMs: 5000, what: 'x', normalize }, async () => 42), 42);
});

test('withDeadline: an over-large or infinite timeout never fires immediately (Node clamps >2^31-1ms timers to 1ms); NaN/<=0 is invalid', async () => {
  const normalize = (e: unknown) => (e instanceof HypertestError ? e : new HypertestError('unavailable', String(e)));
  const slowOk = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 'ok';
  };
  assert.equal(await withDeadline({ timeoutMs: Number.POSITIVE_INFINITY, what: 'x', normalize }, slowOk), 'ok');
  assert.equal(await withDeadline({ timeoutMs: 3_000_000_000, what: 'x', normalize }, slowOk), 'ok');
  for (const bad of [Number.NaN, 0, -5]) {
    await assert.rejects(withDeadline({ timeoutMs: bad, what: 'x', normalize }, slowOk), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && !e.retryable, String(bad));
  }
});
