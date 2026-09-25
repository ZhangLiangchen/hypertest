import { HypertestError, canonicalJson, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { canTransitionRun, isTerminalRun, type EventContext, type RunStatus, type TestRun } from '@hypertest/domain';
import type { CollabDeps, EventStore, RunRepository } from './contracts.ts';
import { compact, eventInput, inTx, json, jsonParam, lockRun, normalize, requireRunMatch, requireString } from './sql.ts';

export interface RunRepositoryDeps extends CollabDeps {
  events: EventStore;
}

/** Status-change event (I10). `run.gating` is not in the domain catalog yet; see README. */
export function runEventType(from: RunStatus, to: RunStatus): string {
  switch (to) {
    case 'running':
      return from === 'created' ? 'run.started' : 'run.resumed';
    case 'paused':
      return 'run.paused';
    case 'converging':
      return 'run.converging';
    case 'gating':
      return 'run.gating';
    case 'completed':
      return 'run.completed';
    case 'failed':
      return 'run.failed';
    case 'cancelled':
      return 'run.cancelled';
    case 'created':
      return 'run.created';
  }
}

/** Fields that may still change on a terminal run (a re-decision after an oracle invalidation; labels). */
const TERMINAL_MUTABLE: ReadonlySet<string> = new Set(['status', 'decisionId', 'labels']);


async function writeRun(q: SqlExecutor, run: TestRun): Promise<void> {
  await q.query('UPDATE ht_runs SET status = $2, goal = $3, run = $4::jsonb, updated_at = $5 WHERE run_id = $1', [run.runId, run.status, run.goal, jsonParam(run), run.updatedAt]);
}

export function createRunRepository(deps: RunRepositoryDeps): RunRepository {
  const { db, clock, events } = deps;

  async function load(q: SqlExecutor, runId: string, lock: boolean): Promise<TestRun | undefined> {
    const r = await q.query<{ run: unknown }>(`SELECT run FROM ht_runs WHERE run_id = $1${lock ? ' FOR UPDATE' : ''}`, [runId]);
    return r.rows[0] ? json<TestRun>(r.rows[0].run) : undefined;
  }

  return {
    async create(run: TestRun, ctx: EventContext, tx?: SqlExecutor) {
      requireString(run.runId, 'run.runId');
      requireRunMatch(run.runId, ctx, 'run');
      // A run enters its state machine at `created` (anything else would skip canTransitionRun) and is pinned to a
      // runtime manifest from the start (I11).
      if (run.status !== 'created') throw new HypertestError('invalid_argument', `a new run must start in status created (got ${String(run.status)})`, { details: { runId: run.runId, status: run.status } });
      requireString(run.runtimeManifestId, 'run.runtimeManifestId');
      const stored = normalize(run);
      return inTx(db, tx, async (q) => {
        await lockRun(q, run.runId);
        const existing = await load(q, run.runId, true);
        if (existing) {
          // Idempotent re-create (durable retry) returns the stored run; anything else is a conflict.
          if (canonicalJson(existing) === canonicalJson(stored)) return existing;
          throw new HypertestError('conflict', `run ${run.runId} already exists`, { details: { runId: run.runId, status: existing.status } });
        }
        await q.query('INSERT INTO ht_runs (run_id, status, goal, run, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
          stored.runId, stored.status, stored.goal, jsonParam(stored), stored.createdAt, stored.updatedAt,
        ]);
        await events.append(
          [eventInput(ctx, 'run.created', 'run', stored.runId, compact({ runId: stored.runId, goal: stored.goal, status: stored.status, runtimeManifestId: stored.runtimeManifestId, policyRevision: stored.policyRevision }))],
          q,
        );
        return stored;
      });
    },

    async get(runId) {
      return load(db, runId, false);
    },

    async update(runId, patch, ctx, tx) {
      requireRunMatch(runId, ctx, 'run');
      return inTx(db, tx, async (q) => {
        await lockRun(q, runId);
        const cur = await load(q, runId, true);
        if (!cur) throw new HypertestError('not_found', `run ${runId} does not exist`);
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<TestRun>;
        delete defined.runId;
        delete defined.createdAt;
        delete defined.updatedAt;
        const to = defined.status ?? cur.status;
        const statusChange = to !== cur.status;
        if (statusChange && !canTransitionRun(cur.status, to)) {
          throw new HypertestError('precondition_failed', `illegal run transition ${cur.status} → ${to}`, { details: { runId, from: cur.status, to } });
        }
        if (!statusChange && isTerminalRun(cur.status) && Object.keys(defined).some((k) => !TERMINAL_MUTABLE.has(k))) {
          throw new HypertestError('precondition_failed', `run ${runId} is ${cur.status} (terminal) and cannot be modified`, { details: { runId, status: cur.status } });
        }
        // I11: the manifest is pinned at creation and never changes for the run (paused runs are live runs too);
        // a runtime upgrade means a new run.
        if (defined.runtimeManifestId !== undefined && defined.runtimeManifestId !== cur.runtimeManifestId) {
          throw new HypertestError('precondition_failed', `run ${runId} is pinned to runtime manifest ${cur.runtimeManifestId} (I11)`, {
            details: { runId, status: cur.status, pinned: cur.runtimeManifestId, requested: defined.runtimeManifestId },
          });
        }
        const next: TestRun = { ...cur, ...defined };
        if (statusChange && cur.status === 'paused' && to !== 'paused' && patch.pauseReason === undefined) delete next.pauseReason;
        if (statusChange && isTerminalRun(to) && next.completedAt === undefined) next.completedAt = clock.isoNow();
        const changed = (Object.keys(defined) as Array<keyof TestRun>).filter((k) => canonicalJson(cur[k] ?? null) !== canonicalJson(next[k] ?? null));
        if (!statusChange && changed.length === 0) return cur;
        next.updatedAt = clock.isoNow();
        const stored = normalize(next);
        await writeRun(q, stored);
        const payload: Record<string, unknown> = statusChange
          ? compact({ runId, from: cur.status, to, pauseReason: stored.pauseReason, decisionId: stored.decisionId })
          : { runId, changed: changed.map(String).sort() };
        await events.append([eventInput(ctx, statusChange ? runEventType(cur.status, to) : 'run.updated', 'run', runId, payload)], q);
        return stored;
      });
    },

    async list(filter = {}) {
      const params: SqlParam[] = [];
      let sql = 'SELECT run FROM ht_runs';
      if (filter.status !== undefined) {
        params.push(filter.status);
        sql += ` WHERE status = ANY($${params.length})`;
      }
      sql += ' ORDER BY created_at DESC, run_id DESC';
      if (filter.limit !== undefined) {
        params.push(Math.max(0, Math.floor(filter.limit)));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await db.query<{ run: unknown }>(sql, params);
      return r.rows.map((row) => json<TestRun>(row.run));
    },
  };
}
