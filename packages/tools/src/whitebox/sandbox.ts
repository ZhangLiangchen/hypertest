import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { HypertestError } from '@hypertest/core';
import type { LocalSandboxOptions, OciSandboxOptions, ProcessResult, SandboxProfile, SandboxRunner, WorkspaceHandle } from '../contracts.ts';
import { DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES, spawnProcess } from './process.ts';
import { confineExisting } from './paths.ts';

/** Variables every sandboxed process gets regardless of the allowlist (values chosen by the sandbox). */
export const SANDBOX_BASE_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

type RunOptions = Parameters<SandboxRunner['run']>[2];

/** Allowlisted variables from the parent environment (never anything else). */
export function allowlistedEnv(profile: SandboxProfile, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of profile.envAllowlist ?? []) {
    const v = parent[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

/** Resolves the working directory inside the workspace root (relative only; realpath-confined). */
export async function sandboxCwd(ws: WorkspaceHandle, cwd: string | undefined): Promise<string> {
  if (cwd === undefined || cwd === '' || cwd === '.') return confineExisting(ws.root, '.');
  return confineExisting(ws.root, cwd);
}

async function privateHome(ws: WorkspaceHandle): Promise<{ home: string; tmp: string; cleanup: () => Promise<void> }> {
  if (ws.tempDir) {
    const home = join(ws.tempDir, 'home');
    const tmp = join(ws.tempDir, 'tmp');
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    return { home, tmp, cleanup: async () => undefined };
  }
  const base = await mkdtemp(join(tmpdir(), 'ht-sandbox-'));
  const home = join(base, 'home');
  const tmp = join(base, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  return { home, tmp, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/**
 * Local process sandbox: argv (no shell), cwd confined to the workspace root, environment = the profile's
 * allowlisted parent variables + PATH, HOME (a private temp home), LANG, TMPDIR, then the caller's explicit
 * `env` (runner-trusted, never agent input). The parent's secrets are never inherited. Detached process
 * group; timeout ⇒ SIGTERM to the group then SIGKILL after `killGraceMs`; abort honoured; stdout/stderr
 * captured up to `maxOutputBytes` each with truncation flags.
 */
export function createLocalSandbox(options: LocalSandboxOptions = {}): SandboxRunner {
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const defaultMax = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    kind: 'local',
    async available() {
      return true;
    },
    async run(ws: WorkspaceHandle, command: string[], opts: RunOptions): Promise<ProcessResult> {
      // never a silent isolation downgrade: a workspace whose profile demands a container is not run as a
      // plain host process
      if (ws.sandbox?.kind === 'oci') {
        throw new HypertestError('precondition_failed', `workspace ${ws.workspaceId} requires the OCI sandbox (profile kind 'oci'); the local sandbox cannot provide it`);
      }
      const cwd = await sandboxCwd(ws, opts.cwd);
      const { home, tmp, cleanup } = await privateHome(ws);
      try {
        const env: Record<string, string> = {
          ...allowlistedEnv(ws.sandbox),
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          LANG: process.env['LANG'] ?? 'C.UTF-8',
          TMPDIR: tmp,
          ...(opts.env ?? {}),
        };
        const req: Parameters<typeof spawnProcess>[0] = { argv: command, cwd, env, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: opts.maxOutputBytes ?? defaultMax, killGraceMs: grace };
        if (opts.stdin !== undefined) req.stdin = opts.stdin;
        return await spawnProcess(req);
      } finally {
        await cleanup();
      }
    },
  };
}

/** Docker `--network` for a profile. Egress allowlists cannot be enforced by plain docker ⇒ `none` (fail closed). */
export function dockerNetwork(profile: SandboxProfile): string {
  switch (profile.network) {
    case 'open':
      return 'bridge';
    case 'none':
    case 'loopback':
    case 'egress_allowlist':
    default:
      return 'none';
  }
}

/** Docker CLI settings taken from the parent (the CLI's own configuration, never forwarded into the container). */
export const DOCKER_CLI_ENV_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION'] as const;

/** Container variables minus names the docker CLI would interpret itself (`DOCKER_*`). */
export function dockerContainerEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('DOCKER_')));
}

/**
 * Environment of the `docker` CLI process: PATH, the parent's docker settings (`DOCKER_HOST`, contexts, TLS)
 * and `DOCKER_CONFIG` pinned to the parent's config dir — the container values (passed by name with
 * `--env NAME`) include HOME, which must not relocate the CLI's own configuration. No other parent
 * variable is inherited.
 */
export function dockerCliEnv(container: Record<string, string>, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = parent['HOME'] ?? tmpdir();
  const env: Record<string, string> = { ...dockerContainerEnv(container) };
  env['PATH'] = parent['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  env['DOCKER_CONFIG'] = parent['DOCKER_CONFIG'] ?? join(home, '.docker');
  for (const k of DOCKER_CLI_ENV_KEYS) {
    const v = parent[k];
    if (typeof v === 'string') env[k] = v;
  }
  env['HOME'] ??= home;
  return env;
}

function currentUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  return `${uid}:${gid}`;
}

/**
 * Builds the `docker run` argv (pure; exported for tests). The workspace root is mounted at /workspace
 * (read-only for read-only workspaces); the workspace tempDir is mounted at its own absolute path so report
 * files written there by runners are visible to the host. Environment variables are passed by NAME
 * (`--env K`); the caller puts their values into the docker CLI's environment.
 */
export function buildDockerArgs(input: {
  docker: string;
  image: string;
  name: string;
  ws: WorkspaceHandle;
  cwdRel: string;
  env: Record<string, string>;
  user: string;
  command: string[];
  interactive: boolean;
}): string[] {
  const { ws } = input;
  const args = [input.docker, 'run', '--rm', '--name', input.name, '--network', dockerNetwork(ws.sandbox)];
  if (input.interactive) args.push('-i');
  args.push('-v', `${ws.root}:/workspace${ws.readOnly ? ':ro' : ''}`);
  if (ws.tempDir) args.push('-v', `${ws.tempDir}:${ws.tempDir}`);
  const wd = input.cwdRel === '' ? '/workspace' : `/workspace/${input.cwdRel.split(sep).join('/')}`;
  args.push('-w', wd, '--user', input.user);
  if (ws.sandbox.cpuLimit !== undefined) args.push('--cpus', String(ws.sandbox.cpuLimit));
  if (ws.sandbox.memoryMb !== undefined) args.push('--memory', `${ws.sandbox.memoryMb}m`);
  args.push('--security-opt', 'no-new-privileges', '--cap-drop', 'ALL');
  // names only: values travel in the docker CLI's environment, never in argv (visible in `ps`)
  for (const k of Object.keys(input.env).sort()) args.push('--env', k);
  args.push(ws.sandbox.image ?? input.image, ...input.command);
  return args;
}

/**
 * OCI sandbox via the docker CLI. `available()` probes `docker info`; callers (and tests) must check it
 * and skip with a reason when the daemon is unreachable. Timeout/abort also `docker kill`s the container
 * (killing the CLI client alone would leave it running).
 */
export function createOciSandbox(options: OciSandboxOptions): SandboxRunner {
  if (!options || typeof options.image !== 'string' || options.image === '') throw new HypertestError('invalid_argument', 'createOciSandbox requires an image');
  const docker = options.docker ?? 'docker';
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const defaultMax = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    kind: 'oci',
    async available() {
      try {
        const r = await spawnProcess({ argv: [docker, 'info', '--format', '{{.ServerVersion}}'], cwd: tmpdir(), env: dockerCliEnv({}), timeoutMs: 10_000, signal: new AbortController().signal, killGraceMs: 500 });
        return r.exitCode === 0 && r.stdout.trim().length > 0;
      } catch {
        return false;
      }
    },
    async run(ws, command, opts) {
      if (!Array.isArray(command) || command.length === 0) throw new HypertestError('invalid_argument', 'command must be a non-empty array of strings');
      const cwd = await sandboxCwd(ws, opts.cwd);
      const cwdRel = relative(await confineExisting(ws.root, '.'), cwd);
      if (ws.tempDir) {
        await mkdir(join(ws.tempDir, 'home'), { recursive: true });
        await mkdir(join(ws.tempDir, 'tmp'), { recursive: true });
      }
      const env = dockerContainerEnv({
        ...allowlistedEnv(ws.sandbox),
        HOME: ws.tempDir ? join(ws.tempDir, 'home') : '/tmp',
        TMPDIR: ws.tempDir ? join(ws.tempDir, 'tmp') : '/tmp',
        LANG: 'C.UTF-8',
        ...(opts.env ?? {}),
      });
      const name = `ht-${randomUUID()}`;
      const argv = buildDockerArgs({ docker, image: options.image, name, ws, cwdRel, env, user: options.user ?? currentUser(), command, interactive: opts.stdin !== undefined });
      const req: Parameters<typeof spawnProcess>[0] = {
        argv,
        cwd: tmpdir(),
        env: dockerCliEnv(env),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        maxOutputBytes: opts.maxOutputBytes ?? defaultMax,
        killGraceMs: grace,
        onTerminate: () => {
          const k = spawn(docker, ['kill', name], { stdio: 'ignore', detached: false, env: dockerCliEnv({}) });
          k.on('error', () => undefined);
          k.unref();
        },
      };
      if (opts.stdin !== undefined) req.stdin = opts.stdin;
      return spawnProcess(req);
    },
  };
}
