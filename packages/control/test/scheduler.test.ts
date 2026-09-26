import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ResourceClaim, WorkItem } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import { call, createHarness, items, type Harness, type RoleBrain } from './harness.ts';

const BUDGET = { maxTurns: 5, maxTokens: 100_000, maxToolCalls: 20, maxWallClockMs: 600_000 };

function newItem(runId: string, title: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title, objective: `objective ${title}`, role: 'code_change_analyst', objectiveIds: [], capabilityRequirements: [],
    inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: BUDGET, priority: 50, depth: 0, fingerprint: `fp-${runId}-${title}`, resourceClaims: [], state: 'ready', ...overrides,
  };
}

const leadDone: RoleBrain = () => call('complete_work', { summary: 'nothing to plan', output: { summary: 'nothing to plan', planProposed: false, readyForGate: false, objectives: [] } });

describe('DynamicScheduler: admission, dependencies, leases (I4, I12)', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: { lead: leadDone } });
  });
  after(async () => h.dispose());

  test('admission follows priority and respects maxAgentConcurrency', async () => {
    const run = await h.control.startRun({ goal: 'concurrency', target: {}, budget: { maxAgentConcurrency: 2 } });
    const ctx = h.ctx(run.runId);
    const low = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'low', { priority: 10 }), ctx)).workItem;
    const high = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'high', { priority: 90 }), ctx)).workItem;
    const mid = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'mid', { priority: 50 }), ctx)).workItem;
    const t = await h.control.tick(run.runId);
    const lead = (await items(h, run.runId)).find((w) => w.role === 'lead')!;
    assert.deepEqual(t.dispatched.map((d) => d.workItemId), [lead.workItemId, high.workItemId]);
    assert.ok(t.dispatched.every((d) => d.ownerId === 'worker-1' && d.fencingToken >= 1));
    assert.equal(t.idleMs, 0);
    assert.deepEqual(t.convergence, { state: 'active', runnable: 2, running: 2, waiting: 0, pendingEvents: 0 });
    const now = await items(h, run.runId);
    assert.equal(now.find((w) => w.workItemId === high.workItemId)!.claim!.fencingToken, t.dispatched[1]!.fencingToken);
    assert.deepEqual([low, mid].map((w) => now.find((x) => x.workItemId === w.workItemId)!.state), ['ready', 'ready']);
    // a second tick admits nothing more while two are active
    assert.deepEqual((await h.control.tick(run.runId)).dispatched, []);
  });

  test('resource claims: conflicting items stay ready (ancestor/descendant, foreign holders), compatible ones are admitted', async () => {
    const run = await h.control.startRun({ goal: 'claims', target: {} });
    const ctx = h.ctx(run.runId);
    const claim = (resourceKey: string, mode: ResourceClaim['mode']): ResourceClaim[] => [{ resourceKey, mode }];
    await h.deps.admission.admit({ holderId: 'foreign-holder', runId: 'run_other', claims: claim('env/shared', 'write_exclusive'), ttlMs: 600_000 });
    const a = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'a', { priority: 80, resourceClaims: claim('env/staging/db', 'write_exclusive') }), ctx)).workItem;
    const b = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'b', { priority: 70, resourceClaims: claim('env/staging/db/users', 'read_shared') }), ctx)).workItem;
    const c = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'c', { priority: 60, resourceClaims: claim('env/other', 'read_shared') }), ctx)).workItem;
    const d = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'd', { priority: 55, resourceClaims: claim('env/shared/x', 'read_shared') }), ctx)).workItem;
    const t = await h.control.tick(run.runId);
    const ids = t.dispatched.map((x) => x.workItemId);
    assert.ok(ids.includes(a.workItemId) && ids.includes(c.workItemId));
    assert.ok(!ids.includes(b.workItemId) && !ids.includes(d.workItemId));
    const held = await h.deps.admission.active(run.runId);
    assert.deepEqual(held.map((x) => [x.holderId, x.claim.resourceKey]).sort(), [[a.workItemId, 'env/staging/db'], [c.workItemId, 'env/other']].sort());
  });

  test('blocked items: ready when dependencies complete, failed (dependency_failed) when one fails', async () => {
    const run = await h.control.startRun({ goal: 'deps', target: {}, budget: { maxAgentConcurrency: 1 } });
    const ctx = h.ctx(run.runId);
    const lead = (await items(h, run.runId))[0]!;
    const failedDep = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'broken', { state: 'blocked', dependsOn: ['wi_missing'] }), ctx)).workItem;
    const waitsOnBroken = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'downstream', { state: 'blocked', dependsOn: [failedDep.workItemId] }), ctx)).workItem;
    const waitsOnLead = (await h.deps.blackboard.createWorkItem(newItem(run.runId, 'after-lead', { state: 'blocked', dependsOn: [lead.workItemId] }), ctx)).workItem;
    const t1 = await h.control.tick(run.runId);
    assert.deepEqual(t1.dispatched.map((d) => d.workItemId), [lead.workItemId]);
    let now = await items(h, run.runId);
    const byId = (id: string) => now.find((w) => w.workItemId === id)!;
    assert.equal(byId(failedDep.workItemId).state, 'failed');
    assert.deepEqual(byId(failedDep.workItemId).failure, { reason: 'dependency_failed', message: 'dependency wi_missing is missing' });
    assert.equal(byId(waitsOnLead.workItemId).state, 'blocked');
    // the lead completes; the dependent becomes ready; the failure propagates downstream
    const lastStatus = await h.control.executeTurn(lead.workItemId, t1.dispatched[0]!.fencingToken);
    assert.equal(lastStatus.status, 'completed');
    await h.control.tick(run.runId);
    now = await items(h, run.runId);
    assert.equal(byId(waitsOnBroken.workItemId).state, 'failed');
    assert.equal(byId(waitsOnBroken.workItemId).failure!.reason, 'dependency_failed');
    assert.ok(['ready', 'claimed'].includes(byId(waitsOnLead.workItemId).state));
  });

  test('another live owner of the run lease: tick does no work', async () => {
    const run = await h.control.startRun({ goal: 'foreign run lease', target: {} });
    const foreign = await h.deps.leases.acquire({ resourceKey: `run/${run.runId}`, owner: 'worker-9', ttlMs: 30_000 });
    assert.ok(foreign);
    const before = await h.deps.events.lastSeq(run.runId);
    const t = await h.control.tick(run.runId);
    assert.deepEqual(t.dispatched, []);
    assert.ok(t.idleMs > 0);
    assert.equal(await h.deps.events.lastSeq(run.runId), before);
    assert.equal((await items(h, run.runId))[0]!.state, 'ready');
    await h.deps.leases.release(foreign.leaseId);
    assert.equal((await h.control.tick(run.runId)).dispatched.length, 1);
  });
});

describe('lease expiry and fencing (I4): a stale worker cannot commit', () => {
  test('expired lease ⇒ requeue with a new fencing token; the old token gets lease_lost and writes nothing', async () => {
    const h = await createHarness({ brains: { lead: leadDone } });
    try {
      const run = await h.control.startRun({ goal: 'expiry', target: {} });
      const t1 = await h.control.tick(run.runId);
      const [d1] = t1.dispatched;
      assert.ok(d1);
      h.clock.advance(60_001);
      const t2 = await h.control.tick(run.runId);
      const [d2] = t2.dispatched;
      assert.equal(d2?.workItemId, d1.workItemId);
      assert.ok(d2!.fencingToken > d1.fencingToken);
      const requeued = await h.deps.events.read(run.runId, { types: ['work.requeued'] });
      assert.equal(requeued.length, 1);
      assert.equal((requeued[0]!.payload as { attempts: number }).attempts, 1);

      const seq = await h.deps.events.lastSeq(run.runId);
      const stale = await h.control.executeTurn(d1.workItemId, d1.fencingToken);
      assert.deepEqual(stale, { status: 'lease_lost', workItemId: d1.workItemId });
      assert.equal(await h.deps.events.lastSeq(run.runId), seq, 'a stale worker writes nothing');
      assert.equal(await h.deps.agents.byWorkItem(d1.workItemId), undefined, 'no agent was created for the stale call');
      assert.equal((await h.deps.blackboard.getWorkItem(d1.workItemId))!.state, 'claimed');

      assert.equal((await h.control.executeTurn(d2!.workItemId, d2!.fencingToken)).status, 'completed');
    } finally {
      await h.dispose();
    }
  });

  test('a worker whose lease expired mid-turn: its next tool call is refused (lease_lost) and nothing is written; the new owner continues the session', async () => {
    let h!: Harness;
    let requeuedToken = 0;
    const complete = () => ({ toolCalls: [{ name: 'complete_work', arguments: { summary: 'result', output: { summary: 'result', planProposed: false, readyForGate: false, objectives: [] } } }] });
    h = await createHarness({
      brains: {
        lead: async (v) => {
          if (requeuedToken === 0) {
            // while this (first) worker's model call is in flight, its lease expires and the item is re-dispatched
            h.clock.advance(60_001);
            requeuedToken = (await h.control.tick(v.runId)).dispatched[0]!.fencingToken;
          }
          return complete();
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'mid-turn expiry', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      const out = await h.control.executeTurn(d1!.workItemId, d1!.fencingToken);
      assert.deepEqual(out, { status: 'lease_lost', workItemId: d1!.workItemId });
      assert.ok(requeuedToken > d1!.fencingToken);
      const item = (await h.deps.blackboard.getWorkItem(d1!.workItemId)) as WorkItem;
      assert.equal(item.state, 'claimed');
      assert.equal(item.claim!.fencingToken, requeuedToken);
      assert.equal((await h.deps.events.read(run.runId, { types: ['work.completed'] })).length, 0);
      const denied = (await h.deps.events.read(run.runId, { types: ['tool.denied'] })).map((e) => e.payload as { errorCode: string; toolId: string });
      assert.deepEqual(denied.map((p) => [p.toolId, p.errorCode]), [['complete_work', 'lease_lost']]);
      assert.equal((await h.deps.agents.byWorkItem(d1!.workItemId))!.status, 'active', 'the stale completion never settled the agent');
      // the new owner resumes the same agent session (the refused call is in its transcript) and completes
      assert.deepEqual(await h.control.executeTurn(d1!.workItemId, requeuedToken), { status: 'completed', workItemId: d1!.workItemId });
      const completed = await h.deps.events.read(run.runId, { types: ['work.completed'] });
      assert.equal((completed[0]!.payload as { fencingToken: number }).fencingToken, requeuedToken);
      assert.equal((await h.deps.agents.list({ runId: run.runId })).length, 1);
    } finally {
      await h.dispose();
    }
  });

  test('crash between the agent settle and the item write: the next owner adopts the settled result without a model call', async () => {
    const h = await createHarness({ brains: { lead: (v) => call('blackboard.read', { limit: v.step + 1 }) } });
    try {
      const run = await h.control.startRun({ goal: 'adopt', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      assert.equal((await h.control.executeTurn(d1!.workItemId, d1!.fencingToken)).status, 'continue');
      const agent = (await h.deps.agents.byWorkItem(d1!.workItemId))!;
      await h.deps.subagents.settle(agent.agentId, { status: 'completed', summary: 'settled before the crash', evidenceRefs: [], recordRefs: [] }, h.ctx(run.runId));
      const calls = h.calls.length;
      assert.deepEqual(await h.control.executeTurn(d1!.workItemId, d1!.fencingToken), { status: 'completed', workItemId: d1!.workItemId });
      assert.equal(h.calls.length, calls);
      assert.equal((await h.deps.blackboard.getWorkItem(d1!.workItemId))!.result!.summary, 'settled before the crash');
    } finally {
      await h.dispose();
    }
  });
});
