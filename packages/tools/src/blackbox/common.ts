import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { HypertestError, type JsonSchema } from '@hypertest/core';
import type { EnvironmentDescriptor, EnvironmentRegistry } from '../contracts.ts';

/** Environment ids become resource-key segments (`env/<id>`): no `/`, no empty or dot segments. */
export const ENV_ID_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' };
/** Operation ids (`op_…`) become file names and resource-key segments. */
export const OPERATION_ID_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' };
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const REDACTED = '[REDACTED]';
/**
 * Path prefix of the process-supervisor control API (restart/kill/faults). It is reserved for the env.*
 * adapters: black-box probe tools (http.request, metrics.*, load.start, browser.*) never address it, so an
 * agent allowed to probe an environment can not restart, kill or fault it outside the governed env.* tools.
 */
export const CONTROL_PATH_PREFIX = '/__hypertest';
/** Header carrying the supervisor control token (capability of the env.process adapter). */
export const CONTROL_TOKEN_HEADER = 'x-hypertest-control-token';
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token']);
const SENSITIVE_NAME = /secret|token|password|passwd|api[_-]?key|session|signature|credential/i;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function assertOperationId(id: unknown, what = 'operationId'): string {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new HypertestError('invalid_argument', `${what} must match ${OPERATION_ID_RE.source}`);
  return id;
}

export function requireEnvironment(envs: EnvironmentRegistry | undefined, environmentId: string): EnvironmentDescriptor {
  if (!envs) throw new HypertestError('precondition_failed', `no environment registry is configured (environment ${environmentId})`);
  const env = envs.get(environmentId);
  if (!env) throw new HypertestError('not_found', `environment ${environmentId} is not registered`);
  return env;
}

/** Parses an absolute http(s) URL (credentials are refused: secrets never travel inside URLs). */
export function parseHttpUrl(raw: string, what = 'url'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HypertestError('invalid_argument', `${what} is not an absolute URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HypertestError('invalid_argument', `${what} must use http or https (got ${url.protocol})`);
  if (url.username !== '' || url.password !== '') throw new HypertestError('invalid_argument', `${what} must not embed credentials; pass them as headers`);
  return url;
}

/**
 * Joins a base URL (which may carry a path prefix, e.g. `http://h/api/`) with a relative request path
 * (`/users?id=1`). Only the path and query change, so the result is always on the base's origin.
 */
export function joinUrl(base: string, path: string | undefined, what = 'baseUrl'): URL {
  const b = parseHttpUrl(base, what);
  const rel = path ?? '/';
  if (!rel.startsWith('/') || rel.startsWith('//')) throw new HypertestError('invalid_argument', `path must start with a single "/" (got ${JSON.stringify(rel.slice(0, 200))})`);
  const hashAt = rel.indexOf('#');
  const noHash = hashAt >= 0 ? rel.slice(0, hashAt) : rel;
  const q = noHash.indexOf('?');
  const pathPart = q >= 0 ? noHash.slice(0, q) : noHash;
  const query = q >= 0 ? noHash.slice(q + 1) : '';
  const url = new URL(b.href);
  const prefix = b.pathname.replace(/\/+$/, '');
  url.pathname = prefix + pathPart;
  url.search = query;
  url.hash = '';
  if (url.origin !== b.origin) throw new HypertestError('invalid_argument', 'path must not change the origin of the environment URL');
  // `..` / `%2e%2e` segments are normalized by URL: the result must stay beneath the base path prefix
  if (prefix !== '' && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new HypertestError('invalid_argument', `path must stay beneath the environment base path ${prefix}`);
  }
  return url;
}

/** Hostname without IPv6 brackets, lower-cased. */
export function bareHostname(url: URL): string {
  const h = url.hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** True for localhost names and loopback addresses (127.0.0.0/8, ::1, IPv4-mapped loopback). */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = isIP(h);
  if (kind === 4) return h.startsWith('127.');
  if (kind === 6) {
    if (h === '::1' || /^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(h)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return mapped[1]!.startsWith('127.');
    const mappedHex = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.exec(h);
    return mappedHex !== null;
  }
  return false;
}

/** Resource-key segment for a URL host (`url/<host>`, `loadgen/<host>`): host[:port], lower-case. */
export function hostSegment(url: URL): string {
  return url.host.toLowerCase();
}

/**
 * Host allowlist pattern semantics: `*` any host; `*.example.com` any subdomain (not the apex);
 * `host:port` / `[v6]:port` exact host and port; anything else is an exact hostname (any port).
 */
export function hostMatches(pattern: string, url: URL): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === '') return false;
  if (p === '*') return true;
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  const bare = bareHostname(url);
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return bare.endsWith(suffix) && bare.length > suffix.length;
  }
  const hasPort = p.startsWith('[') ? p.includes(']:') : p.split(':').length === 2;
  if (hasPort) {
    if (p === host) return true;
    // an explicit default port in the pattern matches a URL that omits it
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    return url.port === '' && p === `${hostname}:${defaultPort}`;
  }
  return p === hostname || p === bare || (p.startsWith('[') && p.endsWith(']') && p.slice(1, -1) === bare);
}

export interface HostCheckInput {
  /** Operator allowlist (BlackboxToolOptions.httpAllowlist). */
  allowlist?: readonly string[] | undefined;
  /** Policy constraint (ActionPermit.constraints.allowedHosts); when present it always applies. */
  permitHosts?: readonly string[] | undefined;
  /** Environment class of the target (loopback is allowed by default only for `local`). */
  environmentClass?: string | undefined;
  /** Origins of the registered environment the request is addressed to (operator-configured, trusted). */
  trustedOrigins?: readonly string[] | undefined;
}

/**
 * Egress decision for black-box HTTP/browser tools (SSRF guard). The permit constraint is a hard upper
 * bound; within it a host is allowed when it belongs to the addressed registered environment, is on the
 * operator allowlist, or is loopback while the environment class is `local`. Everything else is denied.
 */
export function checkHost(url: URL, input: HostCheckInput): { allowed: true } | { allowed: false; reason: string } {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allowed: false, reason: `scheme ${url.protocol} is not allowed` };
  if (input.permitHosts !== undefined && !input.permitHosts.some((p) => hostMatches(p, url))) {
    return { allowed: false, reason: `host ${url.host} is outside the permit's allowedHosts constraint` };
  }
  if (input.trustedOrigins?.includes(url.origin)) return { allowed: true };
  if (input.allowlist?.some((p) => hostMatches(p, url))) return { allowed: true };
  if (isLoopbackHost(url.hostname) && input.environmentClass === 'local') return { allowed: true };
  return { allowed: false, reason: `host ${url.host} is not on the http allowlist${isLoopbackHost(url.hostname) ? ' (loopback is only allowed for environment class local)' : ''}` };
}

/**
 * A control target (`EnvironmentDescriptor.control.target` of a process environment) may carry the
 * supervisor's control token as a URL fragment (`http://h:p/__hypertest#token=…`; fragments are never sent
 * over the wire). Returns the target without the fragment and the token.
 */
export function splitControlTarget(target: string, what = 'control target'): { url: URL; token: string | undefined } {
  const url = parseHttpUrl(target, what);
  const token = url.hash.length > 1 ? (new URLSearchParams(url.hash.slice(1)).get('token') ?? undefined) : undefined;
  url.hash = '';
  return { url, token: token === '' ? undefined : token };
}

/** A control target without its token (safe to persist, hash, log or show). */
export function publicControlTarget(target: string): string {
  try {
    return splitControlTarget(target).url.href;
  } catch {
    const i = target.indexOf('#');
    return i >= 0 ? target.slice(0, i) : target;
  }
}

/**
 * Why a URL may not be addressed by a black-box probe tool, or undefined: the reserved supervisor control
 * namespace (`/__hypertest…` on any host) and the control target of every registered process environment.
 */
export function controlEndpointReason(url: URL, envs: EnvironmentRegistry | undefined): string | undefined {
  const underPrefix = (path: string, prefix: string): boolean => {
    const p = prefix.replace(/\/+$/, '');
    return p === '' || path === p || path.startsWith(`${p}/`);
  };
  if (underPrefix(url.pathname, CONTROL_PATH_PREFIX)) return `${CONTROL_PATH_PREFIX} is the reserved environment-control namespace; use the env.* tools`;
  for (const env of envs?.list() ?? []) {
    if (env.control?.kind !== 'process') continue;
    let control: URL;
    try {
      control = splitControlTarget(env.control.target).url;
    } catch {
      continue;
    }
    if (control.origin === url.origin && underPrefix(url.pathname, control.pathname)) {
      return `${url.origin}${control.pathname} is the control endpoint of environment ${env.environmentId}; use the env.* tools`;
    }
  }
  return undefined;
}

/** checkHost plus the control-endpoint guard: the full egress decision of the black-box probe tools. */
export function checkEgress(url: URL, input: HostCheckInput, envs: EnvironmentRegistry | undefined): { allowed: true } | { allowed: false; reason: string } {
  const host = checkHost(url, input);
  if (!host.allowed) return host;
  const control = controlEndpointReason(url, envs);
  return control === undefined ? host : { allowed: false, reason: control };
}

/** Origins of the URLs an environment descriptor declares (baseUrl, metricsUrl, prometheusUrl). */
export function environmentOrigins(env: EnvironmentDescriptor): string[] {
  const out: string[] = [];
  for (const u of [env.baseUrl, env.metricsUrl, env.prometheusUrl]) {
    if (!u) continue;
    try {
      out.push(new URL(u).origin);
    } catch {
      // ignore malformed descriptor URLs
    }
  }
  return out;
}

/**
 * Environment class of a raw URL: the class of the registered environment that owns its origin, else
 * `local` for loopback hosts, else undefined (the policy then decides; default rules deny effects).
 */
export function environmentClassForUrl(url: URL, envs: EnvironmentRegistry | undefined): string | undefined {
  if (envs) {
    for (const env of envs.list()) {
      if (environmentOrigins(env).includes(url.origin)) return env.environmentClass;
    }
  }
  return isLoopbackHost(url.hostname) ? 'local' : undefined;
}

/** Header map with credential-bearing values replaced (keys lower-cased). */
export function redactHeaders(headers: Iterable<[string, string]> | Record<string, string>): Record<string, string> {
  const entries: Iterable<[string, string]> = Symbol.iterator in Object(headers) ? (headers as Iterable<[string, string]>) : Object.entries(headers as Record<string, string>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    const value = SENSITIVE_HEADERS.has(key) || SENSITIVE_NAME.test(key) ? REDACTED : String(v);
    out[key] = out[key] !== undefined && value !== REDACTED ? `${out[key]}, ${value}` : value;
  }
  return out;
}

/** Deep copy of a JSON value with the values of secret-looking keys (password, token, …) replaced. */
export function redactJsonSecrets(value: unknown, depth = 0): unknown {
  if (depth > 64 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactJsonSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_NAME.test(k) || SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : redactJsonSecrets(v, depth + 1);
  return out;
}

/** URL string with secret-looking query parameter values replaced (parameter order preserved). */
export function redactUrl(url: URL): string {
  const entries = [...url.searchParams.entries()];
  if (!entries.some(([k]) => SENSITIVE_NAME.test(k))) return url.href;
  const u = new URL(url.href);
  u.search = '';
  for (const [k, v] of entries) u.searchParams.append(k, SENSITIVE_NAME.test(k) ? REDACTED : v);
  return u.href;
}

/** Replaces characters the evidence ledger refuses (NUL) so response text can be stored as JSON. */
export function storableText(s: string): string {
  return s.includes('\u0000') ? s.replaceAll('\u0000', '�') : s;
}

/** Content types whose bodies are text (decoded as UTF-8 for previews and evidence). */
export function isTextualContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('javascript') || ct.includes('x-www-form-urlencoded') || ct.includes('yaml') || ct.includes('graphql');
}

/**
 * Reads at most `maxBytes` of a fetch Response body (the rest is cancelled, never buffered). A stream
 * error (reset, timeout mid-body) keeps the bytes read so far: `truncated` + `error` describe the loss.
 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; totalRead: number; error?: unknown }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false, totalRead: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (error) {
      return { bytes: Buffer.concat(chunks), truncated: true, totalRead: size, error };
    }
    const { done, value } = step;
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated, totalRead: size };
}

/** JSON-safe number: finite numbers stay numbers, NaN/±Inf become the Prometheus spellings. */
export function jsonNumber(v: number): number | string {
  if (Number.isFinite(v)) return v;
  if (Number.isNaN(v)) return 'NaN';
  return v > 0 ? '+Inf' : '-Inf';
}

/** Finite number or null (for quantiles/aggregates where NaN means "no data"). */
export function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

// ----------------------------------------------------------------------------- files and processes

/** Writes JSON atomically (tmp file + rename), so readers never observe a partial document. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

export type JsonFileRead<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'corrupt'; error: string };

export async function readJsonFile<T>(path: string): Promise<JsonFileRead<T>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', error: errorMessage(e) };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as T };
  } catch (e) {
    return { kind: 'corrupt', error: `invalid JSON: ${errorMessage(e)}` };
  }
}

export function readJsonFileSync<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Liveness of a pid: `dead` when it does not exist or is a zombie, or (when `cmdlineMarker` is given and
 * /proc is readable) when the pid was reused by a process none of whose arguments ends with the marker.
 */
export function pidState(pid: number, cmdlineMarker?: string): 'alive' | 'dead' {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return 'dead';
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z') return 'dead';
  } catch {
    // no /proc (non-Linux) or a race with exit: fall through to the kill(0) answer
  }
  if (cmdlineMarker !== undefined) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmdline.split('\0').some((arg) => arg.endsWith(cmdlineMarker))) return 'dead';
    } catch {
      // unreadable: trust kill(0)
    }
  }
  return 'alive';
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be started (e.g. ENOENT). */
  spawnError?: string;
  timedOut: boolean;
}

/** Runs a binary without a shell (argv only), bounded by a timeout and an abort signal. */
export function runCommand(file: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; maxBuffer?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const execOptions: Parameters<typeof execFile>[2] = { timeout: options.timeoutMs, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true, killSignal: 'SIGKILL' };
    if (options.signal) execOptions.signal = options.signal;
    if (options.env) execOptions.env = options.env;
    execFile(file, [...args], execOptions, (error, stdout, stderr) => {
      const out = String(stdout ?? '');
      const err = String(stderr ?? '');
      if (!error) return resolve({ exitCode: 0, stdout: out, stderr: err, timedOut: false });
      const e = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
      if (typeof e.code === 'string' && (e.code === 'ENOENT' || e.code === 'EACCES')) {
        return resolve({ exitCode: 127, stdout: out, stderr: err || e.message, spawnError: e.code, timedOut: false });
      }
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return resolve({ exitCode: null, stdout: out, stderr: err || 'aborted', timedOut: false, spawnError: 'ABORTED' });
      const timedOut = e.killed === true && e.signal === 'SIGKILL' && typeof e.code !== 'number';
      resolve({ exitCode: typeof e.code === 'number' ? e.code : null, stdout: out, stderr: err || e.message, timedOut });
    });
  });
}
