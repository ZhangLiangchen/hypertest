import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { HypertestError, noopLogger, sleep, type Logger } from '@hypertest/core';
import { CONTROL_PATH_PREFIX, CONTROL_TOKEN_HEADER, errorMessage } from './common.ts';
import { CONTROL_TOKEN_AUDIENCE, verifyJwtHs256 } from './secrets.ts';

/**
 * A tiny reusable process supervisor for local black-box environments (tests and PoC fixtures).
 *
 * It owns ONE child process (the system under test) and one HTTP listener that serves two things:
 *  - the control API under `/__hypertest` (`controlUrl` is the `EnvironmentDescriptor.control.target` of a
 *    `process` env):
 *      GET    /__hypertest/status
 *      POST   /__hypertest/restart            header `X-Hypertest-Operation: <operationId>`, body {env?, kind?, buildRef?, desiredStateHash?}
 *      POST   /__hypertest/faults             header `X-Hypertest-Operation`, body {kind, params, durationMs, desiredStateHash?}
 *      DELETE /__hypertest/faults
 *      POST   /__hypertest/kill               (crash simulation: SIGKILL the child)
 *      GET    /__hypertest/operations/<operationId>   → 404 | the operation record
 *    Restarts and faults are idempotent per operation id (a repeated request returns the recorded
 *    operation, it never restarts twice). The mutating endpoints (POST/DELETE) require the header
 *    `X-Hypertest-Control-Token: <controlToken>` (401 otherwise): the control API shares its port with the
 *    SUT proxy, so without the token any client of the SUT — including a probe tool — could restart, kill
 *    or fault it outside the governed env.* tools. `controlUrl` carries the token in its fragment
 *    (`…/__hypertest#token=…`, never sent over the wire); the env.process adapter moves it into the header.
 *    Treat `controlUrl` as a secret (it belongs in the environment registry, not in prompts).
 *  - a reverse proxy for every other path to the child (`PORT` env var = the child's private port). Fault
 *    injection lives in the proxy, so it works for any child: `latency` {ms, jitterMs?, probability?} and
 *    `error_rate` {rate, status?} for `durationMs`.
 */

export const SUPERVISOR_CONTROL_PREFIX = CONTROL_PATH_PREFIX;
/**
 * Absolute path of `process-supervisor-cli.ts`: runs the supervisor as its own process (`node <path> [options] -- <cmd…>`),
 * so the environment neither dies with nor shares an event loop with the process that launched it (e.g. an eval harness
 * running Hypertest in-process: the SUT's latency must not depend on the load of the system under evaluation).
 */
export const PROCESS_SUPERVISOR_CLI_PATH: string = fileURLToPath(new URL('./process-supervisor-cli.ts', import.meta.url));
export const OPERATION_HEADER = 'x-hypertest-operation';
/**
 * (E[0]) `X-Hypertest-Fence: <fencing token>` of the gateway's lease on this environment: the supervisor (a fenced target)
 * accepts a mutating request only when its token is ≥ the highest token it accepted before (412 otherwise) — a stale worker
 * that wakes up after another one was granted the environment is refused by the target itself.
 */
export const FENCE_HEADER = 'x-hypertest-fence';
export { CONTROL_TOKEN_HEADER };
const CONTROL_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export type SupervisorFaultKind = 'latency' | 'error_rate';

export interface SupervisorFault {
  kind: SupervisorFaultKind;
  params: Record<string, number>;
}

export interface SupervisorOperation {
  operationId: string;
  kind: 'restart' | 'deploy' | 'fault';
  /** restart/deploy: running | completed | failed. fault: active | expired | cleared. */
  state: 'running' | 'completed' | 'failed' | 'active' | 'expired' | 'cleared';
  requestedAt: string;
  completedAt?: string;
  desiredStateHash?: string;
  restartId?: string;
  /** Supervisor generation after the restart (1 = first start). */
  generation?: number;
  pid?: number;
  buildRef?: string;
  faultId?: string;
  fault?: SupervisorFault;
  expiresAt?: string;
  error?: string;
}

export interface ProcessSupervisorOptions {
  /** argv of the child; it must listen on the port given in `portEnv` (default `PORT`). */
  command: string[];
  cwd?: string;
  /** Extra child environment (merged over process.env unless inheritEnv is false). */
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Public port of the proxy + control API (0 / undefined = ephemeral). */
  port?: number;
  host?: string;
  portEnv?: string;
  readyTimeoutMs?: number;
  killGraceMs?: number;
  /** Environment keys a restart/deploy request may override (default ['BUILD_REF']). */
  allowedEnvOverrides?: string[];
  /** Append child stdout/stderr here (default: discarded). */
  logFile?: string;
  /** Persist operation records here so lookups survive a supervisor restart. */
  stateFile?: string;
  /** Control token (`[A-Za-z0-9_-]{16,256}`) required by the mutating control endpoints; default: random. */
  controlToken?: string;
  logger?: Logger;
}

export interface ProcessSupervisor {
  /** Base URL of the proxy (use as EnvironmentDescriptor.baseUrl). */
  readonly url: string;
  /**
   * Control target WITH the control token in its fragment (`<controlBaseUrl>#token=<token>`): use it as
   * EnvironmentDescriptor.control.target with kind 'process'. A secret.
   */
  readonly controlUrl: string;
  /** Control API base URL without the token (for status/operation lookups and direct HTTP clients). */
  readonly controlBaseUrl: string;
  /** Token the mutating control endpoints require in `X-Hypertest-Control-Token`. */
  readonly controlToken: string;
  readonly port: number;
  readonly generation: number;
  readonly childPid: number | undefined;
  readonly childPort: number | undefined;
  readonly childRunning: boolean;
  restart(options?: { operationId?: string; env?: Record<string, string>; kind?: 'restart' | 'deploy'; buildRef?: string; desiredStateHash?: string }): Promise<SupervisorOperation>;
  injectFault(options: { operationId?: string; kind: SupervisorFaultKind; params: Record<string, unknown>; durationMs: number; desiredStateHash?: string }): SupervisorOperation;
  clearFaults(): void;
  /** Kills the child (crash simulation). */
  killChild(signal?: NodeJS.Signals): Promise<void>;
  operation(operationId: string): SupervisorOperation | undefined;
  operations(): SupervisorOperation[];
  close(): Promise<void>;
}

class BadRequest extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function num(params: Record<string, unknown>, keys: string[], what: string, min: number, max: number, dflt?: number): number {
  for (const k of keys) {
    const v = params[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new BadRequest(`${what} must be a number in [${min}, ${max}]`);
    return v;
  }
  if (dflt === undefined) throw new BadRequest(`${what} is required`);
  return dflt;
}

/** Validates and normalizes fault parameters (shared by the supervisor and the env.process adapter). */
export function normalizeFault(kind: unknown, params: unknown): SupervisorFault {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  try {
    if (kind === 'latency') {
      return { kind, params: { ms: num(p, ['ms', 'latencyMs'], 'latency ms', 0, 60_000), jitterMs: num(p, ['jitterMs'], 'jitterMs', 0, 60_000, 0), probability: num(p, ['probability'], 'probability', 0, 1, 1) } };
    }
    if (kind === 'error_rate') {
      const status = num(p, ['status'], 'status', 400, 599, 503);
      if (!Number.isInteger(status)) throw new BadRequest('status must be an integer');
      return { kind, params: { rate: num(p, ['rate', 'errorRate'], 'error rate', 0, 1), status } };
    }
  } catch (e) {
    throw new HypertestError('invalid_argument', errorMessage(e));
  }
  throw new HypertestError('invalid_argument', `unknown fault kind ${JSON.stringify(kind)} (expected latency or error_rate)`);
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size > limit) {
        reject(new BadRequest('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

class Supervisor implements ProcessSupervisor {
  readonly #o: Required<Pick<ProcessSupervisorOptions, 'host' | 'portEnv' | 'readyTimeoutMs' | 'killGraceMs'>> & ProcessSupervisorOptions;
  readonly #logger: Logger;
  readonly #ops = new Map<string, SupervisorOperation>();
  readonly #inflight = new Map<string, Promise<SupervisorOperation>>();
  readonly #envOverrides: Record<string, string> = {};
  readonly #agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  #server: http.Server | undefined;
  #port = 0;
  #child: ChildProcess | undefined;
  #childPort: number | undefined;
  #childRunning = false;
  #generation = 0;
  /** (E[0]) Highest fencing token a mutating control request carried (stale tokens are refused with 412). */
  #highestFence = 0;
  #counter = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly #token: string;

  constructor(options: ProcessSupervisorOptions) {
    if (!Array.isArray(options.command) || options.command.length === 0 || options.command.some((a) => typeof a !== 'string')) {
      throw new HypertestError('invalid_argument', 'supervisor command must be a non-empty argv array');
    }
    if (options.controlToken !== undefined && !CONTROL_TOKEN_RE.test(options.controlToken)) {
      throw new HypertestError('invalid_argument', `controlToken must match ${CONTROL_TOKEN_RE.source}`);
    }
    this.#token = options.controlToken ?? randomBytes(24).toString('base64url');
    this.#o = { host: '127.0.0.1', portEnv: 'PORT', readyTimeoutMs: 15_000, killGraceMs: 3_000, ...options };
    this.#logger = options.logger ?? noopLogger;
    if (options.stateFile) this.#loadState(options.stateFile);
  }

  get url(): string {
    const h = this.#o.host.includes(':') ? `[${this.#o.host}]` : this.#o.host;
    return `http://${h}:${this.#port}`;
  }
  get controlBaseUrl(): string {
    return `${this.url}${SUPERVISOR_CONTROL_PREFIX}`;
  }
  get controlUrl(): string {
    return `${this.controlBaseUrl}#token=${this.#token}`;
  }
  get controlToken(): string {
    return this.#token;
  }
  get port(): number {
    return this.#port;
  }
  get generation(): number {
    return this.#generation;
  }
  get childPid(): number | undefined {
    return this.#childRunning ? this.#child?.pid : undefined;
  }
  get childPort(): number | undefined {
    return this.#childPort;
  }
  get childRunning(): boolean {
    return this.#childRunning;
  }

  async start(): Promise<void> {
    await this.#spawnChild();
    const server = http.createServer((req, res) => {
      void this.#handle(req, res).catch((e) => {
        this.#logger.error('supervisor request failed', { error: errorMessage(e) });
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(e) });
        else res.destroy();
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#o.port ?? 0, this.#o.host, () => resolve());
    });
    this.#port = (server.address() as net.AddressInfo).port;
  }

  #loadState(file: string): void {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { operations?: SupervisorOperation[] };
      for (const op of data.operations ?? []) {
        if (op.state === 'running') {
          op.state = 'failed';
          op.error = 'supervisor restarted while the operation was running';
        }
        this.#ops.set(op.operationId, op);
      }
    } catch {
      // no previous state
    }
  }

  /**
   * Synchronous atomic write (tmp + rename) of the current records. Synchronous on purpose: concurrent
   * async writes could land out of order and leave an OLDER snapshot on disk (a completed restart recorded
   * as running would be reported failed after a supervisor restart); the file is small.
   */
  #persist(): void {
    const file = this.#o.stateFile;
    if (!file) return;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify({ operations: [...this.#ops.values()] }, null, 2) + '\n');
      renameSync(tmp, file);
    } catch (e) {
      this.#logger.warn('supervisor state not persisted', { error: errorMessage(e) });
    }
  }

  /**
   * A mutating control request is authorized by (E[4]) a short-lived control token minted for ITS operation (a JWT HS256
   * signed with the control token: audience hypertest-supervisor, unexpired, `op` = the request's operation id) — what the
   * env.process adapter sends, so the long-lived token never travels — or by the control token itself (an operator).
   */
  #authorized(req: http.IncomingMessage): boolean {
    const raw = req.headers[CONTROL_TOKEN_HEADER];
    const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const given = Buffer.from(value, 'utf8');
    const expected = Buffer.from(this.#token, 'utf8');
    if (given.byteLength === expected.byteLength && timingSafeEqual(given, expected)) return true;
    if (value.split('.').length !== 3) return false;
    const verified = verifyJwtHs256(value, this.#token, Date.now(), { audience: CONTROL_TOKEN_AUDIENCE });
    if (!verified.ok) return false;
    const op = req.headers[OPERATION_HEADER];
    const operationId = Array.isArray(op) ? op[0] : op;
    // bound to one operation: a minted token never authorizes a request for another operation (or none)
    return typeof operationId === 'string' && verified.claims['op'] === operationId;
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #spawnChild(): Promise<void> {
    const port = await freePort(this.#o.host);
    const base = this.#o.inheritEnv === false ? { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } : { ...process.env };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...base, ...(this.#o.env ?? {}), ...this.#envOverrides })) if (typeof v === 'string') env[k] = v;
    env[this.#o.portEnv] = String(port);
    const logFd = this.#o.logFile ? openSync(this.#o.logFile, 'a') : undefined;
    const stdio = logFd !== undefined ? logFd : 'ignore';
    let child: ChildProcess;
    try {
      child = spawn(this.#o.command[0]!, this.#o.command.slice(1), { cwd: this.#o.cwd, env, detached: true, stdio: ['ignore', stdio, stdio], windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve());
      });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    this.#child = child;
    this.#childPort = port;
    this.#childRunning = true;
    let exited = false;
    child.once('exit', (code, signal) => {
      exited = true;
      if (this.#child === child) {
        this.#childRunning = false;
        this.#logger.warn('supervised child exited', { pid: child.pid, code, signal });
      }
    });
    const deadline = Date.now() + this.#o.readyTimeoutMs;
    for (;;) {
      if (exited) throw new HypertestError('unavailable', `child ${this.#o.command[0]} exited before it became ready`);
      if (await canConnect(this.#o.host, port)) break;
      if (Date.now() > deadline) {
        this.#killGroup(child, 'SIGKILL');
        throw new HypertestError('timeout', `child did not listen on port ${port} within ${this.#o.readyTimeoutMs} ms`);
      }
      await sleep(25);
    }
    this.#generation++;
    this.#logger.info('supervised child ready', { pid: child.pid, port, generation: this.#generation });
  }

  #killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  async #stopChild(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.#childRunning = false;
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.#killGroup(child, signal);
    const timer = setTimeout(() => this.#killGroup(child, 'SIGKILL'), this.#o.killGraceMs);
    await exited;
    clearTimeout(timer);
    this.#childRunning = false;
  }

  restart(options: { operationId?: string; env?: Record<string, string>; kind?: 'restart' | 'deploy'; buildRef?: string; desiredStateHash?: string } = {}): Promise<SupervisorOperation> {
    if (this.#closed) return Promise.reject(new HypertestError('unavailable', 'supervisor is closed'));
    const kind = options.kind ?? 'restart';
    const operationId = options.operationId ?? `restart-${++this.#counter}-${Date.now()}`;
    const existing = this.#ops.get(operationId);
    if (existing) {
      if (existing.kind !== kind) return Promise.reject(new HypertestError('conflict', `operation ${operationId} is a ${existing.kind}, not a ${kind}`));
      return this.#inflight.get(operationId) ?? Promise.resolve(existing);
    }
    const allowed = new Set(this.#o.allowedEnvOverrides ?? ['BUILD_REF']);
    const overrides: Record<string, string> = { ...(options.env ?? {}) };
    if (options.buildRef !== undefined) overrides['BUILD_REF'] = options.buildRef;
    for (const [k, v] of Object.entries(overrides)) {
      if (!allowed.has(k)) return Promise.reject(new HypertestError('invalid_argument', `environment override ${k} is not allowed`));
      if (typeof v !== 'string') return Promise.reject(new HypertestError('invalid_argument', `environment override ${k} must be a string`));
    }
    const record: SupervisorOperation = { operationId, kind, state: 'running', requestedAt: new Date().toISOString(), restartId: `rst-${++this.#counter}` };
    if (options.desiredStateHash !== undefined) record.desiredStateHash = options.desiredStateHash;
    if (options.buildRef !== undefined) record.buildRef = options.buildRef;
    this.#ops.set(operationId, record);
    this.#persist();
    const run = this.#enqueue(async () => {
      try {
        await this.#stopChild();
        Object.assign(this.#envOverrides, overrides);
        await this.#spawnChild();
        record.state = 'completed';
        record.generation = this.#generation;
        if (this.#child?.pid !== undefined) record.pid = this.#child.pid;
      } catch (e) {
        record.state = 'failed';
        record.error = errorMessage(e);
      }
      record.completedAt = new Date().toISOString();
      this.#persist();
      return record;
    }).finally(() => this.#inflight.delete(operationId));
    this.#inflight.set(operationId, run);
    return run;
  }

  injectFault(options: { operationId?: string; kind: SupervisorFaultKind; params: Record<string, unknown>; durationMs: number; desiredStateHash?: string }): SupervisorOperation {
    const operationId = options.operationId ?? `fault-${++this.#counter}-${Date.now()}`;
    const existing = this.#ops.get(operationId);
    if (existing) {
      if (existing.kind !== 'fault') throw new HypertestError('conflict', `operation ${operationId} is a ${existing.kind}, not a fault`);
      return this.#view(existing);
    }
    const fault = normalizeFault(options.kind, options.params);
    if (!(Number.isInteger(options.durationMs) && options.durationMs > 0 && options.durationMs <= 3_600_000)) throw new HypertestError('invalid_argument', 'durationMs must be an integer in [1, 3600000]');
    const now = Date.now();
    const record: SupervisorOperation = {
      operationId,
      kind: 'fault',
      state: 'active',
      requestedAt: new Date(now).toISOString(),
      completedAt: new Date(now).toISOString(),
      faultId: `flt-${++this.#counter}`,
      fault,
      expiresAt: new Date(now + options.durationMs).toISOString(),
    };
    if (options.desiredStateHash !== undefined) record.desiredStateHash = options.desiredStateHash;
    this.#ops.set(operationId, record);
    this.#persist();
    this.#logger.info('fault injected', { operationId, kind: fault.kind, params: fault.params, durationMs: options.durationMs });
    return this.#view(record);
  }

  clearFaults(): void {
    for (const op of this.#ops.values()) if (op.kind === 'fault' && this.#view(op).state === 'active') op.state = 'cleared';
    this.#persist();
  }

  #view(op: SupervisorOperation): SupervisorOperation {
    if (op.kind === 'fault' && op.state === 'active' && op.expiresAt !== undefined && Date.parse(op.expiresAt) <= Date.now()) return { ...op, state: 'expired' };
    return { ...op };
  }

  #activeFaults(): SupervisorFault[] {
    const now = Date.now();
    const latest = new Map<SupervisorFaultKind, SupervisorFault>();
    for (const op of this.#ops.values()) {
      if (op.kind === 'fault' && op.state === 'active' && op.fault && op.expiresAt !== undefined && Date.parse(op.expiresAt) > now) latest.set(op.fault.kind, op.fault);
    }
    return [...latest.values()];
  }

  async killChild(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    await this.#enqueue(() => this.#stopChild(signal));
  }

  operation(operationId: string): SupervisorOperation | undefined {
    const op = this.#ops.get(operationId);
    return op ? this.#view(op) : undefined;
  }

  operations(): SupervisorOperation[] {
    return [...this.#ops.values()].map((o) => this.#view(o));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const server = this.#server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    this.#agent.destroy();
    await this.#queue.catch(() => undefined);
    await this.#stopChild();
  }

  // --------------------------------------------------------------------------------------- HTTP

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === SUPERVISOR_CONTROL_PREFIX || path.startsWith(`${SUPERVISOR_CONTROL_PREFIX}/`)) {
      try {
        await this.#control(req, res, path.slice(SUPERVISOR_CONTROL_PREFIX.length) || '/');
      } catch (e) {
        if (e instanceof BadRequest) sendJson(res, e.status, { error: e.message });
        else if (e instanceof HypertestError && e.code === 'invalid_argument') sendJson(res, 400, { error: e.message });
        else if (e instanceof HypertestError && e.code === 'conflict') sendJson(res, 409, { error: e.message });
        else throw e;
      }
      return;
    }
    await this.#proxy(req, res);
  }

  #operationIdOf(req: http.IncomingMessage): string | undefined {
    const raw = req.headers[OPERATION_HEADER];
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (id === undefined || id === '') return undefined;
    if (!OPERATION_ID_RE.test(id)) throw new BadRequest('invalid X-Hypertest-Operation header');
    return id;
  }

  async #jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const text = await readBody(req);
    if (text.trim() === '') return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch {
      throw new BadRequest('body must be a JSON object');
    }
  }

  async #control(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !this.#authorized(req)) {
      req.resume();
      return sendJson(res, 401, { error: `missing or invalid ${CONTROL_TOKEN_HEADER}` });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      // E[0] fenced target: a request carrying an older fencing token than one already accepted is refused (nothing done)
      const raw = req.headers[FENCE_HEADER];
      const text = Array.isArray(raw) ? raw[0] : raw;
      if (text !== undefined && text !== '') {
        const token = Number(text);
        if (!Number.isSafeInteger(token) || token <= 0) throw new BadRequest(`invalid ${FENCE_HEADER} header`);
        if (token < this.#highestFence) {
          req.resume();
          return sendJson(res, 412, { error: `stale fencing token ${token}: token ${this.#highestFence} was already accepted for this environment` });
        }
        this.#highestFence = token;
      }
    }
    if (method === 'GET' && path === '/status') {
      return sendJson(res, 200, { generation: this.#generation, childPid: this.childPid ?? null, childPort: this.#childPort ?? null, childRunning: this.#childRunning, faults: this.#activeFaults() });
    }
    if (method === 'POST' && path === '/restart') {
      const operationId = this.#operationIdOf(req);
      const body = await this.#jsonBody(req);
      const opts: Parameters<ProcessSupervisor['restart']>[0] = {};
      if (operationId !== undefined) opts.operationId = operationId;
      if (body['env'] !== undefined) {
        if (!body['env'] || typeof body['env'] !== 'object' || Array.isArray(body['env'])) throw new BadRequest('env must be an object of strings');
        opts.env = body['env'] as Record<string, string>;
      }
      if (body['kind'] !== undefined) {
        if (body['kind'] !== 'restart' && body['kind'] !== 'deploy') throw new BadRequest('kind must be restart or deploy');
        opts.kind = body['kind'];
      }
      if (body['buildRef'] !== undefined) {
        if (typeof body['buildRef'] !== 'string') throw new BadRequest('buildRef must be a string');
        opts.buildRef = body['buildRef'];
      }
      if (typeof body['desiredStateHash'] === 'string') opts.desiredStateHash = body['desiredStateHash'];
      const record = await this.restart(opts);
      return sendJson(res, 200, this.#view(record));
    }
    if (method === 'POST' && path === '/faults') {
      const operationId = this.#operationIdOf(req);
      const body = await this.#jsonBody(req);
      const opts: Parameters<ProcessSupervisor['injectFault']>[0] = {
        kind: body['kind'] as SupervisorFaultKind,
        params: (body['params'] ?? {}) as Record<string, unknown>,
        durationMs: body['durationMs'] as number,
      };
      if (operationId !== undefined) opts.operationId = operationId;
      if (typeof body['desiredStateHash'] === 'string') opts.desiredStateHash = body['desiredStateHash'];
      return sendJson(res, 200, this.injectFault(opts));
    }
    if (method === 'DELETE' && path === '/faults') {
      this.clearFaults();
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'POST' && path === '/kill') {
      await this.killChild('SIGKILL');
      return sendJson(res, 200, { killed: true, generation: this.#generation });
    }
    const m = /^\/operations\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const op = this.operation(decodeURIComponent(m[1]!));
      return op ? sendJson(res, 200, op) : sendJson(res, 404, { error: 'unknown operation' });
    }
    sendJson(res, 404, { error: `no control endpoint ${method} ${path}` });
  }

  async #proxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const f of this.#activeFaults()) {
      if (f.kind === 'error_rate' && Math.random() < f.params['rate']!) {
        req.resume();
        return sendJson(res, f.params['status']!, { error: 'fault injected by hypertest supervisor', fault: 'error_rate' });
      }
      if (f.kind === 'latency' && Math.random() < f.params['probability']!) {
        await sleep(f.params['ms']! + Math.random() * f.params['jitterMs']!);
      }
    }
    const port = this.#childPort;
    if (!this.#childRunning || port === undefined) {
      req.resume();
      return sendJson(res, 502, { error: 'supervised process is not running' });
    }
    await new Promise<void>((resolve) => {
      const headers = { ...req.headers, host: `${this.#o.host}:${port}` };
      const upstream = http.request({ host: this.#o.host, port, method: req.method, path: req.url, headers, agent: this.#agent }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on('end', () => resolve());
        up.on('error', () => {
          res.destroy();
          resolve();
        });
      });
      upstream.on('error', (e) => {
        if (!res.headersSent) sendJson(res, 502, { error: `upstream error: ${e.message}` });
        else res.destroy();
        resolve();
      });
      req.pipe(upstream);
    });
  }
}

/** Starts the supervisor (child first, then the listener); resolves once the child accepts connections. */
export async function startProcessSupervisor(options: ProcessSupervisorOptions): Promise<ProcessSupervisor> {
  const s = new Supervisor(options);
  try {
    await s.start();
  } catch (e) {
    await s.close().catch(() => undefined);
    throw e;
  }
  return s;
}
