import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromJsonColumn, type Migration, type SqlDatabase } from '@hypertest/core';
import { EVENT_SCHEMA_VERSION, type DomainEvent, type DomainEventInput, type DomainEventSink } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, infraEnv, skipUnless, testDeps } from '@hypertest/testkit';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type RouteDecision } from '../src/index.ts';
import { profile, routeRequest } from './helpers.ts';

/**
 * I10 portability check: every model.* event payload produced by the router must be storable as jsonb in
 * an append-only L0-like table on PGlite AND PostgreSQL 16 and read back unchanged, with full correlation.
 * (The real event store lives in @hypertest/collab; this test-only table mirrors its shape.)
 */
const TEST_MIGRATIONS: Migration[] = [
  {
    id: 'model/900-test-l0-events',
    sql: `CREATE TABLE ht_model_test_events (
      event_id text PRIMARY KEY,
      run_id text NOT NULL,
      seq bigint NOT NULL,
      event_type text NOT NULL,
      aggregate_id text NOT NULL,
      correlation_id text NOT NULL,
      causation_id text,
      agent_id text,
      work_item_id text,
      payload jsonb NOT NULL,
      UNIQUE (run_id, seq)
    )`,
  },
];

class SqlEventSink implements DomainEventSink {
  readonly #db: SqlDatabase;
  #n = 0;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }
  async emit(events: DomainEventInput<unknown>[]): Promise<DomainEvent<unknown>[]> {
    const out: DomainEvent<unknown>[] = [];
    for (const e of events) {
      const eventId = e.eventId ?? `${e.runId}:evt_${String(++this.#n).padStart(6, '0')}`;
      const { rows } = await this.#db.query<{ seq: number }>(
        `INSERT INTO ht_model_test_events (event_id, run_id, seq, event_type, aggregate_id, correlation_id, causation_id, agent_id, work_item_id, payload)
         VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ht_model_test_events WHERE run_id = $2), $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING seq`,
        [eventId, e.runId, e.eventType, e.aggregateId, e.correlationId, e.causationId ?? null, e.agentId ?? null, e.workItemId ?? null, JSON.stringify(e.payload)],
      );
      out.push({ ...e, eventId, seq: Number(rows[0]!.seq), schemaVersion: EVENT_SCHEMA_VERSION, occurredAt: new Date(0).toISOString() });
    }
    return out;
  }
}

async function scenario(db: SqlDatabase, runId: string): Promise<void> {
  const sink = new SqlEventSink(db);
  const primary = new ScriptedProvider({ providerId: 'pa', brain: () => ({ error: 'unavailable', message: 'down' }) });
  const secondary = new ScriptedProvider({ providerId: 'pb', brain: () => ({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } }) });
  const router = createModelRouter({
    ...testDeps(),
    catalog: new ModelCatalog([
      profile({ routeId: 'primary', provider: 'pa', quality: { default: 0.9 } }),
      profile({ routeId: 'secondary', provider: 'pb', quality: { default: 0.8 } }),
      profile({ routeId: 'cloud_only', provider: 'pb', maxDataClassification: 'internal' }),
    ]),
    providers: new ProviderRegistry([primary, secondary]),
    events: sink,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
  });
  const ctx = eventCtx(runId, { correlationId: `corr_${runId}`, causationId: 'evt_parent', agentId: 'agt_x', workItemId: 'wi_x' });
  const rq = routeRequest({ runId, agentId: 'agt_x', dataClassification: 'confidential', contextSnapshotId: `ctx_${runId}` });
  const d1 = (await router.route(rq, ctx)) as Extract<RouteDecision, { ok: true }>;
  assert.equal(d1.routeId, 'primary');
  const failed = await router.invoke({ decision: d1, call: { messages: [{ role: 'user', content: 'go' }] }, ctx }, rq);
  assert.equal(failed.ok, false);
  const fb = failed.ok ? undefined : failed.fallback;
  assert.equal(fb?.routeId, 'secondary');
  const next = await router.invoke({ decision: fb!, call: { messages: [{ role: 'user', content: 'go' }] }, ctx }, { ...rq, excludeRoutes: ['primary'] });
  assert.equal(next.ok, true);
}

async function assertAuditTrail(db: SqlDatabase, runId: string): Promise<void> {
  const { rows } = await db.query<{ seq: unknown; event_type: string; aggregate_id: string; correlation_id: string; causation_id: string; agent_id: string; work_item_id: string; payload: unknown }>(
    `SELECT seq, event_type, aggregate_id, correlation_id, causation_id, agent_id, work_item_id, payload FROM ht_model_test_events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  assert.deepEqual(rows.map((r) => [Number(r.seq), r.event_type]), [
    [1, 'model.routed'],
    [2, 'model.invoked'],
    [3, 'model.routed'],
    [4, 'model.fallback'],
    [5, 'model.invoked'],
  ]);
  for (const r of rows) {
    assert.equal(r.correlation_id, `corr_${runId}`);
    assert.equal(r.causation_id, 'evt_parent');
    assert.equal(r.agent_id, 'agt_x');
    assert.equal(r.work_item_id, 'wi_x');
    assert.equal(r.aggregate_id, 'agt_x');
  }
  const payloads = rows.map((r) => fromJsonColumn<Record<string, unknown>>(r.payload));
  assert.deepEqual(payloads[0]!['rejected'], [{ routeId: 'cloud_only', stage: 'security', reason: 'route accepts data up to internal; request carries confidential' }]);
  assert.deepEqual(payloads[1], {
    ok: false,
    routeId: 'primary',
    provider: 'pa',
    model: 'primary-model',
    snapshotId: `ctx_${runId}`,
    attempts: 2,
    error: { code: 'unavailable', message: 'down', retryable: true },
    latencyMs: 0,
  });
  assert.deepEqual(payloads[3], { from: 'primary', to: 'secondary', reason: 'unavailable', policy: 'revalidated', excludeRoutes: ['primary'], snapshotId: `ctx_${runId}` });
  assert.equal(payloads[4]!['ok'], true);
  assert.deepEqual(payloads[4]!['usage'], { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: (10 * 1 + 5 * 4) / 1e6 });
}

test('I10: model routing/invocation/fallback audit trail round-trips through jsonb (default test database)', async () => {
  const { db, dispose } = await createTestDatabase({ migrations: TEST_MIGRATIONS });
  try {
    await scenario(db, 'run_int_a');
    await scenario(db, 'run_int_b');
    await assertAuditTrail(db, 'run_int_a');
    await assertAuditTrail(db, 'run_int_b');
  } finally {
    await dispose();
  }
});

const pgUrl = process.env['HYPERTEST_TEST_PG_URL'] ?? infraEnv().pgUrl;
test('I10: model audit trail round-trips through jsonb on PostgreSQL 16', skipUnless(!!pgUrl, 'HYPERTEST_TEST_PG_URL not set (run `npm run infra:up`)'), async () => {
  process.env['HYPERTEST_TEST_PG_URL'] ??= pgUrl;
  const { db, dispose } = await createTestDatabase({ kind: 'postgres', migrations: TEST_MIGRATIONS });
  try {
    assert.equal(db.kind, 'postgres');
    await scenario(db, 'run_pg');
    await assertAuditTrail(db, 'run_pg');
  } finally {
    await dispose();
  }
});
