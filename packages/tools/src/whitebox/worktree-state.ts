import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { SAFE_GIT_CONFIG, gitRun, trustedGitEnv } from './git-exec.ts';

/**
 * Tamper-proof view of a worktree against its base commit (security-1, I8).
 *
 * The drift/test-change governance and the gate's test-file linkage must see what is REALLY on disk. Plain `git diff
 * <base>` trusts state an agent's shell command can rewrite: index flags (`update-index --skip-worktree` /
 * `--assume-unchanged` make a modified tracked file look unchanged), replace refs (`git replace <base> HEAD` makes the
 * base resolve to the agent's commit), repository config (`core.ignoreStat`, sparse checkout, excludes) and attributes
 * (a clean filter or `-diff` can hide a change). Here:
 *  - base and HEAD trees are listed with `--no-replace-objects`;
 *  - every candidate path (base tree ∪ HEAD tree ∪ index entries ∪ untracked files not ignored by a `.gitignore`) is
 *    compared by the git blob id of its RAW bytes on disk (no filters, no attributes, no index stat data);
 *  - changed files are rendered by `git diff --no-index --text` over byte copies in an isolated temporary directory (no
 *    repository, no attributes, no filters, no external diff) and relabelled with their workspace paths.
 * A path whose parent directory is a symlink counts as absent (as git does). Unchanged files are recognised from a
 * per-workspace cache keyed by (ctime, mtime, size, inode): ctime cannot be set back by a process, so a same-size edit
 * with a forged mtime is still re-read.
 */

/** A path that differs between the workspace's base commit and the disk. */
export interface WorktreeChange {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  /** Base tree entry (absent when added). */
  base?: { mode: string; blob: string };
  /** On-disk state (absent when deleted). */
  disk?: { mode: string; blob: string };
}

/** Stat-keyed blob ids of one workspace (see the module comment). */
export type BlobCache = Map<string, { key: string; mode: string; blob: string }>;

/** git's blob id (sha1 of `blob <len>\0<bytes>`) of raw bytes — never through filters or attributes. */
export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** git options that make repository state an agent can write irrelevant to what trusted git reports. */
const HARDENED = ['--no-replace-objects', '-c', 'core.ignoreStat=false', '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false'];

/** Largest file rendered in full; larger changed files get a marker section (still a change: classified, never hidden). */
export const MAX_RENDERED_FILE_BYTES = 4 * 1024 * 1024;

async function lsTree(root: string, env: Record<string, string>, rev: string): Promise<Map<string, { mode: string; blob: string }>> {
  const out = new Map<string, { mode: string; blob: string }>();
  const r = await gitRun(root, [...HARDENED, 'ls-tree', '-r', '-z', '--full-tree', rev], { env, check: false });
  if (r.code !== 0) {
    if (rev === 'HEAD') return out; // an unborn / broken HEAD adds no candidates (the base and the disk still count)
    throw new HypertestError('precondition_failed', `git ls-tree ${rev} failed: ${r.stderr.trim()}`);
  }
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (type === 'blob' && mode && blob) out.set(path, { mode, blob });
    else if (type === 'commit' && mode && blob) out.set(path, { mode, blob }); // gitlink (submodule): never compared by content
  }
  return out;
}

async function lsFiles(root: string, env: Record<string, string>, args: string[]): Promise<string[]> {
  const r = await gitRun(root, [...HARDENED, 'ls-files', '-z', ...args], { env, check: false });
  if (r.code !== 0) throw new HypertestError('precondition_failed', `git ls-files failed: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

/** On-disk state of a workspace-relative path; undefined when absent (or below a symlinked / non-directory parent). */
async function diskState(root: string, path: string, cache: BlobCache): Promise<{ mode: string; blob: string } | undefined> {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const st = await lstat(dir).catch(() => undefined);
    if (!st || !st.isDirectory()) return undefined;
  }
  const abs = join(root, ...parts);
  const st = await lstat(abs).catch(() => undefined);
  if (!st) return undefined;
  let mode: string;
  if (st.isSymbolicLink()) mode = '120000';
  else if (st.isFile()) mode = (st.mode & 0o111) !== 0 ? '100755' : '100644';
  else if (st.isDirectory()) return { mode: '040000', blob: '' }; // e.g. a submodule checkout, or a file replaced by a directory
  else return { mode: 'other', blob: '' };
  const key = `${st.ctimeMs}:${st.mtimeMs}:${st.size}:${st.ino}:${mode}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return { mode: hit.mode, blob: hit.blob };
  const bytes = mode === '120000' ? Buffer.from(await readlink(abs)) : await readFile(abs);
  const blob = gitBlobId(bytes);
  cache.set(path, { key, mode, blob });
  if (cache.size > 200_000) cache.delete(cache.keys().next().value!);
  return { mode, blob };
}

const IGNORE_FILE = '.gitignore';

function isIgnoreFile(path: string): boolean {
  return path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`);
}

/** Escapes gitignore glob metacharacters in a literal directory prefix. */
function escapeIgnoreGlob(dir: string): string {
  return dir.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/**
 * The ignore rules of the BASE commit's `.gitignore` files as one root-relative exclude file (security-1). Each file's
 * patterns are anchored to its directory (a pattern with a slash ⇒ `/<dir>/<pattern>`; without ⇒ `/<dir>/**∕<pattern>`,
 * i.e. at any depth below it), negations and directory-only markers kept, shallower files first so a deeper file's
 * patterns take precedence (the last matching pattern of one file wins) — git's per-directory semantics.
 */
export async function baseIgnorePatterns(root: string, env: Record<string, string>, base: ReadonlyMap<string, { mode: string; blob: string }>): Promise<string> {
  const files = [...base.entries()]
    .filter(([p, e]) => isIgnoreFile(p) && (e.mode === '100644' || e.mode === '100755')) // git never follows a symlinked .gitignore
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const [path, entry] of files) {
    const dir = path === IGNORE_FILE ? '' : path.slice(0, -(IGNORE_FILE.length + 1));
    const text = (await blobBytes(root, env, entry.blob)).toString('utf8');
    for (let line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      line = line.replace(/(?<!\\) +$/, ''); // trailing spaces are ignored unless escaped
      if (line === '') continue;
      const negated = line.startsWith('!');
      let body = negated ? line.slice(1) : line;
      const dirOnly = body.endsWith('/');
      if (dirOnly) body = body.slice(0, -1);
      if (body === '') continue;
      const anchored = body.includes('/');
      body = body.replace(/^\//, '');
      let pattern = dir === '' ? (anchored ? `/${body}` : body) : anchored ? `/${escapeIgnoreGlob(dir)}/${body}` : `/${escapeIgnoreGlob(dir)}/**/${body}`;
      if (dirOnly) pattern += '/';
      out.push(negated ? `!${pattern}` : pattern);
    }
  }
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

/**
 * Untracked files not ignored — by the worktree's own `.gitignore` files when every one of them is exactly the base
 * commit's (then git's rules are the base's), otherwise by the BASE commit's ignore rules only (security-1: an agent's
 * command that writes or edits a `.gitignore` — even one that ignores itself — must never hide a file it added).
 */
async function untrackedFiles(
  root: string,
  env: Record<string, string>,
  base: ReadonlyMap<string, { mode: string; blob: string }>,
  tracked: readonly string[],
  cache: BlobCache,
): Promise<string[]> {
  // every untracked .gitignore, wherever it is (no exclude rules applied to this listing)
  const strayIgnoreFiles = await lsFiles(root, env, ['--others', '--', `:(glob)**/${IGNORE_FILE}`]);
  let tainted = strayIgnoreFiles.length > 0;
  for (const path of tracked) {
    if (tainted) break;
    if (!isIgnoreFile(path)) continue;
    const b = base.get(path);
    const d = await diskState(root, path, cache);
    if (!b || !d || b.blob !== d.blob || b.mode !== d.mode) tainted = true;
  }
  if (!tainted) return lsFiles(root, env, ['--others', `--exclude-per-directory=${IGNORE_FILE}`]);
  const dir = await mkdtemp(join(tmpdir(), 'ht-wtignore-'));
  try {
    const file = join(dir, 'exclude');
    await writeFile(file, await baseIgnorePatterns(root, env, base));
    return await lsFiles(root, env, ['--others', `--exclude-from=${file}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Every path whose on-disk bytes (or mode) differ from the base commit's tree, sorted. `baseTree` may be passed in
 * (cached: the base never changes).
 */
export async function worktreeChanges(input: {
  root: string;
  gitEnv: Record<string, string>;
  baseCommit: string;
  cache: BlobCache;
  baseTree?: Map<string, { mode: string; blob: string }>;
}): Promise<WorktreeChange[]> {
  const { root, gitEnv: env, baseCommit, cache } = input;
  const base = input.baseTree ?? (await lsTree(root, env, baseCommit));
  const head = await lsTree(root, env, 'HEAD');
  // index entries (skip-worktree / assume-unchanged ones included: only their NAMES are used, never their flags or stat)
  const indexed = await lsFiles(root, env, ['--cached']);
  // untracked files not ignored by the BASE commit's .gitignore rules (never by .git/info/exclude, a global excludes
  // file or a .gitignore the agent wrote or edited: it can write those without the change showing up anywhere)
  const untracked = await untrackedFiles(root, env, base, [...new Set([...base.keys(), ...head.keys(), ...indexed])], cache);
  const candidates = [...new Set([...base.keys(), ...head.keys(), ...indexed, ...untracked])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: WorktreeChange[] = [];
  for (const path of candidates) {
    const b = base.get(path);
    if (b && b.mode === '160000') continue; // submodules are not diffed by content
    const d = await diskState(root, path, cache);
    const disk = d && d.mode !== '040000' && d.mode !== 'other' ? d : undefined;
    if (!b && !disk) continue;
    if (b && disk && b.blob === disk.blob && b.mode === disk.mode) continue;
    const change: WorktreeChange = { path, change: !b ? 'added' : !disk ? 'deleted' : 'modified' };
    if (b) change.base = { mode: b.mode, blob: b.blob };
    if (disk) change.disk = { mode: disk.mode, blob: disk.blob };
    out.push(change);
  }
  return out;
}

/** The base tree of a commit (hardened listing; cache it per workspace). */
export function baseTreeOf(root: string, gitEnv: Record<string, string>, baseCommit: string): Promise<Map<string, { mode: string; blob: string }>> {
  return lsTree(root, gitEnv, baseCommit);
}

function blobBytes(root: string, env: Record<string, string>, blob: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...SAFE_GIT_CONFIG, ...HARDENED, 'cat-file', 'blob', blob], { cwd: root, env: { ...trustedGitEnv(), ...env }, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new HypertestError('precondition_failed', `git cat-file blob ${blob} failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    });
  });
}

/** C-style quoting of a diff header path the way git does for special characters (core.quotePath=false). */
function quotePath(prefix: string, path: string): string {
  const full = `${prefix}${path}`;
  // eslint-disable-next-line no-control-regex
  if (!/["\\\x00-\x1f\x7f]/.test(full)) return full;
  const esc = full.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
  return `"${esc}"`;
}

function noIndexDiff(cwd: string, oldArg: string, newArg: string, parent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // an isolated directory outside any repository: no attributes, no filters, no textconv, no external diff
    const env = { ...trustedGitEnv(), GIT_CEILING_DIRECTORIES: parent, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFile(
      'git',
      ['--no-pager', ...SAFE_GIT_CONFIG, '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false', 'diff', '--no-index', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--', oldArg, newArg],
      { cwd, env, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as unknown as { code?: unknown }).code as number | string | undefined) : 0;
        if (code === 0 || code === 1) resolve(String(stdout));
        else reject(new HypertestError('precondition_failed', `git diff --no-index failed (${String(code)}): ${String(stderr).trim()}`));
      },
    );
  });
}

const FILE_MODE: Record<string, number> = { '100644': 0o644, '100755': 0o755, '120000': 0o644 };

/**
 * Unified diff (git format, `a/<path>` → `b/<path>`) of the changes, rendered from raw bytes (see the module comment).
 */
export async function renderWorktreeDiff(root: string, gitEnv: Record<string, string>, changes: readonly WorktreeChange[]): Promise<string> {
  if (changes.length === 0) return '';
  const parent = await mkdtemp(join(tmpdir(), 'ht-wtdiff-'));
  try {
    const sections: string[] = [];
    for (const [i, c] of changes.entries()) {
      const oldName = c.base ? `old${i}` : '/dev/null';
      const newName = c.disk ? `new${i}` : '/dev/null';
      let tooLarge = false;
      if (c.base) {
        const bytes = await blobBytes(root, gitEnv, c.base.blob);
        tooLarge ||= bytes.length > MAX_RENDERED_FILE_BYTES;
        await writeFile(join(parent, oldName), tooLarge ? '' : bytes);
        await chmod(join(parent, oldName), FILE_MODE[c.base.mode] ?? 0o644);
      }
      if (c.disk) {
        const abs = join(root, ...c.path.split('/'));
        const bytes = c.disk.mode === '120000' ? Buffer.from(await readlink(abs)) : await readFile(abs);
        tooLarge ||= bytes.length > MAX_RENDERED_FILE_BYTES;
        await writeFile(join(parent, newName), tooLarge ? '' : bytes);
        await chmod(join(parent, newName), FILE_MODE[c.disk.mode] ?? 0o644);
      }
      const a = quotePath('a/', c.path);
      const b = quotePath('b/', c.path);
      if (tooLarge) {
        const kind = c.change === 'added' ? `new file mode ${c.disk!.mode}\n` : c.change === 'deleted' ? `deleted file mode ${c.base!.mode}\n` : '';
        sections.push(`diff --git ${a} ${b}\n${kind}--- ${c.base ? a : '/dev/null'}\n+++ ${c.disk ? b : '/dev/null'}\n@@ -0,0 +0,0 @@\n+[hypertest: ${c.path} changed; larger than ${MAX_RENDERED_FILE_BYTES} bytes, not rendered]\n`);
        continue;
      }
      const raw = await noIndexDiff(parent, oldName, newName, dirname(parent));
      if (raw === '') {
        // same rendered text, different entry (a symlink ↔ file with the same text, a mode change git did not report)
        if (c.base && c.disk) sections.push(`diff --git ${a} ${b}\nold mode ${c.base.mode}\nnew mode ${c.disk.mode}\n`);
        continue;
      }
      const lines = raw.split('\n');
      const out: string[] = [];
      for (const [n, line] of lines.entries()) {
        if (n === 0 && line.startsWith('diff --git ')) out.push(`diff --git ${a} ${b}`);
        else if (line.startsWith('--- ') && !out.some((l) => l.startsWith('--- '))) out.push(`--- ${c.base ? a : '/dev/null'}`);
        else if (line.startsWith('+++ ') && !out.some((l) => l.startsWith('+++ '))) out.push(`+++ ${c.disk ? b : '/dev/null'}`);
        else if (/^(new file mode|deleted file mode|old mode|new mode) /.test(line) && !out.some((l) => l.startsWith('@@'))) {
          // modes of the real entries (symlinks are rendered from their target text)
          const mode = line.startsWith('new file mode') ? c.disk!.mode : line.startsWith('deleted file mode') ? c.base!.mode : line.startsWith('old mode') ? c.base!.mode : c.disk!.mode;
          out.push(`${line.replace(/ \d{6}$/, '')} ${mode}`);
        } else out.push(line);
      }
      // a symlink ↔ file or mode-only change git --no-index may not show as a mode line
      if (c.base && c.disk && c.base.mode !== c.disk.mode && !out.some((l) => l.startsWith('old mode'))) out.splice(1, 0, `old mode ${c.base.mode}`, `new mode ${c.disk.mode}`);
      sections.push(out.join('\n'));
    }
    return sections.join('');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
