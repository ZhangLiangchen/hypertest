import assert from 'node:assert/strict';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { SymbolIndex, classifyUsage, extractSymbols, goAstHelper, parseGoFiles, parsePythonFiles, parseTsJs } from '../src/index.ts';

/**
 * (B[6], CONFORMANCE "L3 symbol graph from syntax trees") The symbol index parses real syntax trees — the TypeScript compiler
 * API for TS/JS, python3 `ast` for Python, `go/ast` for Go — and classifies each reference from the tree (assignment target ⇒
 * write, callee ⇒ call, import ⇒ import, else read). A file a parser cannot handle (syntax error, missing toolchain) falls
 * back to the regex extractor, and the index says which engine parsed each file.
 */

const usageOf = (p: { usages: Map<number, Map<string, string>> }, line: number, name: string) => p.usages.get(line)?.get(name);
const defsOf = (p: { definitions: Array<{ name: string; kind: string; line: number; container?: string }> }) =>
  p.definitions.map((d) => [d.name, d.kind, d.line, d.container ?? '']);

describe('TypeScript compiler API', () => {
  test('definitions of every kind, with containers', () => {
    const text = [
      'export class Cart {',
      '  total = 0;',
      '  add(n: number): void { this.total += n; }',
      '  get size(): number { return 1; }',
      '  clear = () => { this.total = 0; };',
      '}',
      'export function checkout(c: Cart) { return c.total; }',
      'export interface Line { sku: string }',
      'export type Sku = string;',
      'export enum Mode { A, B }',
      'export const LIMITS = Object.freeze({ max: 3 });',
      'export const handler = async () => 1;',
      'let counter = 0;',
      'function outer() { function inner() {} }',
    ].join('\n');
    const p = parseTsJs(text, 'src/cart.ts', 'ts');
    assert.equal(p.engine, 'typescript');
    assert.deepEqual(defsOf(p), [
      ['Cart', 'class', 1, ''], ['add', 'method', 3, 'Cart'], ['size', 'method', 4, 'Cart'], ['clear', 'method', 5, 'Cart'],
      ['checkout', 'function', 7, ''], ['Line', 'interface', 8, ''], ['Sku', 'type', 9, ''], ['Mode', 'enum', 10, ''],
      ['LIMITS', 'const_object', 11, ''], ['handler', 'function', 12, ''], ['counter', 'variable', 13, ''],
      ['outer', 'function', 14, ''], ['inner', 'function', 14, ''],
    ]);
  });

  test('usages from the tree: a name inside a string or a comment is never a write; multi-line assignments are', () => {
    const text = [
      "import { version, bump } from './v.ts';", // 1 import
      "log('version = 0 reset'); // version++", // 2 only in a string and a comment
      'state.version =', // 3 multi-line assignment target
      '  next;',
      'bump(version);', // 5 call bump, read version
      'state.version++;', // 6 write
      'if (state.version === 3) {}', // 7 read
      'new Ledger(version);', // 8 call (constructor)
    ].join('\n');
    const p = parseTsJs(text, 'src/x.ts', 'ts');
    assert.equal(usageOf(p, 1, 'version'), 'import');
    assert.equal(usageOf(p, 2, 'version'), undefined, 'no identifier `version` on line 2');
    assert.equal(classifyUsage("log('version = 0 reset'); // version++", 'version', 'ts'), 'write', 'the regex classifier is fooled by the string');
    assert.equal(usageOf(p, 3, 'version'), 'write');
    assert.equal(usageOf(p, 5, 'bump'), 'call');
    assert.equal(usageOf(p, 5, 'version'), 'read');
    assert.equal(usageOf(p, 6, 'version'), 'write');
    assert.equal(usageOf(p, 7, 'version'), 'read');
    assert.equal(usageOf(p, 8, 'Ledger'), 'call');
  });
});

describe('python3 ast', () => {
  test('definitions with classes as containers, usages, a syntax error is not parsed', async () => {
    const parsed = await parsePythonFiles([
      { path: 'a.py', text: 'import os\nfrom .state import Ledger as L\n\nclass Ledger:\n    def bump(self):\n        self.version += 1\n\nasync def main():\n    l = L()\n    print("version = 1")\n    return l.version\n' },
      { path: 'broken.py', text: 'def oops(:\n    pass\n' },
    ]);
    assert.ok(parsed, 'python3 is installed in this environment');
    const a = parsed.get('a.py')!;
    assert.equal(a.engine, 'python-ast');
    assert.deepEqual(defsOf(a), [['Ledger', 'class', 4, ''], ['bump', 'method', 5, 'Ledger'], ['main', 'function', 8, '']]);
    assert.equal(usageOf(a, 1, 'os'), 'import');
    assert.equal(usageOf(a, 2, 'L'), 'import');
    assert.equal(usageOf(a, 6, 'version'), 'write');
    assert.equal(usageOf(a, 9, 'L'), 'call');
    assert.equal(usageOf(a, 9, 'l'), 'write');
    assert.equal(usageOf(a, 10, 'version'), undefined, 'a name in a string literal is not a usage');
    assert.equal(usageOf(a, 11, 'version'), 'read');
    assert.equal(parsed.has('broken.py'), false, 'a syntax error yields no parse (the index falls back to regex for it)');
  });

  test('python3 missing ⇒ undefined (the caller falls back)', async () => {
    const path = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      assert.equal(await parsePythonFiles([{ path: 'a.py', text: 'x = 1\n' }]), undefined);
    } finally {
      process.env['PATH'] = path;
    }
  });
});

describe('go/ast', () => {
  let helpers: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    helpers = await tempDir('ht-goast-helper-');
  });
  after(async () => helpers?.cleanup());

  test('methods with their receiver type, structs, interfaces, usages', async () => {
    const text = 'package store\n\ntype Store struct {\n\tVersion int\n}\n\ntype Bumper interface{ Bump() }\n\nvar Default = Store{}\n\nfunc (s *Store) Bump() {\n\ts.Version++\n\tlog("Version = 0")\n}\n\nfunc New() *Store { return &Store{} }\n';
    const helperDir = join(helpers.path, 'private');
    const parsed = await parseGoFiles([{ path: 'store.go', text }, { path: 'broken.go', text: 'package x\nfunc (' }], { helperDir });
    assert.ok(parsed, 'go is installed in this environment');
    const p = parsed.get('store.go')!;
    assert.equal(p.engine, 'go-ast');
    assert.deepEqual(defsOf(p), [['Store', 'struct', 3, ''], ['Bumper', 'interface', 7, ''], ['Default', 'variable', 9, ''], ['Bump', 'method', 11, 'Store'], ['New', 'function', 16, '']]);
    assert.equal(usageOf(p, 12, 'Version'), 'write');
    assert.equal(usageOf(p, 13, 'log'), 'call');
    assert.equal(usageOf(p, 13, 'Version'), undefined, 'a name in a string literal is not a usage');
    assert.equal(parsed.has('broken.go'), false);
    // the helper lives in the private directory it was given (0700), never at a shared temp path
    const bin = (await goAstHelper(helperDir))!;
    assert.equal(dirname(bin), helperDir);
    assert.equal((await stat(helperDir)).mode & 0o077, 0);
  });

  test('(review: sandbox escape) the helper runs outside the sandbox, so it is never taken from a shared or foreign directory', async () => {
    // the attack: a sandboxed command (same uid, /tmp visible) planted a "helper" at the old shared temp path; the host
    // must never execute it — without a private helper directory Go parsing falls back to the regex extractor
    const marker = join(helpers.path, 'pwned');
    const planted = join(tmpdir(), `hypertest-goast-${process.getuid?.() ?? 'u'}-planted`);
    await mkdir(planted, { recursive: true, mode: 0o700 });
    await writeFile(join(planted, 'goast'), `#!/bin/sh\necho pwned > ${marker}\necho '[]'\n`, { mode: 0o700 });
    try {
      assert.equal(await goAstHelper(undefined), undefined);
      assert.equal(await parseGoFiles([{ path: 'a.go', text: 'package a\nfunc A() {}\n' }]), undefined, 'no helper directory: no Go helper at all');
      assert.equal(await goAstHelper('relative/dir'), undefined, 'a relative helper directory is refused');
      // a helper directory others can write is not trusted (its binary could be swapped)
      const shared = join(helpers.path, 'shared');
      await mkdir(shared, { recursive: true });
      await chmod(shared, 0o777);
      assert.equal(await goAstHelper(shared), undefined);
      // a planted binary replacing a built helper in its (private) directory is refused once it is no longer private
      const dir = join(helpers.path, 'private');
      const bin = (await goAstHelper(dir))!;
      await writeFile(bin, `#!/bin/sh\necho pwned > ${marker}\necho '[]'\n`);
      await chmod(bin, 0o777);
      assert.equal(await parseGoFiles([{ path: 'a.go', text: 'package a\nfunc A() {}\n' }], { helperDir: dir }), undefined);
      await assert.rejects(stat(marker), /ENOENT/, 'no planted program was executed');
    } finally {
      await rm(planted, { recursive: true, force: true });
    }
  });
});

describe('SymbolIndex over syntax trees, with per-file regex fallback', () => {
  let repo: Awaited<ReturnType<typeof tempDir>>;
  let goast: Awaited<ReturnType<typeof tempDir>>;
  const FILES: Record<string, string> = {
    'src/state.ts': "export class State {\n  version = 0;\n}\nexport function report(s: State) {\n  log('version = 0 means fresh');\n  return s.version;\n}\n",
    'py/app.py': 'class App:\n    def run(self):\n        self.version = 2\n',
    'py/broken.py': 'def run(:\n    version = 3\n',
    'go/a.go': 'package a\n\nfunc Run() {}\n',
  };
  before(async () => {
    repo = await tempDir('ht-parsers-');
    goast = await tempDir('ht-parsers-goast-');
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(repo.path, rel)), { recursive: true });
      await writeFile(join(repo.path, rel), text);
    }
  });
  after(async () => {
    await repo?.cleanup();
    await goast?.cleanup();
  });

  test('each file records its engine; references are classified from the tree; the regex fallback still indexes a broken file', async () => {
    const index = new SymbolIndex({ root: repo.path, goHelperDir: join(goast.path, 'helper') });
    assert.deepEqual(await index.parserEngines(), { 'go/a.go': 'go-ast', 'py/app.py': 'python-ast', 'py/broken.py': 'regex-fallback', 'src/state.ts': 'typescript' });
    // without a private Go helper directory, Go files are indexed by the regex fallback (never a shared helper path)
    assert.equal((await new SymbolIndex({ root: repo.path }).parserEngines())['go/a.go'], 'regex-fallback');
    const writers = (await index.writers('version')).map((r) => `${r.path}:${r.line}`);
    // the string `'version = 0 means fresh'` (state.ts:5) is not a write; the broken Python file's line is classified by the regex
    assert.deepEqual(writers.sort(), ['py/app.py:3', 'py/broken.py:2', 'src/state.ts:2']);
    const mention = (await index.findReferences('version')).find((r) => r.path === 'src/state.ts' && r.line === 5);
    assert.equal(mention?.usage, 'read', 'a mention inside a string is still found (plain-text reference) but classified as read');
    assert.deepEqual((await index.findDefinitions('run')).map((d) => [d.path, d.kind, d.container ?? '']), [['py/app.py', 'method', 'App'], ['py/broken.py', 'function', '']]);
    assert.deepEqual(extractSymbols(FILES['py/broken.py']!, 'py/broken.py', 'python').map((d) => d.name), ['run'], 'the fallback is the regex extractor');
  });
});
