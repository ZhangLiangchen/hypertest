import { HypertestError, Semaphore, type Logger } from '@hypertest/core';
import type { TestRun } from '@hypertest/domain';
import type { ControlPlane, TickResult, TurnOutcome } from '@hypertest/control';
import type { DurableRuntime, LocalDurableOptions, RunOutcome } from './contracts.ts';
import { errorMessage, faultCode, isRetryableFault } from './errors.ts';

/** Run statuses resumeIncomplete() drives again (a paused run waits for an operator's resumeRun). */
export const RESUMABLE_RUN_STATUSES: readonly TestRun['status'][] = Object.freeze(['created', 'running', 'converging', 'gating']);
const RESUMABLE: ReadonlySet<string> = new Set(RESUMABLE_RUN_STATUSES);
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export const OBSERVE_BACKOFF_MIN_MS = 250;
export const OBSERVE_BACKOFF_MAX_MS = 2000;
export const DEFAULT_MAX_IDLE_MS = 5000;
export const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2000;
const POLL_MIN_MS = 50;
const POLL_MAX_MS = 1000;
/** Consecutive ticks with idleMs 0 before the loop yields anyway (a control plane reporting progress forever). */
export const ZERO_IDLE_STREAK = 20;
export const ZERO_IDLE_YIELD_MS = 50;

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export function outcomeOf(r: Pick<TickResult, 'runId' | 'status' | 'decision'>): RunOutcome {
  const out: RunOutcome = { runId: r.runId, status: r.status };
  if (r.decision) out.decision = r.decision;
  return out;
}

/** Resolves after `ms`, on `wake()` or on abort; `true` unless aborted. */
class Waker {
  #pending = false;
  readonly #waiters = new Set<() => void>();

  /** Sticky wake: the next wait() returns at once when nothing is waiting now. */
  wake(): void {
    this.#pending = true;
    this.pulse();
  }

  /** Wakes the current waiters only. */
  pulse(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const w of waiters) w();
  }

  clear(): void {
    this.#pending = false;
  }

  wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#pending) return Promise.resolve(true);
    return pause(ms, signal, this.#waiters);
  }
}

/** Abortable delay that never rejects: `false` when aborted. `wakers` (optional) may end it early. */
function pause(ms: number, signal: AbortSignal, wakers?: Set<() => void>): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      wakers?.delete(done);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
    wakers?.add(done);
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });
  promise.catch(() => undefined); // observed through awaitCompletion only; never an unhandled rejection
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve(v) {
      if (d.settled) return;
      d.settled = true;
      res(v);
    },
    reject(e) {
      if (d.settled) return;
      d.settled = true;
      rej(e);
    },
  };
  return d;
}

interface WorkLoop {
  readonly workItemId: string;
  token: number | undefined;
  done: boolean;
  promise: Promise<void>;
}

interface RunLoop {
  readonly runId: string;
  /** Stops this run's loops (fatal error / end); linked to the runtime's shutdown. */
  readonly stop: AbortController;
  /** Stops the work loops and their in-flight turns (cancel). */
  readonly workStop: AbortController;
  readonly runSignal: AbortSignal;
  readonly workSignal: AbortSignal;
  readonly waker: Waker;
  readonly observeWaker: Waker;
  readonly workers: Map<string, WorkLoop>;
  readonly outcome: Deferred<RunOutcome>;
  finished: boolean;
  done: Promise<void>;
}

/** A control call the loop stops retrying (non-retryable fault, attempts exhausted, or aborted); `cause` is the fault. */
class GiveUp extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = 'GiveUp';
  }
}

/**
 * In-process durable runtime. Nothing is kept here that is not also in the control plane's SQL state: a crashed
 * process loses only its loops, and resumeIncomplete() on the next start rebuilds them (recover ⇒ tick ⇒ dispatch).
 *
 * Per run: recover once, then loop { tick; start a work loop per dispatched item (turns bounded by one Semaphore of
 * maxConcurrentTurns for the whole runtime); poll untracked waiting items; wait for a wake or min(idleMs, maxIdleMs) }
 * until the tick is final. A work loop runs executeTurn while it continues (each call carries the expected turn, so a
 * retried call never advances twice), polls observeWaiting with backoff (250 ms → 2 s) while waiting (also while it
 * answers lease_lost: another worker still holds the waiting item), continues after the resume under the claim this
 * worker holds then (resolveClaim hook, else the known token), and stops on a terminal outcome, lease_lost or paused,
 * waking the run loop. A newer claim is never adopted after lease_lost: at most one work loop drives a claim.
 */
export class LocalDurableRuntime implements DurableRuntime {
  readonly kind = 'local' as const;
  readonly #control: ControlPlane;
  readonly #listRuns: () => Promise<TestRun[]>;
  readonly #getRun: (runId: string) => Promise<TestRun | undefined>;
  readonly #resolveClaim: ((workItemId: string) => Promise<number | undefined>) | undefined;
  readonly #logger: Logger;
  readonly #semaphore: Semaphore;
  readonly #maxIdleMs: number;
  readonly #maxAttempts: number;
  readonly #root = new AbortController();
  readonly #runs = new Map<string, RunLoop>();
  #shutdown: Promise<void> | undefined;

  constructor(options: LocalDurableOptions) {
    if (!options || typeof options !== 'object' || !options.control) throw new HypertestError('invalid_argument', 'LocalDurableRuntime: control is required');
    if (typeof options.listRuns !== 'function') throw new HypertestError('invalid_argument', 'LocalDurableRuntime: listRuns is required');
    if (!Number.isSafeInteger(options.maxConcurrentTurns) || options.maxConcurrentTurns < 1) {
      throw new HypertestError('invalid_argument', `LocalDurableRuntime: maxConcurrentTurns must be an integer ≥ 1 (got ${String(options.maxConcurrentTurns)})`);
    }
    const maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) throw new HypertestError('invalid_argument', `LocalDurableRuntime: maxIdleMs must be > 0 (got ${String(options.maxIdleMs)})`);
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new HypertestError('invalid_argument', `LocalDurableRuntime: maxAttempts must be an integer ≥ 1 (got ${String(options.maxAttempts)})`);
    this.#control = options.control;
    this.#listRuns = options.listRuns;
    const listRuns = options.listRuns;
    this.#getRun = options.getRun ?? (async (runId) => (await listRuns()).find((r) => r.runId === runId));
    this.#resolveClaim = options.resolveClaim;
    this.#logger = (options.logger ?? options.control.deps.logger).child({ component: 'durable.local' });
    this.#semaphore = new Semaphore(options.maxConcurrentTurns);
    this.#maxIdleMs = maxIdleMs;
    this.#maxAttempts = maxAttempts;
  }

  async startRun(runId: string): Promise<void> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'startRun: runId must be a non-empty string');
    this.#assertOpen('startRun');
    for (;;) {
      const existing = this.#runs.get(runId);
      if (!existing || existing.finished) break;
      if (!existing.stop.signal.aborted) return; // idempotent: one live loop per run
      // The loop is stopping (it failed, or finished) but still waits for its work loops: a restart must not be lost
      // (a no-op here would leave the run undriven), nor run next to it. Wait for it, then look again (a concurrent
      // startRun may have replaced it meanwhile).
      await existing.done;
      this.#assertOpen('startRun');
    }
    const stop = new AbortController();
    const workStop = new AbortController();
    const runSignal = AbortSignal.any([this.#root.signal, stop.signal]);
    const loop: RunLoop = {
      runId,
      stop,
      workStop,
      runSignal,
      workSignal: AbortSignal.any([runSignal, workStop.signal]),
      waker: new Waker(),
      observeWaker: new Waker(),
      workers: new Map(),
      outcome: deferred<RunOutcome>(),
      finished: false,
      done: Promise.resolve(),
    };
    this.#runs.set(runId, loop);
    loop.done = this.#drive(loop);
  }

  async signal(runId: string, signal: { type: 'wake' } | { type: 'cancel'; reason: string }): Promise<void> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'signal: runId must be a non-empty string');
    const loop = this.#runs.get(runId);
    const live = loop && !loop.finished ? loop : undefined;
    if (signal?.type === 'wake') {
      live?.waker.wake();
      live?.observeWaker.pulse();
      return;
    }
    if (signal?.type === 'cancel') {
      if (typeof signal.reason !== 'string' || signal.reason.trim() === '') throw new HypertestError('invalid_argument', 'signal cancel: reason is required');
      // the control plane is the authority: the run and its open work are cancelled there first
      await this.#control.cancelRun(runId, signal.reason);
      if (live) {
        live.workStop.abort(new HypertestError('cancelled', `run ${runId} cancelled: ${signal.reason}`));
        live.waker.wake(); // the next tick reports the cancelled run as final
      }
      return;
    }
    throw new HypertestError('invalid_argument', `signal: unknown signal type ${JSON.stringify((signal as { type?: unknown } | undefined)?.type)}`);
  }

  async awaitCompletion(runId: string, options: { timeoutMs?: number } = {}): Promise<RunOutcome> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'awaitCompletion: runId must be a non-empty string');
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs >= 0)) throw new HypertestError('invalid_argument', `awaitCompletion: timeoutMs must be ≥ 0 (got ${String(timeoutMs)})`);
    this.#assertOpen('awaitCompletion');
    const ctrl = new AbortController();
    const signal = AbortSignal.any([this.#root.signal, ctrl.signal]);
    const racers: Array<Promise<RunOutcome>> = [this.#pollOutcome(runId, signal)];
    const loop = this.#runs.get(runId);
    if (loop) racers.push(loop.outcome.promise);
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      racers.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HypertestError('timeout', `run ${runId} did not complete within ${timeoutMs}ms`, { details: { runId } })), timeoutMs);
      }));
    }
    try {
      return await Promise.race(racers);
    } finally {
      if (timer) clearTimeout(timer);
      ctrl.abort();
    }
  }

  async resumeIncomplete(): Promise<string[]> {
    this.#assertOpen('resumeIncomplete');
    const ids = (await this.#listRuns()).filter((r) => RESUMABLE.has(r.status)).map((r) => r.runId);
    for (const runId of ids) await this.startRun(runId);
    if (ids.length > 0) this.#logger.info('resumed incomplete runs', { runs: ids });
    return ids;
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#root.abort(new HypertestError('cancelled', 'the durable runtime shut down'));
      await Promise.allSettled([...this.#runs.values()].map((l) => l.done));
    })();
    return this.#shutdown;
  }

  // ------------------------------------------------------------------------------------------------ run loop

  #assertOpen(what: string): void {
    if (this.#root.signal.aborted) throw new HypertestError('precondition_failed', `${what}: the durable runtime is shut down`);
  }

  async #drive(loop: RunLoop): Promise<void> {
    const { runId, runSignal: signal } = loop;
    let final = false;
    try {
      await this.#retrying('recover', { runId }, () => this.#control.recover(runId, signal), signal, true);
      let zeroStreak = 0;
      while (!signal.aborted) {
        loop.waker.clear();
        // standby on `unavailable` (the store is down): the run loop outlives an outage of any length — it is the only
        // thing that re-dispatches this run's work in this process
        const r = await this.#retrying('tick', { runId }, () => this.#control.tick(runId), signal, true);
        if (r.final) {
          final = true;
          loop.outcome.resolve(outcomeOf(r));
          this.#logger.info('run finished', { runId, status: r.status, verdict: r.decision?.verdict });
          return;
        }
        for (const d of r.dispatched) this.#startWork(loop, d.workItemId, d.fencingToken);
        for (const w of r.waiting) if (!loop.workers.has(w.workItemId)) this.#startWork(loop, w.workItemId, undefined);
        const idle = Math.min(Math.max(0, r.idleMs), this.#maxIdleMs);
        if (idle > 0) {
          zeroStreak = 0;
          await loop.waker.wait(idle, signal);
        } else if (++zeroStreak >= ZERO_IDLE_STREAK) {
          zeroStreak = 0;
          await loop.waker.wait(ZERO_IDLE_YIELD_MS, signal);
        }
      }
    } catch (e) {
      if (!signal.aborted) {
        const cause = e instanceof GiveUp ? e.cause : e;
        this.#logger.error('run loop failed; the run stays resumable (resumeIncomplete / startRun)', { runId, code: faultCode(cause), error: errorMessage(cause) });
        loop.outcome.reject(cause);
      }
    } finally {
      if (!loop.outcome.settled) loop.outcome.reject(new HypertestError('cancelled', `the durable loop of run ${runId} stopped before the run completed (runtime shut down)`, { details: { runId } }));
      loop.stop.abort(new HypertestError('cancelled', `run loop of ${runId} ended`));
      await Promise.allSettled([...loop.workers.values()].map((w) => w.promise));
      loop.finished = true;
      // a finished run needs no loop record (awaitCompletion answers from the control plane); a failed loop is kept so
      // that awaitCompletion reports its fault until startRun replaces it
      if (final && this.#runs.get(runId) === loop) this.#runs.delete(runId);
    }
  }

  /**
   * Calls `fn` until it succeeds, retrying retryable faults (bounded by maxAttempts, exponential backoff). With `standby`
   * (recover, tick), `unavailable` — the run is owned by another live worker until its lease expires, or the store is
   * down — is retried without bound: past maxAttempts every maxIdleMs.
   */
  async #retrying<T>(what: string, fields: Record<string, unknown>, fn: () => Promise<T>, signal: AbortSignal, standby: boolean): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new GiveUp(new HypertestError('cancelled', `${what} aborted`));
      try {
        return await fn();
      } catch (e) {
        if (signal.aborted) throw new GiveUp(e);
        const standingBy = standby && faultCode(e) === 'unavailable' && attempt >= this.#maxAttempts;
        if (!isRetryableFault(e) || (!standingBy && attempt >= this.#maxAttempts)) throw new GiveUp(e);
        const log = { ...fields, attempt, code: faultCode(e), error: errorMessage(e) };
        if (!standingBy) this.#logger.warn(`${what} failed; retrying`, log);
        else if (attempt === this.#maxAttempts) this.#logger.warn(`${what} unavailable (another live owner, or the store is down); standing by`, { ...log, everyMs: this.#maxIdleMs });
        else this.#logger.debug(`${what}: still unavailable; standing by`, log);
        const delay = standingBy ? this.#maxIdleMs : Math.min(RETRY_MAX_MS, this.#maxIdleMs, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 10));
        if (!(await pause(delay, signal))) throw new GiveUp(e);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ work loops

  #startWork(loop: RunLoop, workItemId: string, fencingToken: number | undefined): void {
    const current = loop.workers.get(workItemId);
    // one loop per item; a new claim (new token: the old one was requeued and lost its lease) gets its own loop
    if (current && !current.done && (fencingToken === undefined || current.token === fencingToken)) return;
    const w: WorkLoop = { workItemId, token: fencingToken, done: false, promise: Promise.resolve() };
    loop.workers.set(workItemId, w);
    w.promise = this.#work(loop, w)
      .catch((e: unknown) => this.#logger.error('work loop crashed', { runId: loop.runId, workItemId, error: errorMessage(e) }))
      .finally(() => {
        w.done = true;
        if (loop.workers.get(workItemId) === w) loop.workers.delete(workItemId);
        loop.waker.wake();
      });
  }

  async #work(loop: RunLoop, w: WorkLoop): Promise<void> {
    const signal = loop.workSignal;
    const { workItemId } = w;
    const fields = { runId: loop.runId, workItemId };
    let phase: 'turn' | 'observe' = w.token === undefined ? 'observe' : 'turn';
    let expectedTurn: number | undefined;
    let backoff = OBSERVE_BACKOFF_MIN_MS;
    try {
      while (!signal.aborted) {
        if (phase === 'turn' && w.token !== undefined) {
          const token = w.token;
          const options = expectedTurn === undefined ? undefined : { expectedTurn };
          const o = await this.#retrying('executeTurn', { ...fields, fencingToken: token, expectedTurn }, async () => {
            const release = await this.#semaphore.acquire();
            try {
              if (signal.aborted) throw new HypertestError('cancelled', 'work loop stopped');
              return await this.#control.executeTurn(workItemId, token, signal, options);
            } finally {
              release();
            }
          }, signal, false);
          if (o.status === 'continue') {
            expectedTurn = o.turn + 1;
            continue;
          }
          if (o.status === 'waiting') {
            phase = 'observe';
            backoff = OBSERVE_BACKOFF_MIN_MS;
            continue;
          }
          // lease_lost: the claim is gone (requeued or taken over); whoever holds the item now drives it — a newer token
          // is never adopted here (it may be a claim the scheduler dispatched to another work loop)
          this.#ended(o, fields);
          return;
        }
        // observe: poll the long-running operations with backoff until the item resumes or ends
        if (!(await loop.observeWaker.wait(backoff, signal))) return;
        const o = await this.#retrying('observeWaiting', fields, () => this.#control.observeWaiting(workItemId, signal), signal, false);
        if (o.status === 'continue') {
          // Resolved right after the resume (the lease was just renewed or re-taken, so the item cannot have been requeued
          // and re-dispatched meanwhile): observeWaiting may have re-taken the claim under a new fencing token.
          const token = await this.#claimAfterResume(workItemId, w.token, signal);
          if (token === undefined) {
            this.#logger.info('no claim token for a resumed work item; it continues through the scheduler (lease expiry ⇒ requeue)', fields);
            return;
          }
          w.token = token;
          phase = 'turn';
          expectedTurn = o.turn + 1;
          backoff = OBSERVE_BACKOFF_MIN_MS;
          continue;
        }
        if (o.status === 'waiting' || o.status === 'lease_lost') {
          // lease_lost while waiting: another worker still holds the item's lease (e.g. right after a takeover); keep
          // polling instead of ending (the run loop would restart an observer at once: a tick + observe hot loop)
          backoff = Math.min(OBSERVE_BACKOFF_MAX_MS, backoff * 2);
          continue;
        }
        this.#ended(o, fields);
        return;
      }
    } catch (e) {
      if (signal.aborted) return;
      const cause = e instanceof GiveUp ? e.cause : e;
      // the item keeps its claim until the lease expires; the scheduler then requeues it (bounded by maxWorkAttempts)
      this.#logger.error('work loop gave up; the item resumes through the scheduler (lease expiry ⇒ requeue)', { ...fields, code: faultCode(cause), error: errorMessage(cause) });
    }
  }

  /**
   * The claim to continue under after observeWaiting resumed an item: with the resolveClaim hook the claim THIS worker
   * holds now (undefined: none), else the token the loop already knows (undefined for an observer of an untracked item).
   */
  async #claimAfterResume(workItemId: string, known: number | undefined, signal: AbortSignal): Promise<number | undefined> {
    const resolve = this.#resolveClaim;
    if (!resolve) return known;
    const t = await this.#retrying('resolveClaim', { workItemId }, () => resolve(workItemId), signal, false);
    return Number.isSafeInteger(t) ? t : undefined;
  }

  #ended(o: TurnOutcome, fields: Record<string, unknown>): void {
    if (o.status === 'paused') this.#logger.info('work item paused with its run', { ...fields, reason: o.reason });
    else if (o.status === 'lease_lost') this.#logger.warn('work item lease lost; another claim owns it now', fields);
    else this.#logger.debug('work item ended', { ...fields, status: o.status });
  }

  // ------------------------------------------------------------------------------------------------ completion

  async #pollOutcome(runId: string, signal: AbortSignal): Promise<RunOutcome> {
    let delay = POLL_MIN_MS;
    const max = Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, this.#maxIdleMs));
    for (;;) {
      if (signal.aborted) throw new HypertestError('cancelled', `awaitCompletion(${runId}) aborted: the durable runtime shut down`, { details: { runId } });
      try {
        const run = await this.#getRun(runId);
        if (!run) throw new HypertestError('not_found', `run ${runId} not found`, { details: { runId } });
        if (TERMINAL.has(run.status)) return await this.#terminalOutcome(run);
      } catch (e) {
        if (!isRetryableFault(e)) throw e;
        this.#logger.debug('awaitCompletion poll failed; retrying', { runId, error: errorMessage(e) });
      }
      await pause(delay, signal);
      delay = Math.min(max, delay * 2);
    }
  }

  /** A terminal run's outcome; the decision comes from the control plane (tick on a terminal run is read-only). */
  async #terminalOutcome(run: TestRun): Promise<RunOutcome> {
    const r = await this.#control.tick(run.runId);
    return r.final ? outcomeOf(r) : { runId: run.runId, status: run.status };
  }
}
