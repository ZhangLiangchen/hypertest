import { HypertestError, fromJsonColumn, type SqlExecutor } from '@hypertest/core';
import type { BudgetAmounts, BudgetDimension, BudgetLedger, BudgetUsage, OperationDeps, ReserveOutcome } from './contracts.ts';
import { jsonParam } from './ledger.ts';

/** Canonical dimension order: the first violated dimension of a scope is reported in this order. */
export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = ['tokens', 'costUsd', 'toolCalls', 'computeMs', 'artifactBytes', 'agents', 'workItems', 'wallClockMs'];
const DIMENSION_SET: ReadonlySet<string> = new Set(BUDGET_DIMENSIONS);
const EPSILON = 1e-9;

interface ScopeRow {
  scope: string;
  parent_scope: string | null;
  limits: unknown;
  used: unknown;
  reserved: unknown;
}

interface ReservationRow {
  reservation_id: string;
  scopes: unknown;
  amounts: unknown;
  status: 'reserved' | 'settled' | 'released';
}

/** Integers stay exact; fractional amounts (costUsd) are rounded to 1e-9 to avoid drift. */
function round(x: number): number {
  return Number.isInteger(x) ? x : Math.round(x * 1e9) / 1e9;
}

function normalizeAmounts(amounts: BudgetAmounts | undefined, what: string): BudgetAmounts {
  if (amounts === null || typeof amounts !== 'object') throw new HypertestError('invalid_argument', `${what} must be an object`);
  const out: BudgetAmounts = {};
  for (const [k, v] of Object.entries(amounts)) {
    if (v === undefined) continue;
    if (!DIMENSION_SET.has(k)) throw new HypertestError('invalid_argument', `${what}: unknown budget dimension ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new HypertestError('invalid_argument', `${what}.${k} must be a finite non-negative number`);
    out[k as BudgetDimension] = v;
  }
  return out;
}

function add(a: BudgetAmounts, b: BudgetAmounts, sign: 1 | -1): BudgetAmounts {
  const out: BudgetAmounts = { ...a };
  for (const d of BUDGET_DIMENSIONS) {
    const delta = b[d];
    if (delta === undefined || delta === 0) continue;
    const next = round((out[d] ?? 0) + sign * delta);
    // Release/settle never drive reservations negative (guards against rounding residue).
    out[d] = next < EPSILON && next > -EPSILON ? 0 : Math.max(0, next);
  }
  return out;
}

function requireScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new HypertestError('invalid_argument', 'at least one budget scope is required');
  for (const s of scopes) if (typeof s !== 'string' || s.length === 0) throw new HypertestError('invalid_argument', 'budget scopes must be non-empty strings');
  return scopes;
}

/**
 * Budgets as leases (I12): reserve → execute → settle | release. A reservation charges every listed
 * scope and all of its ancestors atomically; exhaustion is a typed outcome, never a silent downgrade.
 * Scope parents are immutable once opened, so the ancestor chain is stable; scope rows are locked in
 * sorted order to rule out deadlocks between concurrent reservations.
 */
export function createBudgetLedger(deps: OperationDeps): BudgetLedger {
  const { db, clock, ids, logger } = deps;

  /** Listed scopes followed by their ancestors (child → root), deduplicated, in caller order. */
  async function expandChain(tx: SqlExecutor, scopes: string[]): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (const start of scopes) {
      let cur: string | null = start;
      while (cur !== null && !seen.has(cur)) {
        const r: { rows: Array<{ parent_scope: string | null }> } = await tx.query<{ parent_scope: string | null }>('SELECT parent_scope FROM ht_budget_scopes WHERE scope = $1', [cur]);
        if (!r.rows[0]) throw new HypertestError('not_found', `budget scope ${cur} is not open`, { details: { scope: cur } });
        seen.add(cur);
        chain.push(cur);
        cur = r.rows[0].parent_scope;
      }
    }
    return chain;
  }

  async function lockScopes(tx: SqlExecutor, chain: string[]): Promise<Map<string, { limits: BudgetAmounts; used: BudgetAmounts; reserved: BudgetAmounts }>> {
    const r = await tx.query<ScopeRow>('SELECT scope, parent_scope, limits, used, reserved FROM ht_budget_scopes WHERE scope = ANY($1::text[]) ORDER BY scope FOR UPDATE', [[...chain]]);
    const out = new Map<string, { limits: BudgetAmounts; used: BudgetAmounts; reserved: BudgetAmounts }>();
    for (const row of r.rows) {
      out.set(row.scope, { limits: fromJsonColumn<BudgetAmounts>(row.limits), used: fromJsonColumn<BudgetAmounts>(row.used), reserved: fromJsonColumn<BudgetAmounts>(row.reserved) });
    }
    for (const s of chain) if (!out.has(s)) throw new HypertestError('not_found', `budget scope ${s} is not open`, { details: { scope: s } });
    return out;
  }

  /** Checks used + reserved + requested ≤ limit for every scope of the chain (missing limit = unlimited). */
  function firstViolation(chain: string[], rows: Map<string, { limits: BudgetAmounts; used: BudgetAmounts; reserved: BudgetAmounts }>, amounts: BudgetAmounts): ReserveOutcome | undefined {
    for (const scope of chain) {
      const row = rows.get(scope)!;
      for (const d of BUDGET_DIMENSIONS) {
        const requested = amounts[d] ?? 0;
        const limit = row.limits[d];
        if (requested <= 0 || limit === undefined) continue;
        const used = row.used[d] ?? 0;
        const reserved = row.reserved[d] ?? 0;
        if (used + reserved + requested > limit + EPSILON) {
          return { ok: false, exhausted: { scope, dimension: d, limit, used, reserved, requested } };
        }
      }
    }
    return undefined;
  }

  async function writeScope(tx: SqlExecutor, scope: string, used: BudgetAmounts, reserved: BudgetAmounts): Promise<void> {
    await tx.query('UPDATE ht_budget_scopes SET used = $2::jsonb, reserved = $3::jsonb, updated_at = $4 WHERE scope = $1', [scope, jsonParam(used), jsonParam(reserved), clock.isoNow()]);
  }

  async function reserveOrCharge(scopes: string[], rawAmounts: BudgetAmounts, reason: string, mode: 'reserve' | 'charge', idempotencyKey?: string): Promise<ReserveOutcome> {
    requireScopes(scopes);
    const amounts = normalizeAmounts(rawAmounts, 'amounts');
    if (typeof reason !== 'string') throw new HypertestError('invalid_argument', 'reason must be a string');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)) throw new HypertestError('invalid_argument', 'idempotencyKey must be a non-empty string');
    return db.transaction(async (tx) => {
      if (idempotencyKey !== undefined) {
        // Serializes every charge under this key (also across processes): the lookup below then sees a concurrent
        // duplicate's committed row instead of racing it into a second charge.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ht_budget_charge:${idempotencyKey}`]);
        const prior = await tx.query<{ reservation_id: string; scopes: unknown; amounts: unknown }>('SELECT reservation_id, scopes, amounts FROM ht_budget_reservations WHERE idempotency_key = $1', [idempotencyKey]);
        const row = prior.rows[0];
        if (row) {
          const recordedAmounts = fromJsonColumn<BudgetAmounts>(row.amounts);
          const sameAmounts = BUDGET_DIMENSIONS.every((d) => (recordedAmounts[d] ?? 0) === (amounts[d] ?? 0));
          const recordedChain = new Set(fromJsonColumn<string[]>(row.scopes));
          const chain = await expandChain(tx, scopes);
          const sameScopes = chain.length === recordedChain.size && chain.every((sc) => recordedChain.has(sc));
          if (!sameAmounts || !sameScopes) {
            throw new HypertestError('conflict', `budget charge key ${idempotencyKey} was already used for different scopes or amounts`, {
              details: { idempotencyKey, reservationId: row.reservation_id },
            });
          }
          logger.debug('budget charge already recorded under this key', { idempotencyKey, reservationId: row.reservation_id });
          return { ok: true, reservationId: row.reservation_id };
        }
      }
      const chain = await expandChain(tx, scopes);
      const rows = await lockScopes(tx, chain);
      const violation = firstViolation(chain, rows, amounts);
      if (violation) {
        logger.info('budget exhausted', { mode, reason, ...(violation.ok ? {} : violation.exhausted) });
        return violation;
      }
      for (const scope of chain) {
        const row = rows.get(scope)!;
        if (mode === 'reserve') await writeScope(tx, scope, row.used, add(row.reserved, amounts, 1));
        else await writeScope(tx, scope, add(row.used, amounts, 1), row.reserved);
      }
      const reservationId = ids.next('bres');
      const now = clock.isoNow();
      await tx.query(
        `INSERT INTO ht_budget_reservations (reservation_id, scopes, amounts, actual, status, reason, created_at, updated_at, idempotency_key)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $7, $8)`,
        [reservationId, jsonParam(chain), jsonParam(amounts), mode === 'charge' ? jsonParam(amounts) : null, mode === 'charge' ? 'settled' : 'reserved', reason, now, idempotencyKey ?? null],
      );
      return { ok: true, reservationId };
    });
  }

  async function finish(reservationId: string, actualRaw: BudgetAmounts | undefined): Promise<void> {
    const actual = actualRaw === undefined ? undefined : normalizeAmounts(actualRaw, 'actual');
    await db.transaction(async (tx) => {
      const r = await tx.query<ReservationRow>('SELECT reservation_id, scopes, amounts, status FROM ht_budget_reservations WHERE reservation_id = $1 FOR UPDATE', [reservationId]);
      const res = r.rows[0];
      if (!res) throw new HypertestError('not_found', `budget reservation ${reservationId} not found`);
      if (res.status !== 'reserved') {
        if (actual !== undefined && res.status === 'released') {
          throw new HypertestError('precondition_failed', `budget reservation ${reservationId} was released and cannot be settled`);
        }
        // settle-after-settle and release-after-settle/release are idempotent no-ops.
        logger.debug('budget reservation already finished', { reservationId, status: res.status });
        return;
      }
      const chain = fromJsonColumn<string[]>(res.scopes);
      const amounts = fromJsonColumn<BudgetAmounts>(res.amounts);
      const rows = await lockScopes(tx, chain);
      for (const scope of chain) {
        const row = rows.get(scope)!;
        // Actual usage is always recorded, even above the reservation or the limit.
        await writeScope(tx, scope, actual === undefined ? row.used : add(row.used, actual, 1), add(row.reserved, amounts, -1));
      }
      await tx.query('UPDATE ht_budget_reservations SET status = $2, actual = $3::jsonb, updated_at = $4 WHERE reservation_id = $1', [
        reservationId,
        actual === undefined ? 'released' : 'settled',
        actual === undefined ? null : jsonParam(actual),
        clock.isoNow(),
      ]);
    });
  }

  return {
    async open(scope: string, limitsRaw: BudgetAmounts, parentScope?: string): Promise<void> {
      if (typeof scope !== 'string' || scope.length === 0) throw new HypertestError('invalid_argument', 'scope must be a non-empty string');
      if (parentScope === scope) throw new HypertestError('invalid_argument', `budget scope ${scope} cannot be its own parent`);
      const limits = normalizeAmounts(limitsRaw, 'limits');
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ parent_scope: string | null }>('SELECT parent_scope FROM ht_budget_scopes WHERE scope = $1 FOR UPDATE', [scope]);
        if (!existing.rows[0]) {
          if (parentScope !== undefined) {
            const parent = await tx.query('SELECT scope FROM ht_budget_scopes WHERE scope = $1', [parentScope]);
            if (!parent.rows[0]) throw new HypertestError('not_found', `parent budget scope ${parentScope} is not open`, { details: { scope, parentScope } });
          }
          const now = clock.isoNow();
          // ON CONFLICT: a concurrent open of the same new scope must not fail with a unique violation.
          const inserted = await tx.query(
            `INSERT INTO ht_budget_scopes (scope, parent_scope, limits, used, reserved, created_at, updated_at) VALUES ($1, $2, $3::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $4)
             ON CONFLICT (scope) DO NOTHING RETURNING scope`,
            [scope, parentScope ?? null, jsonParam(limits), now],
          );
          if (inserted.rows[0]) return;
        }
        // Re-open (possibly of a scope a concurrent caller just created): parents are immutable, limits update.
        const row = existing.rows[0] ?? (await tx.query<{ parent_scope: string | null }>('SELECT parent_scope FROM ht_budget_scopes WHERE scope = $1 FOR UPDATE', [scope])).rows[0];
        const currentParent = row?.parent_scope ?? undefined;
        if (currentParent !== parentScope) {
          throw new HypertestError('conflict', `budget scope ${scope} is already open under ${currentParent ?? '(root)'}; parents are immutable`, {
            details: { scope, currentParent: currentParent ?? null, requestedParent: parentScope ?? null },
          });
        }
        await tx.query('UPDATE ht_budget_scopes SET limits = $2::jsonb, updated_at = $3 WHERE scope = $1', [scope, jsonParam(limits), clock.isoNow()]);
      });
    },

    reserve(scopes, amounts, reason): Promise<ReserveOutcome> {
      return reserveOrCharge(scopes, amounts, reason, 'reserve');
    },

    async settle(reservationId: string, actual: BudgetAmounts): Promise<void> {
      if (actual === undefined || actual === null) throw new HypertestError('invalid_argument', 'actual amounts are required to settle');
      await finish(reservationId, actual);
    },

    async release(reservationId: string): Promise<void> {
      await finish(reservationId, undefined);
    },

    charge(scopes, amounts, reason, options): Promise<ReserveOutcome> {
      return reserveOrCharge(scopes, amounts, reason, 'charge', options?.idempotencyKey);
    },

    async releaseOpen(scope: string): Promise<string[]> {
      if (typeof scope !== 'string' || scope.length === 0) throw new HypertestError('invalid_argument', 'scope must be a non-empty string');
      const r = await db.query<{ reservation_id: string }>("SELECT reservation_id FROM ht_budget_reservations WHERE status = 'reserved' AND scopes @> $1::jsonb ORDER BY created_at, reservation_id", [jsonParam([scope])]);
      const released: string[] = [];
      for (const row of r.rows) {
        await finish(row.reservation_id, undefined);
        released.push(row.reservation_id);
      }
      if (released.length > 0) logger.info('released open budget reservations', { scope, released });
      return released;
    },

    async usage(scope: string): Promise<BudgetUsage | undefined> {
      const r = await db.query<ScopeRow>('SELECT scope, parent_scope, limits, used, reserved FROM ht_budget_scopes WHERE scope = $1', [scope]);
      const row = r.rows[0];
      if (!row) return undefined;
      return { scope: row.scope, limits: fromJsonColumn<BudgetAmounts>(row.limits), used: fromJsonColumn<BudgetAmounts>(row.used), reserved: fromJsonColumn<BudgetAmounts>(row.reserved) };
    },
  };
}
