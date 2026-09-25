import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveredEvent, EventBus, EventEnvelope } from '@hypertest/core';
import { workItemFingerprint, type EventContext, type Finding } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { InProcessEventBus, createOutboxRelay } from '../src/index.ts';
import { count, finding, newWorkItem, openEnv, type Env } from './helpers.ts';

/**
 * I5 end-to-end: Blackboard write + outbox (one tx) → relay → at-least-once bus with duplicate delivery →
 * consumer that dedupes through the Inbox inside its own transaction ⇒ exactly one side effect.
 */
let env: Env;
before(async () => {
  env = await openEnv();
  // A side-effect table WITHOUT any uniqueness: only the inbox can prevent duplicates here.
  await env.db.query('CREATE TABLE test_side_effects (id serial PRIMARY KEY, consumer text NOT NULL, event_id text NOT NULL, finding_lineage text NOT NULL)');
});
after(async () => {
  await env.dispose();
});

async function settleOutbox(): Promise<void> {
  await env.db.query("UPDATE ht_outbox SET sent_at = '2026-01-01T00:00:00Z' WHERE sent_at IS NULL");
}

/** RCA reactor: inbox-deduped side-effect row + fingerprint-deduped work item, all in the handler's transaction. */
function rcaReactor(consumer: string, calls: DeliveredEvent[], useInbox = true) {
  return async (delivered: DeliveredEvent) => {
    calls.push(delivered);
    const event = delivered.data as { eventId: string; runId: string; payload: { lineageId: string; severity: Finding['severity'] } };
    await env.db.transaction(async (tx) => {
      if (useInbox && !(await env.inbox.tryConsume(consumer, delivered.eventId, tx))) return;
      await tx.query('INSERT INTO test_side_effects (consumer, event_id, finding_lineage) VALUES ($1, $2, $3)', [consumer, delivered.eventId, event.payload.lineageId]);
      const ctx: EventContext = { runId: event.runId, correlationId: event.runId, causationId: event.eventId, actorId: `reactor:${consumer}` };
      await env.board.createWorkItem(
        newWorkItem(event.runId, {
          kind: 'reaction',
          origin: { kind: 'reactor', rule: consumer, eventId: event.eventId },
          fingerprint: workItemFingerprint({ runId: event.runId, role: 'rca', objective: 'analyse the checkout failure', originKey: event.payload.lineageId }),
        }),
        ctx,
        tx,
      );
    });
  };
}

async function sideEffects(consumer: string, runId: string): Promise<number> {
  return count(env.db, "SELECT count(*) AS n FROM test_side_effects e JOIN ht_records r ON r.lineage_id = e.finding_lineage WHERE e.consumer = $1 AND r.run_id = $2", [consumer, runId]);
}

test('postRecord(finding) → relay.flush → duplicateDelivery=always → inbox consumer creates exactly one side effect', async () => {
  await settleOutbox();
  const runId = 'i5-1';
  const bus = new InProcessEventBus({ duplicateDelivery: () => true });
  const relay = createOutboxRelay({ ...env.deps, bus });
  const calls: DeliveredEvent[] = [];
  // Two subscribers on one durable: the duplicate is handled concurrently by the second one.
  for (let i = 0; i < 2; i++) await bus.subscribe({ durableName: 'rca-reactor', subjects: ['ht.*.finding.created'], handler: rcaReactor('rca-reactor', calls) });

  const rec = await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, eventCtx(runId));
  assert.equal(await relay.flush(), 1);
  await bus.drain(5000);

  assert.deepEqual(calls.map((c) => c.deliveryCount).sort(), [1, 2], 'the fault was actually injected: two deliveries of one event');
  assert.equal(new Set(calls.map((c) => c.eventId)).size, 1);
  assert.equal(await sideEffects('rca-reactor', runId), 1);
  const items = await env.board.listWorkItems({ runId });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.causationEventId, calls[0]!.eventId);
  const evs = await env.events.read(runId);
  assert.equal(evs.filter((e) => e.eventType === 'work.created').length, 1);
  // Traceability: work.created → finding.created.
  const workCreated = evs.find((e) => e.eventType === 'work.created')!;
  assert.deepEqual((await env.events.causalChain(workCreated.eventId)).map((e) => e.eventType), ['finding.created', 'work.created']);
  assert.equal((await env.events.get(workCreated.causationId!))!.aggregateId, rec.lineageId);
  await bus.close();
});

test('relay republish after a crash plus duplicate delivery still yields one side effect', async () => {
  await settleOutbox();
  const runId = 'i5-2';
  const inner = new InProcessEventBus({ duplicateDelivery: () => true });
  let crashed = false;
  const published: string[] = [];
  const crashingBus: EventBus = {
    kind: 'inprocess',
    publish: async (e: EventEnvelope) => {
      await inner.publish(e);
      published.push(e.eventId);
      if (!crashed) {
        crashed = true;
        throw new Error('relay process died after publishing, before marking the row sent');
      }
    },
    subscribe: (o) => inner.subscribe(o),
    drain: (t) => inner.drain(t),
    close: () => inner.close(),
  };
  const calls: DeliveredEvent[] = [];
  await inner.subscribe({ durableName: 'rca-reactor-2', subjects: ['ht.*.finding.created'], handler: rcaReactor('rca-reactor-2', calls) });
  await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, eventCtx(runId));
  const [findingEvent] = await env.events.read(runId, { types: ['finding.created'] });
  await assert.rejects(createOutboxRelay({ ...env.deps, bus: crashingBus }).flush(), /relay process died/);
  await inner.drain(5000);
  // The restarted relay republishes the unmarked finding row (plus the work events the reactor wrote meanwhile).
  await createOutboxRelay({ ...env.deps, bus: crashingBus }).flush();
  await inner.drain(5000);
  assert.deepEqual(published.filter((id) => id === findingEvent!.eventId).length, 2);
  assert.equal(calls.length, 4, 'two publishes × duplicate delivery');
  assert.equal(await sideEffects('rca-reactor-2', runId), 1);
  assert.equal((await env.board.listWorkItems({ runId })).length, 1);
  await inner.close();
});

test('negative control: without the inbox the injected duplicate does produce a second side effect', async () => {
  await settleOutbox();
  const runId = 'i5-3';
  const bus = new InProcessEventBus({ duplicateDelivery: () => true });
  const calls: DeliveredEvent[] = [];
  await bus.subscribe({ durableName: 'naive', subjects: ['ht.*.finding.created'], handler: rcaReactor('naive', calls, false) });
  await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, eventCtx(runId));
  await createOutboxRelay({ ...env.deps, bus }).flush();
  await bus.drain(5000);
  assert.equal(await sideEffects('naive', runId), 2);
  assert.equal((await env.board.listWorkItems({ runId })).length, 1, 'the work item is still protected by its fingerprint');
  await bus.close();
});

test('delayed ack past ackWait (handled, then redelivered) still yields one side effect through the inbox', async () => {
  await settleOutbox();
  const runId = 'i5-4';
  const bus = new InProcessEventBus({ delayedAck: (e) => (e.deliveryCount === 1 ? 600 : 0) });
  const calls: DeliveredEvent[] = [];
  await bus.subscribe({ durableName: 'rca-reactor-4', subjects: ['ht.*.finding.created'], ackWaitMs: 300, handler: rcaReactor('rca-reactor-4', calls) });
  await env.board.postRecord({ runId, recordType: 'finding', payload: finding(), createdBy: 'agent-exec' }, eventCtx(runId));
  await createOutboxRelay({ ...env.deps, bus }).flush();
  await bus.drain(5000);
  assert.deepEqual(calls.map((c) => c.deliveryCount), [1, 2], 'the fault was injected: the handled message came back');
  assert.equal(await sideEffects('rca-reactor-4', runId), 1);
  assert.equal((await env.board.listWorkItems({ runId })).length, 1);
  await bus.close();
});
