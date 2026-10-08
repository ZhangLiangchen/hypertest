import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HashEmbedder, InMemoryVectorIndex, OpenAICompatibleEmbedder } from '../src/index.ts';

/**
 * (B[6]) The optional semantic embedding route: an OpenAI-compatible `POST /embeddings` (`retrieval.embedder`), exercised
 * against a fake fetch only — no request leaves the process. Every answer is verified (count, order by index, dimensions,
 * finite numbers); a failure is provider_error and never echoes the API key.
 */

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[] };
}

/** A fake /embeddings server: vectors from the hashing embedder (semantic enough for a ranking test), optional faults. */
function fakeFetch(options: { dims: number; fault?: (body: Seen['body']) => Response | undefined } = { dims: 32 }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const inner = new HashEmbedder({ dims: options.dims });
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Seen['body'];
    seen.push({ url: String(input), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body });
    const faulty = options.fault?.(body);
    if (faulty) return faulty;
    const vectors = await inner.embed(body.input);
    // answer in reverse order: the client must order by `index`
    const data = vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })).reverse();
    return new Response(JSON.stringify({ object: 'list', data, model: body.model }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, seen };
}

test('request shape, batching, index ordering, auth header; ranks semantically through the vector index', async () => {
  const f = fakeFetch({ dims: 32 });
  const e = new OpenAICompatibleEmbedder({ baseUrl: 'http://embeddings.test/v1/', model: 'text-embed-small', dimensions: 32, apiKey: 'sk-test-123', headers: { 'x-org': 'qa' }, batchSize: 2, fetch: f.fetch });
  assert.equal(e.modelId, 'openai-compatible:text-embed-small:32');
  const vecs = await e.embed(['parse the invoice total', 'round half up', '', 'checkout cart']);
  assert.equal(vecs.length, 4);
  assert.deepEqual(vecs[0], await new HashEmbedder({ dims: 32 }).embedOne('parse the invoice total'), 'reordered by index');
  assert.deepEqual(f.seen.map((s) => [s.url, s.body.model, s.body.input]), [
    ['http://embeddings.test/v1/embeddings', 'text-embed-small', ['parse the invoice total', 'round half up']],
    ['http://embeddings.test/v1/embeddings', 'text-embed-small', [' ', 'checkout cart']],
  ]);
  assert.equal(f.seen[0]!.headers['authorization'], 'Bearer sk-test-123');
  assert.equal(f.seen[0]!.headers['x-org'], 'qa');
  const index = new InMemoryVectorIndex(e);
  await index.upsert([
    { id: 'a', text: 'function invoiceTotal(lines) { return sum(lines) }', ref: { kind: 'file', id: 'a.ts' }, namespace: 'code' },
    { id: 'b', text: 'function renderHeader() { return "<h1>" }', ref: { kind: 'file', id: 'b.ts' }, namespace: 'code' },
  ]);
  assert.equal((await index.search({ text: 'invoice total' }))[0]!.ref.id, 'a.ts');
});

test('a malformed or failing answer is provider_error (never padded, never silently zero), without the API key', async () => {
  const cases: Array<[string, (b: Seen['body']) => Response | undefined, RegExp]> = [
    ['HTTP 401', () => new Response('{"error":"bad key"}', { status: 401 }), /answered HTTP 401: \{"error":"bad key"\}/],
    ['wrong dimensions', (b) => new Response(JSON.stringify({ data: b.input.map((_, index) => ({ index, embedding: [0.1, 0.2] })) })), /is not 32 finite numbers \(model m; check retrieval\.embedder\.dimensions\)/],
    ['too few vectors', () => new Response(JSON.stringify({ data: [] })), /returned 0 vectors for 1 texts/],
    ['out-of-range index', (b) => new Response(JSON.stringify({ data: b.input.map(() => ({ index: 5, embedding: new Array(32).fill(0.1) })) })), /returned an invalid or duplicate index 5/],
    ['non-finite numbers', (b) => new Response(JSON.stringify({ data: b.input.map((_, index) => ({ index, embedding: new Array(32).fill(null) })) })), /is not 32 finite numbers/],
    ['invalid JSON', () => new Response('not json', { status: 200 }), /answered invalid JSON/],
  ];
  for (const [name, fault, message] of cases) {
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'http://embeddings.test/v1', model: 'm', dimensions: 32, apiKey: 'sk-secret-xyz', fetch: fakeFetch({ dims: 32, fault }).fetch });
    await assert.rejects(e.embed(['x']), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'provider_error', name);
      assert.match(err.message, message, name);
      assert.ok(!err.message.includes('sk-secret-xyz'), `${name}: the key is never in an error`);
      return true;
    });
  }
  const dup = new OpenAICompatibleEmbedder({ baseUrl: 'http://embeddings.test/v1', model: 'm', dimensions: 32, fetch: fakeFetch({ dims: 32, fault: (b) => new Response(JSON.stringify({ data: b.input.map(() => ({ index: 0, embedding: new Array(32).fill(0.1) })) })) }).fetch });
  await assert.rejects(dup.embed(['x', 'y']), /returned an invalid or duplicate index 0/);
  const unreachable = new OpenAICompatibleEmbedder({ baseUrl: 'http://embeddings.test/v1', model: 'm', dimensions: 32, fetch: (async () => { throw new TypeError('connect ECONNREFUSED'); }) as typeof fetch });
  await assert.rejects(unreachable.embed(['x']), /provider_error|embeddings request to http:\/\/embeddings\.test\/v1\/embeddings failed: connect ECONNREFUSED/);
  assert.deepEqual(await unreachable.embed([]), [], 'nothing to embed sends nothing');
});

test('invalid configuration is refused at construction', () => {
  assert.throws(() => new OpenAICompatibleEmbedder({ baseUrl: 'file:///etc', model: 'm', dimensions: 8 }), /needs an http\(s\) baseUrl/);
  assert.throws(() => new OpenAICompatibleEmbedder({ baseUrl: 'http://x/v1', model: ' ', dimensions: 8 }), /needs a model/);
  assert.throws(() => new OpenAICompatibleEmbedder({ baseUrl: 'http://x/v1', model: 'm', dimensions: 0 }), /dimensions must be an integer/);
  assert.throws(() => new OpenAICompatibleEmbedder({ baseUrl: 'http://x/v1', model: 'm', dimensions: 8, timeoutMs: -1 }), /timeoutMs must be a positive number/);
  assert.throws(() => new OpenAICompatibleEmbedder({ baseUrl: 'http://x/v1', model: 'm', dimensions: 8, batchSize: 0 }), /batchSize must be a positive integer/);
});
