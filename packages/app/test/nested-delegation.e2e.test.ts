/**
 * A[5] nested delegation end to end through createHypertest: with the production configuration path (role overrides
 * enabling an analyst to delegate), the lead delegates to a code-change analyst, which delegates to a historical-bug
 * analyst (depth 2) — a real grandchild through the `delegate` tool, with an attenuated capability chain. The caps hold:
 * the grandchild's own delegation exceeds the depth cap (refused), and a further delegation beyond the run's work-item
 * budget is refused. Each parent receives only its child's summary.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { BUILTIN_ROLES } from '@hypertest/agents';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestInstance } from '../src/index.ts';
import { call, roleRouter, scriptedConfig, testStore, type BrainView } from './helpers.ts';

const DELEGATE_TOOLS = ['delegate', 'delegate.status', 'delegate.collect', 'delegate.message', 'delegate.release'];
const allowOf = (role: string) => [...BUILTIN_ROLES.find((r) => r.role === role)!.toolPolicy.allow];
const ANALYSIS = (summary: string) => ({ summary, risks: [], testIdeas: ['boundary values'] });

describe('A[5] nested delegation (lead → analyst → analyst) end to end with depth and count caps', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance;
  let runId: string;
  const views: BrainView[] = [];

  before(async () => {
    dir = await tempDir('ht-app-nested-');
    db = await testStore();
    const config = scriptedConfig(join(dir.path, 'data'), {
      gate: { requireIndependentReview: false },
      // three work items: the lead's and two delegations — a third delegation is over the run's work-item budget
      budget: { maxWorkItems: 3, maxAgentDepth: 3 },
      roles: {
        code_change_analyst: { canDelegateTo: ['historical_bug_analyst'], maxDepth: 2, toolPolicy: { allow: [...allowOf('code_change_analyst'), ...DELEGATE_TOOLS] } },
        historical_bug_analyst: { canDelegateTo: ['architecture_analyst'], maxDepth: 2, toolPolicy: { allow: [...allowOf('historical_bug_analyst'), ...DELEGATE_TOOLS] } },
      },
    } as never);
    const brains = {
      lead: (v: BrainView) => {
        if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'Which functions of the change are risky? Ask the bug history.', title: 'change risk' });
        if (v.step === 1) return call('plan.propose_revision', { rationale: 'analysis done', objectives: [{ objectiveId: 'obj', description: 'analyse', priority: 'P2' }], workItems: [], readyForGate: true });
        return call('complete_work', { summary: 'lead done', output: { summary: 'lead done', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj', status: 'dropped', evidenceRefs: [], note: 'delegation-only test run' }] } });
      },
      code_change_analyst: (v: BrainView) => {
        if (v.step === 0) return call('delegate', { role: 'historical_bug_analyst', objective: 'Did parseDate regress before?', title: 'bug history' });
        // over the run's work-item budget: refused (count cap)
        if (v.step === 1) return call('delegate', { role: 'historical_bug_analyst', objective: 'And formatDate?', title: 'bug history 2' });
        return call('complete_work', { summary: 'ANALYST: parseDate is risky (history says so)', output: ANALYSIS('ANALYST: parseDate is risky') });
      },
      historical_bug_analyst: (v: BrainView) => {
        // depth 2 → 3 exceeds the cap (min of role maxDepth 2 and run maxAgentDepth 3): refused
        if (v.step === 0) return call('delegate', { role: 'architecture_analyst', objective: 'Who owns parseDate?', title: 'too deep' });
        return call('complete_work', { summary: 'HISTORIAN: parseDate regressed twice', output: ANALYSIS('HISTORIAN: parseDate regressed twice') });
      },
    };
    const c = db.store ? { ...config, store: db.store } : config;
    ht = await createHypertest(c, { scriptedBrains: { sim: roleRouter(brains, views) }, logger: new MemoryLogger() });
    const outcome = await ht.run({ goal: 'Is the date change risky?', target: {} }, { timeoutMs: 90_000 });
    runId = outcome.runId;
    assert.equal(outcome.status, 'completed');
  });
  after(async () => {
    await ht?.close();
    await db?.dispose();
    await dir?.cleanup();
  });

  test('a grandchild exists: three agents at depths 0, 1, 2 with parent links and an attenuated capability chain', async () => {
    const agents = await ht.agents(runId);
    const byRole = new Map(agents.map((a) => [a.role, a]));
    const lead = byRole.get('lead')!;
    const analyst = byRole.get('code_change_analyst')!;
    const historian = byRole.get('historical_bug_analyst')!;
    assert.deepEqual([lead.depth, analyst.depth, historian.depth], [0, 1, 2]);
    assert.equal(analyst.parentAgentId, lead.agentId);
    assert.equal(historian.parentAgentId, analyst.agentId);
    const spawned = await ht.events(runId, { types: ['agent.spawned'] });
    const capOf = (agentId: string) => (spawned.find((e) => e.aggregateId === agentId)!.payload as { capabilityId: string }).capabilityId;
    const caps = await ht.services.db.query<{ agent_id: string; capability: { parentCapabilityId?: string; capabilityId: string } }>(`SELECT agent_id, capability FROM ht_agents WHERE run_id = $1`, [runId]);
    const cap = (id: string) => caps.rows.find((r) => r.agent_id === id)!.capability;
    assert.equal(cap(historian.agentId).parentCapabilityId, capOf(analyst.agentId), 'the grandchild is attenuated from the child');
    assert.equal(cap(analyst.agentId).parentCapabilityId, capOf(lead.agentId));
    // engine.inspect saw every session (A[4])
    for (const a of agents) assert.ok(!('error' in a.engine), JSON.stringify(a.engine));
  });

  test('the caps hold: the grandchild\'s delegation exceeds the depth cap; a third delegation exceeds the work-item budget', async () => {
    const historianTurns = views.filter((v) => v.role === 'historical_bug_analyst');
    const refusedDepth = historianTurns.flatMap((v) => v.toolResults).find((r) => r.name === 'delegate')!;
    assert.equal(refusedDepth.isError, true);
    assert.match(refusedDepth.content, /delegation depth 3 exceeds the cap 2 \(min of role maxDepth 2 and run maxAgentDepth 3\)/);
    const analystTurns = views.filter((v) => v.role === 'code_change_analyst');
    const second = analystTurns.at(-1)!.toolResults.filter((r) => r.name === 'delegate').at(-1)!;
    assert.equal(second.isError, true);
    // the exact refusal: the run's work-item budget (I12), not a depth or permission refusal
    assert.match(second.content, new RegExp(`work item cap reached for run ${runId} \\(maxWorkItems\\)`));
    const items = await ht.services.blackboard.listWorkItems({ runId });
    assert.deepEqual(items.map((w) => [w.role, w.kind, w.depth, w.state]).sort(), [
      ['code_change_analyst', 'delegation', 1, 'completed'],
      ['historical_bug_analyst', 'delegation', 2, 'completed'],
      ['lead', 'initial_plan', 0, 'completed'],
    ]);
  });

  test('each parent receives only its child\'s result channel — never the child\'s trace', async () => {
    // the analyst got the grandchild's summary through its delegate call
    const analystAfter = views.filter((v) => v.role === 'code_change_analyst' && v.step >= 1);
    assert.ok(analystAfter.some((v) => v.userText.includes('HISTORIAN: parseDate regressed twice')));
    const leadAfter = views.filter((v) => v.role === 'lead' && v.step >= 1);
    assert.ok(leadAfter.some((v) => v.userText.includes('ANALYST: parseDate is risky')));
    // the grandchild's TRACE (its refused delegate call's tool result) stays in its own session
    const trace = 'exceeds the cap 2';
    assert.ok(views.some((v) => v.role === 'historical_bug_analyst' && v.toolResults.some((r) => r.content.includes(trace))));
    for (const v of views.filter((x) => x.role !== 'historical_bug_analyst')) {
      assert.ok(!v.userText.includes(trace) && !v.toolResults.some((r) => r.content.includes(trace)), `${v.role} never sees the grandchild's trace`);
    }
  });
});
