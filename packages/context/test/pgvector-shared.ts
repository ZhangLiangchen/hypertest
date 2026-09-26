import assert from 'node:assert/strict';
import { HashEmbedder, InMemoryVectorIndex, createPgVectorIndex, type Embedder, type VectorDocument } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

export const DOCS: VectorDocument[] = [
  { id: 'd1', text: 'checkout rejects an empty cart with status 400', ref: { kind: 'file', id: 'src/cart.ts' }, path: 'src/cart.ts', line: 31, namespace: 'code' },
  { id: 'd2', text: 'guide for paying with the checkout flow', ref: { kind: 'file', id: 'docs/guide.md' }, path: 'docs/guide.md', namespace: 'doc' },
  { id: 'd3', text: 'metrics scrape of prometheus latency', ref: { kind: 'evidence', id: 'ev_m1' }, namespace: 'evidence' },
  { id: 'd4', text: 'empty cart edge case test for checkout', ref: { kind: 'file', id: 'test/cart.test.ts' }, path: 'test/cart.test.ts', line: 2, namespace: 'test' },
];

/** Behaviour shared by the PGlite and PostgreSQL suites. */
export async function exercisePgVector(db: Parameters<typeof createPgVectorIndex>[0]): Promise<void> {
  const embedder = new HashEmbedder();
  const idx = await createPgVectorIndex(db, embedder);
  await idx.upsert(DOCS);
  const mem = new InMemoryVectorIndex(embedder);
  await mem.upsert(DOCS);

  const q = { text: 'empty cart checkout' };
  const hits = await idx.search(q);
  const expected = await mem.search(q);
  assert.deepEqual(hits.map((h) => h.ref.id), expected.map((h) => h.ref.id), 'same ranking as exact in-memory cosine');
  hits.forEach((h, i) => assert.ok(Math.abs(h.score - expected[i]!.score) < 1e-5, `${h.ref.id} ${h.score} vs ${expected[i]!.score}`));
  assert.deepEqual(hits[0], { source: 'vector', ref: { kind: 'file', id: 'test/cart.test.ts' }, path: 'test/cart.test.ts', line: 2, snippet: 'empty cart edge case test for checkout', score: hits[0]!.score });

  assert.deepEqual((await idx.search({ ...q, kinds: ['doc', 'code'] })).map((h) => h.ref.id), ['src/cart.ts', 'docs/guide.md']);
  assert.deepEqual((await idx.search({ ...q, pathGlobs: ['docs/**'] })).map((h) => h.ref.id), ['docs/guide.md']);
  assert.equal((await idx.search({ ...q, limit: 1 })).length, 1);
  assert.deepEqual(await idx.search({ text: '' }), [], 'a zero query vector matches nothing');

  // Upsert replaces; remove deletes.
  await idx.upsert([{ ...DOCS[3]!, text: 'unrelated prometheus words' }]);
  assert.ok(!(await idx.search(q)).some((h) => h.ref.id === 'test/cart.test.ts'));
  await idx.remove(['d1', 'd2']);
  assert.deepEqual(await idx.search(q), []);

  // Vectors of another embedding model (same dims) are never compared.
  const other: Embedder = { dims: 256, modelId: 'other-model', embed: (t) => embedder.embed(t) };
  const otherIdx = await createPgVectorIndex(db, other);
  assert.deepEqual(await otherIdx.search({ text: 'prometheus latency' }), []);
  // …and never overwrite or remove each other's documents, even with the same document ids.
  await otherIdx.upsert([{ ...DOCS[2]!, text: 'other model text about prometheus latency' }]);
  const d3 = async () => (await idx.search({ text: 'prometheus latency' })).find((h) => h.ref.id === 'ev_m1')?.snippet;
  assert.equal(await d3(), 'metrics scrape of prometheus latency', 'model 1 keeps its own d3');
  assert.equal((await otherIdx.search({ text: 'prometheus latency' }))[0]?.snippet, 'other model text about prometheus latency');
  await otherIdx.remove(['d3']);
  assert.equal(await d3(), 'metrics scrape of prometheus latency', 'removal by model 2 leaves model 1 alone');
  assert.deepEqual(await otherIdx.search({ text: 'prometheus latency' }), []);

  // query.root scopes by path in SQL (documents without a path never match a root).
  await idx.upsert(DOCS);
  assert.deepEqual((await idx.search({ ...q, root: 'test' })).map((h) => h.ref.id), ['test/cart.test.ts']);
  assert.deepEqual((await idx.search({ ...q, root: 'src', limit: 1 })).map((h) => h.ref.id), ['src/cart.ts']);
  assert.deepEqual(await idx.search({ text: 'prometheus latency', root: 'src' }), []);
  await rejectsWith(idx.search({ ...q, root: '../x' }), 'invalid_argument');
  await idx.remove(DOCS.map((d) => d.id));
  // A table created for other dimensions is a conflict, not silent corruption.
  await rejectsWith(createPgVectorIndex(db, new HashEmbedder({ dims: 64 })), 'conflict');
}
