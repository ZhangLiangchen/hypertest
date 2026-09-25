import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import { eventSubject, sleep, type DeliveredEvent, type EventBus, type EventEnvelope } from '@hypertest/core';
import { infraEnv, skipUnless } from '@hypertest/testkit';
import { connectNatsEventBus, sanitizeDurableName, toWireSubject } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

const natsUrl = infraEnv().natsUrl;
const nats = skipUnless(natsUrl !== undefined, 'HYPERTEST_TEST_NATS_URL not set (run `npm run infra:up`)');

// A private stream + subject root per test file run: no interference with other suites sharing the server.
const suffix = randomBytes(4).toString('hex');
const stream = `HT_COLLAB_TEST_${suffix}`;
const subjectPrefix = `httest${suffix}`;
const buses: EventBus[] = [];

async function openBus(): Promise<EventBus> {
  const bus = await connectNatsEventBus({ servers: natsUrl!, stream, subjectPrefix, name: `collab-test-${suffix}` });
  buses.push(bus);
  return bus;
}

let n = 0;
function envelope(runId: string, eventType: string, eventId = `evt_${suffix}_${++n}`): EventEnvelope {
  return { eventId, subject: eventSubject(runId, eventType), eventType, runId, data: { eventId, payload: { n } }, publishedAt: '2026-01-01T00:00:00.000Z' };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

after(async () => {
  for (const b of buses) await b.close().catch(() => undefined);
  if (nats.skip) return;
  const nc = await connect({ servers: natsUrl! });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.streams.delete(stream).catch(() => undefined);
  } finally {
    await nc.close();
  }
});

test('subject helpers: durable names are sanitized, canonical subjects map onto the wire root', () => {
  assert.match(sanitizeDurableName('reactor.rca/finding created'), /^reactor_rca_finding_created_[0-9a-f]{10}$/);
  assert.equal(toWireSubject('ht.run_1.finding.created', 'ht'), 'ht.run_1.finding.created');
  assert.equal(toWireSubject('ht.*.finding.>', 'x1'), 'x1.*.finding.>');
  assert.equal(toWireSubject('>', 'x1'), 'x1.>');
  assert.throws(() => toWireSubject('other.run.x', 'x1'), /outside/);
});

test('nats: publish/subscribe round trip with filters; envelopes keep their canonical subject', nats, async () => {
  const bus = await openBus();
  assert.equal(bus.kind, 'nats');
  const runId = `rt${suffix}`;
  const seen: DeliveredEvent[] = [];
  await bus.subscribe({ durableName: `rt-${suffix}`, subjects: [`ht.${runId}.finding.>`], handler: async (e) => void seen.push(e) });
  const f = envelope(runId, 'finding.created');
  await bus.publish(f);
  await bus.publish(envelope(runId, 'work.created'));
  await bus.drain(5000);
  assert.deepEqual(seen, [{ ...f, deliveryCount: 1 }]);
});

test('nats: a throwing handler is redelivered with deliveryCount 2', nats, async () => {
  const bus = await openBus();
  const runId = `rd${suffix}`;
  const counts: number[] = [];
  await bus.subscribe({
    durableName: `rd-${suffix}`,
    subjects: [`ht.${runId}.>`],
    ackWaitMs: 300,
    handler: async (e) => {
      counts.push(e.deliveryCount);
      if (e.deliveryCount === 1) throw new Error('transient failure');
    },
  });
  await bus.publish(envelope(runId, 'finding.created'));
  await waitFor(() => counts.length >= 2);
  await bus.drain(5000);
  assert.deepEqual(counts, [1, 2]);
});

test('nats: two subscribers on one durable share the work, each message handled once', nats, async () => {
  const bus = await openBus();
  const runId = `qs${suffix}`;
  const perSub: string[][] = [[], []];
  for (const i of [0, 1]) {
    await bus.subscribe({
      durableName: `qs-${suffix}`,
      subjects: [`ht.${runId}.>`],
      handler: async (e) => {
        perSub[i]!.push(e.eventId);
        await sleep(15);
      },
    });
  }
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const e = envelope(runId, 'finding.created');
    ids.push(e.eventId);
    await bus.publish(e);
  }
  await waitFor(() => perSub[0]!.length + perSub[1]!.length >= 24, 10_000);
  await bus.drain(10_000);
  assert.deepEqual([...perSub[0]!, ...perSub[1]!].sort(), [...ids].sort());
  assert.ok(perSub[0]!.length > 0 && perSub[1]!.length > 0, `both subscribers got work (${perSub[0]!.length}/${perSub[1]!.length})`);
});

test('nats: a durable resumes after reconnect without redelivering acknowledged messages', nats, async () => {
  const runId = `du${suffix}`;
  const durableName = `du-${suffix}`;
  const first = await openBus();
  const seen1: string[] = [];
  await first.subscribe({ durableName, subjects: [`ht.${runId}.>`], handler: async (e) => void seen1.push(e.eventId) });
  const m1 = envelope(runId, 'finding.created');
  await first.publish(m1);
  await first.drain(5000);
  await first.close();

  const second = await openBus();
  const m2 = envelope(runId, 'finding.updated');
  await second.publish(m2);
  const seen2: string[] = [];
  await second.subscribe({ durableName, subjects: [`ht.${runId}.>`], handler: async (e) => void seen2.push(e.eventId) });
  await waitFor(() => seen2.length >= 1);
  await second.drain(5000);
  assert.deepEqual(seen1, [m1.eventId]);
  assert.deepEqual(seen2, [m2.eventId]);
});

test('nats: after maxDeliver failures the message is terminated and dead-lettered once', nats, async () => {
  const bus = await openBus();
  const runId = `dl${suffix}`;
  const dead: Array<{ eventId: string; deliveryCount: number }> = [];
  let calls = 0;
  await bus.subscribe({
    durableName: `dl-${suffix}`,
    subjects: [`ht.${runId}.>`],
    ackWaitMs: 200,
    maxDeliver: 2,
    handler: async () => {
      calls++;
      throw new Error('poison');
    },
    onDeadLetter: (e) => dead.push({ eventId: e.eventId, deliveryCount: e.deliveryCount }),
  });
  const m = envelope(runId, 'finding.created');
  await bus.publish(m);
  await waitFor(() => dead.length === 1);
  await bus.drain(5000);
  await sleep(300);
  assert.equal(calls, 2);
  assert.deepEqual(dead, [{ eventId: m.eventId, deliveryCount: 2 }]);
});

test('nats: publishes are deduplicated by eventId (msgID) inside the duplicate window', nats, async () => {
  const bus = await openBus();
  const runId = `dd${suffix}`;
  const seen: string[] = [];
  await bus.subscribe({ durableName: `dd-${suffix}`, subjects: [`ht.${runId}.>`], handler: async (e) => void seen.push(e.eventId) });
  const m = envelope(runId, 'finding.created');
  await bus.publish(m);
  await bus.publish(m);
  await bus.drain(5000);
  assert.deepEqual(seen, [m.eventId]);
});

test('nats: drain rejects with timeout while a handler is stuck; unsubscribe keeps the durable', nats, async () => {
  const bus = await openBus();
  const runId = `st${suffix}`;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const sub = await bus.subscribe({ durableName: `st-${suffix}`, subjects: [`ht.${runId}.>`], ackWaitMs: 10_000, handler: async (e) => { seen.push(e.eventId); await gate; } });
  await bus.publish(envelope(runId, 'finding.created'));
  await waitFor(() => seen.length === 1);
  await rejectsWith(bus.drain(150), 'timeout');
  release();
  await bus.drain(5000);
  await sub.unsubscribe();
  await rejectsWith(connectNatsEventBus({ servers: natsUrl!, stream: 'bad.name' }), 'invalid_argument');
  await rejectsWith(bus.subscribe({ durableName: `bad-${suffix}`, subjects: [`ht.${runId}.>`], maxDeliver: 0, handler: async () => undefined }), 'invalid_argument');
  await rejectsWith(bus.subscribe({ durableName: `bad-${suffix}`, subjects: [`ht.${runId}.>`], ackWaitMs: -1, handler: async () => undefined }), 'invalid_argument');
});

test('nats: re-subscribing a durable with a different filter and ack policy updates the consumer', nats, async () => {
  const bus = await openBus();
  const runId = `up${suffix}`;
  const durableName = `up-${suffix}`;
  const first: string[] = [];
  const sub = await bus.subscribe({ durableName, subjects: [`ht.${runId}.finding.>`], handler: async (e) => void first.push(e.eventType) });
  await bus.publish(envelope(runId, 'finding.created'));
  await waitFor(() => first.length === 1);
  await bus.drain(5000);
  await sub.unsubscribe();
  const second: string[] = [];
  await bus.subscribe({ durableName, subjects: [`ht.${runId}.work.>`, `ht.${runId}.finding.>`], ackWaitMs: 1000, maxDeliver: 3, handler: async (e) => void second.push(e.eventType) });
  await bus.publish(envelope(runId, 'work.created'));
  await bus.publish(envelope(runId, 'finding.updated'));
  await waitFor(() => second.length === 2);
  await bus.drain(5000);
  assert.deepEqual(first, ['finding.created']);
  assert.deepEqual(second, ['work.created', 'finding.updated']);
  const nc = await connect({ servers: natsUrl! });
  try {
    const info = await (await jetstreamManager(nc)).consumers.info(stream, durableName);
    assert.equal(info.config.max_deliver, 3);
    assert.equal(info.config.ack_wait, 1000 * 1_000_000);
    assert.deepEqual([...(info.config.filter_subjects ?? [])].sort(), [`${subjectPrefix}.${runId}.finding.>`, `${subjectPrefix}.${runId}.work.>`]);
  } finally {
    await nc.close();
  }
});

test('nats: connecting to an unreachable server fails with unavailable', async () => {
  await rejectsWith(connectNatsEventBus({ servers: 'nats://127.0.0.1:1', stream: `HT_UNREACHABLE_${suffix}` }), 'unavailable');
});

test('durable names that need rewriting never collide with each other or with a valid name', () => {
  const names = ['rca.finding', 'rca_finding', 'rca finding', 'rca/finding', 'rca*finding'];
  const sanitized = names.map(sanitizeDurableName);
  assert.equal(new Set(sanitized).size, names.length, `distinct durables stay distinct: ${sanitized.join(', ')}`);
  assert.equal(sanitizeDurableName('rca_finding'), 'rca_finding', 'valid names are kept verbatim');
  assert.equal(sanitizeDurableName('rca.finding'), sanitizeDurableName('rca.finding'), 'deterministic');
  assert.ok(sanitized.every((s) => /^[A-Za-z0-9_-]+$/.test(s)));
  assert.throws(() => sanitizeDurableName(''), /empty/);
});

test('nats: two durables whose names sanitize alike are still independent consumers (each gets every message)', nats, async () => {
  const bus = await openBus();
  const runId = `co${suffix}`;
  const a: string[] = [];
  const b: string[] = [];
  await bus.subscribe({ durableName: `co.${suffix}`, subjects: [`ht.${runId}.>`], handler: async (e) => void a.push(e.eventId) });
  await bus.subscribe({ durableName: `co_${suffix}`, subjects: [`ht.${runId}.>`], handler: async (e) => void b.push(e.eventId) });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e = envelope(runId, 'finding.created');
    ids.push(e.eventId);
    await bus.publish(e);
  }
  await waitFor(() => a.length >= 6 && b.length >= 6);
  await bus.drain(5000);
  assert.deepEqual([...a].sort(), [...ids].sort());
  assert.deepEqual([...b].sort(), [...ids].sort());
});
