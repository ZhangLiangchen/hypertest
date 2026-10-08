/**
 * E[3] / stubs[2] / items 10–11: budget exhaustion is POLICY-SELECTED (budget.onExhausted: gate | pause | approval, per run),
 * never a silent downgrade.
 *  - item 10: a USD-exhausted run is an exhausted run (convergence counted only `model_tokens` refusals: the live DeepSeek
 *    run spent $0.9935 of $1 while its markers said nothing the monitor read);
 *  - pause (PAUSED_BUDGET): the run pauses; an operator raise (audited) + resume continues it; a resume without a raise
 *    converges to the gate;
 *  - approval (NEEDS_APPROVAL): a budget-extension approval request, the run waits durably (a resume cannot bypass it);
 *    approved ⇒ extended by the approved amount + resumed; rejected/expired ⇒ the gate;
 *  - every dimension: tool calls, the work-item cap, experiments' own budgets pause under pause/approval too;
 *  - item 11: a cancelled run keeps no model pause.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError, type JsonValue } from '@hypertest/core';
import type { TestRun, WorkItem } from '@hypertest/domain';
import { inspectAgents } from '@hypertest/runtime';
import { createToolDispatcher, experimentActionCheck, experimentScope, runScope } from '../src/index.ts';
import { raiseRunBudget } from '../src/budget-exhaustion.ts';
import { call, createHarness, drive, route, runItem, type Harness, type RoleBrain } from './harness.ts';

const DONE: RoleBrain = () => call('complete_work', { summary: 'no plan', output: { summary: 'no plan', planProposed: false, readyForGate: false, objectives: [] } });
/** $1 / $2 per million tokens in / out (the live run's route). */
const PRO = route('ds-pro', 'alpha', { default: 0.9 }, { costPerMillionInputUsd: 1, costPerMillionOutputUsd: 2 });

async function eventsOf(h: Harness, runId: string, type: string): Promise<Array<Record<string, unknown>>> {
  return (await h.deps.events.read(runId, { types: [type] })).map((e) => e.payload as Record<string, unknown>);
}

async function policyMarkers(h: Harness, runId: string): Promise<Array<Record<string, unknown>>> {
  return (await eventsOf(h, runId, 'budget.exhausted')).filter((p) => p['policyKey'] !== undefined);
}

const human = (id: string) => ({ kind: 'human' as const, id });

describe('item 10: every run budget dimension is an exhaustion (USD included)', () => {
  test('a model call refused by the RUN USD budget ⇒ the run is exhausted (gate policy: no replan, converges to the gate)', async () => {
    const h = await createHarness({ brains: { lead: DONE }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'cost', target: {}, budget: { maxModelCostUsd: 1 } });
      await h.deps.budget.charge([runScope(run.runId)], { costUsd: 0.9935 }, 'earlier turns');
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'failed');
      const now = (await h.deps.runs.get(run.runId))!;
      // before: undefined (only model_tokens refusals were counted) — the run replanned into the same refusal
      assert.equal(await h.control.convergence.exhaustion(now), 'budget');
      const detail = await h.control.convergence.exhaustionDetail!(now);
      assert.deepEqual([detail?.dimension, detail?.scope, detail?.limit, detail?.reason], ['costUsd', runScope(run.runId), 1, 'model_cost']);
      const t2 = await h.control.tick(run.runId);
      assert.equal(t2.replanScheduled, false, 'no replan into the same refusal');
      assert.equal(t2.final, true);
      assert.equal(t2.convergence.state, 'exhausted');
      assert.equal(h.calls.length, 0, 'no model call beyond the budget');
      // a raised USD limit clears it (the refusal was at the old limit)
      await h.deps.budget.open(runScope(run.runId), { ...(await h.deps.budget.usage(runScope(run.runId)))!.limits, costUsd: 2 });
      assert.equal(await h.control.convergence.exhaustion(now), undefined);
    } finally {
      await h.dispose();
    }
  });

  test('tool calls, compute and artifact bytes at the run limit are exhaustions; the work-item cap and experiment budgets count with `caps`', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const run = await h.control.startRun({ goal: 'dims', target: {}, budget: { maxToolCalls: 3, maxWorkItems: 1 } });
      assert.equal(await h.control.convergence.exhaustion(run), undefined);
      await h.deps.budget.charge([runScope(run.runId)], { toolCalls: 3 }, 'calls');
      const d = await h.control.convergence.exhaustionDetail!(run);
      assert.deepEqual([d?.kind, d?.dimension, d?.limit, d?.used], ['budget', 'toolCalls', 3, 3]);
      // the work-item cap: only a REFUSED creation at the cap counts, and only with caps (gate: the run goes on)
      const h2 = await createHarness({ brains: { lead: DONE } });
      try {
        const r2 = await h2.control.startRun({ goal: 'cap', target: {}, budget: { maxWorkItems: 1 } });
        assert.equal(await h2.control.convergence.exhaustionDetail!(r2, { caps: true }), undefined, 'at the cap, nothing refused yet');
        await h2.deps.events.append([{ runId: r2.runId, eventType: 'budget.exhausted', aggregateType: 'budget', aggregateId: runScope(r2.runId), actorId: 'system:test', correlationId: r2.runId, payload: { scope: runScope(r2.runId), dimension: 'workItems', reason: 'work item cap reached' } }]);
        assert.equal(await h2.control.convergence.exhaustionDetail!(r2), undefined, 'gate policy: a cap refusal is not a run exhaustion');
        assert.equal((await h2.control.convergence.exhaustionDetail!(r2, { caps: true }))?.dimension, 'workItems');
      } finally {
        await h2.dispose();
      }
    } finally {
      await h.dispose();
    }
  });
});

describe("onExhausted 'pause' (PAUSED_BUDGET), selected per run", () => {
  test('the run pauses (never a failed item); a resume WITHOUT a raise converges to the gate', async () => {
    const h = await createHarness({ brains: { lead: DONE } }); // the control plane's default is 'gate': the RUN chooses pause
    try {
      const run = await h.control.startRun({ goal: 'pause', target: {}, budget: { maxModelTokens: 6000, onExhausted: 'pause' } });
      assert.equal(run.budget.onExhausted, 'pause');
      const { workItemId, fencingToken } = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.deepEqual(await h.control.executeTurn(workItemId, fencingToken), { status: 'paused', workItemId, reason: 'budget' });
      assert.deepEqual([(await h.deps.runs.get(run.runId))!.status, (await h.deps.runs.get(run.runId))!.pauseReason], ['paused', 'budget']);
      assert.deepEqual((await policyMarkers(h, run.runId)).map((p) => [p['policy'], p['policyOutcome'], p['dimension']]), [['pause', 'paused', 'tokens']]);
      // a tick of the paused run does nothing (no cancellation, no gate)
      const t = await h.control.tick(run.runId);
      assert.equal(t.final, false);
      // the operator resumes without raising: the item ends with the exact reason, the run converges to the gate
      await h.control.resumeRun(run.runId);
      assert.deepEqual(await h.control.observeWaiting(workItemId), { status: 'failed', workItemId });
      const r = await drive(h, run.runId, 10);
      assert.ok(r.final);
      assert.deepEqual((await policyMarkers(h, run.runId)).map((p) => p['policyOutcome']), ['paused', 'gate']);
      assert.match(String((await policyMarkers(h, run.runId))[1]!['detail']), /resumed without raising tokens/);
      assert.equal(h.calls.length, 0);
    } finally {
      await h.dispose();
    }
  });

  test('an operator raise (audited, added to the limits) + resume continues the SAME agent to completion', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const run = await h.control.startRun({ goal: 'raise', target: {}, budget: { maxModelTokens: 6000, onExhausted: 'pause' } });
      const { workItemId, fencingToken } = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'paused');
      const agent = (await h.deps.agents.byWorkItem(workItemId))!;
      await assert.rejects(h.control.raiseBudget!(run.runId, { maxModelTokens: -5 }, 'alice', 'more'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
      await assert.rejects(h.control.raiseBudget!(run.runId, { maxModelCostUsd: 1 }, 'alice', 'more'), (e: unknown) => isHypertestError(e, 'invalid_argument') && /not limited/.test((e as Error).message));
      await assert.rejects(h.control.raiseBudget!(run.runId, { maxModelTokens: 1000 }, 'alice', ' '), (e: unknown) => isHypertestError(e, 'invalid_argument'));
      const raised = await h.control.raiseBudget!(run.runId, { maxModelTokens: 500_000 }, 'alice', 'the suite needs more tokens');
      assert.equal(raised.budget.maxModelTokens, 506_000);
      assert.equal((await h.deps.budget.usage(runScope(run.runId)))!.limits.tokens, 506_000);
      const [ev] = await eventsOf(h, run.runId, 'budget.raised');
      assert.deepEqual([ev!['by'], ev!['rationale'], ev!['before'], ev!['after']], ['human:alice', 'the suite needs more tokens', { maxModelTokens: 6000 }, { maxModelTokens: 506_000 }]);
      await h.control.resumeRun(run.runId);
      const r = await drive(h, run.runId, 40);
      assert.ok(r.final);
      assert.equal(((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem).state, 'completed');
      assert.equal((await h.deps.agents.byWorkItem(workItemId))!.agentId, agent.agentId);
      assert.deepEqual((await policyMarkers(h, run.runId)).map((p) => p['policyOutcome']), ['paused'], 'never converged early');
      // a finished run's budget can no longer be raised
      await assert.rejects(h.control.raiseBudget!(run.runId, { maxModelTokens: 1 }, 'alice', 'late'), (e: unknown) => isHypertestError(e, 'conflict'));
    } finally {
      await h.dispose();
    }
  });

  test('the run-level tick applies the policy too: tool calls spent at the run limit pause the run (nothing cancelled)', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const run = await h.control.startRun({ goal: 'calls', target: {}, budget: { maxToolCalls: 5, onExhausted: 'pause' } });
      await h.deps.budget.charge([runScope(run.runId)], { toolCalls: 5 }, 'calls');
      const t = await h.control.tick(run.runId);
      assert.deepEqual([t.status, t.final, t.dispatched.length], ['paused', false, 0]);
      const items = await h.deps.blackboard.listWorkItems({ runId: run.runId });
      assert.deepEqual(items.map((w) => w.state), ['ready'], 'the pending lead item is kept, not cancelled');
      await h.control.raiseBudget!(run.runId, { maxToolCalls: 10 }, 'bob', 'more calls');
      await h.control.resumeRun(run.runId);
      const t2 = await h.control.tick(run.runId);
      assert.equal(t2.dispatched.length, 1, 'admission continues after the raise');
    } finally {
      await h.dispose();
    }
  });
});

describe("onExhausted 'approval' (NEEDS_APPROVAL)", () => {
  async function exhaustedRun(h: Harness, extra: Partial<TestRun['budget']> = {}): Promise<{ run: TestRun; workItemId: string }> {
    const run = await h.control.startRun({ goal: 'approval', target: {}, budget: { maxModelTokens: 6000, onExhausted: 'approval', ...extra } });
    const { workItemId, fencingToken } = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.deepEqual(await h.control.executeTurn(workItemId, fencingToken), { status: 'paused', workItemId, reason: 'approval' });
    return { run, workItemId };
  }

  test('a budget-extension request; the run waits durably (resume cannot bypass it); approved ⇒ extended by the approved amount and resumed', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const { run, workItemId } = await exhaustedRun(h);
      const now = (await h.deps.runs.get(run.runId))!;
      assert.deepEqual([now.status, now.pauseReason], ['paused', 'approval']);
      const [a] = await h.deps.approvals.list({ runId: run.runId });
      assert.ok(a);
      assert.deepEqual([a.kind, a.status, a.requestedBy], ['budget', 'pending', { kind: 'system', id: 'budget' }]);
      const subject = a.subject as { raise: { maxModelTokens: number }; dimension: string; limit: number };
      assert.deepEqual([subject.dimension, subject.limit], ['tokens', 6000]);
      assert.ok(subject.raise.maxModelTokens >= 3000, 'at least half the exhausted limit (and what the refused call needed)');
      // ticks keep it paused; a resume cannot go around the decision; agents never decide it
      assert.equal((await h.control.tick(run.runId)).final, false);
      await assert.rejects(h.control.resumeRun(run.runId), (e: unknown) => isHypertestError(e, 'precondition_failed') && new RegExp(`budget-extension approval ${a.approvalId}`).test((e as Error).message));
      await assert.rejects(h.deps.approvals.decide(a.approvalId, true, { kind: 'agent', id: 'ag_x', role: 'lead' }, 'ok', h.ctx(run.runId)), (e: unknown) => isHypertestError(e, 'permission_denied'));
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'pending');

      await h.deps.approvals.decide(a.approvalId, true, human('carol'), 'worth it', h.ctx(run.runId));
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'raised');
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'none', 'idempotent');
      const after = (await h.deps.runs.get(run.runId))!;
      assert.equal(after.status, 'running');
      assert.equal(after.budget.maxModelTokens, 6000 + subject.raise.maxModelTokens, 'extended by exactly the approved amount');
      const raised = await eventsOf(h, run.runId, 'budget.raised');
      assert.deepEqual(raised.map((p) => [p['approvalId'], p['by']]), [[a.approvalId, 'human:carol']]);
      // the SAME agent continues with the extended budget and completes its item
      const r = await drive(h, run.runId, 40);
      assert.equal(((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem).state, 'completed');
      // the replan's model call exhausts the extended budget again: a NEW request at the new limit (one approval is one
      // extension, never a blank cheque)
      assert.equal(r.final, undefined);
      const requests = await h.deps.approvals.list({ runId: run.runId });
      assert.equal(requests.length, 2);
      const second = requests[1]!;
      assert.deepEqual([second.status, (second.subject as { limit: number }).limit], ['pending', 6000 + subject.raise.maxModelTokens]);
      await h.deps.approvals.decide(second.approvalId, false, human('carol'), 'enough', h.ctx(run.runId));
      assert.ok((await drive(h, run.runId, 40)).final, 'the rejection converges to the gate');
    } finally {
      await h.dispose();
    }
  });

  test('(review) an agent-filed `budget` approval that imitates an extension request (source budget_exhaustion, a huge raise) is never applied: the run waits for the control plane\'s own request', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const { run } = await exhaustedRun(h);
      const [genuine] = await h.deps.approvals.list({ runId: run.runId });
      // an agent files a look-alike (request_approval kind budget): same source and policy key, a blank cheque
      const forged = await h.deps.approvals.request(
        {
          runId: run.runId, kind: 'budget', requestedBy: { kind: 'agent', id: 'ag_lead', role: 'lead' }, rationale: 'more budget please',
          subject: { ...(genuine!.subject as Record<string, JsonValue>), raise: { maxModelTokens: 1_000_000_000 } },
        },
        h.ctx(run.runId),
      );
      await h.deps.approvals.decide(forged.approvalId, true, human('carol'), 'sure', h.ctx(run.runId));
      // the run still waits for the genuine request: the look-alike is not an extension request of the control plane
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'pending');
      assert.equal((await h.deps.runs.get(run.runId))!.budget.maxModelTokens, 6000, 'nothing raised');
      assert.equal((await eventsOf(h, run.runId, 'budget.raised')).length, 0);
      await assert.rejects(h.control.resumeRun(run.runId), (e: unknown) => isHypertestError(e, 'precondition_failed'));
      // the genuine request decides
      await h.deps.approvals.decide(genuine!.approvalId, true, human('carol'), 'worth it', h.ctx(run.runId));
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'raised');
      const raise = (genuine!.subject as { raise: { maxModelTokens: number } }).raise.maxModelTokens;
      assert.equal((await h.deps.runs.get(run.runId))!.budget.maxModelTokens, 6000 + raise);
    } finally {
      await h.dispose();
    }
  });

  test('rejected ⇒ the run converges to the gate (the item ends with the exact reason)', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const { run, workItemId } = await exhaustedRun(h);
      const [a] = await h.deps.approvals.list({ runId: run.runId });
      await h.deps.approvals.decide(a!.approvalId, false, human('dave'), 'not worth it', h.ctx(run.runId));
      // the run's own tick applies the decision (no separate call needed)
      const r = await drive(h, run.runId, 20);
      assert.ok(r.final);
      assert.equal(((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem).state, 'failed');
      const markers = await policyMarkers(h, run.runId);
      assert.deepEqual(markers.map((p) => p['policyOutcome']), ['approval_requested', 'gate']);
      assert.match(String(markers[1]!['detail']), new RegExp(`budget extension ${a!.approvalId} was denied by human:dave \\(not worth it\\)`));
      assert.equal((await eventsOf(h, run.runId, 'budget.raised')).length, 0);
      assert.equal(h.calls.length, 0);
    } finally {
      await h.dispose();
    }
  });

  test('undecided past its window ⇒ expired ⇒ the gate', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const { run } = await exhaustedRun(h, { maxWallClockMs: 3 * 24 * 60 * 60 * 1000 });
      const [a] = await h.deps.approvals.list({ runId: run.runId });
      h.clock.advance(24 * 60 * 60 * 1000 + 1);
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'gate');
      assert.equal((await h.deps.approvals.get(a!.approvalId))!.status, 'expired');
      assert.ok((await drive(h, run.runId, 20)).final);
    } finally {
      await h.dispose();
    }
  });

  test("an experiment's own budget pauses the run on an extension request; the approved raise extends that experiment", async () => {
    const h = await createHarness({ brains: { lead: (v) => (v.step === 0 ? call('blackboard.read', {}) : DONE(v)) }, environments: [{ environmentId: 'svc', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 1 }] });
    try {
      const run0 = await h.control.startRun({ goal: 'experiment budget', target: {}, budget: { onExhausted: 'approval' } });
      const d0 = (await h.control.tick(run0.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(d0.workItemId, d0.fencingToken)).status, 'continue');
      const item = (await h.deps.blackboard.getWorkItem(d0.workItemId))!;
      const run = (await h.deps.runs.get(run0.runId))!;
      const { agent, spec } = await h.control.worker.ensureAgent(item, run, d0.fencingToken);
      const ctx = { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId };
      const snapshot = await h.deps.snapshotBuilder.build({ runId: run.runId }, ctx);
      const dispatcher = createToolDispatcher(h.deps, {
        runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: item.role, sessionId: agent.sessionId, capability: spec.capability, allow: ['experiment.define'], deny: [],
        workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }), eventContext: ctx, turnState: { turn: 700, snapshot }, fencingToken: d0.fencingToken,
      });
      const def = await dispatcher.dispatch({ id: 'p1', name: 'experiment__define', arguments: { hypothesis: 'svc accepts one write', environmentId: 'svc', isolation: { mode: 'exclusive_write', resourceClaims: [] }, budget: { maxToolCalls: 1 } } as JsonValue }, { sessionId: agent.sessionId, turn: 700, invocationId: `${agent.sessionId}:700:p1`, signal: new AbortController().signal });
      assert.equal(def.message.isError, undefined, String(def.message.content));
      const expId = String(JSON.parse(String(def.message.content)).experimentId);
      const exp = (await h.deps.specs.getExperiment(expId))!;
      const write = (n: number) => experimentActionCheck(h.deps, h.ctx(run.runId), exp, { toolId: 'http.request', invocationId: `inv-${n}`, args: { method: 'POST' }, workItemId: item.workItemId });
      assert.deepEqual(await write(1), { ok: true });
      const refused = await write(2);
      assert.equal(refused.ok, false);
      // the run's tick: the experiment budget is exhausted ⇒ the policy (approval) pauses the run on an extension request
      const t = await h.control.tick(run.runId);
      assert.equal(t.status, 'paused');
      const [a] = await h.deps.approvals.list({ runId: run.runId });
      assert.deepEqual([(a!.subject as Record<string, unknown>)['dimension'], (a!.subject as Record<string, unknown>)['raise']], ['experiment.toolCalls', { experiments: { [expId]: { maxToolCalls: 1 } } }]);
      await h.deps.approvals.decide(a!.approvalId, true, human('erin'), 'one more', h.ctx(run.runId));
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'raised');
      assert.equal((await h.deps.budget.usage(experimentScope(expId)))!.limits.toolCalls, 2);
      assert.deepEqual(await write(3), { ok: true }, 'the extended experiment acts again');
      assert.equal((await h.control.tick(run.runId)).status, 'running');
    } finally {
      await h.dispose();
    }
  });
});

describe('item 11: a cancelled run keeps no model pause', () => {
  test('cancelRun closes the run\'s model pauses (status shows no model-paused agent; L0 model.pauses_released closed)', async () => {
    const h = await createHarness({ catalog: [route('only', 'alpha', { default: 0.9 })], brains: { lead: () => ({ error: 'timeout', message: 'provider timed out' }) } });
    try {
      const run = await h.control.startRun({ goal: 'pause then cancel', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'waiting');
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      assert.ok(await h.deps.epochs.modelPause!(agent.sessionId), 'model-paused');
      await h.control.cancelRun(run.runId, 'operator abort');
      // before: the ht_model_pauses row stayed and `hypertest status` showed a paused agent of a cancelled run
      assert.equal(await h.deps.epochs.modelPause!(agent.sessionId), undefined);
      assert.deepEqual(await h.deps.epochs.listModelPauses!(run.runId), []);
      const views = await inspectAgents({ agents: h.deps.agents, engines: h.deps.engines, epochs: h.deps.epochs }, run.runId);
      assert.ok(views.every((v) => v.modelPause === undefined));
      const [closed] = await eventsOf(h, run.runId, 'model.pauses_released');
      assert.deepEqual([closed!['by'], closed!['closed'], closed!['sessions']], ['run_cancelled', true, [agent.sessionId]]);
      // idempotent: a second cancel records nothing new
      await h.control.cancelRun(run.runId, 'again');
      assert.equal((await eventsOf(h, run.runId, 'model.pauses_released')).length, 1);
    } finally {
      await h.dispose();
    }
  });
});

describe('NEEDS_APPROVAL is crash-safe', () => {
  test('an approved extension applied before a crash (raise recorded, run still paused) is finished by the next resolution, never applied twice', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const run = await h.control.startRun({ goal: 'crash between raise and resume', target: {}, budget: { maxModelTokens: 6000, onExhausted: 'approval' } });
      const { workItemId, fencingToken } = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'paused');
      const [a] = await h.deps.approvals.list({ runId: run.runId });
      await h.deps.approvals.decide(a!.approvalId, true, human('carol'), 'ok', h.ctx(run.runId));
      // the process applied the raise and died before resuming the run
      const raise = (a!.subject as { raise: { maxModelTokens: number } }).raise;
      await raiseRunBudget(h.deps, run.runId, raise, human('carol'), 'approved', h.ctx(run.runId), a!.approvalId);
      assert.deepEqual([(await h.deps.runs.get(run.runId))!.status, (await h.deps.runs.get(run.runId))!.pauseReason], ['paused', 'approval']);
      assert.equal(await h.control.resolveBudgetApproval!(run.runId), 'raised');
      const after = (await h.deps.runs.get(run.runId))!;
      assert.deepEqual([after.status, after.budget.maxModelTokens], ['running', 6000 + raise.maxModelTokens], 'resumed; raised exactly once');
      assert.equal((await eventsOf(h, run.runId, 'budget.raised')).length, 1);
    } finally {
      await h.dispose();
    }
  });
});
