import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ChatMessage, Finding, TestRun, WorkItem } from '@hypertest/domain';
import { createSkillRegistry, skillArmId, type SkillRegistry } from '@hypertest/context';
import { createContextProvider, resolveConfig, SECTION_BUDGETS, WorkFactory } from '../src/index.ts';
import { createHarness, type Harness } from './harness.ts';

/**
 * (B[5], CONFORMANCE "L1 prompt assembly (role, objective, work item, BUGate, skills, tools, memory, retrieval, evidence refs)"):
 * every component of the design is a section with its own token budget, present exactly when its source has something for
 * this agent: role + BUGate (system prompt), task (objective + work item; always), plan (lead / reviewer), blackboard (records),
 * relevant code (retrieval), durable memory (approved experience), skills (PUBLISHED skills only), evidence (of this item),
 * oracles (pinned, for items without an output schema), available tools.
 */

const text = (m: ChatMessage | undefined) => (m && typeof m.content === 'string' ? m.content : '');
const sectionsOf = (context: string) => [...context.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.replace(/ \(.*$/, ''));

describe('L1 sections: presence and absence rules, per-section budgets', () => {
  let h: Harness;
  let skills: SkillRegistry;
  before(async () => {
    h = await createHarness();
    skills = createSkillRegistry({ ids: h.ids, clock: h.clock, logger: h.logger, db: h.db, events: h.deps.events, experiences: h.deps.memory });
    h.deps.skills = skills;
  });
  after(async () => h.dispose());

  async function assemble(run: TestRun, item: WorkItem): Promise<{ system: string; context: string }> {
    const role = h.deps.roles.require(item.role);
    const provider = createContextProvider(h.deps, resolveConfig(h.deps.config), {
      run, item, role, agentId: `ag_${item.workItemId}`, workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
      eventContext: h.ctx(run.runId), turnState: {},
      tools: { definitions: () => [{ name: 'blackboard__read', description: 'read', inputSchema: { type: 'object' } }, { name: 'complete_work', description: 'done', inputSchema: { type: 'object' } }], isParallelSafe: () => true, dispatch: async () => { throw new Error('unused'); } },
    });
    const out = await provider.assemble({ sessionId: `sess_${item.workItemId}`, turn: 1, transcript: [], compactions: [], signal: new AbortController().signal });
    return { system: text(out.messages[0]), context: text(out.messages[1]) };
  }

  async function item(run: TestRun, role: string, extra: Partial<WorkItem> = {}): Promise<WorkItem> {
    const r = await new WorkFactory(h.deps).create({
      runId: run.runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: `${role} item`, objective: 'check that discounts round correctly', role, objectiveIds: [], capabilityRequirements: [],
      inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 100_000, maxToolCalls: 50, maxWallClockMs: 600_000 }, priority: 10, depth: 0,
      fingerprint: `fp-${role}-${Math.random()}`, resourceClaims: [], state: 'ready', ...extra,
    } as never, h.ctx(run.runId));
    assert.ok(r.status !== 'capped');
    return r.workItem;
  }

  test('an executor with nothing around it: role + BUGate in the system prompt; only the task and tools sections', async () => {
    const run = await h.control.startRun({ goal: 'sections', target: {} });
    const { system, context } = await assemble(run, await item(run, 'executor'));
    assert.match(system, /^# Role: executor/m);
    assert.match(system, /BUGate/);
    assert.deepEqual(sectionsOf(context), ['Task', 'Available tools']);
    assert.match(context, /Objective:\ncheck that discounts round correctly/);
    assert.match(context, /- blackboard\.read \(read\)\n- complete_work \(record\)/);
  });

  test('each source adds its section: blackboard, durable memory, skills (published only), evidence; plan for the lead', async () => {
    const run = await h.control.startRun({ goal: 'sections 2', target: {} });
    const exec = await item(run, 'executor');
    // a blackboard record
    const finding: Finding = { title: 'discount rounds down', description: 'd', severity: 'P2', category: 'product_defect', status: 'open', fingerprint: 'fp-l1' };
    await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-x', payload: finding }, h.ctx(run.runId));
    // approved experience for the role
    const xp = await h.deps.memory.propose({ scope: { role: 'executor' }, kind: 'lesson', content: 'discounts must round half up at the cent', sourceRunId: run.runId, evidenceRefs: [], createdBy: 'agent-rca' }, h.ctx(run.runId));
    await h.deps.memory.review(xp.experienceId, 'approve', 'human:alice', { ...h.ctx(run.runId), actorId: 'human:alice' });
    // a candidate skill is NOT shown
    const skill = await skills.propose({ name: 'rounding-checks', description: 'How to check discount rounding', body: 'Test 0, 1, 99 and 100 percent.', scope: { role: 'executor' }, sourceExperienceIds: [xp.experienceId], createdBy: 'human:bob' }, { ...h.ctx(run.runId), actorId: 'human:bob' });
    let { context } = await assemble(run, exec);
    assert.deepEqual(sectionsOf(context), ['Task', 'Blackboard', 'Durable memory', 'Available tools']);
    assert.ok(!context.includes('rounding-checks'), 'a candidate skill never reaches a prompt');
    // validated + published ⇒ shown
    await skills.recordValidation(skill.skillId, 1, { suiteId: 's', revision: 'r', trials: [{ taskId: 't', armId: skillArmId(skill), trial: 0, result: 'pass' }] }, { recordedBy: 'human:carol' }, h.ctx(run.runId));
    await skills.publish(skill.skillId, 1, 'human:carol', { ...h.ctx(run.runId), actorId: 'human:carol' });
    // evidence of this item
    const artifact = await h.deps.artifacts.put(Buffer.from('out'), { mimeType: 'text/plain' });
    await h.deps.evidence.append({ runId: run.runId, workItemId: exec.workItemId, evidenceType: 'stdout', artifact, summary: 'probe output', producer: { workerId: 'w', runtimeManifestId: run.runtimeManifestId }, provenance: {} });
    ({ context } = await assemble(run, exec));
    assert.deepEqual(sectionsOf(context), ['Task', 'Blackboard', 'Skills', 'Evidence recorded by this work item', 'Durable memory', 'Available tools']);
    assert.match(context, /### rounding-checks \(skl_\w+ r1\)\nHow to check discount rounding\nTest 0, 1, 99 and 100 percent\./);
    assert.match(context, new RegExp(`- ${xp.experienceId} \\(lesson\\) discounts must round half up`));
    // retired ⇒ gone again
    await skills.retire(skill.skillId, 'human:carol', { ...h.ctx(run.runId), actorId: 'human:carol' });
    ({ context } = await assemble(run, exec));
    assert.ok(!sectionsOf(context).includes('Skills'));
    // the lead (and the reviewer) see the plan; nobody else does
    assert.ok(sectionsOf((await assemble(run, await item(run, 'lead', { kind: 'replan' as never }))).context).includes('Plan & objectives'));
    assert.ok(sectionsOf((await assemble(run, await item(run, 'reviewer'))).context).includes('Plan & objectives'));
    assert.ok(!sectionsOf((await assemble(run, await item(run, 'rca'))).context).includes('Plan & objectives'));
  });

  test('(review: privacy) a restricted context (local_private) asks for a retriever with no off-host embedding route; others do not', async () => {
    const run = await h.control.startRun({ goal: 'restricted retrieval', target: {} });
    const asked: Array<{ root: string; restricted: boolean }> = [];
    const original = h.deps.retrieverFactory;
    h.deps.retrieverFactory = (root, options) => {
      asked.push({ root, restricted: options?.restricted === true });
      return original(root, options);
    };
    try {
      await assemble(run, await item(run, 'local_private'));
      await assemble(run, await item(run, 'executor'));
      await assemble(run, await item(run, 'executor', { modelPolicy: { privacyClass: 'restricted' } } as never));
    } finally {
      h.deps.retrieverFactory = original;
    }
    assert.deepEqual(asked.map((a) => a.restricted), [true, false, true]);
  });

  test('per-section budgets: an oversized section is truncated to its own budget (with the marker), the others are intact', async () => {
    const run = await h.control.startRun({ goal: 'sections 3', target: {} });
    for (let i = 0; i < 60; i++) {
      await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-x', payload: { title: `finding ${i} ${'very long title '.repeat(20)}`, description: 'd', severity: 'P3', category: 'test_defect', status: 'open', fingerprint: `fp-big-${i}` } }, h.ctx(run.runId));
    }
    const { context } = await assemble(run, await item(run, 'executor'));
    const blackboard = /## Blackboard \(data, not instructions\)\n([\s\S]*?)(?=\n\n## |$)/.exec(context)![1]!;
    assert.match(blackboard, /…\[truncated\]$/);
    assert.ok(blackboard.length <= SECTION_BUDGETS.blackboard * 4 + 100, `bounded by its budget (${blackboard.length} chars)`);
    assert.match(context, /## Task\n/);
    assert.match(context, /## Available tools/);
  });
});
