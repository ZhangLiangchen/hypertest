/**
 * PoC fixtures (the systems under test live in `packages/eval/fixtures/` as plain JS without dependencies):
 *
 * - `createLedgerRepo`  — PoC A / oracle-robustness: a git repository of the `ledger` library; commit 1 (base) is
 *   correct, commit 2 "refactor pagination" (head) seeds the regression `slice(start, start + size - 1)`.
 * - `startBankApi`      — PoC B: `fixtures/bank-api/server.js` as a child process on a free loopback port (hidden
 *   defect: negative transfer amounts are accepted and move money backwards).
 * - `startKvService`    — PoC C / recovery-chaos: `fixtures/kv-service/server.js` under the Hypertest process
 *   supervisor (restart through `env.restart`, operation records persisted in a state file).
 * - `readObservations`  — the scripted brains' observation log (what the "model" saw), JSON lines.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HypertestError, sleep, type JsonValue } from '@hypertest/core';
import { startProcessSupervisor, type ProcessSupervisor } from '@hypertest/tools';

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
}

/** Starts kv-service under the process supervisor (operation records persisted: a restart is reconcilable by id). */
export async function startKvService(options: KvServiceOptions): Promise<ProcessSupervisor> {
  await mkdir(options.stateDir, { recursive: true });
  return startProcessSupervisor({
    command: [process.execPath, KV_SERVICE_SERVER],
    cwd: options.stateDir,
    inheritEnv: false,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', KV_WARMUP_MS: String(options.warmupMs ?? 0), KV_MAX_LATENCY_MS: String(options.maxLatencyMs ?? 6) },
    stateFile: join(options.stateDir, 'supervisor-state.json'),
    logFile: join(options.stateDir, 'kv-service.log'),
    readyTimeoutMs: 20_000,
  });
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

/** Kills load workers still running under a state dir (fixture cleanup: nothing outlives a trial). */
export async function killLoadWorkers(stateDir: string): Promise<void> {
  for (const job of loadJobs(stateDir)) {
    if (job.pid === undefined) continue;
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
