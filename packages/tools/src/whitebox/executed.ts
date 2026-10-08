import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { HypertestError, canonicalJson, sha256Hex, type JsonValue } from '@hypertest/core';
import type { SandboxRunner, TestRunResult, TestRunnerAdapter, WorkspaceHandle, WorkspaceManager } from '../contracts.ts';
import { SAFE_GIT_CONFIG, gitRun, trustedGitEnv } from './git-exec.ts';
import { copyWorkspace } from './mutation.ts';
import { confineExisting, normalizeRel } from './paths.ts';
import { fileExists, looksLikePath, splitSelector } from './runners/common.ts';

/**
 * (D-0 / D-1) Execution binding of test evidence: WHICH test files a run executed, with the content digest of each and a
 * framework-appropriate syntax/static check of the files that differ from the base commit, and WHICH code it ran on —
 * derived by the tool from the run itself (never claimed by the caller). `test.run` and `mutation.run` record it as
 * `executedTests` / `codeRevision` on their evidence; the QualityGate and `test_artifact.validate` (policy
 * `sensitivityBinding`) count a known-good / known-bad / mutation run for an artifact only when it executed exactly that
 * artifact's content.
 *
 * Case → file attribution: the case's `file`; else the head of its id (`file::name`) when it names a workspace file; a
 * pytest classname module (`tests.test_x.TestC` → `tests/test_x.py`); a Go test name defined by exactly one `_test.go`
 * file of the workspace; else — when the selector names exactly one existing file — that file. Cases that cannot be
 * attributed are counted (`unattributedCases`; attribution `partial`/`none`).
 */

export interface StaticCheck {
  checker: string;
  ok: boolean;
  detail?: string;
}

export interface ExecutedTestFileRecord {
  path: string;
  sha256?: string;
  cases: number;
  staticCheck?: StaticCheck;
}

export interface ExecutedTestsRecord {
  attribution: 'complete' | 'partial' | 'none';
  files: ExecutedTestFileRecord[];
  unattributedCases: number;
}

const MAX_STATIC_CHECKS = 20;
const MAX_GO_SCAN_FILES = 2000;

async function sha256File(abs: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readFile(abs));
  } catch {
    return undefined;
  }
}

/** A workspace-relative path for `p` when it names an existing file inside the workspace (else undefined). */
async function workspaceFile(root: string, realRoot: string, p: string): Promise<string | undefined> {
  if (p === '' || p.includes('\0')) return undefined;
  let rel = p;
  if (isAbsolute(p)) {
    const r = relative(realRoot, p);
    if (r.startsWith('..') || isAbsolute(r)) {
      const r2 = relative(root, p);
      if (r2.startsWith('..') || isAbsolute(r2)) return undefined;
      rel = r2;
    } else rel = r;
  }
  rel = normalizeRel(rel.split(sep).join('/'));
  try {
    const abs = await confineExisting(root, rel);
    return (await fileExists(abs)) ? rel : undefined;
  } catch {
    return undefined;
  }
}

/** Every `_test.go` file defining each `TestXxx` function (bounded scan; node_modules / vendor / .git skipped). */
async function goTestIndex(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  let seen = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (seen >= MAX_GO_SCAN_FILES) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) {
        if (['.git', 'node_modules', 'vendor', '.hypertest'].includes(e.name)) continue;
        await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && e.name.endsWith('_test.go')) {
        if (++seen > MAX_GO_SCAN_FILES) return;
        const path = rel ? `${rel}/${e.name}` : e.name;
        const text = await readFile(join(dir, e.name), 'utf8').catch(() => '');
        for (const m of text.matchAll(/^func\s+(Test\w*)\s*\(/gm)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), path]);
      }
    }
  };
  await walk(root, '');
  return out;
}

/** The workspace file a test case belongs to (see the module comment), or undefined. */
async function caseFile(root: string, realRoot: string, c: TestRunResult['cases'][number], framework: string, goIndex: () => Promise<Map<string, string[]>>): Promise<string | undefined> {
  if (typeof c.file === 'string') {
    const f = await workspaceFile(root, realRoot, c.file);
    if (f !== undefined) return f;
  }
  const at = c.id.indexOf('::');
  if (at > 0) {
    const head = c.id.slice(0, at);
    const direct = looksLikePath(head) ? await workspaceFile(root, realRoot, head) : undefined;
    if (direct !== undefined) return direct;
    if (framework === 'pytest' || /^[\w.]+$/.test(head)) {
      // pytest classname: module path, possibly followed by class names
      const parts = head.split('.');
      for (let n = parts.length; n >= 1; n--) {
        const f = await workspaceFile(root, realRoot, `${parts.slice(0, n).join('/')}.py`);
        if (f !== undefined) return f;
      }
    }
    if (framework === 'go_test') {
      const name = c.id.slice(at + 2).split('/')[0]!;
      const files = (await goIndex()).get(name) ?? [];
      if (files.length === 1) return files[0];
    }
  }
  return undefined;
}

/**
 * Attributes the run's cases to workspace files and hashes those files (see the module comment). `root` is the directory
 * the run executed in (the workspace, or a private copy of it).
 */
export async function attributeExecutedTests(root: string, result: TestRunResult, selector: string | undefined): Promise<{ record: ExecutedTestsRecord; perFile: Map<string, TestRunResult['cases']> }> {
  const realRoot = await realpath(root).catch(() => root);
  let goIdx: Map<string, string[]> | undefined;
  const goIndex = async () => (goIdx ??= await goTestIndex(root));
  const perFile = new Map<string, TestRunResult['cases']>();
  let unattributed = 0;
  for (const c of result.cases) {
    const f = await caseFile(root, realRoot, c, result.framework, goIndex);
    if (f === undefined) unattributed++;
    else perFile.set(f, [...(perFile.get(f) ?? []), c]);
  }
  if (perFile.size === 0 && unattributed > 0 && selector !== undefined) {
    // the selector names one file: every case of the run is that file's
    const sel = splitSelector(selector);
    const named = sel.file ?? (sel.pattern !== undefined && looksLikePath(sel.pattern) ? sel.pattern : undefined);
    const f = named !== undefined ? await workspaceFile(root, realRoot, normalizeRel(named)) : undefined;
    if (f !== undefined) {
      perFile.set(f, [...result.cases]);
      unattributed = 0;
    }
  }
  const files: ExecutedTestFileRecord[] = [];
  for (const [path, cases] of [...perFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const rec: ExecutedTestFileRecord = { path, cases: cases.length };
    const digest = await sha256File(await confineExisting(root, path).catch(() => join(root, path)));
    if (digest !== undefined) rec.sha256 = digest;
    files.push(rec);
  }
  const attribution: ExecutedTestsRecord['attribution'] = result.cases.length === 0 ? 'none' : unattributed === 0 ? 'complete' : files.length === 0 ? 'none' : 'partial';
  return { record: { attribution, files, unattributedCases: unattributed }, perFile };
}

const TS_CHECK_SCRIPT = [
  "import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';",
  "import { stripTypeScriptTypes } from 'node:module';",
  "import { execFileSync } from 'node:child_process';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  'const f = process.argv[1];',
  "let js; try { js = stripTypeScriptTypes(readFileSync(f, 'utf8')); } catch (e) { process.stderr.write(`${f}: ${e.message}\\n`); process.exit(1); }",
  "const d = mkdtempSync(join(tmpdir(), 'ht-tscheck-')); const out = join(d, 'check.mjs'); writeFileSync(out, js);",
  "try { execFileSync(process.execPath, ['--check', out], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { process.stderr.write(String(e.stderr ?? e.message).split(out).join(f)); process.exitCode = 1; } finally { rmSync(d, { recursive: true, force: true }); }",
].join('\n');

const PY_CHECK_SCRIPT = 'import sys, py_compile\npy_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)';

/** The framework-appropriate syntax/static check command for a test file, or undefined (no static checker). */
export function staticCheckCommand(path: string, scratchDir: string): { checker: string; argv: string[] } | undefined {
  if (/\.(m|c)?js$/.test(path)) return { checker: 'node --check', argv: ['node', '--check', path] };
  if (/\.(m|c)?ts$/.test(path)) return { checker: 'typescript strip + node --check', argv: ['node', '--input-type=module', '-e', TS_CHECK_SCRIPT, path] };
  if (/\.py$/.test(path)) return { checker: 'python3 -m py_compile', argv: ['python3', '-c', PY_CHECK_SCRIPT, path, join(scratchDir, `${randomUUID()}.pyc`)] };
  if (/\.go$/.test(path)) return { checker: 'gofmt -e', argv: ['gofmt', '-e', '-l', path] };
  return undefined;
}

/**
 * Runs the static check of each file (at most MAX_STATIC_CHECKS) in the sandbox, from `root`. A language without a
 * static checker (e.g. JSX/TSX) is checked by collection: the run executed cases of the file without any harness error.
 */
export async function staticChecks(
  ws: WorkspaceHandle,
  root: string,
  files: ExecutedTestFileRecord[],
  collectedCleanly: (path: string) => boolean,
  sandbox: SandboxRunner,
  signal: AbortSignal,
): Promise<void> {
  const scratch = ws.tempDir ?? (await mkdtemp(join(tmpdir(), 'ht-static-')));
  const own = ws.tempDir === undefined;
  try {
    let n = 0;
    for (const f of files) {
      if (n >= MAX_STATIC_CHECKS) break;
      n++;
      const cmd = staticCheckCommand(f.path, scratch);
      if (!cmd) {
        const ok = collectedCleanly(f.path);
        f.staticCheck = ok ? { checker: 'collection', ok } : { checker: 'collection', ok, detail: 'no static checker for this language and the run did not collect it cleanly' };
        continue;
      }
      try {
        const runWs: WorkspaceHandle = root === ws.root ? ws : { ...ws, root, readOnly: false, kind: 'scratch' };
        const p = await sandbox.run(runWs, cmd.argv, { timeoutMs: 60_000, signal, maxOutputBytes: 64 * 1024 });
        const ok = p.exitCode === 0 && !p.timedOut && p.spawnError === undefined;
        f.staticCheck = ok ? { checker: cmd.checker, ok } : { checker: cmd.checker, ok, detail: (p.spawnError ?? (p.stderr || p.stdout || `exit ${p.exitCode}`)).trim().slice(0, 500) };
      } catch (e) {
        f.staticCheck = { checker: cmd.checker, ok: false, detail: `static check could not run: ${(e as Error).message.slice(0, 300)}` };
      }
    }
  } finally {
    if (own) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Static check fallback for languages without a checker: the run collected cases of the file without any harness error. */
export function collectedCleanly(result: TestRunResult, perFile: Map<string, TestRunResult['cases']>): (path: string) => boolean {
  return (path) => {
    const cases = perFile.get(path) ?? [];
    return cases.length > 0 && result.harnessError === undefined && cases.every((c) => c.status !== 'error');
  };
}

/** The code revision a run in the workspace executed (from its workspace delta). */
export function workspaceCodeRevision(delta: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { kind: 'workspace' };
  if (typeof delta['baseCommit'] === 'string') out['baseCommit'] = delta['baseCommit'];
  if (delta['status'] === 'computed' && typeof delta['treeDigest'] === 'string') out['treeDigest'] = delta['treeDigest'];
  return out;
}

/** The files of `files` that differ from the base commit (added/modified per the workspace delta); all of them when unknown. */
export function changedSubset(files: ExecutedTestFileRecord[], delta: Record<string, JsonValue>): ExecutedTestFileRecord[] {
  if (delta['status'] !== 'computed' || !Array.isArray(delta['testFiles'])) return files;
  const changed = new Set((delta['testFiles'] as JsonValue[]).flatMap((t) => (t && typeof t === 'object' && !Array.isArray(t) && (t as Record<string, JsonValue>)['change'] !== 'deleted' ? [String((t as Record<string, JsonValue>)['path'])] : [])));
  return files.filter((f) => changed.has(f.path));
}

/** Binary-safe `git cat-file blob <commit>:<path>` (undefined when the path does not exist at that commit). */
function gitBlob(cwd: string, commit: string, path: string): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...SAFE_GIT_CONFIG, 'cat-file', 'blob', `${commit}:${path}`], { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, env: trustedGitEnv() }, (error, stdout) => {
      if (error) {
        if (typeof (error as NodeJS.ErrnoException).code === 'string') return reject(new HypertestError('unavailable', `git could not be started: ${error.message}`));
        return resolve(undefined);
      }
      resolve(stdout as Buffer);
    });
  });
}

export interface BaseRunInput {
  ws: WorkspaceHandle;
  workspaces: WorkspaceManager;
  runner: TestRunnerAdapter;
  sandbox: SandboxRunner;
  request: Parameters<TestRunnerAdapter['run']>[1];
  /** Paths that count as test code (kept from the workspace); everything else that changed is restored to the base. */
  isTestFile: (path: string) => boolean;
  /** The known-good base commit (the run's target.baseCommit; set by the control plane, never by the agent). */
  baseCommit: string;
}

/** Every path that differs between the workspace (committed, staged, unstaged, untracked) and `commit`. */
async function changesAgainst(ws: WorkspaceHandle, workspaces: WorkspaceManager, commit: string): Promise<Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>> {
  const out = new Map<string, 'added' | 'modified' | 'deleted'>();
  const r = await gitRun(ws.root, ['diff', '--no-renames', '--name-status', '-z', commit, '--'], { check: true });
  const parts = r.stdout.split('\0').filter((x) => x !== '');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    out.set(path, status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified');
  }
  // untracked files are not in `git diff`; the workspace manager lists them (added since the workspace's own base)
  for (const c of (await workspaces.changedFiles?.(ws)) ?? []) if (!out.has(c.path) && c.change === 'added') out.set(c.path, 'added');
  return [...out.entries()].map(([path, change]) => ({ path, change })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * (D-1) A known-good run on the BASE revision (the run's target.baseCommit): a private copy of the workspace whose product
 * code is restored to that commit (every non-test file that differs from it reverted, files it does not have removed)
 * while the workspace's test files (the artifact under validation, its helpers and fixtures) are kept — so a generated
 * regression test can show that it passes on the code before the change. The workspace is never modified. Returns the
 * run, the copy's root (same relative paths) and the code revision `{ kind: 'base', baseCommit, treeDigest }`.
 */
export async function runOnBaseRevision(input: BaseRunInput): Promise<{ run: Awaited<ReturnType<TestRunnerAdapter['run']>>; root: string; codeRevision: Record<string, JsonValue>; cleanup(): Promise<void> }> {
  const { ws } = input;
  if (ws.baseCommit === undefined || typeof input.workspaces.changedFiles !== 'function' || typeof input.baseCommit !== 'string' || input.baseCommit === '') {
    throw new HypertestError('precondition_failed', 'revision "base" needs a git workspace with a base commit (an isolated worktree or snapshot of the target) and the run\'s base commit');
  }
  const changes = await changesAgainst(ws, input.workspaces, input.baseCommit);
  const realRoot = await realpath(ws.root);
  const tempInsideRoot = ws.tempDir !== undefined && (ws.tempDir === realRoot || ws.tempDir.startsWith(realRoot + sep));
  const ownBase = ws.tempDir === undefined || tempInsideRoot;
  const base = ownBase ? await mkdtemp(join(tmpdir(), 'ht-baserun-')) : ws.tempDir!;
  await mkdir(base, { recursive: true });
  const copyRoot = join(base, `base-${randomUUID()}`);
  const cleanup = async () => {
    await rm(copyRoot, { recursive: true, force: true }).catch(() => undefined);
    if (ownBase) await rm(base, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await copyWorkspace(ws, copyRoot);
    const kept: Array<{ path: string; change: string; sha256: string | null }> = [];
    for (const c of changes) {
      if (input.isTestFile(c.path)) {
        kept.push({ path: c.path, change: c.change, sha256: c.change === 'deleted' ? null : ((await sha256File(join(copyRoot, c.path))) ?? null) });
        continue;
      }
      const target = join(copyRoot, c.path);
      if (c.change === 'added') await rm(target, { force: true });
      else {
        const blob = await gitBlob(ws.root, input.baseCommit, c.path);
        if (blob === undefined) await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, blob);
        }
      }
    }
    const copyWs: WorkspaceHandle = { ...ws, root: copyRoot, readOnly: false, kind: 'scratch' };
    const run = await input.runner.run(copyWs, input.request, input.sandbox);
    const codeRevision: Record<string, JsonValue> = { kind: 'base', baseCommit: input.baseCommit, treeDigest: sha256Hex(canonicalJson({ baseCommit: input.baseCommit, revision: 'base', tests: kept })) };
    return { run, root: copyRoot, codeRevision, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
