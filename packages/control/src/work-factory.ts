import { HypertestError, type SqlExecutor } from '@hypertest/core';
import type { EventContext, WorkItem } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import type { ControlDeps } from './deps.ts';
import { event, isTerminalRunStatus } from './util.ts';

export type CreateWorkOutcome =
  | { status: 'created'; workItem: WorkItem }
  | { status: 'duplicate'; workItem: WorkItem }
  /** The run's work-item budget (maxWorkItems, I12) is exhausted: nothing was created. */
  | { status: 'capped'; reason: string };

export function runScope(runId: string): string {
  return `run:${runId}`;
}

export function workScope(workItemId: string): string {
  return `work:${workItemId}`;
}

/**
 * Creates work items under the run's work-item cap (budget dimension `workItems` of scope `run:<id>`):
 * fingerprint duplicates are a no-op (I5) and are not charged; a new item is charged in the same transaction as
 * its creation, so a rolled-back creation never consumes budget. When the cap is reached nothing is created and
 * `budget.exhausted` is recorded (the ledger emits no events itself).
 */
export class WorkFactory {
  readonly #deps: ControlDeps;
  constructor(deps: ControlDeps) {
    this.#deps = deps;
  }

  async remainingWorkItems(runId: string): Promise<number> {
    const usage = await this.#deps.budget.usage(runScope(runId));
    if (!usage) return Number.POSITIVE_INFINITY;
    const limit = usage.limits.workItems;
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    return limit - (usage.used.workItems ?? 0) - (usage.reserved.workItems ?? 0);
  }

  /**
   * Serializes work creation of one run (transaction-scoped advisory lock): the cap check, the per-rule counts of the
   * reactors and the charge see every committed creation. Lock order: callers take it BEFORE anything that locks the
   * run's event counter (any event append), so a work-creating transaction never deadlocks with another.
   */
  async lock(runId: string, tx: SqlExecutor): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ht_work:${runId}`]);
  }

  /** Creates (or finds) one work item. Joins the caller's transaction when `tx` is given. */
  async create(input: NewWorkItem, ctx: EventContext, tx?: SqlExecutor): Promise<CreateWorkOutcome> {
    const { db, blackboard, budget, events } = this.#deps;
    return db.transaction(async (q) => {
      const t = tx ?? q;
      await this.lock(input.runId, t);
      // durability-8: no work for an ended run (cancelRun changes the status under this lock, so a creation either
      // committed before it — and is swept — or sees the ended run here)
      const run = await this.#deps.runs.get(input.runId);
      if (run && isTerminalRunStatus(run.status)) {
        throw new HypertestError('conflict', `run ${input.runId} is ${run.status}: no work is created for it`, { details: { runId: input.runId, status: run.status } });
      }
      const existing = (await blackboard.listWorkItems({ runId: input.runId })).find((w) => w.fingerprint === input.fingerprint);
      if (existing) return { status: 'duplicate', workItem: existing };
      if ((await this.remainingWorkItems(input.runId)) < 1) {
        const reason = `work item cap reached for run ${input.runId} (maxWorkItems)`;
        await events.append([event(ctx, 'budget.exhausted', 'budget', runScope(input.runId), { scope: runScope(input.runId), dimension: 'workItems', reason, role: input.role, kind: input.kind })], t);
        return { status: 'capped', reason };
      }
      const r = await blackboard.createWorkItem(input, ctx, t);
      if (!r.created) return { status: 'duplicate', workItem: r.workItem };
      const charged = await budget.charge([runScope(input.runId)], { workItems: 1 }, `work:${r.workItem.workItemId}`);
      if (!charged.ok) {
        // A concurrent creator took the last slot between the check and the charge: roll the creation back.
        throw new HypertestError('budget_exhausted', `work item cap reached for run ${input.runId}`, { details: { runId: input.runId } });
      }
      return { status: 'created', workItem: r.workItem };
    });
  }
}
