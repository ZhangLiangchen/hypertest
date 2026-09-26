/**
 * Trial child: `node packages/eval/src/trial-child.ts <job.json>`.
 *
 * Runs ONE Hypertest process of a child-process trial: reads the TrialChildJob, loads the brains module (and the
 * optional task module), composes Hypertest over the job's configuration (chaos: model-timeout injection, duplicate
 * event delivery on the in-process bus), then either starts the run (`start`, the parent fixes the runId) or resumes
 * the incomplete runs of the data directory (`resume`, after the previous child was killed), and awaits the run.
 * While it runs, L0 is polled and the events of interest are appended to the progress file as JSON lines:
 * operation status changes, work transitions, run transitions, then `completed` (or `error`). The process exits with
 * the verdict code (TRIAL_EXIT_CODES) after closing everything it opened.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HypertestError, isHypertestError, sleep, type EventBus, type JsonValue, type Logger, type LogLevel } from '@hypertest/core';
import { isTerminalRun, type DomainEvent } from '@hypertest/domain';
import type { ScriptedBrain } from '@hypertest/model';
import { InProcessEventBus } from '@hypertest/collab';
import { createHypertest, type HypertestInstance, type HypertestOverrides } from '@hypertest/app';
import type { ChildBrainContext, EvalTask, TrialChildJob, TrialProgressEvent } from './contracts.ts';
import { TRIAL_EXIT_CODES, exitCodeForVerdict, readProgress } from './child.ts';
import { withModelTimeoutInjection } from './brains.ts';
import { establishOracles } from './oracles.ts';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 20;

type ProgressBody = TrialProgressEvent extends infer E ? (E extends TrialProgressEvent ? Omit<E, 'pid' | 'at'> : never) : never;

function progressWriter(file: string): (e: ProgressBody) => void {
  // a line torn by a killed predecessor is terminated first, so it can never swallow this child's first line
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) appendFileSync(file, '\n');
  } catch {
    // no progress file yet
  }
  return (e) => {
    const line = `${JSON.stringify({ ...e, pid: process.pid, at: new Date().toISOString() })}\n`;
    try {
      appendFileSync(file, line);
    } catch (err) {
      // never let reporting crash the child (an uncaught crash would exit 1, which reads as a `fail` verdict)
      process.stderr.write(`trial-child: progress line could not be written (${(err as Error).message}): ${line}`);
    }
  };
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger appending synchronously to a file (nothing is lost when the process is killed). */
function fileLogger(file: string, level: LogLevel = 'warn', base: Record<string, unknown> = {}): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    try {
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, pid: process.pid, ...base, ...fields })}\n`);
    } catch {
      // logging never fails the trial
    }
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (f) => fileLogger(file, level, { ...base, ...f }),
  };
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function jobProblems(job: unknown): string[] {
  const problems: string[] = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) return ['the job must be a JSON object'];
  const j = job as Record<string, unknown>;
  if (!j['config'] || typeof j['config'] !== 'object') problems.push('config must be an object');
  for (const k of ['brainsModule', 'brainsExport', 'progressFile'] as const) if (typeof j[k] !== 'string' || j[k] === '') problems.push(`${k} must be a non-empty string`);
  if (j['mode'] !== 'start' && j['mode'] !== 'resume') problems.push(`mode must be 'start' or 'resume'`);
  const input = j['input'] as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') problems.push('input must be an object');
  else {
    if (typeof input['runId'] !== 'string' || input['runId'] === '') problems.push('input.runId must be a non-empty string (the parent fixes the run id)');
    if (j['mode'] === 'start' && typeof input['goal'] !== 'string') problems.push('input.goal must be a string');
  }
  if (j['timeoutMs'] !== undefined && !(typeof j['timeoutMs'] === 'number' && j['timeoutMs'] > 0)) problems.push('timeoutMs must be a positive number');
  if (j['oracles'] !== undefined && !(Array.isArray(j['oracles']) && j['oracles'].every((o) => o !== null && typeof o === 'object' && typeof (o as { oracleId?: unknown }).oracleId === 'string'))) {
    problems.push('oracles must be an array of oracle specs (each with an oracleId)');
  }
  return problems;
}

function moduleUrl(spec: string): string {
  if (spec.startsWith('file:')) return spec;
  return pathToFileURL(isAbsolute(spec) ? spec : resolve(spec)).href;
}

async function loadTask(job: TrialChildJob): Promise<EvalTask | undefined> {
  if (!job.taskModule) return undefined;
  const mod = (await import(moduleUrl(job.taskModule))) as Record<string, unknown>;
  const name = job.taskExport ?? 'task';
  const exp = mod[name];
  const task = typeof exp === 'function' ? await (exp as () => EvalTask | Promise<EvalTask>)() : exp;
  if (!task || typeof task !== 'object') throw new HypertestError('invalid_argument', `task module ${job.taskModule} has no task export '${name}'`);
  return task as EvalTask;
}

async function loadBrains(job: TrialChildJob, task: EvalTask | undefined): Promise<Record<string, ScriptedBrain>> {
  const mod = (await import(moduleUrl(job.brainsModule))) as Record<string, unknown>;
  const exp = mod[job.brainsExport];
  if (exp === undefined) throw new HypertestError('invalid_argument', `brains module ${job.brainsModule} has no export '${job.brainsExport}'`);
  let brains: unknown = exp;
  if (typeof exp === 'function') {
    const ctx: ChildBrainContext = { job, mode: job.mode, attempt: job.attempt ?? 1 };
    if (task) ctx.task = task;
    if (job.brainsArgs !== undefined) ctx.args = job.brainsArgs;
    brains = await (exp as (c: ChildBrainContext) => unknown)(ctx);
  }
  if (!brains || typeof brains !== 'object' || Array.isArray(brains) || Object.values(brains).some((b) => typeof b !== 'function')) {
    throw new HypertestError('invalid_argument', `brains export '${job.brainsExport}' must be (or return) a record of provider id → brain function`);
  }
  return brains as Record<string, ScriptedBrain>;
}

function progressFor(e: DomainEvent<unknown>): ProgressBody | undefined {
  const p = (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, JsonValue | undefined>;
  const s = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
  const seq = e.seq ?? 0;
  if (e.eventType.startsWith('operation.')) {
    const out: ProgressBody = { type: 'operation', runId: e.runId, seq, eventType: e.eventType, operationId: s(p['operationId']) ?? e.aggregateId, from: s(p['from']) ?? null, to: s(p['to']) ?? '' };
    const t = s(p['operationType']);
    if (t !== undefined) out.operationType = t;
    return out;
  }
  if (e.eventType.startsWith('work.')) {
    const out: ProgressBody = { type: 'work', runId: e.runId, seq, eventType: e.eventType, workItemId: s(p['workItemId']) ?? e.aggregateId };
    for (const k of ['role', 'from', 'to'] as const) {
      const v = s(p[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (e.eventType.startsWith('run.')) {
    const out: ProgressBody = { type: 'run', runId: e.runId, seq, eventType: e.eventType };
    const status = s(p['to']) ?? s(p['status']);
    if (status !== undefined) out.status = status;
    return out;
  }
  return undefined;
}

/** Highest L0 seq already reported for the run in the progress file (0 when none). */
export function reportedSeq(progressFile: string, runId: string): number {
  let max = 0;
  for (const e of readProgress(progressFile)) {
    if ('seq' in e && e.runId === runId && e.seq > max) max = e.seq;
  }
  return max;
}

/** Runs one trial child for the job file; resolves with the exit code (never throws). */
export async function runTrialChild(jobFile: string | undefined): Promise<number> {
  let job: TrialChildJob;
  try {
    if (!jobFile) throw new Error('usage: trial-child.ts <job.json>');
    const parsed = JSON.parse(readFileSync(jobFile, 'utf8')) as unknown;
    const problems = jobProblems(parsed);
    if (problems.length > 0) {
      const pf = (parsed as { progressFile?: unknown } | null)?.progressFile;
      if (typeof pf === 'string' && pf !== '') progressWriter(pf)({ type: 'error', code: 'invalid_argument', message: `invalid job: ${problems.join('; ')}`, exitCode: TRIAL_EXIT_CODES.invalid_job });
      process.stderr.write(`trial-child: invalid job ${jobFile}: ${problems.join('; ')}\n`);
      return TRIAL_EXIT_CODES.invalid_job;
    }
    job = parsed as TrialChildJob;
  } catch (e) {
    process.stderr.write(`trial-child: ${(e as Error).message}\n`);
    return TRIAL_EXIT_CODES.invalid_job;
  }

  const progress = progressWriter(job.progressFile);
  const logger = job.logFile ? fileLogger(job.logFile) : silent;
  const runId = job.input.runId!;
  let ht: HypertestInstance | undefined;
  let bus: EventBus | undefined;
  let stopPolling = (): Promise<void> => Promise.resolve();
  try {
    const task = await loadTask(job);
    const brains = withModelTimeoutInjection(await loadBrains(job, task), job.chaos?.injectModelTimeoutOnCall, undefined, (call) => progress({ type: 'chaos', kind: 'model_timeout', call }));
    const overrides: HypertestOverrides = { scriptedBrains: brains, logger };
    if (job.environments) overrides.environments = job.environments;
    if (job.workerId) overrides.workerId = job.workerId;
    if (job.chaos?.duplicateEventDelivery) {
      if (job.config.bus.kind !== 'inprocess') throw new HypertestError('invalid_argument', 'chaos.duplicateEventDelivery needs the in-process bus');
      bus = new InProcessEventBus({ duplicateDelivery: 1, logger });
      overrides.bus = bus;
    }
    ht = await createHypertest(job.config, overrides);
    progress({ type: 'started', mode: job.mode, attempt: job.attempt ?? 1, runId, manifestId: ht.manifest.manifestId });

    // L0 → progress lines, until stopped (then one final drain). A resumed child continues after the highest seq
    // already reported for this run (events a killed child committed but never reported are reported now).
    let lastSeq = reportedSeq(job.progressFile, runId);
    let stopped = false;
    const instance = ht;
    const drain = async (): Promise<void> => {
      for (const e of await instance.events(runId, { afterSeq: lastSeq })) {
        lastSeq = e.seq ?? lastSeq;
        const line = progressFor(e);
        if (line) progress(line);
      }
    };
    const loop = (async () => {
      while (!stopped) {
        try {
          await drain();
        } catch (e) {
          logger.warn('progress poll failed', { error: (e as Error).message });
        }
        await sleep(job.pollMs ?? DEFAULT_POLL_MS);
      }
    })();
    stopPolling = async () => {
      stopped = true;
      await loop;
      await drain();
    };

    if (job.mode === 'start') {
      // the task's oracles are established by the eval oracle authority before the run pins them
      await establishOracles(ht, job.oracles, runId);
      await ht.start(job.input);
    }
    else {
      const resumed = await ht.resumeIncomplete();
      const run = await ht.status(runId);
      if (!run) throw new HypertestError('not_found', `run ${runId} does not exist in this data directory`);
      // a live run this runtime did not resume (e.g. pinned to another manifest, I11) would never finish here
      if (!resumed.includes(runId) && !isTerminalRun(run.status)) {
        throw new HypertestError('precondition_failed', `run ${runId} (${run.status}) was not resumed by this runtime (manifest ${ht.manifest.manifestId}; the run is pinned to ${run.runtimeManifestId})`);
      }
    }
    let code: number;
    try {
      const outcome = await ht.durable.awaitCompletion(runId, { timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      await stopPolling();
      code = exitCodeForVerdict(outcome.decision?.verdict);
      const line: ProgressBody = { type: 'completed', runId, status: outcome.status, exitCode: code };
      if (outcome.decision) Object.assign(line, { verdict: outcome.decision.verdict, decisionId: outcome.decision.decisionId });
      progress(line);
    } catch (e) {
      if (!isHypertestError(e, 'timeout')) throw e;
      await stopPolling();
      code = TRIAL_EXIT_CODES.timeout;
      progress({ type: 'error', code: 'timeout', message: (e as Error).message, exitCode: code });
    }
    return code;
  } catch (e) {
    await stopPolling().catch(() => undefined);
    const code = isHypertestError(e) ? e.code : 'internal';
    progress({ type: 'error', code, message: (e as Error).message, exitCode: TRIAL_EXIT_CODES.error });
    process.stderr.write(`trial-child: ${(e as Error).stack ?? String(e)}\n`);
    return TRIAL_EXIT_CODES.error;
  } finally {
    await ht?.close().catch((e: unknown) => logger.error('close failed', { error: (e as Error).message }));
    await bus?.close().catch(() => undefined);
  }
}

// Entry point when executed directly.
function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = await runTrialChild(process.argv[2]);
  process.exitCode = code;
  // everything was closed; a lingering handle must not keep a finished trial child alive
  setTimeout(() => process.exit(code), 5000).unref();
}
