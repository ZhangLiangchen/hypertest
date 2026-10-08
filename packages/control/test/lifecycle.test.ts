import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type JsonValue } from '@hypertest/core';
import { DEFAULT_BUDGET, type WorkItem } from '@hypertest/domain';
import { DEFAULT_GATE_SPEC } from '@hypertest/policy';
import { LEAD_OUTPUT_SCHEMA } from '@hypertest/agents';
import { ControlStore, runScope } from '../src/index.ts';
import { call, createHarness, drive, items, runItem, type Harness, type RoleBrain } from './harness.ts';
import { pricingOracle } from './fixture.ts';

const NO_PLAN: RoleBrain = () => call('complete_work', { summary: 'no plan', output: { summary: 'no plan', planProposed: false, readyForGate: false, objectives: [] } });

/** A lead that immediately declares readiness without any evidence (the gate must not accept that). */
const READY_WITHOUT_EVIDENCE: RoleBrain = (v) => {
  if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to test', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2', status: 'dropped' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'o', status: 'dropped', evidenceRefs: [] }] } });
};

describe('startRun', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ config: { defaultBudget: { maxAgentConcurrency: 3, maxToolCalls: 500 }, defaultGate: { conditionalOnRiskLevel: 'critical' } } });
    await pricingOracle(h);
  });
  after(async () => h.dispose());

  test('pins manifest, policy, protocol and oracle revisions; merges budgets and gates; creates the lead work item', async () => {
    const run = await h.control.startRun({ goal: 'assess releasability', target: { repoPath: '/repo', commit: 'abc1234', description: 'cart service' }, oracleIds: ['oracle.pricing'], budget: { maxToolCalls: 50 }, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'qa-lead' }, gateOverrideRationale: 'no reviewer model in this deployment', labels: { team: 'qa' } });
    assert.equal(run.status, 'running');
    assert.equal(run.runtimeManifestId, h.deps.config.runtimeManifest.manifestId);
    assert.equal(run.policyRevision, 'policy-rev-1');
    assert.deepEqual(run.protocolBinding, { protocolId: 'bugate', version: h.deps.protocol.binding.version, digest: h.deps.protocol.binding.digest });
    assert.deepEqual(run.oracleRevisions, { 'oracle.pricing': 1 });
    assert.deepEqual(run.budget, { ...DEFAULT_BUDGET, maxAgentConcurrency: 3, maxToolCalls: 50 });
    assert.deepEqual(run.labels, { team: 'qa' });
    const store = new ControlStore(h.db);
    assert.deepEqual(await store.getGate(run.runId), { ...DEFAULT_GATE_SPEC, conditionalOnRiskLevel: 'critical', requireIndependentReview: false });
    assert.deepEqual(await store.getManifest(run.runtimeManifestId), h.deps.config.runtimeManifest);
    assert.deepEqual((await h.deps.budget.usage(runScope(run.runId)))!.limits, { tokens: DEFAULT_BUDGET.maxModelTokens, toolCalls: 50, workItems: DEFAULT_BUDGET.maxWorkItems });
    const [lead] = await items(h, run.runId);
    assert.equal(lead!.kind, 'initial_plan');
    assert.equal(lead!.role, 'lead');
    assert.deepEqual(lead!.origin, { kind: 'system', reason: 'initial_plan' });
    assert.equal(lead!.state, 'ready');
    assert.equal(lead!.priority, 100);
    assert.deepEqual(lead!.expectedOutput, LEAD_OUTPUT_SCHEMA);
    assert.deepEqual(lead!.budget, { maxTurns: 30, maxToolCalls: 80, maxTokens: 400_000, maxWallClockMs: 1_200_000 });
    assert.match(lead!.objective, /^Testing goal: assess releasability\nTarget: repository \/repo; commit under test abc1234 — cart service\n.*propose Plan v1 with plan\.propose_revision/s);
    const types = (await h.deps.events.read(run.runId)).map((e) => e.eventType);
    assert.deepEqual(types.slice(0, 5), ['run.created', 'budget.reserved', 'run.started', 'work.created', 'work.ready']);
    // a durable retry with the same run id returns the stored run
    assert.deepEqual(await h.control.startRun({ goal: 'assess releasability', target: {}, runId: run.runId }), await h.deps.runs.get(run.runId));
    const second = await h.control.startRun({ goal: 'another', target: {} });
    assert.equal(second.runtimeManifestId, run.runtimeManifestId);
    assert.equal((await h.db.query('SELECT 1 FROM ht_manifests')).rows.length, 1);
  });

  test('an unknown oracle is invalid_argument and creates nothing', async () => {
    const before = (await h.deps.runs.list()).length;
    await assert.rejects(h.control.startRun({ goal: 'x', target: {}, oracleIds: ['oracle.nope'] }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /unknown oracle oracle\.nope/.test((e as Error).message));
    await assert.rejects(h.control.startRun({ goal: ' ', target: {} }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await assert.rejects(h.control.startRun({ goal: 'x', target: {}, budget: { maxAgentConcurrency: 0 } }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /budget\.maxAgentConcurrency must be an integer ≥ 1 \(got 0\)/.test((e as Error).message));
    await assert.rejects(h.control.startRun({ goal: 'x', target: {}, budget: { maxWorkItems: 2.5 } }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /budget\.maxWorkItems/.test((e as Error).message));
    await assert.rejects(h.control.startRun({ goal: 'x', target: {}, budget: { maxModelCostUsd: -1 } }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /budget\.maxModelCostUsd/.test((e as Error).message));
    assert.equal((await h.deps.runs.list()).length, before);
  });

  test('snapshot(runId) is a content-addressed projection pinned to the run', async () => {
    const run = await h.control.startRun({ goal: 'snapshot', target: {}, oracleIds: ['oracle.pricing'] });
    const s = await h.control.snapshot(run.runId);
    assert.match(s.snapshotId, /^cs_/);
    assert.equal(s.runtimeManifestId, run.runtimeManifestId);
    assert.deepEqual(s.oracleRevisions, { 'oracle.pricing': 1 });
    assert.equal(s.policyRevision, 'policy-rev-1');
  });
});

describe('convergence: replans, gate feedback loop, caps, exhaustion', () => {
  test('plan drained ⇒ one replan at a time with a digest; the lead is replanned, never duplicated', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN }, config: { defaultBudget: { maxPlanRevisions: 3 } } });
    try {
      const run = await h.control.startRun({ goal: 'drain', target: {} });
      const t1 = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken), 'completed');
      const t2 = await h.control.tick(run.runId);
      assert.equal(t2.replanScheduled, true);
      const replans = (await items(h, run.runId)).filter((w) => w.kind === 'replan');
      assert.equal(replans.length, 1);
      assert.equal(replans[0]!.role, 'lead');
      assert.deepEqual(replans[0]!.origin, { kind: 'system', reason: 'replan:plan_drained' });
      assert.match(replans[0]!.objective, /^Replan #1 \(reason: plan_drained\) of run run_\w+\.\nRun goal: drain\n\n### Objectives: no plan revision has been accepted yet/);
      assert.match(replans[0]!.objective, /### Remaining budget\n- model tokens \d+\/5000000, tool calls 0\/2000, work items 1\/200, accepted plans 0\/3/);
      assert.deepEqual(t2.dispatched.map((d) => d.workItemId), [replans[0]!.workItemId]);
      // while the replan is active no second replan is scheduled
      assert.equal((await h.control.tick(run.runId)).replanScheduled, false);
      assert.equal((await items(h, run.runId)).filter((w) => w.kind === 'replan').length, 1);
    } finally {
      await h.dispose();
    }
  });

  test('gate feedback loop: an inconclusive gate asking for evidence sends the lead back once; the second decision is final', async () => {
    const h = await createHarness({ brains: { lead: READY_WITHOUT_EVIDENCE } });
    try {
      const run = await h.control.startRun({ goal: 'feedback', target: {} });
      const r = await drive(h, run.runId, 20);
      assert.ok(r.final);
      const gateTicks = r.ticks.filter((t) => t.decision);
      assert.deepEqual(gateTicks.map((t) => [t.decision!.verdict, t.final, t.status]), [['inconclusive', false, 'running'], ['inconclusive', true, 'completed']]);
      const [first, second] = gateTicks.map((t) => t.decision!);
      // C0: no oracle is pinned by this run either (conformance-1) — reported first, in criterion order; C12: the run has
      // no SystemModel (coverage-1: missing domain contracts are unknown, never pass)
      assert.deepEqual(first!.unknownCriteria.map((c) => c.criterionId), ['C0', 'C1', 'C4', 'C12']);
      assert.ok(first!.reasons.some((r) => /the run has no SystemModel revision: record the system under test \(system_model\.record\) before judging it/.test(r)), first!.reasons.join('\n'));
      assert.equal(second!.revision, 2);
      assert.equal(second!.supersedes, first!.decisionId);
      assert.equal((await h.deps.decisions.latestForRun(run.runId))!.decisionId, second!.decisionId);
      const feedback = (await items(h, run.runId)).filter((w) => w.kind === 'replan');
      assert.equal(feedback.length, 1);
      assert.deepEqual(feedback[0]!.origin, { kind: 'system', reason: 'replan:gate_feedback' });
      assert.match(feedback[0]!.objective, new RegExp(`### QualityGate feedback \\(decision ${first!.decisionId}, verdict inconclusive\\)\\n- unknown C0 C0 oracle_in_force: no approved oracle is pinned by the run\\n- unknown C1 C1 evidence_integrity: no evidence recorded\\n- unknown C4 C4 required_evidence`));
      const replans = await new ControlStore(h.db).replans(run.runId);
      assert.equal(replans.gateAttempts, 2);
      assert.equal(replans.feedbackPending, false);
      const run2 = (await h.deps.runs.get(run.runId))!;
      assert.equal(run2.status, 'completed');
      assert.equal(run2.decisionId, second!.decisionId);
      const statuses = (await h.deps.events.read(run.runId)).filter((e) => e.eventType.startsWith('run.') && e.eventType !== 'run.updated').map((e) => e.eventType);
      assert.deepEqual(statuses, ['run.created', 'run.started', 'run.converging', 'run.gating', 'run.resumed', 'run.converging', 'run.gating', 'run.completed']);
    } finally {
      await h.dispose();
    }
  });

  test('max plan revisions: the lead cannot replan forever; the run is gated (stalled)', async () => {
    const lead: RoleBrain = (v) => {
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'v1', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2' }], workItems: [] });
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
    };
    const h = await createHarness({ brains: { lead }, config: { defaultBudget: { maxPlanRevisions: 1 } } });
    try {
      const run = await h.control.startRun({ goal: 'caps', target: {} });
      const r = await drive(h, run.runId, 10);
      assert.ok(r.final);
      assert.deepEqual(r.final.convergence, { state: 'stalled', reason: 'max_plan_revisions' });
      assert.equal((await items(h, run.runId)).filter((w) => w.kind === 'replan').length, 0);
      assert.equal(r.final.decision!.verdict, 'inconclusive');
    } finally {
      await h.dispose();
    }
  });

  test('wall clock exhausted: pending work is cancelled, active work may finish, the run is gated', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN } });
    try {
      const run = await h.control.startRun({ goal: 'deadline', target: {}, budget: { maxWallClockMs: 30_000, maxAgentConcurrency: 1 } });
      await h.deps.blackboard.createWorkItem(
        {
          runId: run.runId, kind: 'task', origin: { kind: 'system', reason: 't' }, title: 'late', objective: 'late work', role: 'code_change_analyst', objectiveIds: [], capabilityRequirements: [],
          inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1000, maxToolCalls: 1, maxWallClockMs: 1000 }, priority: 1, depth: 0, fingerprint: 'late', resourceClaims: [], state: 'ready',
        },
        h.ctx(run.runId),
      );
      const t1 = await h.control.tick(run.runId); // the lead is running
      h.clock.advance(31_000); // beyond the run deadline, within the lead's lease
      const t2 = await h.control.tick(run.runId);
      assert.deepEqual(t2.convergence, { state: 'exhausted', reason: 'wall_clock' });
      assert.equal(t2.final, false, 'the running lead may still finish');
      assert.deepEqual((await items(h, run.runId)).map((w) => w.state), ['claimed', 'cancelled']);
      assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, (await items(h, run.runId))[0]!.claim!.fencingToken), 'completed');
      const t3 = await h.control.tick(run.runId);
      assert.equal(t3.final, true);
      assert.deepEqual(t3.convergence, { state: 'exhausted', reason: 'wall_clock' });
      const exhausted = await h.deps.events.read(run.runId, { types: ['budget.exhausted'] });
      assert.equal((exhausted[0]!.payload as { reason: string }).reason, 'wall_clock');
    } finally {
      await h.dispose();
    }
  });

  test('tool-call budget (I12): calls beyond the run limit are refused, terminal tools are not', async () => {
    const results: Array<{ content: string; isError: boolean }> = [];
    const lead: RoleBrain = (v) => {
      if (v.lastResult) results.push(v.lastResult);
      if (v.step < 2) return call('blackboard.read', {});
      return call('complete_work', { summary: 'done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } });
    };
    const h = await createHarness({ brains: { lead } });
    try {
      const run = await h.control.startRun({ goal: 'tool budget', target: {}, budget: { maxToolCalls: 1 } });
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
      assert.equal(results[0]!.isError, false);
      assert.equal(results[1]!.isError, true);
      assert.match(results[1]!.content, /^\[denied\] budget_exhausted: the tool-call budget of run:run_\w+ is spent \(1\/1\)/);
      assert.equal((await h.deps.events.read(run.runId, { types: ['budget.exhausted'] })).length, 1);
      assert.deepEqual((await h.deps.events.read(run.runId, { types: ['tool.denied'] })).map((e) => (e.payload as { errorCode: string }).errorCode), ['budget_exhausted']);
      const t2 = await h.control.tick(run.runId);
      assert.deepEqual(t2.convergence, { state: 'exhausted', reason: 'budget' });
      assert.equal(t2.final, true);
    } finally {
      await h.dispose();
    }
  });

  test("model budget boundary with onBudgetExhausted 'pause': the item waits (never failed), the run pauses; resume without room ⇒ the exact reason, gate", async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN }, config: { onBudgetExhausted: 'pause' } });
    try {
      const run = await h.control.startRun({ goal: 'tokens', target: {}, budget: { maxModelTokens: 6000 } });
      const t = await h.control.tick(run.runId);
      const out = await h.control.executeTurn(t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken);
      assert.deepEqual(out, { status: 'paused', workItemId: t.dispatched[0]!.workItemId, reason: 'budget' });
      // the RUN ran out, not the item: it waits for the run to be resumed with its agent and session intact
      const item = (await h.deps.blackboard.getWorkItem(t.dispatched[0]!.workItemId)) as WorkItem;
      assert.deepEqual([item.state, item.waitingOn], ['waiting', [`budget:${run.runId}`]]);
      const paused = (await h.deps.runs.get(run.runId))!;
      assert.equal(paused.status, 'paused');
      assert.equal(paused.pauseReason, 'budget');
      const agent = (await h.deps.agents.byWorkItem(item.workItemId))!;
      assert.notEqual(agent.status, 'failed');
      assert.equal(h.calls.length, 0, 'no model call was made beyond the budget');
      const idle = await h.control.tick(run.runId);
      assert.equal(idle.status, 'paused');
      assert.deepEqual(idle.dispatched, []);
      // resumed WITHOUT raising the limit: still no room ⇒ the item ends with the exact reason and the gate decides
      await h.control.resumeRun(run.runId);
      const r = await drive(h, run.runId, 5);
      assert.deepEqual(r.final!.convergence, { state: 'exhausted', reason: 'budget' });
      assert.equal(r.final!.decision!.verdict, 'inconclusive');
      const ended = (await h.deps.blackboard.getWorkItem(item.workItemId)) as WorkItem;
      assert.equal(ended.failure!.reason, 'budget_exhausted');
      assert.match(ended.failure!.message, /^the run was resumed but its budget still has no room for the model call \(tokens: \d+ left, \d+ needed\): model budget exhausted at run:run_\w+ on tokens: /);
    } finally {
      await h.dispose();
    }
  });
});

describe('pause / resume / cancel', () => {
  test('a paused run dispatches nothing; resume continues; cancel interrupts agents and cancels open work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lead: RoleBrain = async (v) => {
      if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'analyse' });
      await gate;
      return call('fail_work', { reason: 'x', message: 'y' });
    };
    const h = await createHarness({ brains: { lead, code_change_analyst: () => call('blackboard.read', {}) } });
    try {
      const run = await h.control.startRun({ goal: 'cancel me', target: {} });
      await h.control.pauseRun(run.runId, 'operator');
      assert.deepEqual((await h.control.tick(run.runId)).dispatched, []);
      await h.control.resumeRun(run.runId);
      const t = await h.control.tick(run.runId);
      const leadId = t.dispatched[0]!.workItemId;
      assert.equal((await h.control.executeTurn(leadId, t.dispatched[0]!.fencingToken)).status, 'waiting');
      const t2 = await h.control.tick(run.runId);
      const child = t2.dispatched[0]!;
      assert.equal((await h.control.executeTurn(child.workItemId, child.fencingToken)).status, 'continue');
      await h.control.cancelRun(run.runId, 'operator cancelled');
      release();
      const all = await items(h, run.runId);
      assert.deepEqual(all.map((w) => w.state), ['cancelled', 'cancelled']);
      assert.deepEqual(all.map((w) => w.failure), [{ reason: 'cancelled', message: 'operator cancelled' }, { reason: 'cancelled', message: 'operator cancelled' }]);
      const agents = await h.deps.agents.list({ runId: run.runId });
      assert.deepEqual(agents.map((a) => a.status).sort(), ['interrupted', 'interrupted']);
      assert.equal((await h.deps.runs.get(run.runId))!.status, 'cancelled');
      assert.deepEqual(await h.control.executeTurn(child.workItemId, child.fencingToken), { status: 'cancelled', workItemId: child.workItemId });
      const final = await h.control.tick(run.runId);
      assert.equal(final.final, true);
      assert.equal(final.status, 'cancelled');
      await h.control.cancelRun(run.runId, 'again'); // no-op on a terminal run
      const interrupted = await h.deps.events.read(run.runId, { types: ['agent.interrupted'] });
      assert.equal(interrupted.length, 2);
      assert.ok(interrupted.every((e) => (e.payload as { reason: JsonValue }).reason === 'operator cancelled'));
    } finally {
      release?.();
      await h.dispose();
    }
  });
});
