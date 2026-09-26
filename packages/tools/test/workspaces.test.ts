import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
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
    assert.equal(existsSync(dump), true, 'the (trusted, user-configured) filter did run');
    const seen = await readFile(dump, 'utf8');
    assert.doesNotMatch(seen, /parent-secret-9431/);
    assert.doesNotMatch(seen, /HYPERTEST_TEST_PG_URL/);
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
