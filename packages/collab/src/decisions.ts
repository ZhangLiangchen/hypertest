import { HypertestError, canonicalJson, type SqlExecutor } from '@hypertest/core';
import type { EventContext, QualityDecision } from '@hypertest/domain';
import type { CollabDeps, DecisionRepository, EventStore } from './contracts.ts';
import { compact, eventInput, inTx, json, jsonParam, lockRun, normalize, num, requireRunMatch, requireString } from './sql.ts';

export interface DecisionRepositoryDeps extends CollabDeps {
  events: EventStore;
}

interface DecisionRow {
  decision: unknown;
  revision: unknown;
  needs_reassessment: boolean;
  reassessment_reason: string | null;
}

/** Content identity ignoring the store-assigned chain fields (revision, supersedes). */
function contentKey(d: QualityDecision): string {
  const { revision: _r, supersedes: _s, ...rest } = d;
  return canonicalJson(rest);
}

/**
 * Append-only QualityDecision store. The repository owns the per-run decision chain: an unsigned decision is
 * stored with revision = latest + 1 and supersedes = latest decisionId; a signed decision must already carry
 * exactly those values (the store never rewrites signed content). Decisions are never updated, except the
 * needs_reassessment flag, which lives outside the decision document.
 */
export function createDecisionRepository(deps: DecisionRepositoryDeps): DecisionRepository {
  const { db, events } = deps;

  async function latest(q: SqlExecutor, runId: string): Promise<QualityDecision | undefined> {
    const r = await q.query<DecisionRow>('SELECT decision FROM ht_decisions WHERE run_id = $1 ORDER BY revision DESC LIMIT 1', [runId]);
    return r.rows[0] ? json<QualityDecision>(r.rows[0].decision) : undefined;
  }

  return {
    async save(decision: QualityDecision, ctx: EventContext, tx?: SqlExecutor) {
      requireString(decision.decisionId, 'decision.decisionId');
      requireString(decision.runId, 'decision.runId');
      requireRunMatch(decision.runId, ctx, 'decision');
      return inTx(db, tx, async (q) => {
        await lockRun(q, decision.runId);
        const existing = await q.query<DecisionRow>('SELECT decision FROM ht_decisions WHERE decision_id = $1', [decision.decisionId]);
        if (existing.rows[0]) {
          const stored = json<QualityDecision>(existing.rows[0].decision);
          if (contentKey(stored) === contentKey(normalize(decision))) return stored; // idempotent retry
          throw new HypertestError('conflict', `decision ${decision.decisionId} already recorded with different content (decisions are append-only)`, {
            details: { decisionId: decision.decisionId },
          });
        }
        const prev = await latest(q, decision.runId);
        const revision = (prev?.revision ?? 0) + 1;
        if (decision.signature !== undefined && (decision.revision !== revision || decision.supersedes !== prev?.decisionId)) {
          throw new HypertestError('conflict', `signed decision ${decision.decisionId} must carry revision ${revision} and supersedes ${prev?.decisionId ?? '(none)'}`, {
            details: { decisionId: decision.decisionId, revision: decision.revision, supersedes: decision.supersedes ?? null, expectedRevision: revision, expectedSupersedes: prev?.decisionId ?? null },
          });
        }
        const stored = normalize({ ...decision, revision, supersedes: prev?.decisionId }) as QualityDecision;
        await q.query(
          `INSERT INTO ht_decisions (decision_id, run_id, revision, supersedes, verdict, decision, oracle_revisions, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
          [stored.decisionId, stored.runId, stored.revision, stored.supersedes ?? null, stored.verdict, jsonParam(stored), jsonParam(stored.oracleRevisions ?? {}), stored.decidedAt],
        );
        await events.append(
          [eventInput(ctx, 'decision.recorded', 'decision', stored.decisionId, compact({
            decisionId: stored.decisionId, revision: stored.revision, supersedes: stored.supersedes, verdict: stored.verdict, gateId: stored.gateId,
            requiresHumanReview: stored.requiresHumanReview, evidenceRootHash: stored.evidenceRootHash,
          }))],
          q,
        );
        return stored;
      });
    },

    async get(decisionId) {
      const r = await db.query<DecisionRow>('SELECT decision FROM ht_decisions WHERE decision_id = $1', [decisionId]);
      return r.rows[0] ? json<QualityDecision>(r.rows[0].decision) : undefined;
    },

    latestForRun(runId) {
      return latest(db, runId);
    },

    async findByOracleRevision(oracleId, revision) {
      const r = await db.query<DecisionRow>('SELECT decision FROM ht_decisions WHERE oracle_revisions @> $1::jsonb ORDER BY run_id, revision', [
        jsonParam({ [oracleId]: revision }),
      ]);
      return r.rows.map((row) => json<QualityDecision>(row.decision));
    },

    async markNeedsReassessment(decisionId, reason, ctx) {
      requireString(reason, 'reason');
      await db.transaction(async (q) => {
        const pre = await q.query<{ run_id: string }>('SELECT run_id FROM ht_decisions WHERE decision_id = $1', [decisionId]);
        if (!pre.rows[0]) throw new HypertestError('not_found', `decision ${decisionId} does not exist`);
        // Recorded in the decision's own run (its L0 must show the invalidation); correlation stays the caller's.
        const decisionRunId = pre.rows[0].run_id;
        await lockRun(q, decisionRunId);
        const r = await q.query<DecisionRow>('SELECT needs_reassessment, reassessment_reason, revision FROM ht_decisions WHERE decision_id = $1 FOR UPDATE', [decisionId]);
        const row = r.rows[0]!;
        if (row.needs_reassessment) return; // already flagged: no duplicate event
        await q.query('UPDATE ht_decisions SET needs_reassessment = true, reassessment_reason = $2 WHERE decision_id = $1', [decisionId, reason]);
        await events.append(
          [eventInput({ ...ctx, runId: decisionRunId }, 'decision.recorded', 'decision', decisionId, { decisionId, revision: num(row.revision), needsReassessment: true, reason, requestedInRun: ctx.runId })],
          q,
        );
      });
    },

    async reassessment(decisionId) {
      const r = await db.query<DecisionRow>('SELECT needs_reassessment, reassessment_reason FROM ht_decisions WHERE decision_id = $1', [decisionId]);
      const row = r.rows[0];
      if (!row) return undefined;
      return row.reassessment_reason !== null ? { needsReassessment: row.needs_reassessment, reason: row.reassessment_reason } : { needsReassessment: row.needs_reassessment };
    },
  };
}
