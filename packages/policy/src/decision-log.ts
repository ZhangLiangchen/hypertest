import { HypertestError, fromJsonColumn, hashCanonical, toIso, type SqlExecutor } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type EventContext } from '@hypertest/domain';
import type { ActionPermit, ActionRequest, PolicyDecisionLog, PolicyDecisionRecord, PolicyDeps } from './contracts.ts';
import { storable } from './storable.ts';

interface DecisionRow {
  decision_id: string;
  run_id: string;
  request_hash: string;
  request: unknown;
  permit: unknown;
  decided_at: unknown;
}

function toRecord(row: DecisionRow): PolicyDecisionRecord {
  return {
    decisionId: row.decision_id,
    runId: row.run_id,
    requestHash: row.request_hash,
    request: fromJsonColumn<ActionRequest>(row.request),
    permit: fromJsonColumn<ActionPermit>(row.permit),
    decidedAt: toIso(row.decided_at),
  };
}

/** sha256 of the canonical JSON of the (storable, i.e. NUL-free) action request: the decision's input hash. */
export function policyRequestHash(request: ActionRequest): string {
  return hashCanonical(storable(request));
}

const SELECT = 'SELECT decision_id, run_id, request_hash, request, permit, decided_at FROM ht_policy_decisions';

/**
 * Append-only decision log (I10). record() writes the row and emits `policy.decided` in one transaction;
 * re-recording the same decision id with the same request is idempotent (no second event); a different
 * request under an existing decision id is a conflict.
 */
export function createPolicyDecisionLog(deps: PolicyDeps): PolicyDecisionLog {
  const { db, clock, events, logger } = deps;

  async function getWith(ex: SqlExecutor, decisionId: string): Promise<PolicyDecisionRecord | undefined> {
    const r = await ex.query<DecisionRow>(`${SELECT} WHERE decision_id = $1`, [decisionId]);
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }

  return {
    async record(originalRequest: ActionRequest, originalPermit: ActionPermit, ctx: EventContext): Promise<PolicyDecisionRecord> {
      if (!originalPermit.decisionId) throw new HypertestError('invalid_argument', 'permit.decisionId is required');
      if (ctx.runId !== originalRequest.runId) throw new HypertestError('invalid_argument', `event context run ${ctx.runId} does not match request run ${originalRequest.runId}`);
      // stored (and hashed) in storable form: a NUL in agent-influenced input must not make the audit write fail
      const request = storable(originalRequest);
      const permit = storable(originalPermit);
      const requestHash = policyRequestHash(request);
      const decidedAt = clock.isoNow();
      return db.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO ht_policy_decisions (decision_id, run_id, request_id, request_hash, decision, tool, effect, work_item_id, agent_id, policy_revision, request, permit, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
           ON CONFLICT (decision_id) DO NOTHING`,
          [
            permit.decisionId, request.runId, request.requestId, requestHash, permit.decision, request.tool, request.effect,
            request.workItemId ?? null, request.agentId ?? null, permit.policyRevision, JSON.stringify(request), JSON.stringify(permit), decidedAt,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await getWith(tx, permit.decisionId);
          if (!existing) throw new HypertestError('internal', `decision ${permit.decisionId} vanished`);
          if (existing.requestHash !== requestHash || hashCanonical(existing.permit) !== hashCanonical(permit)) {
            throw new HypertestError('conflict', `policy decision ${permit.decisionId} already recorded for a different request or permit`);
          }
          return existing;
        }
        if (events) {
          await events.emit(
            [
              eventFrom(ctx, EVENT_TYPES.policyDecided, 'policy', permit.decisionId, {
                decisionId: permit.decisionId,
                requestId: request.requestId,
                requestHash,
                decision: permit.decision,
                tool: request.tool,
                effect: request.effect,
                riskClass: request.riskClass,
                reasons: permit.reasons,
                policyRevision: permit.policyRevision,
                ...(permit.approvalId !== undefined ? { approvalId: permit.approvalId } : {}),
              }),
            ],
            tx,
          );
        }
        logger.debug('policy decision recorded', { decisionId: permit.decisionId, decision: permit.decision, tool: request.tool });
        return { decisionId: permit.decisionId, runId: request.runId, requestHash, request, permit, decidedAt };
      });
    },

    get(decisionId: string) {
      return getWith(db, decisionId);
    },

    async list(runId: string): Promise<PolicyDecisionRecord[]> {
      const r = await db.query<DecisionRow>(`${SELECT} WHERE run_id = $1 ORDER BY seq`, [runId]);
      return r.rows.map(toRecord);
    },
  };
}
