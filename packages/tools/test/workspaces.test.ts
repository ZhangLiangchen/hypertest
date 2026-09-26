import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import { createGitRepo, testDeps } from '@hypertest/testkit';
import { createWorkspaceManager, workspaceIdFor, type WorkspaceManager } from '../src/index.ts';
import { SANDBOX, tempDir } from './helpers.ts';

let repo: Awaited<ReturnType<typeof createGitRepo>>;
let base: Awaited<ReturnType<typeof tempDir>>;
let outside: Awaited<ReturnType<typeof tempDir>>;
let wm: WorkspaceManager;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(async () => {
  repo = await createGitRepo({ 'src/a.txt': 'v1\n', 'README.md': '# r\n' }, [{ message: 'second', files: { 'src/a.txt': 'v2\n' } }]);
  base = await tempDir('ht-ws-base-');
  outside = await tempDir('ht-ws-outside-');
  await writeFile(join(outside.path, 'secret.txt'), 'top secret');
  wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX });
});
after(async () => {
  await repo.cleanup();
  await base.cleanup();
  await outside.cleanup();
});

test('resolvePath rejects absolute paths and .. escapes; accepts inner paths', async () => {
  const ws = await wm.scratch({ runId: 'run_p', workItemId: 'wi_p' });
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', '..', '~/x', 'a\0b']) {
    await assert.rejects(wm.resolvePath(ws, bad), (e) => isHypertestError(e, 'permission_denied'), bad);
  }
  assert.equal(await wm.resolvePath(ws, 'a/../b.txt'), join(ws.root, 'b.txt'));
  assert.equal(await wm.resolvePath(ws, '.'), ws.root);
  assert.equal(await wm.resolvePath(ws, 'new/dir/file.txt'), join(ws.root, 'new/dir/file.txt'));
});

test('resolvePath rejects symlinks resolving outside the root (existing target and via a symlinked parent)', async () => {
  const ws = await wm.scratch({ runId: 'run_p', workItemId: 'wi_link' });
  await symlink(outside.path, join(ws.root, 'escape'));
  await symlink(join(outside.path, 'secret.txt'), join(ws.root, 'secret-link'));
  await mkdir(join(ws.root, 'inner'));
  await writeFile(join(ws.root, 'inner', 'ok.txt'), 'ok');
  await symlink(join(ws.root, 'inner'), join(ws.root, 'inner-link'));
  await assert.rejects(wm.resolvePath(ws, 'escape/secret.txt'), (e) => isHypertestError(e, 'permission_denied'));
  await assert.rejects(wm.resolvePath(ws, 'escape/new-file.txt'), (e) => isHypertestError(e, 'permission_denied'), 'non-existing target under an escaping symlink');
  await assert.rejects(wm.resolvePath(ws, 'secret-link'), (e) => isHypertestError(e, 'permission_denied'));
  assert.equal(await wm.resolvePath(ws, 'inner-link/ok.txt'), join(ws.root, 'inner-link/ok.txt'), 'symlinks inside the root are fine');
});

test('isolated worktree: writes do not touch the repository; branch ht/<run>/<wi>; deterministic id', async () => {
  const ws = await wm.isolatedWorktree({ runId: 'run_w', workItemId: 'wi_1', repoPath: repo.path });
  assert.equal(ws.kind, 'isolated_worktree');
  assert.equal(ws.readOnly, false);
  assert.equal(ws.branch, 'ht/run_w/wi_1');
  assert.equal(ws.baseCommit, repo.commits[1]);
  assert.equal(ws.root, await realpath(join(base.path, 'run_w', 'wt', 'wi_1')));
  assert.equal(ws.workspaceId, workspaceIdFor(join(base.path, 'run_w', 'wt', 'wi_1')));
  assert.match(ws.workspaceId, /^ws_[0-9a-f]{16}$/);
  assert.equal(ws.resourcePrefix, `workspace/${ws.workspaceId}`);
  assert.ok(ws.tempDir && !ws.tempDir.startsWith(ws.root + '/'), 'tempDir is outside the root');
  await writeFile(join(ws.root, 'src/a.txt'), 'changed in worktree\n');
  assert.equal(await readFile(join(repo.path, 'src/a.txt'), 'utf8'), 'v2\n');
  assert.equal(git(repo.path, 'status', '--porcelain'), '', 'repository working tree untouched');
  assert.equal(git(ws.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ht/run_w/wi_1');
  assert.deepEqual(wm.get(ws.workspaceId), ws);
});

test('isolated worktree: idempotent reattach (same and fresh manager) keeps work; conflicting base is refused', async () => {
  const first = await wm.isolatedWorktree({ runId: 'run_r', workItemId: 'wi_1', repoPath: repo.path, baseCommit: repo.commits[0]! });
  await writeFile(join(first.root, 'work.txt'), 'in progress\n');
  git(first.root, 'add', 'work.txt');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'agent work'], { cwd: first.root });
  const again = await wm.isolatedWorktree({ runId: 'run_r', workItemId: 'wi_1', repoPath: repo.path });
  assert.deepEqual(again, first);
  const restarted = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX });
  assert.equal(restarted.get(first.workspaceId), undefined, 'get() only knows re-attached workspaces');
  const reattached = await restarted.isolatedWorktree({ runId: 'run_r', workItemId: 'wi_1', repoPath: repo.path });
  assert.equal(reattached.workspaceId, first.workspaceId);
  assert.equal(reattached.baseCommit, repo.commits[0], 'the base survives the restart (not the moving HEAD)');
  assert.equal(await readFile(join(reattached.root, 'work.txt'), 'utf8'), 'in progress\n');
  assert.equal(git(reattached.root, 'log', '-1', '--format=%s'), 'agent work', 'reattach never resets the branch');
  assert.equal(restarted.get(first.workspaceId)?.root, first.root);
  await assert.rejects(restarted.isolatedWorktree({ runId: 'run_r', workItemId: 'wi_1', repoPath: repo.path, baseCommit: repo.commits[1]! }), (e) => isHypertestError(e, 'conflict'));
  await assert.rejects(wm.isolatedWorktree({ runId: '../evil', workItemId: 'wi', repoPath: repo.path }), (e) => isHypertestError(e, 'invalid_argument'));
});

test('diff includes modified, deleted and untracked files against the base commit', async () => {
  const ws = await wm.isolatedWorktree({ runId: 'run_d', workItemId: 'wi_1', repoPath: repo.path });
  await writeFile(join(ws.root, 'src/a.txt'), 'v3\n');
  await writeFile(join(ws.root, 'new-file.txt'), 'brand new\n');
  execFileSync('rm', [join(ws.root, 'README.md')]);
  const diff = await wm.diff(ws);
  assert.match(diff, /diff --git a\/src\/a\.txt b\/src\/a\.txt[\s\S]*-v2\n\+v3/);
  assert.match(diff, /diff --git a\/README\.md b\/README\.md\ndeleted file mode/);
  assert.match(diff, /diff --git a\/new-file\.txt b\/new-file\.txt\nnew file mode 100644[\s\S]*\+brand new/);
  assert.equal(git(ws.root, 'status', '--porcelain', '--', 'new-file.txt'), '?? new-file.txt', 'diff did not stage anything');
  const scratch = await wm.scratch({ runId: 'run_d', workItemId: 'wi_s' });
  await assert.rejects(wm.diff(scratch), (e) => isHypertestError(e, 'precondition_failed'));
});

test('shared snapshot: commit ⇒ read-only detached worktree at that commit; no commit ⇒ the repo itself', async () => {
  const old = await wm.sharedSnapshot({ runId: 'run_s', repoPath: repo.path, commit: repo.commits[0]! });
  assert.equal(old.kind, 'shared_readonly');
  assert.equal(old.readOnly, true);
  assert.equal(old.baseCommit, repo.commits[0]);
  assert.equal(await readFile(join(old.root, 'src/a.txt'), 'utf8'), 'v1\n');
  const again = await wm.sharedSnapshot({ runId: 'run_s', repoPath: repo.path, commit: repo.commits[0]! });
  assert.equal(again.workspaceId, old.workspaceId);
  const head = await wm.sharedSnapshot({ runId: 'run_s', repoPath: repo.path });
  assert.equal(head.root, await realpath(repo.path));
  assert.equal(head.baseCommit, repo.commits[1]);
  assert.equal(head.readOnly, true);
  assert.notEqual(head.workspaceId, old.workspaceId);
  const plain = await tempDir('ht-ws-plain-');
  try {
    const p = await wm.sharedSnapshot({ runId: 'run_s', repoPath: plain.path });
    assert.equal(p.baseCommit, undefined);
    assert.equal(p.readOnly, true);
    await assert.rejects(wm.sharedSnapshot({ runId: 'run_s', repoPath: plain.path, commit: 'HEAD' }), (e) => isHypertestError(e, 'precondition_failed'));
    await assert.rejects(wm.isolatedWorktree({ runId: 'run_s', workItemId: 'wi', repoPath: plain.path }), (e) => isHypertestError(e, 'precondition_failed'));
  } finally {
    await plain.cleanup();
  }
  await assert.rejects(wm.sharedSnapshot({ runId: 'run_s', repoPath: repo.path, commit: 'no-such-rev' }), (e) => isHypertestError(e, 'precondition_failed'));
});

test('dispose removes the worktree (and its registration) but never the repository; scratch dirs are deleted', async () => {
  const ws = await wm.isolatedWorktree({ runId: 'run_x', workItemId: 'wi_1', repoPath: repo.path });
  const shared = await wm.sharedSnapshot({ runId: 'run_x', repoPath: repo.path });
  const scratch = await wm.scratch({ runId: 'run_x', workItemId: 'wi_2' });
  await wm.dispose(ws.workspaceId);
  await wm.dispose(shared.workspaceId);
  await wm.dispose(scratch.workspaceId);
  await wm.dispose('ws_unknown'); // idempotent
  assert.equal(existsSync(ws.root), false);
  assert.equal(existsSync(scratch.root), false);
  assert.equal(existsSync(join(repo.path, 'src/a.txt')), true, 'the repository is never deleted');
  assert.equal(git(repo.path, 'worktree', 'list').includes(ws.root), false);
  assert.equal(wm.get(ws.workspaceId), undefined);
  assert.match(git(repo.path, 'branch', '--list', 'ht/run_x/wi_1'), /ht\/run_x\/wi_1/, 'the work branch is kept for audit');
});

test('concurrent creators for the same worktree serialize: one worktree, identical handles', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => wm.isolatedWorktree({ runId: 'run_c', workItemId: 'wi_1', repoPath: repo.path })));
  for (const r of results) assert.deepEqual(r, results[0]);
  const listed = git(repo.path, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l === `worktree ${results[0]!.root}`);
  assert.equal(listed.length, 1);
});

test('parallel work items on ONE repository: every worktree is created (git worktree administration is serialized per repository)', async () => {
  // Parallel agents (two test designers, three analysts, a fixer beside a test designer…) each get their own worktree of
  // the same repository at the same moment. `git worktree prune` of one creator used to delete the half-created
  // administrative directory of another (`fatal: could not open '.git/worktrees/<id>/gitdir' for writing`): that agent's
  // spawn was refused and its work item failed. Disposal (remove + prune) races the same way.
  for (let round = 0; round < 6; round++) {
    const runId = `run_par${round}`;
    const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => wm.isolatedWorktree({ runId, workItemId: `wi_${i}`, repoPath: repo.path })));
    const refused = settled.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason?.message ?? s));
    assert.deepEqual(refused, [], `round ${round}`);
    const handles = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<WorkspaceManager['isolatedWorktree']>>>).value);
    const listed = git(repo.path, 'worktree', 'list', '--porcelain');
    for (const h of handles) {
      assert.ok(listed.includes(`worktree ${h.root}`), `${h.root} is a registered worktree`);
      assert.equal(await readFile(join(h.root, 'src/a.txt'), 'utf8'), 'v2\n');
    }
    // half of them are disposed while the next ones are created
    const more = Promise.allSettled(Array.from({ length: 4 }, (_, i) => wm.isolatedWorktree({ runId, workItemId: `wi_more_${i}`, repoPath: repo.path })));
    await Promise.all(handles.slice(0, 4).map((h) => wm.dispose(h.workspaceId)));
    const late = await more;
    assert.deepEqual(late.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason?.message)), [], `round ${round} (with disposals)`);
    for (const h of handles.slice(4)) assert.ok(existsSync(join(h.root, 'src/a.txt')), 'a disposal never takes another worktree with it');
  }
});

// ----------------------------------------------------------------------------- review regressions

test('dispose then re-create re-attaches the kept work branch (the agent commits are never reset away)', async () => {
  const ws = await wm.isolatedWorktree({ runId: 'run_again', workItemId: 'wi_1', repoPath: repo.path, baseCommit: repo.commits[0]! });
  await writeFile(join(ws.root, 'fix.txt'), 'the fix\n');
  git(ws.root, 'add', 'fix.txt');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'agent fix'], { cwd: ws.root });
  const tip = git(repo.path, 'rev-parse', 'ht/run_again/wi_1');
  await wm.dispose(ws.workspaceId);
  assert.equal(existsSync(ws.root), false);
  for (const manager of [wm, createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX })]) {
    const again = await manager.isolatedWorktree({ runId: 'run_again', workItemId: 'wi_1', repoPath: repo.path });
    assert.equal(git(repo.path, 'rev-parse', 'ht/run_again/wi_1'), tip, 'the branch still points at the agent commit');
    assert.equal(again.baseCommit, repo.commits[0], 'the recorded base survives dispose');
    assert.equal(await readFile(join(again.root, 'fix.txt'), 'utf8'), 'the fix\n');
    await manager.dispose(again.workspaceId);
  }
});

test('trusted git (diff) never hands the parent secrets to repository filters', async () => {
  const r = await createGitRepo({ 'a.txt': 'one\n' });
  const dump = join(outside.path, 'filter-env');
  try {
    execFileSync('git', ['config', 'filter.probe.clean', `sh -c 'env > ${dump}; cat'`], { cwd: r.path });
    const ws = await wm.isolatedWorktree({ runId: 'run_env', workItemId: 'wi_1', repoPath: r.path });
    await writeFile(join(ws.root, '.gitattributes'), '*.txt filter=probe\n');
    await writeFile(join(ws.root, 'a.txt'), 'two\n');
    process.env['HT_WS_PARENT_SECRET'] = 'parent-secret-9431';
    const diff = await wm.diff(ws);
    assert.match(diff, /-one\n\+two/);
    // security-1: trusted diff compares raw bytes and renders them outside the repository — repository filters (which
    // an agent can configure, and which could rewrite or hide what it changed) never run at all, so they can never see
    // the parent's secrets either
    assert.equal(existsSync(dump), false, 'no repository filter ran on the host');
    if (existsSync(dump)) {
      const seen = await readFile(dump, 'utf8');
      assert.doesNotMatch(seen, /parent-secret-9431/);
      assert.doesNotMatch(seen, /HYPERTEST_TEST_PG_URL/);
    }
  } finally {
    delete process.env['HT_WS_PARENT_SECRET'];
    await r.cleanup();
  }
});

test('a rewritten .git pointer in the root cannot redirect trusted git to attacker config', async () => {
  const evil = await createGitRepo({ 'x.txt': 'x\n' });
  const marker = join(outside.path, 'evil-filter-ran');
  try {
    execFileSync('git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { cwd: evil.path });
    const ws = await wm.isolatedWorktree({ runId: 'run_ptr', workItemId: 'wi_1', repoPath: repo.path });
    await writeFile(join(ws.root, 'src/a.txt'), 'tampered view\n');
    await writeFile(join(ws.root, '.gitattributes'), '* filter=evil\n');
    // what a process in the (container) sandbox could do: the root is writable, the main repository is not
    await writeFile(join(ws.root, '.git'), `gitdir: ${join(evil.path, '.git')}\n`);
    const diff = await wm.diff(ws);
    assert.equal(existsSync(marker), false, 'the attacker filter never ran on the host');
    assert.match(diff, /diff --git a\/src\/a\.txt b\/src\/a\.txt[\s\S]*-v2\n\+tampered view/, 'the diff is still against the real repository');
    await assert.rejects(createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: SANDBOX }).diff(ws), (e) => isHypertestError(e, 'precondition_failed') && /not registered/.test(e.message));
  } finally {
    await evil.cleanup();
  }
});

test('dangling symlinks are refused (permission_denied), never followed to create files elsewhere', async () => {
  const ws = await wm.scratch({ runId: 'run_p', workItemId: 'wi_dangling' });
  await symlink(join(outside.path, 'created-through-link'), join(ws.root, 'dangling'));
  await symlink(join(ws.root, 'loop-b'), join(ws.root, 'loop-a'));
  await symlink(join(ws.root, 'loop-a'), join(ws.root, 'loop-b'));
  for (const p of ['dangling', 'dangling/child.txt', 'loop-a', 'loop-a/x']) {
    await assert.rejects(wm.resolvePath(ws, p), (e) => isHypertestError(e, 'permission_denied'), p);
  }
  assert.equal(existsSync(join(outside.path, 'created-through-link')), false);
});

test('security-1: index flags, replace refs, excludes and clean filters an agent\'s command sets never hide a change from diff() / changedFiles()', async () => {
  const r = await createGitRepo({ 'test/a.test.js': "test('adds', () => { assert.equal(1 + 1, 2); });\n", 'src/sum.js': 'module.exports = (a, b) => a + b;\n' });
  try {
    const weaken = (root: string) => writeFile(join(root, 'test/a.test.js'), "test('adds', () => { assert.ok(true); });\n");
    const expectWeakened = (diff: string, how: string) => {
      assert.match(diff, /diff --git a\/test\/a\.test\.js b\/test\/a\.test\.js[\s\S]*-test\('adds', \(\) => \{ assert\.equal\(1 \+ 1, 2\); \}\);\n\+test\('adds', \(\) => \{ assert\.ok\(true\); \}\);/, how);
    };
    const run = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

    // 1 skip-worktree (the audit PoC): `git diff` reports nothing, the file on disk is gutted
    const ws1 = await wm.isolatedWorktree({ runId: 'run_sec1', workItemId: 'wi_skip', repoPath: r.path });
    assert.equal(await wm.diff(ws1), '');
    run(ws1.root, 'update-index', '--skip-worktree', 'test/a.test.js');
    await weaken(ws1.root);
    assert.equal(run(ws1.root, 'diff', r.commits[0]!).toString(), '', 'plain git diff is blind to it');
    expectWeakened(await wm.diff(ws1), 'skip-worktree');
    assert.deepEqual((await wm.changedFiles!(ws1)).map((c) => `${c.change} ${c.path}`), ['modified test/a.test.js']);

    // 2 assume-unchanged + core.ignoreStat
    const ws2 = await wm.isolatedWorktree({ runId: 'run_sec1', workItemId: 'wi_assume', repoPath: r.path });
    run(ws2.root, 'update-index', '--assume-unchanged', 'test/a.test.js');
    run(ws2.root, 'config', 'core.ignoreStat', 'true');
    await weaken(ws2.root);
    expectWeakened(await wm.diff(ws2), 'assume-unchanged');
    run(ws2.root, 'config', '--unset', 'core.ignoreStat');

    // 3 commit, then `git replace <base> HEAD`: the base now resolves to the agent's commit
    const ws3 = await wm.isolatedWorktree({ runId: 'run_sec1', workItemId: 'wi_replace', repoPath: r.path });
    await weaken(ws3.root);
    run(ws3.root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qam', 'weaken');
    const head = run(ws3.root, 'rev-parse', 'HEAD').toString().trim();
    run(ws3.root, 'replace', r.commits[0]!, head);
    try {
      assert.equal(run(ws3.root, 'diff', r.commits[0]!).toString(), '', 'plain git diff is blind to it');
      expectWeakened(await wm.diff(ws3), 'git replace');
    } finally {
      run(ws3.root, 'replace', '-d', r.commits[0]!);
    }

    // 4 a clean filter that hands git the original text (attributes in the worktree, filter in the repo config)
    const ws4 = await wm.isolatedWorktree({ runId: 'run_sec1', workItemId: 'wi_filter', repoPath: r.path });
    const original = join(outside.path, 'original.js');
    await writeFile(original, "test('adds', () => { assert.equal(1 + 1, 2); });\n");
    run(r.path, 'config', 'filter.hide.clean', `cat ${original}`);
    try {
      await writeFile(join(ws4.root, '.gitattributes'), 'test/* filter=hide -diff\n');
      await weaken(ws4.root);
      const d4 = await wm.diff(ws4);
      expectWeakened(d4, 'clean filter / -diff');
      assert.match(d4, /diff --git a\/\.gitattributes b\/\.gitattributes\nnew file mode 100644/, 'the attributes file itself is a visible change');
    } finally {
      run(r.path, 'config', '--unset', 'filter.hide.clean');
    }

    // 5 a new test file hidden through .git/info/exclude is still listed (only the worktree's .gitignore files count)
    const ws5 = await wm.isolatedWorktree({ runId: 'run_sec1', workItemId: 'wi_exclude', repoPath: r.path });
    const commonDir = run(ws5.root, 'rev-parse', '--git-common-dir').toString().trim();
    const infoDir = commonDir.startsWith('/') ? join(commonDir, 'info') : join(ws5.root, commonDir, 'info');
    await mkdir(infoDir, { recursive: true });
    const excludeFile = join(infoDir, 'exclude');
    const before = existsSync(excludeFile) ? await readFile(excludeFile, 'utf8') : '';
    await writeFile(excludeFile, `${before}test/hidden.test.js\n`);
    try {
      await writeFile(join(ws5.root, 'test/hidden.test.js'), "test('always', () => {});\n");
      assert.match(await wm.diff(ws5), /diff --git a\/test\/hidden\.test\.js b\/test\/hidden\.test\.js\nnew file mode 100644/);
      assert.ok((await wm.changedFiles!(ws5)).some((c) => c.path === 'test/hidden.test.js' && c.change === 'added'));
    } finally {
      await writeFile(excludeFile, before);
    }
  } finally {
    await r.cleanup();
  }
});

test('security-1: a .gitignore the agent writes or edits (even one that ignores itself) never hides a file it added; the base commit\'s ignore rules still apply', async () => {
  const r = await createGitRepo({
    '.gitignore': 'node_modules/\n*.log\n!keep.log\n/build\n# comment\n',
    'pkg/.gitignore': 'dist/\n/local.txt\n**/gen/*.out\n',
    'tests/test_a.py': 'def test_a():\n    assert 1 + 1 == 2\n',
    'pkg/index.js': 'module.exports = 1;\n',
  });
  const placeholder = '# placeholder\n';
  const listed = async (ws: Parameters<WorkspaceManager['diff']>[0]) => (await wm.changedFiles!(ws)).map((c) => `${c.change} ${c.path}`).sort();
  // files the BASE rules ignore (must stay invisible) and files they do not (must be listed)
  const populate = async (root: string) => {
    for (const p of ['node_modules/dep/index.js', 'x.log', 'build/out.js', 'pkg/dist/a.js', 'pkg/local.txt', 'pkg/sub/gen/y.out']) {
      await mkdir(join(root, p, '..'), { recursive: true });
      await writeFile(join(root, p), placeholder);
    }
    for (const p of ['keep.log', 'pkg/sub/local.txt', 'sub/build/out.js', 'pkg/gen/y.txt']) {
      await mkdir(join(root, p, '..'), { recursive: true });
      await writeFile(join(root, p), placeholder);
    }
  };
  const visible = ['added keep.log', 'added pkg/gen/y.txt', 'added pkg/sub/local.txt', 'added sub/build/out.js'];
  try {
    // untainted: git's own per-directory rules (the reference for the base-rule translation below)
    const ws0 = await wm.isolatedWorktree({ runId: 'run_sec1i', workItemId: 'wi_ref', repoPath: r.path });
    await populate(ws0.root);
    assert.deepEqual(await listed(ws0), visible);

    // A: a new, self-ignoring tests/.gitignore hides a new tests/conftest.py from plain git
    const wsA = await wm.isolatedWorktree({ runId: 'run_sec1i', workItemId: 'wi_a', repoPath: r.path });
    const beforeA = await wm.diff(wsA);
    await writeFile(join(wsA.root, 'tests/.gitignore'), '*\n');
    await writeFile(join(wsA.root, 'tests/conftest.py'), placeholder);
    assert.equal(git(wsA.root, 'status', '--porcelain'), '', 'plain git sees nothing');
    assert.notEqual(await wm.diff(wsA), beforeA);
    assert.match(await wm.diff(wsA), /diff --git a\/tests\/conftest\.py b\/tests\/conftest\.py\nnew file mode 100644/);
    assert.deepEqual(await listed(wsA), ['added tests/.gitignore', 'added tests/conftest.py']);

    // B: a new root-level ignore file in a sub-tree the base does not ignore, ignoring itself and the new file
    const wsB = await wm.isolatedWorktree({ runId: 'run_sec1i', workItemId: 'wi_b', repoPath: r.path });
    await mkdir(join(wsB.root, 'extra'), { recursive: true });
    await writeFile(join(wsB.root, 'extra/.gitignore'), '.gitignore\nconftest.py\n');
    await writeFile(join(wsB.root, 'extra/conftest.py'), placeholder);
    assert.deepEqual(await listed(wsB), ['added extra/.gitignore', 'added extra/conftest.py']);

    // C: editing the tracked .gitignore to ignore a new file: both the edit and the file are changes
    const wsC = await wm.isolatedWorktree({ runId: 'run_sec1i', workItemId: 'wi_c', repoPath: r.path });
    await writeFile(join(wsC.root, '.gitignore'), 'node_modules/\n*.log\n!keep.log\n/build\nconftest.py\n');
    await writeFile(join(wsC.root, 'tests/conftest.py'), placeholder);
    assert.deepEqual(await listed(wsC), ['added tests/conftest.py', 'modified .gitignore']);

    // C': deleting the tracked .gitignore does not un-ignore what the base ignores (no flood of dependency files)
    const wsD = await wm.isolatedWorktree({ runId: 'run_sec1i', workItemId: 'wi_d', repoPath: r.path });
    await populate(wsD.root);
    await rm(join(wsD.root, 'pkg/.gitignore'));
    await writeFile(join(wsD.root, 'tests/.gitignore'), '*\n');
    assert.deepEqual(await listed(wsD), [...visible, 'added tests/.gitignore', 'deleted pkg/.gitignore'].sort(), 'tainted: the base rules, translated, ignore exactly what git ignores');
  } finally {
    await r.cleanup();
  }
});
