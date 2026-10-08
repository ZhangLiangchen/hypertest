import { HypertestError, fromJsonColumn, toIso, type JsonValue, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type ActorRef, type EventContext } from '@hypertest/domain';
import type { ApprovalConsumption, ApprovalRequest, ApprovalService, PolicyDeps } from './contracts.ts';
import { agentIndependenceViolation } from './independence.ts';
import { storable, storableString } from './storable.ts';

interface ApprovalRow {
  approval_id: string;
  run_id: string;
  kind: ApprovalRequest['kind'];
  subject: unknown;
  requested_by: unknown;
  status: ApprovalRequest['status'];
  decided_by: unknown;
  rationale: string | null;
  created_at: unknown;
  decided_at: unknown;
}

const KINDS: ReadonlySet<string> = new Set(['action', 'oracle_change', 'test_change', 'budget', 'manual_review', 'gate_exception']);
/**
 * Kinds an agent may never decide: they are the human-in-the-loop for side effects (`action`, from
 * approval_required permits), spend (`budget`) and explicit manual review. Agents can only request them.
 */
const HUMAN_OR_SYSTEM_KINDS: ReadonlySet<string> = new Set(['action', 'budget', 'manual_review']);
const STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'denied', 'expired']);

interface ConsumptionRow {
  approval_id: string;
  run_id: string;
  consumed_by: string;
  digest: string;
  consumed_at: unknown;
}
const CONSUMPTION_SELECT = 'SELECT approval_id, run_id, consumed_by, digest, consumed_at FROM ht_approval_consumptions';

function toConsumption(r: ConsumptionRow): ApprovalConsumption {
  return { approvalId: r.approval_id, runId: r.run_id, consumedBy: r.consumed_by, digest: r.digest, consumedAt: toIso(r.consumed_at) };
}
const SELECT = 'SELECT approval_id, run_id, kind, subject, requested_by, status, decided_by, rationale, created_at, decided_at FROM ht_approvals';

function toApproval(row: ApprovalRow): ApprovalRequest {
  const a: ApprovalRequest = {
    approvalId: row.approval_id,
    runId: row.run_id,
    kind: row.kind,
    subject: fromJsonColumn<JsonValue>(row.subject),
    requestedBy: fromJsonColumn<ActorRef>(row.requested_by),
    status: row.status,
    createdAt: toIso(row.created_at),
  };
  if (row.decided_by !== null && row.decided_by !== undefined) a.decidedBy = fromJsonColumn<ActorRef>(row.decided_by);
  if (row.rationale !== null) a.rationale = row.rationale;
  if (row.decided_at !== null && row.decided_at !== undefined) a.decidedAt = toIso(row.decided_at);
  return a;
}

function assertActor(actor: ActorRef, what: string): void {
  if (!actor || typeof actor.id !== 'string' || actor.id.length === 0 || !['agent', 'human', 'system'].includes(actor.kind)) {
    throw new HypertestError('invalid_argument', `${what} must be an ActorRef with kind and id`);
  }
}

/**
 * Approval requests (ht_approvals). A request emits `approval.requested`; decide() emits
 * `approval.granted` / `approval.denied` in the same transaction as the state change. The requester can
 * never decide their own request (permission_denied); a request is decided exactly once
 * (precondition_failed otherwise, enforced with a conditional UPDATE so concurrent deciders cannot both win).
 * Agents never decide `action`/`budget`/`manual_review` approvals, and may decide `test_change`/
 * `oracle_change` approvals only when independent of an agent requester (different known provider and role).
 */
export function createApprovalService(deps: PolicyDeps): ApprovalService {
  const { db, ids, clock, events, logger } = deps;

  async function getWith(ex: SqlExecutor, approvalId: string): Promise<ApprovalRequest | undefined> {
    const r = await ex.query<ApprovalRow>(`${SELECT} WHERE approval_id = $1`, [approvalId]);
    return r.rows[0] ? toApproval(r.rows[0]) : undefined;
  }

  return {
    async request(input, ctx: EventContext): Promise<ApprovalRequest> {
      if (!KINDS.has(input.kind)) throw new HypertestError('invalid_argument', `unknown approval kind: ${String(input.kind)}`);
      assertActor(input.requestedBy, 'requestedBy');
      if (input.decidedBy !== undefined || input.decidedAt !== undefined) throw new HypertestError('invalid_argument', 'a new approval request cannot carry a decision');
      if (typeof input.runId !== 'string' || input.runId.length === 0) throw new HypertestError('invalid_argument', 'runId is required');
      if (ctx.runId !== input.runId) throw new HypertestError('invalid_argument', `event context run ${ctx.runId} does not match approval run ${input.runId}`);
      const approval: ApprovalRequest = {
        approvalId: ids.next('appr'),
        runId: input.runId,
        kind: input.kind,
        subject: storable(input.subject),
        requestedBy: storable(input.requestedBy),
        status: 'pending',
        createdAt: clock.isoNow(),
      };
      if (input.rationale !== undefined) approval.rationale = storableString(input.rationale);
      return db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ht_approvals (approval_id, run_id, kind, subject, requested_by, status, rationale, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'pending', $6, $7)`,
          [approval.approvalId, approval.runId, approval.kind, JSON.stringify(approval.subject), JSON.stringify(approval.requestedBy), approval.rationale ?? null, approval.createdAt],
        );
        if (events) {
          await events.emit(
            [
              eventFrom(ctx, EVENT_TYPES.approvalRequested, 'approval', approval.approvalId, {
                approvalId: approval.approvalId,
                kind: approval.kind,
                requestedBy: approval.requestedBy.id,
                subject: approval.subject,
                // the row's rationale is replaced by the decider's; L0 keeps the requester's
                ...(approval.rationale !== undefined ? { rationale: approval.rationale } : {}),
              }),
            ],
            tx,
          );
        }
        logger.info('approval requested', { approvalId: approval.approvalId, kind: approval.kind, runId: approval.runId });
        return approval;
      });
    },

    async decide(approvalId: string, approve: boolean, originalDecidedBy: ActorRef, originalRationale: string, ctx: EventContext): Promise<ApprovalRequest> {
      assertActor(originalDecidedBy, 'decidedBy');
      if (typeof originalRationale !== 'string' || originalRationale.trim().length === 0) throw new HypertestError('invalid_argument', 'a decision rationale is required');
      const decidedBy = storable(originalDecidedBy);
      const rationale = storableString(originalRationale);
      return db.transaction(async (tx) => {
        const current = await getWith(tx, approvalId);
        if (!current) throw new HypertestError('not_found', `approval ${approvalId} not found`);
        if (current.status !== 'pending') throw new HypertestError('precondition_failed', `approval ${approvalId} is already ${current.status}`);
        // (E[8], E[3]) an action or budget-extension request past its decision window can no longer be decided (the gate
        // denies the action / the run converges to the gate). (A gate_exception's expiresAt is the waiver's own validity.)
        const until = current.kind === 'action' || current.kind === 'budget' ? (current.subject as { expiresAt?: unknown } | null)?.expiresAt : undefined;
        if (typeof until === 'string' && Number.isFinite(Date.parse(until)) && Date.parse(until) <= clock.nowMs()) {
          throw new HypertestError('precondition_failed', `approval ${approvalId} expired at ${until}; it can no longer be decided`, { details: { rule: 'expired' } });
        }
        if (current.requestedBy.id === decidedBy.id) {
          throw new HypertestError('permission_denied', `requester ${decidedBy.id} cannot decide their own approval ${approvalId}`, { details: { rule: 'self_decision' } });
        }
        if (decidedBy.kind === 'agent') {
          if (HUMAN_OR_SYSTEM_KINDS.has(current.kind)) {
            throw new HypertestError('permission_denied', `agents cannot decide ${current.kind} approvals (${decidedBy.id} on ${approvalId})`, { details: { rule: 'agent_decider' } });
          }
          const violation = agentIndependenceViolation(current.requestedBy, decidedBy);
          if (violation) throw new HypertestError('permission_denied', `${violation.message} (approval ${approvalId})`, { details: { rule: violation.rule } });
        }
        const status: ApprovalRequest['status'] = approve ? 'approved' : 'denied';
        const decidedAt = clock.isoNow();
        const upd = await tx.query(
          `UPDATE ht_approvals SET status = $2, decided_by = $3::jsonb, rationale = $4, decided_at = $5 WHERE approval_id = $1 AND status = 'pending'`,
          [approvalId, status, JSON.stringify(decidedBy), rationale, decidedAt] as SqlParam[],
        );
        if (upd.rowCount === 0) throw new HypertestError('precondition_failed', `approval ${approvalId} was decided concurrently`);
        const decided: ApprovalRequest = { ...current, status, decidedBy, rationale, decidedAt };
        if (events) {
          await events.emit(
            [
              eventFrom(ctx, approve ? EVENT_TYPES.approvalGranted : EVENT_TYPES.approvalDenied, 'approval', approvalId, {
                approvalId,
                kind: current.kind,
                decidedBy: decidedBy.id,
                decidedByKind: decidedBy.kind,
                rationale,
              }),
            ],
            tx,
          );
        }
        logger.info('approval decided', { approvalId, status, decidedBy: decidedBy.id });
        return decided;
      });
    },

    get(approvalId: string) {
      return getWith(db, approvalId);
    },

    async consume(approvalId, consumer, ctx: EventContext) {
      if (!consumer || typeof consumer.requestId !== 'string' || consumer.requestId === '' || typeof consumer.digest !== 'string' || consumer.digest === '') {
        throw new HypertestError('invalid_argument', 'consume: requestId and digest are required');
      }
      return db.transaction(async (tx) => {
        const current = await getWith(tx, approvalId);
        if (!current) throw new HypertestError('not_found', `approval ${approvalId} not found`);
        if (current.status !== 'approved') throw new HypertestError('precondition_failed', `approval ${approvalId} is ${current.status}, not approved: it cannot be consumed`);
        const at = clock.isoNow();
        const ins = await tx.query(
          'INSERT INTO ht_approval_consumptions (approval_id, run_id, consumed_by, digest, consumed_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (approval_id) DO NOTHING',
          [approvalId, current.runId, consumer.requestId, consumer.digest, at],
        );
        const row = (await tx.query<ConsumptionRow>(`${CONSUMPTION_SELECT} WHERE approval_id = $1`, [approvalId])).rows[0]!;
        const consumption = toConsumption(row);
        if ((ins.rowCount ?? 0) === 0) {
          // consumed before: by this very request (a durable replay of the same action), or by another one
          return consumption.consumedBy === consumer.requestId ? { consumed: true as const, consumption } : { consumed: false as const, consumption };
        }
        if (events) {
          await events.emit([eventFrom(ctx, EVENT_TYPES.approvalConsumed, 'approval', approvalId, { approvalId, kind: current.kind, requestId: consumer.requestId, digest: consumer.digest })], tx);
        }
        logger.info('approval consumed', { approvalId, requestId: consumer.requestId });
        return { consumed: true as const, consumption };
      });
    },

    async consumption(approvalId: string) {
      const r = await db.query<ConsumptionRow>(`${CONSUMPTION_SELECT} WHERE approval_id = $1`, [approvalId]);
      return r.rows[0] ? toConsumption(r.rows[0]) : undefined;
    },

    async expire(approvalId: string, ctx: EventContext) {
      return db.transaction(async (tx) => {
        const current = await getWith(tx, approvalId);
        if (!current) throw new HypertestError('not_found', `approval ${approvalId} not found`);
        if (current.status !== 'pending') return current;
        const upd = await tx.query(`UPDATE ht_approvals SET status = 'expired', decided_at = $2 WHERE approval_id = $1 AND status = 'pending'`, [approvalId, clock.isoNow()]);
        if ((upd.rowCount ?? 0) === 0) return (await getWith(tx, approvalId)) ?? current;
        const expiresAt = (current.subject as { expiresAt?: unknown } | null)?.expiresAt;
        if (events) {
          await events.emit([eventFrom(ctx, EVENT_TYPES.approvalExpired, 'approval', approvalId, { approvalId, kind: current.kind, ...(typeof expiresAt === 'string' ? { expiresAt } : {}) })], tx);
        }
        logger.info('approval expired', { approvalId, kind: current.kind });
        return (await getWith(tx, approvalId))!;
      });
    },

    async list(filter): Promise<ApprovalRequest[]> {
      const where: string[] = [];
      const params: SqlParam[] = [];
      if (filter.runId !== undefined) {
        params.push(filter.runId);
        where.push(`run_id = $${params.length}`);
      }
      if (filter.status !== undefined) {
        const statuses = filter.status.filter((s) => STATUSES.has(s));
        if (statuses.length === 0) return [];
        const placeholders = statuses.map((s) => {
          params.push(s);
          return `$${params.length}`;
        });
        where.push(`status IN (${placeholders.join(', ')})`);
      }
      const r = await db.query<ApprovalRow>(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`, params);
      return r.rows.map(toApproval);
    },
  };
}
