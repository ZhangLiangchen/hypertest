import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HypertestError } from '@hypertest/core';
import type { ProcessResult, TestCaseResult, TestCaseStatus, TestRunResult, WorkspaceHandle } from '../../contracts.ts';

export const CASE_STATUSES: readonly TestCaseStatus[] = ['passed', 'failed', 'skipped', 'xfail', 'xpass', 'error'];

export function totalsOf(cases: readonly TestCaseResult[]): TestRunResult['totals'] {
  const t = { passed: 0, failed: 0, skipped: 0, xfail: 0, xpass: 0, error: 0, total: cases.length };
  for (const c of cases) t[c.status]++;
  return t;
}

/**
 * Builds a TestRunResult. `passed` (fake-green guard) is true only when: no harness error, exit code 0,
 * at least one case ran and actually passed, and no case failed/errored/xpassed. Skipped and xfail cases
 * do not fail the run but never count as a pass on their own.
 */
export function buildResult(input: { framework: string; command: string[]; exitCode: number | null; cases: TestCaseResult[]; durationMs: number; harnessError?: string | undefined }): TestRunResult {
  const totals = totalsOf(input.cases);
  const passed = input.harnessError === undefined && input.exitCode === 0 && totals.total > 0 && totals.passed > 0 && totals.failed === 0 && totals.error === 0 && totals.xpass === 0;
  const r: TestRunResult = { framework: input.framework, command: input.command, exitCode: input.exitCode, totals, cases: input.cases, passed, durationMs: input.durationMs };
  if (input.harnessError !== undefined) r.harnessError = input.harnessError;
  return r;
}

/** Harness-level problem of the process itself (timeout, could not start, killed), if any. */
export function processHarnessError(p: ProcessResult, what: string): string | undefined {
  if (p.spawnError) return `${what} could not be started: ${p.spawnError}`;
  if (p.timedOut) return `${what} timed out after ${Math.round(p.durationMs)}ms`;
  if (p.exitCode === null) return `${what} was killed by ${p.signal ?? 'a signal'}`;
  return undefined;
}

export function tail(s: string, max = 2000): string {
  return s.length <= max ? s : '…' + s.slice(s.length - max);
}

/** A private report file path OUTSIDE the workspace root (workspace tempDir, else the OS temp dir). */
export async function reportPath(ws: WorkspaceHandle, name: string): Promise<string> {
  const dir = ws.tempDir ? join(ws.tempDir, 'reports') : join(tmpdir(), 'ht-reports');
  await mkdir(dir, { recursive: true });
  return join(dir, `${randomUUID()}-${name}`);
}

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function readPackageJson(root: string): Promise<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined> {
  const text = await readIfExists(join(root, 'package.json'));
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as { scripts?: Record<string, string> }) : undefined;
  } catch {
    return undefined;
  }
}

export function hasDependency(pkg: Awaited<ReturnType<typeof readPackageJson>>, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]) || Boolean(pkg.scripts?.['test']?.includes(name));
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'vendor', '__pycache__', '.venv', 'venv', 'dist', 'build', 'coverage', '.pytest_cache']);

/** True when some file (relative POSIX path) within `maxDepth` matches the predicate. Bounded walk. */
export async function anyFile(root: string, predicate: (rel: string, name: string) => boolean, maxDepth = 4, maxEntries = 20_000): Promise<boolean> {
  let seen = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<boolean> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const d of names) {
      if (++seen > maxEntries) return false;
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        if (depth < maxDepth && (await walk(join(dir, d.name), r, depth + 1))) return true;
      } else if (d.isFile() && predicate(r, d.name)) return true;
    }
    return false;
  };
  return walk(root, '', 0);
}

/** Splits `file::pattern` selectors. */
export function splitSelector(selector: string | undefined): { file?: string; pattern?: string } {
  if (selector === undefined || selector.trim() === '') return {};
  const i = selector.indexOf('::');
  if (i >= 0) {
    const file = selector.slice(0, i).trim();
    const pattern = selector.slice(i + 2).trim();
    const out: { file?: string; pattern?: string } = {};
    if (file) out.file = file;
    if (pattern) out.pattern = pattern;
    return out;
  }
  return { pattern: selector.trim() };
}

export function looksLikePath(s: string): boolean {
  return s.includes('/') || /\.(m|c)?[jt]sx?$|\.py$|\.go$/.test(s);
}

/** Rejects selector parts that the runner CLI would parse as options (argument injection). */
export function assertSafeSelector(selector: string | undefined): void {
  if (selector === undefined) return;
  for (const part of selector.split('::')) {
    if (part.trim().startsWith('-')) throw new HypertestError('invalid_argument', `test selector must not start with "-": ${JSON.stringify(selector)}`);
  }
  if (selector.includes('\0')) throw new HypertestError('invalid_argument', 'test selector must not contain NUL');
}
