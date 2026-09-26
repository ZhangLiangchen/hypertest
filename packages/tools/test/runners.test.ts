import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import { testDeps } from '@hypertest/testkit';
import {
  applyPytestSummary, commandRunner, createLocalSandbox, createWorkspaceManager, goSelectorArgs, goTestRunner, jestRunner, nodeTestRunner, parseGoTestJson, parseJestJson, parseJunitCases, pytestRunner, vitestRunner,
  type TestRunnerAdapter, type WorkspaceHandle, type WorkspaceManager,
} from '../src/index.ts';
import { SANDBOX, tempDir } from './helpers.ts';

let base: Awaited<ReturnType<typeof tempDir>>;
let wm: WorkspaceManager;
const sandbox = createLocalSandbox();
const never = () => new AbortController().signal;
let n = 0;

async function fixture(files: Record<string, string>): Promise<WorkspaceHandle> {
  const ws = await wm.scratch({ runId: 'run_runners', workItemId: `wi_${++n}` });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(ws.root, rel, '..'), { recursive: true });
    await writeFile(join(ws.root, rel), content);
  }
  return ws;
}

async function run(runner: TestRunnerAdapter, ws: WorkspaceHandle, extra: { selector?: string; coverage?: boolean } = {}) {
  return runner.run(ws, { timeoutMs: 120_000, signal: never(), ...extra }, sandbox);
}

before(async () => {
  base = await tempDir('ht-runners-');
  wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX });
});
after(async () => {
  await base.cleanup();
});

// ----------------------------------------------------------------------------- node:test (real)

const NODE_TESTS = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => { assert.equal(1 + 1, 2); });
test('fails', () => { assert.equal(1 + 1, 3); });
test('skipped', { skip: 'later' }, () => {});
describe('suite', () => { test('inner', () => {}); });
`;

test('node:test: pass, fail, skip and describe nesting are parsed from real junit output', async () => {
  const ws = await fixture({ 'math.test.mjs': NODE_TESTS });
  const runner = nodeTestRunner();
  assert.equal(await runner.detect(ws), true);
  const out = await run(runner, ws);
  const r = out.result;
  assert.equal(r.framework, 'node_test');
  assert.equal(r.passed, false);
  assert.equal(r.harnessError, undefined);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.totals, { passed: 2, failed: 1, skipped: 1, xfail: 0, xpass: 0, error: 0, total: 4 });
  assert.deepEqual(r.cases.map((c) => [c.name, c.status]), [['adds', 'passed'], ['fails', 'failed'], ['skipped', 'skipped'], ['suite > inner', 'passed']]);
  assert.match(r.cases[1]!.message!, /Expected values to be strictly equal/);
  assert.equal(out.rawReport?.mimeType, 'application/xml');
  assert.match(out.stdout, /✖ fails/);
});

test('node:test: all passing ⇒ passed; file selector attributes cases; name pattern selects', async () => {
  const ws = await fixture({ 'a.test.mjs': "import { test } from 'node:test'; test('one', () => {}); test('two', () => {});\n", 'b.test.mjs': "import { test } from 'node:test'; test('three', () => { throw new Error('x'); });\n" });
  const onlyA = await run(nodeTestRunner(), ws, { selector: 'a.test.mjs' });
  assert.equal(onlyA.result.passed, true);
  assert.deepEqual(onlyA.result.cases.map((c) => c.id), ['a.test.mjs::one', 'a.test.mjs::two']);
  assert.equal(onlyA.result.cases[0]!.file, 'a.test.mjs');
  const byName = await run(nodeTestRunner(), ws, { selector: 'a.test.mjs::^two$' });
  assert.deepEqual(byName.result.cases.filter((c) => c.status === 'passed').map((c) => c.name), ['two']);
  await assert.rejects(run(nodeTestRunner(), ws, { selector: '--require=/etc/evil' }), (e) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(run(nodeTestRunner(), ws, { selector: '../outside.test.mjs::x' }), (e) => isHypertestError(e, 'permission_denied'));
});

test('fake-green guard: zero tests ⇒ passed=false; a test file that cannot load ⇒ harness error, not an assertion failure', async () => {
  const empty = await fixture({ 'empty.test.mjs': "import 'node:test';\n" });
  const r0 = (await run(nodeTestRunner(), empty)).result;
  assert.equal(r0.totals.total, 0);
  assert.equal(r0.passed, false);
  const broken = await fixture({ 'ok.test.mjs': "import { test } from 'node:test'; test('fine', () => {});\n", 'broken.test.mjs': "throw new Error('cannot load');\n" });
  const rb = (await run(nodeTestRunner(), broken)).result;
  assert.equal(rb.passed, false);
  assert.match(rb.harnessError ?? '', /test harness errors: broken\.test\.mjs/);
  assert.equal(rb.cases.find((c) => c.name === 'broken.test.mjs')?.status, 'error');
  assert.equal(rb.totals.failed, 0);
});

test('node:test coverage: lcov is parsed with workspace-relative paths', async () => {
  const ws = await fixture({ 'lib.mjs': 'export function f(x) {\n  if (x > 0) return 1;\n  return 2;\n}\n', 'lib.test.mjs': "import { test } from 'node:test'; import { f } from './lib.mjs'; test('f', () => { f(1); });\n" });
  const out = await run(nodeTestRunner(), ws, { coverage: true });
  assert.equal(out.result.passed, true);
  const lib = out.coverage?.files.find((f) => f.path === 'lib.mjs');
  assert.ok(lib, JSON.stringify(out.coverage?.files.map((f) => f.path)));
  assert.equal(out.coverage!.format, 'lcov');
  assert.ok(lib.lines.total > 0 && lib.lines.covered < lib.lines.total, 'line 3 is not covered');
});

// ----------------------------------------------------------------------------- pytest (real when available)

const pytestAvailable = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0 || spawnSync('pytest', ['--version']).status === 0;
const PY_TESTS = `import pytest
def test_ok(): assert 1 + 1 == 2
def test_fail(): assert 1 + 1 == 3
@pytest.mark.skip(reason="nope")
def test_skip(): pass
@pytest.mark.xfail(reason="known bug")
def test_xfail(): assert False
@pytest.mark.xfail(reason="fixed?")
def test_xpass(): assert True
`;

test('pytest: pass/fail/skip/xfail/xpass, selectors, collection errors and no-tests are distinguished', { skip: pytestAvailable ? false : 'pytest is not installed (neither `python3 -m pytest` nor `pytest`)' }, async () => {
  const ws = await fixture({ 'tests/test_x.py': PY_TESTS });
  const runner = pytestRunner();
  assert.equal(await runner.detect(ws), true);
  const r = (await run(runner, ws)).result;
  assert.equal(r.harnessError, undefined, r.harnessError);
  assert.deepEqual(r.totals, { passed: 1, failed: 1, skipped: 1, xfail: 1, xpass: 1, error: 0, total: 5 });
  assert.equal(r.passed, false);
  assert.equal(r.cases.find((c) => c.name === 'test_xpass')?.status, 'xpass');
  assert.equal(r.cases.find((c) => c.name === 'test_xfail')?.status, 'xfail');
  assert.equal(r.cases.find((c) => c.name === 'test_ok')?.id, 'tests.test_x::test_ok');
  const one = (await run(runner, ws, { selector: 'tests/test_x.py::test_ok' })).result;
  assert.equal(one.passed, true);
  assert.deepEqual(one.cases.map((c) => c.name), ['test_ok']);
  const k = (await run(runner, ws, { selector: 'ok or skip' })).result;
  assert.deepEqual(k.cases.map((c) => [c.name, c.status]), [['test_ok', 'passed'], ['test_skip', 'skipped']]);
  assert.equal(k.passed, true, 'a skip does not fail the run when a case passed');
  const broken = await fixture({ 'test_bad.py': 'import no_such_module_xyz\n' });
  const rb = (await run(runner, broken)).result;
  assert.equal(rb.passed, false);
  assert.match(rb.harnessError ?? '', /collection errors: test_bad|exited 2/);
  const none = await fixture({ 'pytest.ini': '[pytest]\n' });
  const rn = (await run(runner, none)).result;
  assert.equal(rn.passed, false);
  assert.equal(rn.totals.total, 0);
  assert.match(rn.harnessError ?? '', /no tests \(exit 5\)/);
});

test('pytest: a cancelled run surfaces as a cancellation, never as "pytest is not available"', async () => {
  const ws = await fixture({ 'tests/test_x.py': 'def test_ok(): pass\n' });
  const ctrl = new AbortController();
  ctrl.abort(new Error('run cancelled'));
  await assert.rejects(pytestRunner().run(ws, { timeoutMs: 10_000, signal: ctrl.signal }, sandbox), (e) => isHypertestError(e, 'cancelled'));
});

test('pytest junit parsing (xunit2) and the -rxX summary', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4"><testcase classname="tests.test_x" name="test_ok" time="0.001" /><testcase classname="tests.test_x" name="test_bad" time="0.002"><failure message="assert 2 == 3">E   assert 2 == 3</failure></testcase><testcase classname="tests.test_x.TestC" name="test_xp[a&amp;b]" time="0.000" /><testcase classname="tests.test_x" name="test_strict"><failure message="[XPASS(strict)] r">[XPASS(strict)] r</failure></testcase></testsuite></testsuites>`;
  const cases = parseJunitCases(xml, { framework: 'pytest' });
  applyPytestSummary(cases, 'XPASS tests/test_x.py::TestC::test_xp[a&b] - reason\n');
  assert.deepEqual(cases.map((c) => [c.id, c.status]), [
    ['tests.test_x::test_ok', 'passed'],
    ['tests.test_x::test_bad', 'failed'],
    ['tests.test_x.TestC::test_xp[a&b]', 'xpass'],
    ['tests.test_x::test_strict', 'xpass'],
  ]);
  assert.equal(cases[1]!.message, 'assert 2 == 3');
  assert.equal(cases[0]!.durationMs, 1);
});

// ----------------------------------------------------------------------------- go test (real when available)

const goAvailable = spawnSync('go', ['version']).status === 0;
test('go test: -json stream with subtests, selectors, build failures and coverage', { skip: goAvailable ? false : 'go toolchain is not installed' }, async () => {
  const ws = await fixture({
    'go.mod': 'module example.com/calc\n\ngo 1.21\n',
    'calc.go': 'package calc\n\nfunc Add(a, b int) int { return a + b }\n\nfunc Max(a, b int) int {\n\tif a > b {\n\t\treturn a\n\t}\n\treturn b\n}\n',
    'calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n\nfunc TestMax(t *testing.T) {\n\tt.Run("a", func(t *testing.T) {\n\t\tif Max(1, 2) != 2 {\n\t\t\tt.Fatal("x")\n\t\t}\n\t})\n\tt.Run("b", func(t *testing.T) { t.Fatal("boom") })\n}\n',
  });
  const runner = goTestRunner();
  assert.equal(await runner.detect(ws), true);
  const out = await run(runner, ws, { coverage: true });
  const r = out.result;
  assert.equal(r.harnessError, undefined, r.harnessError);
  assert.deepEqual(r.cases.map((c) => [c.id, c.status]), [
    ['example.com/calc::TestAdd', 'passed'],
    ['example.com/calc::TestMax', 'failed'],
    ['example.com/calc::TestMax/a', 'passed'],
    ['example.com/calc::TestMax/b', 'failed'],
  ]);
  assert.match(r.cases[3]!.message!, /boom/);
  assert.equal(r.passed, false);
  assert.equal(out.coverage?.format, 'go');
  assert.equal(out.coverage?.totals.branches, 'unknown');
  assert.ok(out.coverage!.totals.lines.total > 0);
  const add = (await run(runner, ws, { selector: '^TestAdd$' })).result;
  assert.equal(add.passed, true);
  assert.deepEqual(add.cases.map((c) => c.name), ['TestAdd']);
  const broken = await fixture({ 'go.mod': 'module example.com/bad\n\ngo 1.21\n', 'bad.go': 'package bad\n\nfunc X() int { return undefinedThing }\n', 'bad_test.go': 'package bad\n\nimport "testing"\n\nfunc TestX(t *testing.T) { X() }\n' });
  const rb = (await run(runner, broken)).result;
  assert.equal(rb.passed, false);
  assert.match(rb.harnessError ?? '', /build failed/);
});

test('go test -json parsing: unfinished tests and package failures without a failing test are harness problems', () => {
  const stream = [
    { Action: 'run', Package: 'p', Test: 'TestA' },
    { Action: 'output', Package: 'p', Test: 'TestA', Output: 'panic: nil map\n' },
    { Action: 'fail', Package: 'p' },
    { Action: 'run', Package: 'q', Test: 'TestB' },
    { Action: 'skip', Package: 'q', Test: 'TestB', Elapsed: 0.01 },
    { Action: 'fail', Package: 'r' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';
  const p = parseGoTestJson(stream);
  assert.deepEqual(p.cases.map((c) => [c.id, c.status]), [['p::TestA', 'error'], ['q::TestB', 'skipped']]);
  assert.equal(p.cases[1]!.durationMs, 10);
  assert.deepEqual(p.harnessProblems, ['test p::TestA did not finish', 'package r failed without a failing test: ']);
  assert.deepEqual(goSelectorArgs('./pkg/...::^TestX$'), { packages: ['./pkg/...'], run: '^TestX$' });
  assert.deepEqual(goSelectorArgs('./internal/...'), { packages: ['./internal/...'] });
  assert.deepEqual(goSelectorArgs('TestY'), { packages: ['./...'], run: 'TestY' });
});

// ----------------------------------------------------------------------------- jest / vitest JSON, command runner

test('jest/vitest JSON: statuses mapped, suite load failures become error cases', async () => {
  const root = '/repo';
  const json = JSON.stringify({
    testResults: [
      { name: '/repo/src/a.test.ts', status: 'failed', message: '', assertionResults: [
        { fullName: 'math adds', title: 'adds', ancestorTitles: ['math'], status: 'passed', duration: 3, failureMessages: [] },
        { fullName: 'math subtracts', title: 'subtracts', status: 'failed', duration: 1, failureMessages: ['Error: expected 1 to be 2\n  at x'] },
        { fullName: 'math later', title: 'later', status: 'pending', failureMessages: [] },
        { fullName: 'math todo', title: 'todo', status: 'todo', failureMessages: [] },
      ] },
      { name: '/repo/src/b.test.ts', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] },
    ],
  });
  const { cases, suiteErrors } = parseJestJson(json, root);
  assert.deepEqual(cases.map((c) => [c.id, c.status]), [
    ['src/a.test.ts::math adds', 'passed'],
    ['src/a.test.ts::math subtracts', 'failed'],
    ['src/a.test.ts::math later', 'skipped'],
    ['src/a.test.ts::math todo', 'skipped'],
    ['src/b.test.ts', 'error'],
  ]);
  assert.equal(cases[1]!.message, 'Error: expected 1 to be 2');
  assert.deepEqual(suiteErrors, ['src/b.test.ts']);
  const ws = await fixture({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^2' } }) });
  assert.equal(await vitestRunner().detect(ws), true);
  assert.equal(await jestRunner().detect(ws), false);
  // a fake vitest binary proves the argv and report plumbing without the real package
  const fake = await fixture({
    'package.json': '{}',
    'fake-vitest.mjs': `import { writeFileSync } from 'node:fs';\nconst out = process.argv.find((a) => a.startsWith('--outputFile=')).slice(13);\nwriteFileSync(out, JSON.stringify({ testResults: [{ name: process.cwd() + '/x.test.ts', status: 'passed', assertionResults: [{ fullName: 'x works', status: 'passed', failureMessages: [] }] }] }));\n`,
  });
  const res = await run(vitestRunner({ command: ['node', 'fake-vitest.mjs'] }), fake, { selector: 'works' });
  assert.deepEqual(res.result.command.slice(2), ['run', '--reporter=json', res.result.command[4]!, '-t', 'works']);
  assert.equal(res.result.passed, true);
  assert.deepEqual(res.result.cases.map((c) => c.id), ['x.test.ts::x works']);
});

test('command runner: exit code only; zero cases is never a pass unless explicitly allowed', async () => {
  const ws = await fixture({ 'ok.mjs': 'process.exit(0)\n', 'bad.mjs': 'process.exit(3)\n' });
  const strict = (await run(commandRunner({ command: ['node', 'ok.mjs'] }), ws)).result;
  assert.equal(strict.exitCode, 0);
  assert.deepEqual(strict.cases, []);
  assert.equal(strict.totals.total, 0);
  assert.equal(strict.passed, false);
  assert.equal((await run(commandRunner({ command: ['node', 'ok.mjs'], allowNoCases: true }), ws)).result.passed, true);
  assert.equal((await run(commandRunner({ command: ['node', 'bad.mjs'], allowNoCases: true }), ws)).result.passed, false);
  const missing = (await run(commandRunner({ command: ['no-such-binary-xyz'], allowNoCases: true }), ws)).result;
  assert.equal(missing.passed, false);
  assert.match(missing.harnessError ?? '', /could not be started/);
  assert.equal(await commandRunner({ command: ['x'] }).detect(ws), false);
  assert.throws(() => commandRunner({ command: [] }), (e) => isHypertestError(e, 'invalid_argument'));
});
