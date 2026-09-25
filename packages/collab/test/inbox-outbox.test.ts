import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLogger, sleep, type EventBus, type EventEnvelope, type SqlDatabase } from '@hypertest/core';
import type { DomainEventInput } from '@hypertest/domain';
import { InProcessEventBus, createOutboxRelay } from '../src/index.ts';
import { count, openEnv, rejectsWith, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

function ev(runId: string, eventType: string): DomainEventInput<unknown> {
  return { eventType, aggregateType: 'run', aggregateId: runId, runId, correlationId: runId, actorId: 'system:test', payload: {} };
}

/** A bus that records every publish; optional faults per call. */
class RecordingBus implements EventBus {
  readonly kind = 'inprocess' as const;
  readonly published: EventEnvelope[] = [];
  /** Throws on the given publish call numbers (1-based) BEFORE recording (publish never happened). */
  failBefore = new Set<number>();
  /** Records, then throws on the given call numbers (the process "crashes" after publishing, before marking sent). */
  crashAfter = new Set<number>();
  #calls = 0;
  async publish(event: EventEnvelope): Promise<void> {
    const call = ++this.#calls;
    if (this.failBefore.has(call)) throw new Error(`broker unavailable (call ${call})`);
    this.published.push(event);
    if (this.crashAfter.has(call)) throw new Error(`crash after publish (call ${call})`);
  }
  async subscribe(): Promise<never> {
    throw new Error('not used');
  }
  async drain(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Isolates tests sharing one database: marks every earlier outbox row as sent. */
async function settleOutbox(): Promise<void> {
  await env.db.query("UPDATE ht_outbox SET sent_at = '2026-01-01T00:00:00Z' WHERE sent_at IS NULL");
}

test('inbox: first tryConsume wins, duplicates return false, consumers are independent', async () => {
  assert.equal(await env.inbox.tryConsume('rca', 'evt_i1'), true);
  assert.equal(await env.inbox.tryConsume('rca', 'evt_i1'), false);
  assert.equal(await env.inbox.tryConsume('designer', 'evt_i1'), true);
  assert.equal(await env.inbox.consumed('rca', 'evt_i1'), true);
  assert.equal(await env.inbox.consumed('rca', 'evt_i2'), false);
  await rejectsWith(env.inbox.tryConsume('', 'evt_i1'), 'invalid_argument');
});

test('inbox: a consume inside a rolled-back handler transaction is undone, so the redelivery is processed', async () => {
  await assert.rejects(
    env.db.transaction(async (tx) => {
      assert.equal(await env.inbox.tryConsume('rca', 'evt_i3', tx), true);
      throw new Error('side effect failed');
    }),
  );
  assert.equal(await env.inbox.consumed('rca', 'evt_i3'), false);
  assert.equal(await env.inbox.tryConsume('rca', 'evt_i3'), true);
});

test('relay publishes unsent rows in outbox order, marks them sent and reports pending', async () => {
  await settleOutbox();
  const bus = new RecordingBus();
  const relay = createOutboxRelay({ ...env.deps, bus, batchSize: 2 });
  const written = await env.events.append([ev('ob-1', 'a'), ev('ob-1', 'b'), ev('ob-2', 'c'), ev('ob-1', 'd'), ev('ob-2', 'e')]);
  assert.equal(await relay.pending(), 5);
  assert.equal(await relay.flush(), 5);
  assert.deepEqual(bus.published.map((e) => e.eventId), written.map((e) => e.eventId));
  assert.deepEqual(bus.published[0]!.data, written[0]);
  assert.equal(await relay.pending(), 0);
  assert.equal(await relay.flush(), 0);
  assert.equal(bus.published.length, 5);
});

test('crash between publish and mark ⇒ the same eventId is republished on the next flush (at-least-once)', async () => {
  await settleOutbox();
  const bus = new RecordingBus();
  bus.crashAfter.add(2);
  const relay = createOutboxRelay({ ...env.deps, bus });
  const written = await env.events.append([ev('ob-3', 'a'), ev('ob-3', 'b'), ev('ob-3', 'c')]);
  await assert.rejects(relay.flush(), /crash after publish/);
  assert.equal(await relay.pending(), 2, 'the published-but-unmarked row and everything after it stay unsent');
  assert.equal(await relay.flush(), 2);
  assert.deepEqual(bus.published.map((e) => e.eventId), [written[0]!.eventId, written[1]!.eventId, written[1]!.eventId, written[2]!.eventId]);
  assert.equal(await relay.pending(), 0);
});

test('a publish failure stops the flush at that row so later rows are never published ahead of it', async () => {
  await settleOutbox();
  const bus = new RecordingBus();
  bus.failBefore.add(2);
  const relay = createOutboxRelay({ ...env.deps, bus });
  const written = await env.events.append([ev('ob-4', 'a'), ev('ob-4', 'b'), ev('ob-4', 'c')]);
  await assert.rejects(relay.flush(), /broker unavailable/);
  assert.deepEqual(bus.published.map((e) => e.eventId), [written[0]!.eventId]);
  assert.equal(await relay.flush(), 2);
  assert.deepEqual(bus.published.map((e) => e.eventId), written.map((e) => e.eventId));
});

test('start() polls in the background, logs failures and keeps retrying; stop() waits for the in-flight flush', async () => {
  await settleOutbox();
  const logger = new MemoryLogger();
  const bus = new RecordingBus();
  bus.failBefore.add(1);
  const relay = createOutboxRelay({ ...env.deps, logger, bus, pollMs: 5 });
  const [e] = await env.events.append([ev('ob-5', 'a')]);
  relay.start();
  relay.start(); // idempotent
  for (let i = 0; i < 200 && bus.published.length === 0; i++) await sleep(5);
  await relay.stop();
  assert.deepEqual(bus.published.map((x) => x.eventId), [e!.eventId]);
  assert.ok(logger.entries.some((l) => l.level === 'warn' && l.msg.includes('outbox relay flush failed')));
  assert.equal(await relay.pending(), 0);
  // Stopped: nothing is published any more.
  await env.events.append([ev('ob-5', 'b')]);
  await sleep(30);
  assert.equal(bus.published.length, 1);
});

test('relay rejects invalid configuration', () => {
  const bus = new InProcessEventBus();
  assert.throws(() => createOutboxRelay({ ...env.deps, bus, batchSize: 0 }), /batchSize/);
  assert.throws(() => createOutboxRelay({ ...env.deps, bus, pollMs: 0 }), /pollMs/);
});

test('sent rows keep their sent_at; unsent count matches the table', async () => {
  await settleOutbox();
  await env.events.append([ev('ob-6', 'a'), ev('ob-6', 'b')]);
  const relay = createOutboxRelay({ ...env.deps, bus: new RecordingBus() });
  assert.equal(await relay.pending(), await count(env.db, 'SELECT count(*) AS n FROM ht_outbox WHERE sent_at IS NULL'));
  await relay.flush();
  assert.equal(await count(env.db, "SELECT count(*) AS n FROM ht_outbox WHERE envelope->>'runId' = 'ob-6' AND sent_at IS NOT NULL"), 2);
});

test('stop() then start() while a flush is in flight leaves exactly one poll loop; nothing polls after the final stop()', async () => {
  await settleOutbox();
  let polls = 0;
  let stopped = false;
  let pollsAfterStop = 0;
  const db: SqlDatabase = {
    kind: env.db.kind,
    query: (sql, params) => {
      if (sql.includes('FROM ht_outbox WHERE sent_at IS NULL ORDER BY id')) {
        polls++;
        if (stopped) pollsAfterStop++;
      }
      return env.db.query(sql, params);
    },
    transaction: (fn) => env.db.transaction(fn),
    close: () => env.db.close(),
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inPublish = new Promise<void>((r) => (entered = r));
  const bus = new RecordingBus();
  const gated: EventBus = { kind: 'inprocess', publish: async (e) => { if (bus.published.length === 0) { entered(); await gate; } await bus.publish(e); }, subscribe: () => bus.subscribe(), drain: () => bus.drain(), close: () => bus.close() };
  const relay = createOutboxRelay({ ...env.deps, db, bus: gated, pollMs: 2 });
  await env.events.append([ev('ob-7', 'a')]);
  relay.start();
  await inPublish; // the first poll loop is inside flush()
  const stopping = relay.stop();
  relay.start(); // restart while that flush is still in flight
  release();
  await stopping;
  const pollsBefore = polls;
  await sleep(40);
  assert.ok(polls > pollsBefore, 'the restarted relay polls');
  await relay.stop();
  stopped = true;
  await sleep(60);
  assert.equal(pollsAfterStop, 0, 'no poll loop survived stop()');
  assert.equal(bus.published.length, 1);
});
