import { HypertestError, toIso, toNumber } from '@hypertest/core';
import type { ResourceLease } from '@hypertest/domain';
import type { LeaseService, OperationDeps } from './contracts.ts';

interface LeaseRow {
  resource_key: string;
  lease_id: string;
  owner: string;
  fencing_token: unknown;
  expires_at: unknown;
  acquired_at: unknown;
}

const LEASE_COLUMNS = 'resource_key, lease_id, owner, fencing_token, expires_at, acquired_at';

function rowToLease(r: LeaseRow): ResourceLease {
  return {
    leaseId: r.lease_id,
    resourceKey: r.resource_key,
    owner: r.owner,
    fencingToken: toNumber(r.fencing_token),
    expiresAt: toIso(r.expires_at),
    acquiredAt: toIso(r.acquired_at),
  };
}

function requireTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new HypertestError('invalid_argument', `lease ttlMs must be a positive number (got ${ttlMs})`);
}

/**
 * Write leases with monotonic fencing tokens (I4).
 *
 * - A grant (resource free, previous lease expired per the injected clock, or re-acquired by the same
 *   owner) always issues `previous token + 1`; the counter lives in ht_fences and survives release,
 *   so tokens are never reused. A same-owner re-acquire therefore supersedes the owner's older lease.
 * - `renew`/`checkFence` refuse leases that are expired or were superseded: a paused worker cannot
 *   resurrect its lease once another owner could have been granted a newer token.
 */
export function createLeaseService(deps: OperationDeps): LeaseService {
  const { db, clock, ids, logger } = deps;
  const isLive = (lease: ResourceLease): boolean => Date.parse(lease.expiresAt) > clock.nowMs();

  return {
    async acquire(request): Promise<ResourceLease | undefined> {
      const { resourceKey, owner, ttlMs } = request;
      if (typeof resourceKey !== 'string' || resourceKey.length === 0) throw new HypertestError('invalid_argument', 'resourceKey must be a non-empty string');
      if (typeof owner !== 'string' || owner.length === 0) throw new HypertestError('invalid_argument', 'owner must be a non-empty string');
      requireTtl(ttlMs);
      return db.transaction(async (tx) => {
        await tx.query('INSERT INTO ht_fences (resource_key, last_token, highest_accepted) VALUES ($1, 0, 0) ON CONFLICT (resource_key) DO NOTHING', [resourceKey]);
        // Row lock on the fence serializes every grant for this resource.
        const fence = await tx.query<{ last_token: unknown }>('SELECT last_token FROM ht_fences WHERE resource_key = $1 FOR UPDATE', [resourceKey]);
        // Lock the current lease row too: renew() locks it FOR UPDATE, so a renewal in progress is either
        // seen here (live ⇒ refused) or happens after the regrant (⇒ stale_fence) — never silently overwritten.
        const existing = await tx.query<LeaseRow>(`SELECT ${LEASE_COLUMNS} FROM ht_leases WHERE resource_key = $1 FOR UPDATE`, [resourceKey]);
        const held = existing.rows[0] ? rowToLease(existing.rows[0]) : undefined;
        if (held && isLive(held) && held.owner !== owner) {
          logger.debug('lease busy', { resourceKey, owner, heldBy: held.owner });
          return undefined;
        }
        const token = toNumber(fence.rows[0]!.last_token) + 1;
        const nowMs = clock.nowMs();
        const lease: ResourceLease = {
          leaseId: ids.next('lease'),
          resourceKey,
          owner,
          fencingToken: token,
          acquiredAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
        };
        await tx.query('UPDATE ht_fences SET last_token = $2 WHERE resource_key = $1', [resourceKey, token]);
        await tx.query(
          `INSERT INTO ht_leases (resource_key, lease_id, owner, fencing_token, expires_at, acquired_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (resource_key) DO UPDATE SET lease_id = EXCLUDED.lease_id, owner = EXCLUDED.owner, fencing_token = EXCLUDED.fencing_token,
             expires_at = EXCLUDED.expires_at, acquired_at = EXCLUDED.acquired_at`,
          [resourceKey, lease.leaseId, owner, token, lease.expiresAt, lease.acquiredAt],
        );
        logger.debug('lease granted', { resourceKey, owner, fencingToken: token, previousOwner: held?.owner });
        return lease;
      });
    },

    async renew(leaseId: string, ttlMs: number): Promise<ResourceLease> {
      requireTtl(ttlMs);
      return db.transaction(async (tx) => {
        const r = await tx.query<LeaseRow>(`SELECT ${LEASE_COLUMNS} FROM ht_leases WHERE lease_id = $1 FOR UPDATE`, [leaseId]);
        if (!r.rows[0]) throw new HypertestError('stale_fence', `lease ${leaseId} is no longer held (released or superseded)`, { details: { leaseId } });
        const lease = rowToLease(r.rows[0]);
        if (!isLive(lease)) throw new HypertestError('stale_fence', `lease ${leaseId} expired at ${lease.expiresAt}`, { details: { leaseId, expiresAt: lease.expiresAt } });
        const expiresAt = new Date(clock.nowMs() + ttlMs).toISOString();
        await tx.query('UPDATE ht_leases SET expires_at = $2 WHERE lease_id = $1', [leaseId, expiresAt]);
        return { ...lease, expiresAt };
      });
    },

    async release(leaseId: string): Promise<void> {
      await db.query('DELETE FROM ht_leases WHERE lease_id = $1', [leaseId]);
    },

    async current(resourceKey: string): Promise<ResourceLease | undefined> {
      const r = await db.query<LeaseRow>(`SELECT ${LEASE_COLUMNS} FROM ht_leases WHERE resource_key = $1`, [resourceKey]);
      const lease = r.rows[0] ? rowToLease(r.rows[0]) : undefined;
      return lease && isLive(lease) ? lease : undefined;
    },

    async checkFence(resourceKey: string, fencingToken: number): Promise<boolean> {
      if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) return false;
      return db.transaction(async (tx) => {
        const f = await tx.query<{ highest_accepted: unknown }>('SELECT highest_accepted FROM ht_fences WHERE resource_key = $1 FOR UPDATE', [resourceKey]);
        if (!f.rows[0]) return false;
        const highest = toNumber(f.rows[0].highest_accepted);
        const r = await tx.query<LeaseRow>(`SELECT ${LEASE_COLUMNS} FROM ht_leases WHERE resource_key = $1`, [resourceKey]);
        const lease = r.rows[0] ? rowToLease(r.rows[0]) : undefined;
        const accepted = lease !== undefined && isLive(lease) && lease.fencingToken === fencingToken && fencingToken >= highest;
        if (!accepted) {
          logger.warn('stale fencing token refused', { resourceKey, fencingToken, liveToken: lease && isLive(lease) ? lease.fencingToken : null, highestAccepted: highest });
          return false;
        }
        if (fencingToken > highest) await tx.query('UPDATE ht_fences SET highest_accepted = $2 WHERE resource_key = $1', [resourceKey, fencingToken]);
        return true;
      });
    },
  };
}
