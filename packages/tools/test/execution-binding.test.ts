/**
 * D-0 / D-1 execution binding of test evidence (tools side): `test.run` and `mutation.run` record which test files they
 * executed (digest, static check of changed files) and on which code; `test.run` revision "base" runs the workspace's tests
 * on the base revision (product code restored) — the known-good run of a regression test for a defect of the candidate.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@hypertest/core';
import type { EvidenceRecord } from '@hypertest/domain';
import { createGitRepo } from '@hypertest/testkit';
import { builtinTools, staticCheckCommand, type ToolExecutionResult, type ToolRuntime, type WorkspaceHandle } from '../src/index.ts';
import { RUN, capability, openToolEnv, request, runtimeFor, type ToolEnv } from './helpers.ts';

let env: ToolEnv;
let repo: Awaited<ReturnType<typeof createGitRepo>>;
let rt: ToolRuntime;
let wt: WorkspaceHandle;

const OK = 'export function applyDiscount(price, pct) {\n  return Math.round((price * (100 - pct)) / 100);\n}\n';
const BUG = 'export function applyDiscount(price, pct) {\n  return Math.round((price * (100 - pct * 2)) / 100);\n}\n';
const EXISTING = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/pricing.mjs';\ntest('zero discount keeps the price', () => { assert.equal(applyDiscount(1000, 0), 1000); });\n";
const REGRESSION = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/pricing.mjs';\ntest('applies a 10% discount', () => { assert.equal(applyDiscount(1000, 10), 900); });\n";

before(async () => {
  env = await openToolEnv();
  // the base commit is correct; the candidate (HEAD) carries the seeded defect
  repo = await createGitRepo({ 'src/pricing.mjs': OK, 'test/zero.test.mjs': EXISTING, 'package.json': '{"type":"module"}\n' }, [{ message: 'faster discount', files: { 'src/pricing.mjs': BUG } }]);
  // the worktree is the candidate (as the control plane opens it: at target.commit); the base commit is target.baseCommit
  wt = await env.workspaces.isolatedWorktree({ runId: RUN, workItemId: 'wi_bind', repoPath: repo.path, baseCommit: repo.commits[1]! });
  rt = runtimeFor(env, builtinTools({ sandbox: env.sandbox, workspaces: env.workspaces }));
});
after(async () => {
  await env.dispose();
  await repo.cleanup();
});

const run = (toolId: string, input: Record<string, unknown>) => rt.execute(request(toolId, input, wt, { workItemId: 'wi_bind', capability: capability({ workItemId: 'wi_bind' }) }));
function ok(r: ToolExecutionResult): ToolExecutionResult {
  assert.equal(r.status, 'success', `${r.toolId}: ${r.status} ${JSON.stringify(r.error)} ${r.modelText.slice(0, 800)}`);
  return r;
}
async function record(r: ToolExecutionResult, type: string): Promise<Record<string, any>> {
  const e = (await env.evidence.getMany(r.evidenceRefs)).find((x): x is EvidenceRecord => x?.evidenceType === type);
  assert.ok(e, `no ${type} evidence`);
  return e.structured as Record<string, any>;
}

test('a regression test: fails on the candidate (bound known-bad), passes on the BASE revision (bound known-good); the workspace is never modified', async () => {
  await writeFile(join(wt.root, 'test', 'regression.test.mjs'), REGRESSION);
  const digest = sha256Hex(REGRESSION);
  const bad = ok(await run('test.run', { framework: 'node_test', selector: 'test/regression.test.mjs' }));
  const badRec = await record(bad, 'test-result');
  assert.equal(badRec['passed'], false);
  assert.deepEqual(badRec['executedTests'], { attribution: 'complete', unattributedCases: 0, files: [{ path: 'test/regression.test.mjs', sha256: digest, cases: 1, staticCheck: { checker: 'node --check', ok: true } }] });
  assert.equal(badRec['codeRevision']['kind'], 'workspace');
  assert.equal(badRec['codeRevision']['baseCommit'], repo.commits[1]);
  const good = ok(await run('test.run', { framework: 'node_test', selector: 'test/regression.test.mjs', revision: 'base', baseCommit: repo.commits[0] }));
  const goodRec = await record(good, 'test-result');
  assert.equal(goodRec['passed'], true, good.modelText);
  assert.equal(goodRec['codeRevision']['kind'], 'base');
  assert.equal(goodRec['codeRevision']['baseCommit'], repo.commits[0]);
  assert.notEqual(goodRec['codeRevision']['treeDigest'], badRec['codeRevision']['treeDigest'], 'known-good and known-bad ran on different code');
  assert.deepEqual(goodRec['executedTests']['files'], [{ path: 'test/regression.test.mjs', sha256: digest, cases: 1, staticCheck: { checker: 'node --check', ok: true } }]);
  assert.match(good.modelText, /KNOWN-GOOD RUN ON THE BASE REVISION/);
  // the candidate workspace still has the defect and the test (nothing was restored in place), and no copy is left behind
  assert.equal(await readFile(join(wt.root, 'src', 'pricing.mjs'), 'utf8'), BUG);
  assert.equal(await readFile(join(wt.root, 'test', 'regression.test.mjs'), 'utf8'), REGRESSION);
  assert.deepEqual((await readdir(wt.tempDir!)).filter((d) => d.startsWith('base-')), []);
});

test('revision "base" needs a git base commit and a test framework', async () => {
  const scratch = await env.workspaces.scratch({ runId: RUN, workItemId: 'wi_scratch_base' });
  await writeFile(join(scratch.root, 'package.json'), '{"type":"module"}\n');
  const r = await rt.execute(request('test.run', { framework: 'node_test', revision: 'base', baseCommit: repo.commits[0] }, scratch, { workItemId: 'wi_scratch_base', capability: capability({ workItemId: 'wi_scratch_base' }) }));
  assert.equal(r.status, 'failed');
  assert.match(r.modelText, /revision "base" needs a git workspace with a base commit/);
  const noBase = await run('test.run', { framework: 'node_test', selector: 'test/zero.test.mjs', revision: 'base' });
  assert.equal(noBase.status, 'failed');
  assert.match(noBase.modelText, /needs the run's base commit/);
  const cmd = await run('test.run', { framework: 'command', command: ['node', '--version'], revision: 'base' });
  assert.equal(cmd.status, 'failed');
});

test('mutation.run records the test files it executed: only the selected file — another test\'s kills are attributable to it, not to an artifact', async () => {
  // run on the candidate's code: the existing zero-discount test passes there (baseline green)
  const m = ok(await run('mutation.run', { file: 'src/pricing.mjs', testSelector: 'test/zero.test.mjs', framework: 'node_test', maxMutants: 6 }));
  const rec = await record(m, 'mutation-result');
  assert.deepEqual(rec['executedTests']['files'].map((f: { path: string }) => f.path), ['test/zero.test.mjs']);
  assert.equal(rec['executedTests']['attribution'], 'complete');
  assert.equal(rec['executedTests']['files'][0]['sha256'], sha256Hex(EXISTING));
  assert.equal(rec['codeRevision']['kind'], 'workspace');
  assert.equal(typeof rec['codeRevision']['treeDigest'], 'string');
  assert.match(m.modelText, /executed test files: test\/zero\.test\.mjs — this result validates a test artifact only when it executed exactly that artifact's file/);
  // review: which file was mutated, derived by the tool (the candidate's product code, unchanged in the workspace)
  assert.deepEqual(rec['mutatedFile'], { path: 'src/pricing.mjs', isTestFile: false, changedSinceBase: false });
  assert.match(m.modelText, /\nmutated: src\/pricing\.mjs\n/);
});

test('mutation.run refuses test code as its mutation target and flags a product file written in the workspace (review: self-mutation bypass)', async () => {
  // mutating the test itself would "kill" mutants of its own (possibly tautological) assertions: refused before anything runs
  await writeFile(join(wt.root, 'test', 'weak.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/pricing.mjs';\ntest('applies a 10% discount', () => { assert.ok(applyDiscount(1000, 10) > 0); assert.equal(10 * 2, 20); });\n");
  for (const file of ['test/weak.test.mjs', 'test/zero.test.mjs', 'src/__tests__/helper.mjs']) {
    const r = await run('mutation.run', { file, testSelector: 'test/weak.test.mjs', framework: 'node_test', maxMutants: 4 });
    assert.equal(r.status, 'failed', file);
    assert.equal(r.error?.code, 'invalid_argument', file);
    assert.match(r.modelText, /is test code: mutation\.run mutates the candidate's PRODUCT source/, file);
    assert.deepEqual(r.evidenceRefs, [], `${file}: no evidence recorded`);
  }
  // a product-looking helper the agent wrote in its workspace: recorded as changed since the base (the binding refuses it)
  await writeFile(join(wt.root, 'src', 'checks.mjs'), 'export const twice = (n) => n * 2;\n');
  await writeFile(join(wt.root, 'test', 'uses-helper.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { twice } from '../src/checks.mjs';\ntest('twice', () => { assert.equal(twice(10), 20); });\n");
  const helper = ok(await run('mutation.run', { file: 'src/checks.mjs', testSelector: 'test/uses-helper.test.mjs', framework: 'node_test', maxMutants: 4 }));
  const rec = await record(helper, 'mutation-result');
  assert.ok((rec['killed'] as number) >= 1, 'the helper\'s mutants are killed — which proves nothing about the product');
  assert.deepEqual(rec['mutatedFile'], { path: 'src/checks.mjs', isTestFile: false, changedSinceBase: true });
  assert.match(helper.modelText, /mutated: src\/checks\.mjs \(added or modified in your workspace: mutants of a file you wrote show no sensitivity/);
});

test('static check commands are framework-appropriate (JS, TS, Python, Go); other languages fall back to clean collection', () => {
  assert.deepEqual(staticCheckCommand('t/a.test.mjs', '/tmp')?.argv, ['node', '--check', 't/a.test.mjs']);
  assert.equal(staticCheckCommand('t/a.test.ts', '/tmp')?.checker, 'typescript strip + node --check');
  assert.equal(staticCheckCommand('tests/test_a.py', '/tmp')?.checker, 'python3 -m py_compile');
  assert.deepEqual(staticCheckCommand('pkg/a_test.go', '/tmp')?.argv, ['gofmt', '-e', '-l', 'pkg/a_test.go']);
  assert.equal(staticCheckCommand('ui/a.test.tsx', '/tmp'), undefined);
});

test('the TypeScript and Python static checks catch syntax errors in the sandbox', async () => {
  await writeFile(join(wt.root, 'test', 'typed.test.ts'), "import { test } from 'node:test';\ntest('t', (): void => { const n: number = 1; void n; });\n");
  await writeFile(join(wt.root, 'test', 'broken.test.ts'), "const x: number = ;\n");
  const tsOk = await env.sandbox.run(wt, staticCheckCommand('test/typed.test.ts', wt.tempDir!)!.argv, { timeoutMs: 30_000, signal: new AbortController().signal });
  assert.equal(tsOk.exitCode, 0, tsOk.stderr);
  const tsBad = await env.sandbox.run(wt, staticCheckCommand('test/broken.test.ts', wt.tempDir!)!.argv, { timeoutMs: 30_000, signal: new AbortController().signal });
  assert.notEqual(tsBad.exitCode, 0);
  await writeFile(join(wt.root, 'test', 'test_ok.py'), 'def test_a():\n    assert 1 == 1\n');
  await writeFile(join(wt.root, 'test', 'test_bad.py'), 'def test_a(:\n    pass\n');
  const pyOk = await env.sandbox.run(wt, staticCheckCommand('test/test_ok.py', wt.tempDir!)!.argv, { timeoutMs: 30_000, signal: new AbortController().signal });
  assert.equal(pyOk.exitCode, 0, pyOk.stderr);
  const pyBad = await env.sandbox.run(wt, staticCheckCommand('test/test_bad.py', wt.tempDir!)!.argv, { timeoutMs: 30_000, signal: new AbortController().signal });
  assert.notEqual(pyBad.exitCode, 0);
  // py_compile never writes bytecode into the workspace
  assert.deepEqual((await readdir(join(wt.root, 'test'))).filter((f) => f.includes('pycache')), []);
});
