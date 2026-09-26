import { isHypertestError } from '@hypertest/core';
import type { EventContext, ResourceLease, TestRun, WorkItem } from '@hypertest/domain';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { runCtx } from './util.ts';

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
}

export interface Scheduler {
  /** The run lease (`run/<runId>`, owner = workerId); undefined when another live owner holds it. */
  acquireRunLease(runId: string): Promise<ResourceLease | undefined>;
  /** blocked ⇒ ready when every dependency completed; a failed/cancelled/missing dependency fails the item. */
  unblock(runId: string, items: WorkItem[]): Promise<{ readied: string[]; failed: string[] }>;
  /** claimed/running items whose claim and lease expired ⇒ requeued (their fencing token becomes stale); ids changed. */
  expireLeases(runId: string, items: WorkItem[]): Promise<string[]>;
  /** Admission: priority order, concurrency cap, resource claims, then a lease + fencing claim per item. */
  admit(run: TestRun, items: WorkItem[]): Promise<Dispatch[]>;
  /** Frees the lease and resource claims held for a work item. */
  release(item: WorkItem): Promise<void>;
  /**
   * Takes an orphaned claimed/running/waiting item away from its worker: back to `ready` (attempts + 1, claim dropped
   * ⇒ its fencing token is stale), or `failed` (`lease_lost`) once it lost its worker `maxWorkAttempts` times (a
   * poison item never livelocks the run). Returns the new state. Throws the Blackboard's conflict/stale_fence.
   */
  requeue(item: WorkItem, ctx: EventContext, reason: string, expectedFencingToken?: number): Promise<'ready' | 'failed'>;
}

/**
 * The DynamicScheduler (I12): the control plane keeps admission and convergence authority. Every state change goes
 * through the Blackboard's work-item state machine with fencing; the scheduler never executes work itself.
 */
export function createScheduler(deps: ControlDeps, config: ResolvedControlConfig): Scheduler {
  const { blackboard, leases, admission, clock, logger } = deps;
  const workerId = config.workerId;

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

  return {
    requeue,

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

    async admit(run, items) {
      const dispatched: Dispatch[] = [];
      let active = items.filter((w) => w.state === 'claimed' || w.state === 'running').length;
      const ready = items
        .filter((w) => w.state === 'ready')
        .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.workItemId < b.workItemId ? -1 : 1));
      for (const w of ready) {
        if (active >= run.budget.maxAgentConcurrency) break;
        const hasClaims = w.resourceClaims.length > 0;
        if (hasClaims) {
          const adm = await admission.admit({ holderId: w.workItemId, runId: run.runId, claims: w.resourceClaims, ttlMs: config.leaseTtlMs });
          if (!adm.admitted) {
            logger.debug('work item not admitted: resource conflict', { workItemId: w.workItemId, conflicts: adm.conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`) });
            continue;
          }
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
        dispatched.push({ workItemId: w.workItemId, ownerId: workerId, fencingToken: lease.fencingToken });
        active++;
      }
      return dispatched;
    },

    async release(item) {
      if (item.claim) await leases.release(item.claim.leaseId);
      if (item.resourceClaims.length > 0) await admission.release(item.workItemId);
    },
  };
}
