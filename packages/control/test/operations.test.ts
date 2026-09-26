import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import type { WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, RoleCatalog, type RoleDefinition } from '@hypertest/agents';
import type { SideEffectAdapter } from '@hypertest/operation';
import type { ToolSpec } from '@hypertest/tools';
import { createControlPlane } from '../src/index.ts';
import { call, createHarness, runItem, type Harness, type RoleBrain } from './harness.ts';

/** An external deployment whose completion the test controls (observe-by-operation-id, deterministic reconcile). */
class FakeDeployTarget {
  dispatched = 0;
  done = false;
  adapter(): SideEffectAdapter {
    return {
      adapterId: 'fake.deploy',
      capabilities: { supportsNativeIdempotency: true, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'deterministic', riskClass: 'medium' },
      prepare: async (op, input) => ({ desiredState: input, desiredStateHash: sha256Hex(JSON.stringify(input)), target: op.operation.target }),
      dispatch: async () => {
        this.dispatched++;
        return { accepted: true, externalJobId: 'job-1' };
      },
      observe: async () => ({ state: 'present', observation: { done: this.done } }),
      verify: async (obs) => ((obs as { done: boolean }).done ? { status: 'verified', result: { deployed: true } } : { status: 'pending', progress: { phase: 'rolling' } }),
    };
  }
}

const DEPLOY_TOOL: ToolSpec<{ version: string }> = {
  id: 'ops.deploy',
  title: 'Deploy',
  description: 'Deploy a version of the app (long-running external operation).',
  inputSchema: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'string' } } },
  effect: 'external',
  riskClass: 'medium',
  resources: () => ['env/local/app'],
  environmentClass: () => 'local',
  sideEffect: { adapterId: 'fake.deploy', operationType: 'deploy', target: () => ({ resourceKey: 'env/local/app', kind: 'app' }) },
  timeoutMs: 10_000,
  execute: async () => {
    throw new Error('side-effect tools never execute directly');
  },
};

const DEPLOYER: RoleDefinition = {
  role: 'deployer',
  description: 'deploys',
  systemPrompt: 'You are {{role}}. Goal: {{runGoal}}. Objective: {{objective}}. Protocol: {{protocol}}',
  phase: 'execution',
  taskType: 'deploy',
  defaultModelPolicy: { requiredCapabilities: ['tool_use'] },
  toolPolicy: { allow: ['ops.deploy', 'complete_work', 'fail_work'] },
  permissionProfile: 'test_executor',
  workspace: 'scratch',
  dataClassification: 'internal',
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: {},
};

describe('long-running external operations: waiting items are observed, not re-dispatched (I4)', () => {
  test('pending side effect ⇒ waiting; observeWaiting polls the gateway; verified ⇒ the agent resumes with the result', async () => {
    const target = new FakeDeployTarget();
    const deployerViews: string[] = [];
    const deployer: RoleBrain = (v) => {
      deployerViews.push(v.userText);
      if (v.step === 0) return call('ops.deploy', { version: '1.2.3' });
      return call('complete_work', { summary: 'deployed 1.2.3' });
    };
    const lead: RoleBrain = (v) => {
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'deploy', objectives: [{ objectiveId: 'o', description: 'deploy', priority: 'P2' }], workItems: [{ localId: 'd', title: 'deploy', objective: 'deploy 1.2.3', role: 'deployer', dependsOn: [], objectiveIds: ['o'] }] });
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
    };
    const roles = new RoleCatalog(BUILTIN_ROLES, { custom: [DEPLOYER] }, { extraToolIds: ['ops.deploy'] });
    const h = await createHarness({ roles, brains: { lead, deployer } });
    (h.deps.adapters as unknown as { register(a: SideEffectAdapter): void }).register(target.adapter());
    h.deps.registry.register(DEPLOY_TOOL);
    try {
      const run = await h.control.startRun({ goal: 'deploy', target: {} });
      const t1 = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken), 'completed');
      const t2 = await h.control.tick(run.runId);
      const d = t2.dispatched[0]!;
      const out = await h.control.executeTurn(d.workItemId, d.fencingToken);
      assert.equal(out.status, 'waiting');
      const [op] = await h.deps.ledger.list({ runId: run.runId });
      assert.ok(op);
      assert.deepEqual(out, { status: 'waiting', workItemId: d.workItemId, operationIds: [op.operationId] });
      assert.equal(op.status, 'acknowledged');
      assert.equal(target.dispatched, 1);

      // still rolling: stays waiting, the lease is renewed, nothing is re-dispatched
      assert.deepEqual(await h.control.observeWaiting(d.workItemId), { status: 'waiting', workItemId: d.workItemId, operationIds: [op.operationId] });
      const t3 = await h.control.tick(run.runId);
      assert.deepEqual(t3.waiting, [{ workItemId: d.workItemId, operationIds: [op.operationId] }]);
      assert.equal(target.dispatched, 1);

      target.done = true;
      const resumed = await h.control.observeWaiting(d.workItemId);
      assert.equal(resumed.status, 'continue');
      assert.equal((await h.deps.ledger.get(op.operationId))!.status, 'verified');
      const item = (await h.deps.blackboard.getWorkItem(d.workItemId)) as WorkItem;
      assert.equal(item.state, 'running');
      assert.equal(await runItem(h.control, d.workItemId, item.claim!.fencingToken), 'completed');
      assert.match(deployerViews[1]!, new RegExp(`Results of pending operations/delegations:\\n- operation ${op.operationId} \\(deploy\\) verified: \\{"deployed":true\\}`));
      assert.equal(target.dispatched, 1, 'exactly one external effect');
    } finally {
      await h.dispose();
    }
  });
});

describe('a waiting item keeps its resources while its external operation runs', () => {
  test('observeWaiting renews the item\'s resource claims with its lease: a conflicting item is not admitted meanwhile', async () => {
    const target = new FakeDeployTarget();
    const deployer: RoleBrain = (v) => (v.step === 0 ? call('ops.deploy', { version: '2.0.0' }) : call('complete_work', { summary: 'deployed' }));
    const claims = [{ resourceKey: 'env/local/app', mode: 'write_exclusive' }];
    const lead: RoleBrain = (v) => {
      if (v.step === 0) {
        return call('plan.propose_revision', {
          rationale: 'deploy, then a conflicting job',
          objectives: [{ objectiveId: 'o', description: 'deploy', priority: 'P2' }],
          workItems: [{ localId: 'd', title: 'deploy', objective: 'deploy 2.0.0', role: 'deployer', dependsOn: [], objectiveIds: ['o'], resourceClaims: claims, priority: 90 }],
        });
      }
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
    };
    const roles = new RoleCatalog(BUILTIN_ROLES, { custom: [DEPLOYER] }, { extraToolIds: ['ops.deploy'] });
    const h = await createHarness({ roles, brains: { lead, deployer } });
    (h.deps.adapters as unknown as { register(a: SideEffectAdapter): void }).register(target.adapter());
    h.deps.registry.register(DEPLOY_TOOL);
    try {
      const run = await h.control.startRun({ goal: 'claims while waiting', target: {} });
      const t1 = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken), 'completed');
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'waiting');
      // the operation takes longer than one lease TTL: the durable runtime keeps observing
      for (let i = 0; i < 3; i++) {
        h.clock.advance(40_000);
        assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'waiting');
      }
      const held = await h.deps.admission.active(run.runId);
      assert.deepEqual(held.map((c) => [c.holderId, c.claim.resourceKey]), [[d.workItemId, 'env/local/app']], 'claim alive after 120 s (TTL 60 s)');
      const rival = await h.deps.admission.admit({ holderId: 'rival', runId: run.runId, claims: claims as never, ttlMs: 60_000 });
      assert.equal(rival.admitted, false, 'nobody else can take the resource while the deployment runs');
      target.done = true;
      assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
      const item = (await h.deps.blackboard.getWorkItem(d.workItemId)) as WorkItem;
      assert.equal(await runItem(h.control, d.workItemId, item.claim!.fencingToken), 'completed');
      assert.deepEqual(await h.deps.admission.active(run.runId), [], 'released with the completion');
    } finally {
      await h.dispose();
    }
  });
});

describe('recover(): reconcile, then take over orphaned work with new fencing tokens', () => {
  test('a second worker reconciles unsettled operations, waits for the run lease, requeues the first worker\'s claim', async () => {
    const lead: RoleBrain = () => call('complete_work', { summary: 'recovered and done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } });
    const h: Harness = await createHarness({ brains: { lead } });
    const target = new FakeDeployTarget();
    target.done = true;
    (h.deps.adapters as unknown as { register(a: SideEffectAdapter): void }).register(target.adapter());
    try {
      const run = await h.control.startRun({ goal: 'recovery', target: {} });
      const t1 = await h.control.tick(run.runId);
      const lead1 = t1.dispatched[0]!;
      // an operation whose dispatch outcome was never recorded (crash after dispatch)
      const ctx = { ...h.ctx(run.runId), workItemId: lead1.workItemId };
      const prepared = await h.deps.ledger.prepare(
        { runId: run.runId, workItemId: lead1.workItemId, operationType: 'deploy', adapterId: 'fake.deploy', target: { resourceKey: 'env/local/app', kind: 'app' }, desiredStateHash: 'h', inputHash: 'i' },
        ctx,
      );
      await h.deps.ledger.transition(prepared.operationId, 'dispatching', {}, ctx);

      const worker2 = createControlPlane({ ...h.deps, config: { ...h.deps.config, workerId: 'worker-2' } });
      await assert.rejects(worker2.recover(run.runId), (e: unknown) => isHypertestError(e, 'unavailable') && /owned by live worker worker-1/.test((e as Error).message));
      assert.equal((await h.deps.ledger.get(prepared.operationId))!.status, 'verified', 'reconciliation happens before the lease check');

      h.clock.advance(60_001);
      const report = await worker2.recover(run.runId);
      assert.deepEqual(report, { reconciled: 0, requeued: [lead1.workItemId] });
      const t2 = await worker2.tick(run.runId);
      const lead2 = t2.dispatched[0]!;
      assert.deepEqual([lead2.workItemId, lead2.ownerId], [lead1.workItemId, 'worker-2']);
      assert.ok(lead2.fencingToken > lead1.fencingToken);
      assert.deepEqual(await h.control.executeTurn(lead1.workItemId, lead1.fencingToken), { status: 'lease_lost', workItemId: lead1.workItemId });
      assert.equal(await runItem(worker2, lead2.workItemId, lead2.fencingToken), 'completed');
      assert.equal(target.dispatched, 0, 'reconciliation never dispatches');
      const recovery = (await worker2.report(run.runId)).recovery.map((r) => r.detail);
      assert.ok(recovery.some((d) => d.startsWith(`work item ${lead1.workItemId} requeued (attempt 1`)));
      assert.ok(recovery.some((d) => d === `operation ${prepared.operationId} reconciled: acknowledged`));
      // the recovery pass explains what re-runs and why (the first, refused attempt recorded nothing)
      assert.ok(recovery.includes(`recovery by worker-2: re-runs ${lead1.workItemId} (lead, was claimed, attempt 1) — orphaned by the previous process`), recovery.join('\n'));
      assert.equal(recovery.filter((d) => d.startsWith('recovery by')).length, 1);
    } finally {
      await h.dispose();
    }
  });

  test('a restarted process of the same worker requeues the claims it can no longer drive; a live instance keeps its own', async () => {
    const lead: RoleBrain = () => call('complete_work', { summary: 'done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } });
    const h = await createHarness({ brains: { lead } });
    try {
      const run = await h.control.startRun({ goal: 'restart', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      assert.deepEqual(await h.control.recover(run.runId), { reconciled: 0, requeued: [] }, 'the issuing instance keeps driving its claim');
      const restarted = createControlPlane({ ...h.deps }); // same workerId, fresh process
      assert.deepEqual(await restarted.recover(run.runId), { reconciled: 0, requeued: [d1!.workItemId] });
      const [d2] = (await restarted.tick(run.runId)).dispatched;
      assert.equal(d2!.workItemId, d1!.workItemId);
      assert.ok(d2!.fencingToken > d1!.fencingToken);
      assert.deepEqual(await h.control.executeTurn(d1!.workItemId, d1!.fencingToken), { status: 'lease_lost', workItemId: d1!.workItemId });
      assert.equal(await runItem(restarted, d2!.workItemId, d2!.fencingToken), 'completed');
    } finally {
      await h.dispose();
    }
  });

  test('recovery is auditable: a waiting item re-attached by a restarted process is named in the report (what was recovered, by whom, waiting on what)', async () => {
    // PoC C "recovery audit": the load item was WAITING on its running load job when Hypertest was killed; the resumed
    // process (same worker id) keeps it waiting on the same operation — re-attached, never re-created. The report must
    // explain that, not only requeues and reconciliations. A pass that recovered nothing records nothing.
    const done = { summary: 'done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } };
    const lead: RoleBrain = (v) => (v.step === 0 ? call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions', title: 'summary' }) : call('complete_work', done));
    const h = await createHarness({ brains: { lead, code_change_analyst: () => call('complete_work', { summary: 'S', output: { summary: 'S', risks: [], testIdeas: [] } }) } });
    const recovered = async (runId: string) => (await h.deps.events.read(runId, { types: ['run.recovered'] })).map((e) => e.payload as Record<string, unknown>);
    try {
      const run = await h.control.startRun({ goal: 'recovery audit', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      assert.deepEqual(await h.control.recover(run.runId), { reconciled: 0, requeued: [] });
      assert.deepEqual(await recovered(run.runId), [], 'the issuing instance recovered nothing: no audit record');
      const waited = await h.control.executeTurn(d1!.workItemId, d1!.fencingToken);
      assert.equal(waited.status, 'waiting');
      const before = (await h.deps.blackboard.getWorkItem(d1!.workItemId)) as WorkItem;
      assert.equal(before.state, 'waiting');

      const restarted = createControlPlane({ ...h.deps }); // same worker id, fresh process
      assert.deepEqual(await restarted.recover(run.runId), { reconciled: 0, requeued: [] }, 'a waiting item is not re-run');
      const after = (await h.deps.blackboard.getWorkItem(d1!.workItemId)) as WorkItem;
      assert.deepEqual([after.state, after.claim?.fencingToken, after.waitingOn], ['waiting', before.claim!.fencingToken, before.waitingOn]);
      assert.deepEqual(await recovered(run.runId), [{
        workerId: 'worker-1',
        operations: { examined: 0, verified: [], notApplied: [], manualReview: [], stillPending: [], compensated: 0 },
        requeued: [],
        reattached: [{ workItemId: d1!.workItemId, role: 'lead', waitingOn: before.waitingOn, fencingToken: before.claim!.fencingToken, claim: 'kept' }],
      }]);
      const recovery = (await restarted.report(run.runId)).recovery.map((r) => r.detail);
      assert.deepEqual(recovery, [`recovery by worker-1: re-attached ${d1!.workItemId} (lead) to ${before.waitingOn!.join(', ')} — still waiting, nothing re-created`]);
      // idempotent: a second pass of the same process has nothing new to recover
      await restarted.recover(run.runId);
      assert.equal((await recovered(run.runId)).length, 1);
    } finally {
      await h.dispose();
    }
  });

  test('a compensation that cannot be resumed (its adapter is gone) is logged and left compensating; the work is still recovered', async () => {
    const h = await createHarness({ brains: { lead: () => call('complete_work', { summary: 'done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } }) } });
    try {
      const run = await h.control.startRun({ goal: 'stuck compensation', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      const ctx = { ...h.ctx(run.runId), workItemId: d1!.workItemId };
      const op = await h.deps.ledger.prepare(
        { runId: run.runId, workItemId: d1!.workItemId, operationType: 'deploy', adapterId: 'gone.adapter', target: { resourceKey: 'env/local/app', kind: 'app' }, desiredStateHash: 'h', inputHash: 'i' },
        ctx,
      );
      for (const to of ['dispatching', 'acknowledged', 'verified', 'compensating'] as const) await h.deps.ledger.transition(op.operationId, to, {}, ctx);
      const restarted = createControlPlane({ ...h.deps });
      assert.deepEqual(await restarted.recover(run.runId), { reconciled: 0, requeued: [d1!.workItemId] });
      assert.equal((await h.deps.ledger.get(op.operationId))!.status, 'compensating');
      assert.ok(h.logger.entries.some((e) => e.msg === 'interrupted compensation could not be resumed' && e.fields['operationId'] === op.operationId));
    } finally {
      await h.dispose();
    }
  });
});
