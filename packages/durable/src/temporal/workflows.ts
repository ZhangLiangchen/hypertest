/**
 * Hypertest Temporal workflows. Deterministic workflow code: ONLY `@temporalio/workflow` and type-only imports; no
 * Node APIs, I/O, LLM calls, Date.now or randomness — every effect is an activity, a timer or a signal. Temporal
 * keeps "how accepted work survives failure"; the control plane (SQL) keeps every business fact, so the workflow
 * state is only the set of in-flight child workflows.
 *
 * Bundled by the Temporal worker (webpack + swc handle this `.ts` file; type-only imports are erased).
 *
 * NOTE: changing the command sequence of these workflows is not replay-compatible with histories recorded by an older
 * revision (Temporal non-determinism). Drain or restart running workflows on upgrade (I11: a live run is never
 * hot-swapped), or guard the change with `patched()`.
 */
import {
  ActivityFailure, ApplicationFailure, CancellationScope, ContinueAsNew, ParentClosePolicy, TemporalFailure, condition, continueAsNew, defineSignal,
  getExternalWorkflowHandle, isCancellation, log, proxyActivities, setHandler, startChild, workflowInfo,
} from '@temporalio/workflow';
import type { TickResult, TurnOutcome } from '@hypertest/control';
import type { RunOutcome } from '../contracts.ts';
import type { TemporalActivities } from './activities.ts';

/**
 * Activity error types the retry policy never retries. Kept identical to NON_RETRYABLE_ERROR_CODES of
 * src/errors.ts (workflow code may not import it; a unit test asserts the two lists are equal).
 */
export const WORKFLOW_NON_RETRYABLE_ERROR_TYPES: readonly string[] = [
  'invalid_argument',
  'not_found',
  'permission_denied',
  'stale_fence',
  'schema_violation',
  'integrity_violation',
  'unsupported',
  'budget_exhausted',
  'precondition_failed',
  'provider_error',
];

/** Loop iterations of one workflow run before continueAsNew bounds its history. */
export const DEFAULT_MAX_WORKFLOW_ITERATIONS = 200;
export const WORKFLOW_OBSERVE_BACKOFF_MIN_MS = 250;
export const WORKFLOW_OBSERVE_BACKOFF_MAX_MS = 2000;
/**
 * Default cap of the idle wait between ticks and interval of the recover standby (the control plane suggests ≤ 5 s;
 * the same default as the local runtime's maxIdleMs).
 */
export const DEFAULT_WORKFLOW_MAX_IDLE_MS = 5000;
/** @deprecated the idle cap is `TestRunWorkflowState.maxIdleMs` (default DEFAULT_WORKFLOW_MAX_IDLE_MS). */
export const WORKFLOW_MAX_IDLE_MS = 60_000;
/** Consecutive non-final ticks with idleMs 0 before the run workflow yields anyway (as the local runtime). */
export const WORKFLOW_ZERO_IDLE_STREAK = 20;
export const WORKFLOW_ZERO_IDLE_YIELD_MS = 50;

const retry = { maximumAttempts: 5, nonRetryableErrorTypes: [...WORKFLOW_NON_RETRYABLE_ERROR_TYPES] };
/** Scheduling steps: tick, observe, cancel, claim lookup. */
const control = proxyActivities<TemporalActivities>({ startToCloseTimeout: '2 minutes', retry });

/**
 * (durability-5) Default start-to-close bound of ONE agent-turn attempt: a turn is a model call plus up to
 * maxToolCallsPerTurn tool calls, each of which may legitimately run for an hour or two (test.run ≤ 1 h, mutation.run ≤ 2
 * h), so the bound must never be what ends a healthy turn. Liveness comes from the heartbeat timeout (the activity
 * heartbeats every 10 s): a crashed worker's attempt is retried within a minute. Override per runtime with
 * TemporalDurableOptions.turnTimeoutMs.
 */
export const DEFAULT_TURN_ACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Agent turns (heartbeating: a crashed worker's attempt is retried after the heartbeat timeout). */
function turnActivities(timeoutMs: number | undefined): TemporalActivities {
  return proxyActivities<TemporalActivities>({ startToCloseTimeout: timeoutMs ?? DEFAULT_TURN_ACTIVITY_TIMEOUT_MS, heartbeatTimeout: '1 minute', retry });
}
/**
 * Recovery. `unavailable` (the run is owned by another live worker until its lease expires, or the store is down) is
 * not retried by the policy: the run workflow stands by (every maxIdleMs, unbounded — as the local runtime) instead of
 * failing after five attempts while the previous owner's run lease is still live.
 */
const recovery = proxyActivities<TemporalActivities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '1 minute',
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: [...WORKFLOW_NON_RETRYABLE_ERROR_TYPES, 'unavailable'] },
});

/** Payload of a child's `wake` to its parent (external wakes carry none). */
export interface WakePayload {
  workItemId: string;
  workflowId: string;
  status: WorkItemWorkflowResult['status'];
}

export const wakeSignal = defineSignal<[WakePayload?]>('wake');
export const cancelSignal = defineSignal<[string]>('cancel');
/**
 * (additive, E[8]) ApprovalSignal: a human decided the approval (id). The run workflow wakes and forwards it to its
 * children: a work item waiting on an approval observes it at once instead of after its backoff.
 */
export const approvalSignal = defineSignal<[string]>('approval');

/** State carried by continueAsNew (never business state: that is in SQL). */
export interface TestRunWorkflowState {
  /** recover already ran for this run (it runs once, at the first execution). */
  recovered?: boolean;
  /** Child workflows still in flight (they are ABANDONed by continueAsNew and keep running). */
  children?: Array<{ workItemId: string; workflowId: string }>;
  maxIterations?: number;
  /** Cap of the idle wait between ticks and interval of the recover standby (default DEFAULT_WORKFLOW_MAX_IDLE_MS). */
  maxIdleMs?: number;
  /** (additive, durability-5) Start-to-close bound of one agent-turn attempt (default DEFAULT_TURN_ACTIVITY_TIMEOUT_MS). */
  turnTimeoutMs?: number;
}

export interface WorkItemWorkflowInput {
  workItemId: string;
  runId: string;
  /** The claim to execute under; absent for a waiting item the run found untracked (resolved after it resumes). */
  fencingToken?: number;
  /** (continueAsNew) the turn expected next. */
  expectedTurn?: number;
  /** (continueAsNew / untracked waiting item) where to resume. */
  phase?: 'turn' | 'observe';
  backoffMs?: number;
  /** @deprecated ignored: the claim is resolved right after observeWaiting resumes the item. */
  mayReresolve?: boolean;
  maxIterations?: number;
  parentWorkflowId?: string;
  /** (additive, durability-5) Start-to-close bound of one agent-turn attempt (default DEFAULT_TURN_ACTIVITY_TIMEOUT_MS). */
  turnTimeoutMs?: number;
}

export interface WorkItemWorkflowResult {
  workItemId: string;
  /** The last turn outcome; `no_claim`: no claim token to continue with; `error`: an activity failed for good. */
  status: TurnOutcome['status'] | 'no_claim' | 'error';
  error?: string;
}

export function runWorkflowId(runId: string): string {
  return `run-${runId}`;
}

/** One child per claim (`wi-<item>-<token>`); `wi-<item>-observe` for a waiting item the run found untracked. */
export function workItemWorkflowId(workItemId: string, fencingToken?: number): string {
  return fencingToken === undefined ? `wi-${workItemId}-observe` : `wi-${workItemId}-${fencingToken}`;
}

function outcomeOf(r: TickResult): RunOutcome {
  const out: RunOutcome = { runId: r.runId, status: r.status };
  if (r.decision) out.decision = r.decision;
  return out;
}

function isAlreadyStarted(e: unknown): boolean {
  return e instanceof Error && e.name === 'WorkflowExecutionAlreadyStartedError';
}

/** An activity that failed for good with the ApplicationFailure type `type` (a HypertestError code). */
function isActivityFault(e: unknown, type: string): boolean {
  return e instanceof ActivityFailure && e.cause instanceof ApplicationFailure && e.cause.type === type;
}

/**
 * testRunWorkflow(runId): recover (once; standby while another live worker owns the run) → loop { tick (standby while the
 * control plane stays `unavailable` beyond the retry policy); one
 * workItemWorkflow child per dispatched claim; an observer child per untracked waiting item; wait for `wake`
 * (children signal it when they end) or the tick's idle time } until the tick is final. Signals: `wake`,
 * `cancel(reason)` (control.cancelRun, then the final tick reports it).
 * Children are ABANDONed on close so that continueAsNew (every maxIterations) never kills an in-flight turn; the
 * tracked children are asked to cancel when the run is final AND when this workflow fails or is cancelled (a
 * restarted run workflow must be the only driver of its items: children of a failed execution would otherwise keep
 * driving them untracked, next to the new execution's own children).
 */
export async function testRunWorkflow(runId: string, state: TestRunWorkflowState = {}): Promise<RunOutcome> {
  const maxIterations = state.maxIterations ?? DEFAULT_MAX_WORKFLOW_ITERATIONS;
  const maxIdleMs = state.maxIdleMs ?? DEFAULT_WORKFLOW_MAX_IDLE_MS;
  const children = new Map<string, string>();
  for (const c of state.children ?? []) children.set(c.workItemId, c.workflowId);
  /** Children that already ended (a signal or the close event may overtake the start's resolution). */
  const ended = new Set<string>();
  let wakePending = false;
  let cancelReason: string | undefined;
  let cancelled = false;

  function untrack(workItemId: string, workflowId: string): void {
    ended.add(workflowId);
    if (children.get(workItemId) === workflowId) children.delete(workItemId);
  }

  setHandler(wakeSignal, (p?: WakePayload) => {
    wakePending = true;
    if (p && typeof p.workItemId === 'string' && typeof p.workflowId === 'string') untrack(p.workItemId, p.workflowId);
  });
  setHandler(cancelSignal, (reason: string) => {
    cancelReason ??= typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled';
    wakePending = true;
  });
  /** (E[8]) Approvals decided since the last forward to the children. */
  const approvalsDecided: string[] = [];
  setHandler(approvalSignal, (approvalId: string) => {
    if (typeof approvalId === 'string' && approvalId.length > 0) approvalsDecided.push(approvalId);
    wakePending = true;
  });
  async function forwardApprovals(): Promise<void> {
    if (approvalsDecided.length === 0) return;
    const decided = approvalsDecided.splice(0);
    for (const workflowId of [...children.values()]) {
      for (const id of decided) await getExternalWorkflowHandle(workflowId).signal(approvalSignal, id).catch(() => undefined); // closed: nothing to wake
    }
  }

  function nextState(recovered: boolean): TestRunWorkflowState {
    const next: TestRunWorkflowState = { recovered, children: [...children].map(([workItemId, workflowId]) => ({ workItemId, workflowId })), maxIterations };
    if (state.maxIdleMs !== undefined) next.maxIdleMs = state.maxIdleMs;
    if (state.turnTimeoutMs !== undefined) next.turnTimeoutMs = state.turnTimeoutMs;
    return next;
  }
  /** Fields every child inherits from the run workflow's state. */
  const inherited = (): Pick<WorkItemWorkflowInput, 'turnTimeoutMs'> => (state.turnTimeoutMs !== undefined ? { turnTimeoutMs: state.turnTimeoutMs } : {});

  async function startWorkItem(workflowId: string, input: WorkItemWorkflowInput): Promise<void> {
    ended.delete(workflowId);
    try {
      const handle = await startChild(workItemWorkflow, { workflowId, args: [input], parentClosePolicy: ParentClosePolicy.ABANDON });
      // Its close event (completed, failed, cancelled or terminated) untracks it too: a child that ended without its
      // `wake` (terminated, or an older revision cancelled) must not keep its waiting item unobserved forever.
      const onClose = () => {
        wakePending = true;
        untrack(input.workItemId, workflowId);
      };
      handle.result().then(onClose, onClose);
    } catch (e) {
      if (!isAlreadyStarted(e)) throw e;
      log.warn('work item workflow already running; tracking it', { workflowId });
    }
    if (!ended.has(workflowId)) children.set(input.workItemId, workflowId);
  }

  async function cancelChildren(): Promise<void> {
    for (const workflowId of [...children.values()]) {
      await getExternalWorkflowHandle(workflowId).cancel().catch(() => undefined); // already closed: nothing to do
    }
  }

  async function cancelRunIfSignalled(): Promise<void> {
    if (cancelReason === undefined || cancelled) return;
    await control.cancelRun(runId, cancelReason);
    cancelled = true;
  }

  async function recoverWithStandby(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await recovery.recover(runId);
        return;
      } catch (e) {
        if (!isActivityFault(e, 'unavailable')) throw e;
        if (attempt === 1) log.info('run owned by another live worker (or the store is unavailable); standing by', { runId, error: e instanceof Error ? e.cause instanceof Error ? e.cause.message : e.message : String(e) });
      }
      // a cancel is not delayed by the standby (the control plane is the authority; recover still runs afterwards,
      // it reconciles the run's operations whatever the run status); a store still down retries it next round
      try {
        await cancelRunIfSignalled();
      } catch (e) {
        if (!isActivityFault(e, 'unavailable')) throw e;
      }
      if (attempt >= maxIterations) await continueAsNew<typeof testRunWorkflow>(runId, nextState(false));
      await condition(() => cancelReason !== undefined && !cancelled, maxIdleMs);
    }
  }

  try {
    if (!state.recovered) await recoverWithStandby();
    let zeroIdle = 0;
    let standingBy = false;
    for (let iteration = 0; ; iteration++) {
      let r: TickResult;
      try {
        await cancelRunIfSignalled();
        if (iteration >= maxIterations) return await continueAsNew<typeof testRunWorkflow>(runId, nextState(true));
        wakePending = false;
        await forwardApprovals();
        r = await control.tick(runId);
      } catch (e) {
        // the control plane's store stayed down beyond the retry policy: stand by (every maxIdleMs, bounded history via
        // the iteration count) — a store outage must not fail the run workflow (nothing would drive the run until the
        // next resumeIncomplete)
        if (!isActivityFault(e, 'unavailable')) throw e;
        if (!standingBy) log.warn('control plane unavailable; the run workflow stands by', { runId, error: e instanceof Error ? e.message : String(e) });
        standingBy = true;
        zeroIdle = 0;
        await condition(() => cancelReason !== undefined && !cancelled, maxIdleMs);
        continue;
      }
      standingBy = false;
      if (r.final) {
        await cancelChildren();
        return outcomeOf(r);
      }
      for (const d of r.dispatched) {
        const input: WorkItemWorkflowInput = { workItemId: d.workItemId, fencingToken: d.fencingToken, runId, maxIterations, ...inherited() };
        // durability-9: even the first turn names the turn it expects (a retried first call never advances twice)
        if (d.nextTurn !== undefined) input.expectedTurn = d.nextTurn;
        await startWorkItem(workItemWorkflowId(d.workItemId, d.fencingToken), input);
      }
      for (const w of r.waiting) {
        if (children.has(w.workItemId)) continue;
        await startWorkItem(workItemWorkflowId(w.workItemId), { workItemId: w.workItemId, runId, phase: 'observe', maxIterations, ...inherited() });
      }
      const idle = Math.min(Math.max(0, r.idleMs), maxIdleMs);
      if (idle > 0) {
        zeroIdle = 0;
        if (!wakePending) await condition(() => wakePending, idle);
      } else if (++zeroIdle >= WORKFLOW_ZERO_IDLE_STREAK) {
        // a control plane reporting progress forever must not drive back-to-back ticks without end
        zeroIdle = 0;
        if (!wakePending) await condition(() => wakePending, WORKFLOW_ZERO_IDLE_YIELD_MS);
      }
    }
  } catch (e) {
    if (e instanceof ContinueAsNew) throw e;
    // This execution closes (failed or cancelled): its children must not outlive it untracked.
    if (e instanceof TemporalFailure || isCancellation(e)) await CancellationScope.nonCancellable(() => cancelChildren());
    throw e;
  }
}

/**
 * workItemWorkflow: executeTurn while it continues (each call names the expected turn: an activity retried after a
 * crash never advances twice); waiting ⇒ wait(backoff 250 ms → 2 s, ended early by an ApprovalSignal) + observeWaiting until the item resumes (a
 * `lease_lost` observation — another worker still holds the waiting item's lease — keeps polling); once resumed, the
 * turns continue under the claim this worker holds now (observeWaiting may have re-taken it under a new token), or
 * the child ends `no_claim`. Ends on completed/failed/cancelled/paused/lease_lost and signals the parent `wake` —
 * also when it is cancelled.
 */
export async function workItemWorkflow(input: WorkItemWorkflowInput): Promise<WorkItemWorkflowResult> {
  const { workItemId } = input;
  const parentWorkflowId = input.parentWorkflowId ?? workflowInfo().parent?.workflowId ?? runWorkflowId(input.runId);
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_WORKFLOW_ITERATIONS;
  let token = input.fencingToken;
  let expectedTurn = input.expectedTurn;
  let phase: 'turn' | 'observe' = input.phase ?? (token === undefined ? 'observe' : 'turn');
  let backoff = input.backoffMs ?? WORKFLOW_OBSERVE_BACKOFF_MIN_MS;
  const turns = turnActivities(input.turnTimeoutMs);
  /** (E[8]) An ApprovalSignal ends the current observe backoff at once (the decision is observed now). */
  let approvalWoken = false;
  setHandler(approvalSignal, () => {
    approvalWoken = true;
  });

  async function drive(): Promise<WorkItemWorkflowResult> {
    for (let iteration = 0; ; iteration++) {
      if (iteration >= maxIterations) {
        const next: WorkItemWorkflowInput = { workItemId, runId: input.runId, phase, backoffMs: backoff, maxIterations, parentWorkflowId };
        if (input.turnTimeoutMs !== undefined) next.turnTimeoutMs = input.turnTimeoutMs;
        if (token !== undefined) next.fencingToken = token;
        if (expectedTurn !== undefined) next.expectedTurn = expectedTurn;
        return await continueAsNew<typeof workItemWorkflow>(next);
      }
      if (phase === 'turn') {
        if (token === undefined) {
          // (an input without a claim in the turn phase: resolve it once)
          const t = await control.claimAfterResume({ workItemId });
          if (t === null) return { workItemId, status: 'no_claim' };
          token = t;
        }
        const current = token;
        const o = await turns.executeTurn(expectedTurn === undefined ? { workItemId, fencingToken: current } : { workItemId, fencingToken: current, expectedTurn });
        if (o.status === 'continue') {
          expectedTurn = o.turn + 1;
          continue;
        }
        if (o.status === 'waiting') {
          phase = 'observe';
          backoff = WORKFLOW_OBSERVE_BACKOFF_MIN_MS;
          continue;
        }
        // lease_lost: the claim is gone (requeued or taken over): whoever holds the item now drives it — never adopted
        return { workItemId, status: o.status };
      }
      if (!approvalWoken) await condition(() => approvalWoken, backoff);
      approvalWoken = false;
      const o = await control.observeWaiting(workItemId);
      if (o.status === 'continue') {
        // Resolved right after the resume (the lease was just renewed or re-taken, so it cannot have been requeued and
        // re-dispatched meanwhile): never after a later lease_lost, when the token found could be a newer claim that
        // the scheduler dispatched to another child.
        const t = await control.claimAfterResume(token === undefined ? { workItemId } : { workItemId, fencingToken: token });
        if (t === null) return { workItemId, status: 'no_claim' };
        token = t;
        phase = 'turn';
        expectedTurn = o.turn + 1;
        backoff = WORKFLOW_OBSERVE_BACKOFF_MIN_MS;
        continue;
      }
      if (o.status === 'waiting' || o.status === 'lease_lost') {
        backoff = Math.min(WORKFLOW_OBSERVE_BACKOFF_MAX_MS, backoff * 2);
        continue;
      }
      return { workItemId, status: o.status };
    }
  }

  async function notifyParent(result: WorkItemWorkflowResult): Promise<void> {
    const payload: WakePayload = { workItemId, workflowId: workflowInfo().workflowId, status: result.status };
    await getExternalWorkflowHandle(parentWorkflowId)
      .signal(wakeSignal, payload)
      .catch((e: unknown) => log.debug('parent not signalled (closed)', { parentWorkflowId, error: e instanceof Error ? e.message : String(e) }));
  }

  let result: WorkItemWorkflowResult;
  try {
    result = await drive();
  } catch (e) {
    if (e instanceof ContinueAsNew) throw e;
    if (isCancellation(e)) {
      // cancelled (by the parent at the run's end or failure, or by an operator): the parent still learns it ended
      const cancelledResult: WorkItemWorkflowResult = { workItemId, status: 'cancelled' };
      await CancellationScope.nonCancellable(() => notifyParent(cancelledResult));
      return cancelledResult;
    }
    if (!(e instanceof ActivityFailure)) throw e;
    // retries exhausted / non-retryable: the item keeps its claim until the lease expires, then the scheduler requeues it
    const cause = e.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}` : e.message;
    log.warn('work item workflow gave up after an activity failure', { workItemId, error: cause });
    result = { workItemId, status: 'error', error: cause };
  }
  await notifyParent(result);
  return result;
}
