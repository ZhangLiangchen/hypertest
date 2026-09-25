import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventSubject, type EventEnvelope } from '@hypertest/core';
import { EVENT_SCHEMA_VERSION, type DomainEventInput } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { count, finding, openEnv, rejectsWith, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

function ev(runId: string, eventType: string, overrides: Partial<DomainEventInput<unknown>> = {}): DomainEventInput<unknown> {
  return { eventType, aggregateType: 'run', aggregateId: runId, runId, correlationId: `corr-${runId}`, actorId: 'system:test', payload: { n: 1 }, ...overrides };
}

async function outboxFor(runId: string): Promise<Array<{ event_id: string; subject: string; envelope: EventEnvelope }>> {
  const r = await env.db.query<{ event_id: string; subject: string; envelope: EventEnvelope }>(
    "SELECT event_id, subject, envelope FROM ht_outbox WHERE envelope->>'runId' = $1 ORDER BY id",
    [runId],
  );
  return r.rows;
}

test('append assigns eventId, per-run seq, occurredAt and schemaVersion; read/get/lastSeq return them', async () => {
  const out = await env.events.append([ev('es-1', 'run.created'), ev('es-1', 'run.started', { causationId: 'x', workItemId: 'wi-1', agentId: 'ag-1' })]);
  assert.deepEqual(out.map((e) => e.seq), [1, 2]);
  assert.ok(out.every((e) => /^evt_\d{6}$/.test(e.eventId)));
  assert.ok(out.every((e) => e.schemaVersion === EVENT_SCHEMA_VERSION && e.occurredAt === '2026-01-01T00:00:00.000Z'));
  assert.equal(out[1]!.workItemId, 'wi-1');
  assert.equal(out[1]!.agentId, 'ag-1');
  assert.deepEqual(await env.events.read('es-1'), out);
  assert.deepEqual(await env.events.get(out[1]!.eventId), out[1]);
  assert.equal(await env.events.lastSeq('es-1'), 2);
  assert.equal(await env.events.lastSeq('es-unknown'), 0);
  assert.equal(await env.events.get('evt_missing'), undefined);
});

test('read filters by afterSeq, types and limit, ordered by seq', async () => {
  await env.events.append([ev('es-2', 'a.x'), ev('es-2', 'b.y'), ev('es-2', 'a.x'), ev('es-2', 'c.z')]);
  assert.deepEqual((await env.events.read('es-2', { afterSeq: 2 })).map((e) => e.seq), [3, 4]);
  assert.deepEqual((await env.events.read('es-2', { types: ['a.x', 'c.z'] })).map((e) => e.seq), [1, 3, 4]);
  assert.deepEqual((await env.events.read('es-2', { limit: 2 })).map((e) => e.seq), [1, 2]);
});

test('every event gets one outbox row: subject ht.<run>.<type>, envelope data = the full event', async () => {
  const [e] = await env.events.append([ev('es-3', 'finding.created', { payload: { recordId: 'rec_1', severity: 'P1' } })]);
  const rows = await outboxFor('es-3');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event_id, e!.eventId);
  assert.equal(rows[0]!.subject, eventSubject('es-3', 'finding.created'));
  assert.equal(rows[0]!.subject, 'ht.es-3.finding.created');
  assert.deepEqual(rows[0]!.envelope.data, e);
  assert.equal(rows[0]!.envelope.eventType, 'finding.created');
});

test('gap-free seq under 30 concurrent appends across 2 runs', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => env.events.append([ev(i % 2 === 0 ? 'es-c1' : 'es-c2', 'tick', { payload: { i } })])));
  for (const runId of ['es-c1', 'es-c2']) {
    const seqs = results.flat().filter((e) => e.runId === runId).map((e) => e.seq!).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepEqual((await env.events.read(runId)).map((e) => e.seq), seqs);
    assert.equal(await env.events.lastSeq(runId), 15);
    assert.equal((await outboxFor(runId)).length, 15);
  }
});

test('a batch spanning two runs gets independent per-run sequences in input order', async () => {
  const out = await env.events.append([ev('es-m1', 'a'), ev('es-m2', 'a'), ev('es-m1', 'b'), ev('es-m2', 'b'), ev('es-m1', 'c')]);
  assert.deepEqual(out.map((e) => `${e.runId}:${e.seq}:${e.eventType}`), ['es-m1:1:a', 'es-m2:1:a', 'es-m1:2:b', 'es-m2:2:b', 'es-m1:3:c']);
});

test('rollback: an append inside a failed transaction leaves neither events nor outbox rows, and seq stays gap-free', async () => {
  await env.events.append([ev('es-rb', 'first')]);
  await assert.rejects(
    env.db.transaction(async (tx) => {
      await env.events.append([ev('es-rb', 'doomed'), ev('es-rb', 'doomed')], tx);
      throw new Error('state change failed after the events were written');
    }),
    /state change failed/,
  );
  assert.deepEqual((await env.events.read('es-rb')).map((e) => e.eventType), ['first']);
  assert.equal((await outboxFor('es-rb')).length, 1);
  assert.equal(await env.events.lastSeq('es-rb'), 1);
  const [next] = await env.events.append([ev('es-rb', 'second')]);
  assert.equal(next!.seq, 2);
});

test('outbox is written in the same transaction as the state change: a failing blackboard tx leaves no trace', async () => {
  const ctx = eventCtx('es-tx');
  const before = await env.board.revision('es-tx');
  await assert.rejects(
    env.db.transaction(async (tx) => {
      await env.board.postRecord({ runId: 'es-tx', recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, ctx, tx);
      throw new Error('crash before commit');
    }),
    /crash before commit/,
  );
  assert.equal(await count(env.db, "SELECT count(*) AS n FROM ht_records WHERE run_id = 'es-tx'"), 0);
  assert.equal((await env.events.read('es-tx')).length, 0);
  assert.equal((await outboxFor('es-tx')).length, 0);
  assert.equal(await env.board.revision('es-tx'), before);
});

test('explicit eventId: re-append is idempotent (same seq, no second outbox row); reuse for another event is a conflict', async () => {
  const [a] = await env.events.append([ev('es-id', 'work.created', { eventId: 'evt_fixed_1', aggregateId: 'wi-1' })]);
  const [again] = await env.events.append([ev('es-id', 'work.created', { eventId: 'evt_fixed_1', aggregateId: 'wi-1' })]);
  assert.deepEqual(again, a);
  assert.equal(await env.events.lastSeq('es-id'), 1);
  assert.equal((await outboxFor('es-id')).length, 1);
  const err = await rejectsWith(env.events.append([ev('es-id', 'work.failed', { eventId: 'evt_fixed_1', aggregateId: 'wi-1' })]), 'conflict');
  assert.equal(err.details['eventId'], 'evt_fixed_1');
  assert.equal(await env.events.lastSeq('es-id'), 1);
});

test('invalid input is rejected before anything is written', async () => {
  await rejectsWith(env.events.append([ev('es-bad', 'a', { eventId: 'evt_dup' }), ev('es-bad', 'b', { eventId: 'evt_dup' })]), 'invalid_argument');
  await rejectsWith(env.events.append([ev('es-bad', 'a', { actorId: '' })]), 'invalid_argument');
  await rejectsWith(env.events.append([ev('', 'a')]), 'invalid_argument');
  await rejectsWith(env.events.append([ev('es-bad', 'a', { occurredAt: 'not-a-date' })]), 'invalid_argument');
  assert.equal(await env.events.lastSeq('es-bad'), 0);
  assert.deepEqual(await env.events.append([]), []);
});

test('explicit occurredAt is kept in canonical ISO form', async () => {
  const [e] = await env.events.append([ev('es-ts', 'a', { occurredAt: '2026-03-04T05:06:07Z' })]);
  assert.equal(e!.occurredAt, '2026-03-04T05:06:07.000Z');
  assert.equal((await env.events.get(e!.eventId))!.occurredAt, '2026-03-04T05:06:07.000Z');
});

test('emit() is the DomainEventSink alias of append and honours the transaction', async () => {
  await assert.rejects(
    env.db.transaction(async (tx) => {
      await env.events.emit([ev('es-emit', 'a')], tx);
      throw new Error('rollback');
    }),
  );
  assert.equal(await env.events.lastSeq('es-emit'), 0);
  const [e] = await env.events.emit([ev('es-emit', 'a')]);
  assert.equal(e!.seq, 1);
});

test('causalChain walks causationId back to the root (root first)', async () => {
  const [root] = await env.events.append([ev('es-cause', 'finding.created')]);
  const [mid] = await env.events.append([ev('es-cause', 'work.created', { causationId: root!.eventId })]);
  const [leaf] = await env.events.append([ev('es-cause', 'hypothesis.created', { causationId: mid!.eventId })]);
  assert.deepEqual((await env.events.causalChain(leaf!.eventId)).map((e) => e.eventId), [root!.eventId, mid!.eventId, leaf!.eventId]);
  assert.deepEqual((await env.events.causalChain(root!.eventId)).map((e) => e.eventId), [root!.eventId]);
  assert.deepEqual(await env.events.causalChain('evt_unknown'), []);
});

test('causalChain stops at a causationId that is not a recorded event and terminates on cycles', async () => {
  const [orphan] = await env.events.append([ev('es-cause2', 'a', { causationId: 'wi-not-an-event' })]);
  assert.deepEqual((await env.events.causalChain(orphan!.eventId)).map((e) => e.eventId), [orphan!.eventId]);
  await env.events.append([ev('es-cause2', 'x', { eventId: 'evt_cyc_a', causationId: 'evt_cyc_b' }), ev('es-cause2', 'y', { eventId: 'evt_cyc_b', causationId: 'evt_cyc_a' })]);
  assert.deepEqual((await env.events.causalChain('evt_cyc_a')).map((e) => e.eventId), ['evt_cyc_b', 'evt_cyc_a']);
});

test('payloads of every JSON type round-trip; a string payload never makes the run L0 unreadable', async () => {
  const payloads: unknown[] = ['plain text', '{"looks":"like json"}', '42', 7, null, [1, 'two'], { nested: { ok: true } }, true];
  const written = await env.events.append(payloads.map((payload, i) => ev('es-json', `t${i}`, { payload })));
  assert.deepEqual(written.map((e) => e.payload), payloads);
  const read = await env.events.read('es-json');
  assert.deepEqual(read.map((e) => e.payload), payloads, 'read returns every payload exactly as appended');
  assert.deepEqual(read, written);
  assert.equal((await env.events.get(written[1]!.eventId))!.payload, '{"looks":"like json"}', 'a JSON-looking string stays a string');
  const [child] = await env.events.append([ev('es-json', 'child', { causationId: written[0]!.eventId, payload: 'caused' })]);
  assert.deepEqual((await env.events.causalChain(child!.eventId)).map((e) => e.payload), ['plain text', 'caused']);
  // The outbox envelope carries the same payload.
  const rows = await outboxFor('es-json');
  assert.equal((rows[0]!.envelope.data as { payload: unknown }).payload, 'plain text');
});

test('passing the database itself as tx still writes atomically (it is not an autocommit loophole)', async () => {
  const runId = 'es-dbtx';
  // actorId '' makes the event append fail AFTER the record row was written in the same unit of work.
  await rejectsWith(
    env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, eventCtx(runId, { actorId: '' }), env.db),
    'invalid_argument',
  );
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_records WHERE run_id = $1', [runId]), 0, 'the record rolled back with the failed event');
  assert.equal(await env.board.revision(runId), 0);
  assert.equal(await env.events.lastSeq(runId), 0);
  const [e] = await env.events.append([ev(runId, 'ok')], env.db);
  assert.equal(e!.seq, 1);
});
