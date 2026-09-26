import { execFile } from 'node:child_process';
import { HypertestError } from '@hypertest/core';

/**
 * Config overrides applied to every git invocation Hypertest makes (workspace manager and git.* tools):
 * repository config can otherwise execute arbitrary programs (fsmonitor, hooks, external diff, pager).
 */
export const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'protocol.allow=never'] as const;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Parent variables trusted host-side git may see. Repository config (filters, textconv drivers …) can run
 * programs, and the agent can influence which ones run (`.gitattributes`); such programs must never inherit
 * the orchestrator's secrets (API keys, database URLs), so everything else is dropped. Proxy/CA settings
 * stay (checkout filters such as git-lfs may need the network).
 */
export const TRUSTED_GIT_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_EXEC_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
] as const;

/** Minimal environment for trusted git (see TRUSTED_GIT_ENV_KEYS) plus non-interactive defaults. */
export function trustedGitEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of TRUSTED_GIT_ENV_KEYS) {
    const v = parent[k];
    if (typeof v === 'string') env[k] = v;
  }
  env['PATH'] ??= '/usr/local/bin:/usr/bin:/bin';
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

/** Trusted git execution for the WorkspaceManager (not agent-controlled argv). Never throws on exit≠0 unless `check`. */
export function gitRun(cwd: string, args: string[], options: { check?: boolean; allowCodes?: number[]; env?: Record<string, string> } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...SAFE_GIT_CONFIG, ...args],
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...trustedGitEnv(), ...(options.env ?? {}) },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : 1) : 0;
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          return reject(new HypertestError('unavailable', `git could not be started: ${error.message}`, { cause: error }));
        }
        const ok = code === 0 || (options.allowCodes ?? []).includes(code);
        if (!ok && options.check !== false) {
          return reject(new HypertestError('precondition_failed', `git ${args.join(' ')} failed (${code}): ${String(stderr).trim() || String(stdout).trim()}`, { details: { code, args } }));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const r = await gitRun(path, ['rev-parse', '--is-inside-work-tree'], { check: false });
    return r.code === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Resolves a revision to a full commit sha (precondition_failed when unknown). */
export async function resolveCommit(repo: string, rev: string): Promise<string> {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new HypertestError('invalid_argument', `invalid revision ${JSON.stringify(rev)}`);
  const r = await gitRun(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { check: false });
  if (r.code !== 0) throw new HypertestError('precondition_failed', `unknown commit ${rev} in ${repo}`);
  return r.stdout.trim();
}
