import { ApplicationFailure, Context } from '@temporalio/activity';
import { isHypertestError } from '@hypertest/core';
import type { ControlPlane, TickResult, TurnOutcome } from '@hypertest/control';
import { NON_RETRYABLE_ERROR_CODES, errorMessage, faultCode, isRetryableFault } from '../errors.ts';

/** Input of the executeTurn activity: the claim and the turn the workflow expects to run (idempotent retries). */
export interface ExecuteTurnActivityInput {
  workItemId: string;
  fencingToken: number;
  /** The turn about to run: a retried activity whose turn already committed returns `continue` without running. */
  expectedTurn?: number;
}

/** The activities of the Hypertest workflows: thin, stateless adapters over the ControlPlane facade. */
export interface TemporalActivities {
  recover(runId: string): Promise<{ reconciled: number; requeued: string[] }>;
  tick(runId: string): Promise<TickResult>;
  executeTurn(input: ExecuteTurnActivityInput): Promise<TurnOutcome>;
  observeWaiting(workItemId: string): Promise<TurnOutcome>;
  cancelRun(runId: string, reason: string): Promise<void>;
  /** The fencing token of the claim this worker holds (null: none, or no resolveClaim hook configured). */
  resolveClaim(workItemId: string): Promise<number | null>;
  /**
   * (additive) The claim to continue a work item under right after observeWaiting resumed it: with a resolveClaim hook
   * the token of the claim THIS worker holds now (observeWaiting may have re-taken it under a new token; null: none);
   * without one the token the caller already knows (null when it knows none).
   */
  claimAfterResume(input: ClaimAfterResumeInput): Promise<number | null>;
}

/** Input of the claimAfterResume activity. */
export interface ClaimAfterResumeInput {
  workItemId: string;
  /** The claim the workflow executed under before the item waited (absent for an observer of an untracked item). */
  fencingToken?: number;
}

/** Error types the activity retry policy never retries (the workflows declare the same list; see workflows.ts). */
export const ACTIVITY_NON_RETRYABLE_ERROR_TYPES: readonly string[] = NON_RETRYABLE_ERROR_CODES;

/** Heartbeat interval of long activities (the workflows set a heartbeat timeout of 60 s on turn/recover). */
export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * A fault as a Temporal ApplicationFailure: `type` = HypertestError code (`internal` for anything else),
 * `nonRetryable` per code, details = the HypertestError details. Never a CancelledFailure: an activity aborted by a
 * worker shutdown is reported as a retryable failure, so the server retries it at once on another worker.
 */
export function toApplicationFailure(e: unknown): ApplicationFailure {
  if (e instanceof ApplicationFailure) return e;
  const type = faultCode(e);
  const details = isHypertestError(e) ? [e.details] : [];
  return ApplicationFailure.create({
    type,
    message: errorMessage(e),
    nonRetryable: !isRetryableFault(e),
    details,
    ...(e instanceof Error ? { cause: e } : {}),
  });
}

function activityContext(): Context | undefined {
  try {
    return Context.current();
  } catch {
    return undefined; // called outside an activity (tests, direct use)
  }
}

/** Runs one control call inside an activity: its cancellation signal, periodic heartbeats and error mapping. */
async function run<T>(fn: (signal: AbortSignal | undefined) => Promise<T>, heartbeat: boolean): Promise<T> {
  const ctx = activityContext();
  let timer: NodeJS.Timeout | undefined;
  if (ctx && heartbeat) {
    timer = setInterval(() => ctx.heartbeat(), ACTIVITY_HEARTBEAT_INTERVAL_MS);
    timer.unref();
  }
  try {
    return await fn(ctx?.cancellationSignal);
  } catch (e) {
    throw toApplicationFailure(e);
  } finally {
    if (timer) clearInterval(timer);
  }
}

/**
 * createTemporalActivities(control): {recover, tick, executeTurn, observeWaiting, cancelRun, resolveClaim, claimAfterResume}.
 * Every activity is safe to retry: the control plane persists each step, executeTurn is fenced and idempotent per
 * `expectedTurn`, observeWaiting only polls, recover/cancelRun are idempotent.
 */
export function createTemporalActivities(
  control: ControlPlane,
  options: { resolveClaim?: (workItemId: string) => Promise<number | undefined> } = {},
): TemporalActivities {
  const resolve = options.resolveClaim;
  return {
    recover: (runId) => run((signal) => control.recover(runId, signal), true),
    tick: (runId) => run(() => control.tick(runId), false),
    executeTurn: (input) =>
      run((signal) => control.executeTurn(input.workItemId, input.fencingToken, signal, input.expectedTurn === undefined ? undefined : { expectedTurn: input.expectedTurn }), true),
    observeWaiting: (workItemId) => run((signal) => control.observeWaiting(workItemId, signal), true),
    cancelRun: (runId, reason) => run(() => control.cancelRun(runId, reason), false),
    resolveClaim: (workItemId) =>
      run(async () => {
        if (!resolve) return null;
        const t = await resolve(workItemId);
        return Number.isSafeInteger(t) ? (t as number) : null;
      }, false),
    claimAfterResume: (input) =>
      run(async () => {
        if (!resolve) return Number.isSafeInteger(input.fencingToken) ? (input.fencingToken as number) : null;
        const t = await resolve(input.workItemId);
        return Number.isSafeInteger(t) ? (t as number) : null;
      }, false),
  };
}
