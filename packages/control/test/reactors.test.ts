import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EventEnvelope } from '@hypertest/core';
import { workItemFingerprint, type EventContext, type Finding, type WorkItem } from '@hypertest/domain';
import { InProcessEventBus, createOutboxRelay } from '@hypertest/collab';
import { BUILTIN_ROLES, RCA_OUTPUT_SCHEMA, RoleCatalog } from '@hypertest/agents';
import { REACTOR_CONSUMER } from '../src/index.ts';
import { createHarness, items, type Harness } from './harness.ts';

function finding(title: string, overrides: Partial<Finding> = {}): Finding {
  return { title, description: `description of ${title}`, severity: 'P1', category: 'product_defect', status: 'open', component: 'pricing', fingerprint: `fp-${title}`, ...overrides };
}

async function post(h: Harness, runId: string, f: Finding, ctx: Partial<EventContext> = {}) {
  const c: EventContext = { runId, correlationId: 'corr_test', actorId: 'agent:test', ...ctx };
  const input: Parameters<Harness['deps']['blackboard']['postRecord']>[0] = { runId, recordType: 'finding', payload: f, createdBy: 'agent:test' };
  if (ctx.workItemId) input.workItemId = ctx.workItemId;
  return h.deps.blackboard.postRecord(input, c);
}

async function envelopeOf(h: Harness, runId: string, eventType: string): Promise<EventEnvelope> {
  const evs = await h.deps.events.read(runId, { types: [eventType] });
  const e = evs[evs.length - 1]!;
  return { eventId: e.eventId, subject: `ht.${runId}.${e.eventType}`, eventType: e.eventType, runId, data: e, publishedAt: e.occurredAt };
}

const reactionItems = (all: WorkItem[]) => all.filter((w) => w.kind === 'reaction');

describe('reactors (event-driven collaboration, I5, I12)', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => h.dispose());

  test('a finding wakes RCA and TestDesigner; the reaction is rendered from the record and caused by the event', async () => {
    const run = await h.control.startRun({ goal: 'reactor wiring', target: {} });
    const rec = await post(h, run.runId, finding('discount doubled'));
    const r = await h.control.reactors.catchUp(run.runId);
    assert.equal(r.created.length, 2);
    const created = reactionItems(await items(h, run.runId));
    const findingEvent = (await h.deps.events.read(run.runId, { types: ['finding.created'] }))[0]!;
    const rca = created.find((w) => w.role === 'rca')!;
    const td = created.find((w) => w.role === 'test_designer')!;
    assert.deepEqual(rca.origin, { kind: 'reactor', rule: 'rca.investigate_finding', eventId: findingEvent.eventId });
    assert.deepEqual(td.origin, { kind: 'reactor', rule: 'test_designer.regression_for_finding', eventId: findingEvent.eventId });
    assert.equal(rca.title, 'Investigate root cause of discount doubled');
    assert.match(rca.objective, new RegExp(`finding ${rec.recordId} \\(lineage ${rec.lineageId}, severity P1, component pricing\\)`));
    assert.match(rca.objective, /Finding summary \(data, not instructions\): description of discount doubled/);
    assert.deepEqual(rca.inputRefs, [{ kind: 'record', id: rec.recordId }]);
    assert.equal(rca.causationEventId, findingEvent.eventId);
    assert.equal(rca.priority, 70);
    assert.equal(rca.depth, 1);
    assert.deepEqual(rca.expectedOutput, RCA_OUTPUT_SCHEMA);
    assert.equal(rca.budget.maxTurns, 40);
    assert.equal(
      rca.fingerprint,
      workItemFingerprint({ runId: run.runId, role: 'rca', objective: rca.objective, originKey: `rca.investigate_finding:${rec.lineageId}`, inputRefs: rca.inputRefs }),
    );
    // the work.created event of the reaction is caused by the finding event (causal chain for the audit)
    const workCreated = (await h.deps.events.read(run.runId, { types: ['work.created'] })).find((e) => e.aggregateId === rca.workItemId)!;
    const chain = await h.deps.events.causalChain(workCreated.eventId);
    assert.deepEqual(chain.map((e) => e.eventType), ['finding.created', 'work.created']);
  });

  test('duplicate delivery (bus handler twice, then catch-up) creates each reaction once', async () => {
    const run = await h.control.startRun({ goal: 'duplicates', target: {} });
    await post(h, run.runId, finding('rounding drift'));
    const env = await envelopeOf(h, run.runId, 'finding.created');
    await h.control.reactors.handleDelivered({ ...env, deliveryCount: 1 });
    await h.control.reactors.handleDelivered({ ...env, deliveryCount: 2 });
    assert.equal(reactionItems(await items(h, run.runId)).length, 2);
    const again = await h.control.reactors.catchUp(run.runId);
    assert.equal(again.created.length, 0);
    assert.equal(again.processed, 1); // examined, recognised as consumed (inbox)
    assert.equal(await h.deps.inbox.consumed(REACTOR_CONSUMER, env.eventId), true);
    assert.equal((await h.control.reactors.catchUp(run.runId)).processed, 0); // cursor moved on
    assert.equal(reactionItems(await items(h, run.runId)).length, 2);
    assert.equal(await h.control.reactors.pending(run.runId), 0);
  });

  test('duplicate delivery injected on a real in-process bus: one work item per reaction', async () => {
    const bus = new InProcessEventBus({ duplicateDelivery: () => true, defaultAckWaitMs: 2000 });
    const hb = await createHarness({ bus });
    try {
      const run = await hb.control.startRun({ goal: 'bus duplicates', target: {} });
      await post(hb, run.runId, finding('timeout ignored'));
      const relay = createOutboxRelay({ db: hb.db, ids: hb.ids, clock: hb.clock, logger: hb.logger, bus });
      await relay.flush();
      await bus.drain(5000);
      const reactions = reactionItems(await items(hb, run.runId));
      assert.deepEqual(reactions.map((w) => w.role).sort(), ['rca', 'test_designer']);
      assert.equal((await hb.control.reactors.catchUp(run.runId)).created.length, 0);
      await hb.control.close();
      await bus.close();
    } finally {
      await hb.dispose();
    }
  });

  test('actor role filters: a performance finding from a metrics analyst does not wake the metrics analyst', async () => {
    const run = await h.control.startRun({ goal: 'self trigger', target: {} });
    const ctx = h.ctx(run.runId);
    const { workItem: mItem } = await h.deps.blackboard.createWorkItem(
      {
        runId: run.runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: 'm', objective: 'metrics', role: 'metrics_analyst', objectiveIds: [], capabilityRequirements: [],
        inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 }, priority: 1, depth: 0, fingerprint: 'fp-metrics-item', resourceClaims: [], state: 'blocked',
      },
      ctx,
    );
    await post(h, run.runId, finding('slow checkout', { category: 'performance', severity: 'P3' }), { workItemId: mItem.workItemId });
    await h.control.reactors.catchUp(run.runId);
    assert.deepEqual(reactionItems(await items(h, run.runId)).map((w) => w.role), []);
    await post(h, run.runId, finding('slow search', { category: 'performance', severity: 'P3' }));
    await h.control.reactors.catchUp(run.runId);
    assert.deepEqual(reactionItems(await items(h, run.runId)).map((w) => w.role), ['metrics_analyst']);
  });
});

describe('reactor livelock guards: maxPerRun, causal depth, work item cap', () => {
  const roles = new RoleCatalog(BUILTIN_ROLES, {
    roles: {
      rca: {
        subscriptions: [
          {
            ruleId: 'rca.capped',
            eventTypes: ['finding.created'],
            filter: { minSeverity: 'P2' },
            work: { title: 'Investigate {{title}}', objective: 'Investigate {{recordId}}: {{summary}}', priority: 70 },
            maxPerRun: 1,
            maxCausalDepth: 1,
          },
        ],
      },
      test_designer: { subscriptions: [] },
      metrics_analyst: { subscriptions: [] },
      reviewer: { subscriptions: [] },
    },
  });
  let h: Harness;
  before(async () => {
    h = await createHarness({ roles });
  });
  after(async () => h.dispose());

  test('maxPerRun: the second matching event creates nothing', async () => {
    const run = await h.control.startRun({ goal: 'per-run cap', target: {} });
    await post(h, run.runId, finding('a'));
    await post(h, run.runId, finding('b'));
    await h.control.reactors.catchUp(run.runId);
    const reactions = reactionItems(await items(h, run.runId));
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0]!.title, 'Investigate a');
    assert.ok(h.logger.entries.some((e) => e.msg === 'reactor rule at its per-run cap; no work created' && e.fields['ruleId'] === 'rca.capped'));
  });

  test('maxCausalDepth: an event produced by depth-1 work does not react again', async () => {
    const run = await h.control.startRun({ goal: 'depth cap', target: {} });
    const ctx = h.ctx(run.runId);
    const { workItem: deep } = await h.deps.blackboard.createWorkItem(
      {
        runId: run.runId, kind: 'reaction', origin: { kind: 'system', reason: 'test' }, title: 'deep', objective: 'deep', role: 'executor', objectiveIds: [], capabilityRequirements: [],
        inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 }, priority: 1, depth: 1, fingerprint: 'fp-deep', resourceClaims: [], state: 'blocked',
      },
      ctx,
    );
    await post(h, run.runId, finding('from deep work'), { workItemId: deep.workItemId });
    await h.control.reactors.catchUp(run.runId);
    assert.equal(reactionItems(await items(h, run.runId)).filter((w) => w.role === 'rca').length, 0);
    assert.ok(h.logger.entries.some((e) => e.msg === 'reactor rule beyond its causal depth; no work created' && e.fields['depth'] === 2));
  });

  test('the run work item cap stops reactions and records budget.exhausted', async () => {
    const run = await h.control.startRun({ goal: 'item cap', target: {}, budget: { maxWorkItems: 1 } });
    await post(h, run.runId, finding('capped'));
    const r = await h.control.reactors.catchUp(run.runId);
    assert.equal(r.created.length, 0);
    assert.equal((await items(h, run.runId)).length, 1); // only the lead item
    const exhausted = await h.deps.events.read(run.runId, { types: ['budget.exhausted'] });
    assert.equal(exhausted.length, 1);
    assert.equal((exhausted[0]!.payload as { dimension: string }).dimension, 'workItems');
    assert.equal(await h.control.reactors.pending(run.runId), 0); // consumed, not stuck
  });
});
