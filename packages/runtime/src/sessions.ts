import { HypertestError, toIso, toNumber, type JsonSchema, type JsonValue, type SqlExecutor } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, ToolResultMessage } from '@hypertest/domain';
import type { Compaction, TranscriptEntry } from '@hypertest/context';
import type { ModelUsage } from '@hypertest/model';
import type { CompleteTurnOptions, RunTurnStatus, RuntimeDeps, SessionRecord, SessionStatus, SessionStore, TerminalSignal, ToolCallRecord, TurnOutcome, TurnRecord } from './contracts.ts';
import { assertNonEmpty, assertTurnNumber, isoOrUndefined, jsonOrNull, jsonParam, parseJson, sameJson } from './util.ts';

const SESSION_STATUSES: readonly SessionStatus[] = ['active', 'waiting', 'completed', 'failed', 'interrupted', 'disposed'];
const TERMINAL_TURN: ReadonlySet<TurnRecord['status']> = new Set(['completed', 'boundary', 'failed']);
/** Sessions in these states accept no new turn (resume/reactivate first). */
const CLOSED_SESSION: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'disposed']);
const RUN_TURN_STATUSES: readonly RunTurnStatus[] = ['continue', 'completed', 'failed', 'waiting', 'interrupted', 'boundary'];

/**
 * The session status a turn completion leaves behind. `disposed` is final; an `interrupted` session (the interrupt
 * landed while the turn ran, possibly from another process) is not silently reactivated by 'active'/'waiting' — only
 * an explicit resume does that. A terminal 'completed'/'failed' outcome still closes it.
 */
function nextSessionStatus(current: SessionStatus, requested: SessionStatus | undefined): SessionStatus {
  if (requested === undefined || current === 'disposed') return current;
  if (current === 'interrupted' && (requested === 'active' || requested === 'waiting')) return current;
  return requested;
}

function assertOutcome(o: unknown): asserts o is TurnOutcome {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HypertestError('invalid_argument', 'outcome must be an object');
  const status = (o as { status?: unknown }).status;
  if (!RUN_TURN_STATUSES.includes(status as RunTurnStatus)) throw new HypertestError('invalid_argument', `unknown outcome status ${String(status)}`);
}

interface SessionRow {
  session_id: string;
  run_id: string;
  agent_id: string;
  engine_kind: string;
  status: SessionStatus;
  turn_count: unknown;
  current_epoch_id: string | null;
  output_schema: unknown;
  native_state: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface TurnRow {
  session_id: string;
  turn: unknown;
  status: TurnRecord['status'];
  epoch_id: string | null;
  route_id: string | null;
  snapshot_id: string | null;
  response: unknown;
  usage: unknown;
  started_at: unknown;
  completed_at: unknown;
  outcome: unknown;
}

interface ToolCallRow {
  tool_call_id: string;
  name: string;
  invocation_id: string;
  status: 'pending' | 'settled';
  result: unknown;
  pending_operation_id: string | null;
  terminal: unknown;
}

const SESSION_COLUMNS = 'session_id, run_id, agent_id, engine_kind, status, turn_count, current_epoch_id, output_schema, native_state, created_at, updated_at';
const TURN_COLUMNS = 'session_id, turn, status, epoch_id, route_id, snapshot_id, response, usage, started_at, completed_at, outcome';

function rowToSession(r: SessionRow): SessionRecord {
  const rec: SessionRecord = {
    sessionId: r.session_id,
    runId: r.run_id,
    agentId: r.agent_id,
    engineKind: r.engine_kind,
    status: r.status,
    turnCount: toNumber(r.turn_count),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  if (r.current_epoch_id) rec.currentEpochId = r.current_epoch_id;
  const schema = parseJson<JsonSchema>(r.output_schema);
  if (schema !== undefined) rec.outputSchema = schema;
  const native = parseJson<{ compatibilityClass: string; data: JsonValue }>(r.native_state);
  if (native !== undefined) rec.nativeState = native;
  return rec;
}

function rowToToolCall(r: ToolCallRow): ToolCallRecord {
  const rec: ToolCallRecord = { toolCallId: r.tool_call_id, name: r.name, invocationId: r.invocation_id, status: r.status };
  const result = parseJson<ToolResultMessage>(r.result);
  if (result !== undefined) rec.result = result;
  if (r.pending_operation_id) rec.pendingOperationId = r.pending_operation_id;
  const terminal = parseJson<TerminalSignal>(r.terminal);
  if (terminal !== undefined) rec.terminal = terminal;
  return rec;
}

function rowToTurn(r: TurnRow, calls: ToolCallRow[]): TurnRecord {
  const rec: TurnRecord = {
    sessionId: r.session_id,
    turn: toNumber(r.turn),
    status: r.status,
    toolCalls: calls.map(rowToToolCall),
    startedAt: toIso(r.started_at),
  };
  if (r.epoch_id) rec.epochId = r.epoch_id;
  if (r.route_id) rec.routeId = r.route_id;
  if (r.snapshot_id) rec.snapshotId = r.snapshot_id;
  const response = parseJson<AssistantMessage>(r.response);
  if (response !== undefined) rec.response = response;
  const usage = parseJson<ModelUsage>(r.usage);
  if (usage !== undefined) rec.usage = usage;
  const completedAt = isoOrUndefined(r.completed_at);
  if (completedAt !== undefined) rec.completedAt = completedAt;
  const outcome = parseJson<TurnOutcome>(r.outcome);
  if (outcome !== undefined) rec.outcome = outcome;
  return rec;
}

function assertMessage(m: unknown, what: string): asserts m is ChatMessage {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new HypertestError('invalid_argument', `${what} must be a message object`);
  const role = (m as { role?: unknown }).role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') throw new HypertestError('invalid_argument', `${what} has an unknown role ${String(role)}`);
}

function assertEntries(entries: readonly TranscriptEntry[]): void {
  if (!Array.isArray(entries)) throw new HypertestError('invalid_argument', 'transcript entries must be an array');
  entries.forEach((e, i) => {
    assertTurnNumber(e?.turn, `transcript entry #${i} turn`, 0);
    assertMessage(e.message, `transcript entry #${i} message`);
  });
}

/** SQL SessionStore (see contracts.ts for the semantics). All multi-row changes run in one transaction. */
export function createSessionStore(deps: RuntimeDeps): SessionStore {
  const { db, clock } = deps;

  async function lockSession(x: SqlExecutor, sessionId: string): Promise<SessionRow> {
    const r = await x.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM ht_sessions WHERE session_id = $1 FOR UPDATE`, [sessionId]);
    const row = r.rows[0];
    if (!row) throw new HypertestError('not_found', `session ${sessionId} not found`, { details: { sessionId } });
    return row;
  }

  async function readTurn(x: SqlExecutor, sessionId: string, turn: number, lock = false): Promise<TurnRecord | undefined> {
    const r = await x.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM ht_turns WHERE session_id = $1 AND turn = $2${lock ? ' FOR UPDATE' : ''}`, [sessionId, turn]);
    const row = r.rows[0];
    if (!row) return undefined;
    const calls = await x.query<ToolCallRow>(
      `SELECT tool_call_id, name, invocation_id, status, result, pending_operation_id, terminal FROM ht_tool_calls WHERE session_id = $1 AND turn = $2 ORDER BY ordinal`,
      [sessionId, turn],
    );
    return rowToTurn(row, calls.rows);
  }

  async function lockTurn(x: SqlExecutor, sessionId: string, turn: number): Promise<TurnRecord> {
    const t = await readTurn(x, sessionId, turn, true);
    if (!t) throw new HypertestError('not_found', `turn ${turn} of session ${sessionId} not found`, { details: { sessionId, turn } });
    return t;
  }

  async function append(x: SqlExecutor, sessionId: string, entries: readonly TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const r = await x.query<{ max: unknown }>(`SELECT COALESCE(MAX(seq), 0) AS max FROM ht_transcript WHERE session_id = $1`, [sessionId]);
    let seq = toNumber(r.rows[0]?.max);
    for (const e of entries) {
      seq += 1;
      await x.query(`INSERT INTO ht_transcript (session_id, seq, turn, message) VALUES ($1, $2, $3, $4::jsonb)`, [sessionId, seq, e.turn, jsonParam(e.message)]);
    }
  }

  async function enqueue(x: SqlExecutor, sessionId: string, messages: readonly ChatMessage[]): Promise<void> {
    const at = clock.isoNow();
    for (const m of messages) await x.query(`INSERT INTO ht_agent_inbox (session_id, message, enqueued_at) VALUES ($1, $2::jsonb, $3)`, [sessionId, jsonParam(m), at]);
  }

  async function drain(x: SqlExecutor, sessionId: string): Promise<ChatMessage[]> {
    // One UPDATE … RETURNING: a row is drained exactly once even under concurrent drains (row locks re-check NOT drained).
    const r = await x.query<{ id: unknown; message: unknown }>(
      `UPDATE ht_agent_inbox SET drained = true, drained_at = $2 WHERE session_id = $1 AND NOT drained RETURNING id, message`,
      [sessionId, clock.isoNow()],
    );
    return r.rows
      .map((row) => ({ id: toNumber(row.id), message: parseJson<ChatMessage>(row.message)! }))
      .sort((a, b) => a.id - b.id)
      .map((row) => row.message);
  }

  async function assertSessionExists(x: SqlExecutor, sessionId: string): Promise<void> {
    const r = await x.query(`SELECT 1 FROM ht_sessions WHERE session_id = $1`, [sessionId]);
    if (r.rows.length === 0) throw new HypertestError('not_found', `session ${sessionId} not found`, { details: { sessionId } });
  }

  const store: SessionStore = {
    async create(record, initialTranscript) {
      assertNonEmpty(record?.sessionId, 'sessionId');
      assertNonEmpty(record.runId, 'runId');
      assertNonEmpty(record.agentId, 'agentId');
      assertNonEmpty(record.engineKind, 'engineKind');
      if (initialTranscript !== undefined) assertEntries(initialTranscript);
      const now = clock.isoNow();
      // One transaction: the session never exists without its initial transcript.
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ht_sessions (session_id, run_id, agent_id, engine_kind, status, turn_count, current_epoch_id, output_schema, native_state, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', 0, $5, $6::jsonb, $7::jsonb, $8, $8)`,
          [record.sessionId, record.runId, record.agentId, record.engineKind, record.currentEpochId ?? null, jsonOrNull(record.outputSchema), jsonOrNull(record.nativeState), now],
        );
        if (initialTranscript !== undefined) await append(tx, record.sessionId, initialTranscript);
      });
      const created = await store.get(record.sessionId);
      if (!created) throw new HypertestError('internal', `session ${record.sessionId} not readable after insert`);
      return created;
    },

    async get(sessionId) {
      const r = await db.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM ht_sessions WHERE session_id = $1`, [sessionId]);
      return r.rows[0] ? rowToSession(r.rows[0]) : undefined;
    },

    async setStatus(sessionId, status) {
      if (!SESSION_STATUSES.includes(status)) throw new HypertestError('invalid_argument', `unknown session status ${String(status)}`);
      await db.transaction(async (tx) => {
        const row = await lockSession(tx, sessionId);
        if (row.status === status) return;
        if (row.status === 'disposed') throw new HypertestError('conflict', `session ${sessionId} is disposed`, { details: { sessionId, status } });
        await tx.query(`UPDATE ht_sessions SET status = $2, updated_at = $3 WHERE session_id = $1`, [sessionId, status, clock.isoNow()]);
      });
    },

    async setNativeState(sessionId, state) {
      if (state !== undefined && (typeof state?.compatibilityClass !== 'string' || state.compatibilityClass.length === 0)) {
        throw new HypertestError('invalid_argument', 'nativeState.compatibilityClass must be a non-empty string');
      }
      const r = await db.query(`UPDATE ht_sessions SET native_state = $2::jsonb, updated_at = $3 WHERE session_id = $1 RETURNING session_id`, [sessionId, jsonOrNull(state), clock.isoNow()]);
      if (r.rows.length === 0) throw new HypertestError('not_found', `session ${sessionId} not found`, { details: { sessionId } });
    },

    async appendTranscript(sessionId, entries) {
      assertEntries(entries);
      await db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        await append(tx, sessionId, entries);
      });
    },

    async transcript(sessionId) {
      const r = await db.query<{ turn: unknown; message: unknown }>(`SELECT turn, message FROM ht_transcript WHERE session_id = $1 ORDER BY seq`, [sessionId]);
      if (r.rows.length === 0) await assertSessionExists(db, sessionId);
      return r.rows.map((row) => ({ turn: toNumber(row.turn), message: parseJson<ChatMessage>(row.message)! }));
    },

    async beginTurn(sessionId, turn, meta) {
      assertTurnNumber(turn);
      return db.transaction(async (tx) => {
        const session = await lockSession(tx, sessionId);
        const existing = await readTurn(tx, sessionId, turn);
        if (existing) return existing;
        if (CLOSED_SESSION.has(session.status)) {
          throw new HypertestError('precondition_failed', `session ${sessionId} is ${session.status}; no new turn may begin`, { details: { sessionId, status: session.status } });
        }
        const last = await tx.query<{ turn: unknown; status: TurnRecord['status'] }>(`SELECT turn, status FROM ht_turns WHERE session_id = $1 ORDER BY turn DESC LIMIT 1`, [sessionId]);
        const prev = last.rows[0];
        const expected = prev ? toNumber(prev.turn) + 1 : 1;
        if (turn !== expected) {
          throw new HypertestError('precondition_failed', `turn ${turn} cannot begin: the next turn of session ${sessionId} is ${expected}`, { details: { sessionId, turn, expected } });
        }
        if (prev && !TERMINAL_TURN.has(prev.status)) {
          throw new HypertestError('precondition_failed', `turn ${turn} cannot begin: turn ${toNumber(prev.turn)} is still ${prev.status}`, { details: { sessionId, turn, previousStatus: prev.status } });
        }
        await tx.query(
          `INSERT INTO ht_turns (session_id, turn, status, epoch_id, route_id, snapshot_id, started_at) VALUES ($1, $2, 'started', $3, $4, $5, $6)`,
          [sessionId, turn, meta?.epochId ?? null, meta?.routeId ?? null, meta?.snapshotId ?? null, clock.isoNow()],
        );
        return (await readTurn(tx, sessionId, turn))!;
      });
    },

    async recordModelResponse(sessionId, turn, response, usage, toolCalls, meta) {
      assertTurnNumber(turn);
      if (!response || response.role !== 'assistant' || !Array.isArray(response.content)) throw new HypertestError('invalid_argument', 'response must be an assistant message');
      const calls = response.toolCalls ?? [];
      if (!Array.isArray(toolCalls) || toolCalls.length !== calls.length) {
        throw new HypertestError('invalid_argument', `toolCalls must list exactly the response's ${calls.length} tool call(s)`);
      }
      const ids = new Set<string>();
      const invocations = new Set<string>();
      toolCalls.forEach((c, i) => {
        const call = calls[i]!;
        if (c.toolCallId !== call.id || c.name !== call.name) {
          throw new HypertestError('invalid_argument', `toolCalls[${i}] (${c.toolCallId}/${c.name}) does not match the response's tool call ${call.id}/${call.name}`);
        }
        assertNonEmpty(c.toolCallId, `toolCalls[${i}].toolCallId`);
        assertNonEmpty(c.invocationId, `toolCalls[${i}].invocationId`);
        if (ids.has(c.toolCallId)) throw new HypertestError('invalid_argument', `duplicate tool call id ${c.toolCallId}`);
        if (invocations.has(c.invocationId)) throw new HypertestError('invalid_argument', `duplicate invocation id ${c.invocationId}`);
        ids.add(c.toolCallId);
        invocations.add(c.invocationId);
      });
      return db.transaction(async (tx) => {
        const current = await lockTurn(tx, sessionId, turn);
        if (current.response !== undefined) {
          const same = sameJson(current.response, response) && sameJson(current.toolCalls.map((c) => [c.toolCallId, c.name, c.invocationId]), toolCalls.map((c) => [c.toolCallId, c.name, c.invocationId]));
          if (same) return current;
          throw new HypertestError('conflict', `turn ${turn} of session ${sessionId} already has a different model response`, { details: { sessionId, turn } });
        }
        if (current.status !== 'started') {
          throw new HypertestError('precondition_failed', `turn ${turn} of session ${sessionId} is ${current.status}; it cannot take a model response`, { details: { sessionId, turn, status: current.status } });
        }
        await tx.query(
          `UPDATE ht_turns SET status = 'model_responded', response = $3::jsonb, usage = $4::jsonb, epoch_id = COALESCE($5, epoch_id), route_id = COALESCE($6, route_id),
                  snapshot_id = COALESCE($7, snapshot_id)
           WHERE session_id = $1 AND turn = $2`,
          [sessionId, turn, jsonParam(response), jsonParam(usage), meta?.epochId ?? null, meta?.routeId ?? null, meta?.snapshotId ?? null],
        );
        for (const [ordinal, c] of toolCalls.entries()) {
          await tx.query(
            `INSERT INTO ht_tool_calls (session_id, turn, tool_call_id, ordinal, name, invocation_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [sessionId, turn, c.toolCallId, ordinal, c.name, c.invocationId],
          );
        }
        return (await readTurn(tx, sessionId, turn))!;
      });
    },

    async settleToolCall(sessionId, turn, toolCallId, settled) {
      assertTurnNumber(turn);
      const result = settled?.result;
      if (!result || result.role !== 'tool' || typeof result.content !== 'string') throw new HypertestError('invalid_argument', 'settled.result must be a tool result message');
      if (result.toolCallId !== toolCallId) throw new HypertestError('invalid_argument', `settled.result.toolCallId ${result.toolCallId} does not match ${toolCallId}`);
      const outcome = { result, pendingOperationId: settled.pendingOperationId, terminal: settled.terminal };
      await db.transaction(async (tx) => {
        const t = await lockTurn(tx, sessionId, turn);
        const call = t.toolCalls.find((c) => c.toolCallId === toolCallId);
        if (!call) throw new HypertestError('not_found', `tool call ${toolCallId} of turn ${turn} (session ${sessionId}) not found`, { details: { sessionId, turn, toolCallId } });
        if (call.status === 'settled') {
          if (sameJson({ result: call.result, pendingOperationId: call.pendingOperationId, terminal: call.terminal }, outcome)) return;
          throw new HypertestError('conflict', `tool call ${toolCallId} of turn ${turn} is already settled with a different outcome`, { details: { sessionId, turn, toolCallId } });
        }
        if (t.status !== 'model_responded') {
          throw new HypertestError('precondition_failed', `turn ${turn} of session ${sessionId} is ${t.status}; its tool calls can no longer be settled`, { details: { sessionId, turn, status: t.status } });
        }
        await tx.query(
          `UPDATE ht_tool_calls SET status = 'settled', result = $4::jsonb, pending_operation_id = $5, terminal = $6::jsonb, settled_at = $7
           WHERE session_id = $1 AND turn = $2 AND tool_call_id = $3`,
          [sessionId, turn, toolCallId, jsonParam(result), settled.pendingOperationId ?? null, jsonOrNull(settled.terminal), clock.isoNow()],
        );
      });
    },

    async completeTurn(sessionId, turn, status, options: CompleteTurnOptions = {}) {
      assertTurnNumber(turn);
      if (status !== 'completed' && status !== 'boundary' && status !== 'failed') throw new HypertestError('invalid_argument', `unknown terminal turn status ${String(status)}`);
      if (options.append) assertEntries(options.append);
      for (const [i, m] of (options.enqueue ?? []).entries()) assertMessage(m, `enqueue[${i}]`);
      if (options.sessionStatus !== undefined && !SESSION_STATUSES.includes(options.sessionStatus)) {
        throw new HypertestError('invalid_argument', `unknown session status ${String(options.sessionStatus)}`);
      }
      if (options.outcome !== undefined) assertOutcome(options.outcome);
      await db.transaction(async (tx) => {
        const session = await lockSession(tx, sessionId);
        const t = await lockTurn(tx, sessionId, turn);
        if (t.status === status) return;
        if (TERMINAL_TURN.has(t.status)) {
          throw new HypertestError('conflict', `turn ${turn} of session ${sessionId} is already ${t.status}`, { details: { sessionId, turn, status: t.status, requested: status } });
        }
        if (status === 'completed') {
          if (t.status !== 'model_responded') {
            throw new HypertestError('precondition_failed', `turn ${turn} of session ${sessionId} has no model response; it cannot complete`, { details: { sessionId, turn, status: t.status } });
          }
          const pending = t.toolCalls.filter((c) => c.status !== 'settled').map((c) => c.toolCallId);
          if (pending.length > 0) {
            throw new HypertestError('precondition_failed', `turn ${turn} of session ${sessionId} has unsettled tool calls: ${pending.join(', ')}`, { details: { sessionId, turn, pending } });
          }
        }
        const now = clock.isoNow();
        await tx.query(`UPDATE ht_turns SET status = $3, completed_at = $4, outcome = $5::jsonb WHERE session_id = $1 AND turn = $2`, [sessionId, turn, status, now, jsonOrNull(options.outcome)]);
        const nextStatus = nextSessionStatus(session.status, options.sessionStatus);
        await tx.query(`UPDATE ht_sessions SET turn_count = GREATEST(turn_count, $2), status = $3, updated_at = $4 WHERE session_id = $1`, [sessionId, turn, nextStatus, now]);
        if (options.append) await append(tx, sessionId, options.append);
        if (options.enqueue) await enqueue(tx, sessionId, options.enqueue);
      });
    },

    async getTurn(sessionId, turn) {
      return readTurn(db, sessionId, turn);
    },

    async lastTurn(sessionId) {
      const r = await db.query<{ turn: unknown }>(`SELECT turn FROM ht_turns WHERE session_id = $1 ORDER BY turn DESC LIMIT 1`, [sessionId]);
      const row = r.rows[0];
      return row ? readTurn(db, sessionId, toNumber(row.turn)) : undefined;
    },

    async addCompaction(sessionId, compaction) {
      assertNonEmpty(compaction?.compactionId, 'compactionId');
      if (compaction.level !== 'soft' && compaction.level !== 'hard') throw new HypertestError('invalid_argument', 'compaction level must be soft or hard');
      assertTurnNumber(compaction.upToTurn, 'upToTurn', 0);
      if (typeof compaction.summary !== 'string') throw new HypertestError('invalid_argument', 'compaction summary must be a string');
      await db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        await tx.query(
          `INSERT INTO ht_compactions (compaction_id, session_id, level, up_to_turn, summary, evidence_refs, summary_artifact, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
          [compaction.compactionId, sessionId, compaction.level, compaction.upToTurn, compaction.summary, jsonParam(compaction.evidenceRefs ?? []), jsonOrNull(compaction.summaryArtifact), compaction.createdAt ?? clock.isoNow()],
        );
      });
    },

    async compactions(sessionId) {
      const r = await db.query<{ compaction_id: string; level: 'soft' | 'hard'; up_to_turn: unknown; summary: string; evidence_refs: unknown; summary_artifact: unknown; created_at: unknown }>(
        `SELECT compaction_id, level, up_to_turn, summary, evidence_refs, summary_artifact, created_at FROM ht_compactions WHERE session_id = $1 ORDER BY seq`,
        [sessionId],
      );
      return r.rows.map((row) => {
        const c: Compaction = {
          compactionId: row.compaction_id,
          level: row.level,
          upToTurn: toNumber(row.up_to_turn),
          summary: row.summary,
          evidenceRefs: parseJson<string[]>(row.evidence_refs) ?? [],
          createdAt: toIso(row.created_at),
        };
        const artifact = parseJson<NonNullable<Compaction['summaryArtifact']>>(row.summary_artifact);
        if (artifact !== undefined) c.summaryArtifact = artifact;
        return c;
      });
    },

    async enqueueInput(sessionId, messages) {
      if (!Array.isArray(messages)) throw new HypertestError('invalid_argument', 'messages must be an array');
      messages.forEach((m, i) => assertMessage(m, `messages[${i}]`));
      await db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        await enqueue(tx, sessionId, messages);
      });
    },

    async drainInput(sessionId) {
      return db.transaction(async (tx) => {
        await assertSessionExists(tx, sessionId);
        return drain(tx, sessionId);
      });
    },

    async drainInputInto(sessionId, turn, extra) {
      assertTurnNumber(turn, 'turn', 0);
      if (!Array.isArray(extra)) throw new HypertestError('invalid_argument', 'extra must be an array');
      extra.forEach((m, i) => assertMessage(m, `extra[${i}]`));
      return db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        const drained = await drain(tx, sessionId);
        const entries: TranscriptEntry[] = [...drained, ...extra].map((message) => ({ turn, message }));
        await append(tx, sessionId, entries);
        return entries;
      });
    },
  };
  return store;
}
