import type { Migration, SqlDatabase, SqlExecutor } from '@hypertest/core';
import type { ArtifactRef, DomainEvent, DomainEventInput, DomainEventSink, EvidenceInput } from '@hypertest/domain';
import { evidenceMigrations } from '../src/index.ts';

/** Test-only table used by SqlEventSink to prove events are written in the ledger's transaction. */
export const testEventMigration: Migration = {
  id: 'evidence-test/001-events',
  sql: `CREATE TABLE IF NOT EXISTS test_evidence_events (
    event_id text PRIMARY KEY, run_id text NOT NULL, event_type text NOT NULL, actor_id text NOT NULL,
    correlation_id text NOT NULL, work_item_id text, agent_id text, causation_id text, payload jsonb NOT NULL)`,
};

export const migrations: Migration[] = [...evidenceMigrations, testEventMigration];

/** A DomainEventSink that writes into test_evidence_events using the transaction it is handed. */
export class SqlEventSink implements DomainEventSink {
  readonly #db: SqlDatabase;
  #n = 0;
  failNext = false;
  readonly txSeen: unknown[] = [];
  constructor(db: SqlDatabase) {
    this.#db = db;
  }
  async emit(events: DomainEventInput<unknown>[], tx?: unknown): Promise<DomainEvent<unknown>[]> {
    this.txSeen.push(tx);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sink failure (injected)');
    }
    const ex = (tx as SqlExecutor | undefined) ?? this.#db;
    const out: DomainEvent<unknown>[] = [];
    for (const e of events) {
      const eventId = e.eventId ?? `evt_test${String(++this.#n).padStart(6, '0')}`;
      await ex.query(
        `INSERT INTO test_evidence_events (event_id, run_id, event_type, actor_id, correlation_id, work_item_id, agent_id, causation_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [eventId, e.runId, e.eventType, e.actorId, e.correlationId, e.workItemId ?? null, e.agentId ?? null, e.causationId ?? null, JSON.stringify(e.payload)],
      );
      out.push({ ...e, eventId, schemaVersion: '1', occurredAt: '2026-01-01T00:00:00.000Z' });
    }
    return out;
  }
  async rows(runId: string): Promise<Array<{ event_type: string; actor_id: string; correlation_id: string; work_item_id: string | null; agent_id: string | null; causation_id: string | null; payload: unknown }>> {
    const res = await this.#db.query<{ event_type: string; actor_id: string; correlation_id: string; work_item_id: string | null; agent_id: string | null; causation_id: string | null; payload: unknown }>(
      'SELECT event_type, actor_id, correlation_id, work_item_id, agent_id, causation_id, payload FROM test_evidence_events WHERE run_id = $1 ORDER BY event_id',
      [runId],
    );
    return res.rows;
  }
}

export function evidenceInput(runId: string, artifact: ArtifactRef, extra: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    runId,
    evidenceType: 'test-result',
    artifact,
    summary: 'unit suite: 12 passed, 0 failed',
    producer: { workerId: 'worker-1', runtimeManifestId: 'rm_000001' },
    provenance: { toolId: 'test.run', command: ['node', '--test'] },
    ...extra,
  };
}

/**
 * Simulates an attacker with direct database access (e.g. a superuser) who first disables the
 * append-only triggers. Used only by tamper tests.
 */
export async function asAttacker(db: SqlDatabase, sql: string, params: unknown[] = []): Promise<number> {
  await db.query('ALTER TABLE ht_evidence DISABLE TRIGGER USER');
  await db.query('ALTER TABLE ht_evidence_seals DISABLE TRIGGER USER');
  try {
    const res = await db.query(sql, params as never);
    return res.rowCount;
  } finally {
    await db.query('ALTER TABLE ht_evidence ENABLE TRIGGER USER');
    await db.query('ALTER TABLE ht_evidence_seals ENABLE TRIGGER USER');
  }
}
