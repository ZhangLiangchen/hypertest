import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitRepo, testDeps } from '@hypertest/testkit';
import { BuiltinPolicyEngine, DEFAULT_GATE_SPEC, DEFAULT_POLICY_RULES, QualityGate } from '@hypertest/policy';
import { sha256Hex } from '@hypertest/core';
import type { EvidenceRecord, TestArtifact } from '@hypertest/domain';
import { builtinTools, createWorkspaceManager, parseNumstatPaths, patchPaths, whiteboxTools, type BuiltinToolOptions, type SandboxRunner, type ToolExecutionResult, type ToolRuntime, type WorkspaceHandle } from '../src/index.ts';
import { ALL_EFFECTS_PROFILE, RUN, SANDBOX, SECRET, WORK, capability, openToolEnv, request, runtimeFor, tempDir, type ToolEnv } from './helpers.ts';

let env: ToolEnv;
let repo: Awaited<ReturnType<typeof createGitRepo>>;
let outside: Awaited<ReturnType<typeof tempDir>>;
let wt: WorkspaceHandle;
let shared: WorkspaceHandle;
let options: BuiltinToolOptions;
let rt: ToolRuntime;

const CALC = 'export function isAdult(age) {\n  return age >= 18;\n}\n\nexport function add(a, b) {\n  return a + b;\n}\n';
const GOOD_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isAdult, add } from '../src/calc.mjs';\ntest('adult boundary', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\ntest('add', () => { assert.equal(add(2, 3), 5); });\n";

before(async () => {
  env = await openToolEnv();
  repo = await createGitRepo({ 'src/calc.mjs': CALC, 'test/calc.test.mjs': GOOD_TEST, 'README.md': '# fixture\nhello world\n', 'package.json': '{"type":"module","scripts":{"test":"node --test"}}\n' });
  outside = await tempDir('ht-tools-outside-');
  await writeFile(join(outside.path, 'secret.txt'), 'outside secret');
  // a failing hook in the repository must never run (git.commit uses --no-verify and hooksPath=/dev/null)
  await writeFile(join(repo.path, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${join(outside.path, 'hook-ran')}\nexit 1\n`);
  await chmod(join(repo.path, '.git/hooks/pre-commit'), 0o755);
  wt = await env.workspaces.isolatedWorktree({ runId: RUN, workItemId: WORK, repoPath: repo.path });
  shared = await env.workspaces.sharedSnapshot({ runId: RUN, repoPath: repo.path, commit: repo.commits[0]! });
  options = { sandbox: env.sandbox, workspaces: env.workspaces };
  rt = runtimeFor(env, builtinTools(options));
});
after(async () => {
  await env.dispose();
  await repo.cleanup();
  await outside.cleanup();
});

const exec = (toolId: string, input: unknown, ws: WorkspaceHandle = wt) => rt.execute(request(toolId, input, ws));
function ok(r: ToolExecutionResult): ToolExecutionResult {
  assert.equal(r.status, 'success', `${r.toolId}: ${r.status} ${JSON.stringify(r.error)} ${r.modelText.slice(0, 500)}`);
  return r;
}

test('builtinTools: every white-box tool registers with a unique id and a valid schema', () => {
  const ids = whiteboxTools(options).map((s) => s.id);
  assert.deepEqual(ids, ['fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.apply_patch', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'git.commit', 'shell.exec', 'test.run', 'coverage.collect', 'mutation.run', 'code.symbols', 'code.references']);
  // the black-box half is part of the catalog (static import: a renamed export cannot silently drop it)
  const all = builtinTools(options).map((s) => s.id);
  for (const id of [...ids, 'http.request', 'metrics.query', 'load.start', 'load.observe', 'load.stop', 'env.restart', 'env.inject_fault', 'env.deploy']) assert.ok(all.includes(id), id);
  assert.equal(new Set(all).size, all.length, 'ids are unique');
  assert.match(rt.registry.revision(), /^[0-9a-f]{64}$/);
});

test('fs.read: content, line ranges, binary files; traversal and symlink escapes are denied', async () => {
  const r = ok(await exec('fs.read', { path: 'src/calc.mjs' }));
  assert.equal(r.modelText, CALC.replace(/\n$/, ''));
  assert.deepEqual({ ...(r.structured as object), sha256: undefined }, { path: 'src/calc.mjs', sizeBytes: CALC.length, sha256: undefined, totalLines: 7, startLine: 1, endLine: 7, truncated: false, binary: false });
  const range = ok(await exec('fs.read', { path: 'src/calc.mjs', startLine: 2, endLine: 2 }));
  assert.equal(range.modelText, '  return age >= 18;');
  const esc = await exec('fs.read', { path: '../../../etc/passwd' });
  assert.equal(esc.status, 'denied');
  assert.match(esc.error!.message, /resource_not_canonical/);
  const abs = await exec('fs.read', { path: '/etc/passwd' });
  assert.equal(abs.status, 'denied');
  await symlink(join(outside.path, 'secret.txt'), join(wt.root, 'leak'));
  const link = await exec('fs.read', { path: 'leak' });
  assert.equal(link.status, 'failed');
  assert.equal(link.error?.code, 'permission_denied');
  assert.doesNotMatch(link.modelText, /outside secret/);
  execFileSync('rm', [join(wt.root, 'leak')]);
  await writeFile(join(wt.root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const bin = ok(await exec('fs.read', { path: 'bin.dat' }));
  assert.equal((bin.structured as { binary: boolean }).binary, true);
  execFileSync('rm', [join(wt.root, 'bin.dat')]);
  assert.equal((await exec('fs.read', { path: 'nope.txt' })).error?.code, 'not_found');
});

test('fs.list and fs.search (ripgrep and the built-in fallback)', async () => {
  const list = ok(await exec('fs.list', { path: '.', depth: 2 }));
  const paths = (list.structured as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
  assert.deepEqual(paths, ['README.md', 'package.json', 'src', 'src/calc.mjs', 'test', 'test/calc.test.mjs']);
  const glob = ok(await exec('fs.list', { glob: '*.mjs', depth: 3 }));
  assert.deepEqual((glob.structured as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/calc.mjs', 'test/calc.test.mjs']);
  const s = ok(await exec('fs.search', { pattern: 'isAdult(' }));
  assert.equal((s.structured as { engine: string }).engine, 'ripgrep');
  assert.deepEqual((s.structured as { matches: Array<{ path: string; line: number }> }).matches.map((m) => `${m.path}:${m.line}`).sort(), ['src/calc.mjs:1', 'test/calc.test.mjs:4']);
  const re = ok(await exec('fs.search', { pattern: 'return a [+-] b', isRegex: true, glob: 'src/**' }));
  assert.deepEqual((re.structured as { matches: Array<{ path: string; text: string }> }).matches, [{ path: 'src/calc.mjs', line: 6, text: '  return a + b;' }]);
  const bad = await exec('fs.search', { pattern: '(unclosed', isRegex: true });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error?.code, 'invalid_argument');
  const noRg: SandboxRunner = { run: (ws, cmd, o) => (cmd[0] === 'rg' ? Promise.resolve({ exitCode: 127, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, spawnError: 'ENOENT' }) : env.sandbox.run(ws, cmd, o)) };
  const fallback = runtimeFor(env, whiteboxTools({ ...options, sandbox: noRg }));
  const js = await fallback.execute(request('fs.search', { pattern: 'ISADULT', caseSensitive: false, glob: '*.mjs' }, wt));
  assert.equal(js.status, 'success');
  assert.equal((js.structured as { engine: string }).engine, 'js');
  assert.deepEqual((js.structured as { matches: Array<{ path: string; line: number }> }).matches.map((m) => `${m.path}:${m.line}`), ['src/calc.mjs:1', 'test/calc.test.mjs:3', 'test/calc.test.mjs:4']);
});

test('fs.write: isolated worktree only; read-only snapshots and symlink escapes refused', async () => {
  const w = ok(await exec('fs.write', { path: 'notes/new.txt', content: 'hello\n' }));
  assert.deepEqual({ ...(w.structured as object), sha256: undefined }, { path: 'notes/new.txt', bytes: 6, sha256: undefined, created: true });
  assert.equal(await readFile(join(wt.root, 'notes/new.txt'), 'utf8'), 'hello\n');
  assert.equal(existsSync(join(repo.path, 'notes/new.txt')), false);
  const ro = await exec('fs.write', { path: 'x.txt', content: 'x' }, shared);
  assert.equal(ro.status, 'failed');
  assert.equal(ro.error?.code, 'permission_denied');
  assert.equal(existsSync(join(shared.root, 'x.txt')), false);
  await symlink(outside.path, join(wt.root, 'out'));
  const esc = await exec('fs.write', { path: 'out/pwned.txt', content: 'x' });
  assert.equal(esc.error?.code, 'permission_denied');
  assert.equal(existsSync(join(outside.path, 'pwned.txt')), false);
  execFileSync('rm', ['-r', join(wt.root, 'out'), join(wt.root, 'notes')]);
});

test('fs.apply_patch: check then apply; non-applying and escaping patches change nothing', async () => {
  const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n # fixture\n-hello world\n+hello patched world\n';
  const check = ok(await exec('fs.apply_patch', { patch, check: true }));
  assert.deepEqual(check.structured, { files: ['README.md'], applied: false, additions: 1, deletions: 1 });
  assert.equal(await readFile(join(wt.root, 'README.md'), 'utf8'), '# fixture\nhello world\n');
  ok(await exec('fs.apply_patch', { patch }));
  assert.equal(await readFile(join(wt.root, 'README.md'), 'utf8'), '# fixture\nhello patched world\n');
  const again = await exec('fs.apply_patch', { patch });
  assert.equal(again.status, 'failed');
  assert.equal(again.error?.code, 'precondition_failed');
  assert.match(again.modelText, /patch does not apply/);
  const plain = ok(await exec('fs.apply_patch', { patch: '--- src/new.txt\n+++ src/new.txt\n@@ -0,0 +1 @@\n+created by a p0 patch\n'.replace('--- src/new.txt', '--- /dev/null') }));
  assert.deepEqual((plain.structured as { files: string[] }).files, ['src/new.txt']);
  assert.equal(await readFile(join(wt.root, 'src/new.txt'), 'utf8'), 'created by a p0 patch\n');
  const escape = await exec('fs.apply_patch', { patch: '--- a/../../evil.txt\n+++ b/../../evil.txt\n@@ -0,0 +1 @@\n+x\n' });
  assert.equal(escape.status, 'denied');
  assert.match(escape.error!.message, /resource_not_canonical/);
  const ro = await exec('fs.apply_patch', { patch }, shared);
  assert.equal(ro.error?.code, 'permission_denied');
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: wt.root });
  execFileSync('rm', [join(wt.root, 'src/new.txt')]);
});

test('git tools: status, diff (recorded as git-diff evidence), log, show, blame; commit without hooks', async () => {
  await writeFile(join(wt.root, 'src/calc.mjs'), CALC.replace('>= 18', '> 18'));
  await writeFile(join(wt.root, 'untracked.txt'), 'u\n');
  const status = ok(await exec('git.status', {}));
  assert.deepEqual((status.structured as { entries: unknown[] }).entries, [{ index: ' ', worktree: 'M', path: 'src/calc.mjs' }, { index: '?', worktree: '?', path: 'untracked.txt' }]);
  const diff = ok(await exec('git.diff', {}));
  assert.match(diff.modelText, /-  return age >= 18;\n\+  return age > 18;/);
  assert.equal(diff.evidenceRefs.length, 1);
  const ev = (await env.evidence.get(diff.evidenceRefs[0]!))!;
  assert.equal(ev.evidenceType, 'git-diff');
  assert.equal(ev.provenance.commit, wt.baseCommit);
  const badRev = await exec('git.diff', { base: '--output=/tmp/x' });
  assert.equal(badRev.status, 'failed');
  assert.equal(badRev.error?.code, 'schema_violation');
  const log = ok(await exec('git.log', { maxCount: 5 }));
  assert.deepEqual((log.structured as { commits: Array<{ subject: string; sha: string }> }).commits.map((c) => [c.sha, c.subject]), [[repo.commits[0], 'initial']]);
  const show = ok(await exec('git.show', { rev: 'HEAD', path: 'src/calc.mjs' }));
  assert.equal(show.modelText, CALC);
  const blame = ok(await exec('git.blame', { path: 'src/calc.mjs', startLine: 1, endLine: 2 }));
  assert.deepEqual((blame.structured as { lines: Array<{ line: number; commit: string; content: string }> }).lines.map((l) => [l.line, l.commit === '0000000000000000000000000000000000000000' ? 'uncommitted' : l.commit, l.content]), [[1, repo.commits[0], 'export function isAdult(age) {'], [2, 'uncommitted', '  return age > 18;']]);
  const commit = ok(await exec('git.commit', { message: 'agent: tighten boundary' }));
  const c = commit.structured as { commit: string; branch: string; files: string[] };
  assert.equal(c.branch, `ht/${RUN}/${WORK}`);
  assert.deepEqual(c.files, ['src/calc.mjs', 'untracked.txt']);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%an <%ae>|%s'], { cwd: wt.root, encoding: 'utf8' }).trim(), 'Hypertest Agent <agent@hypertest.invalid>|agent: tighten boundary');
  assert.equal(existsSync(join(outside.path, 'hook-ran')), false, 'repository hooks never run');
  const nothing = await exec('git.commit', { message: 'empty' });
  assert.equal(nothing.status, 'failed');
  assert.equal(nothing.error?.code, 'precondition_failed');
  const scratch = await env.workspaces.scratch({ runId: RUN, workItemId: 'wi_scratch' });
  assert.equal((await exec('git.commit', { message: 'x' }, scratch)).error?.code, 'permission_denied');
  execFileSync('git', ['reset', '-q', '--hard', repo.commits[0]!], { cwd: wt.root });
});

test('shell.exec: allowlisted argv only (no shells, no paths), stdout/stderr evidence, exit codes and timeouts', async () => {
  const r = ok(await exec('shell.exec', { command: ['node', '-e', "console.log('out'); console.error('err'); process.exit(3)"] }));
  assert.equal((r.structured as { exitCode: number }).exitCode, 3, 'a non-zero exit is still a successful tool call');
  assert.match(r.modelText, /^exit 3\n--- stdout ---\nout\n\n--- stderr ---\nerr\n/);
  assert.equal(r.evidenceRefs.length, 2);
  const [out, err] = await env.evidence.getMany(r.evidenceRefs);
  assert.deepEqual([out!.evidenceType, err!.evidenceType].sort(), ['stderr', 'stdout']);
  for (const cmd of [['bash', '-c', 'echo pwned'], ['sh', '-c', 'id'], ['/bin/ls'], ['./node']]) {
    const d = await exec('shell.exec', { command: cmd });
    assert.equal(d.status, 'denied', cmd.join(' '));
    assert.equal(d.error?.code, 'permission_denied');
    assert.equal(d.evidenceRefs.length, 0);
  }
  const slow = await exec('shell.exec', { command: ['node', '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 });
  assert.equal(slow.status, 'timeout');
  // a permit constraint narrows the allowlist further
  const constrained = new BuiltinPolicyEngine(
    [...DEFAULT_POLICY_RULES, { id: 'only-node', description: 'only node', match: { tools: ['shell.exec'] }, decision: 'allow', constraints: { allowedCommands: ['node'] } }],
    'rev-c',
    { clock: env.deps.clock, capabilitySecret: SECRET },
  );
  const rt2 = runtimeFor(env, whiteboxTools(options), { policy: constrained });
  const ls = await rt2.execute(request('shell.exec', { command: ['ls'] }, wt));
  assert.equal(ls.status, 'denied');
  assert.match(ls.error!.message, /allowedCommands/);
  assert.equal((await rt2.execute(request('shell.exec', { command: ['node', '-e', '0'] }, wt))).status, 'success');
});

test('test.run: structured results + test-result evidence linked to test artifacts; coverage evidence; zero tests is not a pass', async () => {
  const r = ok(await exec('test.run', { framework: 'auto', coverage: true, testArtifactIds: ['ta_1', 'ta_2'] }));
  const s = r.structured as { framework: string; passed: boolean; totals: { passed: number; total: number }; evidence: { testResult: string[]; coverage: string[] } };
  assert.equal(s.framework, 'node_test');
  assert.equal(s.passed, true);
  assert.deepEqual(s.totals, { passed: 2, failed: 0, skipped: 0, xfail: 0, xpass: 0, error: 0, total: 2 });
  assert.equal(s.evidence.testResult.length, 2, 'one test-result record per linked test artifact');
  const recs = await env.evidence.getMany(s.evidence.testResult);
  assert.deepEqual(recs.map((e) => (e.structured as { testArtifactId: string }).testArtifactId).sort(), ['ta_1', 'ta_2']);
  for (const e of recs) {
    assert.equal(e.evidenceType, 'test-result');
    assert.equal((e.structured as { passed: boolean }).passed, true);
    assert.ok((e.structured as { rawReport: { uri: string } }).rawReport.uri.startsWith('cas://sha256/') || (e.structured as { rawReport: { uri: string } }).rawReport.uri.length > 0);
    assert.ok(e.parentEvidenceIds.length >= 1, 'linked to stdout evidence');
  }
  const cov = (await env.evidence.getMany(s.evidence.coverage))[0]!;
  assert.equal(cov.evidenceType, 'coverage');
  assert.ok(((cov.structured as { totals: { lines: { total: number } } }).totals.lines.total) > 0);
  assert.equal(r.artifactRefs.length, 1, 'raw junit report stored as an artifact');

  await writeFile(join(wt.root, 'test/calc.test.mjs'), GOOD_TEST.replace('isAdult(17), false', 'isAdult(17), true'));
  const red = ok(await exec('test.run', { selector: 'test/calc.test.mjs' }));
  assert.equal((red.structured as { passed: boolean }).passed, false, 'failing tests are a successful call with passed=false');
  assert.match(red.modelText, /NOT PASSED[\s\S]*FAILED test\/calc\.test\.mjs::adult boundary/);
  await writeFile(join(wt.root, 'test/calc.test.mjs'), "import 'node:test';\n");
  const empty = ok(await exec('test.run', {}));
  assert.equal((empty.structured as { passed: boolean }).passed, false);
  assert.match(empty.modelText, /NO TESTS RAN/);
  await writeFile(join(wt.root, 'test/calc.test.mjs'), GOOD_TEST);
  const denied = await exec('test.run', { framework: 'command', command: ['bash', '-c', 'true'] });
  assert.equal(denied.status, 'denied');
  const cmd = ok(await exec('test.run', { framework: 'command', command: ['node', '-e', '0'] }));
  assert.equal((cmd.structured as { passed: boolean }).passed, false, 'an exit code alone never proves tests passed');
  assert.equal((await exec('test.run', { selector: '-rf' })).error?.code, 'schema_violation');
});

test('coverage.collect: parses a report in the workspace into coverage evidence', async () => {
  await writeFile(join(wt.root, 'lcov.info'), `SF:${wt.root}/src/calc.mjs\nDA:1,1\nDA:2,1\nDA:5,0\nDA:6,0\nLF:4\nLH:2\nend_of_record\n`);
  const r = ok(await exec('coverage.collect', { path: 'lcov.info' }));
  assert.deepEqual((r.structured as { totals: unknown }).totals, { lines: { covered: 2, total: 4 }, branches: 'unknown' });
  const ev = (await env.evidence.get(r.evidenceRefs[0]!))!;
  assert.equal(ev.evidenceType, 'coverage');
  assert.deepEqual((ev.structured as { files: Array<{ path: string }> }).files.map((f) => f.path), ['src/calc.mjs']);
  assert.match(r.modelText, /branches unknown \(not measured\)/);
  assert.equal((await exec('coverage.collect', { path: 'README.md' })).error?.code, 'invalid_argument');
  execFileSync('rm', [join(wt.root, 'lcov.info')]);
});

test('mutation.run: sensitivity evidence (mutation-result) without touching the workspace', async () => {
  const r = ok(await exec('mutation.run', { file: 'src/calc.mjs', testSelector: 'test/calc.test.mjs', maxMutants: 20, testArtifactId: 'ta_1' }));
  const s = r.structured as { killed: number; survived: number; score: number; total: number; testArtifactId: string };
  assert.ok(s.killed >= 3, JSON.stringify(s));
  assert.equal(s.testArtifactId, 'ta_1');
  const ev = (await env.evidence.get(r.evidenceRefs[0]!))!;
  assert.equal(ev.evidenceType, 'mutation-result');
  assert.equal((ev.structured as { score: number }).score, s.score);
  assert.equal(await readFile(join(wt.root, 'src/calc.mjs'), 'utf8'), CALC);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt.root, encoding: 'utf8' }), '');
});

test('code.symbols / code.references: built-in scan and the retrieval port', async () => {
  const sym = ok(await exec('code.symbols', { query: 'adult' }));
  assert.deepEqual((sym.structured as { symbols: unknown[] }).symbols, [{ name: 'isAdult', kind: 'function', path: 'src/calc.mjs', line: 1 }]);
  const refs = ok(await exec('code.references', { symbol: 'isAdult' }));
  assert.deepEqual((refs.structured as { references: Array<{ path: string; line: number; isDefinition: boolean }> }).references.map((x) => [x.path, x.line, x.isDefinition]), [['src/calc.mjs', 1, true], ['test/calc.test.mjs', 3, false], ['test/calc.test.mjs', 4, false]]);
  const queries: unknown[] = [];
  const withRetrieval = runtimeFor(env, whiteboxTools({ ...options, retrieval: { search: async (q) => { queries.push(q); return [{ path: 'src/calc.mjs', line: 1, snippet: 'export function isAdult', score: 0.9 }]; } } }));
  const viaPort = await withRetrieval.execute(request('code.symbols', { query: 'isAdult', limit: 5 }, wt));
  assert.equal((viaPort.structured as { engine: string }).engine, 'retrieval');
  assert.deepEqual(queries, [{ text: 'isAdult', symbol: 'isAdult', root: wt.root, limit: 5 }]);
});

// ----------------------------------------------------------------------------- review regressions

test('git metadata is never read or written through fs.* (a rewritten .git pointer would redirect commits)', async () => {
  const pointer = await readFile(join(wt.root, '.git'), 'utf8');
  for (const path of ['.git', '.GIT', 'sub/.git/config', './.git']) {
    const w = await exec('fs.write', { path, content: `gitdir: ${join(repo.path, '.git')}\n` });
    assert.equal(w.status, 'failed', path);
    assert.equal(w.error?.code, 'permission_denied', path);
  }
  assert.equal(await readFile(join(wt.root, '.git'), 'utf8'), pointer, 'the worktree pointer is untouched');
  assert.equal(existsSync(join(wt.root, 'sub')), false);
  const read = await exec('fs.read', { path: '.git' });
  assert.equal(read.error?.code, 'permission_denied');
  for (const [tool, input] of [['fs.search', { pattern: 'url', path: '.git' }], ['fs.list', { path: '.git', includeHidden: true }], ['coverage.collect', { path: '.git', format: 'coverage.py' }]] as const) {
    const r = await exec(tool, input, shared);
    assert.equal(r.error?.code, 'permission_denied', tool);
  }
  const hook = await exec('fs.apply_patch', { patch: 'diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/post-checkout\n@@ -0,0 +1 @@\n+evil\n' });
  assert.equal(hook.error?.code, 'permission_denied');
});

test('git.commit commits only onto the workspace work branch, never where HEAD was moved to', async () => {
  const mainHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' }).trim();
  const pointer = await readFile(join(wt.root, '.git'), 'utf8');
  await writeFile(join(wt.root, 'README.md'), '# redirected\n');
  try {
    // out-of-band tampering (e.g. a sandboxed process): the pointer now names the main repository
    await writeFile(join(wt.root, '.git'), `gitdir: ${join(repo.path, '.git')}\n`);
    const r = await exec('git.commit', { message: 'lands on main?' });
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'permission_denied');
    assert.match(r.error!.message, /HEAD is refs\/heads\/main, not the work branch refs\/heads\/ht\/run_tools\/wi_1/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' }).trim(), mainHead, 'nothing was committed to main');
  } finally {
    await writeFile(join(wt.root, '.git'), pointer);
    execFileSync('git', ['reset', '-q'], { cwd: repo.path });
  }
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: wt.root });
  const detached = await exec('git.commit', { message: 'detached' });
  assert.equal(detached.error?.code, 'permission_denied');
  execFileSync('git', ['checkout', '-q', `ht/${RUN}/${WORK}`], { cwd: wt.root });
  execFileSync('git', ['checkout', '-q', '--', 'README.md'], { cwd: wt.root });
});

test('git.commit with paths commits exactly those paths (other staged changes stay uncommitted)', async () => {
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt.root, encoding: 'utf8' }).trim();
  await writeFile(join(wt.root, 'README.md'), '# only this\n');
  await writeFile(join(wt.root, 'src/calc.mjs'), CALC + '// staged elsewhere\n');
  execFileSync('git', ['add', 'src/calc.mjs'], { cwd: wt.root });
  const r = ok(await exec('git.commit', { message: 'readme only', paths: ['README.md'] }));
  assert.deepEqual((r.structured as { files: string[] }).files, ['README.md']);
  assert.equal(execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: wt.root, encoding: 'utf8' }).trim(), 'README.md');
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: wt.root, encoding: 'utf8' }).trim(), 'src/calc.mjs', 'the unrelated staged change is still only staged');
  execFileSync('git', ['reset', '-q', '--hard', base], { cwd: wt.root });
});

test('test.run: the agent cannot turn an exit code into a pass (no allowNoCases input)', async () => {
  const r = await exec('test.run', { framework: 'command', command: ['node', '-e', '0'], allowNoCases: true });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'schema_violation');
  const plain = ok(await exec('test.run', { framework: 'command', command: ['node', '-e', '0'] }));
  assert.equal((plain.structured as { passed: boolean }).passed, false);
});

test('fs.apply_patch: a no-prefix git patch is applied at -p0 (never re-rooted onto another path)', async () => {
  const ws = await env.workspaces.scratch({ runId: RUN, workItemId: 'wi_noprefix' });
  await mkdir(join(ws.root, 'tests/src'), { recursive: true });
  await mkdir(join(ws.root, 'src'), { recursive: true });
  await writeFile(join(ws.root, 'tests/src/main.js'), 'safe\n');
  await writeFile(join(ws.root, 'src/main.js'), 'product\n');
  // the declared (authorized) resource is tests/src/main.js; with -p1 git would patch src/main.js instead
  const patch = 'diff --git tests/src/main.js tests/src/main.js\n--- tests/src/main.js\n+++ tests/src/main.js\n@@ -1 +1 @@\n-product\n+pwned\n';
  assert.deepEqual(patchPaths(patch), { paths: ['tests/src/main.js'], strip: 0 });
  const scoped = capability({ profile: { ...ALL_EFFECTS_PROFILE, resourceScopes: [`${ws.resourcePrefix}/tests/**`] } });
  const r = await rt.execute(request('fs.apply_patch', { patch }, ws, { capability: scoped }));
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'precondition_failed', r.modelText);
  assert.equal(await readFile(join(ws.root, 'src/main.js'), 'utf8'), 'product\n', 'the out-of-scope file is untouched');
  const good = ok(await rt.execute(request('fs.apply_patch', { patch: patch.replace('-product', '-safe') }, ws, { capability: scoped })));
  assert.deepEqual((good.structured as { files: string[] }).files, ['tests/src/main.js']);
  assert.equal(await readFile(join(ws.root, 'tests/src/main.js'), 'utf8'), 'pwned\n');
  assert.equal(await readFile(join(ws.root, 'src/main.js'), 'utf8'), 'product\n');
});

test('patchPaths: hunk bodies never count as headers; renames are unstripped; numstat parsing', () => {
  // a removed line "-- sql comment" appears as "--- sql comment" inside the hunk
  const sql = 'diff --git a/db/q.sql b/db/q.sql\n--- a/db/q.sql\n+++ b/db/q.sql\n@@ -1,2 +1,1 @@\n--- sql comment\n select 1;\n';
  assert.deepEqual(patchPaths(sql), { paths: ['db/q.sql'], strip: 1 });
  const rename = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n';
  assert.deepEqual(patchPaths(rename), { paths: ['new.txt', 'old.txt'], strip: 1 });
  assert.deepEqual(patchPaths('--- /dev/null\n+++ src/new.txt\n@@ -0,0 +1 @@\n+x\n'), { paths: ['src/new.txt'], strip: 0 });
  assert.deepEqual(parseNumstatPaths('1\t1\tsrc/a.txt\0-\t-\tbin.dat\x000\t0\t\0old name.txt\0new name.txt\0'), ['bin.dat', 'new name.txt', 'old name.txt', 'src/a.txt']);
});

test('security-H1a: shell.exec / test.run command arguments cannot read or write outside the workspace (the PoC), ordinary commands still run', async () => {
  // PoC 1: cat <absolute path outside the root> returned the file
  const cat = await exec('shell.exec', { command: ['cat', join(outside.path, 'secret.txt')] });
  assert.equal(cat.status, 'denied');
  assert.equal(cat.error?.code, 'permission_denied');
  assert.match(cat.error!.message, /outside the workspace/);
  assert.doesNotMatch(cat.modelText, /outside secret/);
  assert.equal(cat.evidenceRefs.length, 0, 'nothing ran');
  // PoC 2: sed writing into a sibling directory through ..
  const rel = join('..'.repeat(1), '..', '..', '..', '..', '..', '..', '..', '..', outside.path, 'pwned.txt');
  for (const script of [`w ${join(outside.path, 'pwned.txt')}`, `w ${rel}`]) {
    const sed = await exec('shell.exec', { command: ['sed', '-n', script, 'README.md'] });
    assert.equal(sed.status, 'denied', script);
    assert.equal(existsSync(join(outside.path, 'pwned.txt')), false);
  }
  // interpreters with a literal path, cwd-relative escapes and test.run's command framework are confined the same way
  for (const command of [['node', '-e', `console.log(require('fs').readFileSync(${JSON.stringify(join(outside.path, 'secret.txt'))}, 'utf8'))`], ['ls', '..'], ['git', '-C', outside.path, 'status']]) {
    const d = await exec('shell.exec', { command });
    assert.equal(d.status, 'denied', command.join(' '));
    assert.doesNotMatch(d.modelText, /outside secret/);
  }
  const viaTest = await exec('test.run', { framework: 'command', command: ['cat', join(outside.path, 'secret.txt')] });
  assert.equal(viaTest.status, 'denied');
  assert.doesNotMatch(viaTest.modelText, /outside secret/);
  // ordinary commands are unaffected
  ok(await exec('shell.exec', { command: ['sed', '-n', '/hello/p', 'README.md'] }));
  ok(await exec('shell.exec', { command: ['grep', '-rn', 'hello', '.'] }));
  const inside = ok(await exec('shell.exec', { command: ['cat', join(wt.root, 'README.md')] }));
  assert.match(inside.modelText, /hello world/);
  // the marker is visible to the program
  const marker = ok(await exec('shell.exec', { command: ['node', '-e', 'process.stdout.write(String(process.env.HYPERTEST_SANDBOX))'] }));
  assert.match(marker.modelText, /--- stdout ---\nlocal\n/);
});

test('conformance-2: test.run records what was tested relative to the base commit (tool-derived digests); an unregistered new test cannot count for the gate', async () => {
  const dwt = await env.workspaces.isolatedWorktree({ runId: RUN, workItemId: 'wi_delta', repoPath: repo.path });
  const run = (input: Record<string, unknown>) => rt.execute(request('test.run', { framework: 'node_test', ...input }, dwt, { workItemId: 'wi_delta', capability: capability({ workItemId: 'wi_delta' }) }));
  // unchanged tree: nothing to prove
  const clean = ok(await run({}));
  const cleanDelta = (clean.structured as { workspaceDelta: Record<string, unknown> }).workspaceDelta;
  assert.deepEqual({ ...cleanDelta, treeDigest: 'x' }, { status: 'computed', readOnly: false, treeDigest: 'x', changedFiles: 0, testFiles: [], baseCommit: repo.commits[0] });
  // a generated trivial test, never registered, run without any testArtifactId
  const GEN = "import { test } from 'node:test';\ntest('cart > total', () => {});\n";
  await writeFile(join(dwt.root, 'test', 'new_generated.test.mjs'), GEN);
  await writeFile(join(dwt.root, 'src', 'calc.mjs'), CALC + '// product change (not a test file)\n');
  const r = ok(await run({}));
  const delta = (r.structured as { workspaceDelta: { status: string; baseCommit: string; treeDigest: string; changedFiles: number; testFiles: unknown[] } }).workspaceDelta;
  assert.equal(delta.status, 'computed');
  assert.equal(delta.baseCommit, repo.commits[0]);
  assert.match(delta.treeDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(delta.treeDigest, (cleanDelta as { treeDigest: string }).treeDigest);
  assert.equal(delta.changedFiles, 2);
  assert.deepEqual(delta.testFiles, [{ path: 'test/new_generated.test.mjs', change: 'added', sha256: sha256Hex(GEN) }], 'product files are not test files');
  assert.match(r.modelText, /1 test file\(s\) differ from the base commit \(added test\/new_generated\.test\.mjs\).*registered and validated as a TestArtifact/);
  // the evidence itself carries the delta (never a caller claim) …
  const records = await env.evidence.getMany(r.evidenceRefs);
  const testResult = records.find((e) => e?.evidenceType === 'test-result') as EvidenceRecord;
  assert.deepEqual((testResult.structured as { workspaceDelta: unknown }).workspaceDelta, delta);
  // … so the gate refuses it without a validated artifact of exactly that content, and accepts it with one
  const gateInput = (testArtifacts: TestArtifact[]) => ({
    run: { runId: RUN, goal: 'g', target: {}, status: 'gating', budget: {}, runtimeManifestId: 'm', policyRevision: 'p', currentPlanRevision: 1, oracleRevisions: {}, experimentIds: [], labels: {}, createdAt: '', updatedAt: '' } as never,
    // no oracle here: this test is about artifact eligibility, so the gate waives C0 explicitly (conformance-1)
    gate: { ...DEFAULT_GATE_SPEC, requireIndependentReview: false, requireOracle: false }, objectives: [], oracles: [], experiments: [], findings: [], risks: [], reviews: [], coverageGaps: [], testArtifacts,
    evidence: [testResult], evidenceRoot: { rootHash: 'r', count: 1 }, workItems: [], claims: [], exceptions: [], runtimeManifestId: 'm', policyRevision: 'p', decisionId: 'd', now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(new QualityGate().evaluate(gateInput([])).verdict, 'inconclusive');
  const validated: TestArtifact = {
    artifactId: 'ta_gen', runId: RUN, revision: 1, path: 'test/new_generated.test.mjs', artifactDigest: sha256Hex(GEN), sourceType: 'generated', oracleRefs: [],
    runner: { framework: 'node_test', selector: 'test/new_generated.test.mjs' }, validations: { knownBad: { status: 'passed', evidenceRefs: ['ev_x'] } }, approvalState: 'validated', createdAt: '',
  };
  assert.equal(new QualityGate().evaluate(gateInput([validated])).verdict, 'pass');
  // modifying an existing test is a change too; a selector naming a non-pattern file includes it
  await writeFile(join(dwt.root, 'test', 'calc.test.mjs'), GOOD_TEST + '// weakened\n');
  await writeFile(join(dwt.root, 'checks.mjs'), GEN);
  const m = ok(await run({ selector: 'checks.mjs' }));
  const files = (m.structured as { workspaceDelta: { testFiles: Array<{ path: string; change: string }> } }).workspaceDelta.testFiles.map((f) => `${f.change} ${f.path}`);
  assert.deepEqual(files, ['added checks.mjs', 'modified test/calc.test.mjs', 'added test/new_generated.test.mjs']);
  // a scratch workspace has no base: everything in it was created in the run
  const scratch = await env.workspaces.scratch({ runId: RUN, workItemId: 'wi_delta_scratch' });
  await mkdir(join(scratch.root, 'test'), { recursive: true });
  await writeFile(join(scratch.root, 'test', 'a.test.mjs'), GEN);
  await writeFile(join(scratch.root, 'package.json'), '{"type":"module"}\n');
  const sr = ok(await rt.execute(request('test.run', { framework: 'node_test' }, scratch, { workItemId: 'wi_delta_scratch', capability: capability({ workItemId: 'wi_delta_scratch' }) })));
  assert.deepEqual((sr.structured as { workspaceDelta: { testFiles: unknown } }).workspaceDelta.testFiles, [{ path: 'test/a.test.mjs', change: 'added', sha256: sha256Hex(GEN) }]);
  await env.workspaces.dispose(dwt.workspaceId);
});

test('shell.exec: the capability must cover the whole workspace, not only the cwd', async () => {
  await mkdir(join(wt.root, 'sub'), { recursive: true });
  const scoped = capability({ profile: { ...ALL_EFFECTS_PROFILE, resourceScopes: [`${wt.resourcePrefix}/sub/**`] } });
  const r = await rt.execute(request('shell.exec', { command: ['node', '-e', "require('fs').writeFileSync('../escaped.txt', 'x')"], cwd: 'sub' }, wt, { capability: scoped }));
  assert.equal(r.status, 'denied');
  assert.match(r.error!.message, new RegExp(`resource_out_of_scope: ${wt.resourcePrefix}$`));
  assert.equal(existsSync(join(wt.root, 'escaped.txt')), false);
  execFileSync('rm', ['-r', join(wt.root, 'sub')]);
});

test('a scratch workspace nested inside a repository never sees that repository through git', async () => {
  const nested = createWorkspaceManager({ ...testDeps(), baseDir: join(repo.path, '.hypertest', 'workspaces'), defaultSandbox: SANDBOX });
  const ws = await nested.scratch({ runId: RUN, workItemId: 'wi_nested' });
  const nestedRt = runtimeFor(env, whiteboxTools({ sandbox: env.sandbox, workspaces: nested }));
  const log = await nestedRt.execute(request('git.log', {}, ws));
  assert.equal(log.status, 'failed');
  assert.match(log.modelText, /not a git repository/);
  assert.doesNotMatch(log.modelText, /initial/);
  const show = await nestedRt.execute(request('git.show', { rev: 'HEAD', path: 'x' }, ws));
  assert.equal(show.status, 'failed');
  // git apply works as a plain patch tool, rooted at the scratch directory
  ok(await nestedRt.execute(request('fs.apply_patch', { patch: '--- /dev/null\n+++ b/made.txt\n@@ -0,0 +1 @@\n+here\n' }, ws)));
  assert.equal(await readFile(join(ws.root, 'made.txt'), 'utf8'), 'here\n');
  execFileSync('rm', ['-rf', join(repo.path, '.hypertest')]);
});
