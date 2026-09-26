import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import {
  ExactSearch,
  HashEmbedder,
  HybridRetriever,
  InMemoryVectorIndex,
  SymbolIndex,
  classifyPath,
  cosine,
  findRipgrep,
  type RetrievalHit,
  type RetrievalQuery,
  type Retriever,
} from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

const CART_TS = `import { formatMoney } from './util/format.js';

/** A shopping cart. */
export class Cart {
  private lines: CartLine[] = [];
  static readonly MAX = 10;

  constructor(readonlyOwner: string) {}

  addItem(sku: string, qty = 1): void {
    if (qty > Cart.MAX) {
      throw new Error('too many');
    }
    this.lines.push({ sku, qty });
  }

  async removeItem(sku: string): Promise<void> {
    this.lines = this.lines.filter((l) => l.sku !== sku);
  }

  total = (): number => this.lines.length;
}

export interface CartLine { sku: string; qty: number }
export type Money = number;
export enum Color { Red, Green }
export const CartStatus = { Open: 'open', Closed: 'closed' } as const;
export const computeTax = (amount: number): number => amount * 0.2;
export let retries = 3;

export function checkout(cart: Cart): string {
  return formatMoney(cart.total());
}
`;

const FORMAT_JS = `export function formatMoney(n) {
  return '$' + n.toFixed(2);
}
const DEFAULT_CURRENCY = 'USD';
`;

const CART_PY = `class Cart:
    """A cart.

    def not_a_method(self): pass
    """

    def add_item(self, sku):
        def inner():
            return sku
        return inner()

    async def refresh(self):
        pass


async def checkout(cart):
    return cart


def helper():
    return checkout(None)
`;

const CART_GO = `package cart

// Cart holds lines.
type Cart struct {
	Lines []string
}

type Store interface {
	Save(c *Cart) error
}

type ID string

func NewCart() *Cart { return &Cart{} }

func (c *Cart) AddItem(sku string) {
	c.Lines = append(c.Lines, sku)
}

func Map[T any](xs []T) []T { return xs }
`;

const TEST_TS = `import { checkout, Cart } from '../src/cart.ts';
test('checkout', () => {
  checkout(new Cart('me'));
  checkout(new Cart('you')); checkout(new Cart('them'));
});
`;

let repo: { path: string; cleanup(): Promise<void> };
let outside: { path: string; cleanup(): Promise<void> };

async function put(rel: string, content: string | Uint8Array): Promise<void> {
  const p = join(repo.path, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

before(async () => {
  repo = await tempDir('ht-ctx-repo-');
  outside = await tempDir('ht-ctx-outside-');
  await put('src/cart.ts', CART_TS);
  await put('src/util/format.js', FORMAT_JS);
  await put('pkg/cart.py', CART_PY);
  await put('go/cart.go', CART_GO);
  await put('test/cart.test.ts', TEST_TS);
  await put('docs/guide.md', '# Guide\n\nCall checkout to pay. Checkout is final.\n');
  await put('node_modules/lib/index.js', 'export function checkout() {}\n');
  await put('dist/out.js', 'checkout();\n');
  await put('.hidden/x.ts', 'checkout();\n');
  await put('.gitignore', 'ignored/\n*.log\n');
  await put('ignored/gen.ts', 'checkout();\n');
  await put('app.log', 'checkout called\n');
  await put('sub/.gitignore', 'local.ts\n');
  await put('sub/local.ts', 'checkout();\n');
  await put('sub/kept.ts', 'export const x = checkout;\n');
  await put('bin.dat', Buffer.concat([Buffer.from('checkout'), Buffer.from([0, 1, 2]), Buffer.from('checkout')]));
  await put('big.txt', 'checkout\n' + 'x'.repeat(1024 * 1024 + 10));
  await writeFile(join(outside.path, 'secret.ts'), 'checkout();\n');
  await symlink(outside.path, join(repo.path, 'escape'));
  await symlink(join(outside.path, 'secret.ts'), join(repo.path, 'src', 'linked.ts'));
});
after(async () => {
  await repo.cleanup();
  await outside.cleanup();
});

const brief = (hits: RetrievalHit[]) => hits.map((h) => `${h.path}:${h.line}`);

test('exact search (JS walker): literal, smart case, skips ignored/hidden/vendored/binary/huge files and symlinks', async () => {
  const js = new ExactSearch({ root: repo.path, ripgrep: false });
  const hits = await js.search({ text: 'checkout', limit: 50 });
  assert.equal(js.lastEngine, 'js');
  assert.deepEqual(new Set(hits.map((h) => h.path)), new Set(['src/cart.ts', 'pkg/cart.py', 'test/cart.test.ts', 'docs/guide.md', 'sub/kept.ts']));
  for (const h of hits) {
    assert.equal(h.source, 'exact');
    assert.deepEqual(h.ref, { kind: 'file', id: h.path });
    assert.ok(h.score > 0 && h.score < 1);
  }
  // Smart case: an upper-case query is case sensitive.
  assert.deepEqual(brief(await js.search({ text: 'Checkout' })), ['docs/guide.md:3']);
  // The line with three matches ranks first; ties break by path then line.
  assert.equal(hits[0]!.path, 'test/cart.test.ts');
  assert.equal(hits[0]!.line, 4);
  assert.equal(hits[0]!.snippet, "checkout(new Cart('you')); checkout(new Cart('them'));");
  // Literal, not a regex.
  assert.deepEqual(brief(await js.search({ text: "n.toFixed(2)" })), ['src/util/format.js:2']);
  assert.deepEqual(await js.search({ text: '' }), []);
});

test('exact search: ripgrep and the JS walker return identical hits', async (t) => {
  const rg = await findRipgrep();
  if (!rg) {
    t.skip('ripgrep (rg) is not on PATH; only the JS walker is exercised');
    return;
  }
  const withRg = new ExactSearch({ root: repo.path, ripgrep: true });
  const js = new ExactSearch({ root: repo.path, ripgrep: false });
  const queries: RetrievalQuery[] = [
    { text: 'checkout', limit: 50 },
    { text: 'Cart', limit: 50 },
    { text: 'cart', limit: 3 },
    { text: 'checkout', root: 'src', limit: 50 },
    { text: 'checkout', pathGlobs: ['*.py', 'docs/**'], limit: 50 },
    { text: 'checkout', kinds: ['test'], limit: 50 },
  ];
  for (const q of queries) {
    const a = await withRg.search(q);
    assert.equal(withRg.lastEngine, 'ripgrep');
    const b = await js.search(q);
    assert.deepEqual(a, b, JSON.stringify(q));
    assert.ok(a.length > 0, JSON.stringify(q));
  }
});

test('exact search scoping: root subdir, path globs, kinds, limit; queries can never leave the root', async () => {
  const s = new ExactSearch({ root: repo.path, ripgrep: 'auto' });
  assert.deepEqual([...new Set((await s.search({ text: 'checkout', root: 'src', limit: 50 })).map((h) => h.path))], ['src/cart.ts']);
  assert.deepEqual([...new Set((await s.search({ text: 'checkout', pathGlobs: ['*.py'], limit: 50 })).map((h) => h.path))], ['pkg/cart.py']);
  assert.deepEqual([...new Set((await s.search({ text: 'checkout', pathGlobs: ['src/**/*.ts', '!src/util/**'], limit: 50 })).map((h) => h.path))], ['src/cart.ts']);
  assert.deepEqual([...new Set((await s.search({ text: 'checkout', kinds: ['doc'], limit: 50 })).map((h) => h.path))], ['docs/guide.md']);
  assert.equal((await s.search({ text: 'checkout', limit: 2 })).length, 2);
  await rejectsWith(s.search({ text: 'checkout', root: '../' }), 'invalid_argument');
  await rejectsWith(s.search({ text: 'checkout', root: outside.path }), 'invalid_argument');
  await rejectsWith(s.search({ text: 'checkout', pathGlobs: ['../**'] }), 'invalid_argument');
  await rejectsWith(s.search({ text: 'checkout', root: 'escape' }), 'permission_denied');
  await rejectsWith(s.search({ text: 'checkout', root: 'nope' }), 'not_found');
  assert.equal(classifyPath('pkg/test_cart.py'), 'test');
  assert.equal(classifyPath('go/cart_test.go'), 'test');
  assert.equal(classifyPath('README.md'), 'doc');
  assert.equal(classifyPath('src/cart.ts'), 'code');
});

test('symbol index: TS/JS definitions incl. methods, arrow functions, enum-like consts', async () => {
  const idx = new SymbolIndex({ root: repo.path });
  const built = await idx.build();
  assert.equal(built.files, 6, 'cart.ts, format.js, cart.py, cart.go, cart.test.ts, sub/kept.ts');
  const def = async (name: string) => (await idx.findDefinitions(name)).map((d) => `${d.language}:${d.kind}:${d.container ? d.container + '.' : ''}${d.name}@${d.path}:${d.line}`);
  assert.deepEqual(await def('Cart'), ['go:struct:Cart@go/cart.go:4', 'python:class:Cart@pkg/cart.py:1', 'ts:class:Cart@src/cart.ts:4']);
  assert.deepEqual(await def('addItem'), ['ts:method:Cart.addItem@src/cart.ts:10']);
  assert.deepEqual(await def('removeItem'), ['ts:method:Cart.removeItem@src/cart.ts:17']);
  assert.deepEqual(await def('total'), ['ts:method:Cart.total@src/cart.ts:21']);
  assert.deepEqual(await def('CartLine'), ['ts:interface:CartLine@src/cart.ts:24']);
  assert.deepEqual(await def('Money'), ['ts:type:Money@src/cart.ts:25']);
  assert.deepEqual(await def('Color'), ['ts:enum:Color@src/cart.ts:26']);
  assert.deepEqual(await def('CartStatus'), ['ts:const_object:CartStatus@src/cart.ts:27']);
  assert.deepEqual(await def('computeTax'), ['ts:function:computeTax@src/cart.ts:28']);
  assert.deepEqual(await def('retries'), ['ts:variable:retries@src/cart.ts:29']);
  assert.deepEqual(await def('formatMoney'), ['js:function:formatMoney@src/util/format.js:1']);
  assert.deepEqual(await def('DEFAULT_CURRENCY'), ['js:variable:DEFAULT_CURRENCY@src/util/format.js:4']);
  assert.deepEqual(await def('if'), [], 'control flow inside methods is not a method');
  assert.deepEqual(await def('push'), []);
});

test('symbol index: Python and Go definitions', async () => {
  const idx = new SymbolIndex({ root: repo.path });
  const def = async (name: string) => (await idx.findDefinitions(name)).map((d) => `${d.language}:${d.kind}:${d.container ? d.container + '.' : ''}${d.name}@${d.path}:${d.line}`);
  assert.deepEqual(await def('add_item'), ['python:method:Cart.add_item@pkg/cart.py:7']);
  assert.deepEqual(await def('inner'), ['python:function:inner@pkg/cart.py:8'], 'nested def is not a method');
  assert.deepEqual(await def('refresh'), ['python:method:Cart.refresh@pkg/cart.py:12']);
  assert.deepEqual(await def('checkout'), ['python:function:checkout@pkg/cart.py:16', 'ts:function:checkout@src/cart.ts:31']);
  assert.deepEqual(await def('not_a_method'), [], 'docstring content is skipped');
  assert.deepEqual(await def('Store'), ['go:interface:Store@go/cart.go:8']);
  assert.deepEqual(await def('ID'), ['go:type:ID@go/cart.go:12']);
  assert.deepEqual(await def('NewCart'), ['go:function:NewCart@go/cart.go:14']);
  assert.deepEqual(await def('AddItem'), ['go:method:Cart.AddItem@go/cart.go:16']);
  assert.deepEqual(await def('Map'), ['go:function:Map@go/cart.go:20']);

  const pyOnly = new SymbolIndex({ root: repo.path, languages: ['python'] });
  assert.deepEqual((await pyOnly.findDefinitions('Cart')).map((d) => d.language), ['python']);
});

test('symbol search: exact definitions 1.0, prefixes 0.7, references 0.3; references exclude definitions', async () => {
  const idx = new SymbolIndex({ root: repo.path });
  const hits = await idx.search({ text: '', symbol: 'checkout', limit: 50 });
  assert.deepEqual(hits.filter((h) => h.score === 1).map((h) => `${h.path}:${h.line}`), ['pkg/cart.py:16', 'src/cart.ts:31']);
  const refs = hits.filter((h) => h.score === 0.3).map((h) => `${h.path}:${h.line}`);
  assert.deepEqual(refs, ['pkg/cart.py:21', 'sub/kept.ts:1', 'test/cart.test.ts:1', 'test/cart.test.ts:2', 'test/cart.test.ts:3', 'test/cart.test.ts:4']);
  assert.deepEqual((await idx.findReferences('checkout')).map((r) => `${r.path}:${r.line}`), refs);
  const cart = await idx.search({ text: 'Cart', limit: 50 });
  assert.deepEqual(cart.slice(0, 3).map((h) => [h.path, h.score]), [['go/cart.go', 1], ['pkg/cart.py', 1], ['src/cart.ts', 1]]);
  assert.deepEqual(cart.filter((h) => h.score === 0.7).map((h) => h.ref.note), ['interface CartLine', 'const_object CartStatus']);
  assert.ok(cart.some((h) => h.score === 0.3 && h.path === 'test/cart.test.ts'));
  assert.equal(cart[0]!.source, 'symbol');
  // Scoping works like exact search.
  assert.deepEqual([...new Set((await idx.search({ text: 'Cart', kinds: ['test'], limit: 50 })).map((h) => h.path))], ['test/cart.test.ts']);
  assert.deepEqual([...new Set((await idx.search({ text: 'Cart', root: 'go', limit: 50 })).map((h) => h.path))], ['go/cart.go']);
  await rejectsWith(idx.search({ text: 'Cart', root: '/etc' }), 'invalid_argument');
});

test('HashEmbedder: deterministic, L2-normalized, camelCase/snake_case aware', async () => {
  const e = new HashEmbedder();
  assert.equal(e.dims, 256);
  const [a, b, c, d, z] = await e.embed(['getUserName', 'get_user_name', 'get user name', 'parse the config file', '']);
  assert.deepEqual(a, (await new HashEmbedder().embed(['getUserName']))[0]);
  assert.equal(a!.length, 256);
  assert.ok(Math.abs(Math.hypot(...a!) - 1) < 1e-9);
  assert.ok(cosine(a!, b!) > 0.999 && cosine(b!, c!) > 0.999, 'the same words in different casing styles embed alike');
  assert.ok(cosine(a!, d!) < 0.3);
  assert.ok(z!.every((x) => x === 0));
});

test('InMemoryVectorIndex: cosine ranking, namespace (kind) filter, upsert replaces, remove', async () => {
  const idx = new InMemoryVectorIndex(new HashEmbedder());
  await idx.upsert([
    { id: 'd1', text: 'checkout rejects an empty cart with status 400', ref: { kind: 'file', id: 'src/cart.ts' }, path: 'src/cart.ts', line: 31, namespace: 'code' },
    { id: 'd2', text: 'guide for paying with the checkout flow', ref: { kind: 'file', id: 'docs/guide.md' }, path: 'docs/guide.md', namespace: 'doc' },
    { id: 'd3', text: 'metrics scrape of prometheus latency', ref: { kind: 'evidence', id: 'ev_m1' }, namespace: 'evidence' },
  ]);
  const hits = await idx.search({ text: 'empty cart checkout' });
  assert.deepEqual(hits.map((h) => h.ref.id), ['src/cart.ts', 'docs/guide.md']);
  assert.equal(hits[0]!.source, 'vector');
  assert.equal(hits[0]!.line, 31);
  assert.deepEqual((await idx.search({ text: 'empty cart checkout', kinds: ['doc'] })).map((h) => h.ref.id), ['docs/guide.md']);
  await idx.upsert([{ id: 'd1', text: 'unrelated words only', ref: { kind: 'file', id: 'src/cart.ts' }, namespace: 'code' }]);
  assert.deepEqual((await idx.search({ text: 'empty cart checkout' })).map((h) => h.ref.id), ['docs/guide.md']);
  await idx.remove(['d2']);
  assert.deepEqual(await idx.search({ text: 'empty cart checkout' }), []);
  assert.equal(idx.size, 2);
});

function fixed(name: string, hits: Array<[string, number?]>): Retriever {
  return { name, search: async () => hits.map(([id, line], i) => ({ source: 'exact' as const, ref: { kind: 'file' as const, id }, ...(line !== undefined ? { line } : {}), snippet: `${name}:${id}`, score: 1 - i / 10 })) };
}

test('HybridRetriever: reciprocal-rank fusion, dedupe by ref kind:id(+line), stable ties, failing child tolerated', async () => {
  const a = fixed('a', [['x.ts', 1], ['y.ts', 2], ['z.ts']]);
  const b = fixed('b', [['y.ts', 2], ['w.ts'], ['x.ts', 1]]);
  const h = new HybridRetriever([a, b], { k: 60 });
  const hits = await h.search({ text: 'q' });
  // y: 1/62 + 1/61; x: 1/61 + 1/63; z: 1/63; w: 1/62
  assert.deepEqual(hits.map((x) => x.ref.id), ['y.ts', 'x.ts', 'w.ts', 'z.ts']);
  assert.ok(Math.abs(hits[0]!.score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.ok(Math.abs(hits[1]!.score - (1 / 61 + 1 / 63)) < 1e-12);
  assert.equal(hits[0]!.snippet, 'a:y.ts', 'the first-seen hit represents a fused group');
  // Same file, different lines are different hits; ties keep first-seen order.
  const tie = await new HybridRetriever([fixed('p', [['f.ts', 1]]), fixed('q', [['f.ts', 2]])]).search({ text: 'q' });
  assert.deepEqual(tie.map((x) => x.line), [1, 2]);
  // A failing child is skipped; all failing ⇒ the error surfaces.
  const boom: Retriever = { name: 'boom', search: async () => { throw new Error('index offline'); } };
  assert.deepEqual((await new HybridRetriever([boom, a]).search({ text: 'q' })).map((x) => x.ref.id), ['x.ts', 'y.ts', 'z.ts']);
  await assert.rejects(new HybridRetriever([boom]).search({ text: 'q' }), /index offline/);
  assert.equal((await h.search({ text: 'q', limit: 2 })).length, 2);
});

test('HybridRetriever over real retrievers ranks the definition that every child finds first', async () => {
  const vec = new InMemoryVectorIndex(new HashEmbedder());
  await vec.upsert([{ id: 'v1', text: 'function checkout(cart: Cart): string', ref: { kind: 'file', id: 'src/cart.ts' }, path: 'src/cart.ts', line: 31, namespace: 'code' }]);
  const hybrid = new HybridRetriever([new ExactSearch({ root: repo.path }), new SymbolIndex({ root: repo.path }), vec]);
  const hits = await hybrid.search({ text: 'checkout', symbol: 'checkout', limit: 5 });
  assert.equal(`${hits[0]!.path}:${hits[0]!.line}`, 'src/cart.ts:31');
});

// ----------------------------------------------------------------------------- ripgrep / JS parity edge cases

/**
 * Fixture for the cases where ripgrep and the JS walker used to disagree. `expected` is what both engines must
 * return (paths of the hits, sorted).
 */
async function parityFixture(): Promise<{ root: string; cleanup(): Promise<void>; cases: Array<{ query: RetrievalQuery; expected: string[] }> }> {
  const dir = await tempDir('ht-ctx-parity-');
  const w = async (rel: string, content: string | Uint8Array) => {
    const p = join(dir.path, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  };
  execFileSync('git', ['init', '-q'], { cwd: dir.path });
  await w('.git/info/exclude', 'excluded.ts\n'); // not honoured by either engine (only .gitignore files are)
  await w('excluded.ts', 'needle\n');
  await w('.gitignore', 'secret.ts\n[z-a]\nlate.log\nbuild/\n'); // the invalid line is skipped on its own
  await w('secret.ts', 'needle\n');
  await w('late.log', 'needle\n');
  await w('build/keep.ts', 'needle\n');
  await w('ok.ts', 'needle ok\n');
  await w('nul-near.txt', 'needle\n' + 'x'.repeat(9000) + '\n\u0000\nneedle\n'); // NUL inside ripgrep's first buffer
  await w('nul-far.txt', 'needle\n' + 'x'.repeat(70_000) + '\n\u0000\nneedle\n'); // NUL beyond it: rg reports line 1
  await w('bad-utf8.txt', Buffer.concat([Buffer.from('needle '), Buffer.from([0xff, 0xfe]), Buffer.from(' tail\n')]));
  await w('.github/wf.yml', 'needle\n');
  await w('dist/out.ts', 'needle\n');
  await w('one/file.ts', 'needle one\n');
  const all = ['bad-utf8.txt', 'excluded.ts', 'ok.ts', 'one/file.ts'];
  return {
    root: dir.path,
    cleanup: () => dir.cleanup(),
    cases: [
      { query: { text: 'needle', limit: 100 }, expected: all },
      // query.root is a filter over a walk from the root: hidden, vendored and ignored roots yield nothing.
      { query: { text: 'needle', root: '.github', limit: 100 }, expected: [] },
      { query: { text: 'needle', root: 'dist', limit: 100 }, expected: [] },
      { query: { text: 'needle', root: 'build', limit: 100 }, expected: [] },
      { query: { text: 'needle', root: 'secret.ts', limit: 100 }, expected: [] },
      // A file root searches that file.
      { query: { text: 'needle', root: 'one/file.ts', limit: 100 }, expected: ['one/file.ts'] },
      { query: { text: 'needle', root: 'one', limit: 100 }, expected: ['one/file.ts'] },
    ],
  };
}

const paths = (hits: RetrievalHit[]) => hits.map((h) => h.path!).sort();

test('JS walker: binary = a NUL anywhere, per-line .gitignore errors, non-UTF-8 lines, hidden/ignored/file query roots', async () => {
  const f = await parityFixture();
  try {
    const js = new ExactSearch({ root: f.root, ripgrep: false });
    for (const c of f.cases) assert.deepEqual(paths(await js.search(c.query)), c.expected, JSON.stringify(c.query));
    const bad = (await js.search({ text: 'needle', pathGlobs: ['*.txt'] })).find((h) => h.path === 'bad-utf8.txt')!;
    assert.equal(bad.snippet, 'needle �� tail', 'decoded lossily, still found');
    // Symbol and exact search agree on scoping semantics (file root included).
    await writeFile(join(f.root, 'one', 'file.ts'), 'export function needle() {}\nneedle();\n');
    const idx = new SymbolIndex({ root: f.root });
    assert.deepEqual((await idx.search({ text: '', symbol: 'needle', root: 'one/file.ts', limit: 10 })).map((h) => `${h.path}:${h.line}:${h.score}`), ['one/file.ts:1:1', 'one/file.ts:2:0.3']);
  } finally {
    await f.cleanup();
  }
});

test('ripgrep and the JS walker agree on the edge cases too (binary, ignore errors, exclude files, UTF-8, roots)', async (t) => {
  if (!(await findRipgrep())) {
    t.skip('ripgrep (rg) is not on PATH; the JS walker behaviour is asserted by the previous test');
    return;
  }
  const f = await parityFixture();
  try {
    const rg = new ExactSearch({ root: f.root, ripgrep: true });
    const js = new ExactSearch({ root: f.root, ripgrep: false });
    for (const c of f.cases) {
      const a = await rg.search(c.query);
      assert.equal(rg.lastEngine, 'ripgrep');
      assert.deepEqual(a, await js.search(c.query), JSON.stringify(c.query));
      assert.deepEqual(paths(a), c.expected, JSON.stringify(c.query));
    }
  } finally {
    await f.cleanup();
  }
});

test('invalid limits and globs are invalid_argument on every retriever (never an engine error or silent empty result)', async () => {
  const vec = new InMemoryVectorIndex(new HashEmbedder());
  const retrievers: Retriever[] = [new ExactSearch({ root: repo.path, ripgrep: false }), new SymbolIndex({ root: repo.path }), vec, new HybridRetriever([vec])];
  if (await findRipgrep()) retrievers.push(new ExactSearch({ root: repo.path, ripgrep: true }));
  for (const r of retrievers) {
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, '5' as never]) await rejectsWith(r.search({ text: 'checkout', limit }), 'invalid_argument');
  }
  await rejectsWith(new ExactSearch({ root: repo.path, ripgrep: false }).search({ text: 'checkout', pathGlobs: ['[z-a].ts'] }), 'invalid_argument');
  await rejectsWith(vec.search({ text: 'checkout', pathGlobs: ['src/[z-a]'] }), 'invalid_argument');
  assert.throws(() => new ExactSearch({ root: repo.path, defaultLimit: Number.NaN }), /defaultLimit/);
});

test('vector indexes honour query.root like the file retrievers; a malformed embedder answer is provider_error', async () => {
  const idx = new InMemoryVectorIndex(new HashEmbedder());
  await idx.upsert([
    { id: 'a', text: 'checkout cart total', ref: { kind: 'file', id: 'src/cart.ts' }, path: 'src/cart.ts', namespace: 'code' },
    { id: 'b', text: 'checkout cart guide', ref: { kind: 'file', id: 'docs/guide.md' }, path: 'docs/guide.md', namespace: 'doc' },
    { id: 'c', text: 'checkout cart metric', ref: { kind: 'evidence', id: 'ev_1' }, namespace: 'evidence' },
    { id: 'd', text: 'checkout cart sibling', ref: { kind: 'file', id: 'src2/x.ts' }, path: 'src2/x.ts', namespace: 'code' },
  ]);
  assert.deepEqual((await idx.search({ text: 'checkout cart' })).length, 4);
  assert.deepEqual((await idx.search({ text: 'checkout cart', root: 'src' })).map((h) => h.path), ['src/cart.ts']);
  assert.deepEqual((await idx.search({ text: 'checkout cart', root: './src/' })).map((h) => h.path), ['src/cart.ts']);
  await rejectsWith(idx.search({ text: 'checkout', root: '../src' }), 'invalid_argument');
  await rejectsWith(idx.search({ text: 'checkout', root: '/etc' }), 'invalid_argument');

  const wrongDims: HashEmbedder = Object.assign(Object.create(HashEmbedder.prototype) as HashEmbedder, { dims: 8, modelId: 'bad', embed: async (t: string[]) => t.map(() => [1, 2, 3]) });
  await rejectsWith(new InMemoryVectorIndex(wrongDims).upsert([{ id: 'x', text: 'x', ref: { kind: 'file', id: 'x' }, namespace: 'code' }]), 'provider_error');
  const nanVec = { dims: 2, modelId: 'nan', embed: async (t: string[]) => t.map(() => [Number.NaN, 1]) };
  await rejectsWith(new InMemoryVectorIndex(nanVec).search({ text: 'x' }), 'provider_error');
  const short = { dims: 2, modelId: 'short', embed: async () => [] as number[][] };
  await rejectsWith(new InMemoryVectorIndex(short).upsert([{ id: 'x', text: 'x', ref: { kind: 'file', id: 'x' }, namespace: 'code' }]), 'provider_error');
});

test('SymbolIndex: when builds overlap, the latest build() wins even if an older one finishes later', async () => {
  const dir = await tempDir('ht-ctx-race-');
  try {
    await writeFile(join(dir.path, 'a.ts'), 'export function oldSym() {}\n');
    await mkdir(join(dir.path, 'b', '0hook'), { recursive: true });
    await writeFile(join(dir.path, 'b', '0hook', 'h.ts'), 'export const hook = 1;\n');
    for (let i = 0; i < 300; i++) await writeFile(join(dir.path, 'b', `f${String(i).padStart(3, '0')}.ts`), `export const f${i} = ${i};\n`);
    const idx = new SymbolIndex({ root: dir.path });
    let second: Promise<unknown> | undefined;
    let visits = 0;
    // walkFiles reads signal.aborted once per directory visit: root, b, b/0hook. At b/0hook the first build has
    // already indexed a.ts (oldSym) and listed b's 300 files; the tree changes and a second build starts. The
    // second build has far less left to do, so the first one finishes last with a stale view.
    const hook = {
      get aborted() {
        if (++visits === 3) {
          writeFileSync(join(dir.path, 'a.ts'), 'export function newSym() {}\n');
          for (let i = 0; i < 300; i++) rmSync(join(dir.path, 'b', `f${String(i).padStart(3, '0')}.ts`));
          second = idx.build();
        }
        return false;
      },
    } as unknown as AbortSignal;
    const first = idx.build(hook);
    await first;
    await second;
    assert.equal(visits >= 3, true, 'the hook fired');
    assert.deepEqual((await idx.findDefinitions('newSym')).map((d) => d.path), ['a.ts']);
    assert.deepEqual(await idx.findDefinitions('oldSym'), [], 'the stale build did not overwrite the index');
  } finally {
    await dir.cleanup();
  }
});
