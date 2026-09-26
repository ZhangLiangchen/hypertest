import { dirname } from 'node:path';
import { HypertestError, type JsonSchema } from '@hypertest/core';
import type { ProcessResult, SandboxRunner, ToolContext, WorkspaceHandle } from '../../contracts.ts';
import { SAFE_GIT_CONFIG } from '../git-exec.ts';
import { workspaceResource } from '../paths.ts';

export const PATH_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 4096 };
export const OPT_PATH_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 4096 };
/** Git revision: no leading `-` (option injection), conservative character set. */
export const REV_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_./~^@{}][A-Za-z0-9_./~^@{}:+-]*$' };

export function pathResource(ctx: Pick<ToolContext, 'workspace'>, path: string | undefined): string {
  return workspaceResource(ctx.workspace, path);
}

export function rootResource(ctx: Pick<ToolContext, 'workspace'>): string {
  return ctx.workspace.resourcePrefix;
}

export function ensureWritable(ws: WorkspaceHandle, tool: string): void {
  if (ws.readOnly) throw new HypertestError('permission_denied', `${tool}: workspace ${ws.workspaceId} (${ws.kind}) is read-only; mutating tools need an isolated worktree or scratch workspace`);
}

/**
 * Git metadata is never read or written through the fs.* tools: rewriting a worktree's `.git` pointer (or
 * anything under a `.git` directory) would redirect git.commit onto another repository/branch and make
 * trusted host-side git read attacker-controlled config. Matched per path segment, case-insensitively
 * (case-insensitive filesystems resolve `.GIT` to `.git`). Git metadata is reached via the git.* tools.
 */
export function assertNotGitMetadata(relPath: string, tool: string): void {
  const segments = String(relPath).replaceAll('\\', '/').split('/');
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new HypertestError('permission_denied', `${tool}: ${relPath} is git metadata; use the git.* tools instead`);
  }
}

export function assertRev(rev: string, what = 'revision'): void {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-') || !/^[A-Za-z0-9_./~^@{}][A-Za-z0-9_./~^@{}:+-]*$/.test(rev)) {
    throw new HypertestError('invalid_argument', `invalid ${what} ${JSON.stringify(rev)}`);
  }
}

/** Runs git inside the sandbox with hardened config; exit codes outside `allowCodes` (default [0]) throw precondition_failed. */
export async function sandboxGit(
  sandbox: SandboxRunner,
  ctx: Pick<ToolContext, 'workspace' | 'signal'>,
  args: string[],
  options: { allowCodes?: number[]; stdin?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ProcessResult> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
  // A scratch directory is not a repository: git must not discover an enclosing one (e.g. a baseDir inside
  // the target repo), which would expose history/files outside the workspace and re-root git apply paths.
  if (ctx.workspace.kind === 'scratch') env['GIT_CEILING_DIRECTORIES'] = dirname(ctx.workspace.root);
  const runOpts: Parameters<SandboxRunner['run']>[2] = {
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: ctx.signal,
    env: { ...env, ...(options.env ?? {}) },
  };
  if (options.stdin !== undefined) runOpts.stdin = options.stdin;
  if (options.maxOutputBytes !== undefined) runOpts.maxOutputBytes = options.maxOutputBytes;
  const r = await sandbox.run(ctx.workspace, ['git', '--no-pager', ...SAFE_GIT_CONFIG, ...args], runOpts);
  if (r.spawnError) throw new HypertestError('unavailable', `git is not available in the sandbox: ${r.spawnError}`);
  if (r.timedOut) throw new HypertestError('timeout', `git ${args[0]} timed out`);
  const allowed = options.allowCodes ?? [0];
  if (r.exitCode === null || !allowed.includes(r.exitCode)) {
    throw new HypertestError('precondition_failed', `git ${args[0]} failed (${r.exitCode ?? r.signal}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r;
}

export function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
