import { HypertestError, toIso, toNumber } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type ModelEpoch, type ModelSwitchReason } from '@hypertest/domain';
import type { EpochDeps, EpochManager, EpochRouting, ModelPause, ModelSwitchOutcome, ModelSwitchRequest, OkRouteDecision, PendingFallback, TurnRecord } from './contracts.ts';
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

interface PauseRow {
  session_id: string;
  run_id: string;
  agent_id: string;
  turn: unknown;
  reason: string;
  resume_at: unknown;
  routes: unknown;
  consecutive: unknown;
  created_at: unknown;
}

function rowToPause(r: PauseRow): ModelPause {
  return {
    sessionId: r.session_id,
    runId: r.run_id,
    agentId: r.agent_id,
    turn: toNumber(r.turn),
    reason: r.reason,
    resumeAt: toIso(r.resume_at),
    routes: parseJson<string[]>(r.routes) ?? [],
    consecutive: toNumber(r.consecutive),
    createdAt: toIso(r.created_at),
  };
}

interface SwitchRow {
  switch_id: string;
  run_id: string;
  target_kind: 'agent' | 'role';
  target: string;
  route_id: string;
  reason: string | null;
  requested_by: string;
  created_at: unknown;
}

function rowToSwitch(r: SwitchRow): ModelSwitchRequest {
  const out: ModelSwitchRequest = {
    switchId: r.switch_id,
    runId: r.run_id,
    target: r.target_kind === 'agent' ? { kind: 'agent', agentId: r.target } : { kind: 'role', role: r.target },
    routeId: r.route_id,
    requestedBy: r.requested_by,
    createdAt: toIso(r.created_at),
  };
  if (r.reason) out.reason = r.reason;
  return out;
}

/**
 * SQL EpochManager over ht_epochs (+ ht_pending_fallbacks, ht_model_pauses, ht_model_switches). Emits
 * model.epoch_started in the insert transaction (and model.switch_requested with a manual switch request).
 */
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
                                  context_snapshot_id, switch_reason, started_at_turn, started_at, decision, excluded_routes, route_profile)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb)`,
          [
            e.epochId, e.runId, e.agentId, e.sessionId, e.previousEpochId ?? null, e.routeId, e.provider, e.model, e.capabilityProfileRevision, e.continuationCompatibilityClass,
            e.contextSnapshotId, e.switchReason, e.startedAtTurn, e.startedAt, jsonOrNull(decision), jsonParam(excluded), jsonOrNull(options.profile),
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
      const r = await db.query<{ decision: unknown; excluded_routes: unknown; route_profile: unknown }>(`SELECT decision, excluded_routes, route_profile FROM ht_epochs WHERE epoch_id = $1`, [epochId]);
      const row = r.rows[0];
      if (!row) return undefined;
      const out: EpochRouting = { excludedRoutes: parseJson<string[]>(row.excluded_routes) ?? [] };
      const decision = parseJson<OkRouteDecision>(row.decision);
      if (decision !== undefined) out.decision = decision;
      const profile = parseJson<EpochRouting['profile']>(row.route_profile);
      if (profile !== undefined) out.profile = profile;
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

    async clearPendingFallback(sessionId) {
      assertNonEmpty(sessionId, 'sessionId');
      await db.query(`DELETE FROM ht_pending_fallbacks WHERE session_id = $1`, [sessionId]);
    },

    async modelPause(sessionId) {
      const r = await db.query<PauseRow>(
        `SELECT session_id, run_id, agent_id, turn, reason, resume_at, routes, consecutive, created_at FROM ht_model_pauses WHERE session_id = $1`,
        [sessionId],
      );
      return r.rows[0] ? rowToPause(r.rows[0]) : undefined;
    },

    async setModelPause(pause) {
      for (const f of ['sessionId', 'runId', 'agentId', 'reason', 'resumeAt'] as const) assertNonEmpty(pause?.[f], f);
      if (!Number.isSafeInteger(pause.turn) || pause.turn < 0) throw new HypertestError('invalid_argument', 'pause.turn must be a non-negative integer');
      if (!Number.isSafeInteger(pause.consecutive) || pause.consecutive < 1) throw new HypertestError('invalid_argument', 'pause.consecutive must be an integer ≥ 1');
      if (!Number.isFinite(Date.parse(pause.resumeAt))) throw new HypertestError('invalid_argument', `pause.resumeAt must be an ISO-8601 time (got ${pause.resumeAt})`);
      assertStringList(pause.routes, 'pause.routes');
      const createdAt = clock.isoNow();
      await db.query(
        `INSERT INTO ht_model_pauses (session_id, run_id, agent_id, turn, reason, resume_at, routes, consecutive, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (session_id) DO UPDATE SET turn = EXCLUDED.turn, reason = EXCLUDED.reason, resume_at = EXCLUDED.resume_at, routes = EXCLUDED.routes,
           consecutive = EXCLUDED.consecutive, created_at = EXCLUDED.created_at`,
        [pause.sessionId, pause.runId, pause.agentId, pause.turn, pause.reason, pause.resumeAt, jsonParam(pause.routes), pause.consecutive, createdAt],
      );
      return { ...pause, routes: [...pause.routes], createdAt };
    },

    async clearModelPause(sessionId) {
      await db.query(`DELETE FROM ht_model_pauses WHERE session_id = $1`, [sessionId]);
    },

    async listModelPauses(runId) {
      const r = await db.query<PauseRow>(
        `SELECT session_id, run_id, agent_id, turn, reason, resume_at, routes, consecutive, created_at FROM ht_model_pauses WHERE run_id = $1 ORDER BY session_id`,
        [runId],
      );
      return r.rows.map(rowToPause);
    },

    async releaseModelPauses(runId, at) {
      assertNonEmpty(runId, 'runId');
      if (!Number.isFinite(Date.parse(at))) throw new HypertestError('invalid_argument', `at must be an ISO-8601 time (got ${at})`);
      // only pauses that would still wait are released (a repeated release changes nothing and reports nothing)
      const r = await db.query<{ session_id: string }>(`UPDATE ht_model_pauses SET resume_at = $2::timestamptz WHERE run_id = $1 AND resume_at > $2::timestamptz RETURNING session_id`, [runId, at]);
      return r.rows.map((row) => row.session_id).sort();
    },

    async requestSwitch(request, ctx) {
      assertNonEmpty(request?.runId, 'runId');
      assertNonEmpty(request.routeId, 'routeId');
      assertNonEmpty(request.requestedBy, 'requestedBy');
      const t = request.target;
      if (t?.kind === 'agent') assertNonEmpty(t.agentId, 'target.agentId');
      else if (t?.kind === 'role') assertNonEmpty(t.role, 'target.role');
      else throw new HypertestError('invalid_argument', `target must be { kind: 'agent', agentId } or { kind: 'role', role }`);
      const out: ModelSwitchRequest = { ...request, switchId: ids.next('msw'), createdAt: clock.isoNow() };
      if (out.reason === undefined) delete out.reason;
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ht_model_switches (switch_id, run_id, target_kind, target, route_id, reason, requested_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [out.switchId, out.runId, t.kind, t.kind === 'agent' ? t.agentId : t.role, out.routeId, out.reason ?? null, out.requestedBy, out.createdAt],
        );
        if (deps.events) {
          await deps.events.emit(
            [eventFrom(ctx, EVENT_TYPES.modelSwitchRequested, 'model', out.switchId, { switchId: out.switchId, target: t, routeId: out.routeId, reason: out.reason ?? null, requestedBy: out.requestedBy })],
            tx,
          );
        }
      });
      return out;
    },

    async pendingSwitch(runId, agentId, role) {
      const r = await db.query<SwitchRow>(
        `SELECT s.switch_id, s.run_id, s.target_kind, s.target, s.route_id, s.reason, s.requested_by, s.created_at
           FROM ht_model_switches s
          WHERE s.run_id = $1 AND ((s.target_kind = 'agent' AND s.target = $2) OR (s.target_kind = 'role' AND s.target = $3))
            AND NOT EXISTS (SELECT 1 FROM ht_model_switch_outcomes o WHERE o.switch_id = s.switch_id AND o.agent_id = $2)
            -- a request older than one this agent already handled is superseded by it
            AND s.seq > COALESCE((SELECT max(s2.seq) FROM ht_model_switches s2 JOIN ht_model_switch_outcomes o2 ON o2.switch_id = s2.switch_id
                                   WHERE s2.run_id = $1 AND o2.agent_id = $2), 0)
          ORDER BY s.seq DESC LIMIT 1`,
        [runId, agentId, role],
      );
      return r.rows[0] ? rowToSwitch(r.rows[0]) : undefined;
    },

    async recordSwitchOutcome(outcome) {
      assertNonEmpty(outcome?.switchId, 'switchId');
      assertNonEmpty(outcome.agentId, 'agentId');
      if (outcome.outcome !== 'applied' && outcome.outcome !== 'refused') throw new HypertestError('invalid_argument', `outcome must be applied or refused`);
      // once per agent (older unhandled requests are superseded: pendingSwitch never returns them again)
      await db.query(
        `INSERT INTO ht_model_switch_outcomes (switch_id, agent_id, outcome, epoch_id, detail, at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (switch_id, agent_id) DO NOTHING`,
        [outcome.switchId, outcome.agentId, outcome.outcome, outcome.epochId ?? null, outcome.detail, clock.isoNow()],
      );
    },

    async listSwitches(runId) {
      const r = await db.query<SwitchRow>(
        `SELECT switch_id, run_id, target_kind, target, route_id, reason, requested_by, created_at FROM ht_model_switches WHERE run_id = $1 ORDER BY seq`,
        [runId],
      );
      const o = await db.query<{ switch_id: string; agent_id: string; outcome: 'applied' | 'refused'; epoch_id: string | null; detail: string; at: unknown }>(
        `SELECT o.switch_id, o.agent_id, o.outcome, o.epoch_id, o.detail, o.at FROM ht_model_switch_outcomes o JOIN ht_model_switches s ON s.switch_id = o.switch_id WHERE s.run_id = $1 ORDER BY o.at, o.agent_id`,
        [runId],
      );
      return r.rows.map((row) => {
        const outcomes: ModelSwitchOutcome[] = o.rows
          .filter((x) => x.switch_id === row.switch_id)
          .map((x) => {
            const out: ModelSwitchOutcome = { switchId: x.switch_id, agentId: x.agent_id, outcome: x.outcome, detail: x.detail, at: toIso(x.at) };
            if (x.epoch_id) out.epochId = x.epoch_id;
            return out;
          });
        return { ...rowToSwitch(row), outcomes };
      });
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
