import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, MemoryLogger, eventSubject, sleep, type DeliveredEvent, type EventEnvelope } from '@hypertest/core';
import { InProcessEventBus } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

let n = 0;
function envelope(runId: string, eventType: string, eventId = `evt_${++n}`): EventEnvelope {
  return { eventId, subject: eventSubject(runId, eventType), eventType, runId, data: { eventId, payload: { n } }, publishedAt: '2026-01-01T00:00:00.000Z' };
}

function recorder(): { seen: DeliveredEvent[]; handler: (e: DeliveredEvent) => Promise<void> } {
  const seen: DeliveredEvent[] = [];
  return { seen, handler: async (e) => void seen.push(e) };
}

test('delivers matching subjects with deliveryCount 1 and a private copy of the envelope', async () => {
  const bus = new InProcessEventBus();
  const a = recorder();
  const b = recorder();
  await bus.subscribe({ durableName: 'findings', subjects: ['ht.*.finding.>'], handler: a.handler });
  await bus.subscribe({ durableName: 'all-run1', subjects: ['ht.r1.>'], handler: b.handler });
  const e1 = envelope('r1', 'finding.created');
  await bus.publish(e1);
  await bus.publish(envelope('r2', 'finding.updated'));
  await bus.publish(envelope('r1', 'work.created'));
  await bus.drain(1000);
  assert.deepEqual(a.seen.map((e) => e.subject), ['ht.r1.finding.created', 'ht.r2.finding.updated']);
  assert.deepEqual(b.seen.map((e) => e.eventType), ['finding.created', 'work.created']);
  assert.deepEqual(a.seen[0], { ...e1, deliveryCount: 1 });
  assert.notEqual(a.seen[0]!.data, b.seen[0]!.data, 'each consumer gets its own copy');
  await bus.close();
});

test('a new durable consumer starts from the beginning of the stream (deliver policy all)', async () => {
  const bus = new InProcessEventBus();
  await bus.publish(envelope('r3', 'finding.created', 'evt_old_1'));
  await bus.publish(envelope('r3', 'work.created', 'evt_old_2'));
  await bus.publish(envelope('r3', 'finding.updated', 'evt_old_3'));
  const late = recorder();
  await bus.subscribe({ durableName: 'late', subjects: ['ht.*.finding.*'], handler: late.handler });
  await bus.drain(1000);
  assert.deepEqual(late.seen.map((e) => e.eventId), ['evt_old_1', 'evt_old_3']);
  assert.equal(bus.streamLength, 3);
  await bus.close();
});

test('queue semantics: subscribers sharing a durable split the messages; each message is handled exactly once', async () => {
  const bus = new InProcessEventBus();
  const perSub: string[][] = [[], []];
  for (const i of [0, 1]) {
    await bus.subscribe({
      durableName: 'rca',
      subjects: ['ht.>'],
      handler: async (e) => {
        perSub[i]!.push(e.eventId);
        await sleep(2);
      },
    });
  }
  const other = recorder();
  await bus.subscribe({ durableName: 'designer', subjects: ['ht.>'], handler: other.handler });
  for (let i = 0; i < 20; i++) await bus.publish(envelope('r4', 'finding.created', `evt_q_${i}`));
  await bus.drain(2000);
  const all = [...perSub[0]!, ...perSub[1]!].sort();
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
  assert.ok(perSub[0]!.length > 0 && perSub[1]!.length > 0, `both subscribers got work (${perSub[0]!.length}/${perSub[1]!.length})`);
  assert.equal(other.seen.length, 20, 'an independent durable receives every message');
  await bus.close();
});

test('a single subscriber receives messages in stream order', async () => {
  const bus = new InProcessEventBus();
  const r = recorder();
  await bus.subscribe({ durableName: 'ordered', subjects: ['ht.>'], handler: async (e) => { await sleep(1); await r.handler(e); } });
  const ids = Array.from({ length: 10 }, (_, i) => `evt_o_${i}`);
  for (const id of ids) await bus.publish(envelope('r5', 'x.y', id));
  await bus.drain(2000);
  assert.deepEqual(r.seen.map((e) => e.eventId), ids);
  await bus.close();
});

test('a throwing handler is redelivered with an incremented deliveryCount until it succeeds', async () => {
  const bus = new InProcessEventBus();
  const counts: number[] = [];
  await bus.subscribe({
    durableName: 'flaky',
    subjects: ['ht.>'],
    ackWaitMs: 5,
    handler: async (e) => {
      counts.push(e.deliveryCount);
      if (e.deliveryCount < 3) throw new Error('transient');
    },
  });
  await bus.publish(envelope('r6', 'finding.created'));
  await bus.drain(1000);
  assert.deepEqual(counts, [1, 2, 3]);
  await bus.close();
});

test('a handler that exceeds ackWait is redelivered (deliveryCount 2) while the slow attempt is still running', async () => {
  const bus = new InProcessEventBus();
  const counts: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  for (let i = 0; i < 2; i++) {
    await bus.subscribe({
      durableName: 'slow',
      subjects: ['ht.>'],
      ackWaitMs: 20,
      handler: async (e) => {
        counts.push(e.deliveryCount);
        if (e.deliveryCount === 1) await gate;
      },
    });
  }
  await bus.publish(envelope('r7', 'finding.created'));
  await sleep(60);
  assert.deepEqual(counts, [1, 2]);
  await rejectsWith(bus.drain(10), 'timeout');
  release();
  await bus.drain(1000);
  assert.deepEqual(counts, [1, 2], 'the late completion of attempt 1 does not cause another delivery');
  await bus.close();
});

test('after maxDeliver failed deliveries the message is dead-lettered once and drain completes', async () => {
  const logger = new MemoryLogger();
  const bus = new InProcessEventBus({ logger });
  const dead: Array<{ eventId: string; deliveryCount: number; error: string }> = [];
  let calls = 0;
  await bus.subscribe({
    durableName: 'poison',
    subjects: ['ht.>'],
    ackWaitMs: 2,
    maxDeliver: 3,
    handler: async () => {
      calls++;
      throw new Error('always fails');
    },
    onDeadLetter: (e, error) => dead.push({ eventId: e.eventId, deliveryCount: e.deliveryCount, error: (error as Error).message }),
  });
  await bus.publish(envelope('r8', 'finding.created', 'evt_poison'));
  await bus.drain(1000);
  assert.equal(calls, 3);
  assert.deepEqual(dead, [{ eventId: 'evt_poison', deliveryCount: 3, error: 'always fails' }]);
  assert.ok(logger.entries.some((e) => e.level === 'warn' && e.msg.includes('dead-lettered')));
  await bus.close();
});

test('duplicateDelivery fault injection delivers the same envelope twice (deliveryCount 1 then 2) to every consumer', async () => {
  const bus = new InProcessEventBus({ duplicateDelivery: (e) => e.eventType === 'finding.created' });
  const a = recorder();
  const b = recorder();
  await bus.subscribe({ durableName: 'a', subjects: ['ht.>'], handler: a.handler });
  await bus.subscribe({ durableName: 'b', subjects: ['ht.>'], handler: b.handler });
  await bus.publish(envelope('r9', 'finding.created', 'evt_dup'));
  await bus.publish(envelope('r9', 'work.created', 'evt_single'));
  await bus.drain(1000);
  for (const r of [a, b]) assert.deepEqual(r.seen.map((e) => `${e.eventId}#${e.deliveryCount}`), ['evt_dup#1', 'evt_dup#2', 'evt_single#1']);
  await bus.close();
});

test('publishes are not deduplicated: a republished eventId is delivered again', async () => {
  const bus = new InProcessEventBus();
  const r = recorder();
  await bus.subscribe({ durableName: 'c', subjects: ['ht.>'], handler: r.handler });
  const e = envelope('r10', 'finding.created', 'evt_again');
  await bus.publish(e);
  await bus.publish(e);
  await bus.drain(1000);
  assert.deepEqual(r.seen.map((x) => x.eventId), ['evt_again', 'evt_again']);
  await bus.close();
});

test('unsubscribe keeps the durable position; re-subscribing resumes without redelivering handled messages', async () => {
  const bus = new InProcessEventBus();
  const first = recorder();
  const sub = await bus.subscribe({ durableName: 'resumable', subjects: ['ht.>'], handler: first.handler });
  await bus.publish(envelope('r11', 'a.b', 'evt_r1'));
  await bus.drain(1000);
  await sub.unsubscribe();
  await bus.publish(envelope('r11', 'a.b', 'evt_r2'));
  await bus.drain(1000); // nobody subscribed to the durable: nothing to wait for
  const second = recorder();
  await bus.subscribe({ durableName: 'resumable', subjects: ['ht.>'], handler: second.handler });
  await bus.drain(1000);
  assert.deepEqual(first.seen.map((e) => e.eventId), ['evt_r1']);
  assert.deepEqual(second.seen.map((e) => e.eventId), ['evt_r2']);
  await bus.close();
});

test('drain rejects with timeout (never a silent partial drain) while a handler is stuck', async () => {
  const bus = new InProcessEventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await bus.subscribe({ durableName: 'stuck', subjects: ['ht.>'], ackWaitMs: 10_000, handler: () => gate });
  await bus.publish(envelope('r12', 'a.b'));
  const err = await rejectsWith(bus.drain(30), 'timeout');
  assert.deepEqual((err.details['pending'] as Record<string, unknown>)['stuck'], { ready: 0, scheduled: 0, running: 1, subscribers: 1 });
  release();
  await bus.drain(1000);
  await bus.close();
});

test('closed bus refuses publish/subscribe; invalid subscriptions are rejected', async () => {
  const bus = new InProcessEventBus();
  await rejectsWith(bus.subscribe({ durableName: '', subjects: ['ht.>'], handler: async () => undefined }), 'invalid_argument');
  await rejectsWith(bus.subscribe({ durableName: 'x', subjects: [], handler: async () => undefined }), 'invalid_argument');
  await rejectsWith(bus.subscribe({ durableName: 'x', subjects: ['ht.>'], maxDeliver: 0, handler: async () => undefined }), 'invalid_argument');
  await rejectsWith(bus.publish({ ...envelope('r13', 'a.b'), eventId: '' }), 'invalid_argument');
  await bus.close();
  const err = await rejectsWith(bus.publish(envelope('r13', 'a.b')), 'unavailable');
  assert.ok(err instanceof HypertestError);
  await rejectsWith(bus.subscribe({ durableName: 'x', subjects: ['ht.>'], handler: async () => undefined }), 'unavailable');
  await bus.drain(10);
});

test('close() waits for handlers still running, so their resources can be released right after it', async () => {
  const bus = new InProcessEventBus();
  let finished = false;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  await bus.subscribe({ durableName: 'closing', subjects: ['ht.>'], handler: async () => { started(); await sleep(40); finished = true; } });
  await bus.publish(envelope('r14', 'a.b'));
  await running;
  await bus.close();
  assert.equal(finished, true, 'close() resolved only after the in-flight handler returned');
});

test('unsubscribe() waits for that subscriber in-flight handler; other durables keep running', async () => {
  const bus = new InProcessEventBus();
  let finished = false;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const sub = await bus.subscribe({ durableName: 'leaving', subjects: ['ht.>'], handler: async () => { started(); await sleep(40); finished = true; } });
  const other = recorder();
  await bus.subscribe({ durableName: 'staying', subjects: ['ht.>'], handler: other.handler });
  await bus.publish(envelope('r15', 'a.b', 'evt_leave_1'));
  await running;
  await sub.unsubscribe();
  assert.equal(finished, true);
  await bus.publish(envelope('r15', 'a.b', 'evt_leave_2'));
  await bus.drain(1000);
  assert.deepEqual(other.seen.map((e) => e.eventId), ['evt_leave_1', 'evt_leave_2']);
  await bus.close();
});

test('close() waits at most closeGraceMs for a stuck handler and logs the detach', async () => {
  const logger = new MemoryLogger();
  const bus = new InProcessEventBus({ closeGraceMs: 30, logger });
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  await bus.subscribe({ durableName: 'stuck-close', subjects: ['ht.>'], ackWaitMs: 10_000, handler: () => { started(); return new Promise<void>(() => undefined); } });
  await bus.publish(envelope('r16', 'a.b'));
  await running;
  const t0 = Date.now();
  await bus.close();
  assert.ok(Date.now() - t0 < 1000, 'close did not hang on the stuck handler');
  assert.ok(logger.entries.some((e) => e.level === 'warn' && e.msg.includes('did not finish')));
});

test('duplicateDelivery as a probability: 1 duplicates every message, 0 none; out-of-range is rejected', async () => {
  for (const [p, expected] of [[1, ['evt_p#1', 'evt_p#2']], [0, ['evt_p#1']]] as const) {
    const bus = new InProcessEventBus({ duplicateDelivery: p });
    const r = recorder();
    await bus.subscribe({ durableName: 'prob', subjects: ['ht.>'], handler: r.handler });
    await bus.publish(envelope('r17', 'finding.created', 'evt_p'));
    await bus.drain(1000);
    assert.deepEqual(r.seen.map((e) => `${e.eventId}#${e.deliveryCount}`), expected);
    await bus.close();
  }
  const draws = [0.2, 0.9];
  const seeded = new InProcessEventBus({ duplicateDelivery: 0.5, random: () => draws.shift()! });
  const r = recorder();
  await seeded.subscribe({ durableName: 'seeded', subjects: ['ht.>'], handler: r.handler });
  await seeded.publish(envelope('r17', 'x.y', 'evt_s1'));
  await seeded.publish(envelope('r17', 'x.y', 'evt_s2'));
  await seeded.drain(1000);
  assert.deepEqual(r.seen.map((e) => `${e.eventId}#${e.deliveryCount}`), ['evt_s1#1', 'evt_s1#2', 'evt_s2#1']);
  await seeded.close();
  assert.throws(() => new InProcessEventBus({ duplicateDelivery: 1.5 }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
});

test('delayedAck fault injection: an ack later than ackWait redelivers a message that was already handled', async () => {
  const bus = new InProcessEventBus({ delayedAck: (e) => (e.deliveryCount === 1 ? 60 : 0) });
  const counts: number[] = [];
  await bus.subscribe({ durableName: 'late-ack', subjects: ['ht.>'], ackWaitMs: 15, handler: async (e) => void counts.push(e.deliveryCount) });
  await bus.subscribe({ durableName: 'late-ack', subjects: ['ht.>'], ackWaitMs: 15, handler: async (e) => void counts.push(e.deliveryCount) });
  await bus.publish(envelope('r18', 'finding.created'));
  await bus.drain(2000);
  assert.deepEqual(counts, [1, 2], 'handled once, redelivered because the ack arrived after ackWait');
  // A delay inside ackWait is harmless.
  const calm = new InProcessEventBus({ delayedAck: () => 5 });
  const r = recorder();
  await calm.subscribe({ durableName: 'calm', subjects: ['ht.>'], ackWaitMs: 500, handler: r.handler });
  await calm.publish(envelope('r18', 'finding.created'));
  await calm.drain(2000);
  assert.deepEqual(r.seen.map((e) => e.deliveryCount), [1]);
  await bus.close();
  await calm.close();
});
