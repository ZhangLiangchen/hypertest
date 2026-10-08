import { HypertestError, type SqlDatabase } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type ActorRef, type DomainEventSink, type EventContext, type OperationRecord, type OperationStatus } from '@hypertest/domain';
import type { LeaseService, OperationLedger } from './contracts.ts';

/**
 * (stubs[8]) Manual review resolution. An operation whose outcome reconciliation could not establish (destructive /
 * high-risk, non-reconcilable, a late receipt after a re-dispatch) is escalated to `manual_review` and is never retried
 * blindly (I4). Only a HUMAN takes it out of there — after checking the target — with the outcome they observed:
 *  - `succeeded`   ⇒ `verified`    (the effect is in force);
 *  - `failed`      ⇒ `failed`      (the effect did not happen / failed; terminal — a retry is a new call);
 *  - `compensated` ⇒ `compensated` (the effect was undone).
 * The resolution is audited on L0 (`operation.resolved` `{ operationId, outcome, from, to, by, note }`, plus the ledger's
 * own transition event) in the transaction of the transition; the work waiting on the operation resumes with that
 * outcome. Agents never resolve operations (`permission_denied`): an agent would otherwise declare its own unknown side
 * effect a success.
 */

export type ManualReviewOutcome = 'succeeded' | 'failed' | 'compensated';
export const MANUAL_REVIEW_OUTCOMES: readonly ManualReviewOutcome[] = Object.freeze(['succeeded', 'failed', 'compensated']);

const TARGET: Record<ManualReviewOutcome, OperationStatus> = { succeeded: 'verified', failed: 'failed', compensated: 'compensated' };

export interface ResolveManualReviewInput {
  outcome: ManualReviewOutcome;
  /** The deciding human (`kind: 'human'`); an agent (or any other actor kind) is refused. */
  by: ActorRef;
  /** What the human checked on the target (required, audited). */
  note: string;
}

export interface ManualReviewDeps {
  db: SqlDatabase;
  ledger: OperationLedger;
  events?: DomainEventSink;
  /** Releases the operation's resource lease if it is still held (the effect's exclusivity ends with the review). */
  leases?: LeaseService;
}

/** Resolves an operation under manual review (see the module comment). Idempotent for the same outcome. */
export async function resolveManualReview(deps: ManualReviewDeps, operationId: string, input: ResolveManualReviewInput, ctx: EventContext): Promise<OperationRecord> {
  if (typeof operationId !== 'string' || operationId === '') throw new HypertestError('invalid_argument', 'operationId is required');
  if (!input || !MANUAL_REVIEW_OUTCOMES.includes(input.outcome)) throw new HypertestError('invalid_argument', `outcome must be one of ${MANUAL_REVIEW_OUTCOMES.join(', ')}`);
  const by = input.by;
  if (!by || typeof by.id !== 'string' || by.id.trim() === '') throw new HypertestError('invalid_argument', 'the resolving human (by) is required');
  if (by.kind !== 'human') {
    throw new HypertestError('permission_denied', `operation ${operationId}: only a human resolves a manual review (${by.kind}:${by.id} is not one)`, { details: { rule: 'human_only' } });
  }
  if (typeof input.note !== 'string' || input.note.trim() === '') throw new HypertestError('invalid_argument', 'a note on what was checked on the target is required');
  const note = input.note.trim().slice(0, 2000);
  const to = TARGET[input.outcome];
  const resolved = await deps.db.transaction(async (tx) => {
    const op = await deps.ledger.get(operationId);
    if (!op) throw new HypertestError('not_found', `operation ${operationId} not found`);
    if (op.runId !== ctx.runId) throw new HypertestError('invalid_argument', `operation ${operationId} belongs to run ${op.runId}, not ${ctx.runId}`);
    if (op.status !== 'manual_review') {
      // a repeated resolution with the same outcome is a no-op; anything else is a conflict
      if (op.status === to && (await alreadyResolved(deps, op, input.outcome))) return op;
      throw new HypertestError('precondition_failed', `operation ${operationId} is ${op.status}, not under manual review`, { details: { operationId, status: op.status } });
    }
    const verdict = `manual review by human:${by.id}: ${input.outcome} — ${note}`;
    // the verdict stays on the record (lastError: the latest reason of its status); a verified one keeps its result
    const patch: Parameters<OperationLedger['transition']>[2] = { lastError: verdict };
    if (to === 'verified' && op.result === undefined) patch.result = { resolvedBy: `human:${by.id}`, note };
    const rec = await deps.ledger.transition(operationId, to, patch, ctx, { expectedFrom: ['manual_review'], tx });
    if (deps.events) {
      await deps.events.emit(
        [
          eventFrom(ctx, EVENT_TYPES.operationResolved, 'operation', operationId, {
            operationId, operationType: op.operationType, resourceKey: op.target.resourceKey, outcome: input.outcome, from: 'manual_review', to, by: `human:${by.id}`, note,
            previousReason: op.lastError ?? null,
          }),
        ],
        tx,
      );
    }
    return rec;
  });
  // the effect's exclusivity ends with the review (a lease the gateway still holds for it is released)
  if (deps.leases && resolved.lease) {
    const live = await deps.leases.current(resolved.lease.resourceKey);
    if (live && live.leaseId === resolved.lease.leaseId) await deps.leases.release(live.leaseId).catch(() => undefined);
  }
  return resolved;
}

async function alreadyResolved(_deps: ManualReviewDeps, op: OperationRecord, outcome: ManualReviewOutcome): Promise<boolean> {
  // the record carries the reviewer's verdict (lastError) once resolved
  return typeof op.lastError === 'string' && op.lastError.startsWith('manual review by human:') && op.lastError.includes(`: ${outcome} — `);
}
