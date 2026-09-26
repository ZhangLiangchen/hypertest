/**
 * Real concurrency on PostgreSQL 16 (PGlite serializes every transaction, so races only show here): two workers
 * (control planes with different worker ids over the same database) tick, react and claim at the same time.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EventEnvelope } from '@hypertest/core';
import type { NewWorkItem } from '@hypertest/collab';
import { infraEnv, skipUnless } from '@hypertest/testkit';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { createControlPlane, type ControlPlaneInternals } from '../src/index.ts';
import { createHarness, items, type Harness } from './harness.ts';

const pg = skipUnless(infraEnv().pgUrl !== undefined, 'HYPERTEST_TEST_PG_URL not set (run `npm run infra:up`)');

function item(runId: string, n: number): NewWorkItem {
  return {
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: `t${n}`, objective: `objective ${n}`, role: 'code_change_analyst', objectiveIds: [], capabilityRequirements: [],
    inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1000, maxToolCalls: 1, maxWallClockMs: 60_000 }, priority: n, depth: 0,
    fingerprint: `pg-${runId}-${n}`, resourceClaims: [], state: 'ready',
  };
}

describe('two workers on PostgreSQL', { skip: pg.skip }, () => {
  let h: Harness;
  let w2: ControlPlaneInternals;
  before(async () => {
    process.env['HYPERTEST_TEST_PG_URL'] ??= infraEnv().pgUrl;
    h = await createHarness({ dbKind: 'postgres' });
    w2 = createControlPlane({ ...h.deps, config: { ...h.deps.config, workerId: 'worker-2' } });
  });
  after(async () => h?.dispose());

  test('concurrent ticks: one run lease owner; every item is claimed at most once', async () => {
    const run = await h.control.startRun({ goal: 'race', target: {}, budget: { maxAgentConcurrency: 20 } });
    for (let n = 1; n <= 8; n++) await h.deps.blackboard.createWorkItem(item(run.runId, n), h.ctx(run.runId));
    const results = await Promise.all([h.control.tick(run.runId), w2.tick(run.runId), h.control.tick(run.runId), w2.tick(run.runId)]);
    const dispatched = results.flatMap((r) => r.dispatched);
    assert.equal(dispatched.length, 9, 'the lead + 8 items, each exactly once');
    assert.equal(new Set(dispatched.map((d) => d.workItemId)).size, 9);
    assert.equal(new Set(dispatched.map((d) => d.ownerId)).size, 1, 'only the run lease owner admitted work');
    const claimed = (await items(h, run.runId)).filter((w) => w.state === 'claimed');
    assert.equal(claimed.length, 9);
    const claimEvents = await h.deps.events.read(run.runId, { types: ['work.claimed'] });
    assert.equal(claimEvents.length, 9);
  });

  test('concurrent reactions from both workers (catch-up and bus deliveries) create each reaction once', async () => {
    const run = await h.control.startRun({ goal: 'reaction race', target: {} });
    await h.deps.blackboard.postRecord(
      { runId: run.runId, recordType: 'finding', payload: { title: 'race', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp-race' }, createdBy: 'agent:test' },
      h.ctx(run.runId),
    );
    const [e] = await h.deps.events.read(run.runId, { types: ['finding.created'] });
    const env: EventEnvelope = { eventId: e!.eventId, subject: `ht.${run.runId}.finding.created`, eventType: 'finding.created', runId: run.runId, data: e, publishedAt: e!.occurredAt };
    await Promise.all([
      h.control.reactors.catchUp(run.runId),
      w2.reactors.catchUp(run.runId),
      h.control.reactors.handleDelivered({ ...env, deliveryCount: 1 }),
      w2.reactors.handleDelivered({ ...env, deliveryCount: 2 }),
    ]);
    const reactions = (await items(h, run.runId)).filter((w) => w.kind === 'reaction');
    assert.deepEqual(reactions.map((w) => w.role).sort(), ['rca', 'test_designer']);
    const usage = await h.deps.budget.usage(`run:${run.runId}`);
    assert.equal(usage!.used.workItems, 3, 'the work item budget was charged once per created item');
  });
});

describe('per-rule caps under concurrent deliveries on PostgreSQL', { skip: pg.skip }, () => {
  test('two DIFFERENT events of a maxPerRun=1 rule delivered concurrently to two workers create exactly one reaction', async () => {
    process.env['HYPERTEST_TEST_PG_URL'] ??= infraEnv().pgUrl;
    const roles = new RoleCatalog(BUILTIN_ROLES, {
      roles: {
        rca: { subscriptions: [{ ruleId: 'rca.once', eventTypes: ['finding.created'], filter: { minSeverity: 'P2' }, work: { title: 'Investigate {{title}}', objective: 'Investigate {{recordId}}', priority: 70 }, maxPerRun: 1, maxCausalDepth: 3 }] },
        test_designer: { subscriptions: [] },
        metrics_analyst: { subscriptions: [] },
        reviewer: { subscriptions: [] },
      },
    });
    const h = await createHarness({ dbKind: 'postgres', roles });
    try {
      const w2 = createControlPlane({ ...h.deps, config: { ...h.deps.config, workerId: 'worker-2' } });
      for (let round = 0; round < 3; round++) {
        const run = await h.control.startRun({ goal: `cap race ${round}`, target: {} });
        const envs: EventEnvelope[] = [];
        for (const title of ['a', 'b', 'c', 'd']) {
          await h.deps.blackboard.postRecord(
            { runId: run.runId, recordType: 'finding', payload: { title, description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: `fp-${title}` }, createdBy: 'agent:test' },
            h.ctx(run.runId),
          );
        }
        for (const e of await h.deps.events.read(run.runId, { types: ['finding.created'] })) {
          envs.push({ eventId: e.eventId, subject: `ht.${run.runId}.finding.created`, eventType: 'finding.created', runId: run.runId, data: e, publishedAt: e.occurredAt });
        }
        await Promise.all(envs.map((env, i) => (i % 2 === 0 ? h.control : w2).reactors.handleDelivered({ ...env, deliveryCount: 1 })));
        const reactions = (await items(h, run.runId)).filter((w) => w.kind === 'reaction');
        assert.equal(reactions.length, 1, `round ${round}: maxPerRun holds under concurrency`);
        assert.equal((await h.deps.budget.usage(`run:${run.runId}`))!.used.workItems, 2, 'lead + the one reaction were charged');
      }
    } finally {
      await h.dispose();
    }
  });
});
