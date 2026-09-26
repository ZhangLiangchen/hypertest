import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { SymbolIndex, classifyUsage, extractImports, resolveImport } from '../src/index.ts';

/**
 * L3 symbol graph without tree-sitter (conformance: "L3 hybrid retrieval … symbol graph"): definitions + classified
 * references (import / write / call / read, with the enclosing definition) + import edges, answering "who writes X?"
 * and "who calls X?" for TS/JS, Python and Go.
 */
let repo: Awaited<ReturnType<typeof tempDir>>;
let index: SymbolIndex;

const FILES: Record<string, string> = {
  'src/account.ts': [
    "import { audit } from './audit.ts';",
    'export class AccountState {',
    '  version = 0;',
    '  balance: number = 0;',
    '  bump(): void {',
    '    this.version += 1;',
    "    audit('bump', this.version);",
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/service.ts': [
    "import { AccountState } from './account.ts';",
    "import * as audit from './audit.js';",
    "const lazy = () => import('./lazy');",
    'export function transfer(state: AccountState, amount: number): number {',
    '  if (state.version === 3) return 0;',
    '  state.version = state.version + 1;',
    '  state.balance -= amount;',
    '  return state.balance;',
    '}',
    'export function reset(other: { version: number }) {',
    '  other.version = 0;',
    '}',
    '',
  ].join('\n'),
  'src/audit.ts': 'export function audit(kind: string, v: number): void {\n  console.info(kind, v);\n}\n',
  'src/lazy/index.ts': 'export const lazy = 1;\n',
  'src/untouched.ts': "export function reader(s: { version: number }) {\n  return s.version <= 2 || s.version >= 9 || s.version != 4;\n}\n",
  'py/ledger/__init__.py': '',
  'py/ledger/state.py': 'class Ledger:\n    def __init__(self):\n        self.version = 0\n\n    def bump(self):\n        self.version += 1\n',
  'py/ledger/cli.py': 'from .state import Ledger\nimport os, json\n\ndef main():\n    ledger = Ledger()\n    ledger.bump()\n',
  'go/store/store.go': 'package store\n\ntype Store struct {\n\tVersion int\n}\n\nfunc (s *Store) Bump() {\n\ts.Version++\n}\n',
  'go/cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/go/store"\n)\n\nfunc main() {\n\tv := store.Store{}\n\tv.Bump()\n\tfmt.Println(v)\n}\n',
};

before(async () => {
  repo = await tempDir('ht-symgraph-');
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo.path, rel)), { recursive: true });
    await writeFile(join(repo.path, rel), text);
  }
  index = new SymbolIndex({ root: repo.path });
});
after(async () => {
  await repo.cleanup();
});

test('classifyUsage: import > write (=, op=, :=, ++/--) > call > read; comparisons and arrows are not writes', () => {
  assert.equal(classifyUsage("import { x } from './x.ts';", 'x', 'ts'), 'import');
  assert.equal(classifyUsage('from .state import Ledger', 'Ledger', 'python'), 'import');
  assert.equal(classifyUsage('  this.version += 1;', 'version', 'ts'), 'write');
  assert.equal(classifyUsage('  state.version = state.version + 1;', 'version', 'ts'), 'write');
  assert.equal(classifyUsage('\ts.Version++', 'Version', 'go'), 'write');
  assert.equal(classifyUsage('\tv := store.Store{}', 'v', 'go'), 'write');
  assert.equal(classifyUsage('  --count;', 'count', 'js'), 'write');
  assert.equal(classifyUsage('  if (state.version === 3) return 0;', 'version', 'ts'), 'read');
  assert.equal(classifyUsage('  return s.version <= 2 || s.version >= 9 || s.version != 4;', 'version', 'ts'), 'read');
  assert.equal(classifyUsage('  const f = version => version * 2;', 'version', 'ts'), 'read');
  assert.equal(classifyUsage("    audit('bump', this.version);", 'audit', 'ts'), 'call');
  assert.equal(classifyUsage('  const s = new Store<number>(1);', 'Store', 'ts'), 'call');
});

test('import edges: relative TS/JS (.js→.ts, index files, dynamic import), Python relative modules, Go module paths', async () => {
  const edges = await index.imports();
  const view = edges.map((e) => `${e.from}:${e.line} ${e.specifier} → ${e.to ?? '(external)'}`);
  assert.deepEqual(view, [
    'go/cmd/main.go:4 fmt → (external)',
    'go/cmd/main.go:5 example.com/app/go/store → go/store/store.go',
    'py/ledger/cli.py:1 .state → py/ledger/state.py',
    'py/ledger/cli.py:2 os → (external)',
    'py/ledger/cli.py:2 json → (external)',
    'src/account.ts:1 ./audit.ts → src/audit.ts',
    'src/service.ts:1 ./account.ts → src/account.ts',
    'src/service.ts:2 ./audit.js → src/audit.ts',
    'src/service.ts:3 ./lazy → src/lazy/index.ts',
  ]);
  assert.deepEqual((await index.importers('src/audit.ts')).map((e) => e.from), ['src/account.ts', 'src/service.ts']);
  assert.deepEqual((await index.imports('src/account.ts')).map((e) => e.to), ['src/audit.ts']);
  // the pure helpers behave the same outside an index
  assert.deepEqual(extractImports("export * from './a.ts';\nconst x = require('../b');\n", 'src/m/x.ts', 'ts').map((e) => e.specifier), ['./a.ts', '../b']);
  assert.equal(resolveImport({ from: 'src/m/x.ts', specifier: '../../../etc/passwd', line: 1, language: 'ts' }, new Set(['etc/passwd'])), undefined, 'never outside the repository');
});

test('"who writes AccountState.version?": the writes inside AccountState and in files using it, not unrelated `version` writes', async () => {
  const all = await index.writers('version');
  assert.deepEqual(all.map((r) => `${r.path}:${r.line} ${r.enclosing}`), [
    'py/ledger/state.py:3 Ledger.__init__',
    'py/ledger/state.py:6 Ledger.bump',
    'src/account.ts:3 AccountState',
    'src/account.ts:6 AccountState.bump',
    'src/service.ts:6 transfer',
    'src/service.ts:11 reset',
  ]);
  const qualified = await index.writers('AccountState.version');
  // the field initializer and bump() inside the class, transfer()/reset() in the file that imports AccountState
  assert.deepEqual(qualified.map((r) => `${r.path}:${r.line}`), ['src/account.ts:3', 'src/account.ts:6', 'src/service.ts:6', 'src/service.ts:11']);
  assert.ok(qualified.every((r) => r.usage === 'write'));
  // reads and comparisons never count as writes
  assert.ok(!all.some((r) => r.path === 'src/untouched.ts'));
  const py = await index.writers('Ledger.version');
  assert.deepEqual(py.map((r) => `${r.path}:${r.line}`), ['py/ledger/state.py:3', 'py/ledger/state.py:6']);
  assert.deepEqual((await index.writers('Store.Version')).map((r) => `${r.path}:${r.line} ${r.enclosing}`), ['go/store/store.go:8 Store.Bump']);
});

test('call graph and usage filters: callers carry the calling definition; references are classified', async () => {
  assert.deepEqual((await index.callers('audit')).map((r) => `${r.path}:${r.line} ${r.enclosing}`), ['src/account.ts:7 AccountState.bump']);
  assert.deepEqual((await index.callers('Bump')).map((r) => `${r.path}:${r.line} ${r.enclosing}`), ['go/cmd/main.go:10 main']);
  const refs = await index.findReferences('AccountState');
  assert.deepEqual(refs.map((r) => `${r.path}:${r.line} ${r.usage}`), ['src/service.ts:1 import', 'src/service.ts:4 read']);
  const reads = await index.findReferences('version', 100, { usage: ['read'] });
  assert.deepEqual(reads.map((r) => `${r.path}:${r.line}`), ['src/account.ts:7', 'src/service.ts:5', 'src/service.ts:10', 'src/untouched.ts:1', 'src/untouched.ts:2']);
  assert.ok(reads.every((r) => r.usage === 'read'));
});

test('search(): a "who writes / who calls" question ranks the graph edges above plain references', async () => {
  const hits = await index.search({ text: 'Who writes AccountState.version?', limit: 8 });
  // the definition named in the question first (1.0), then every write edge (0.9), before any plain reference (0.3)
  assert.deepEqual(hits.slice(0, 5).map((h) => `${h.path}:${h.line} ${h.score}`), ['src/account.ts:2 1', 'src/account.ts:3 0.9', 'src/account.ts:6 0.9', 'src/service.ts:6 0.9', 'src/service.ts:11 0.9']);
  assert.ok(hits.slice(1, 5).every((h) => /^writes AccountState\.version/.test(h.ref.note ?? '')));
  assert.ok(hits.slice(5).every((h) => h.score < 0.9));
  // without the question the same writes are plain references
  const plain = await index.search({ text: 'AccountState version', limit: 20 });
  assert.ok(!plain.some((h) => h.score === 0.9));
  const calls = await index.search({ text: 'who calls audit', limit: 3 });
  assert.equal(`${calls[0]!.path}:${calls[0]!.line}`, 'src/audit.ts:1', 'the definition itself stays first (1.0)');
  assert.equal(`${calls[1]!.path}:${calls[1]!.line}`, 'src/account.ts:7');
  assert.equal(calls[1]!.score, 0.8);
  // "who uses X": every non-import reference (reads, calls, writes), never the import lines
  const uses = await index.search({ text: 'who uses AccountState', limit: 10 });
  assert.deepEqual(uses.filter((h) => /^uses /.test(h.ref.note ?? '')).map((h) => `${h.path}:${h.line}`), ['src/service.ts:4']);
});
