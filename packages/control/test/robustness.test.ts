/**
 * Failure paths found by the adversarial review: an item ended mid-turn, a run cancelled mid-sweep, poison items,
 * final spawn refusals, transient budget reservations, pointless gate re-evaluations, interim decisions in reports,
 * late reactions on ended runs, proposal chains.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError, type EventEnvelope } from '@hypertest/core';
import type { EventContext, WorkItem } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import { BUILTIN_ROLES, EVIDENCE_PRODUCER_ROLES } from '@hypertest/agents';
import { ControlStore, runScope, tightenModelPolicy } from '../src/index.ts';
import { call, createHarness, drive, items, mustRun, runItem, type Harness, type RoleBrain } from './harness.ts';

const LEAD_DONE = { summary: 'done', output: { summary: 'done', planProposed: false, readyForGate: false, objectives: [] } };
const NO_PLAN: RoleBrain = () => call('complete_work', LEAD_DONE);

function extraItem(runId: string, title: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title, objective: `objective ${title}`, role: 'code_change_analyst', objectiveIds: [], capabilityRequirements: [],
    inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 100_000, maxToolCalls: 20, maxWallClockMs: 600_000 }, priority: 10, depth: 0,
    fingerprint: `fp-${runId}-${title}`, resourceClaims: [], state: 'ready', ...overrides,
  };
}

describe('an item that ends while its turn runs (cancelled by a plan revision / cancelRun): a domain outcome, never a thrown fault', () => {
  test('cancelled during the model call: its tool calls are refused (item cancelled) and executeTurn reports cancelled', async () => {
    let h!: Harness;
    h = await createHarness({
      brains: {
        lead: async (v) => {
          await h.deps.blackboard.transitionWorkItem(v.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'cancelled by plan revision 9' } }, { runId: v.runId, correlationId: v.workItemId, actorId: 'system:test' });
          return call('complete_work', LEAD_DONE);
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'mid-turn cancel', target: {} });
      const [d] = (await h.control.tick(run.runId)).dispatched;
      assert.deepEqual(await h.control.executeTurn(d!.workItemId, d!.fencingToken), { status: 'cancelled', workItemId: d!.workItemId });
      assert.equal((await h.deps.events.read(run.runId, { types: ['work.completed'] })).length, 0);
      const denied = (await h.deps.events.read(run.runId, { types: ['tool.denied'] })).map((e) => e.payload as { toolId: string; reason: string });
      assert.deepEqual(denied, [{ ...denied[0]!, toolId: 'complete_work', reason: `work item ${d!.workItemId} is cancelled` }]);
    } finally {
      await h.dispose();
    }
  });

  test('cancelled between the completion and the fenced item write (conflict): executeTurn reports cancelled', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN } });
    const board = h.deps.blackboard;
    const original = board.transitionWorkItem.bind(board);
    try {
      const run = await h.control.startRun({ goal: 'late cancel', target: {} });
      const [d] = (await h.control.tick(run.runId)).dispatched;
      board.transitionWorkItem = async (id, to, patch, ctx, options) => {
        if (to === 'completed') await original(id, 'cancelled', { failure: { reason: 'cancelled', message: 'cancelled concurrently' } }, ctx, {});
        return original(id, to, patch, ctx, options);
      };
      assert.deepEqual(await h.control.executeTurn(d!.workItemId, d!.fencingToken), { status: 'cancelled', workItemId: d!.workItemId });
      assert.equal((await board.getWorkItem(d!.workItemId))!.state, 'cancelled');
    } finally {
      board.transitionWorkItem = original;
      await h.dispose();
    }
  });
});

describe('cancelRun: the run first, then agents and work; a retried cancel completes the sweep', () => {
  test('a crash after the run status (cancelled) left work open: executeTurn runs no turn, a retried cancelRun sweeps the rest', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN } });
    try {
      const run = await h.control.startRun({ goal: 'cancel crash', target: {}, budget: { maxAgentConcurrency: 1 } });
      const extra = (await h.deps.blackboard.createWorkItem(extraItem(run.runId, 'extra'), h.ctx(run.runId))).workItem;
      const [d] = (await h.control.tick(run.runId)).dispatched;
      await h.deps.runs.update(run.runId, { status: 'cancelled' }, h.ctx(run.runId)); // cancelRun step 1, then a crash
      const calls = h.calls.length;
      assert.deepEqual(await h.control.executeTurn(d!.workItemId, d!.fencingToken), { status: 'cancelled', workItemId: d!.workItemId });
      assert.equal(h.calls.length, calls, 'no model call for a cancelled run');
      const lead = (await h.deps.blackboard.getWorkItem(d!.workItemId)) as WorkItem;
      assert.deepEqual([lead.state, lead.failure], ['cancelled', { reason: 'cancelled', message: `run ${run.runId} is cancelled` }]);
      assert.equal(await h.deps.leases.current(`work/${d!.workItemId}`), undefined, 'lease released');
      assert.equal((await h.deps.blackboard.getWorkItem(extra.workItemId))!.state, 'ready');
      await h.control.cancelRun(run.runId, 'operator retry');
      assert.deepEqual((await h.deps.blackboard.getWorkItem(extra.workItemId))!.failure, { reason: 'cancelled', message: 'operator retry' });
      assert.equal((await h.control.tick(run.runId)).final, true);
    } finally {
      await h.dispose();
    }
  });
});

describe('poison items and final spawn refusals never livelock the run (I12)', () => {
  test('an item that keeps losing its worker fails (lease_lost) after maxWorkAttempts instead of cycling forever', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN }, config: { maxWorkAttempts: 2 } });
    try {
      const run = await h.control.startRun({ goal: 'poison', target: {} });
      const [d1] = (await h.control.tick(run.runId)).dispatched;
      h.clock.advance(60_001);
      const [d2] = (await h.control.tick(run.runId)).dispatched;
      assert.equal(d2!.workItemId, d1!.workItemId);
      assert.equal((await h.deps.blackboard.getWorkItem(d1!.workItemId))!.attempts, 1);
      h.clock.advance(60_001);
      await h.control.tick(run.runId);
      const item = (await h.deps.blackboard.getWorkItem(d1!.workItemId)) as WorkItem;
      assert.equal(item.state, 'failed');
      assert.equal(item.attempts, 2);
      assert.equal(item.failure!.reason, 'lease_lost');
      assert.match(item.failure!.message, /the item lost its worker 2 times \(maxWorkAttempts 2\)$/);
      assert.deepEqual(await h.control.executeTurn(d2!.workItemId, d2!.fencingToken), { status: 'failed', workItemId: d2!.workItemId });
    } finally {
      await h.dispose();
    }
  });

  test('a spawn the runtime refuses for good (agent cap) fails the item instead of throwing on every dispatch', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN } });
    const subagents = h.deps.subagents;
    const original = subagents.spawn.bind(subagents);
    try {
      subagents.spawn = async () => {
        throw new HypertestError('budget_exhausted', 'run already has 100 agents (maxAgentsPerRun 100)');
      };
      const run = await h.control.startRun({ goal: 'agent cap', target: {} });
      const [d] = (await h.control.tick(run.runId)).dispatched;
      assert.deepEqual(await h.control.executeTurn(d!.workItemId, d!.fencingToken), { status: 'failed', workItemId: d!.workItemId });
      const item = (await h.deps.blackboard.getWorkItem(d!.workItemId)) as WorkItem;
      assert.deepEqual(item.failure, { reason: 'budget_exhausted', message: 'agent spawn refused (budget_exhausted): run already has 100 agents (maxAgentsPerRun 100)' });
      subagents.spawn = async () => {
        throw new HypertestError('unavailable', 'database restarting', { retryable: true });
      };
      const other = (await h.deps.blackboard.createWorkItem(extraItem(run.runId, 'transient'), h.ctx(run.runId))).workItem;
      const d2 = (await h.control.tick(run.runId)).dispatched.find((x) => x.workItemId === other.workItemId)!;
      await assert.rejects(h.control.executeTurn(d2.workItemId, d2.fencingToken), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable', 'a transient fault stays a fault (the durable runtime retries)');
      assert.equal((await h.deps.blackboard.getWorkItem(other.workItemId))!.state, 'running');
    } finally {
      subagents.spawn = original;
      await h.dispose();
    }
  });
});

describe('budget exhaustion is permanent, so it must not be declared on transient reservations', () => {
  test('in-flight reservations never exhaust the run; used tokens or an uncontended refusal do', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN } });
    try {
      const run = await h.control.startRun({ goal: 'reservations', target: {}, budget: { maxModelTokens: 20_000 } });
      await h.deps.blackboard.createWorkItem(extraItem(run.runId, 'pending', { state: 'blocked', dependsOn: ['wi_never'] }), h.ctx(run.runId));
      const scope = runScope(run.runId);
      const inFlight = await h.deps.budget.reserve([scope], { tokens: 18_000 }, 'three calls in flight');
      assert.ok(inFlight.ok);
      assert.equal(await h.control.convergence.exhaustion(run), undefined, '20000 − 0 used ≥ one call: reservations settle, the run goes on');
      const t = await h.control.tick(run.runId);
      assert.notEqual(t.convergence.state, 'exhausted');
      assert.equal((await h.deps.events.read(run.runId, { types: ['budget.exhausted'] })).length, 0, 'nothing was cancelled for budget');
      const marker = (reservedByOthers: number) => h.deps.events.append([
        { runId: run.runId, correlationId: run.runId, actorId: 'test', eventType: 'budget.exhausted', aggregateType: 'budget', aggregateId: scope, payload: { scope, reason: 'model_tokens', limit: 20_000, remaining: 100, reservedByOthers } } as never,
      ]);
      await marker(18_000);
      assert.equal(await h.control.convergence.exhaustion(run), undefined, 'a refusal caused by concurrent reservations is transient');
      await marker(0);
      assert.equal(await h.control.convergence.exhaustion(run), 'budget', 'an uncontended refusal at this limit is final');
      const fresh = await h.control.startRun({ goal: 'used up', target: {}, budget: { maxModelTokens: 20_000 } });
      await h.deps.budget.charge([runScope(fresh.runId)], { tokens: 17_000 }, 'spent');
      assert.equal(await h.control.convergence.exhaustion(fresh), 'budget', '3000 left < maxOutputTokens 4096');
    } finally {
      await h.dispose();
    }
  });
});

describe('gate feedback loop only when a replan can follow; reports show only final verdicts', () => {
  test('replan ordinal at maxPlanRevisions: the first inconclusive decision is final (no pointless second evaluation)', async () => {
    const h = await createHarness({ brains: { lead: NO_PLAN }, config: { defaultBudget: { maxPlanRevisions: 1 } } });
    try {
      const run = await h.control.startRun({ goal: 'no feedback possible', target: {} });
      const r = await drive(h, run.runId, 12);
      assert.ok(r.final);
      assert.deepEqual(r.final.convergence, { state: 'stalled', reason: 'livelock' });
      assert.equal(r.final.decision!.verdict, 'inconclusive');
      assert.equal((await h.deps.events.read(run.runId, { types: ['gate.evaluated'] })).length, 1);
      assert.equal((await new ControlStore(h.db).replans(run.runId)).gateAttempts, 1);
      assert.equal((await mustRun(h, run.runId)).decisionId, r.final.decision!.decisionId);
    } finally {
      await h.dispose();
    }
  });

  test('while the feedback replan runs, the report verdict is pending and the interim decision is labelled as such', async () => {
    const lead: RoleBrain = (v) => {
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to test', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2', status: 'dropped' }], workItems: [], readyForGate: true });
      return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'o', status: 'dropped', evidenceRefs: [] }] } });
    };
    const h = await createHarness({ brains: { lead } });
    try {
      const run = await h.control.startRun({ goal: 'interim', target: {} });
      let interimId = '';
      for (let i = 0; i < 10 && !interimId; i++) {
        const t = await h.control.tick(run.runId);
        if (t.decision && !t.final) interimId = t.decision.decisionId;
        for (const d of t.dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
      }
      assert.ok(interimId, 'an interim (feedback) decision was taken');
      const pending = await h.control.report(run.runId);
      assert.equal(pending.verdict, 'pending');
      assert.equal(pending.decision, undefined);
      assert.match(pending.markdown, new RegExp(`- \\*\\*Interim gate decision \\(not final\\):\\*\\* inconclusive \\(decision ${interimId}, revision 1\\)`));
      const r = await drive(h, run.runId, 20);
      const final = await h.control.report(run.runId);
      assert.equal(final.verdict, 'inconclusive');
      assert.equal(final.decision!.decisionId, r.final!.decision!.decisionId);
      assert.doesNotMatch(final.markdown, /Interim gate decision/);
    } finally {
      await h.dispose();
    }
  });
});

describe('reactions and proposals are bounded', () => {
  test('a late delivery of a finding event for an ended run creates no work (consumed, nothing to do)', async () => {
    const h = await createHarness();
    try {
      const run = await h.control.startRun({ goal: 'ended', target: {} });
      await h.control.cancelRun(run.runId, 'operator');
      const ctx: EventContext = { runId: run.runId, correlationId: run.runId, actorId: 'agent:late' };
      await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', payload: { title: 'late', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp-late' }, createdBy: 'agent:late' }, ctx);
      const [e] = await h.deps.events.read(run.runId, { types: ['finding.created'] });
      const env: EventEnvelope = { eventId: e!.eventId, subject: `ht.${run.runId}.finding.created`, eventType: 'finding.created', runId: run.runId, data: e, publishedAt: e!.occurredAt };
      await h.control.reactors.handleDelivered({ ...env, deliveryCount: 1 });
      assert.equal((await h.control.reactors.catchUp(run.runId)).created.length, 0);
      assert.deepEqual((await items(h, run.runId)).map((w) => [w.kind, w.state]), [['initial_plan', 'cancelled']]);
      assert.equal(await h.deps.inbox.consumed('reactors', e!.eventId), true);
    } finally {
      await h.dispose();
    }
  });

  test('work.propose cannot chain proposals beyond the run\'s maxAgentDepth', async () => {
    const results: Array<{ content: string; isError: boolean }> = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.lastResult) results.push(v.lastResult);
          if (v.step === 0) return call('work.propose', { title: 'review', objective: 'review the evidence', role: 'reviewer', rationale: 'independent review' });
          return call('complete_work', LEAD_DONE);
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'depth', target: {}, budget: { maxAgentDepth: 2 } });
      const [initial] = await items(h, run.runId);
      await h.deps.blackboard.transitionWorkItem(initial!.workItemId, 'cancelled', {}, h.ctx(run.runId));
      await h.deps.blackboard.createWorkItem(extraItem(run.runId, 'deep lead', { role: 'lead', depth: 2, priority: 99 }), h.ctx(run.runId));
      const [d] = (await h.control.tick(run.runId)).dispatched;
      assert.equal(await runItem(h.control, d!.workItemId, d!.fencingToken), 'completed');
      assert.equal(results[0]!.isError, true);
      assert.match(results[0]!.content, /permission_denied: proposed work would have depth 3, beyond the run's maxAgentDepth 2/);
      assert.equal((await items(h, run.runId)).filter((w) => w.role === 'reviewer').length, 0);
    } finally {
      await h.dispose();
    }
  });
});

describe('a plan may tighten, never weaken, a role\'s model routing policy (I3)', () => {
  test('tightenModelPolicy: unions, intersections, floors and the stricter privacy class; preferences are the item\'s', () => {
    const reviewer = BUILTIN_ROLES.find((r) => r.role === 'reviewer')!.defaultModelPolicy;
    const weakened = tightenModelPolicy(reviewer, { independentFromRoles: [], minQuality: 0.1, requiredCapabilities: [], fallback: 'revalidated', temperature: 0.7 });
    assert.deepEqual(weakened.independentFromRoles, [...EVIDENCE_PRODUCER_ROLES]);
    assert.equal(weakened.minQuality, 0.75);
    assert.deepEqual(weakened.requiredCapabilities, ['tool_use', 'structured_output', 'reasoning']);
    assert.equal(weakened.temperature, 0.7);
    const role = { allowedProviders: ['a', 'b'], prohibitedProviders: ['x'], privacyClass: 'confidential' as const, maxCostPerCallUsd: 1, fallback: 'fail_closed' as const };
    const t = tightenModelPolicy(role, { allowedProviders: ['b', 'c'], prohibitedProviders: ['y'], privacyClass: 'public', maxCostPerCallUsd: 5, fallback: 'revalidated', preferredRoutes: ['r1'] });
    assert.deepEqual(t, { allowedProviders: ['b'], prohibitedProviders: ['x', 'y'], privacyClass: 'confidential', maxCostPerCallUsd: 1, fallback: 'fail_closed', preferredRoutes: ['r1'] });
    assert.equal(tightenModelPolicy({ privacyClass: 'internal' }, { privacyClass: 'restricted' }).privacyClass, 'restricted', 'stricter is allowed');
    assert.deepEqual(tightenModelPolicy(reviewer, undefined), reviewer);
  });

  test('a planned reviewer whose item policy drops reviewer independence keeps the role\'s requirement', async () => {
    const lead: RoleBrain = (v) => {
      if (v.step === 0) {
        return call('plan.propose_revision', {
          rationale: 'review', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2' }],
          workItems: [{ localId: 'r', title: 'review', objective: 'review', role: 'reviewer', dependsOn: [], objectiveIds: ['o'], modelPolicy: { independentFromRoles: [], minQuality: 0 } }],
        });
      }
      return call('complete_work', { ...LEAD_DONE, output: { ...LEAD_DONE.output, planProposed: true } });
    };
    const h = await createHarness({ brains: { lead, reviewer: () => call('fail_work', { reason: 'x', message: 'y' }) } });
    try {
      const run = await h.control.startRun({ goal: 'policy', target: {} });
      for (let i = 0; i < 2; i++) for (const d of (await h.control.tick(run.runId)).dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
      const reviewItem = (await items(h, run.runId)).find((w) => w.role === 'reviewer')!;
      const agent = (await h.deps.agents.byWorkItem(reviewItem.workItemId))!;
      const spec = (await new ControlStore(h.db).agentHost(agent.agentId))!;
      assert.deepEqual(spec.modelPolicy.independentFromRoles, [...EVIDENCE_PRODUCER_ROLES]);
      assert.equal(spec.modelPolicy.minQuality, 0.75);
    } finally {
      await h.dispose();
    }
  });
});

describe('duplicate concurrent executeTurn deliveries (same claim) never run the turn twice', () => {
  test('the second call waits for the first and reports its outcome: one model call, one completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await createHarness({
      brains: {
        lead: async () => {
          await gate;
          return call('complete_work', LEAD_DONE);
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'duplicate delivery', target: {} });
      const [d] = (await h.control.tick(run.runId)).dispatched;
      const first = h.control.executeTurn(d!.workItemId, d!.fencingToken);
      const second = h.control.executeTurn(d!.workItemId, d!.fencingToken);
      await new Promise((r) => setTimeout(r, 50));
      release();
      assert.deepEqual(await Promise.all([first, second]), [{ status: 'completed', workItemId: d!.workItemId }, { status: 'completed', workItemId: d!.workItemId }]);
      assert.equal(h.calls.length, 1);
      assert.equal((await h.deps.events.read(run.runId, { types: ['work.completed'] })).length, 1);
    } finally {
      release();
      await h.dispose();
    }
  });
});
