import { HypertestError, toIso, toNumber } from '@hypertest/core';
import { claimsConflict, type ResourceClaim, type ResourceMode } from '@hypertest/domain';
import type { AdmissionResult, OperationDeps, ResourceAdmission } from './contracts.ts';

interface ClaimRow {
  claim_id: string;
  holder_id: string;
  run_id: string;
  resource_key: string;
  mode: ResourceMode;
  quantity: unknown;
  expires_at: unknown;
}

const MODES: ReadonlySet<string> = new Set(['read_shared', 'write_exclusive', 'fault_exclusive']);
const CLAIM_COLUMNS = 'claim_id, holder_id, run_id, resource_key, mode, quantity, expires_at';

function rowToClaim(r: ClaimRow): ResourceClaim {
  const claim: ResourceClaim = { resourceKey: r.resource_key, mode: r.mode };
  if (r.quantity !== null && r.quantity !== undefined) claim.quantity = toNumber(r.quantity);
  return claim;
}

/** Hierarchical keys are `/`-separated non-empty segments, so prefix overlap equals ancestry. */
function validateClaim(c: ResourceClaim): void {
  if (!c || typeof c.resourceKey !== 'string' || c.resourceKey.length === 0) throw new HypertestError('invalid_argument', 'claim.resourceKey must be a non-empty string');
  if (c.resourceKey.split('/').some((seg) => seg.length === 0)) {
    throw new HypertestError('invalid_argument', `claim.resourceKey ${c.resourceKey} has an empty segment (leading, trailing or double '/')`);
  }
  if (!MODES.has(c.mode)) throw new HypertestError('invalid_argument', `claim.mode ${String(c.mode)} is not a resource mode`);
  if (c.quantity !== undefined && (!Number.isFinite(c.quantity) || c.quantity < 0)) throw new HypertestError('invalid_argument', 'claim.quantity must be a non-negative number');
}

/**
 * Experiment isolation (I12): all-or-nothing admission of hierarchical resource claims. Admission
 * is serialized by a row lock on ht_admission_lock (portable to PGlite), so two conflicting
 * experiments can never both be admitted.
 */
export function createResourceAdmission(deps: OperationDeps): ResourceAdmission {
  const { db, clock, ids, logger } = deps;

  return {
    async admit(request): Promise<AdmissionResult> {
      const { holderId, runId, claims, ttlMs } = request;
      if (typeof holderId !== 'string' || holderId.length === 0) throw new HypertestError('invalid_argument', 'holderId must be a non-empty string');
      if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'runId must be a non-empty string');
      if (!Array.isArray(claims)) throw new HypertestError('invalid_argument', 'claims must be an array');
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new HypertestError('invalid_argument', 'ttlMs must be positive');
      for (const c of claims) validateClaim(c);
      const nowMs = clock.nowMs();
      const now = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlMs).toISOString();

      return db.transaction(async (tx) => {
        await tx.query('SELECT lock_id FROM ht_admission_lock WHERE lock_id = 1 FOR UPDATE');
        await tx.query('DELETE FROM ht_resource_claims WHERE expires_at <= $1', [now]);
        const live = await tx.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM ht_resource_claims WHERE expires_at > $1 ORDER BY created_at, claim_id`, [now]);
        const others = live.rows.filter((r) => r.holder_id !== holderId);
        const conflicts: Array<{ requested: ResourceClaim; heldBy: string; held: ResourceClaim }> = [];
        for (const requested of claims) {
          for (const row of others) {
            const held = rowToClaim(row);
            if (claimsConflict(requested, held)) conflicts.push({ requested, heldBy: row.holder_id, held });
          }
        }
        if (conflicts.length > 0) {
          logger.info('resource admission refused', { holderId, runId, conflicts: conflicts.map((c) => ({ key: c.requested.resourceKey, heldBy: c.heldBy, heldKey: c.held.resourceKey })) });
          return { admitted: false, conflicts };
        }
        const own = live.rows.filter((r) => r.holder_id === holderId);
        const claimIds: string[] = [];
        for (const c of claims) {
          // Idempotent re-admission: an identical live claim of this holder is extended, not duplicated.
          const same = own.find((r) => r.resource_key === c.resourceKey && r.mode === c.mode && r.run_id === runId && (r.quantity === null ? c.quantity === undefined : toNumber(r.quantity) === c.quantity));
          if (same) {
            await tx.query('UPDATE ht_resource_claims SET expires_at = GREATEST(expires_at, $2::timestamptz) WHERE claim_id = $1', [same.claim_id, expiresAt]);
            claimIds.push(same.claim_id);
            continue;
          }
          const claimId = ids.next('claim');
          await tx.query(
            'INSERT INTO ht_resource_claims (claim_id, holder_id, run_id, resource_key, mode, quantity, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [claimId, holderId, runId, c.resourceKey, c.mode, c.quantity ?? null, expiresAt, now],
          );
          own.push({ claim_id: claimId, holder_id: holderId, run_id: runId, resource_key: c.resourceKey, mode: c.mode, quantity: c.quantity ?? null, expires_at: expiresAt });
          claimIds.push(claimId);
        }
        return { admitted: true, claimIds };
      });
    },

    async release(holderId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.query('SELECT lock_id FROM ht_admission_lock WHERE lock_id = 1 FOR UPDATE');
        await tx.query('DELETE FROM ht_resource_claims WHERE holder_id = $1', [holderId]);
      });
    },

    async active(runId?: string): Promise<Array<{ holderId: string; runId: string; claim: ResourceClaim; expiresAt: string }>> {
      const now = clock.isoNow();
      const r = runId === undefined
        ? await db.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM ht_resource_claims WHERE expires_at > $1 ORDER BY created_at, claim_id`, [now])
        : await db.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM ht_resource_claims WHERE expires_at > $1 AND run_id = $2 ORDER BY created_at, claim_id`, [now, runId]);
      return r.rows.map((row) => ({ holderId: row.holder_id, runId: row.run_id, claim: rowToClaim(row), expiresAt: toIso(row.expires_at) }));
    },
  };
}
