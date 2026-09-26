import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { HypertestError, jsonClone, sha256Hex } from '@hypertest/core';
import type { WorkspaceChange, WorkspaceDeps, WorkspaceHandle, WorkspaceManager } from '../contracts.ts';
import { gitRun, isGitRepo, resolveCommit } from './git-exec.ts';
import { confineExisting } from './paths.ts';
import { baseTreeOf, renderWorktreeDiff, worktreeChanges, type BlobCache, type WorktreeChange } from './worktree-state.ts';

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function segment(value: string, what: string): string {
  if (typeof value !== 'string' || !SEGMENT_RE.test(value) || value.includes('..')) {
    throw new HypertestError('invalid_argument', `${what} ${JSON.stringify(value)} is not a safe path segment`);
  }
  return value;
}

/** Upper bound of files a scratch workspace listing walks (a runaway tree must not stall a test run). */
const MAX_SCRATCH_FILES = 20_000;

/** sha256 of a regular file's content (streamed); undefined for anything else (symlink, directory, missing). */
export async function fileSha256(abs: string): Promise<string | undefined> {
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rej);
    stream.on('end', () => res());
  });
  return hash.digest('hex');
}

/** Every file below `root` (no .git, no node_modules), workspace-relative POSIX paths, sorted; bounded. */
async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const abs = join(dir, name);
      const st = await lstat(abs).catch(() => undefined);
      if (!st) continue;
      if (st.isDirectory()) await walk(abs);
      else {
        out.push(relative(root, abs).split(sep).join('/'));
        if (out.length > MAX_SCRATCH_FILES) throw new HypertestError('precondition_failed', `scratch workspace has more than ${MAX_SCRATCH_FILES} files; changes cannot be listed`);
      }
    }
  };
  await walk(root);
  return out;
}

/** Deterministic workspace id from its slot: restarts that recompute the slot get the same id. */
export function workspaceIdFor(slotKey: string): string {
  return `ws_${sha256Hex(slotKey).slice(0, 16)}`;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

interface Entry {
  handle: WorkspaceHandle;
  slot: string;
  repoPath?: string;
  /** True when the slot is a git worktree we created (dispose removes it). */
  ownsWorktree: boolean;
  /**
   * Git dir + work tree pinned when the handle was created/re-attached, from the repository's OWN metadata:
   * trusted git (diff) never follows the `.git` pointer inside the (agent-writable) root.
   */
  git?: { gitDir: string; workTree: string };
  /** (security-1) Blob ids of on-disk files keyed by stat, and the (immutable) base tree: see worktree-state.ts. */
  blobs?: BlobCache;
  baseTree?: Map<string, { mode: string; blob: string }>;
}

interface WorktreeMeta {
  repoPath: string;
  baseCommit: string;
  branch: string;
}

/**
 * Workspace layout (all paths deterministic so a restarted process re-attaches by calling the creators
 * again; `get()` only knows workspaces created or re-attached by THIS instance):
 *   <baseDir>/<runId>/shared/<commit12>     detached worktree at `commit` (read-only view)
 *   <repoPath>                               shared view when no commit is given (no copy, read-only)
 *   <baseDir>/<runId>/wt/<workItemId>        isolated worktree on branch ht/<runId>/<workItemId>
 *   <baseDir>/<runId>/scratch/<workItemId>   empty scratch directory
 *   <baseDir>/<runId>/tmp/<workspaceId>      private sandbox HOME/TMPDIR/reports (outside every root)
 *   <baseDir>/<runId>/meta/<workspaceId>.json  worktree base commit (written before `worktree add`; kept by
 *                                            dispose together with the work branch)
 */
export function createWorkspaceManager(deps: WorkspaceDeps): WorkspaceManager {
  const baseDir = resolve(deps.baseDir);
  const entries = new Map<string, Entry>();
  const logger = deps.logger;

  const runDir = (runId: string) => join(baseDir, segment(runId, 'runId'));
  // creators for the same slot are serialized in-process (concurrent re-attach must not race `worktree add`)
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  }
  /**
   * `git worktree` administration (prune / add / remove) of ONE repository is serialized in-process: parallel work
   * items create their worktrees of the same repository at the same moment, and one creator's `worktree prune` would
   * delete another's half-created administrative directory (`.git/worktrees/<id>` before its `gitdir` exists), failing
   * that `worktree add` — and the agent's spawn. Disposal (remove + prune) races the same way.
   */
  function gitAdmin<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    return serialized(`git-admin:${repo}`, fn);
  }

  /** (security-1) The tamper-proof change list of a git workspace (see worktree-state.ts). */
  async function trustedChanges(e: Entry): Promise<WorktreeChange[]> {
    const env = { GIT_DIR: e.git!.gitDir, GIT_WORK_TREE: e.git!.workTree };
    e.blobs ??= new Map();
    e.baseTree ??= await baseTreeOf(e.git!.workTree, env, e.handle.baseCommit!);
    return worktreeChanges({ root: e.git!.workTree, gitEnv: env, baseCommit: e.handle.baseCommit!, cache: e.blobs, baseTree: e.baseTree });
  }

  async function makeHandle(input: Omit<WorkspaceHandle, 'workspaceId' | 'resourcePrefix' | 'sandbox' | 'tempDir'>, slotKey: string, runId: string): Promise<WorkspaceHandle> {
    const workspaceId = workspaceIdFor(slotKey);
    const tempDir = join(runDir(runId), 'tmp', workspaceId);
    await mkdir(tempDir, { recursive: true });
    const handle: WorkspaceHandle = {
      workspaceId,
      kind: input.kind,
      root: input.root,
      readOnly: input.readOnly,
      sandbox: jsonClone(deps.defaultSandbox),
      resourcePrefix: `workspace/${workspaceId}`,
      tempDir,
    };
    if (input.baseCommit !== undefined) handle.baseCommit = input.baseCommit;
    if (input.branch !== undefined) handle.branch = input.branch;
    return handle;
  }

  function remember(entry: Entry): WorkspaceHandle {
    entries.set(entry.handle.workspaceId, entry);
    return jsonClone(entry.handle);
  }

  async function validWorktreeAt(slot: string, repo: string): Promise<string | undefined> {
    if (!(await isDir(slot))) return undefined;
    const top = await gitRun(slot, ['rev-parse', '--show-toplevel'], { check: false }).catch(() => undefined);
    if (!top || top.code !== 0) return undefined;
    const realSlot = await realpath(slot);
    if ((await realpath(top.stdout.trim()).catch(() => '')) !== realSlot) return undefined;
    // the slot must be a worktree of THIS repository
    const common = await gitRun(slot, ['rev-parse', '--git-common-dir'], { check: false });
    const repoCommon = await gitRun(repo, ['rev-parse', '--git-common-dir'], { check: false });
    const a = await realpath(resolve(slot, common.stdout.trim())).catch(() => 'a');
    const b = await realpath(resolve(repo, repoCommon.stdout.trim())).catch(() => 'b');
    if (a !== b) return undefined;
    const head = await gitRun(slot, ['rev-parse', 'HEAD'], { check: false });
    return head.code === 0 ? head.stdout.trim() : undefined;
  }

  /** Admin dir of the linked worktree at `slot`, found through the main repository's `worktrees/*\/gitdir` files. */
  async function linkedGitDir(repo: string, slot: string): Promise<{ gitDir: string; workTree: string }> {
    const common = (await gitRun(repo, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const dir = join(await realpath(resolve(repo, common)), 'worktrees');
    const workTree = await realpath(slot);
    const want = join(workTree, '.git');
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      const recorded = (await readFile(join(dir, name, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (recorded === '') continue;
      const real = await realpath(dirname(recorded)).then((d) => join(d, basename(recorded))).catch(() => recorded);
      if (real === want) return { gitDir: join(dir, name), workTree };
    }
    throw new HypertestError('integrity_violation', `${slot} is not registered as a worktree of ${repo}`);
  }

  async function repoGitDir(repo: string): Promise<{ gitDir: string; workTree: string }> {
    const gitDir = (await gitRun(repo, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const workTree = (await gitRun(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
    return { gitDir: await realpath(gitDir), workTree: await realpath(workTree) };
  }

  async function requireRepoDir(repoPath: string): Promise<string> {
    const repo = resolve(repoPath);
    if (!(await isDir(repo))) throw new HypertestError('not_found', `repository path ${repoPath} does not exist`);
    return realpath(repo);
  }

  async function sharedSnapshot({ runId, repoPath, commit }: Parameters<WorkspaceManager['sharedSnapshot']>[0]): Promise<WorkspaceHandle> {
    const repo = await requireRepoDir(repoPath);
    const git = await isGitRepo(repo);
    if (commit === undefined) {
      const slotKey = `${join(runDir(runId), 'shared')}::${repo}`;
      let baseCommit: string | undefined;
      let pinned: Entry['git'];
      if (git) {
        const head = await gitRun(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { check: false });
        if (head.code === 0) baseCommit = head.stdout.trim();
        pinned = await repoGitDir(repo);
      }
      const handle = await makeHandle({ kind: 'shared_readonly', root: repo, readOnly: true, ...(baseCommit ? { baseCommit } : {}) }, slotKey, runId);
      return remember({ handle, slot: repo, repoPath: repo, ownsWorktree: false, ...(pinned ? { git: pinned } : {}) });
    }
    if (!git) throw new HypertestError('precondition_failed', `${repoPath} is not a git repository; a commit snapshot needs git`);
    const sha = await resolveCommit(repo, commit);
    const slot = join(runDir(runId), 'shared', sha.slice(0, 12));
    const existing = await validWorktreeAt(slot, repo);
    if (existing !== sha) {
      await gitAdmin(repo, async () => {
        if (await isDir(slot)) {
          await gitRun(repo, ['worktree', 'remove', '--force', slot], { check: false });
          await rm(slot, { recursive: true, force: true });
        }
        await gitRun(repo, ['worktree', 'prune']);
        await mkdir(join(runDir(runId), 'shared'), { recursive: true });
        await gitRun(repo, ['worktree', 'add', '--detach', slot, sha]);
      });
    }
    const root = await realpath(slot);
    const handle = await makeHandle({ kind: 'shared_readonly', root, readOnly: true, baseCommit: sha }, slot, runId);
    return remember({ handle, slot: root, repoPath: repo, ownsWorktree: true, git: await linkedGitDir(repo, root) });
  }

  async function isolatedWorktree({ runId, workItemId, repoPath, baseCommit }: Parameters<WorkspaceManager['isolatedWorktree']>[0]): Promise<WorkspaceHandle> {
    const repo = await requireRepoDir(repoPath);
    if (!(await isGitRepo(repo))) throw new HypertestError('precondition_failed', `${repoPath} is not a git repository; an isolated worktree needs git`);
    const slot = join(runDir(runId), 'wt', segment(workItemId, 'workItemId'));
    const workspaceId = workspaceIdFor(slot);
    const metaPath = join(runDir(runId), 'meta', `${workspaceId}.json`);
    const branch = `ht/${runId}/${workItemId}`;
    const refOk = await gitRun(repo, ['check-ref-format', `refs/heads/${branch}`], { check: false });
    if (refOk.code !== 0) throw new HypertestError('invalid_argument', `invalid worktree branch name ${branch}`);

    let meta: WorktreeMeta | undefined;
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as WorktreeMeta;
    } catch {
      meta = undefined;
    }
    if (meta && meta.repoPath !== repo) throw new HypertestError('conflict', `workspace ${slot} belongs to repository ${meta.repoPath}, not ${repo}`);
    if (meta && baseCommit !== undefined) {
      const want = await resolveCommit(repo, baseCommit);
      if (want !== meta.baseCommit) throw new HypertestError('conflict', `worktree ${slot} was created at ${meta.baseCommit}, not ${want}`);
    }
    if (!meta) {
      const sha = await resolveCommit(repo, baseCommit ?? 'HEAD');
      meta = { repoPath: repo, baseCommit: sha, branch };
      await mkdir(join(runDir(runId), 'meta'), { recursive: true });
      // written BEFORE `worktree add`: its presence means the branch is ours (reattach never resets it)
      await writeFile(metaPath, JSON.stringify(meta));
      await gitAdmin(repo, async () => {
        await gitRun(repo, ['worktree', 'prune']);
        if (await isDir(slot)) await rm(slot, { recursive: true, force: true });
        await mkdir(join(runDir(runId), 'wt'), { recursive: true });
        await gitRun(repo, ['worktree', 'add', '-B', branch, slot, sha]);
      });
    } else if ((await validWorktreeAt(slot, repo)) === undefined) {
      const recorded = meta;
      await gitAdmin(repo, async () => {
        await gitRun(repo, ['worktree', 'prune']);
        if (await isDir(slot)) await rm(slot, { recursive: true, force: true });
        await mkdir(join(runDir(runId), 'wt'), { recursive: true });
        const hasBranch = await gitRun(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { check: false });
        if (hasBranch.code === 0) await gitRun(repo, ['worktree', 'add', slot, branch]);
        else await gitRun(repo, ['worktree', 'add', '-B', branch, slot, recorded.baseCommit]);
      });
      logger.info('workspace worktree re-created', { slot, branch });
    }
    const root = await realpath(slot);
    const handle = await makeHandle({ kind: 'isolated_worktree', root, readOnly: false, baseCommit: meta.baseCommit, branch }, slot, runId);
    return remember({ handle, slot: root, repoPath: repo, ownsWorktree: true, git: await linkedGitDir(repo, root) });
  }

  async function scratch({ runId, workItemId }: Parameters<WorkspaceManager['scratch']>[0]): Promise<WorkspaceHandle> {
    const slot = join(runDir(runId), 'scratch', segment(workItemId, 'workItemId'));
    await mkdir(slot, { recursive: true });
    const root = await realpath(slot);
    const handle = await makeHandle({ kind: 'scratch', root, readOnly: false }, slot, runId);
    return remember({ handle, slot: root, ownsWorktree: false });
  }

  return {
    sharedSnapshot: (input) => serialized(`shared:${input.runId}`, () => sharedSnapshot(input)),
    isolatedWorktree: (input) => serialized(`wt:${input.runId}:${input.workItemId}`, () => isolatedWorktree(input)),
    scratch: (input) => serialized(`scratch:${input.runId}:${input.workItemId}`, () => scratch(input)),

    get(workspaceId) {
      const e = entries.get(workspaceId);
      return e ? jsonClone(e.handle) : undefined;
    },

    resolvePath(ws, relPath) {
      return confineExisting(ws.root, relPath);
    },

    async diff(ws) {
      // only handles this manager created or re-attached: their git dir was pinned from trusted metadata
      const e = entries.get(ws.workspaceId);
      if (!e) throw new HypertestError('precondition_failed', `workspace ${ws.workspaceId} is not registered with this manager; re-attach it (call its creator) first`);
      const { handle } = e;
      if (!handle.baseCommit || !e.git) throw new HypertestError('precondition_failed', `workspace ${ws.workspaceId} has no git base commit`);
      // GIT_DIR/GIT_WORK_TREE: a rewritten `.git` pointer in the root cannot redirect trusted git to
      // attacker-controlled config. security-1: the diff is computed from the RAW bytes on disk against the real base
      // tree — index flags (skip-worktree, assume-unchanged), replace refs, excludes, attributes and filters an agent's
      // command can set never hide a change (worktree-state.ts)
      const env = { GIT_DIR: e.git.gitDir, GIT_WORK_TREE: e.git.workTree };
      return renderWorktreeDiff(e.git.workTree, env, await trustedChanges(e));
    },

    async changedFiles(ws): Promise<WorkspaceChange[]> {
      const e = entries.get(ws.workspaceId);
      if (!e) throw new HypertestError('precondition_failed', `workspace ${ws.workspaceId} is not registered with this manager; re-attach it (call its creator) first`);
      const { handle } = e;
      const root = await realpath(handle.root);
      const hashed = async (path: string, change: WorkspaceChange['change']): Promise<WorkspaceChange> => {
        const c: WorkspaceChange = { path, change };
        if (change !== 'deleted') {
          // confined like every workspace read: a path leading out through a symlinked directory is never hashed
          const abs = await confineExisting(root, path).catch(() => undefined);
          const digest = abs === undefined ? undefined : await fileSha256(abs);
          if (digest !== undefined) c.sha256 = digest;
        }
        return c;
      };
      if (!handle.baseCommit || !e.git) {
        // a scratch directory starts empty: everything in it was created in this run
        if (handle.kind !== 'scratch') throw new HypertestError('precondition_failed', `workspace ${ws.workspaceId} has no git base commit`);
        return Promise.all((await listTree(root)).map((p) => hashed(p, 'added')));
      }
      // every file whose raw bytes differ from the base tree (committed on the branch, staged, unstaged or untracked):
      // the same tamper-proof comparison as diff() (security-1), so index flags or replace refs never hide a test file
      const changes = await trustedChanges(e);
      return Promise.all(changes.map((c) => hashed(c.path, c.change)));
    },

    async dispose(workspaceId) {
      const e = entries.get(workspaceId);
      if (!e) return;
      entries.delete(workspaceId);
      if (e.ownsWorktree && e.repoPath) {
        const repo = e.repoPath;
        await gitAdmin(repo, async () => {
          await gitRun(repo, ['worktree', 'remove', '--force', e.slot], { check: false });
          await rm(e.slot, { recursive: true, force: true });
          await gitRun(repo, ['worktree', 'prune'], { check: false });
        });
      } else if (e.handle.kind === 'scratch') {
        await rm(e.slot, { recursive: true, force: true });
      }
      if (e.handle.tempDir) await rm(e.handle.tempDir, { recursive: true, force: true });
      // the worktree meta (base commit) is kept with the work branch: re-creating the workspace re-attaches the
      // branch at its recorded base instead of resetting it (`worktree add -B`) and losing the agent's commits
    },
  };
}
