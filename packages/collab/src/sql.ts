import { HypertestError, fromJsonColumn, toIso, toNumber, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import type { DomainEventInput, EventContext } from '@hypertest/domain';

/**
 * Runs fn in the caller's transaction when given, else in a fresh one (state row + events + outbox commit together).
 * Passing the database itself as `tx` is treated like no tx: `db` is an autocommit executor, and running the
 * multi-statement write on it would drop both atomicity and the per-run lock.
 */
export function inTx<T>(db: SqlDatabase, tx: SqlExecutor | undefined, fn: (q: SqlExecutor) => Promise<T>): Promise<T> {
  return tx !== undefined && tx !== db ? fn(tx) : db.transaction(fn);
}

/** Namespace of collab's advisory locks (two-int4 key space, disjoint from the single-bigint keys other packages use). */
const ADVISORY_NAMESPACE = 0x48544342; // 'HTCB'

/**
 * Transaction-scoped lock on an arbitrary key (e.g. a spec id shared by several runs). Take it AFTER the run lock
 * so every collab writer keeps the order run lock → key lock.
 */
export async function lockKey(q: SqlExecutor, key: string): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2))', [ADVISORY_NAMESPACE, key]);
}

/**
 * Takes the per-run row lock (creating the counter row on first use) and returns the current counters.
 * Every collab write locks its run FIRST, so all writers of one run serialize on the same row in the same
 * order: no deadlocks between blackboard writes and event appends, and gap-free seq/revision assignment.
 */
export async function lockRun(q: SqlExecutor, runId: string): Promise<{ lastSeq: number; bbRevision: number }> {
  const r = await q.query<{ last_seq: unknown; bb_revision: unknown }>(
    `INSERT INTO ht_run_counters (run_id, last_seq, bb_revision) VALUES ($1, 0, 0)
     ON CONFLICT (run_id) DO UPDATE SET last_seq = ht_run_counters.last_seq
     RETURNING last_seq, bb_revision`,
    [runId],
  );
  const row = r.rows[0]!;
  return { lastSeq: toNumber(row.last_seq), bbRevision: toNumber(row.bb_revision) };
}

/** Increments and returns the run's blackboard revision (caller holds the run lock in the same tx). */
export async function bumpRevision(q: SqlExecutor, runId: string): Promise<number> {
  const r = await q.query<{ bb_revision: unknown }>(
    `INSERT INTO ht_run_counters (run_id, last_seq, bb_revision) VALUES ($1, 0, 1)
     ON CONFLICT (run_id) DO UPDATE SET bb_revision = ht_run_counters.bb_revision + 1
     RETURNING bb_revision`,
    [runId],
  );
  return toNumber(r.rows[0]!.bb_revision);
}

/** jsonb parameter: always pass JSON text and cast with `::jsonb` (arrays would otherwise become PG arrays). */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** JSON round trip: drops undefined members so returned objects equal what a later read returns. */
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Decodes a jsonb column whose top-level value is always an object or array (domain documents). Columns that may
 * hold a top-level JSON string must be selected as `col::text` and decoded with `jsonText` instead: the drivers
 * already parse jsonb, so a string value is indistinguishable from JSON text here.
 */
export function json<T>(v: unknown): T {
  return fromJsonColumn<T>(v);
}

/** Decodes a `jsonb::text` column (unambiguous for every JSON value, including strings). */
export function jsonText<T>(v: unknown): T {
  if (typeof v !== 'string') throw new TypeError(`expected jsonb::text, got ${typeof v}`);
  return JSON.parse(v) as T;
}

export function num(v: unknown): number {
  return toNumber(v);
}

export function iso(v: unknown): string {
  return toIso(v);
}

/** Validates an ISO-8601 timestamp and returns its canonical `toISOString()` form. */
export function canonicalIso(value: string, what: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new HypertestError('invalid_argument', `${what} is not a valid timestamp: ${value}`);
  return new Date(ms).toISOString();
}

export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HypertestError('invalid_argument', `${what} must be a non-empty string`);
  return value;
}

export function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new HypertestError('invalid_argument', `${what} must be an array`);
  return value;
}

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HypertestError('invalid_argument', `${what} must be an object`);
  return value as Record<string, unknown>;
}

export function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HypertestError('invalid_argument', `${what} must be a finite number`);
  return value;
}

export function requireNonNegativeInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HypertestError('invalid_argument', `${what} must be a non-negative integer`);
  return value;
}

export function requireRunMatch(inputRunId: string, ctx: EventContext, what: string): void {
  if (inputRunId !== ctx.runId) {
    throw new HypertestError('invalid_argument', `${what}.runId (${inputRunId}) does not match the event context run (${ctx.runId})`, {
      details: { runId: inputRunId, ctxRunId: ctx.runId },
    });
  }
}

/** Event input from a context (I10 correlation fields), with an optional work item fallback. */
export function eventInput(
  ctx: EventContext,
  eventType: string,
  aggregateType: DomainEventInput['aggregateType'],
  aggregateId: string,
  payload: unknown,
  fallbackWorkItemId?: string,
): DomainEventInput<unknown> {
  const e: DomainEventInput<unknown> = { eventType, aggregateType, aggregateId, runId: ctx.runId, correlationId: ctx.correlationId, actorId: ctx.actorId, payload };
  if (ctx.causationId !== undefined) e.causationId = ctx.causationId;
  const workItemId = ctx.workItemId ?? fallbackWorkItemId;
  if (workItemId !== undefined) e.workItemId = workItemId;
  if (ctx.agentId !== undefined) e.agentId = ctx.agentId;
  return e;
}

/** Copies only defined values (payloads stay small and JSON-clean). */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
