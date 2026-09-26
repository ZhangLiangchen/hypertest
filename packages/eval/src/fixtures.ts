/**
 * PoC fixtures (the systems under test live in `packages/eval/fixtures/` as plain JS without dependencies):
 *
 * - `createLedgerRepo`  — PoC A / oracle-robustness: a git repository of the `ledger` library; commit 1 (base) is
 *   correct, commit 2 "refactor pagination" (head) seeds the regression `slice(start, start + size - 1)`.
 * - `startBankApi`      — PoC B: `fixtures/bank-api/server.js` as a child process on a free loopback port (hidden
 *   defect: negative transfer amounts are accepted and move money backwards).
 * - `startKvService`    — PoC C / recovery-chaos: `fixtures/kv-service/server.js` under the Hypertest process
 *   supervisor running as its own process (restart through `env.restart`, operation records persisted in a state
 *   file; the service's latency never depends on the harness's event loop).
 * - `readObservations`  — the scripted brains' observation log (what the "model" saw), JSON lines.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HypertestError, sleep, type JsonValue } from '@hypertest/core';
import { PROCESS_SUPERVISOR_CLI_PATH, type SupervisorOperation } from '@hypertest/tools';

const exec = promisify(execFile);

/** Absolute path of `packages/eval/fixtures/`. */
export const FIXTURES_DIR: string = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const BANK_API_SERVER: string = join(FIXTURES_DIR, 'bank-api', 'server.js');
export const KV_SERVICE_SERVER: string = join(FIXTURES_DIR, 'kv-service', 'server.js');

// ------------------------------------------------------------------------------------------------ git (ledger)

async function git(cwd: string, args: string[], options: { raw?: boolean } = {}): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ledger Maintainer',
      GIT_AUTHOR_EMAIL: 'maintainer@ledger.invalid',
      GIT_COMMITTER_NAME: 'Ledger Maintainer',
      GIT_COMMITTER_EMAIL: 'maintainer@ledger.invalid',
    },
  });
  return options.raw ? stdout : stdout.trim();
}

export interface LedgerRepo {
  path: string;
  /** The correct initial commit (known-good base). */
  base: string;
  /** The candidate: commit "refactor pagination" with the seeded regression. */
  head: string;
}

/**
 * Creates the ledger repository inside `parentDir` (a trial directory: removed with it). `withPaginationTest` adds a
 * multi-page pagination test to the initial commit (oracle-robustness: the suite fails on the candidate).
 */
export async function createLedgerRepo(parentDir: string, options: { withPaginationTest?: boolean } = {}): Promise<LedgerRepo> {
  await mkdir(parentDir, { recursive: true });
  const path = await mkdtemp(join(parentDir, 'ledger-'));
  const src = join(FIXTURES_DIR, 'ledger');
  await cp(join(src, 'v1'), path, { recursive: true });
  if (options.withPaginationTest) await cp(join(src, 'extra'), path, { recursive: true });
  await git(path, ['init', '-q', '-b', 'main']);
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-q', '-m', 'initial ledger library']);
  const base = await git(path, ['rev-parse', 'HEAD']);
  await cp(join(src, 'v2'), path, { recursive: true });
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-q', '-m', 'refactor pagination']);
  const head = await git(path, ['rev-parse', 'HEAD']);
  return { path, base, head };
}

/** A file of the repository at a revision (probes: the candidate's test code must be unchanged after the run). */
export async function gitShowFile(repoPath: string, rev: string, file: string): Promise<string> {
  return git(repoPath, ['show', `${rev}:${file}`], { raw: true });
}

// ------------------------------------------------------------------------------------------------ bank-api

export interface BankApi {
  url: string;
  pid: number;
  /** Mutating requests the server observed per Idempotency-Key (ground truth for duplicate side effects). */
  effects(): Promise<Record<string, number>>;
  /** GET /health of the server (ground truth for the balance invariant). */
  health(): Promise<{ total: number; deposited: number; balanceConserved: boolean; accounts: number }>;
  close(): Promise<void>;
}

async function stopChild(child: ChildProcess, graceMs = 2000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the bank API on a free loopback port (the server prints `{"port": N}` once it listens). */
export async function startBankApi(options: { readyTimeoutMs?: number } = {}): Promise<BankApi> {
  const child = spawn(process.execPath, [BANK_API_SERVER], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PORT: '0' } });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new HypertestError('timeout', 'bank-api did not start listening in time')), options.readyTimeoutMs ?? 15_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve((JSON.parse(buf.slice(0, nl)) as { port: number }).port);
      } catch (e) {
        reject(e as Error);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new HypertestError('unavailable', `bank-api exited before listening (code ${String(code)})`));
    });
  }).catch(async (e: unknown) => {
    await stopChild(child);
    throw e;
  });
  child.stdout!.resume();
  const url = `http://127.0.0.1:${port}`;
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new HypertestError('unavailable', `bank-api ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    url,
    pid: child.pid!,
    effects: async () => (await getJson<{ effects: Record<string, number> }>('/__eval/effects')).effects,
    health: () => getJson('/health'),
    close: () => stopChild(child),
  };
}

// ------------------------------------------------------------------------------------------------ kv-service

export interface KvServiceOptions {
  /** Directory for the supervisor's state file and the service log. */
  stateDir: string;
  /** Delay before the service listens after a (re)start (keeps a restart in flight; default 0). */
  warmupMs?: number;
  /** Upper bound of the random per-request latency (default 6 ms). */
  maxLatencyMs?: number;
  /** How long to wait for the supervisor to report the service ready (default 20 000 ms). */
  readyTimeoutMs?: number;
}

/** kv-service under its own process supervisor (see startKvService). */
export interface KvService {
  /** Public URL (the supervisor's proxy): EnvironmentDescriptor.baseUrl. */
  readonly url: string;
  /** Control target WITH the control token (EnvironmentDescriptor.control.target, kind `process`). A secret. */
  readonly controlUrl: string;
  /** Control API base URL without the token (status and operation lookups). */
  readonly controlBaseUrl: string;
  /** Pid of the supervisor process. */
  readonly pid: number;
  /** The supervisor's current generation (1 = first start; +1 per restart): GET /__hypertest/status. */
  generation(): Promise<number>;
  /** The operation records the supervisor persisted (restarts per operation id): ground truth for side effects. */
  operations(): SupervisorOperation[];
  /** Stops the supervisor and the service (SIGTERM, SIGKILL after a grace period). Idempotent. */
  close(): Promise<void>;
}

/**
 * Starts kv-service under the Hypertest process supervisor running as ITS OWN PROCESS (`PROCESS_SUPERVISOR_CLI_PATH`):
 * the supervisor proxies every request to the service, so hosting it in the harness process would make the service's
 * latency depend on the event loop of the system under evaluation (an in-process trial runs Hypertest there). Its
 * operation records are persisted in `<stateDir>/supervisor-state.json` (a restart is reconcilable by operation id).
 */
export async function startKvService(options: KvServiceOptions): Promise<KvService> {
  await mkdir(options.stateDir, { recursive: true });
  const stateFile = join(options.stateDir, 'supervisor-state.json');
  const args = [
    '--no-warnings', PROCESS_SUPERVISOR_CLI_PATH, '--port', '0', '--cwd', options.stateDir, '--state-file', stateFile, '--log-file', join(options.stateDir, 'kv-service.log'),
    '--env', `KV_WARMUP_MS=${options.warmupMs ?? 0}`, '--env', `KV_MAX_LATENCY_MS=${options.maxLatencyMs ?? 6}`, '--', process.execPath, KV_SERVICE_SERVER,
  ];
  const errFd = openSync(join(options.stateDir, 'supervisor.err'), 'a');
  let child: ChildProcess;
  try {
    // a scrubbed environment: the service inherits nothing of the harness but PATH
    child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', errFd], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
  } finally {
    closeSync(errFd);
  }
  let info: { url: string; controlUrl: string; controlBaseUrl: string; childPid: number | null };
  try {
    info = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new HypertestError('timeout', 'kv-service supervisor did not report ready in time')), options.readyTimeoutMs ?? 20_000);
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as typeof info);
        } catch (e) {
          reject(e as Error);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new HypertestError('unavailable', `kv-service supervisor exited before it was ready (code ${String(code)}; see ${join(options.stateDir, 'supervisor.err')})`));
      });
    });
  } catch (e) {
    await stopChild(child, 5000);
    throw e;
  }
  child.stdout!.resume();
  const status = async (): Promise<{ generation: number; childPid: number | null }> => {
    const res = await fetch(`${info.controlBaseUrl}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new HypertestError('unavailable', `kv-service supervisor status answered ${res.status}`);
    return (await res.json()) as { generation: number; childPid: number | null };
  };
  let closing: Promise<void> | undefined;
  return {
    url: info.url,
    controlUrl: info.controlUrl,
    controlBaseUrl: info.controlBaseUrl,
    pid: child.pid!,
    generation: async () => (await status()).generation,
    operations() {
      try {
        return (JSON.parse(readFileSync(stateFile, 'utf8')) as { operations?: SupervisorOperation[] }).operations ?? [];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
    },
    close() {
      closing ??= (async () => {
        // the CURRENT service pid (a restart replaces it), for the case the supervisor cannot stop it itself
        const servicePid = child.exitCode === null && child.signalCode === null ? await status().then((s) => s.childPid, () => info.childPid) : null;
        // SIGTERM: the supervisor stops the service (its own grace period) and exits
        await stopChild(child, 8000);
        if (child.signalCode === 'SIGKILL' && servicePid !== null) {
          try {
            process.kill(-servicePid, 'SIGKILL'); // the service leads its own process group (detached)
          } catch {
            // already gone
          }
        }
      })();
      return closing;
    },
  };
}

/** Load job directories created under a Hypertest state dir (`<stateDir>/loadjobs/<operationId>`), with their worker pid. */
export function loadJobs(stateDir: string): Array<{ operationId: string; pid?: number; state?: string }> {
  const root = join(stateDir, 'loadjobs');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((operationId) => {
      const out: { operationId: string; pid?: number; state?: string } = { operationId };
      try {
        const pid = Number.parseInt(readFileSync(join(root, operationId, 'pid'), 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) out.pid = pid;
      } catch {
        // no worker pid recorded
      }
      try {
        const status = JSON.parse(readFileSync(join(root, operationId, 'status.json'), 'utf8')) as { state?: unknown };
        if (typeof status.state === 'string') out.state = status.state;
      } catch {
        // no status yet
      }
      return out;
    });
}

/**
 * Whether `pid` is (still) the worker of the load job `operationId`: a live process whose argv carries the job
 * directory (`…/loadjobs/<operationId>`, as the load adapter launches it). A recorded pid outlives its worker — the
 * worker exits by itself when the job finishes — and the kernel reuses pids (pid_max is often 32768), so a bare
 * `kill(pid)` could hit an unrelated process. Without /proc (non-Linux) the pid is trusted only while the job has not
 * reported a terminal state.
 */
export function isLoadWorker(pid: number, job: { operationId: string; state?: string }): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return job.state === undefined || job.state === 'starting' || job.state === 'running';
  }
  const marker = `${sep}${join('loadjobs', job.operationId)}`;
  return cmdline.split('\0').some((arg) => arg.endsWith(marker));
}

/**
 * Kills the load workers still running under a state dir (fixture cleanup: nothing outlives a trial). Only a pid that
 * still belongs to its job's worker is signalled (see isLoadWorker): never a process that reused a recorded pid.
 */
export async function killLoadWorkers(stateDir: string): Promise<void> {
  for (const job of loadJobs(stateDir)) {
    if (job.pid === undefined || !isLoadWorker(job.pid, job)) continue;
    try {
      process.kill(job.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await sleep(10);
}

// ------------------------------------------------------------------------------------------------ brain observations

/** One observation of a scripted brain: what the "model" received on one call. */
export interface BrainObservation {
  provider: string;
  role: string;
  workItemId: string;
  kind: string;
  step: number;
  /** Bytes of the whole request (messages + tool definitions), as sent to the provider. */
  requestBytes: number;
  /** Largest single message content in the request (bytes). */
  maxMessageBytes: number;
  assistantMessages: number;
  toolMessages: number;
  /** The request contained the lead's private reasoning marker (a context-isolation breach for any other agent). */
  sawLeadTrace: boolean;
  /** Free-form tag set by the brain (e.g. `after_large_output`). */
  tag?: string;
  /** (additive) Tool names offered to the model on this call (wire names, sorted): what the agent could do at all. */
  offeredTools?: string[];
}

/** Reads the brains' observation log (JSON lines; a missing file is an empty log). */
export function readObservations(file: string): BrainObservation[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as BrainObservation];
      } catch {
        return [];
      }
    });
}

/** JSON-safe copy (probe results must be JSON). */
export function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
