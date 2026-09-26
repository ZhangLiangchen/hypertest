import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WorkItem } from '@hypertest/domain';
import { agentHeader, parseAgentHeader } from '../src/index.ts';
import { call, createHarness, runItem, type BrainView, type RoleBrain } from './harness.ts';

describe('context assembly (L1/L2)', () => {
  test('the system prompt starts with the machine-readable header, carries the role prompt and the BUGate protocol; sections are assembled', async () => {
    const views: BrainView[] = [];
    const lead: RoleBrain = (v) => {
      views.push(v);
      return call('complete_work', { summary: 'ok', output: { summary: 'ok', planProposed: false, readyForGate: false, objectives: [] } });
    };
    const h = await createHarness({ brains: { lead } });
    try {
      const run = await h.control.startRun({ goal: 'context goal', target: { description: 'svc' } });
      const t = await h.control.tick(run.runId);
      const d = t.dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
      const [v] = views;
      const firstLine = v!.system.split('\n')[0]!;
      assert.equal(firstLine, `[hypertest role=lead work_item=${d.workItemId} kind=initial_plan run=${run.runId}]`);
      assert.deepEqual(parseAgentHeader(v!.system), { role: 'lead', workItemId: d.workItemId, kind: 'initial_plan', runId: run.runId });
      assert.equal(agentHeader({ role: 'x', workItemId: 'wi_1', kind: 'task', runId: 'run_1' }), '[hypertest role=x work_item=wi_1 kind=task run=run_1]');
      assert.match(v!.system, /^# Role: lead — lead test strategist$/m);
      assert.match(v!.system, /Run goal: context goal/);
      assert.match(v!.system, /## Governing protocol \(BUGate\)\n[^\n]*BUGate/);
      assert.match(v!.system, /Context snapshot: cs_\w+/);
      const context = v!.request.messages[1]!;
      assert.equal(context.role, 'user');
      const text = context.role === 'user' && typeof context.content === 'string' ? context.content : '';
      assert.match(text, /## Task\nWork item wi_\w+ \(initial_plan, role lead, priority 100, attempt 1\)/);
      assert.match(text, /Expected output of complete_work \(JSON Schema, validated deterministically\)/);
      assert.match(text, /## Plan & objectives\nNo plan revision accepted yet\./);
      // the turn-0 task message is in the transcript
      assert.match(v!.userText, /# Work item wi_\w+: Plan v1: analyse the goal and propose the first plan/);
      // the snapshot of the turn is pinned to the run
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      const turn = (await h.deps.sessions.getTurn(agent.sessionId, 1))!;
      const snapshot = (await h.deps.snapshots.get(turn.snapshotId!))!;
      assert.equal(snapshot.runtimeManifestId, run.runtimeManifestId);
    } finally {
      await h.dispose();
    }
  });

  test('hard context pressure ⇒ LLM condenser compaction (context.compacted); a failing condenser falls back to the deterministic summarizer', async () => {
    for (const condenserFails of [false, true]) {
      const views: BrainView[] = [];
      let n = 0; // a counter, not the transcript: condensation shortens what the model sees
      const lead: RoleBrain = (v) => {
        views.push(v);
        if (n++ < 7) return call('blackboard.read', { status: `status-${n}-${'x'.repeat(700)}` });
        return call('complete_work', { summary: 'ok', output: { summary: 'ok', planProposed: false, readyForGate: false, objectives: [] } });
      };
      const condenser: RoleBrain = () => (condenserFails ? { error: 'provider_error', message: 'condenser down' } : { text: 'CONDENSED: the lead read the blackboard seven times.' });
      const h = await createHarness({ brains: { lead, condenser }, config: { maxInlineContextTokens: 1500 } });
      try {
        const run = await h.control.startRun({ goal: 'long context', target: {} });
        const t = await h.control.tick(run.runId);
        const d = t.dispatched[0]!;
        const st = await runItem(h.control, d.workItemId, d.fencingToken);
        assert.equal(st, 'completed', JSON.stringify((await h.deps.blackboard.getWorkItem(d.workItemId))!.failure));
        const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
        const compactions = await h.deps.sessions.compactions(agent.sessionId);
        assert.ok(compactions.length >= 1, 'at least one compaction');
        const events = await h.deps.events.read(run.runId, { types: ['context.compacted'] });
        assert.equal(events.length, compactions.length);
        assert.equal(events[0]!.workItemId, d.workItemId);
        const last = views[views.length - 1]!;
        if (condenserFails) {
          assert.ok(!compactions[0]!.summary.includes('CONDENSED'));
          assert.ok(h.logger.entries.some((e) => e.msg === 'LLM condenser unavailable; using the deterministic summarizer'));
        } else {
          assert.match(compactions[0]!.summary, /CONDENSED: the lead read the blackboard seven times\./);
          assert.match(JSON.stringify(last.request.messages), /CONDENSED: the lead read the blackboard seven times\./);
          assert.ok(h.calls.some((c) => c.role === 'condenser'));
        }
      } finally {
        await h.dispose();
      }
    }
  });
});

describe('executeTurn idempotency and work budgets', () => {
  test('expectedTurn: a durable retry of an already committed turn does not run the model again', async () => {
    const lead: RoleBrain = (v) => (v.step === 0 ? call('blackboard.read', {}) : call('complete_work', { summary: 'ok', output: { summary: 'ok', planProposed: false, readyForGate: false, objectives: [] } }));
    const h = await createHarness({ brains: { lead } });
    try {
      const run = await h.control.startRun({ goal: 'idempotent', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.deepEqual(await h.control.executeTurn(d.workItemId, d.fencingToken, undefined, { expectedTurn: 1 }), { status: 'continue', workItemId: d.workItemId, turn: 1 });
      const calls = h.calls.length;
      assert.deepEqual(await h.control.executeTurn(d.workItemId, d.fencingToken, undefined, { expectedTurn: 1 }), { status: 'continue', workItemId: d.workItemId, turn: 1 });
      assert.equal(h.calls.length, calls, 'the committed turn was not re-run');
      assert.deepEqual(await h.control.executeTurn(d.workItemId, d.fencingToken, undefined, { expectedTurn: 2 }), { status: 'completed', workItemId: d.workItemId });
      assert.deepEqual(await h.control.executeTurn(d.workItemId, d.fencingToken), { status: 'completed', workItemId: d.workItemId }, 'a terminal item returns its status');
    } finally {
      await h.dispose();
    }
  });

  test('the work item turn budget ends a looping agent as failed/budget_exhausted (never silently downgraded)', async () => {
    const lead: RoleBrain = (v) => {
      if (v.kind !== 'initial_plan') return call('complete_work', { summary: 'x', output: { summary: 'x', planProposed: false, readyForGate: false, objectives: [] } });
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'r', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P3' }], workItems: [{ localId: 'a', title: 'loop', objective: 'loop', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['o'], budget: { maxTurns: 3 } }] });
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
    };
    const analyst: RoleBrain = (v) => call('blackboard.read', { limit: v.step + 1 });
    const h = await createHarness({ brains: { lead, code_change_analyst: analyst } });
    try {
      const run = await h.control.startRun({ goal: 'budget', target: {} });
      const t1 = await h.control.tick(run.runId);
      await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken);
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'failed');
      const item = (await h.deps.blackboard.getWorkItem(d.workItemId)) as WorkItem;
      assert.deepEqual(item.failure, { reason: 'budget_exhausted', message: 'maxTurns 3 reached' });
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      assert.equal(agent.status, 'failed');
      assert.equal((await h.deps.sessions.get(agent.sessionId))!.turnCount, 3);
      const exhausted = await h.deps.events.read(run.runId, { types: ['budget.exhausted'] });
      assert.equal((exhausted[0]!.payload as { reason: string }).reason, 'maxTurns 3 reached');
    } finally {
      await h.dispose();
    }
  });
});
