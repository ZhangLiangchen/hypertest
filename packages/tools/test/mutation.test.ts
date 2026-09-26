import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import { testDeps } from '@hypertest/testkit';
import { applyMutant, createLocalSandbox, createWorkspaceManager, generateMutants, maskSource, nodeTestRunner, runMutationAnalysis, selectMutants, type SandboxRunner, type WorkspaceHandle, type WorkspaceManager } from '../src/index.ts';
import { SANDBOX, tempDir } from './helpers.ts';

let base: Awaited<ReturnType<typeof tempDir>>;
let wm: WorkspaceManager;
let n = 0;

before(async () => {
  base = await tempDir('ht-mutation-');
  wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX });
});
after(async () => {
  await base.cleanup();
});

async function fixture(files: Record<string, string>): Promise<WorkspaceHandle> {
  const ws = await wm.scratch({ runId: 'run_mut', workItemId: `wi_${++n}` });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(ws.root, rel, '..'), { recursive: true });
    await writeFile(join(ws.root, rel), content);
  }
  return ws;
}

const summary = (src: string, lang: Parameters<typeof generateMutants>[2]) => generateMutants('f', src, lang).map((m) => `${m.operator}:${m.original}->${m.replacement}`);

test('masking: comments, strings, templates and regex literals are never mutated', () => {
  const src = [
    "import { a } from './x-1.js';",
    '// a + b < c && true 1',
    '/* x * y */',
    "const s = 'p + q' + \"r - s\" + `t ${u + 1} v`;",
    'const re = /a+b|c-d/g;',
    'const y = x + 2;',
  ].join('\n');
  const masked = maskSource(src, 'javascript');
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(masked.split('\n')[1]!, /\S/);
  const muts = generateMutants('f.js', src, 'javascript');
  assert.deepEqual([...new Set(muts.map((m) => m.line))], [6], JSON.stringify(muts.map((m) => [m.line, m.original])));
  assert.deepEqual(muts.filter((m) => m.line === 6).map((m) => `${m.operator}:${m.original}->${m.replacement}`), ['arithmetic:+->-', 'numeric_literal:2->1', 'numeric_literal:2->3']);
  // operators between (masked) string literals are not binary operators on code operands: nothing on line 4
});

test('JS/TS operators: arithmetic, relational, logical, boolean, numeric, return value, off-by-one', () => {
  assert.deepEqual(summary('r = a * b / c;', 'javascript'), ['arithmetic:*->/', 'arithmetic:/->*']);
  assert.deepEqual(summary('if (x < y && y >= z || a === b || c !== d || e == f) {}', 'javascript'), [
    'relational:<-><=', 'logical:&&->||', 'relational:>=->>', 'logical:||->&&', 'relational:===->!==', 'logical:||->&&', 'relational:!==->===', 'logical:||->&&', 'relational:==->!=',
  ]);
  assert.deepEqual(summary('const ok = true;', 'typescript'), ['boolean:true->false']);
  assert.deepEqual(summary('function f(x) { return x; }', 'javascript'), ['return_value:x->null']);
  assert.deepEqual(summary('const last = arr.length - 1;', 'javascript'), ['off_by_one: - 1->', 'arithmetic:-->+', 'numeric_literal:1->0', 'numeric_literal:1->2']);
  // not mutated: generics, arrows, increments, compound assignment, exponent, shifts
  assert.deepEqual(summary('const m: Map<string, Array<number>> = new Map(); const f = (a) => a; i++; j += k; const e = 1e-5; const s = a >> b;', 'typescript').filter((x) => !x.startsWith('numeric_literal')), []);
});

test('Python and Go operators; import lines skipped; Go pointer types untouched', () => {
  assert.deepEqual(summary('import os\nfrom a import b\ndef f(x):\n    # x > 1\n    return x > 1 and True  # c\n', 'python'), [
    'relational:>->>=', 'numeric_literal:1->0', 'numeric_literal:1->2', 'logical:and->or', 'boolean:True->False',
  ]);
  assert.deepEqual(summary('def g(v):\n    return v\n', 'python'), ['return_value:v->None']);
  const go = 'package p\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc f(x *int, err error) error {\n\ty := 2 * 3\n\treturn err\n}\n';
  assert.deepEqual(summary(go, 'go'), ['numeric_literal:2->1', 'numeric_literal:2->3', 'arithmetic:*->/', 'numeric_literal:3->2', 'numeric_literal:3->4', 'return_value:err->nil']);
});

test('mutant ids are deterministic; apply/select are exact', () => {
  const src = 'export const f = (a, b) => a + b > 10;\n';
  const a = generateMutants('f.js', src, 'javascript');
  const b = generateMutants('f.js', src, 'javascript');
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((m) => m.id), ['m001-L1-arithmetic', 'm002-L1-relational', 'm003-L1-numeric_literal', 'm004-L1-numeric_literal']);
  assert.equal(applyMutant(src, a[0]!), 'export const f = (a, b) => a - b > 10;\n');
  assert.throws(() => applyMutant('something else', a[0]!), (e) => isHypertestError(e, 'precondition_failed'));
  const many = Array.from({ length: 10 }, (_, i) => ({ ...a[0]!, id: `m${i}` }));
  assert.deepEqual(selectMutants(many, 4).map((m) => m.id), ['m0', 'm2', 'm5', 'm7']);
  assert.equal(generateMutants('f.js', src, 'javascript', { operators: ['relational'] }).length, 1);
});

const CALC = `// adults are 18 or older (a comment: 18 + 1 must not be mutated)
export function isAdult(age) {
  return age >= 18;
}
`;

test('mutation analysis: a good test kills mutants, a weak test kills none; the workspace is never modified', async () => {
  const ws = await fixture({
    'calc.mjs': CALC,
    'good.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { isAdult } from './calc.mjs';\ntest('boundary', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\n",
    'weak.test.mjs': "import { test } from 'node:test'; import { isAdult } from './calc.mjs';\ntest('smoke', () => { isAdult(30); });\n",
  });
  const sandbox = createLocalSandbox();
  const common = { ws, file: 'calc.mjs', runner: nodeTestRunner(), sandbox, timeoutMs: 120_000, signal: new AbortController().signal };
  const good = await runMutationAnalysis({ ...common, selector: 'good.test.mjs' });
  assert.equal(good.baseline.passed, true);
  assert.deepEqual(good.mutants.map((m) => [m.original, m.replacement, m.status]), [['>=', '>', 'killed'], ['18', '17', 'killed'], ['18', '19', 'killed']]);
  assert.equal(good.killed, 3);
  assert.equal(good.score, 1);
  const weak = await runMutationAnalysis({ ...common, selector: 'weak.test.mjs' });
  assert.equal(weak.killed, 0);
  assert.equal(weak.survived, 3);
  assert.equal(weak.score, 0);
  assert.equal(await readFile(join(ws.root, 'calc.mjs'), 'utf8'), CALC, 'the original workspace is untouched');
  assert.deepEqual((await readdir(ws.tempDir!)).filter((d) => d.startsWith('mutation-')), [], 'mutation copies are cleaned up');
});

test('mutation analysis: a failing baseline is refused (failures would be fake kills); unsupported files rejected', async () => {
  const ws = await fixture({
    'calc.mjs': CALC,
    'red.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { isAdult } from './calc.mjs';\ntest('wrong', () => { assert.equal(isAdult(1), true); });\n",
    'notes.txt': 'a + b',
  });
  const common = { ws, runner: nodeTestRunner(), sandbox: createLocalSandbox(), timeoutMs: 60_000, signal: new AbortController().signal };
  await assert.rejects(runMutationAnalysis({ ...common, file: 'calc.mjs', selector: 'red.test.mjs' }), (e) => isHypertestError(e, 'precondition_failed') && /baseline tests do not pass/.test(e.message));
  await assert.rejects(runMutationAnalysis({ ...common, file: 'notes.txt' }), (e) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(runMutationAnalysis({ ...common, file: '../escape.mjs' }), (e) => isHypertestError(e, 'permission_denied'));
});

test('mutation analysis in a monorepo: tests importing a workspace package by name exercise the MUTATED copy', async () => {
  const ws = await fixture({
    'package.json': JSON.stringify({ type: 'module', workspaces: ['packages/*'] }),
    'packages/lib/package.json': JSON.stringify({ name: '@fx/lib', type: 'module', exports: './index.mjs' }),
    'packages/lib/index.mjs': 'export function isAdult(age) {\n  return age >= 18;\n}\n',
    'test/lib.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { isAdult } from '@fx/lib';\ntest('boundary', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\n",
  });
  // what npm/pnpm/yarn workspaces create: a relative link from node_modules into the workspace
  await mkdir(join(ws.root, 'node_modules/@fx'), { recursive: true });
  await symlink('../../packages/lib', join(ws.root, 'node_modules/@fx/lib'));
  const r = await runMutationAnalysis({ ws, file: 'packages/lib/index.mjs', runner: nodeTestRunner(), sandbox: createLocalSandbox(), selector: 'test/lib.test.mjs', timeoutMs: 120_000, signal: new AbortController().signal });
  assert.equal(r.baseline.passed, true);
  assert.deepEqual(r.mutants.map((m) => [m.original, m.replacement, m.status]), [['>=', '>', 'killed'], ['18', '17', 'killed'], ['18', '19', 'killed']]);
  assert.equal(r.score, 1);
  assert.equal(await readFile(join(ws.root, 'packages/lib/index.mjs'), 'utf8'), 'export function isAdult(age) {\n  return age >= 18;\n}\n');
});

test('mutation analysis never writes a mutant into the original through a symlink (absolute in-root links, node_modules)', async () => {
  const ORIGINAL = 'export function isAdult(age) {\n  return age >= 18;\n}\n';
  const ws = await fixture({
    'real/calc.mjs': ORIGINAL,
    'good.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { isAdult } from './lib/calc.mjs';\ntest('boundary', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\n",
    'node_modules/dep/index.mjs': 'export const one = 1 + 0;\n',
  });
  await symlink(join(ws.root, 'real'), join(ws.root, 'lib')); // an ABSOLUTE link inside the workspace
  const inner = createLocalSandbox();
  const observed = new Set<string>();
  // observe the ORIGINAL file every time a test run starts (i.e. while a mutant is applied)
  const spy: SandboxRunner = { run: async (w, cmd, o) => { observed.add(await readFile(join(ws.root, 'real/calc.mjs'), 'utf8')); return inner.run(w, cmd, o); } };
  const common = { ws, runner: nodeTestRunner(), sandbox: spy, selector: 'good.test.mjs', timeoutMs: 120_000, signal: new AbortController().signal };
  const r = await runMutationAnalysis({ ...common, file: 'lib/calc.mjs' });
  assert.deepEqual([...observed], [ORIGINAL], 'the original never changed during the analysis');
  assert.deepEqual(r.mutants.map((m) => m.status), ['killed', 'killed', 'killed'], 'the tests exercised the mutated copy');
  await assert.rejects(runMutationAnalysis({ ...common, file: 'node_modules/dep/index.mjs' }), (e) => isHypertestError(e, 'precondition_failed') && /outside the private mutation copy/.test(e.message));
  assert.equal(await readFile(join(ws.root, 'node_modules/dep/index.mjs'), 'utf8'), 'export const one = 1 + 0;\n');
});
