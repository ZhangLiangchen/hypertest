import { isHypertestError } from '@hypertest/core';
import { EVENT_TYPES, type EventContext, type ResourceLease, type TestRun, type WorkItem } from '@hypertest/domain';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { compatibleClaimHolders, releaseRunIsolation, settleExternalQps, syncExperimentClaims, type ExperimentSync } from './isolation.ts';
import { event, runCtx } from './util.ts';

export function workLeaseKey(workItemId: string): string {
  return `work/${workItemId}`;
}

export function runLeaseKey(runId: string): string {
  return `run/${runId}`;
}

export interface Dispatch {
  workItemId: string;
  ownerId: string;
  fencingToken: number;
  /** (durability-9) The turn the item's session runs next (1 for a new agent). */
  nextTurn?: number;
}

export interface Scheduler {
  /** The run lease (`run/<runId>`, owner = workerId); undefined when another live owner holds it. */
  acquireRunLease(runId: string): Promise<ResourceLease | undefined>;
  /** blocked ⇒ ready when every dependency completed; a failed/cancelled/missing dependency fails the item. */
  unblock(runId: string, items: WorkItem[]): Promise<{ readied: string[]; failed: string[] }>;
  /** claimed/running items whose claim and lease expired ⇒ requeued (their fencing token becomes stale); ids changed. */
  expireLeases(runId: string, items: WorkItem[]): Promise<string[]>;
  /**
   * Admission: priority order, concurrency cap, resource claims, then a lease + fencing claim per item. `maxDispatch`
   * (additive; H6) caps the claims handed out now — the durable runtime's free executor capacity — so no claim waits
   * unrenewed behind a full executor.
   */
  admit(run: TestRun, items: WorkItem[], maxDispatch?: number): Promise<Dispatch[]>;
  /**
   * (additive; H13, durability-2) Gives a claimed/running item back WITHOUT counting a lost worker: `ready`, claim dropped
   * (its fencing token becomes stale), attempts unchanged, lease and resource claims released. For a pause or a lapsed
   * resource claim — not the worker's fault. Throws the Blackboard's conflict/stale_fence.
   */
  yieldClaim(item: WorkItem, fencingToken: number, ctx: EventContext, reason: string): Promise<void>;
  /** Frees the lease and resource claims held for a work item. */
  release(item: WorkItem): Promise<void>;
  /**
   * (additive, conformance-5/6) Isolation upkeep of a live run, every tick before admission: the claims of its experiments
   * are renewed while an owner (defining or declaring work item) is live and released otherwise; QPS reservations of load
   * jobs that ended are given back. `progressed` when anything was released.
   */
  syncIsolation?(run: TestRun, items: WorkItem[]): Promise<ExperimentSync & { qpsReleased: string[] }>;
  /** (additive, conformance-5/6) Releases everything a finished run still holds (experiment claims, open reservations). */
  releaseRun?(runId: string): Promise<void>;
  /**
   * Takes an orphaned claimed/running/waiting item away from its worker: back to `ready` (attempts + 1, claim dropped
   * ⇒ its fencing token is stale), or `failed` (`lease_lost`) once it lost its worker `maxWorkAttempts` times (a
   * poison item never livelocks the run). Returns the new state. Throws the Blackboard's conflict/stale_fence.
   */
  requeue(item: WorkItem, ctx: EventContext, reason: string, expectedFencingToken?: number): Promise<'ready' | 'failed'>;
}

/**
 * (H13, durability-2) Gives a claimed/running item back without counting a lost worker: `ready` with the claim dropped
 * (fenced by the caller's token), attempts unchanged, then its lease and resource claims are released.
 */
export async function yieldWorkClaim(
  deps: Pick<ControlDeps, 'blackboard' | 'leases' | 'admission' | 'logger'>,
  w: WorkItem,
  fencingToken: number,
  ctx: EventContext,
  reason: string,
): Promise<void> {
  const wctx = { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId };
  await deps.blackboard.transitionWorkItem(w.workItemId, 'ready', { claim: null }, wctx, { expectedFencingToken: fencingToken, expectedFrom: ['claimed', 'running'] });
  if (w.claim) await deps.leases.release(w.claim.leaseId).catch(() => undefined);
  await deps.admission.release(w.workItemId);
  deps.logger.info('work item claim yielded (no attempt consumed)', { runId: w.runId, workItemId: w.workItemId, fencingToken, reason });
}

/**
 * The DynamicScheduler (I12): the control plane keeps admission and convergence authority. Every state change goes
 * through the Blackboard's work-item state machine with fencing; the scheduler never executes work itself.
 */
export function createScheduler(deps: ControlDeps, config: ResolvedControlConfig): Scheduler {
  const { blackboard, leases, admission, events, clock, logger } = deps;
  const workerId = config.workerId;
  /** Last refusal reported per item (admission.refused once per distinct conflict set, not every tick). */
  const refusals = new Map<string, string>();
  /** Last lapse reported per experiment (admission.lapsed once per distinct conflict set). */
  const experimentLapses = new Map<string, string>();

  async function requeue(w: WorkItem, ctx: EventContext, reason: string, expectedFencingToken?: number): Promise<'ready' | 'failed'> {
    const attempts = w.attempts + 1;
    const options: Parameters<typeof blackboard.transitionWorkItem>[4] = { expectedFrom: [w.state] };
    if (expectedFencingToken !== undefined) options.expectedFencingToken = expectedFencingToken;
    const wctx = { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId };
    if (attempts >= config.maxWorkAttempts) {
      await blackboard.transitionWorkItem(
        w.workItemId,
        'failed',
        { attempts, failure: { reason: 'lease_lost', message: `${reason}; the item lost its worker ${attempts} times (maxWorkAttempts ${config.maxWorkAttempts})` } },
        wctx,
        options,
      );
      await admission.release(w.workItemId);
      logger.warn('work item failed after repeatedly losing its worker', { runId: w.runId, workItemId: w.workItemId, attempts });
      return 'failed';
    }
    await blackboard.transitionWorkItem(w.workItemId, 'ready', { claim: null, attempts }, wctx, options);
    await admission.release(w.workItemId);
    return 'ready';
  }

  const yieldClaim = (w: WorkItem, fencingToken: number, ctx: EventContext, reason: string) => yieldWorkClaim(deps, w, fencingToken, ctx, reason);

  /** The turn a work item's session runs next: the last committed turn + 1 (1 when it has no agent yet). */
  async function nextTurnOf(workItemId: string): Promise<number> {
    const agent = await deps.agents.byWorkItem(workItemId);
    if (!agent) return 1;
    const last = await deps.sessions.lastTurn(agent.sessionId);
    return (last?.turn ?? 0) + 1;
  }

  return {
    requeue,
    yieldClaim,

    acquireRunLease(runId) {
      return leases.acquire({ resourceKey: runLeaseKey(runId), owner: workerId, ttlMs: config.runLeaseTtlMs });
    },

    async unblock(runId, items) {
      const byId = new Map(items.map((w) => [w.workItemId, w]));
      const readied: string[] = [];
      const failed: string[] = [];
      const ctx = runCtx(runId, workerId);
      for (const w of items) {
        if (w.state !== 'blocked') continue;
        const bad = w.dependsOn.map((d) => ({ d, dep: byId.get(d) })).find(({ dep }) => !dep || dep.state === 'failed' || dep.state === 'cancelled');
        try {
          if (bad) {
            await blackboard.transitionWorkItem(
              w.workItemId,
              'failed',
              { failure: { reason: 'dependency_failed', message: `dependency ${bad.d} is ${bad.dep ? bad.dep.state : 'missing'}` } },
              { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId },
              { expectedFrom: ['blocked'] },
            );
            failed.push(w.workItemId);
          } else if (w.dependsOn.every((d) => byId.get(d)?.state === 'completed')) {
            await blackboard.transitionWorkItem(w.workItemId, 'ready', {}, { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId }, { expectedFrom: ['blocked'] });
            readied.push(w.workItemId);
          }
        } catch (e) {
          if (!isHypertestError(e, 'conflict')) throw e; // moved concurrently: the next tick sees the new state
        }
      }
      return { readied, failed };
    },

    async expireLeases(runId, items) {
      const now = clock.nowMs();
      const requeued: string[] = [];
      for (const w of items) {
        if ((w.state !== 'claimed' && w.state !== 'running') || !w.claim) continue;
        if (Date.parse(w.claim.expiresAt) >= now) continue;
        const live = await leases.current(workLeaseKey(w.workItemId));
        if (live && live.fencingToken === w.claim.fencingToken) continue; // renewed; the claim record only lags
        try {
          const to = await requeue(w, runCtx(runId, workerId), `lease of ${w.claim.ownerId} (token ${w.claim.fencingToken}) expired`, w.claim.fencingToken);
          requeued.push(w.workItemId);
          if (to === 'ready') logger.warn('work item lease expired; requeued', { runId, workItemId: w.workItemId, owner: w.claim.ownerId, fencingToken: w.claim.fencingToken });
        } catch (e) {
          if (!isHypertestError(e, 'conflict') && !isHypertestError(e, 'stale_fence')) throw e;
        }
      }
      return requeued;
    },

    async admit(run, items, maxDispatch) {
      const dispatched: Dispatch[] = [];
      const cap = maxDispatch === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(maxDispatch));
      let active = items.filter((w) => w.state === 'claimed' || w.state === 'running').length;
      const ready = items
        .filter((w) => w.state === 'ready')
        .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.workItemId < b.workItemId ? -1 : 1));
      const ctxOf = (w: WorkItem) => ({ ...runCtx(run.runId, workerId), workItemId: w.workItemId, correlationId: w.workItemId });
      for (const w of ready) {
        if (active >= run.budget.maxAgentConcurrency || dispatched.length >= cap) break;
        const hasClaims = w.resourceClaims.length > 0;
        if (hasClaims) {
          // (conformance-6) an item that runs for experiments shares their admitted claims (never refused by them)
          const adm = await admission.admit({ holderId: w.workItemId, runId: run.runId, claims: w.resourceClaims, ttlMs: config.leaseTtlMs, compatibleHolders: await compatibleClaimHolders(deps, w) });
          if (!adm.admitted) {
            const conflicts = adm.conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`).sort();
            logger.info('work item not admitted: resource conflict', { workItemId: w.workItemId, conflicts });
            // L0 audit of the refusal (durability-2), once per distinct conflict set
            const signature = conflicts.join('\u0000');
            if (refusals.get(w.workItemId) !== signature) {
              refusals.set(w.workItemId, signature);
              if (refusals.size > 10_000) refusals.delete(refusals.keys().next().value!);
              await events.append([event(ctxOf(w), EVENT_TYPES.admissionRefused, 'work_item', w.workItemId, { workItemId: w.workItemId, conflicts, claims: w.resourceClaims })]);
            }
            continue;
          }
          refusals.delete(w.workItemId);
        }
        const lease = await leases.acquire({ resourceKey: workLeaseKey(w.workItemId), owner: workerId, ttlMs: config.leaseTtlMs });
        if (!lease) {
          if (hasClaims) await admission.release(w.workItemId);
          continue;
        }
        try {
          await blackboard.transitionWorkItem(
            w.workItemId,
            'claimed',
            { claim: { ownerId: workerId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt } },
            { ...runCtx(run.runId, workerId), workItemId: w.workItemId, correlationId: w.workItemId },
            { expectedFrom: ['ready'] },
          );
        } catch (e) {
          await leases.release(lease.leaseId);
          if (hasClaims) await admission.release(w.workItemId);
          if (isHypertestError(e, 'conflict') || isHypertestError(e, 'stale_fence') || isHypertestError(e, 'precondition_failed')) continue;
          throw e;
        }
        if (hasClaims) await events.append([event(ctxOf(w), EVENT_TYPES.admissionGranted, 'work_item', w.workItemId, { workItemId: w.workItemId, claims: w.resourceClaims, fencingToken: lease.fencingToken })]);
        dispatched.push({ workItemId: w.workItemId, ownerId: workerId, fencingToken: lease.fencingToken, nextTurn: await nextTurnOf(w.workItemId) });
        active++;
      }
      return dispatched;
    },

    async release(item) {
      if (item.claim) await leases.release(item.claim.leaseId);
      if (item.resourceClaims.length > 0) await admission.release(item.workItemId);
    },

    async syncIsolation(run, items) {
      const sync = await syncExperimentClaims(deps, config, run, items, experimentLapses);
      const qpsReleased = await settleExternalQps(deps, run.runId);
      return { ...sync, qpsReleased };
    },

    async releaseRun(runId) {
      await releaseRunIsolation(deps, runId, runCtx(runId, workerId));
      for (const e of await deps.specs.listExperiments(runId)) experimentLapses.delete(e.experimentId);
    },
  };
}
