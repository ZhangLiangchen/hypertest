import { HypertestError, toIso, toNumber } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type ModelEpoch, type ModelSwitchReason } from '@hypertest/domain';
import type { EpochDeps, EpochManager, EpochRouting, OkRouteDecision, PendingFallback, TurnRecord } from './contracts.ts';
import { assertNonEmpty, jsonOrNull, jsonParam, parseJson } from './util.ts';

export const SWITCH_REASONS: readonly ModelSwitchReason[] = ['initial', 'policy', 'quality', 'rate_limit', 'unavailable', 'cost', 'manual'];

interface EpochRow {
  epoch_id: string;
  run_id: string;
  agent_id: string;
  session_id: string;
  previous_epoch_id: string | null;
  route_id: string;
  provider: string;
  model: string;
  capability_profile_revision: string;
  continuation_compatibility_class: string;
  context_snapshot_id: string;
  switch_reason: ModelSwitchReason;
  started_at_turn: unknown;
  started_at: unknown;
}

const COLUMNS =
  'e.epoch_id, e.run_id, e.agent_id, e.session_id, e.previous_epoch_id, e.route_id, e.provider, e.model, e.capability_profile_revision, e.continuation_compatibility_class, e.context_snapshot_id, e.switch_reason, e.started_at_turn, e.started_at';

function rowToEpoch(r: EpochRow): ModelEpoch {
  const e: ModelEpoch = {
    epochId: r.epoch_id,
    runId: r.run_id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    routeId: r.route_id,
    provider: r.provider,
    model: r.model,
    capabilityProfileRevision: r.capability_profile_revision,
    continuationCompatibilityClass: r.continuation_compatibility_class,
    contextSnapshotId: r.context_snapshot_id,
    switchReason: r.switch_reason,
    startedAtTurn: toNumber(r.started_at_turn),
    startedAt: toIso(r.started_at),
  };
  if (r.previous_epoch_id) e.previousEpochId = r.previous_epoch_id;
  return e;
}

function assertStringList(v: unknown, what: string): asserts v is string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) throw new HypertestError('invalid_argument', `${what} must be an array of non-empty strings`);
}

/**
 * The next turn at which an epoch may start, or a refusal (I3 safe boundary): a turn with a recorded response whose
 * calls are not all settled-and-completed (`model_responded`) or an earlier turn still `started` is never a boundary.
 */
export function safeEpochTurn(last: Pick<TurnRecord, 'turn' | 'status'> | undefined): { ok: true; turn: number } | { ok: false; reason: string } {
  if (!last) return { ok: true, turn: 1 };
  if (last.status === 'model_responded') return { ok: false, reason: `turn ${last.turn} has a model response with unsettled tool calls` };
  if (last.status === 'started') return { ok: true, turn: last.turn };
  return { ok: true, turn: last.turn + 1 };
}

/** SQL EpochManager over ht_epochs (+ ht_pending_fallbacks). Emits model.epoch_started in the insert transaction. */
export function createEpochManager(deps: EpochDeps): EpochManager {
  const { db, ids, clock } = deps;

  return {
    async current(sessionId) {
      const r = await db.query<EpochRow>(`SELECT ${COLUMNS} FROM ht_epochs e JOIN ht_sessions s ON s.current_epoch_id = e.epoch_id WHERE s.session_id = $1`, [sessionId]);
      return r.rows[0] ? rowToEpoch(r.rows[0]) : undefined;
    },

    async start(input, ctx, options = {}) {
      for (const f of ['runId', 'agentId', 'sessionId', 'routeId', 'provider', 'model', 'capabilityProfileRevision', 'continuationCompatibilityClass', 'contextSnapshotId'] as const) {
        assertNonEmpty(input?.[f], f);
      }
      if (!SWITCH_REASONS.includes(input.switchReason)) throw new HypertestError('invalid_argument', `unknown switchReason ${String(input.switchReason)}`);
      if (!Number.isSafeInteger(input.startedAtTurn) || input.startedAtTurn < 0) throw new HypertestError('invalid_argument', `startedAtTurn must be a non-negative integer`);
      const decision = options.decision;
      if (decision !== undefined) {
        const mismatch = decision.ok !== true || decision.routeId !== input.routeId || decision.provider !== input.provider || decision.model !== input.model
          || decision.continuationCompatibilityClass !== input.continuationCompatibilityClass || decision.capabilityProfileRevision !== input.capabilityProfileRevision;
        if (mismatch) throw new HypertestError('invalid_argument', `route decision ${decision.routeId} does not describe the epoch route ${input.routeId}`);
      }
      const excluded = options.excludedRoutes ?? [];
      assertStringList(excluded, 'excludedRoutes');

      const epoch = await db.transaction(async (tx) => {
        const s = await tx.query<{ run_id: string; agent_id: string; current_epoch_id: string | null; status: string }>(
          `SELECT run_id, agent_id, current_epoch_id, status FROM ht_sessions WHERE session_id = $1 FOR UPDATE`,
          [input.sessionId],
        );
        const session = s.rows[0];
        if (!session) throw new HypertestError('not_found', `session ${input.sessionId} not found`, { details: { sessionId: input.sessionId } });
        if (session.run_id !== input.runId || session.agent_id !== input.agentId) {
          throw new HypertestError('invalid_argument', `epoch identity (${input.runId}/${input.agentId}) does not match session ${input.sessionId} (${session.run_id}/${session.agent_id})`);
        }
        const last = await tx.query<{ turn: unknown; status: TurnRecord['status'] }>(`SELECT turn, status FROM ht_turns WHERE session_id = $1 ORDER BY turn DESC LIMIT 1`, [input.sessionId]);
        const lastRow = last.rows[0];
        const boundary = safeEpochTurn(lastRow ? { turn: toNumber(lastRow.turn), status: lastRow.status } : undefined);
        if (!boundary.ok) {
          throw new HypertestError('precondition_failed', `no safe turn boundary for a new epoch on session ${input.sessionId}: ${boundary.reason}`, {
            details: { sessionId: input.sessionId, startedAtTurn: input.startedAtTurn },
          });
        }
        if (input.startedAtTurn !== boundary.turn) {
          throw new HypertestError('precondition_failed', `an epoch of session ${input.sessionId} may start only at turn ${boundary.turn} (the next safe boundary), not ${input.startedAtTurn}`, {
            details: { sessionId: input.sessionId, startedAtTurn: input.startedAtTurn, boundaryTurn: boundary.turn },
          });
        }
        const currentId = session.current_epoch_id ?? undefined;
        if (input.previousEpochId !== undefined && input.previousEpochId !== currentId) {
          throw new HypertestError('conflict', `previousEpochId ${input.previousEpochId} is not the current epoch (${currentId ?? 'none'}) of session ${input.sessionId}`, {
            details: { sessionId: input.sessionId, previousEpochId: input.previousEpochId, currentEpochId: currentId ?? null },
          });
        }
        const e: ModelEpoch = { ...input, epochId: ids.next('ep'), startedAt: clock.isoNow() };
        if (currentId !== undefined) e.previousEpochId = currentId;
        else delete e.previousEpochId;
        await tx.query(
          `INSERT INTO ht_epochs (epoch_id, run_id, agent_id, session_id, previous_epoch_id, route_id, provider, model, capability_profile_revision, continuation_compatibility_class,
                                  context_snapshot_id, switch_reason, started_at_turn, started_at, decision, excluded_routes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)`,
          [
            e.epochId, e.runId, e.agentId, e.sessionId, e.previousEpochId ?? null, e.routeId, e.provider, e.model, e.capabilityProfileRevision, e.continuationCompatibilityClass,
            e.contextSnapshotId, e.switchReason, e.startedAtTurn, e.startedAt, jsonOrNull(decision), jsonParam(excluded),
          ],
        );
        await tx.query(`UPDATE ht_sessions SET current_epoch_id = $2, updated_at = $3 WHERE session_id = $1`, [e.sessionId, e.epochId, e.startedAt]);
        if (options.consumeFallback) await tx.query(`DELETE FROM ht_pending_fallbacks WHERE session_id = $1`, [e.sessionId]);
        if (deps.events) {
          await deps.events.emit(
            [
              eventFrom(ctx, EVENT_TYPES.modelEpochStarted, 'model', e.agentId, {
                epochId: e.epochId,
                previousEpochId: e.previousEpochId ?? null,
                sessionId: e.sessionId,
                routeId: e.routeId,
                provider: e.provider,
                model: e.model,
                capabilityProfileRevision: e.capabilityProfileRevision,
                continuationCompatibilityClass: e.continuationCompatibilityClass,
                contextSnapshotId: e.contextSnapshotId,
                switchReason: e.switchReason,
                startedAtTurn: e.startedAtTurn,
                excludedRoutes: excluded,
              }),
            ],
            tx,
          );
        }
        return e;
      });
      deps.logger.info('model epoch started', { sessionId: epoch.sessionId, epochId: epoch.epochId, routeId: epoch.routeId, reason: epoch.switchReason, turn: epoch.startedAtTurn });
      return epoch;
    },

    async list(sessionId) {
      const r = await db.query<EpochRow>(`SELECT ${COLUMNS} FROM ht_epochs e WHERE e.session_id = $1 ORDER BY e.seq`, [sessionId]);
      return r.rows.map(rowToEpoch);
    },

    async providersUsedByRoles(runId, roles) {
      assertNonEmpty(runId, 'runId');
      assertStringList(roles, 'roles');
      if (roles.length === 0) return [];
      const r = await db.query<{ provider: string }>(
        `SELECT DISTINCT e.provider FROM ht_epochs e JOIN ht_agents a ON a.agent_id = e.agent_id WHERE e.run_id = $1 AND a.role = ANY($2::text[]) ORDER BY e.provider`,
        [runId, roles],
      );
      return r.rows.map((row) => row.provider);
    },

    async routing(epochId): Promise<EpochRouting | undefined> {
      const r = await db.query<{ decision: unknown; excluded_routes: unknown }>(`SELECT decision, excluded_routes FROM ht_epochs WHERE epoch_id = $1`, [epochId]);
      const row = r.rows[0];
      if (!row) return undefined;
      const out: EpochRouting = { excludedRoutes: parseJson<string[]>(row.excluded_routes) ?? [] };
      const decision = parseJson<OkRouteDecision>(row.decision);
      if (decision !== undefined) out.decision = decision;
      return out;
    },

    async setPendingFallback(sessionId, fallback) {
      assertNonEmpty(sessionId, 'sessionId');
      if (!fallback?.decision || fallback.decision.ok !== true) throw new HypertestError('invalid_argument', 'fallback.decision must be an ok route decision');
      if (!SWITCH_REASONS.includes(fallback.reason)) throw new HypertestError('invalid_argument', `unknown switch reason ${String(fallback.reason)}`);
      assertNonEmpty(fallback.fromRouteId, 'fromRouteId');
      assertStringList(fallback.excludedRoutes, 'excludedRoutes');
      await db.query(
        `INSERT INTO ht_pending_fallbacks (session_id, decision, reason, from_route_id, from_epoch_id, error, excluded_routes, created_at)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
         ON CONFLICT (session_id) DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, from_route_id = EXCLUDED.from_route_id,
           from_epoch_id = EXCLUDED.from_epoch_id, error = EXCLUDED.error, excluded_routes = EXCLUDED.excluded_routes, created_at = EXCLUDED.created_at`,
        [sessionId, jsonParam(fallback.decision), fallback.reason, fallback.fromRouteId, fallback.fromEpochId ?? null, jsonParam(fallback.error), jsonParam(fallback.excludedRoutes), clock.isoNow()],
      );
    },

    async pendingFallback(sessionId): Promise<PendingFallback | undefined> {
      const r = await db.query<{ decision: unknown; reason: ModelSwitchReason; from_route_id: string; from_epoch_id: string | null; error: unknown; excluded_routes: unknown; created_at: unknown }>(
        `SELECT decision, reason, from_route_id, from_epoch_id, error, excluded_routes, created_at FROM ht_pending_fallbacks WHERE session_id = $1`,
        [sessionId],
      );
      const row = r.rows[0];
      if (!row) return undefined;
      const fb: PendingFallback = {
        decision: parseJson<OkRouteDecision>(row.decision)!,
        reason: row.reason,
        fromRouteId: row.from_route_id,
        error: parseJson<{ code: string; message: string }>(row.error)!,
        excludedRoutes: parseJson<string[]>(row.excluded_routes) ?? [],
        createdAt: toIso(row.created_at),
      };
      if (row.from_epoch_id) fb.fromEpochId = row.from_epoch_id;
      return fb;
    },
  };
}
