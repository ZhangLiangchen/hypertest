/**
 * The trial harness. One trial = a fresh work directory (fixture setup, embedded store under it, or a fresh
 * PostgreSQL schema), the arm's configuration over the defaults, the arm's scripted brains, a Hypertest run of the
 * task's goal against the fixture's target (in this process, or in child processes that a chaos plan may SIGKILL and
 * resume), then — environment first — probes, the trial's recorded state, graders and metrics, and cleanup.
 *
 * Results (decideTrialResult): `fail` when the run did not finish in time (whatever the graders say) or a grader
 * failed; `pass` when every grader passed and the whole chaos plan happened; `infra_error` when the trial could not be
 * run or graded (setup of the environment, configuration, harness faults, a crashed or inconsistent trial child, a probe
 * or grader precondition), or when every grader passed but part of the chaos plan never happened (recovery from it is
 * unconfirmed). infra_error is never counted as a pass or a fail — so it never hides a failing arm either.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { HypertestError, isHypertestError, newId, noopLogger, sleep, type Logger } from '@hypertest/core';
import { isTerminalRun, type DomainEvent, type EvidenceRecord, type QualityVerdict } from '@hypertest/domain';
import { InProcessEventBus } from '@hypertest/collab';
import { openDatabase } from '@hypertest/store';
import { createHypertest, defaultConfig, mergeConfig, type HypertestConfig, type HypertestInstance, type HypertestOverrides } from '@hypertest/app';
import type { StartRunInput } from '@hypertest/control';
import type { ScriptedBrain } from '@hypertest/model';
import type {
  ChaosPlan, ChildExit, EvalArm, EvalOracle, EvalTask, EvalTrial, Grader, GraderResult, RunOutcome, TrialChildJob, TrialContext, TrialData, TrialFixture, TrialOptions,
  TrialProgressEvent,
} from './contracts.ts';
import { graderOrderProblems, resolveGrader, type ResolvedGrader } from './graders.ts';
import { collectTrialData, DEFAULT_PROBE_TIMEOUT_MS, runProbes } from './collect.ts';
import { EVAL_HARNESS_REVISION } from './grader-revisions.ts';
import { VERDICT_CONSISTENCY_RUBRIC } from './judge.ts';
import { canonicalState, trialKey, trialModelRoutes } from './trial-records.ts';
import { outcomeMetrics, trajectoryMetrics } from './metrics.ts';
import { withModelTimeoutInjection, type ModelCallCounter } from './brains.ts';
import { TRIAL_EXIT_CODES, describeKillPoint, dispatchCount, exitCodeForVerdict, killPointCount, killPointProblems, runChildTrial, verdictForExitCode } from './child.ts';
import { establishOracles } from './oracles.ts';

/** Directory (inside the trial work directory) that holds the trial's Hypertest data (store, artifacts, keys, state). */
export const TRIAL_DATA_DIR = 'hypertest';
/** Default trial timeout. */
export const DEFAULT_TRIAL_TIMEOUT_MS = 600_000;
/** How long a cancelled (timed-out) run gets to settle before its state is collected. */
const CANCEL_SETTLE_MS = 15_000;
const WATCH_POLL_MS = 20;

/** The Hypertest data directory of a trial (fixtures use it to locate e.g. `<dataDir>/state/loadjobs`). */
export function trialDataDir(ctx: Pick<TrialContext, 'workDir'>): string {
  return join(ctx.workDir, TRIAL_DATA_DIR);
}

/**
 * The configuration a trial starts from: `defaultConfig` (or `base`) with `project.dataDir` = the trial's data
 * directory and the embedded store and filesystem artifacts inside it (a base's own paths are never reused, so trials
 * never share state).
 */
export function trialBaseConfig(dataDir: string, base?: HypertestConfig): HypertestConfig {
  const config = base
    ? mergeConfig<HypertestConfig>(base, { project: { dataDir } })
    : defaultConfig({ project: { name: 'hypertest-eval', dataDir }, observability: { logLevel: 'warn' } });
  if (config.store.kind === 'pglite') config.store = { kind: 'pglite', dataDir: join(dataDir, 'db') };
  if (config.artifacts.kind === 'fs') config.artifacts = { kind: 'fs', root: join(dataDir, 'artifacts') };
  return config;
}

function inside(dir: string, p: string | undefined): boolean {
  if (p === undefined) return false;
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Isolation problems of an arm's configuration (every local path must stay inside the trial directory). */
export function isolationProblems(config: HypertestConfig, workDir: string): string[] {
  const problems: string[] = [];
  if (!inside(workDir, config.project?.dataDir)) problems.push(`project.dataDir ${String(config.project?.dataDir)} is outside the trial directory ${workDir}`);
  if (config.store.kind === 'pglite' && !inside(workDir, config.store.dataDir)) problems.push(`store.dataDir ${String(config.store.dataDir)} is outside the trial directory`);
  if (config.artifacts.kind === 'fs' && !inside(workDir, config.artifacts.root)) problems.push(`artifacts.root ${String(config.artifacts.root)} is outside the trial directory`);
  return problems;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'x';
}

/** Warn/error of a trial's Hypertest instances go to the harness logger; debug/info are dropped. */
function trialLogger(base: Logger, fields: Record<string, unknown>): Logger {
  const target = base.child(fields);
  const self: Logger = {
    debug() {},
    info() {},
    warn: (m, f) => target.warn(m, f),
    error: (m, f) => target.error(m, f),
    child: (f) => trialLogger(base, { ...fields, ...f }),
  };
  return self;
}

/** Things to release at the end of a trial, in reverse order of acquisition. */
class Scope {
  readonly #closers: Array<{ name: string; fn: () => Promise<void> }> = [];
  add(name: string, fn: () => Promise<void>): void {
    this.#closers.push({ name, fn });
  }
  async close(logger: Logger): Promise<void> {
    for (const c of this.#closers.splice(0).reverse()) {
      try {
        await c.fn();
      } catch (e) {
        logger.warn('trial resource could not be released', { resource: c.name, error: (e as Error).message });
      }
    }
  }
}

function precondition(message: string): HypertestError {
  return new HypertestError('precondition_failed', message);
}

function validateOptions(options: TrialOptions): void {
  if (!options || typeof options.workDir !== 'string' || options.workDir === '') throw new HypertestError('invalid_argument', 'TrialOptions.workDir must be a non-empty path');
  if (!Number.isSafeInteger(options.trial) || options.trial < 0) throw new HypertestError('invalid_argument', `TrialOptions.trial must be a non-negative integer, got ${String(options.trial)}`);
  if (typeof options.seed !== 'string') throw new HypertestError('invalid_argument', 'TrialOptions.seed must be a string');
  if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) throw new HypertestError('invalid_argument', `TrialOptions.timeoutMs must be > 0, got ${String(options.timeoutMs)}`);
  if (options.probeTimeoutMs !== undefined && !(Number.isFinite(options.probeTimeoutMs) && options.probeTimeoutMs > 0)) {
    throw new HypertestError('invalid_argument', `TrialOptions.probeTimeoutMs must be > 0, got ${String(options.probeTimeoutMs)}`);
  }
  if (options.mode !== undefined && options.mode !== 'in-process' && options.mode !== 'child-process') throw new HypertestError('invalid_argument', `TrialOptions.mode must be in-process or child-process, got ${String(options.mode)}`);
}

/** A task's chaos plan is validated before any environment exists (a malformed plan is never half-applied). */
export function chaosProblems(chaos: ChaosPlan | undefined): string[] {
  if (chaos === undefined) return [];
  if (chaos === null || typeof chaos !== 'object') return ['chaos must be an object'];
  const out: string[] = [];
  for (const k of ['killAfterOperationDispatch', 'injectModelTimeoutOnCall', 'largeOutputBytes'] as const) {
    const v = chaos[k];
    if (v !== undefined && !(Number.isSafeInteger(v) && v >= 1)) out.push(`chaos.${k} must be a positive integer, got ${String(v)}`);
  }
  if (chaos.duplicateEventDelivery !== undefined && typeof chaos.duplicateEventDelivery !== 'boolean') out.push(`chaos.duplicateEventDelivery must be a boolean, got ${String(chaos.duplicateEventDelivery)}`);
  if (chaos.kills !== undefined) {
    if (!Array.isArray(chaos.kills)) out.push('chaos.kills must be an array of kill points');
    else chaos.kills.forEach((k, i) => out.push(...killPointProblems(k, `chaos.kills[${i}]`)));
  }
  return out;
}

/**
 * The parts of a chaos plan that did not happen in a trial: no kill (fewer operations dispatched than planned), no
 * injected model timeout (fewer model calls than planned; in a child-process trial only the first child injects), no
 * evidence artifact of at least `largeOutputBytes` (the large output never happened). A trial with such a gap cannot
 * confirm recovery from that fault.
 */
export function unexercisedChaos(
  chaos: ChaosPlan | undefined,
  facts: { restarts: number; injectedModelTimeouts: number; evidence: readonly Pick<EvidenceRecord, 'artifact'>[] },
): string[] {
  const out: string[] = [];
  if (!chaos) return out;
  if (chaos.killAfterOperationDispatch !== undefined && facts.restarts < 1) {
    out.push(`fewer than ${chaos.killAfterOperationDispatch} operation(s) were dispatched before the run finished or timed out`);
  }
  const before = chaos.killAfterOperationDispatch !== undefined ? 1 : 0;
  (chaos.kills ?? []).forEach((k, i) => {
    if (facts.restarts < before + i + 1) out.push(`kill point ${i + 1} (${describeKillPoint(k)}) was never reached`);
  });
  if (chaos.injectModelTimeoutOnCall !== undefined && facts.injectedModelTimeouts < 1) {
    out.push(`the model timeout planned for model call ${chaos.injectModelTimeoutOnCall} was never injected`);
  }
  const large = chaos.largeOutputBytes;
  if (large !== undefined && !facts.evidence.some((e) => e.artifact.size >= large)) out.push(`no evidence artifact of at least ${large} bytes was recorded (the large output never happened)`);
  return out;
}

/**
 * The result of a graded trial: `fail` when the run did not finish in time (whatever the graders say: a timed-out run
 * never passes) or a grader failed; otherwise `infra_error` when part of the chaos plan did not happen (the trial cannot
 * confirm the recovery it was built for — never a silent pass), else `pass`. A failing arm stays a `fail` even when its
 * chaos plan was not exercised: an infra error is excluded from pass rates, so it must never hide a failure.
 */
export function decideTrialResult(input: { graders: readonly GraderResult[]; timedOut: boolean; unexercised: readonly string[]; error?: string }): { result: EvalTrial['result']; error?: string } {
  const notes: string[] = [];
  if (input.error !== undefined) notes.push(input.error);
  if (input.unexercised.length > 0) notes.push(`chaos plan not exercised: ${input.unexercised.join('; ')}`);
  // (additive) a result reported but not counted (an uncalibrated LLM judge) never decides; a counted `unknown` (the judge
  // could not decide from the evidence) never passes: without a failing grader the trial needs a human audit (infra_error)
  const counted = input.graders.filter((g) => g.counted !== false);
  const unknown = counted.filter((g) => g.outcome === 'unknown');
  const failed = counted.filter((g) => g.outcome !== 'unknown' && !g.pass);
  if (unknown.length > 0) notes.push(`needs human audit: ${unknown.map((g) => `${g.graderId} could not decide from the evidence`).join('; ')}`);
  const result: EvalTrial['result'] = input.timedOut || failed.length > 0 ? 'fail' : input.unexercised.length > 0 || unknown.length > 0 ? 'infra_error' : 'pass';
  return notes.length > 0 ? { result, error: notes.join('; ') } : { result };
}

/**
 * Consistency of a finished trial child with the store (the child's exit code is its verdict): a crash (error or
 * invalid-job code, a signal, an unknown code) or an exit code that disagrees with the run's stored final verdict makes
 * the trial ungradable. The timeout code is not a problem here (the run did not finish in time: the trial fails).
 */
export function childExitProblem(exit: ChildExit, storedVerdict: QualityVerdict | undefined, reported?: string): string | undefined {
  const code = exit.code;
  if (code === TRIAL_EXIT_CODES.timeout) return undefined;
  const verdictCodes: number[] = [TRIAL_EXIT_CODES.pass, TRIAL_EXIT_CODES.fail, TRIAL_EXIT_CODES.conditional, TRIAL_EXIT_CODES.inconclusive, TRIAL_EXIT_CODES.no_verdict];
  if (code === null || !verdictCodes.includes(code)) return `the trial child failed (exit ${code ?? exit.signal}): ${reported ?? 'no error reported'}`;
  const expected = exitCodeForVerdict(storedVerdict);
  if (code !== expected) return `the trial child reported exit ${code} (${verdictForExitCode(code) ?? 'no verdict'}) but the store holds verdict ${storedVerdict ?? 'none'}`;
  return undefined;
}

function validateFixture(fixture: unknown): asserts fixture is TrialFixture {
  const f = fixture as Partial<TrialFixture> | undefined;
  if (!f || typeof f !== 'object') throw precondition('task.setup() returned no fixture');
  if (!f.target || typeof f.target !== 'object') throw precondition('the fixture has no target');
  if (typeof f.cleanup !== 'function') throw precondition('the fixture has no cleanup()');
}

/** A fresh PostgreSQL schema per trial (dropped at the end): the arm's `store.schema` is used as a prefix. */
function freshPostgresSchema(config: HypertestConfig, scope: Scope): HypertestConfig {
  if (config.store.kind !== 'postgres') return config;
  const url = config.store.url ?? (config.store.urlEnv ? process.env[config.store.urlEnv] : undefined);
  if (!url) throw precondition(`store.urlEnv names ${String(config.store.urlEnv)}, which is not set`);
  const prefix = (config.store.schema ?? 'ht_eval').toLowerCase().slice(0, 40);
  const schema = `${prefix}_${randomBytes(4).toString('hex')}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw precondition(`store.schema prefix ${prefix} is not a valid schema name`);
  scope.add(`schema ${schema}`, async () => {
    const db = await openDatabase({ kind: 'postgres', url });
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db.close();
    }
  });
  return { ...config, store: { ...config.store, schema } };
}

/** Brains of a grading instance: it never calls a model. */
function gradingBrains(config: HypertestConfig): Record<string, ScriptedBrain> {
  const out: Record<string, ScriptedBrain> = {};
  for (const p of config.models.providers) {
    if (p.kind === 'scripted') {
      out[p.id] = () => {
        throw new Error('the eval grading instance makes no model calls');
      };
    }
  }
  return out;
}

async function outcomeOf(ht: HypertestInstance, runId: string): Promise<RunOutcome | undefined> {
  const run = await ht.status(runId);
  if (!run) return undefined;
  const out: RunOutcome = { runId, status: run.status };
  if (run.decisionId) {
    const d = await ht.services.decisions.get(run.decisionId);
    if (d) out.decision = d;
  }
  return out;
}

/** An L0 operation event as the progress line the kill-point predicates of the child protocol read. */
function operationLine(e: DomainEvent<unknown>): TrialProgressEvent | undefined {
  if (!e.eventType.startsWith('operation.')) return undefined;
  const p = (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const line: TrialProgressEvent = {
    type: 'operation', pid: process.pid, at: e.occurredAt, runId: e.runId, seq: e.seq ?? 0, eventType: e.eventType,
    operationId: s(p['operationId']) ?? e.aggregateId, from: s(p['from']) ?? null, to: s(p['to']) ?? '',
  };
  const t = s(p['operationType']);
  if (t !== undefined) line.operationType = t;
  return line;
}

/**
 * Polls L0 (accumulating operation lines in `watch`, across instances) until `reached` holds (true), or the run finished
 * / the deadline passed (false).
 */
async function waitForPoint(
  ht: HypertestInstance,
  runId: string,
  watch: { afterSeq: number; lines: TrialProgressEvent[] },
  reached: (lines: readonly TrialProgressEvent[]) => boolean,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  while (Date.now() < deadline && !signal?.aborted) {
    for (const e of await ht.events(runId, { afterSeq: watch.afterSeq })) {
      watch.afterSeq = e.seq ?? watch.afterSeq;
      const line = operationLine(e);
      if (line) watch.lines.push(line);
    }
    if (reached(watch.lines)) return true;
    const run = await ht.status(runId);
    if (!run || isTerminalRun(run.status)) return false;
    await sleep(WATCH_POLL_MS);
  }
  return false;
}

/** The kill points of a chaos plan as predicates over operation lines (killAfterOperationDispatch first). */
function killPredicates(chaos: ChaosPlan): Array<{ reached: (lines: readonly TrialProgressEvent[]) => boolean; delayMs: number; downtimeMs: number }> {
  const out: Array<{ reached: (lines: readonly TrialProgressEvent[]) => boolean; delayMs: number; downtimeMs: number }> = [];
  const n = chaos.killAfterOperationDispatch;
  if (n !== undefined) out.push({ reached: (lines) => dispatchCount(lines) >= n, delayMs: 0, downtimeMs: 0 });
  for (const k of chaos.kills ?? []) out.push({ reached: (lines) => killPointCount(lines, k) >= (k.nth ?? 1), delayMs: k.delayMs ?? 0, downtimeMs: k.downtimeMs ?? 0 });
  return out;
}

interface Execution {
  ht: HypertestInstance;
  outcome?: RunOutcome;
  error?: string;
  infraError?: string;
  harness: TrialData['harness'];
}

interface ExecutionInput {
  task: EvalTask;
  arm: EvalArm;
  fixture: TrialFixture;
  config: HypertestConfig;
  input: StartRunInput & { runId: string };
  workDir: string;
  timeoutMs: number;
  logger: Logger;
  scope: Scope;
  signal?: AbortSignal;
}

/** Rejects with `cancelled` when `signal` aborts (never, without a signal). */
function aborted(signal: AbortSignal | undefined): { promise: Promise<never>; dispose(): void } {
  if (!signal) return { promise: new Promise<never>(() => undefined), dispose: () => undefined };
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(new HypertestError('cancelled', 'the eval trial was cancelled'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, dispose: () => listener && signal.removeEventListener('abort', listener) };
}

/** Waits for the run; on timeout (or cancellation, H11) it is cancelled and given a moment to settle (the trial then fails). */
async function awaitRun(ht: HypertestInstance, runId: string, deadline: number, logger: Logger, signal?: AbortSignal): Promise<{ outcome?: RunOutcome; error?: string; timedOut: boolean; cancelled?: boolean }> {
  const abort = aborted(signal);
  try {
    return { outcome: await Promise.race([ht.durable.awaitCompletion(runId, { timeoutMs: Math.max(1, deadline - Date.now()) }), abort.promise]), timedOut: false };
  } catch (e) {
    const cancelled = isHypertestError(e, 'cancelled') && signal?.aborted === true;
    if (!isHypertestError(e, 'timeout') && !cancelled) throw e;
    const error = cancelled ? 'the trial was cancelled (signal)' : `the run did not complete in time: ${(e as Error).message}`;
    try {
      await ht.cancel(runId, cancelled ? 'eval trial cancelled' : 'eval trial timeout');
      await ht.durable.awaitCompletion(runId, { timeoutMs: CANCEL_SETTLE_MS });
    } catch (c) {
      logger.warn('the timed-out run could not be cancelled cleanly', { runId, error: (c as Error).message });
    }
    const outcome = await outcomeOf(ht, runId);
    const out: { outcome?: RunOutcome; error?: string; timedOut: boolean; cancelled?: boolean } = { error, timedOut: !cancelled };
    if (outcome) out.outcome = outcome;
    if (cancelled) out.cancelled = true;
    return out;
  } finally {
    abort.dispose();
  }
}

async function executeInProcess(x: ExecutionInput): Promise<Execution> {
  const { task, arm, fixture, config, input, logger, scope } = x;
  const chaos = task.chaos ?? {};
  const counter: ModelCallCounter = { calls: 0, injected: 0 };
  const brains = withModelTimeoutInjection(arm.brains ? arm.brains(task, fixture) : {}, chaos.injectModelTimeoutOnCall, counter);
  if (chaos.duplicateEventDelivery && config.bus.kind !== 'inprocess') throw precondition('chaos.duplicateEventDelivery needs the in-process bus');
  let instances = 0;
  const compose = async (): Promise<HypertestInstance> => {
    const overrides: HypertestOverrides = { scriptedBrains: brains, logger: logger.child({ instance: ++instances }) };
    if (fixture.environments) overrides.environments = fixture.environments;
    if (chaos.duplicateEventDelivery) {
      const bus = new InProcessEventBus({ duplicateDelivery: 1, logger });
      scope.add('bus', () => bus.close());
      overrides.bus = bus;
    }
    const ht = await createHypertest(config, overrides);
    scope.add('hypertest', () => ht.close());
    return ht;
  };
  const deadline = Date.now() + x.timeoutMs;
  let ht = await compose();
  await establishOracles(ht, task.oracles, input.runId);
  await ht.start(input);
  let restarts = 0;
  // when a kill point is never reached (the run finished or the deadline passed first), the trial is still graded:
  // runTrial decides from the graders, the timeout and the unexercised chaos (unexercisedChaos / decideTrialResult)
  const watch = { afterSeq: 0, lines: [] as TrialProgressEvent[] };
  for (const point of killPredicates(chaos)) {
    if (!(await waitForPoint(ht, input.runId, watch, point.reached, deadline, x.signal))) break;
    if (point.delayMs > 0) await sleep(Math.min(point.delayMs, Math.max(0, deadline - Date.now())));
    // "kill": the instance goes away mid-run (in-flight turns aborted); a new one resumes from the stores
    await ht.close();
    restarts++;
    // Hypertest stays down for a while: the external world moves on without it
    if (point.downtimeMs > 0) await sleep(Math.min(point.downtimeMs, Math.max(0, deadline - Date.now())));
    ht = await compose();
    await ht.resumeIncomplete();
  }
  const r = await awaitRun(ht, input.runId, deadline, logger, x.signal);
  const out: Execution = { ht, harness: { restarts, injectedModelTimeouts: counter.injected, duplicateDelivery: chaos.duplicateEventDelivery === true, timedOut: r.timedOut } };
  if (r.outcome) out.outcome = r.outcome;
  if (r.error) out.error = r.error;
  if (r.cancelled) out.infraError = r.error ?? 'the trial was cancelled';
  return out;
}

async function executeInChild(x: ExecutionInput): Promise<Execution> {
  const { task, arm, fixture, config, input, workDir, logger, scope } = x;
  const spec = arm.child;
  if (!spec) throw precondition(`arm ${arm.armId} has no child spec (EvalArm.child) for a child-process trial`);
  const chaos = task.chaos ?? {};
  const job: TrialChildJob = {
    config,
    brainsModule: spec.brainsModule,
    brainsExport: spec.brainsExport,
    mode: 'start',
    input,
    progressFile: join(workDir, 'progress.jsonl'),
    timeoutMs: x.timeoutMs,
    logFile: join(workDir, 'child.log'),
    // one worker identity for every child of the trial: a resumed child re-takes the killed one's leases at once
    workerId: `worker:eval:${input.runId}`,
  };
  if (spec.taskModule) job.taskModule = spec.taskModule;
  if (spec.taskExport) job.taskExport = spec.taskExport;
  if (task.oracles && task.oracles.length > 0) job.oracles = task.oracles;
  if (spec.args) job.brainsArgs = spec.args(task, fixture);
  if (fixture.environments) job.environments = fixture.environments;
  if (chaos.injectModelTimeoutOnCall !== undefined || chaos.duplicateEventDelivery) {
    job.chaos = {};
    if (chaos.injectModelTimeoutOnCall !== undefined) job.chaos.injectModelTimeoutOnCall = chaos.injectModelTimeoutOnCall;
    if (chaos.duplicateEventDelivery) job.chaos.duplicateEventDelivery = true;
  }
  const r = await runChildTrial(job, {
    workDir,
    timeoutMs: x.timeoutMs,
    ...(x.signal ? { signal: x.signal } : {}),
    ...(chaos.killAfterOperationDispatch !== undefined ? { killAfterOperationDispatch: chaos.killAfterOperationDispatch } : {}),
    ...(chaos.kills && chaos.kills.length > 0 ? { kills: chaos.kills } : {}),
  });
  // a grading instance over the same stores (the children are gone)
  const overrides: HypertestOverrides = { scriptedBrains: gradingBrains(config), logger: logger.child({ instance: 'grading' }) };
  if (fixture.environments) overrides.environments = fixture.environments;
  const ht = await createHypertest(config, overrides);
  scope.add('hypertest', () => ht.close());
  const code = r.exit.code;
  // the run did not finish in time: the parent's deadline killed the child, or the child's own wait timed out
  const timedOut = r.timedOut || code === TRIAL_EXIT_CODES.timeout;
  const out: Execution = {
    ht,
    harness: {
      restarts: r.kills,
      injectedModelTimeouts: r.progress.filter((e) => e.type === 'chaos' && e.kind === 'model_timeout').length,
      duplicateDelivery: chaos.duplicateEventDelivery === true,
      timedOut,
    },
  };
  const outcome = await outcomeOf(ht, input.runId);
  if (outcome) out.outcome = outcome;
  const failure = [...r.progress].reverse().find((e) => e.type === 'error');
  const reported = failure?.type === 'error' ? failure.message : undefined;
  if (r.cancelled) out.infraError = 'the trial was cancelled (signal): its child was killed';
  else if (r.timedOut) out.error = `the trial child did not finish within ${x.timeoutMs} ms (killed)`;
  else if (code === TRIAL_EXIT_CODES.timeout) out.error = `the run did not complete in time: ${reported ?? 'timeout'}`;
  else {
    const problem = childExitProblem(r.exit, outcome?.decision?.verdict, reported);
    if (problem) out.infraError = problem;
  }
  return out;
}

/**
 * (additive) A grader result stamped with its revision and three-valued outcome. `pass` ⇔ outcome `pass` (a result
 * claiming one without the other is inconsistent). Only an LLM-judged grader (`kind: 'llm'`) may be reported but NOT
 * counted (`counted: false`: a judge below its calibration threshold) — a deterministic grader that opted out of counting
 * would turn its own failure into a pass. Inconsistent results are schema violations (⇒ the trial is an infra error),
 * never silently repaired.
 */
export function stampGraderResult(r: GraderResult, grader: { id: string; revision: string; kind?: 'deterministic' | 'llm' }): GraderResult {
  if (r === null || typeof r !== 'object') throw new HypertestError('schema_violation', `grader ${grader.id} returned no result`);
  const out: GraderResult = { ...r, revision: grader.revision };
  if (out.outcome === undefined) out.outcome = r.pass ? 'pass' : 'fail';
  else if (out.outcome !== 'pass' && out.outcome !== 'fail' && out.outcome !== 'unknown') throw new HypertestError('schema_violation', `grader ${grader.id} returned outcome ${String(out.outcome)}`);
  // a pass is a pass: a result cannot claim pass with a non-pass outcome, nor a pass outcome without passing
  if ((out.outcome === 'pass') !== (out.pass === true)) throw new HypertestError('schema_violation', `grader ${grader.id} returned pass ${String(out.pass)} with outcome ${out.outcome}`);
  if (out.counted !== undefined && typeof out.counted !== 'boolean') throw new HypertestError('schema_violation', `grader ${grader.id} returned counted ${String(out.counted)}`);
  if (out.counted === false && grader.kind !== 'llm') {
    throw new HypertestError('schema_violation', `grader ${grader.id}: only an LLM-judged grader may be reported uncounted (counted: false); a deterministic grader always counts`);
  }
  return out;
}

/**
 * Runs the graders in task order (deterministic first, the LLM judge last — enforced by graderOrderProblems): each sees
 * the results before it (`prior`) and the harness's judge.
 */
async function grade(graders: ReadonlyArray<ResolvedGrader>, ctx: Parameters<Grader>[0], revisions: Readonly<Record<string, string>>): Promise<GraderResult[]> {
  const out: GraderResult[] = [];
  for (const { id, grader, kind } of graders) {
    try {
      out.push(stampGraderResult(await grader({ ...ctx, prior: [...out] }), { id, revision: revisions[id]!, kind }));
    } catch (e) {
      throw new HypertestError(isHypertestError(e) ? e.code : 'internal', `grader ${id} could not grade the trial: ${(e as Error).message}`, { cause: e });
    }
  }
  return out;
}

/**
 * The revision of every grader of a task as recorded on its trials. An LLM-judged grader's revision also names the rubric
 * and the judge (a different judge model is a different grader).
 */
export function graderRevisionsOf(task: Pick<EvalTask, 'rubric'>, graders: ReadonlyArray<ResolvedGrader>, judge?: { identity: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of graders) {
    if (g.kind !== 'llm') out[g.id] = g.revision;
    else {
      const rubric = task.rubric ?? VERDICT_CONSISTENCY_RUBRIC;
      out[g.id] = `${g.revision}/${rubric.rubricId}@${rubric.revision}/${judge?.identity ?? 'no-judge'}`;
    }
  }
  return out;
}

/** Problems of a task's graders before any environment exists: judge ordering and a judge for LLM-judged graders. */
export function graderSetupProblems(task: Pick<EvalTask, 'taskId' | 'graders'>, options: Pick<TrialOptions, 'graders' | 'judge' | 'bridge'>): string[] {
  const out = graderOrderProblems(task.graders, options.graders).map((p) => `task ${task.taskId}: ${p}`);
  const resolved = task.graders.map((g) => resolveGrader(g, options.graders));
  if (resolved.some((g) => g.kind === 'llm') && !options.judge) out.push(`task ${task.taskId} lists an LLM-judged grader (${resolved.filter((g) => g.kind === 'llm').map((g) => g.id).join(', ')}) but no independent judge is configured (HarnessOptions.judge)`);
  for (const [id, b] of Object.entries(options.bridge ?? {})) {
    if (!b || typeof b.grader !== 'function' || typeof b.revision !== 'string' || b.revision.trim() === '') out.push(`bridge grader ${id} must be {revision, grader}`);
  }
  return out;
}

/**
 * Bridge graders (HarnessOptions.bridge): candidate revisions of graders the task lists, run on the same trial data after
 * the task's graders; results are recorded apart (EvalTrial.bridge) and never decide the trial. A candidate that cannot
 * grade the trial is recorded as a failed result naming the fault (the bridge report shows it), never a trial fault.
 */
async function gradeBridge(task: EvalTask, options: TrialOptions, ctx: Parameters<Grader>[0], prior: readonly GraderResult[]): Promise<GraderResult[]> {
  const out: GraderResult[] = [];
  const listed = new Set(task.graders.map((g) => g.split('?')[0]!.trim()));
  for (const [id, candidate] of Object.entries(options.bridge ?? {})) {
    if (!listed.has(id)) continue;
    try {
      const r = await candidate.grader({ ...ctx, prior });
      out.push(stampGraderResult({ ...r, graderId: id }, { id, revision: candidate.revision, kind: candidate.kind ?? 'deterministic' }));
    } catch (e) {
      out.push({ graderId: id, pass: false, score: 0, outcome: 'fail', revision: candidate.revision, detail: `the candidate revision could not grade the trial: ${(e as Error).message}` });
    }
  }
  return out;
}

/** Runs one trial of `task` under `arm` (see the module comment). Never throws for trial problems: they are results. */
export async function runTrial(task: EvalTask, arm: EvalArm, options: TrialOptions): Promise<EvalTrial> {
  const started = Date.now();
  const harnessLogger = options?.logger ?? noopLogger;
  const trial: EvalTrial = {
    taskId: task?.taskId,
    armId: arm?.armId,
    trial: options?.trial,
    seed: options?.seed,
    result: 'infra_error',
    graders: [],
    outcomeMetrics: {},
    trajectoryMetrics: {},
    durationMs: 0,
  };
  const infra = (e: unknown): EvalTrial => {
    trial.result = 'infra_error';
    trial.error = (e as Error)?.message ?? String(e);
    trial.durationMs = Date.now() - started;
    return trial;
  };
  // fail fast (no environment yet): options, grader specs, arm capabilities
  let graders: ResolvedGrader[];
  let revisions: Record<string, string>;
  try {
    validateOptions(options);
    if (!Array.isArray(task.graders) || task.graders.length === 0) throw precondition(`task ${task.taskId} lists no graders`);
    const chaos = chaosProblems(task.chaos);
    if (chaos.length > 0) throw new HypertestError('invalid_argument', `task ${task.taskId}: ${chaos.join('; ')}`);
    graders = task.graders.map((g) => resolveGrader(g, options.graders));
    const setup = graderSetupProblems(task, options);
    if (setup.length > 0) throw new HypertestError('invalid_argument', setup.join('; '));
    revisions = graderRevisionsOf(task, graders, options.judge);
    if (options.mode === 'child-process' && !arm.child) throw precondition(`arm ${arm.armId} has no child spec (EvalArm.child) for a child-process trial`);
  } catch (e) {
    return infra(e);
  }
  trial.harness = `hypertest-eval@${EVAL_HARNESS_REVISION}/${options.mode ?? 'in-process'}`;
  trial.suiteRevision = task.suiteRevision;
  if (options.suiteId !== undefined) trial.suiteId = options.suiteId;
  trial.graderRevisions = { ...revisions };
  const logger = trialLogger(harnessLogger, { taskId: task.taskId, armId: arm.armId, trial: options.trial });
  const scope = new Scope();
  let workDir: string | undefined;
  let fixture: TrialFixture | undefined;
  try {
    await mkdir(options.workDir, { recursive: true });
    workDir = await mkdtemp(join(options.workDir, `${slug(task.taskId)}-${slug(arm.armId)}-t${options.trial}-`));
    const ctx: TrialContext = { workDir, seed: options.seed, trial: options.trial };
    const f: unknown = await task.setup(ctx);
    validateFixture(f);
    fixture = f;
    let config = arm.config(trialBaseConfig(trialDataDir(ctx), options.baseConfig), ctx);
    const isolation = isolationProblems(config, workDir);
    if (isolation.length > 0) throw precondition(`arm ${arm.armId} breaks trial isolation: ${isolation.join('; ')}`);
    config = freshPostgresSchema(config, scope);
    const input: StartRunInput & { runId: string } = {
      goal: task.goal,
      target: fixture.target,
      runId: newId('run'),
      labels: { eval_task: task.taskId, eval_suite_revision: task.suiteRevision, eval_arm: arm.armId, eval_trial: String(options.trial), eval_seed: options.seed },
    };
    if (task.budget) input.budget = { ...task.budget };
    if (task.gate) input.gate = { ...task.gate };
    if (task.oracles && task.oracles.length > 0) input.oracleIds = task.oracles.map((o: EvalOracle) => o.oracleId);
    const x: ExecutionInput = { task, arm, fixture, config, input, workDir, timeoutMs: options.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS, logger, scope };
    if (options.signal) {
      if (options.signal.aborted) throw new HypertestError('cancelled', 'the trial was cancelled (signal) before its run started');
      x.signal = options.signal;
    }
    const exec = options.mode === 'child-process' ? await executeInChild(x) : await executeInProcess(x);
    if (exec.infraError) throw precondition(exec.infraError);
    const probes = await runProbes(fixture, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    const data = await collectTrialData(exec.ht, { runId: input.runId, probes, harness: exec.harness, logger, ...(exec.outcome ? { outcome: exec.outcome } : {}) });
    trial.runId = input.runId;
    if (data.run) trial.runtimeManifestId = data.run.runtimeManifestId;
    if (data.decision) {
      trial.verdict = data.decision.verdict;
      trial.evidenceRootHash = data.decision.evidenceRootHash;
    } else if (data.verification) {
      trial.evidenceRootHash = data.verification.rootHash;
    }
    // what happened is recorded BEFORE grading: a trial whose grader cannot grade it (infra_error) still carries its
    // outcome metrics (security violations, duplicate effects, false releases — the release gate counts them), routes,
    // canonical state and key
    trial.outcomeMetrics = outcomeMetrics(task, data);
    trial.trajectoryMetrics = trajectoryMetrics(data);
    trial.modelRoutes = trialModelRoutes(data.events);
    trial.canonical = canonicalState(data);
    if (data.run) trial.oracleRevisions = { ...data.run.oracleRevisions };
    const keyParts: Parameters<typeof trialKey>[0] = { suiteRevision: task.suiteRevision, taskId: task.taskId, graderRevisions: revisions, oracleRevisions: trial.oracleRevisions ?? {} };
    if (options.suiteId !== undefined) keyParts.suiteId = options.suiteId;
    if (trial.runtimeManifestId !== undefined) keyParts.runtimeManifestId = trial.runtimeManifestId;
    trial.trialKey = trialKey(keyParts);
    const gctx: Parameters<Grader>[0] = { task, armId: arm.armId, trial: ctx, fixture, data, ht: exec.ht };
    if (options.judge) gctx.judge = options.judge;
    trial.graders = await grade(graders, gctx, revisions);
    trial.bridge = await gradeBridge(task, options, gctx, trial.graders);
    if (trial.bridge.length === 0) delete trial.bridge;
    const unexercised = unexercisedChaos(task.chaos, { restarts: exec.harness.restarts, injectedModelTimeouts: exec.harness.injectedModelTimeouts, evidence: data.evidence });
    const decided = decideTrialResult({ graders: trial.graders, timedOut: exec.harness.timedOut, unexercised, ...(exec.error !== undefined ? { error: exec.error } : {}) });
    trial.result = decided.result;
    if (decided.error !== undefined) trial.error = decided.error;
    trial.durationMs = Date.now() - started;
  } catch (e) {
    infra(e);
  } finally {
    await scope.close(logger);
    if (fixture) {
      try {
        await fixture.cleanup();
      } catch (e) {
        logger.warn('fixture cleanup failed', { error: (e as Error).message });
      }
    }
    if (workDir && !options.keepWorkDir) await rm(workDir, { recursive: true, force: true }).catch((e: unknown) => logger.warn('trial directory could not be removed', { workDir, error: (e as Error).message }));
  }
  return trial;
}
