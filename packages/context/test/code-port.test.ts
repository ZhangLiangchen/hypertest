import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { createCodeToolRetrieval, stripSymbolAnnotation } from '../src/index.ts';

/**
 * (B[6], audit: "no agent can ask who writes AccountState.version") The code tools' retrieval port answers from the
 * syntax-tree symbol graph: code.symbols → labelled definitions; code.references `Owner.member` → definitions, then writes
 * (narrowed to the owner), calls, reads, imports — each with its enclosing definition; an edit of the workspace is seen by
 * the next query (incremental rebuild).
 */
let repo: Awaited<ReturnType<typeof tempDir>>;
const FILES: Record<string, string> = {
  'src/account.ts': [
    'export class AccountState {',
    '  version = 0;',
    '  bump(): void {',
    '    this.version += 1;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/service.ts': [
    "import { AccountState } from './account.ts';",
    'export function transfer(state: AccountState): number {',
    "  log('version = 0 is fresh');",
    '  state.version = state.version + 1;',
    '  return state.version;',
    '}',
    'export function other(o: { version: number }) {',
    '  o.version = 9;',
    '}',
    '',
  ].join('\n'),
  'src/unrelated.ts': 'export function noop(x: { version: number }) {\n  x.version = 1;\n}\n',
};

before(async () => {
  repo = await tempDir('ht-codeport-');
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo.path, rel)), { recursive: true });
    await writeFile(join(repo.path, rel), text);
  }
});
after(async () => repo?.cleanup());

test('code.symbols: definitions containing the query, exact first, labelled with kind and container', async () => {
  const port = createCodeToolRetrieval();
  const rows = await port.search({ text: 'bump', symbol: 'bump', root: repo.path, limit: 10 });
  assert.deepEqual(rows, [{ path: 'src/account.ts', line: 3, snippet: '⟦definition method AccountState.bump⟧ bump(): void {', score: 1 }]);
  assert.deepEqual((await port.search({ text: 'Account', symbol: 'Account', root: repo.path })).map((r) => [r.path, r.line, r.score]), [['src/account.ts', 1, 0.7]]);
});

test('code.references Owner.member: who writes AccountState.version — writes first, narrowed to the owner, strings are not writes', async () => {
  const port = createCodeToolRetrieval();
  const rows = await port.search({ text: 'AccountState.version', root: repo.path, limit: 50 });
  assert.deepEqual(rows.map((r) => `${r.path}:${r.line} ${r.snippet}`), [
    // the class field initializer declares-and-writes the member
    'src/account.ts:2 ⟦write in AccountState⟧ version = 0;',
    'src/account.ts:4 ⟦write in AccountState.bump⟧ this.version += 1;',
    'src/service.ts:4 ⟦write in transfer⟧ state.version = state.version + 1;',
    // a write of `version` in a file that uses AccountState is kept (the owner narrowing is by file, without types)
    'src/service.ts:8 ⟦write in other⟧ o.version = 9;',
    // the string "version = 0" is a mention, not a write (the regex line classifier called it a write)
    "src/service.ts:3 ⟦read in transfer⟧ log('version = 0 is fresh');",
    'src/service.ts:5 ⟦read in transfer⟧ return state.version;',
    'src/service.ts:7 ⟦read in other⟧ export function other(o: { version: number }) {',
    'src/unrelated.ts:1 ⟦read in noop⟧ export function noop(x: { version: number }) {',
  ]);
  assert.deepEqual(rows.map((r) => r.score), [0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5]);
  assert.ok(!rows.some((r) => r.path === 'src/unrelated.ts' && r.line === 2), 'a write of `version` in a file unrelated to AccountState is not a writer of AccountState.version');
  assert.equal(stripSymbolAnnotation(rows[1]!.snippet), 'this.version += 1;');
});

test('the next query sees an edit of the workspace (incremental rebuild)', async () => {
  const port = createCodeToolRetrieval();
  assert.equal((await port.search({ text: 'reset', symbol: 'reset', root: repo.path })).length, 0);
  await writeFile(join(repo.path, 'src/account.ts'), FILES['src/account.ts']!.replace('  bump(): void {', '  reset(): void {\n    this.version = 0;\n  }\n  bump(): void {'));
  assert.deepEqual((await port.search({ text: 'reset', symbol: 'reset', root: repo.path })).map((r) => [r.path, r.line]), [['src/account.ts', 3]]);
  const writes = (await port.search({ text: 'AccountState.version', root: repo.path })).filter((r) => r.snippet.startsWith('⟦write'));
  assert.deepEqual(writes.map((r) => `${r.path}:${r.line} ${r.snippet.slice(0, r.snippet.indexOf('⟧') + 1)}`), [
    'src/account.ts:2 ⟦write in AccountState⟧', 'src/account.ts:4 ⟦write in AccountState.reset⟧', 'src/account.ts:7 ⟦write in AccountState.bump⟧',
    'src/service.ts:4 ⟦write in transfer⟧', 'src/service.ts:8 ⟦write in other⟧',
  ]);
  assert.deepEqual(await port.search({ text: 'not an identifier!', root: repo.path }), []);
  assert.deepEqual(await port.search({ text: 'x' }), [], 'no root, no answer');
});
