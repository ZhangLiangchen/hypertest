/**
 * E[8] / stubs[0] / coverage[0]: the human approval loop of the control plane. A tool call whose permit is
 * `approval_required` is not executed: the work item WAITS durably on `approval:<id>` (its SQL state — a restarted process
 * keeps waiting), a human decides (`hypertest approve|reject`), observeWaiting resumes the agent, and the SAME call runs
 * exactly once (the gate consumes the approval). A denial ⇒ the call is denied from then on.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import type { WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, RoleCatalog, type RoleDefinition } from '@hypertest/agents';
import type { SideEffectAdapter } from '@hypertest/operation';
import { ApprovalGatedPolicyEngine, type PolicyEngine } from '@hypertest/policy';
import type { ToolSpec } from '@hypertest/tools';
import { approvalWaitOperationId, createControlPlane } from '../src/index.ts';
import { call, createHarness, runItem, type BrainView, type Harness, type RoleBrain } from './harness.ts';

/** A production-like rollout whose dispatches the test counts. */
class Rollout {
  dispatched = 0;
  adapter(): SideEffectAdapter {
    return {
      adapterId: 'fake.rollout',
      capabilities: { supportsNativeIdempotency: true, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'deterministic', riskClass: 'critical' },
      prepare: async (op, input) => ({ desiredState: input, desiredStateHash: sha256Hex(JSON.stringify(input)), target: op.operation.target }),
      dispatch: async () => {
        this.dispatched++;
        return { accepted: true, externalJobId: `job-${this.dispatched}` };
      },
      observe: async () => ({ state: 'present', observation: { done: true } }),
      verify: async () => ({ status: 'verified', result: { rolledOut: true } }),
    };
  }
}

/** Critical risk + external ⇒ DEFAULT_POLICY_RULES `approve-critical-risk` ⇒ approval_required. */
const ROLLOUT_TOOL: ToolSpec<{ version: string }> = {
  id: 'ops.rollout',
  title: 'Rollout',
  description: 'Roll a version out (critical: needs a human approval).',
  inputSchema: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'string' } } },
  effect: 'external',
  riskClass: 'critical',
  resources: () => ['env/local/app'],
  environmentClass: () => 'local',
  sideEffect: { adapterId: 'fake.rollout', operationType: 'rollout', target: () => ({ resourceKey: 'env/local/app', kind: 'app' }) },
  timeoutMs: 10_000,
  execute: async () => {
    throw new Error('side-effect tools never execute directly');
  },
};

const EXPERIMENT = { hypothesis: 'the new version rolls out cleanly', isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/local/app', mode: 'write_exclusive' }] } };

const RELEASER: RoleDefinition = {
  role: 'releaser',
  description: 'rolls versions out',
  systemPrompt: 'You are {{role}}. Goal: {{runGoal}}. Objective: {{objective}}. Protocol: {{protocol}}',
  phase: 'execution',
  taskType: 'deploy',
  defaultModelPolicy: { requiredCapabilities: ['tool_use'] },
  toolPolicy: { allow: ['ops.rollout', 'experiment.define', 'complete_work', 'fail_work'] },
  permissionProfile: 'environment_operator',
  workspace: 'scratch',
  dataClassification: 'internal',
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: {},
};

const lead: RoleBrain = (v) => {
  if (v.step === 0) return call('plan.propose_revision', { rationale: 'release', objectives: [{ objectiveId: 'o', description: 'release', priority: 'P2' }], workItems: [{ localId: 'r', title: 'release', objective: 'roll 2.0.0 out', role: 'releaser', dependsOn: [], objectiveIds: ['o'] }] });
  return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
};

/** The harness policy object is shared by the ToolRuntime and the control plane: gate it in place (as compose wraps it). */
function gatePolicy(h: Harness, approvalTtlMs?: number): void {
  const policy = h.deps.policy as PolicyEngine & { evaluate: PolicyEngine['evaluate'] };
  const inner: PolicyEngine = { revision: policy.revision, evaluate: policy.evaluate.bind(policy) };
  const gate = new ApprovalGatedPolicyEngine(inner, approvalTtlMs !== undefined ? { approvals: h.deps.approvals, clock: h.clock, approvalTtlMs } : { approvals: h.deps.approvals, clock: h.clock });
  policy.evaluate = (r) => gate.evaluate(r);
}

async function setup(views: BrainView[], approvalTtlMs?: number): Promise<{ h: Harness; rollout: Rollout; runId: string; workItemId: string; fencingToken: number }> {
  const rollout = new Rollout();
  const releaser: RoleBrain = (v) => {
    views.push(v);
    if (v.step === 0) return call('experiment.define', EXPERIMENT);
    if (v.step <= 2) return call('ops.rollout', { version: '2.0.0' }); // step 2: the same call again after the decision
    return call('complete_work', { summary: 'released 2.0.0' });
  };
  const roles = new RoleCatalog(BUILTIN_ROLES, { custom: [RELEASER] }, { extraToolIds: ['ops.rollout'] });
  const h = await createHarness({ roles, brains: { lead, releaser } });
  (h.deps.adapters as unknown as { register(a: SideEffectAdapter): void }).register(rollout.adapter());
  h.deps.registry.register(ROLLOUT_TOOL);
  gatePolicy(h, approvalTtlMs);
  const run = await h.control.startRun({ goal: 'release', target: {} });
  const t1 = await h.control.tick(run.runId);
  assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken), 'completed');
  const d = (await h.control.tick(run.runId)).dispatched[0]!;
  assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue', 'the experiment is defined');
  return { h, rollout, runId: run.runId, workItemId: d.workItemId, fencingToken: d.fencingToken };
}

describe('E[8] human approval loop: approval_required ⇒ durable wait ⇒ human decision ⇒ resume', () => {
  test('approved: the item waits on approval:<id> (also across a restarted process), resumes on the decision, and the SAME call runs exactly once', async () => {
    const views: BrainView[] = [];
    const { h, rollout, runId, workItemId, fencingToken } = await setup(views);
    try {
      const waited = await h.control.executeTurn(workItemId, fencingToken);
      assert.equal(waited.status, 'waiting');
      const [a] = (await h.deps.approvals.list({ runId })).filter((x) => x.kind === 'action');
      assert.ok(a, 'an action approval request was recorded');
      assert.equal(a.status, 'pending');
      assert.deepEqual((a.subject as Record<string, unknown>)['tool'], 'ops.rollout');
      assert.deepEqual(waited, { status: 'waiting', workItemId, operationIds: [approvalWaitOperationId(a.approvalId)] });
      assert.equal(rollout.dispatched, 0, 'nothing ran without approval');
      // the turn told the agent it waits — not an error, never a fake success
      const item = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(item.state, 'waiting');

      // undecided: it keeps waiting (tick reports it, no re-dispatch); a restarted process re-attaches the same wait
      assert.equal((await h.control.observeWaiting(workItemId)).status, 'waiting');
      assert.deepEqual((await h.control.tick(runId)).waiting, [{ workItemId, operationIds: [approvalWaitOperationId(a.approvalId)] }]);
      const restarted = createControlPlane({ ...h.deps });
      await restarted.recover(runId);
      assert.equal((await restarted.observeWaiting(workItemId)).status, 'waiting');
      assert.deepEqual(((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem).waitingOn, [approvalWaitOperationId(a.approvalId)]);

      // agents never decide it; a human does
      await assert.rejects(h.deps.approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_x', role: 'reviewer' }, 'ok', h.ctx(runId)), (e: unknown) => isHypertestError(e, 'permission_denied'));
      await h.deps.approvals.decide(a.approvalId, true, { kind: 'human', id: 'release-manager' }, 'go', h.ctx(runId));
      const resumed = await restarted.observeWaiting(workItemId);
      assert.equal(resumed.status, 'continue');
      const now = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(await runItem(restarted, workItemId, now.claim!.fencingToken), 'completed');
      assert.match(views[2]!.userText, new RegExp(`approval ${a.approvalId} \\(action\\) APPROVED by human:release-manager — go: issue exactly the same ops.rollout call again`));
      assert.equal(rollout.dispatched, 1, 'exactly one rollout');
      const ops = (await h.deps.ledger.list({ runId })).filter((o) => o.operationType === 'rollout');
      assert.deepEqual(ops.map((o) => o.status), ['verified']);
      assert.ok(await h.deps.approvals.consumption!(a.approvalId), 'the approval was consumed by the rollout');
      const types = (await h.deps.events.read(runId, { types: ['approval.requested', 'approval.granted', 'approval.consumed'] })).map((e) => e.eventType);
      assert.deepEqual(types, ['approval.requested', 'approval.granted', 'approval.consumed']);
    } finally {
      await h.dispose();
    }
  });

  test('rejected: the item resumes with the denial, and the same call is denied (never executed, never re-requested)', async () => {
    const views: BrainView[] = [];
    const { h, rollout, runId, workItemId, fencingToken } = await setup(views);
    try {
      assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'waiting');
      const [a] = (await h.deps.approvals.list({ runId })).filter((x) => x.kind === 'action');
      await h.deps.approvals.decide(a!.approvalId, false, { kind: 'human', id: 'release-manager' }, 'freeze window', h.ctx(runId));
      assert.equal((await h.control.observeWaiting(workItemId)).status, 'continue');
      // the agent issues the call again anyway: denied with the exact reason, nothing dispatched, no new request
      const item = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(await runItem(h.control, workItemId, item.claim!.fencingToken), 'completed');
      assert.match(views[2]!.userText, new RegExp(`approval ${a!.approvalId} \\(action\\) DENIED by human:release-manager — freeze window: ops.rollout must not run`));
      assert.equal(views[3]!.lastResult?.name, 'ops__rollout');
      assert.match(views[3]!.lastResult?.content ?? '', /approval_denied: approval .* of this action was denied by human:release-manager \(freeze window\)/);
      assert.equal(rollout.dispatched, 0);
      assert.equal((await h.deps.approvals.list({ runId })).filter((x) => x.kind === 'action').length, 1);
    } finally {
      await h.dispose();
    }
  });

  test('expired undecided: observeWaiting records the expiry and resumes the agent; the call is denied', async () => {
    const views: BrainView[] = [];
    const { h, rollout, runId, workItemId, fencingToken } = await setup(views, 60_000);
    try {
      assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'waiting');
      const [a] = (await h.deps.approvals.list({ runId })).filter((x) => x.kind === 'action');
      // a durable runtime ticks the run and observes the wait every few seconds (keeping the claims alive)
      for (let i = 0; i < 5; i++) {
        h.clock.advance(10_000);
        await h.control.tick(runId);
        assert.equal((await h.control.observeWaiting(workItemId)).status, 'waiting', 'inside its window it keeps waiting');
      }
      h.clock.advance(10_000); // the window (60 s) ends
      await h.control.tick(runId);
      assert.equal((await h.control.observeWaiting(workItemId)).status, 'continue');
      assert.equal((await h.deps.approvals.get(a!.approvalId))!.status, 'expired');
      await assert.rejects(h.deps.approvals.decide(a!.approvalId, true, { kind: 'human', id: 'late' }, 'too late', h.ctx(runId)), (e: unknown) => isHypertestError(e, 'precondition_failed'));
      const item = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(await runItem(h.control, workItemId, item.claim!.fencingToken), 'completed');
      assert.match(views[2]!.userText, new RegExp(`approval ${a!.approvalId} \\(action\\) EXPIRED undecided at .*: ops.rollout must not run`));
      assert.match(views[3]!.lastResult?.content ?? '', /approval_expired: approval .* expired before it was decided/);
      assert.equal(rollout.dispatched, 0);
    } finally {
      await h.dispose();
    }
  });
});
