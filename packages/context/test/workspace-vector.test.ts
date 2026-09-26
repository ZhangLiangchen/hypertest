import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { createTestDatabase } from '@hypertest/store';
import { createGitRepo, tempDir } from '@hypertest/testkit';
import {
  ExactSearch,
  HashEmbedder,
  HybridRetriever,
  InMemoryVectorIndex,
  SymbolIndex,
  VectorCorpusCache,
  WorkspaceVectorRetriever,
  chunkText,
  createPgVectorIndex,
  gitHeadCommit,
  type Embedder,
  type VectorIndex,
} from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_CONFIG_NOSYSTEM: '1' } });

/**
 * L3 semantic retrieval actually used (conformance: "L3 hybrid retrieval … vectors (pgvector)"): workspace files are
 * chunked by symbol/section, embedded lazily into a corpus cached per workspace + commit, in memory or in pgvector.
 */
const LEDGER = [
  '/** Moves money between two accounts; the total balance is conserved. */',
  'export function applyTransfer(accounts, from, to, amount) {',
  '  accounts[from] -= amount;',
  '  accounts[to] += amount;',
  '  return accounts;',
  '}',
  '',
  '/** Returns one page of items (1-based page number). */',
  'export function paginate(items, page, size) {',
  '  const start = (page - 1) * size;',
  '  return items.slice(start, start + size);',
  '}',
  '',
].join('\n');

let repo: Awaited<ReturnType<typeof createGitRepo>>;
before(async () => {
  repo = await createGitRepo({
    'src/ledger.js': LEDGER,
    'README.md': '# Ledger\n\nA tiny ledger.\n\n## Interest\n\nCompound interest is computed monthly.\n',
    'tests/ledger.test.js': "import { paginate } from '../src/ledger.js';\ntest('first page', () => paginate([1, 2, 3], 1, 2));\n",
    'data/big.bin': 'binary\u0000content',
    '.gitignore': 'ignored/\n',
    'ignored/secret.js': 'export const transferSecret = 1;\n',
  }, [{ message: 'second', files: { 'src/interest.js': 'export function computeInterest(balance, rate) {\n  return balance * rate;\n}\n' } }]);
});
after(async () => {
  await repo.cleanup();
});

/** Counts the texts an embedder is asked to embed (population must be lazy and happen once per corpus). */
function counting(): Embedder & { texts: number } {
  const inner = new HashEmbedder();
  const e = { dims: inner.dims, modelId: inner.modelId, texts: 0, embed: async (t: string[]) => { e.texts += t.length; return inner.embed(t); } };
  return e;
}

test('chunkText: symbol bodies, markdown sections, bounded windows; blank chunks dropped; options validated', () => {
  const code = chunkText('src/ledger.js', LEDGER);
  assert.deepEqual(code.map((c) => [c.startLine, c.endLine, c.symbol, c.kind]), [[1, 1, undefined, 'code'], [2, 8, 'applyTransfer', 'code'], [9, 13, 'paginate', 'code']]);
  assert.match(code[1]!.text, /accounts\[from\] -= amount/);
  const doc = chunkText('README.md', '# Ledger\n\nintro\n\n## Interest\n\nmonthly\n');
  assert.deepEqual(doc.map((c) => [c.startLine, c.symbol, c.kind]), [[1, 'Ledger', 'doc'], [5, 'Interest', 'doc']]);
  const long = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(chunkText('notes.txt', long, { maxLines: 10 }).map((c) => [c.startLine, c.endLine]), [[1, 10], [11, 20], [21, 25]]);
  assert.equal(chunkText('big.txt', 'x'.repeat(10_000), { maxChars: 100 })[0]!.text.length, 100);
  assert.deepEqual(chunkText('blank.txt', '\n\n  \n'), []);
  assert.throws(() => chunkText('a.txt', 'x', { maxLines: 0 }), /positive integers/);
});

test('gitHeadCommit: the checked-out commit of a repository, a linked worktree (gitdir file + commondir), a detached HEAD and packed refs', async () => {
  assert.equal(await gitHeadCommit(repo.path), repo.commits[1]);
  assert.equal(await gitHeadCommit(join(repo.path, 'src')), repo.commits[1], 'a subdirectory resolves to its repository');
  const wtBase = await tempDir('ht-wt-');
  try {
    const wt = join(wtBase.path, 'wt');
    await git(repo.path, 'worktree', 'add', '-q', '-b', 'side', wt, repo.commits[0]!);
    assert.equal(await gitHeadCommit(wt), repo.commits[0]);
    await git(repo.path, 'pack-refs', '--all');
    assert.equal(await gitHeadCommit(wt), repo.commits[0], 'the branch ref only exists in packed-refs now');
    await git(wt, 'checkout', '-q', '--detach', repo.commits[1]!);
    assert.equal(await gitHeadCommit(wt), repo.commits[1]);
    await git(repo.path, 'worktree', 'remove', '--force', wt);
  } finally {
    await wtBase.cleanup();
  }
  const plain = await tempDir('ht-nogit-');
  try {
    assert.equal(await gitHeadCommit(plain.path), undefined);
  } finally {
    await plain.cleanup();
  }
});

test('in memory: populated lazily once per commit; semantic hits carry path + line; kinds and root filter; ignored/binary files skipped', async () => {
  const embedder = counting();
  const r = new WorkspaceVectorRetriever({ root: repo.path, embedder });
  assert.equal(embedder.texts, 0, 'nothing is embedded before the first search');
  const hits = await r.search({ text: 'move money from one account to another', limit: 3 });
  assert.deepEqual([hits[0]!.source, hits[0]!.path, hits[0]!.line, hits[0]!.ref], ['vector', 'src/ledger.js', 2, { kind: 'file', id: 'src/ledger.js', note: 'applyTransfer' }]);
  const populated = embedder.texts;
  const stats = await r.corpus();
  assert.deepEqual([stats.files, stats.shared, stats.truncated], [4, false, false], 'ledger.js, interest.js, README.md, the test — not the ignored or binary file');
  assert.equal(stats.documents + 1, populated, 'every chunk once, plus the query');
  await r.search({ text: 'compound interest monthly' });
  assert.equal(embedder.texts, populated + 1, 'later searches embed only their query');
  assert.deepEqual((await r.search({ text: 'compound interest', kinds: ['doc'] })).map((h) => h.path), ['README.md']);
  assert.deepEqual((await r.search({ text: 'paginate first page', kinds: ['test'] })).map((h) => h.path), ['tests/ledger.test.js']);
  assert.ok((await r.search({ text: 'interest balance rate', root: 'src' })).every((h) => h.path!.startsWith('src/')));
  assert.deepEqual(await r.search({ text: 'anything', kinds: ['record'] }), [], 'non-file kinds are not in a workspace corpus');
  assert.ok(!(await r.search({ text: 'transferSecret', limit: 50 })).some((h) => h.path!.startsWith('ignored/')));
  await rejectsWith(r.search({ text: 'x', limit: Number.NaN }), 'invalid_argument');
});

test('a new commit re-populates the corpus (cache key = workspace + commit); the old corpus leaves a shared index', async () => {
  const work = await createGitRepo({ 'src/a.js': 'export function refundPayment() {\n  return 1;\n}\n' });
  try {
    const removed: string[][] = [];
    const inner = new InMemoryVectorIndex(new HashEmbedder());
    const shared: VectorIndex = { name: 'vector', upsert: (d) => inner.upsert(d), remove: async (ids) => { removed.push(ids); await inner.remove(ids); }, search: (q, s) => inner.search(q, s) };
    const r = new WorkspaceVectorRetriever({ root: work.path, embedder: new HashEmbedder(), sharedIndex: async () => shared });
    const before = await r.corpus();
    assert.equal(before.shared, true);
    assert.deepEqual((await r.search({ text: 'refund payment' })).map((h) => h.path), ['src/a.js']);
    await writeFile(join(work.path, 'src/b.js'), 'export function chargebackDispute() {\n  return 2;\n}\n');
    // uncommitted: the corpus is unchanged (keyed by commit)
    assert.deepEqual((await r.search({ text: 'chargeback dispute' })).map((h) => h.path), []);
    await git(work.path, 'add', '-A');
    await git(work.path, 'commit', '-q', '-m', 'b');
    const after = await r.corpus();
    assert.notEqual(after.key, before.key);
    assert.deepEqual((await r.search({ text: 'chargeback dispute' })).map((h) => h.path), ['src/b.js']);
    for (let i = 0; i < 50 && removed.length === 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(removed.length, 1, 'the outdated corpus was removed from the shared index');
    assert.ok(removed[0]!.every((id) => id.startsWith(`${before.key}:`)));
  } finally {
    await work.cleanup();
  }
});

test('a shared index that is unavailable falls back to memory; bounds truncate the corpus; a failed population is retried', async () => {
  const r = new WorkspaceVectorRetriever({ root: repo.path, embedder: new HashEmbedder(), sharedIndex: async () => Promise.reject(new Error('no pgvector')), maxFiles: 1 });
  const c = await r.corpus();
  assert.deepEqual([c.shared, c.files, c.truncated], [false, 1, true]);
  let fail = true;
  const flaky: Embedder = { dims: 256, modelId: 'hash-v1-256', embed: async (t) => { if (fail) throw new Error('embedder down'); return new HashEmbedder().embed(t); } };
  const r2 = new WorkspaceVectorRetriever({ root: repo.path, embedder: flaky });
  await assert.rejects(r2.search({ text: 'transfer' }), /embedder down/);
  fail = false;
  assert.ok((await r2.search({ text: 'transfer money accounts' })).length > 0, 'the next search populates again');
  assert.throws(() => new WorkspaceVectorRetriever({ root: '', embedder: new HashEmbedder() }), /root/);
  assert.throws(() => new WorkspaceVectorRetriever({ root: repo.path, embedder: new HashEmbedder(), maxChunks: 0 }), /maxChunks/);
});

test('hybrid: symbol + exact + vector fused (RRF); a prose objective reaches code no identifier names', async () => {
  const hybrid = new HybridRetriever([new SymbolIndex({ root: repo.path }), new ExactSearch({ root: repo.path, ripgrep: false }), new WorkspaceVectorRetriever({ root: repo.path, embedder: new HashEmbedder() })]);
  // no identifier and no literal line says this: only the vector retriever reaches the README section
  const prose = await hybrid.search({ text: 'how is compound interest applied monthly', limit: 5 });
  const section = prose.find((h) => h.path === 'README.md');
  assert.deepEqual([section?.line, section?.source], [5, 'vector']);
  const symbolOnly = new HybridRetriever([new SymbolIndex({ root: repo.path }), new ExactSearch({ root: repo.path, ripgrep: false })]);
  assert.ok(!(await symbolOnly.search({ text: 'how is compound interest applied monthly', limit: 5 })).some((h) => h.path === 'README.md'), 'without vectors the section is not found');
  // an identifier: the symbol definition and the vector chunk of the same line fuse into one top hit
  const named = await hybrid.search({ text: 'paginate', limit: 5 });
  const def = named.find((h) => `${h.path}:${h.line}` === 'src/ledger.js:9');
  assert.ok(def && named.indexOf(def) < 2, JSON.stringify(named.map((h) => `${h.path}:${h.line}`)));
  assert.ok(def.score > 2 / 62, 'fused from the symbol definition and the vector chunk starting at it (and the exact line)');
});

test('pgvector (PGlite with the vector extension): two workspaces share ht_vectors without seeing each other', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite', extensions: ['vector'] });
  const other = await createGitRepo({ 'lib/refund.py': 'def refund_payment(order):\n    return order.total\n' });
  try {
    const embedder = new HashEmbedder();
    let pg: Promise<VectorIndex> | undefined;
    const sharedIndex = () => (pg ??= createPgVectorIndex(db, embedder));
    const a = new WorkspaceVectorRetriever({ root: repo.path, embedder, sharedIndex });
    const b = new WorkspaceVectorRetriever({ root: other.path, embedder, sharedIndex });
    assert.equal((await a.corpus()).shared, true);
    assert.deepEqual((await b.search({ text: 'refund payment order total' })).map((h) => h.path), ['lib/refund.py']);
    assert.ok((await a.search({ text: 'refund payment order total' })).every((h) => h.path !== 'lib/refund.py'));
    assert.equal((await a.search({ text: 'move money between accounts' }))[0]!.path, 'src/ledger.js');
    const n = await db.query<{ n: unknown }>('SELECT count(DISTINCT split_part(namespace, \':\', 1)) AS n FROM ht_vectors');
    assert.equal(Number(n.rows[0]!.n), 2, 'one corpus per workspace + commit');
  } finally {
    await other.cleanup();
    await dispose();
  }
});


test('VectorCorpusCache: retrievers share one LRU-bounded cache; an evicted corpus is populated again on demand', async () => {
  const roots = await Promise.all([0, 1, 2].map((i) => createGitRepo({ [`src/m${i}.js`]: `export function module${i}Handler() {\n  return ${i};\n}\n` })));
  try {
    const embedder = counting();
    const cache = new VectorCorpusCache({ maxCorpora: 2 });
    const rs = roots.map((r) => new WorkspaceVectorRetriever({ root: r.path, embedder, cache }));
    for (const r of rs) await r.corpus();
    assert.equal(cache.size, 2, 'bounded');
    const before = embedder.texts;
    await rs[2]!.corpus();
    assert.equal(embedder.texts, before, 'a cached corpus is not embedded again');
    await rs[0]!.corpus();
    assert.ok(embedder.texts > before, 'the evicted corpus of the first root is populated again');
    assert.deepEqual((await rs[0]!.search({ text: 'module0 handler' })).map((h) => h.path), ['src/m0.js']);
    // two roots never share a corpus (a worktree's own files, uncommitted edits included, never leak to another)
    assert.notEqual((await rs[0]!.corpus()).key, (await rs[1]!.corpus()).key);
    assert.throws(() => new VectorCorpusCache({ maxCorpora: 0 }), /maxCorpora/);
  } finally {
    await Promise.all(roots.map((r) => r.cleanup()));
  }
});
