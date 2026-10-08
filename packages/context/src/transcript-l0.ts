import { HypertestError, sha256Hex, type JsonValue, type Logger, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import { eventFrom, type ChatMessage, type DomainEvent, type DomainEventInput } from '@hypertest/domain';
import type { Compaction, TranscriptEntry } from './contracts.ts';

/**
 * (B[8]) L0 is the root of context reconstruction (technology-selection §Context Engine: "L0 Event Store … 它是 Context
 * 重建的根"): every transcript entry an agent session commits — the task input, every model response, every tool result,
 * every queued input — is appended to the immutable event store (ht_events: UPDATE/DELETE/TRUNCATE refused by database
 * triggers) as `context.transcript_recorded`, IN THE SAME TRANSACTION as the session store write; every compaction is on L0 as
 * `context.compacted` with its summary. rebuildWorkingContext() reconstructs an agent's transcript and compactions from L0
 * alone.
 */
export const TRANSCRIPT_RECORDED_EVENT = 'context.transcript_recorded';
/** The L0 record of a compaction (written by the context provider in the transaction that stores it). */
export const COMPACTED_EVENT = 'context.compacted';

/** Deterministic id of the L0 event of a session's `ordinal`-th transcript entry (a retried write appends nothing twice). */
export function transcriptEventId(sessionId: string, ordinal: number): string {
  return `evt_tr_${sha256Hex(`transcript\u0000${sessionId}\u0000${ordinal}`).slice(0, 32)}`;
}

/** Structural view of the runtime SessionStore (the write paths that append transcript entries). */
export interface TranscriptSessionStore {
  create(record: { sessionId: string; runId: string; agentId: string } & Record<string, unknown>, initialTranscript?: TranscriptEntry[]): Promise<unknown>;
  get(sessionId: string): Promise<{ sessionId: string; runId: string; agentId: string } | undefined>;
  appendTranscript(sessionId: string, entries: TranscriptEntry[]): Promise<void>;
  transcript(sessionId: string): Promise<TranscriptEntry[]>;
  completeTurn(sessionId: string, turn: number, status: never, options?: never): Promise<void>;
  drainInputInto?(sessionId: string, turn: number, extra: ChatMessage[]): Promise<TranscriptEntry[]>;
}

/** Structural view of the L0 EventStore (@hypertest/collab). */
export interface TranscriptEventPort {
  append(events: DomainEventInput<unknown>[], tx?: SqlExecutor): Promise<DomainEvent<unknown>[]>;
  get(eventId: string): Promise<DomainEvent<unknown> | undefined>;
  read(runId: string, options?: { afterSeq?: number; limit?: number; types?: string[] }): Promise<DomainEvent<unknown>[]>;
}

export interface TranscriptL0Deps {
  db: SqlDatabase;
  events: TranscriptEventPort;
  logger: Logger;
}

/**
 * Wraps a SessionStore so that every transcript write (create with an initial transcript, appendTranscript, completeTurn with
 * appended entries, drainInputInto) also appends the entries it ADDED to L0, in one transaction with the write: the entries
 * are found as the transcript's growth inside that transaction (a no-op retry adds nothing), each with its per-session
 * ordinal and a deterministic event id. A failed L0 append rolls the session write back (the turn is retried), so the
 * session store never holds history L0 lacks.
 */
export function recordTranscriptOnL0<S extends TranscriptSessionStore>(sessions: S, deps: TranscriptL0Deps): S {
  const { db, events } = deps;
  const owners = new Map<string, { runId: string; agentId: string }>();

  async function owner(sessionId: string): Promise<{ runId: string; agentId: string }> {
    const known = owners.get(sessionId);
    if (known) return known;
    const s = await sessions.get(sessionId);
    if (!s) throw new HypertestError('not_found', `session ${sessionId} not found`);
    const o = { runId: s.runId, agentId: s.agentId };
    owners.set(sessionId, o);
    if (owners.size > 10_000) owners.delete(owners.keys().next().value!);
    return o;
  }

  async function record(tx: SqlExecutor, sessionId: string, before: number): Promise<void> {
    const all = await sessions.transcript(sessionId);
    if (all.length <= before) return;
    const { runId, agentId } = await owner(sessionId);
    const out: DomainEventInput<unknown>[] = [];
    for (let ordinal = before; ordinal < all.length; ordinal++) {
      const eventId = transcriptEventId(sessionId, ordinal);
      if (await events.get(eventId)) continue;
      const entry = all[ordinal]!;
      const e = eventFrom({ runId, correlationId: sessionId, actorId: agentId, agentId }, TRANSCRIPT_RECORDED_EVENT, 'session', sessionId, {
        sessionId, agentId, ordinal, turn: entry.turn, message: JSON.parse(JSON.stringify(entry.message)) as JsonValue,
      });
      out.push({ ...e, eventId } as DomainEventInput<unknown>);
    }
    if (out.length > 0) await events.append(out, tx);
  }

  /** Runs a transcript write and records its growth on L0, in one transaction. */
  function recorded<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const before = (await sessions.transcript(sessionId)).length;
      const result = await write();
      await record(tx, sessionId, before);
      return result;
    });
  }

  const wrapped = Object.create(sessions) as S;
  Object.assign(wrapped, {
    create: (rec: Parameters<S['create']>[0], initial?: TranscriptEntry[]) =>
      db.transaction(async (tx) => {
        const created = await sessions.create(rec, initial);
        owners.set(rec.sessionId, { runId: rec.runId, agentId: rec.agentId });
        if (initial && initial.length > 0) await record(tx, rec.sessionId, 0);
        return created;
      }),
    appendTranscript: (sessionId: string, entries: TranscriptEntry[]) => recorded(sessionId, () => sessions.appendTranscript(sessionId, entries)),
    completeTurn: (sessionId: string, turn: number, status: never, options?: never) => recorded(sessionId, () => sessions.completeTurn(sessionId, turn, status, options)),
  });
  if (typeof sessions.drainInputInto === 'function') {
    const drain = sessions.drainInputInto.bind(sessions);
    (wrapped as TranscriptSessionStore).drainInputInto = (sessionId: string, turn: number, extra: ChatMessage[]) => recorded(sessionId, () => drain(sessionId, turn, extra));
  }
  // every other method (reads, turns, compactions, inputs) is the store's own, bound to it
  for (const key of Object.getOwnPropertyNames(sessions) as Array<keyof S>) {
    if (Object.hasOwn(wrapped, key)) continue;
    const v = sessions[key];
    if (typeof v === 'function') (wrapped as Record<keyof S, unknown>)[key] = (v as (...a: unknown[]) => unknown).bind(sessions);
  }
  return wrapped;
}

/** A compaction as recorded on L0 (`context.compacted` payload with its summary). */
function compactionOf(p: Record<string, unknown>): Compaction | undefined {
  if (typeof p['compactionId'] !== 'string' || (p['level'] !== 'soft' && p['level'] !== 'hard') || typeof p['upToTurn'] !== 'number' || typeof p['summary'] !== 'string') return undefined;
  const c: Compaction = {
    compactionId: p['compactionId'],
    level: p['level'],
    upToTurn: p['upToTurn'],
    summary: p['summary'],
    evidenceRefs: Array.isArray(p['evidenceRefs']) ? p['evidenceRefs'].filter((x): x is string => typeof x === 'string') : [],
    createdAt: typeof p['createdAt'] === 'string' ? p['createdAt'] : '',
  };
  if (p['summaryArtifact'] && typeof p['summaryArtifact'] === 'object') c.summaryArtifact = p['summaryArtifact'] as Compaction['summaryArtifact'] & object;
  return c;
}

/**
 * (B[8]) Reconstructs one agent session's working context — its transcript and its compactions — from L0 events ONLY (no
 * session store): `context.transcript_recorded` events in ordinal order (a gap or a duplicate ordinal is an
 * integrity_violation: L0 must hold the whole history) and the `context.compacted` events of the session that carry their
 * summary. WorkingContextManager.view over the result is the agent's working view.
 */
export async function rebuildWorkingContext(events: Pick<TranscriptEventPort, 'read'>, runId: string, sessionId: string): Promise<{ transcript: TranscriptEntry[]; compactions: Compaction[] }> {
  const recorded = (await events.read(runId, { types: [TRANSCRIPT_RECORDED_EVENT] })).filter((e) => (e.payload as Record<string, unknown> | undefined)?.['sessionId'] === sessionId);
  const byOrdinal = new Map<number, TranscriptEntry>();
  for (const e of recorded) {
    const p = e.payload as Record<string, unknown>;
    const ordinal = p['ordinal'];
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new HypertestError('integrity_violation', `L0 transcript event ${e.eventId} has no valid ordinal`);
    if (byOrdinal.has(ordinal)) throw new HypertestError('integrity_violation', `L0 holds two transcript entries #${ordinal} of session ${sessionId}`);
    byOrdinal.set(ordinal, { turn: Number(p['turn']), message: p['message'] as ChatMessage });
  }
  const transcript: TranscriptEntry[] = [];
  for (let i = 0; i < byOrdinal.size; i++) {
    const entry = byOrdinal.get(i);
    if (!entry) throw new HypertestError('integrity_violation', `L0 misses transcript entry #${i} of session ${sessionId} (it holds ${byOrdinal.size})`);
    transcript.push(entry);
  }
  const compactions: Compaction[] = [];
  for (const e of await events.read(runId, { types: [COMPACTED_EVENT] })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p['sessionId'] !== sessionId) continue;
    const c = compactionOf(p);
    if (!c) throw new HypertestError('integrity_violation', `L0 compaction event ${e.eventId} of session ${sessionId} lacks its summary: the context cannot be rebuilt from L0`);
    compactions.push(c);
  }
  return { transcript, compactions };
}
