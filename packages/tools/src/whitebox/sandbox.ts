import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { HypertestError } from '@hypertest/core';
import type { EgressEndpointPolicy, EgressWritePolicy, LocalSandboxOptions, OciSandboxOptions, ProcessResult, SandboxProfile, SandboxRunner, WorkspaceHandle } from '../contracts.ts';
import { DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES, spawnProcess } from './process.ts';
import { confineExisting } from './paths.ts';
import { networkIsolation, resolveProgram, type IsolationSpec, type NetworkIsolation } from './netns.ts';
import { createEgressHttpServer, currentEgressContext, type EgressCallContext } from './egress-relay.ts';

/** Variables every sandboxed process gets regardless of the allowlist (values chosen by the sandbox). */
export const SANDBOX_BASE_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

/**
 * Marker every sandboxed process gets (value: the sandbox kind, `local` | `oci`), set LAST so neither the profile's
 * allowlist nor the caller's `env` can remove or spoof it. Programs that must never act for a sandboxed agent check it —
 * e.g. the CLI refuses human decisions (`approve`, `oracle decide`) under `$HYPERTEST_SANDBOX`.
 */
export const SANDBOX_MARKER_ENV = 'HYPERTEST_SANDBOX';

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
 * `env` (runner-trusted, never agent input), then `HYPERTEST_SANDBOX=local`. The parent's secrets are never inherited.
 * Detached process group; timeout ⇒ SIGTERM to the group then SIGKILL after `killGraceMs`; abort honoured;
 * stdout/stderr captured up to `maxOutputBytes` each with truncation flags.
 *
 * Isolation (security-2, H1): unless the workspace's profile says `network: 'open'`, the command runs in fresh user +
 * network namespaces with nothing but its own loopback (`netns.ts`; the local analogue of the OCI sandbox's
 * `--network none`): no egress, no host services. Where the host supports the jail strategy it also gets PID + mount
 * namespaces: a fresh `/proc` (the Hypertest process is invisible), `hiddenPaths` hidden and every other workspace of
 * `workspacesDir` hidden. A host that cannot isolate the network refuses such profiles (`precondition_failed`) —
 * never a silent downgrade to the open network.
 *
 * NOT a complete file-system boundary: the command runs as the same uid and sees the host file system except what the
 * jail hides. Agent argv is confined by the tools (`argumentPathDenial`: no `..` escapes, no absolute paths outside
 * the workspace) as defence in depth; untrusted execution needs the OCI sandbox.
 */
export function createLocalSandbox(options: LocalSandboxOptions = {}): SandboxRunner {
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const defaultMax = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const isolation = (): Promise<NetworkIsolation> => networkIsolation(options.networkIsolation ?? {});
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
      const cleanups: Array<() => Promise<void>> = [];
      try {
        const env: Record<string, string> = {
          ...allowlistedEnv(ws.sandbox),
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          LANG: process.env['LANG'] ?? 'C.UTF-8',
          TMPDIR: tmp,
          ...(opts.env ?? {}),
          [SANDBOX_MARKER_ENV]: 'local',
        };
        let argv = command;
        const network = ws.sandbox?.network;
        // E[4]: paths this sandbox must hide (keys, capability secret, store) are hidden only by the jail strategy; a command
        // that would see them runs only when its owner explicitly accepted that (allowUnhiddenPaths) — never silently
        const mustHide = (options.hiddenPaths?.length ?? 0) > 0 && options.allowUnhiddenPaths !== true;
        if (mustHide && network === 'open') {
          throw new HypertestError('precondition_failed', `the local sandbox cannot hide ${options.hiddenPaths!.join(', ')} from a command with an open network (no namespaces): refused (fail closed)`, {
            details: { workspaceId: ws.workspaceId, network },
          });
        }
        if (network !== 'open') {
          // fail closed: every profile but an explicitly open network (and a workspace without a profile) is isolated
          const iso = await isolation();
          if (iso.available && !iso.jail && mustHide) {
            throw new HypertestError('precondition_failed', `the local sandbox cannot hide ${options.hiddenPaths!.join(', ')} from commands on this host (strategy ${iso.strategy} has no PID/mount jail): refused (fail closed)`, {
              details: { workspaceId: ws.workspaceId, strategy: iso.strategy },
            });
          }
          if (!iso.available) {
            throw new HypertestError(
              'precondition_failed',
              `the local sandbox cannot enforce network '${network ?? 'none'}' for workspace ${ws.workspaceId}: ${iso.reason}. Use the OCI sandbox, or set the sandbox profile's network to 'open' to accept an unrestricted network explicitly`,
              { details: { workspaceId: ws.workspaceId, network: network ?? null } },
            );
          }
          if (Array.isArray(command) && command.length > 0 && typeof command[0] === 'string') {
            // a program that cannot be started is reported like an unwrapped spawn (exit 127 + spawnError), without
            // ever starting it outside the namespace
            if (!resolveProgram(command[0], env['PATH'], cwd)) return notStarted(command[0]);
            const spec = isolationSpec(ws, cwd, options);
            // allowlisted egress (the SUT's loopback endpoints) for every profile but `none` — jail strategy only
            if (network !== 'none' && network !== undefined && iso.jail && options.egress) {
              const endpoints = loopbackEndpointPolicies(await options.egress(ws));
              if (endpoints.length > 0) {
                // E[2]: HTTP-aware relays — safe methods pass, writes are ledgered (or refused), raw traffic refused unless
                // the environment allows it; the tool call the command runs for is captured now
                const fw = await startEgressForwarders(endpoints, options.egressWrites ?? 'ledger', currentEgressContext());
                cleanups.push(fw.close);
                spec.egress = fw.list;
              }
            }
            argv = iso.wrap(command, spec);
          }
        }
        const req: Parameters<typeof spawnProcess>[0] = { argv, cwd, env, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: opts.maxOutputBytes ?? defaultMax, killGraceMs: grace };
        if (opts.stdin !== undefined) req.stdin = opts.stdin;
        return await spawnProcess(req);
      } finally {
        for (const c of cleanups) await c().catch(() => undefined);
        await cleanup();
      }
    },
  };
}

/** A loopback endpoint a namespace can be given: bound inside at `bind:port`, served outside by `host:port`. */
interface LoopbackEndpoint {
  bind: string;
  host: string;
  port: number;
}

/**
 * The loopback endpoints among `origins` (`http(s)://host:port` of the registered environments and the operator
 * allowlist): only this host's loopback can be relayed into a namespace; any other host stays unreachable.
 */
export function loopbackEndpoints(origins: readonly string[]): LoopbackEndpoint[] {
  return loopbackEndpointPolicies(origins).map(({ bind, host, port }) => ({ bind, host, port }));
}

/** (E[2]) loopbackEndpoints with each endpoint's egress policy (a plain origin string: HTTP-aware, no raw traffic). */
export function loopbackEndpointPolicies(origins: readonly (string | EgressEndpointPolicy)[]): Array<LoopbackEndpoint & { policy: EgressEndpointPolicy }> {
  const out: Array<LoopbackEndpoint & { policy: EgressEndpointPolicy }> = [];
  const add = (e: LoopbackEndpoint & { policy: EgressEndpointPolicy }) => {
    if (!out.some((o) => o.bind === e.bind && o.port === e.port)) out.push(e);
  };
  for (const entry of origins) {
    const policy: EgressEndpointPolicy = typeof entry === 'string' ? { origin: entry } : entry;
    let url: URL;
    try {
      url = new URL(policy.origin);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost') {
      add({ bind: '127.0.0.1', host: '127.0.0.1', port, policy });
      add({ bind: '::1', host: '::1', port, policy });
    } else if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '::1') {
      add({ bind: host, host, port, policy });
    }
  }
  return out;
}

/**
 * Serves each endpoint on a unix socket (a short private directory under the system temp dir, visible inside the jail).
 * (E[2]) An HTTP-aware relay (createEgressHttpServer: safe methods forwarded, writes ledgered or refused, non-HTTP traffic
 * refused); only an endpoint whose policy allows `raw` traffic gets a byte relay to the real endpoint. `close()` stops
 * the servers and their connections.
 */
async function startEgressForwarders(
  endpoints: ReadonlyArray<LoopbackEndpoint & { policy: EgressEndpointPolicy }>,
  writes: EgressWritePolicy,
  call: EgressCallContext | undefined,
): Promise<{ list: Array<{ host: string; port: number; socket: string }>; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'hte-'));
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const list: Array<{ host: string; port: number; socket: string }> = [];
  try {
    for (const [i, e] of endpoints.entries()) {
      const path = join(dir, `${i}.sock`);
      if (e.policy.raw !== true) {
        const http = createEgressHttpServer(e, writes, call);
        http.on('connection', (s: Socket) => {
          sockets.add(s);
          s.once('close', () => sockets.delete(s));
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          http.once('error', rejectListen);
          http.listen(path, () => resolveListen());
        });
        servers.push(http as unknown as Server);
        list.push({ host: e.bind, port: e.port, socket: path });
        continue;
      }
      const server = createServer((inner) => {
        const outer = connect({ host: e.host, port: e.port });
        for (const s of [inner, outer]) {
          sockets.add(s);
          s.once('close', () => sockets.delete(s));
          s.on('error', () => {
            inner.destroy();
            outer.destroy();
          });
        }
        inner.pipe(outer);
        outer.pipe(inner);
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(path, () => resolveListen());
      });
      servers.push(server);
      list.push({ host: e.bind, port: e.port, socket: path });
    }
  } catch (e) {
    for (const s of servers) s.close();
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    list,
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * What the jail hides from one command (H1): the configured `hiddenPaths` (secrets, the store) and every workspace but
 * the command's own. A hidden path that contains the command's workspace is a configuration error.
 */
function isolationSpec(ws: WorkspaceHandle, cwd: string, options: LocalSandboxOptions): IsolationSpec {
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const hide = (options.hiddenPaths ?? []).map((p) => resolve(p));
  for (const h of hide) {
    for (const p of [ws.root, ws.tempDir]) {
      if (p !== undefined && inside(resolve(p), h)) {
        throw new HypertestError('precondition_failed', `sandbox hidden path ${h} contains workspace path ${p}: nothing could run there`, { details: { workspaceId: ws.workspaceId, hiddenPath: h } });
      }
    }
  }
  const spec: IsolationSpec = { cwd, hide };
  if (options.workspacesDir !== undefined) spec.privateDir = { dir: resolve(options.workspacesDir), keep: [ws.root, ...(ws.tempDir ? [ws.tempDir] : [])] };
  return spec;
}

/** The result of a command whose program does not exist (what `spawnProcess` reports for a failed spawn). */
function notStarted(program: string): ProcessResult {
  const code = program.includes('/') && existsSync(program) ? 'EACCES' : 'ENOENT';
  return { exitCode: 127, signal: null, stdout: '', stderr: `failed to start ${program}: spawn ${program} ${code}`, durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, spawnError: code };
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
        [SANDBOX_MARKER_ENV]: 'oci',
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
