import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HypertestError, hashCanonical, isHypertestError, sleep, type JsonSchema, type JsonValue, type Logger } from '@hypertest/core';
import type { EvidenceRecord } from '@hypertest/domain';
import type { CompensationResult, DispatchReceipt, ObservationResult, OperationContext, PreparedOperation, SideEffectAdapter, SideEffectCapabilities, SideEffectOutcome, VerificationResult } from '@hypertest/operation';
import type { EnvironmentRegistry, ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import {
  ENV_ID_SCHEMA, OPERATION_ID_SCHEMA, assertOperationId, checkEgress, environmentClassForUrl, environmentOrigins, errorMessage, hostSegment, joinUrl, parseHttpUrl, pidState, readJsonFile,
  readJsonFileSync, requireEnvironment, writeJsonAtomic,
} from './common.ts';
import { HTTP_METHODS } from './http.ts';

export const LOAD_ADAPTER_ID = 'load.http';
export const LOAD_STOP_ADAPTER_ID = 'load.http.stop';
/** The standalone worker script (`node <path> <jobDir>`). */
export const LOADGEN_WORKER_PATH = fileURLToPath(new URL('./loadgen-worker.ts', import.meta.url));
const DEFAULT_LAUNCH_GRACE_MS = 15_000;
const DEFAULT_STOP_WAIT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 16;
const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);

export interface LoadStartInput {
  environmentId?: string;
  targetUrl?: string;
  path?: string;
  method: string;
  ratePerSecond: number;
  durationMs: number;
  concurrency?: number;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** The job specification written to `<jobDir>/spec.json` (the operation's desired state + bookkeeping). */
export interface LoadJobSpec {
  operationId: string;
  targetUrl: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
  ratePerSecond: number;
  durationMs: number;
  concurrency: number;
  timeoutMs: number;
  environmentId?: string;
  environmentClass?: string;
}

export type LoadJobState = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/** `status.json` / `results.json` as written by the worker. */
export interface LoadJobStatus {
  operationId?: string;
  state: 'running' | 'completed' | 'failed' | 'stopped';
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  planned?: number;
  sent: number;
  ok: number;
  errors: number;
  networkErrors?: number;
  timeouts?: number;
  inFlight?: number;
  queued?: number;
  statusCodes?: Record<string, number>;
  latencyMs?: { p50: number | null; p95: number | null; p99: number | null; max: number | null; min?: number | null; mean: number | null };
  achievedRps?: number;
  elapsedMs?: number;
  error?: string;
  lastError?: string;
  histogram?: { unit: 'ms'; buckets: Array<{ le: number | string; count: number }> };
}

export interface LoadJobObservation {
  operationId: string;
  jobDir: string;
  state: LoadJobState;
  pid?: number;
  pidAlive: boolean;
  status?: LoadJobStatus;
  results?: LoadJobStatus;
  /** desiredStateHash recorded in spec.json when the job was launched. */
  desiredStateHash?: string;
  reason?: string;
}

/**
 * Load job directory `<stateDir>/loadjobs/<operationId>` (the operation id is the job's identity). Always
 * absolute: the worker runs with the job directory as its cwd and receives it as argv, so a relative
 * state dir would make the worker look for `<dir>/<dir>/spec.json`.
 */
export function loadJobDir(stateDir: string, operationId: string): string {
  return join(resolve(stateDir), 'loadjobs', assertOperationId(operationId));
}

/**
 * The command-line marker of a job's worker: its job-dir argument ends with `/loadjobs/<operationId>`; a pid
 * without such an argument was reused by another process. Independent of how the state dir is spelled
 * (relative, symlinked), and exact (the worker of `op_12` never passes for `op_1`).
 */
function workerMarker(operationId: string): string {
  return `${sep}${join('loadjobs', operationId)}`;
}

/** Resolves the target URL of a load job from `targetUrl` or `environmentId` + `path`. */
export function resolveLoadTarget(input: Pick<LoadStartInput, 'environmentId' | 'targetUrl' | 'path'>, envs: EnvironmentRegistry | undefined): { url: URL; environmentClass: string | undefined; trustedOrigins: string[] } {
  if (input.environmentId !== undefined) {
    const env = requireEnvironment(envs, input.environmentId);
    if (!env.baseUrl) throw new HypertestError('precondition_failed', `environment ${env.environmentId} has no baseUrl`);
    return { url: joinUrl(env.baseUrl, input.path, `environment ${env.environmentId} baseUrl`), environmentClass: env.environmentClass, trustedOrigins: environmentOrigins(env) };
  }
  if (input.targetUrl === undefined) throw new HypertestError('invalid_argument', 'either targetUrl or environmentId is required');
  if (input.path !== undefined) throw new HypertestError('invalid_argument', 'path is only valid together with environmentId');
  const url = parseHttpUrl(input.targetUrl, 'targetUrl');
  return { url, environmentClass: environmentClassForUrl(url, envs), trustedOrigins: [] };
}

/** The run a load job belongs to (recorded in spec.json at launch); undefined when unknown. */
function jobRunId(stateDir: string, operationId: string): string | undefined {
  const spec = readJsonFileSync<{ runId?: unknown }>(join(loadJobDir(stateDir, operationId), 'spec.json'));
  return typeof spec?.runId === 'string' ? spec.runId : undefined;
}

/** Upper bound of the process-wide in-memory caches below (oldest entries are evicted first). */
const MAX_CACHED_JOBS = 4096;

/** Map.set that evicts the oldest entries beyond `max` (Map iterates in insertion order). */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max = MAX_CACHED_JOBS): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/**
 * Process-wide job → environment class cache (so load.stop can be classified without a state dir; with a
 * state dir, spec.json is the durable source). Bounded: a long-lived worker must not grow without limit.
 */
const jobEnvironmentClass = new Map<string, string>();

/** The worker's pid: from its own `pid` file, else (unless workerOnly) from the launcher's launch.json. */
async function readPid(dir: string, workerOnly = false): Promise<number | undefined> {
  for (const file of workerOnly ? ['pid'] : ['pid', 'launch.json']) {
    try {
      const text = await readFile(join(dir, file), 'utf8');
      const pid = file === 'pid' ? Number.parseInt(text.trim(), 10) : Number((JSON.parse(text) as { pid?: unknown }).pid);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // try the next source
    }
  }
  return undefined;
}

/**
 * Observes a load job by its operation id (the directory name): `absent` without a directory,
 * `uncertain` when status.json is unreadable/corrupt or the launch was interrupted (directory without a
 * worker after the grace period), otherwise `present` with the job state. A worker that died while its
 * status still says `running` is reported as `failed`.
 */
export async function observeLoadJob(stateDir: string, operationId: string, options: { launchGraceMs?: number } = {}): Promise<ObservationResult<LoadJobObservation>> {
  const dir = loadJobDir(stateDir, operationId);
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'uncertain', detail: `cannot inspect job directory: ${errorMessage(e)}` };
  }
  const obs: LoadJobObservation = { operationId, jobDir: dir, state: 'starting', pidAlive: false };
  const spec = await readJsonFile<{ desiredStateHash?: string }>(join(dir, 'spec.json'));
  if (spec.kind === 'ok' && typeof spec.value.desiredStateHash === 'string') obs.desiredStateHash = spec.value.desiredStateHash;
  const pid = await readPid(dir);
  if (pid !== undefined) {
    obs.pid = pid;
    obs.pidAlive = pidState(pid, workerMarker(operationId)) === 'alive';
  }
  const status = await readJsonFile<LoadJobStatus>(join(dir, 'status.json'));
  if (status.kind === 'corrupt') return { state: 'uncertain', detail: `status.json unreadable: ${status.error}` };
  if (status.kind === 'ok') {
    const s = status.value;
    if (!s || typeof s !== 'object' || !['running', 'completed', 'failed', 'stopped'].includes(s.state)) return { state: 'uncertain', detail: 'status.json has no valid state' };
    obs.status = s;
    if (s.state === 'running') {
      if (pid !== undefined && !obs.pidAlive) {
        obs.state = 'failed';
        obs.reason = `worker process ${pid} died while the job was running`;
      } else obs.state = 'running';
      return { state: 'present', observation: obs };
    }
    obs.state = s.state;
    const results = await readJsonFile<LoadJobStatus>(join(dir, 'results.json'));
    if (results.kind === 'ok') obs.results = results.value;
    else if (s.state === 'completed') return { state: 'uncertain', detail: `job completed but results.json is ${results.kind === 'missing' ? 'missing' : `unreadable: ${results.error}`}` };
    if (s.state === 'failed') obs.reason = s.error ?? s.lastError ?? 'load worker failed';
    return { state: 'present', observation: obs };
  }
  // no status yet
  if (pid !== undefined) {
    if (obs.pidAlive) return { state: 'present', observation: obs };
    obs.state = 'failed';
    obs.reason = `worker process ${pid} exited before reporting status (see ${join(dir, 'worker.log')})`;
    return { state: 'present', observation: obs };
  }
  const age = Date.now() - dirStat.mtimeMs;
  if (age < (options.launchGraceMs ?? DEFAULT_LAUNCH_GRACE_MS)) return { state: 'present', observation: obs };
  return { state: 'uncertain', detail: `job directory ${dir} exists without a worker after ${Math.round(age)} ms (interrupted launch)` };
}

/**
 * Sends SIGTERM to a load job's worker (only when the pid still belongs to this job) and waits until it
 * reports a terminal state or exits; escalates to SIGKILL after `waitMs`.
 */
export async function stopLoadJob(stateDir: string, operationId: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<{ found: boolean; signalled: boolean; finalState?: LoadJobState; killed: boolean }> {
  const dir = loadJobDir(stateDir, operationId);
  const first = await observeLoadJob(stateDir, operationId);
  if (first.state === 'absent') return { found: false, signalled: false, killed: false };
  // A finished job is left alone (its worker may still be exiting; signalling it would change nothing).
  if (first.state === 'present' && TERMINAL_STATES.has(first.observation.state)) return { found: true, signalled: false, killed: false, finalState: first.observation.state };
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_STOP_WAIT_MS);
  // Signal only a worker that has written its own pid file: it installs its SIGTERM handler first, so a
  // signal sent earlier (pid known only from launch.json) would kill it without a final status.
  let pid = await readPid(dir, true);
  while (pid === undefined && Date.now() < deadline) {
    const launched = await readPid(dir);
    if (launched !== undefined && pidState(launched, workerMarker(operationId)) === 'dead') break;
    if (launched === undefined) {
      const o = await observeLoadJob(stateDir, operationId);
      if (o.state !== 'present' || o.observation.state !== 'starting') break;
    }
    await sleep(25, options.signal);
    pid = await readPid(dir, true);
  }
  pid ??= await readPid(dir);
  const alive = () => pid !== undefined && pidState(pid, workerMarker(operationId)) === 'alive';
  let signalled = false;
  let killed = false;
  if (alive()) {
    try {
      process.kill(pid!, 'SIGTERM');
      signalled = true;
    } catch {
      // exited in between
    }
  }
  while (alive()) {
    if (Date.now() >= deadline) {
      try {
        process.kill(pid!, 'SIGKILL');
        killed = true;
      } catch {
        // gone
      }
      break;
    }
    await sleep(50, options.signal);
  }
  const last = await observeLoadJob(stateDir, operationId);
  const out: { found: boolean; signalled: boolean; finalState?: LoadJobState; killed: boolean } = { found: true, signalled, killed };
  if (last.state === 'present') out.finalState = last.observation.state;
  return out;
}

const LOAD_CAPABILITIES: SideEffectCapabilities = {
  supportsNativeIdempotency: true,
  supportsExternalLookupByOperationId: true,
  supportsFencing: false,
  supportsCompensation: true,
  reconciliationClass: 'deterministic',
  riskClass: 'high',
};

export interface HttpLoadAdapterOptions {
  stateDir: string;
  environments?: EnvironmentRegistry;
  /** Worker script (default: the built-in loadgen-worker.ts next to this module). */
  workerPath?: string;
  /** Node binary (default: process.execPath). */
  nodePath?: string;
  /** How long a job directory without a worker is considered "launching" before it is `uncertain`. */
  launchGraceMs?: number;
  /** How long compensate/stop waits for the worker to stop before SIGKILL (default 5000). */
  stopWaitMs?: number;
  logger?: Logger;
}

function summarizeResults(r: LoadJobStatus | undefined): Record<string, unknown> {
  if (!r) return {};
  const out: Record<string, unknown> = { sent: r.sent, ok: r.ok, errors: r.errors };
  for (const k of ['planned', 'networkErrors', 'timeouts', 'statusCodes', 'latencyMs', 'achievedRps', 'elapsedMs', 'startedAt', 'finishedAt', 'histogram', 'lastError'] as const) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

/**
 * `load.http` SideEffectAdapter: the built-in HTTP load generator as an external job. The job directory
 * `<stateDir>/loadjobs/<operationId>/` IS the external effect, keyed by the operation id, so:
 * dispatch never starts a second worker for an operation (an existing directory ⇒ receipt for the
 * existing job; the directory is claimed with an exclusive mkdir), observe finds the job by operation id
 * after a crash, and verify reads the worker's own status/results files.
 */
export class HttpLoadAdapter implements SideEffectAdapter<LoadStartInput, LoadJobObservation> {
  readonly adapterId = LOAD_ADAPTER_ID;
  readonly capabilities = LOAD_CAPABILITIES;
  readonly #o: HttpLoadAdapterOptions;
  /** Number of worker processes this adapter instance spawned (observability for tests/metrics). */
  spawned = 0;

  constructor(options: HttpLoadAdapterOptions) {
    if (!options || typeof options.stateDir !== 'string' || options.stateDir === '') throw new HypertestError('invalid_argument', 'HttpLoadAdapter requires stateDir');
    this.#o = { ...options, stateDir: resolve(options.stateDir) };
  }

  get stateDir(): string {
    return this.#o.stateDir;
  }

  async prepare(op: OperationContext, input: LoadStartInput): Promise<PreparedOperation> {
    const operationId = assertOperationId(op.operation.operationId);
    if (!input || typeof input !== 'object') throw new HypertestError('invalid_argument', 'load.start input must be an object');
    const method = String(input.method ?? '').toUpperCase();
    if (!HTTP_METHODS.includes(method)) throw new HypertestError('invalid_argument', `unsupported method ${input.method}`);
    // fetch refuses these per request: the job would "complete" with 100% errors instead of failing up front
    if ((method === 'GET' || method === 'HEAD') && input.body !== undefined) throw new HypertestError('invalid_argument', `${method} load requests cannot carry a body`);
    if (!(typeof input.ratePerSecond === 'number' && input.ratePerSecond > 0 && input.ratePerSecond <= 100_000)) throw new HypertestError('invalid_argument', 'ratePerSecond must be in (0, 100000]');
    if (!(Number.isInteger(input.durationMs) && input.durationMs > 0)) throw new HypertestError('invalid_argument', 'durationMs must be a positive integer');
    const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
    if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10_000)) throw new HypertestError('invalid_argument', 'concurrency must be an integer in [1, 10000]');
    const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new HypertestError('invalid_argument', 'timeoutMs must be a positive integer');
    const { url, environmentClass } = resolveLoadTarget(input, this.#o.environments);
    const spec: LoadJobSpec = { operationId, targetUrl: url.href, method, ratePerSecond: input.ratePerSecond, durationMs: input.durationMs, concurrency, timeoutMs };
    if (input.body !== undefined) spec.body = input.body;
    if (input.headers !== undefined) spec.headers = normalizeHeaders(input.headers);
    if (input.environmentId !== undefined) spec.environmentId = input.environmentId;
    if (environmentClass !== undefined) {
      spec.environmentClass = environmentClass;
      setBounded(jobEnvironmentClass, operationId, environmentClass);
    }
    return { desiredState: spec, desiredStateHash: hashCanonical(spec), target: { resourceKey: `loadgen/${hostSegment(url)}`, kind: 'load_job', externalId: operationId } };
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const spec = prepared.desiredState as LoadJobSpec;
    const operationId = assertOperationId(op.operation.operationId);
    if (spec.operationId !== operationId) throw new HypertestError('conflict', `prepared load spec belongs to ${spec.operationId}, not ${operationId}`);
    const dir = loadJobDir(this.#o.stateDir, operationId);
    await mkdir(join(this.#o.stateDir, 'loadjobs'), { recursive: true });
    try {
      await mkdir(dir); // exclusive claim: exactly one dispatcher ever launches this job
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = await readPid(dir);
      this.#o.logger?.info('load job already exists; attaching instead of launching', { operationId, pid });
      return { accepted: true, externalJobId: operationId, receipt: JSON.stringify({ jobDir: dir, existing: true, ...(pid !== undefined ? { pid } : {}) }) };
    }
    // Everything up to a successful spawn is undone on failure (claim removed ⇒ definitively not applied);
    // a claim left behind without a worker would otherwise surface as an "interrupted launch" (manual review).
    let logFd: number | undefined;
    let pid: number;
    try {
      await writeJsonAtomic(join(dir, 'spec.json'), { ...spec, desiredStateHash: prepared.desiredStateHash, runId: op.operation.runId, createdAt: new Date().toISOString() });
      logFd = openSync(join(dir, 'worker.log'), 'a');
      const child = spawn(this.#o.nodePath ?? process.execPath, ['--no-warnings', this.#o.workerPath ?? LOADGEN_WORKER_PATH, dir], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...(process.env['TZ'] ? { TZ: process.env['TZ'] } : {}), ...(process.env['LANG'] ? { LANG: process.env['LANG'] } : {}) },
        windowsHide: true,
      });
      pid = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve(child.pid!));
      });
      child.unref();
    } catch (e) {
      if (logFd !== undefined) closeSync(logFd);
      logFd = undefined;
      await rm(dir, { recursive: true, force: true });
      return { accepted: false, notAppliedReason: `load worker could not be started: ${errorMessage(e)}` };
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    this.spawned++;
    await writeJsonAtomic(join(dir, 'launch.json'), { pid, spawnedAt: new Date().toISOString() });
    this.#o.logger?.info('load job launched', { operationId, pid, targetUrl: spec.targetUrl, ratePerSecond: spec.ratePerSecond, durationMs: spec.durationMs });
    return { accepted: true, externalJobId: operationId, receipt: JSON.stringify({ jobDir: dir, pid }) };
  }

  async observe(op: OperationContext): Promise<ObservationResult<LoadJobObservation>> {
    const opts: { launchGraceMs?: number } = {};
    if (this.#o.launchGraceMs !== undefined) opts.launchGraceMs = this.#o.launchGraceMs;
    return observeLoadJob(this.#o.stateDir, op.operation.operationId, opts);
  }

  async verify(observation: LoadJobObservation, desiredStateHash: string): Promise<VerificationResult> {
    if (observation.desiredStateHash !== undefined && observation.desiredStateHash !== desiredStateHash) {
      return { status: 'failed', reason: `job directory ${observation.jobDir} holds a different load spec` };
    }
    switch (observation.state) {
      case 'completed':
        return { status: 'verified', result: { operationId: observation.operationId, jobDir: observation.jobDir, state: 'completed', results: summarizeResults(observation.results ?? observation.status) } };
      case 'starting':
      case 'running': {
        const progress: Record<string, unknown> = { state: observation.state };
        if (observation.pid !== undefined) progress['pid'] = observation.pid;
        const s = observation.status;
        if (s) Object.assign(progress, { sent: s.sent, ok: s.ok, errors: s.errors, planned: s.planned, achievedRps: s.achievedRps, latencyMs: s.latencyMs, elapsedMs: s.elapsedMs });
        return { status: 'pending', progress };
      }
      case 'stopped':
        return { status: 'failed', reason: `load job stopped before completion (sent ${observation.status?.sent ?? 0} of ${observation.status?.planned ?? '?'})` };
      case 'failed':
        return { status: 'failed', reason: `load job failed: ${observation.reason ?? 'unknown reason'}` };
    }
  }

  /** Stops the job's worker (SIGTERM, then SIGKILL after stopWaitMs). A finished job needs nothing. */
  async compensate(op: OperationContext): Promise<CompensationResult> {
    const opts: { waitMs?: number; signal?: AbortSignal } = { signal: op.signal };
    if (this.#o.stopWaitMs !== undefined) opts.waitMs = this.#o.stopWaitMs;
    const r = await stopLoadJob(this.#o.stateDir, op.operation.operationId, opts);
    if (!r.found) return { compensated: true, detail: 'no load job directory; nothing to stop' };
    if (!r.signalled && r.finalState !== undefined && TERMINAL_STATES.has(r.finalState)) return { compensated: true, detail: `job already ${r.finalState}; nothing to stop` };
    return { compensated: true, detail: `${r.signalled ? 'SIGTERM sent' : 'worker not running'}${r.killed ? ', SIGKILL after timeout' : ''}; final state ${r.finalState ?? 'unknown'}` };
  }
}

export interface LoadStopObservation {
  jobOperationId: string;
  jobState?: LoadJobState;
  pidAlive: boolean;
  status?: LoadJobStatus;
}

const STOP_CAPABILITIES: SideEffectCapabilities = {
  supportsNativeIdempotency: true,
  supportsExternalLookupByOperationId: true,
  supportsFencing: false,
  supportsCompensation: false,
  reconciliationClass: 'deterministic',
  riskClass: 'medium',
};

/**
 * `load.http.stop` SideEffectAdapter behind `load.stop`: stopping a running load job is its own governed
 * operation (the SideEffectGateway only compensates *verified* operations, and a running job is still
 * `acknowledged`). dispatch records a stop marker `stop-<stopOperationId>.json` in the job directory (the
 * lookup key) and SIGTERMs the worker; verify succeeds once the job is terminal or its worker is gone.
 */
export class HttpLoadStopAdapter implements SideEffectAdapter<{ operationId: string }, LoadStopObservation> {
  readonly adapterId = LOAD_STOP_ADAPTER_ID;
  readonly capabilities = STOP_CAPABILITIES;
  readonly #o: HttpLoadAdapterOptions;

  constructor(options: HttpLoadAdapterOptions) {
    if (!options || typeof options.stateDir !== 'string' || options.stateDir === '') throw new HypertestError('invalid_argument', 'HttpLoadStopAdapter requires stateDir');
    this.#o = { ...options, stateDir: resolve(options.stateDir) };
  }

  /** A run may only stop its own load jobs (the job's run is recorded in its spec.json). */
  #assertSameRun(jobOperationId: string, runId: string): void {
    const owner = jobRunId(this.#o.stateDir, jobOperationId);
    if (owner !== undefined && owner !== runId) throw new HypertestError('permission_denied', `load job ${jobOperationId} belongs to another run`);
  }

  async prepare(op: OperationContext, input: { operationId: string }): Promise<PreparedOperation> {
    const jobOperationId = assertOperationId(input?.operationId);
    this.#assertSameRun(jobOperationId, op.operation.runId);
    return { desiredState: { jobOperationId, action: 'stop' }, desiredStateHash: hashCanonical({ jobOperationId, action: 'stop' }), target: { resourceKey: `loadjob/${jobOperationId}`, kind: 'load_job', externalId: jobOperationId } };
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const { jobOperationId } = prepared.desiredState as { jobOperationId: string };
    const dir = loadJobDir(this.#o.stateDir, jobOperationId);
    try {
      await stat(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { accepted: false, notAppliedReason: `no load job ${jobOperationId}` };
      throw e;
    }
    const owner = jobRunId(this.#o.stateDir, jobOperationId);
    if (owner !== undefined && owner !== op.operation.runId) return { accepted: false, notAppliedReason: `load job ${jobOperationId} belongs to another run` };
    await writeFile(join(dir, `stop-${assertOperationId(op.operation.operationId)}.json`), JSON.stringify({ stopOperationId: op.operation.operationId, requestedAt: new Date().toISOString() }) + '\n');
    const opts: { waitMs?: number; signal?: AbortSignal } = { signal: op.signal };
    if (this.#o.stopWaitMs !== undefined) opts.waitMs = this.#o.stopWaitMs;
    const r = await stopLoadJob(this.#o.stateDir, jobOperationId, opts);
    return { accepted: true, externalJobId: jobOperationId, receipt: JSON.stringify({ signalled: r.signalled, killed: r.killed, finalState: r.finalState ?? null }) };
  }

  async observe(op: OperationContext): Promise<ObservationResult<LoadStopObservation>> {
    const jobOperationId = op.operation.target.externalId ?? op.operation.target.resourceKey.replace(/^loadjob\//, '');
    const dir = loadJobDir(this.#o.stateDir, jobOperationId);
    const marker = await readJsonFile(join(dir, `stop-${assertOperationId(op.operation.operationId)}.json`));
    if (marker.kind === 'missing') return { state: 'absent' };
    if (marker.kind === 'corrupt') return { state: 'uncertain', detail: `stop marker unreadable: ${marker.error}` };
    const job = await observeLoadJob(this.#o.stateDir, jobOperationId, this.#o.launchGraceMs !== undefined ? { launchGraceMs: this.#o.launchGraceMs } : {});
    if (job.state === 'uncertain') return job;
    if (job.state === 'absent') return { state: 'present', observation: { jobOperationId, pidAlive: false } };
    const obs: LoadStopObservation = { jobOperationId, jobState: job.observation.state, pidAlive: job.observation.pidAlive };
    if (job.observation.status) obs.status = job.observation.status;
    return { state: 'present', observation: obs };
  }

  async verify(observation: LoadStopObservation): Promise<VerificationResult> {
    const terminal = observation.jobState === undefined || observation.jobState === 'completed' || observation.jobState === 'failed' || observation.jobState === 'stopped';
    if (terminal || !observation.pidAlive) {
      return { status: 'verified', result: { jobOperationId: observation.jobOperationId, finalState: observation.jobState ?? 'gone', ...summarizeResults(observation.status) } };
    }
    return { status: 'pending', progress: { jobOperationId: observation.jobOperationId, jobState: observation.jobState } };
  }
}

// ----------------------------------------------------------------------------- tools

export interface LoadToolOptions {
  /** Same state dir as the HttpLoadAdapter (enables job-status details and evidence dedupe across restarts). */
  stateDir?: string;
}

const HEADERS_SCHEMA: JsonSchema = { type: 'object', additionalProperties: { type: 'string', maxLength: 8192 }, maxProperties: 50 };

/**
 * Lower-cased header map. Header names are case-insensitive: without this, `X-Hypertest-Operation` from the
 * caller would be merged with the worker's own operation label into one comma-joined value.
 */
function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (Object.hasOwn(out, key)) throw new HypertestError('invalid_argument', `header ${key} is given more than once`);
    if (key === 'x-hypertest-operation') throw new HypertestError('invalid_argument', 'x-hypertest-operation is set by the load generator (operation-id labelling)');
    out[key] = String(v);
  }
  return out;
}

export const LOAD_START_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    environmentId: ENV_ID_SCHEMA,
    targetUrl: { type: 'string', minLength: 1, maxLength: 4096 },
    path: { type: 'string', maxLength: 4096, pattern: '^/(?!/)' },
    method: { type: 'string', enum: [...HTTP_METHODS] },
    ratePerSecond: { type: 'number', exclusiveMinimum: 0, maximum: 10_000 },
    durationMs: { type: 'integer', minimum: 100, maximum: 3_600_000 },
    concurrency: { type: 'integer', minimum: 1, maximum: 1000 },
    body: { type: 'string', maxLength: 1024 * 1024 },
    headers: HEADERS_SCHEMA,
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
  },
  required: ['method', 'ratePerSecond', 'durationMs'],
  allOf: [{ anyOf: [{ required: ['targetUrl'] }, { required: ['environmentId'] }] }, { not: { required: ['targetUrl', 'environmentId'] } }, { not: { required: ['targetUrl', 'path'] } }],
};

function boundOnly(id: string): ToolSpec['execute'] {
  return async () => ({ status: 'failed', error: { code: 'precondition_failed', message: `${id} runs only through the ToolRuntime's SideEffectGateway` } });
}

function loadTargetResources(input: LoadStartInput, envs: EnvironmentRegistry): string[] {
  const { url } = resolveLoadTarget(input, envs);
  const primary = input.environmentId !== undefined ? `env/${input.environmentId}` : `url/${hostSegment(url)}`;
  return [primary, `loadgen/${hostSegment(url)}`];
}

/**
 * `load.start` — starts a built-in HTTP load job (external/high). Bound to the `load.http` adapter: the
 * runtime runs it through the SideEffectGateway with a stable operation id, so a retried or resumed call
 * re-attaches to the same job instead of starting another. Usually returns `pending` with the operation
 * id; follow up with `load.observe`.
 *
 * Egress: the same guard as http.request, enforced when the runtime derives the side-effect target (before
 * any operation is prepared): the permit's `allowedHosts` bound, then the addressed environment's origins,
 * `httpAllowlist`, or loopback for class `local`; supervisor control endpoints are never load targets.
 */
export function loadStartTool(options: { httpAllowlist?: string[] } = {}): ToolSpec<LoadStartInput> {
  return {
    id: 'load.start',
    title: 'Start HTTP load job',
    description: 'Start an open-loop HTTP load job (ratePerSecond for durationMs) against targetUrl or environmentId+path. Returns an operation id; poll it with load.observe. Never re-issue load.start to check progress.',
    inputSchema: LOAD_START_INPUT_SCHEMA,
    effect: 'external',
    riskClass: 'high',
    resources: (input, ctx) => loadTargetResources(input, ctx.environments),
    environmentClass: (input, ctx) => resolveLoadTarget(input, ctx.environments).environmentClass,
    sideEffect: {
      adapterId: LOAD_ADAPTER_ID,
      operationType: 'load.start',
      target: (input, ctx) => {
        const t = resolveLoadTarget(input as LoadStartInput, ctx.environments);
        const egress = checkEgress(t.url, { allowlist: options.httpAllowlist, permitHosts: ctx.permit?.constraints?.allowedHosts, environmentClass: t.environmentClass, trustedOrigins: t.trustedOrigins }, ctx.environments);
        if (!egress.allowed) throw new HypertestError('permission_denied', `load target refused: ${egress.reason}`);
        return { resourceKey: `loadgen/${hostSegment(t.url)}`, kind: 'load_job' };
      },
    },
    timeoutMs: 30_000,
    execute: boundOnly('load.start'),
  };
}

/** In-process dedupe of results evidence per (run, operation); bounded (the state-dir marker is durable). */
const evidenceByJob = new Map<string, Promise<EvidenceRecord | { evidenceId: string }>>();

async function loadResultsEvidence(ctx: ToolContext, stateDir: string | undefined, operationId: string, result: { results?: Record<string, unknown> }): Promise<string> {
  const key = `${ctx.runId}\u0000${operationId}`;
  let pending = evidenceByJob.get(key);
  if (!pending) {
    pending = (async () => {
      const markerPath = stateDir ? join(stateDir, 'load-evidence', `${assertOperationId(operationId)}.json`) : undefined;
      if (markerPath) {
        const marker = await readJsonFile<{ runId?: string; evidenceId?: string }>(markerPath);
        if (marker.kind === 'ok' && marker.value.runId === ctx.runId && typeof marker.value.evidenceId === 'string') return { evidenceId: marker.value.evidenceId };
      }
      const r = (result.results ?? {}) as { sent?: number; ok?: number; errors?: number; achievedRps?: number; latencyMs?: { p95?: number | null } };
      const rec = await ctx.recordEvidence({
        evidenceType: 'metric',
        data: JSON.stringify({ operationId, ...result.results }, null, 2),
        mimeType: 'application/json',
        summary: `load job ${operationId}: sent ${r.sent ?? 0}, ok ${r.ok ?? 0}, errors ${r.errors ?? 0}, p95 ${r.latencyMs?.p95 ?? 'n/a'} ms, achieved ${r.achievedRps ?? 'n/a'} rps`,
        structured: { source: 'loadgen', operationId, ...(result.results ?? {}) } as JsonValue,
        operationId,
      });
      if (markerPath) {
        try {
          await mkdir(join(stateDir!, 'load-evidence'), { recursive: true });
          await writeJsonAtomic(markerPath, { runId: ctx.runId, evidenceId: rec.evidenceId });
        } catch (e) {
          ctx.logger.warn('load evidence marker could not be written', { operationId, error: errorMessage(e) });
        }
      }
      return rec;
    })();
    setBounded(evidenceByJob, key, pending);
    pending.catch(() => evidenceByJob.delete(key));
  }
  return (await pending).evidenceId;
}

function jobStatusSnapshot(stateDir: string | undefined, operationId: string): LoadJobStatus | undefined {
  if (!stateDir) return undefined;
  try {
    return readJsonFileSync<LoadJobStatus>(join(loadJobDir(stateDir, operationId), 'status.json'));
  } catch {
    return undefined;
  }
}

function operationOutcomeToTool(outcome: SideEffectOutcome, extra: Record<string, unknown>): ToolOutcome {
  const base = { operationId: outcome.operation.operationId, operationStatus: outcome.operation.status, ...extra };
  if (outcome.status === 'pending') {
    return {
      status: 'pending',
      operationId: outcome.operation.operationId,
      structured: { ...base, ...(outcome.progress !== undefined ? { progress: outcome.progress } : {}) } as JsonValue,
      text: `load job ${outcome.operation.operationId} is still ${outcome.operation.status}${outcome.progress !== undefined ? `: ${JSON.stringify(outcome.progress)}` : ''}`,
    };
  }
  if (outcome.status === 'verified') return { status: 'success', operationId: outcome.operation.operationId, structured: base as JsonValue };
  return { status: 'failed', operationId: outcome.operation.operationId, error: { code: outcome.status, message: outcome.reason }, structured: { ...base, reason: outcome.reason } as JsonValue };
}

/**
 * `load.observe` — polls a load operation through the SideEffectGateway (observe → verify). A completed
 * job's results are recorded ONCE per (run, operation) as `metric` evidence (with the operation id);
 * repeated observations return the same evidence id. Running jobs return `pending` with progress.
 */
export function loadObserveTool(options: LoadToolOptions = {}): ToolSpec<{ operationId: string }> {
  return {
    id: 'load.observe',
    title: 'Observe HTTP load job',
    description: 'Poll a load job started by load.start (by operation id): progress while running; final results (recorded once as metric evidence) when completed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { operationId: OPERATION_ID_SCHEMA }, required: ['operationId'] },
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`loadjob/${assertOperationId(input.operationId)}`],
    timeoutMs: 30_000,
    async execute(input, ctx) {
      if (!ctx.sideEffects) return { status: 'failed', error: { code: 'precondition_failed', message: 'load.observe needs a SideEffectGateway' } };
      // Run isolation: a job launched by another run is neither driven nor reported (checked before observing
      // when the state dir knows the job's run, and again on the ledger record).
      const foreign = { status: 'failed' as const, error: { code: 'permission_denied', message: `operation ${input.operationId} belongs to another run` } };
      if (options.stateDir !== undefined) {
        const owner = jobRunId(options.stateDir, input.operationId);
        if (owner !== undefined && owner !== ctx.runId) return foreign;
      }
      let outcome: SideEffectOutcome;
      try {
        outcome = await ctx.sideEffects.observe(input.operationId, ctx.eventContext, ctx.signal);
      } catch (e) {
        if (isHypertestError(e) && e.code !== 'cancelled' && e.code !== 'timeout') return { status: 'failed', error: { code: e.code, message: e.message } };
        throw e;
      }
      if (outcome.operation.runId !== ctx.runId) return foreign;
      if (outcome.operation.adapterId !== LOAD_ADAPTER_ID) {
        return { status: 'failed', error: { code: 'invalid_argument', message: `operation ${input.operationId} is a ${outcome.operation.operationType} operation, not a load job` } };
      }
      if (outcome.status === 'verified') {
        const result = (outcome.result ?? {}) as { results?: Record<string, unknown>; state?: string };
        const evidenceId = await loadResultsEvidence(ctx, options.stateDir, input.operationId, result);
        const out = operationOutcomeToTool(outcome, { state: 'completed', results: result.results ?? {}, evidenceId });
        out.evidenceRefs = [evidenceId];
        return out;
      }
      const job = jobStatusSnapshot(options.stateDir, input.operationId);
      return operationOutcomeToTool(outcome, job ? { jobStatus: summarizeResults(job), jobState: job.state } : {});
    },
  };
}

function loadStopEnvironmentClass(stateDir: string | undefined, operationId: string): string | undefined {
  const known = jobEnvironmentClass.get(operationId);
  if (known !== undefined) return known;
  if (!stateDir) return undefined;
  const spec = readJsonFileSync<LoadJobSpec>(join(loadJobDir(stateDir, operationId), 'spec.json'));
  return typeof spec?.environmentClass === 'string' ? spec.environmentClass : undefined;
}

/**
 * `load.stop` — stops a running load job (external/medium) as its own governed operation (adapter
 * `load.http.stop`): SIGTERM to the job's worker, verified when the job is terminal. The environment
 * class is the job's (from spec.json in the state dir, or the in-process record).
 */
export function loadStopTool(options: LoadToolOptions = {}): ToolSpec<{ operationId: string }> {
  return {
    id: 'load.stop',
    title: 'Stop HTTP load job',
    description: 'Stop a running load job started by load.start (by its operation id). Idempotent.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { operationId: OPERATION_ID_SCHEMA }, required: ['operationId'] },
    effect: 'external',
    riskClass: 'medium',
    resources: (input) => [`loadjob/${assertOperationId(input.operationId)}`],
    environmentClass: (input) => loadStopEnvironmentClass(options.stateDir, input.operationId),
    sideEffect: {
      adapterId: LOAD_STOP_ADAPTER_ID,
      operationType: 'load.stop',
      target: (input) => {
        const id = assertOperationId((input as { operationId: string }).operationId);
        return { resourceKey: `loadjob/${id}`, kind: 'load_job', externalId: id };
      },
    },
    timeoutMs: 30_000,
    execute: boundOnly('load.stop'),
  };
}
