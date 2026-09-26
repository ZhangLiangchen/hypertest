/**
 * Parent side of child-process trials: spawning `src/trial-child.ts` on a JSON job file, tailing its JSON-lines
 * progress file, and the kill/restart helper that turns a chaos plan (`killAfterOperationDispatch`) into a real
 * SIGKILL of the Hypertest process followed by a resumed child over the same data directory.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HypertestError, sleep } from '@hypertest/core';
import type { QualityVerdict } from '@hypertest/domain';
import type { ChildExit, ChildTrialProcess, ChildTrialResult, KillPoint, TrialChildJob, TrialProgressEvent } from './contracts.ts';

/** Absolute path of the child entry module. */
export const TRIAL_CHILD_ENTRY: string = fileURLToPath(new URL('./trial-child.ts', import.meta.url));

/** Exit codes of a trial child: the verdict, or why there is none. */
export const TRIAL_EXIT_CODES = Object.freeze({
  pass: 0,
  fail: 1,
  conditional: 2,
  inconclusive: 3,
  /** The run ended without a verdict (cancelled/failed). */
  no_verdict: 4,
  /** The run did not finish within the job's timeout. */
  timeout: 5,
  /** The job file is missing or malformed. */
  invalid_job: 64,
  /** Any other fault (composition, brains module, store). */
  error: 70,
});

/** Exit code for a verdict. */
export function exitCodeForVerdict(verdict: QualityVerdict | undefined): number {
  return verdict === undefined ? TRIAL_EXIT_CODES.no_verdict : TRIAL_EXIT_CODES[verdict];
}

/** The verdict an exit code stands for (undefined for the non-verdict codes). */
export function verdictForExitCode(code: number | null): QualityVerdict | undefined {
  switch (code) {
    case 0:
      return 'pass';
    case 1:
      return 'fail';
    case 2:
      return 'conditional';
    case 3:
      return 'inconclusive';
    default:
      return undefined;
  }
}

/** Parses a JSON-lines progress text; a trailing partial line (still being written) is ignored. */
export function parseProgress(text: string): TrialProgressEvent[] {
  const out: TrialProgressEvent[] = [];
  const lines = text.split('\n');
  lines.pop(); // incomplete (or empty) last line
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as TrialProgressEvent);
    } catch {
      // a torn line of a killed writer: skip it
    }
  }
  return out;
}

/** Reads a whole progress file (missing ⇒ []). */
export function readProgress(file: string): TrialProgressEvent[] {
  try {
    return parseProgress(readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export interface SpawnTrialChildOptions {
  /** Where the job JSON is written. */
  jobFile: string;
  /** File receiving the child's stdout+stderr (default: `<jobFile>.out`). */
  outputFile?: string;
  /** Child entry module (default TRIAL_CHILD_ENTRY; tests substitute a fake). */
  entry?: string;
  /** Progress tail interval (default 20 ms). */
  pollMs?: number;
  /** Environment of the child (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Writes the job file and spawns the child (`node <entry> <jobFile>`). The progress file is tailed while the child
 * runs; every timer and handle is released when the child exits.
 */
export async function spawnTrialChild(job: TrialChildJob, options: SpawnTrialChildOptions): Promise<ChildTrialProcess> {
  writeFileSync(options.jobFile, JSON.stringify(job, null, 2));
  // this child's lines only: an earlier child of the same trial may have written to the progress file already
  let offset = fileSize(job.progressFile);
  const outputFile = options.outputFile ?? `${options.jobFile}.out`;
  const fd = openSync(outputFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [options.entry ?? TRIAL_CHILD_ENTRY, options.jobFile], { stdio: ['ignore', fd, fd], env: options.env ?? process.env });
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', reject);
    });
  } finally {
    closeSync(fd);
  }
  const progress: TrialProgressEvent[] = [];
  const waiters = new Set<() => void>();
  let buffered = '';
  const pump = (): void => {
    let size: number;
    try {
      size = statSync(job.progressFile).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fdp = openSync(job.progressFile, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const n = readSyncFully(fdp, buf, offset);
      offset += n;
      buffered += buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fdp);
    }
    const complete = buffered.lastIndexOf('\n');
    if (complete < 0) return;
    progress.push(...parseProgress(buffered.slice(0, complete + 1)));
    buffered = buffered.slice(complete + 1);
    for (const w of [...waiters]) w();
  };
  const timer = setInterval(pump, options.pollMs ?? 20);
  let exited = false;
  const exit = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      clearInterval(timer);
      pump();
      exited = true;
      for (const w of [...waiters]) w();
      resolve({ code, signal });
    });
  });
  const pid = child.pid!;
  return {
    pid,
    progress,
    exit,
    waitFor(predicate, opts = {}) {
      return new Promise<TrialProgressEvent | undefined>((resolve) => {
        let scanned = 0;
        let deadline: NodeJS.Timeout | undefined;
        const done = (value: TrialProgressEvent | undefined): void => {
          waiters.delete(check);
          if (deadline) clearTimeout(deadline);
          resolve(value);
        };
        function check(): void {
          for (; scanned < progress.length; scanned++) {
            if (predicate(progress[scanned]!, progress)) return done(progress[scanned]);
          }
          if (exited) done(undefined);
        }
        waiters.add(check);
        if (opts.timeoutMs !== undefined) deadline = setTimeout(() => done(undefined), opts.timeoutMs);
        check();
      });
    },
    async kill(signal: NodeJS.Signals = 'SIGKILL') {
      if (!exited) child.kill(signal);
      return exit;
    },
  };
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readSyncFully(fd: number, buf: Buffer, position: number): number {
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

export interface RunChildTrialOptions extends Omit<SpawnTrialChildOptions, 'jobFile' | 'outputFile'> {
  /** Directory for job/output files (`child-<attempt>.json`, `child-<attempt>.out`). */
  workDir: string;
  /** Kill the child (SIGKILL) once this many `operation.dispatched` progress lines were seen, then resume. */
  killAfterOperationDispatch?: number;
  /** (additive) Kill points, in order (after `killAfterOperationDispatch`): each one SIGKILLs the running child and resumes. */
  kills?: KillPoint[];
  /** Overall deadline for all children (the child still running at the deadline is killed). */
  timeoutMs: number;
}

/** The ledger state a kill point waits for (`operation` progress lines carry the state an operation moved `to`). */
export const KILL_POINT_STATES: Readonly<Record<KillPoint['after'], string>> = Object.freeze({ dispatched: 'dispatching', acknowledged: 'acknowledged', verified: 'verified' });

/** Problems of a kill point (checked before any environment exists). */
export function killPointProblems(point: unknown, label = 'kill point'): string[] {
  if (!point || typeof point !== 'object' || Array.isArray(point)) return [`${label} must be an object`];
  const p = point as Partial<KillPoint>;
  const out: string[] = [];
  if (typeof p.after !== 'string' || !Object.hasOwn(KILL_POINT_STATES, p.after)) out.push(`${label}.after must be one of ${Object.keys(KILL_POINT_STATES).join(', ')}, got ${String(p.after)}`);
  if (p.operationType !== undefined && (typeof p.operationType !== 'string' || p.operationType === '')) out.push(`${label}.operationType must be a non-empty string`);
  if (p.nth !== undefined && !(Number.isSafeInteger(p.nth) && p.nth >= 1)) out.push(`${label}.nth must be a positive integer, got ${String(p.nth)}`);
  if (p.delayMs !== undefined && !(Number.isSafeInteger(p.delayMs) && p.delayMs >= 0)) out.push(`${label}.delayMs must be a non-negative integer, got ${String(p.delayMs)}`);
  return out;
}

/**
 * Number of distinct operations (of the point's `operationType`, when given) that reached the point's state in the
 * progress lines (operation ids deduplicated: a reconciliation back into the same state is the same operation).
 */
export function killPointCount(progress: readonly TrialProgressEvent[], point: KillPoint): number {
  const to = KILL_POINT_STATES[point.after];
  const ids = new Set<string>();
  for (const e of progress) {
    if (e.type !== 'operation' || e.to !== to) continue;
    if (point.operationType !== undefined && e.operationType !== point.operationType) continue;
    ids.add(e.operationId);
  }
  return ids.size;
}

/** A human-readable label of a kill point (error messages, reports). */
export function describeKillPoint(point: KillPoint): string {
  return `after ${point.after} of ${point.operationType ?? 'any operation'}${(point.nth ?? 1) > 1 ? ` #${point.nth}` : ''}${point.delayMs ? ` + ${point.delayMs} ms` : ''}`;
}

/**
 * Number of distinct operations dispatched so far (operation.dispatched progress lines, by operation id): the ledger
 * emits operation.dispatched on every transition into `dispatching`, so a re-dispatch of the same operation (e.g. after
 * not_applied) is one dispatched operation, not two.
 */
export function dispatchCount(progress: readonly TrialProgressEvent[]): number {
  const ids = new Set<string>();
  for (const e of progress) if (e.type === 'operation' && e.eventType === 'operation.dispatched') ids.add(e.operationId);
  return ids.size;
}

/**
 * Runs a trial child and, when `killAfterOperationDispatch` is set, SIGKILLs it right after the N-th dispatched
 * operation and starts a `resume` child on the same job (fresh process, same data directory — the durable runtime,
 * sessions and the operation ledger must re-attach instead of re-creating). The chaos model-timeout injection only
 * applies to the first child. Returns the last child's exit status and every progress line.
 */
export async function runChildTrial(job: TrialChildJob, options: RunChildTrialOptions): Promise<ChildTrialResult> {
  const { workDir, killAfterOperationDispatch, kills: killPoints = [], timeoutMs, ...spawnOptions } = options;
  if (killAfterOperationDispatch !== undefined && (!Number.isSafeInteger(killAfterOperationDispatch) || killAfterOperationDispatch < 1)) {
    throw new HypertestError('invalid_argument', `killAfterOperationDispatch must be a positive integer, got ${String(killAfterOperationDispatch)}`);
  }
  if (!Array.isArray(killPoints)) throw new HypertestError('invalid_argument', 'kills must be an array of kill points');
  const pointProblems = killPoints.flatMap((p, i) => killPointProblems(p, `kills[${i}]`));
  if (pointProblems.length > 0) throw new HypertestError('invalid_argument', pointProblems.join('; '));
  const deadline = Date.now() + timeoutMs;
  const all: TrialProgressEvent[] = [];
  let kills = 0;
  let killPointsHit = 0;
  let timedOut = false;
  let chaosExercised = killAfterOperationDispatch === undefined && killPoints.length === 0;
  const start = async (attempt: number, mode: 'start' | 'resume'): Promise<ChildTrialProcess> => {
    const j: TrialChildJob = { ...job, mode, attempt };
    if (attempt > 1 && job.chaos) {
      // the model-timeout injection belongs to the first child only
      const { injectModelTimeoutOnCall: _once, ...rest } = job.chaos;
      j.chaos = rest;
    }
    return spawnTrialChild(j, { ...spawnOptions, jobFile: `${workDir}/child-${attempt}.json`, outputFile: `${workDir}/child-${attempt}.out` });
  };
  const finish = async (proc: ChildTrialProcess): Promise<ChildExit> => {
    const remaining = Math.max(0, deadline - Date.now());
    let timer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([
      proc.exit,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (exit !== 'timeout') return exit;
    timedOut = true;
    return proc.kill('SIGKILL');
  };

  // every kill point, in order: the first one reached SIGKILLs the running child and a resume child takes over; a point
  // that is never reached (the run finished, or the deadline passed) ends the chaos plan there
  const points: Array<{ reached: (progress: readonly TrialProgressEvent[]) => boolean; killPoint: boolean; delayMs: number }> = [];
  if (killAfterOperationDispatch !== undefined) points.push({ reached: (p) => dispatchCount(p) >= killAfterOperationDispatch, killPoint: false, delayMs: 0 });
  for (const k of killPoints) points.push({ reached: (p) => killPointCount(p, k) >= (k.nth ?? 1), killPoint: true, delayMs: k.delayMs ?? 0 });
  let attempt = 1;
  let proc = await start(attempt, job.mode);
  let exercised = 0;
  for (const point of points) {
    // counted over the whole trial: the earlier children's lines + this child's
    const hit = await proc.waitFor((_e, progress) => point.reached([...all, ...progress]), { timeoutMs: Math.max(0, deadline - Date.now()) });
    if (!hit) break;
    if (point.delayMs > 0) await sleep(Math.min(point.delayMs, Math.max(0, deadline - Date.now())));
    await proc.kill('SIGKILL');
    all.push(...proc.progress);
    kills++;
    exercised++;
    if (point.killPoint) killPointsHit++;
    proc = await start(++attempt, 'resume');
  }
  if (exercised === points.length) chaosExercised = true;
  const exit = await finish(proc);
  all.push(...proc.progress);
  return { exit, kills, killPointsHit, chaosExercised, timedOut, progress: all };
}
