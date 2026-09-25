import { HypertestError, eventSubject, type EventEnvelope, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { EVENT_SCHEMA_VERSION, type DomainEvent, type DomainEventInput } from '@hypertest/domain';
import type { CollabDeps, EventStore } from './contracts.ts';
import { canonicalIso, inTx, iso, jsonParam, jsonText, lockRun, num, requireString } from './sql.ts';

const MAX_CHAIN_DEPTH = 1000;
/** Rows per multi-row INSERT (14 params per event row keeps us far below the 65535 parameter limit). */
const INSERT_CHUNK = 200;

/**
 * Event columns for SELECTs. The payload is read as `jsonb::text`: a payload may be any JSON value, and a
 * top-level JSON string arrives from both drivers already decoded, where it would be indistinguishable from JSON
 * text (decoding it again throws and would make the whole run's L0 unreadable).
 */
export function eventColumns(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return ['event_id', 'run_id', 'seq', 'event_type', 'aggregate_type', 'aggregate_id', 'correlation_id', 'causation_id', 'actor_id', 'work_item_id', 'agent_id', 'schema_version']
    .map((c) => `${a}${c}`)
    .concat([`${a}payload::text AS payload`, `${a}occurred_at`])
    .join(', ');
}

interface EventRow {
  event_id: string;
  run_id: string;
  seq: unknown;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id: string | null;
  actor_id: string;
  work_item_id: string | null;
  agent_id: string | null;
  schema_version: string;
  payload: unknown;
  occurred_at: unknown;
}

export function rowToEvent(r: EventRow): DomainEvent<unknown> {
  const e: DomainEvent<unknown> = {
    eventId: r.event_id,
    eventType: r.event_type,
    aggregateType: r.aggregate_type as DomainEvent['aggregateType'],
    aggregateId: r.aggregate_id,
    runId: r.run_id,
    seq: num(r.seq),
    correlationId: r.correlation_id,
    actorId: r.actor_id,
    schemaVersion: r.schema_version,
    payload: jsonText<unknown>(r.payload),
    occurredAt: iso(r.occurred_at),
  };
  if (r.causation_id !== null) e.causationId = r.causation_id;
  if (r.work_item_id !== null) e.workItemId = r.work_item_id;
  if (r.agent_id !== null) e.agentId = r.agent_id;
  return e;
}

function validateInput(e: DomainEventInput<unknown>, i: number): void {
  const at = `events[${i}]`;
  requireString(e.runId, `${at}.runId`);
  requireString(e.eventType, `${at}.eventType`);
  requireString(e.aggregateType, `${at}.aggregateType`);
  requireString(e.aggregateId, `${at}.aggregateId`);
  requireString(e.correlationId, `${at}.correlationId`);
  requireString(e.actorId, `${at}.actorId`);
  if (e.eventId !== undefined) requireString(e.eventId, `${at}.eventId`);
}

/** Same logical event (idempotent re-append with an explicit eventId)? */
function sameEvent(stored: DomainEvent<unknown>, input: DomainEventInput<unknown>): boolean {
  return stored.runId === input.runId && stored.eventType === input.eventType && stored.aggregateType === input.aggregateType && stored.aggregateId === input.aggregateId;
}

export function createEventStore(deps: CollabDeps): EventStore {
  const { db, ids, clock } = deps;

  async function append(inputs: DomainEventInput<unknown>[], tx?: SqlExecutor): Promise<DomainEvent<unknown>[]> {
    if (inputs.length === 0) return [];
    const explicit = new Set<string>();
    inputs.forEach((e, i) => {
      validateInput(e, i);
      if (e.eventId !== undefined) {
        if (explicit.has(e.eventId)) throw new HypertestError('invalid_argument', `duplicate eventId ${e.eventId} in one append batch`);
        explicit.add(e.eventId);
      }
    });

    return inTx(db, tx, async (q) => {
      // 1. Per-run locks in a stable order (gap-free seq; no lock-order inversion between runs of one batch).
      const runIds = [...new Set(inputs.map((e) => e.runId))].sort();
      for (const runId of runIds) await lockRun(q, runId);

      // 2. Idempotent re-append of explicitly identified events (durable retries): return what is stored.
      const out: Array<DomainEvent<unknown> | undefined> = new Array(inputs.length);
      if (explicit.size > 0) {
        const existing = await q.query<EventRow>(`SELECT ${eventColumns()} FROM ht_events WHERE event_id = ANY($1)`, [[...explicit]]);
        const byId = new Map(existing.rows.map((r) => [r.event_id, rowToEvent(r)]));
        inputs.forEach((e, i) => {
          const stored = e.eventId === undefined ? undefined : byId.get(e.eventId);
          if (!stored) return;
          if (!sameEvent(stored, e)) {
            throw new HypertestError('conflict', `eventId ${e.eventId} already recorded for a different event`, {
              details: { eventId: e.eventId, stored: { runId: stored.runId, eventType: stored.eventType, aggregateId: stored.aggregateId } },
            });
          }
          out[i] = stored;
        });
      }

      // 3. Assign seq per run for the new events, in input order.
      const fresh: number[] = [];
      inputs.forEach((_, i) => {
        if (out[i] === undefined) fresh.push(i);
      });
      if (fresh.length === 0) return out as DomainEvent<unknown>[];
      const nextSeq = new Map<string, number>();
      for (const runId of runIds) {
        const n = fresh.filter((i) => inputs[i]!.runId === runId).length;
        if (n === 0) continue;
        const r = await q.query<{ last_seq: unknown }>('UPDATE ht_run_counters SET last_seq = last_seq + $2 WHERE run_id = $1 RETURNING last_seq', [runId, n]);
        nextSeq.set(runId, num(r.rows[0]!.last_seq) - n + 1);
      }
      const now = clock.isoNow();
      const created: Array<{ event: DomainEvent<unknown>; payloadJson: string }> = [];
      for (const i of fresh) {
        const input = inputs[i]!;
        const seq = nextSeq.get(input.runId)!;
        nextSeq.set(input.runId, seq + 1);
        const payloadJson = jsonParam(input.payload);
        const event: DomainEvent<unknown> = {
          eventId: input.eventId ?? ids.next('evt'),
          eventType: input.eventType,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          runId: input.runId,
          seq,
          correlationId: input.correlationId,
          actorId: input.actorId,
          schemaVersion: EVENT_SCHEMA_VERSION,
          payload: JSON.parse(payloadJson) as unknown,
          occurredAt: canonicalIso(input.occurredAt ?? now, 'occurredAt'),
        };
        if (input.causationId !== undefined) event.causationId = input.causationId;
        if (input.workItemId !== undefined) event.workItemId = input.workItemId;
        if (input.agentId !== undefined) event.agentId = input.agentId;
        out[i] = event;
        created.push({ event, payloadJson });
      }

      // 4. ht_events + ht_outbox in the caller's transaction (I5/I10: no state change without its event).
      for (let start = 0; start < created.length; start += INSERT_CHUNK) {
        const chunk = created.slice(start, start + INSERT_CHUNK);
        const evParams: SqlParam[] = [];
        const evValues: string[] = [];
        const obParams: SqlParam[] = [];
        const obValues: string[] = [];
        for (const { event: e, payloadJson } of chunk) {
          const b = evParams.length;
          evValues.push(`(${Array.from({ length: 14 }, (_, k) => (k === 12 ? `$${b + k + 1}::jsonb` : `$${b + k + 1}`)).join(', ')})`);
          evParams.push(
            e.eventId, e.runId, e.seq!, e.eventType, e.aggregateType, e.aggregateId, e.correlationId, e.causationId ?? null, e.actorId,
            e.workItemId ?? null, e.agentId ?? null, e.schemaVersion, payloadJson, e.occurredAt,
          );
          const subject = eventSubject(e.runId, e.eventType);
          const envelope: EventEnvelope = { eventId: e.eventId, subject, eventType: e.eventType, runId: e.runId, data: e, publishedAt: e.occurredAt };
          const o = obParams.length;
          obValues.push(`($${o + 1}, $${o + 2}, $${o + 3}::jsonb, $${o + 4})`);
          obParams.push(e.eventId, subject, JSON.stringify(envelope), now);
        }
        await q.query(
          `INSERT INTO ht_events (event_id, run_id, seq, event_type, aggregate_type, aggregate_id, correlation_id, causation_id, actor_id,
             work_item_id, agent_id, schema_version, payload, occurred_at) VALUES ${evValues.join(', ')}`,
          evParams,
        );
        await q.query(`INSERT INTO ht_outbox (event_id, subject, envelope, created_at) VALUES ${obValues.join(', ')}`, obParams);
      }
      return out as DomainEvent<unknown>[];
    });
  }

  const store: EventStore = {
    append,
    emit: (events, tx) => append(events, tx as SqlExecutor | undefined),

    async read(runId, options = {}) {
      const params: SqlParam[] = [runId, options.afterSeq ?? 0];
      let sql = `SELECT ${eventColumns()} FROM ht_events WHERE run_id = $1 AND seq > $2`;
      if (options.types && options.types.length > 0) {
        params.push(options.types);
        sql += ` AND event_type = ANY($${params.length})`;
      }
      sql += ' ORDER BY seq';
      if (options.limit !== undefined) {
        params.push(Math.max(0, Math.floor(options.limit)));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await db.query<EventRow>(sql, params);
      return r.rows.map(rowToEvent);
    },

    async get(eventId) {
      const r = await db.query<EventRow>(`SELECT ${eventColumns()} FROM ht_events WHERE event_id = $1`, [eventId]);
      return r.rows[0] ? rowToEvent(r.rows[0]) : undefined;
    },

    async lastSeq(runId) {
      const r = await db.query<{ last_seq: unknown }>('SELECT last_seq FROM ht_run_counters WHERE run_id = $1', [runId]);
      return r.rows[0] ? num(r.rows[0].last_seq) : 0;
    },

    async causalChain(eventId) {
      // Root first, the requested event last. Stops at a causationId that is not a recorded event; the depth
      // cap guards against a cycle created with explicit ids.
      const r = await db.query<EventRow & { depth: number }>(
        `WITH RECURSIVE chain AS (
           SELECT e.event_id, e.causation_id, 0 AS depth FROM ht_events e WHERE e.event_id = $1
           UNION ALL
           SELECT p.event_id, p.causation_id, c.depth + 1 FROM ht_events p JOIN chain c ON p.event_id = c.causation_id WHERE c.depth < $2
         )
         SELECT ${eventColumns('ev')}, chain.depth FROM chain JOIN ht_events ev ON ev.event_id = chain.event_id ORDER BY chain.depth`,
        [eventId, MAX_CHAIN_DEPTH],
      );
      const seen = new Set<string>();
      const chain: DomainEvent<unknown>[] = [];
      for (const row of r.rows) {
        if (seen.has(row.event_id)) break;
        seen.add(row.event_id);
        chain.push(rowToEvent(row));
      }
      return chain.reverse();
    },
  };
  return store;
}
