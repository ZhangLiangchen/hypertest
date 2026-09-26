/**
 * I2 (BLUEPRINT §1.2; improvements §安全与权限边界): an agent's capability is
 *   parent ∩ role policy ∩ WorkItem.capabilityRequirements ∩ environment policy — never amplified.
 * A seeded property test over generated parents, role constraints, requirements and registered environments, then the
 * worker end to end: a delegated child and a planned root item whose requirements exceed their grant get a capability
 * WITHOUT the excess, and the missing part is reported in their task message (and on L0).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { ActionCapability, CapabilityRequirement, RiskClass, ToolEffect } from '@hypertest/domain';
import { attenuateCapability, resourcePatternCovers, type CapabilityConstraints } from '@hypertest/policy';
import { capabilityAmplification } from '@hypertest/runtime';
import { BASELINE_EFFECTS, addressesEnvironments, describeUnmet, requirementProblems, unmetRequirements, workItemConstraint } from '../src/index.ts';
import { call, createHarness, items, parsed, runItem, type BrainView } from './harness.ts';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EFFECTS: ToolEffect[] = ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'];
const RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const CLASSES = ['local', 'sandbox', 'staging', 'production'];
const SCOPES = ['**', 'workspace/**', 'workspace/ws_1/**', 'workspace/ws_2/**', 'workspace/ws_1/src/**', 'run/**', 'run/run_1/**', 'env/**', 'env/staging/**', 'env/sbx/**', 'loadgen/**', 'loadjob/**'];

function subset<T>(r: () => number, xs: readonly T[], p = 0.5): T[] {
  return xs.filter(() => r() < p);
}
function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function parentCap(r: () => number): ActionCapability {
  return {
    capabilityId: 'cap_parent', runId: 'run_1', subjectAgentId: 'ag_parent', workItemId: 'wi_parent',
    tools: r() < 0.3 ? ['*'] : subset(r, ['fs.*', 'git.*', 'test.run', 'http.request', 'blackboard.*', 'complete_work']),
    resourceScopes: r() < 0.3 ? ['**'] : subset(r, SCOPES, 0.4),
    allowedEffects: subset(r, EFFECTS, 0.75),
    credentialScopes: subset(r, ['workspace:product_write']),
    maxRiskClass: pick(r, RISKS),
    environmentClasses: subset(r, CLASSES, 0.75),
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

function roleConstraint(r: () => number): CapabilityConstraints {
  return {
    tools: subset(r, ['fs.*', 'git.diff', 'test.run', 'http.request', 'blackboard.read', 'complete_work', 'fail_work'], 0.6),
    resourceScopes: ['workspace/ws_1/**', 'run/run_1/**', ...subset(r, ['env/**', 'loadgen/**', 'loadjob/**'])],
    allowedEffects: subset(r, EFFECTS, 0.75),
    environmentClasses: subset(r, CLASSES, 0.75),
    credentialScopes: [],
    maxRiskClass: pick(r, RISKS),
    expiresAt: '2029-01-01T00:00:00.000Z',
  };
}

/** Requirement scopes: mostly inside the role's scopes (grantable), sometimes anything (the excess). */
const LIKELY = ['workspace/ws_1/**', 'workspace/ws_1/src/**', 'run/run_1/**', 'env/staging/**', 'env/**'];

function requirements(r: () => number): CapabilityRequirement[] {
  const n = Math.floor(r() * 5);
  const out: CapabilityRequirement[] = [];
  for (let i = 0; i < n; i++) {
    const req: CapabilityRequirement = { effect: pick(r, EFFECTS), resourceScopes: r() < 0.7 ? [pick(r, LIKELY)] : subset(r, SCOPES, 0.2) };
    if (req.resourceScopes.length === 0) req.resourceScopes = [pick(r, SCOPES)];
    if (r() < 0.4) req.environmentClass = pick(r, CLASSES);
    out.push(req);
  }
  return out;
}

const covers = (cap: ActionCapability, req: CapabilityRequirement) =>
  (cap.allowedEffects as string[]).includes(req.effect) &&
  req.resourceScopes.every((s) => cap.resourceScopes.some((p) => resourcePatternCovers(p, s))) &&
  (req.environmentClass === undefined || cap.environmentClasses.includes(req.environmentClass));

/**
 * `covers`, plus the environment dimension of a requirement WITHOUT a class: it asks for its scopes in every class the
 * other operands allow (`universe`), unless its scopes are agent-local (workspace files, run records: never classified).
 */
const coversIn = (cap: ActionCapability, req: CapabilityRequirement, universe: readonly string[]) =>
  covers(cap, req) && (req.environmentClass !== undefined || !addressesEnvironments(req) || universe.every((c) => cap.environmentClasses.includes(c)));

const within = (cap: ActionCapability, c: CapabilityConstraints) =>
  (c.allowedEffects === undefined || cap.allowedEffects.every((e) => c.allowedEffects!.includes(e))) &&
  (c.resourceScopes === undefined || cap.resourceScopes.every((s) => c.resourceScopes!.some((p) => resourcePatternCovers(p, s)))) &&
  (c.environmentClasses === undefined || cap.environmentClasses.every((e) => c.environmentClasses!.includes(e)));

describe('I2 property: parent ∩ role ∩ work item ∩ environment, over generated requirements', () => {
  test('never amplified; inside every operand; a requirement is granted iff the other operands allow it; the unmet report is exact', () => {
    const r = prng(0xc0ffee);
    let granted = 0;
    let unmetSeen = 0;
    let mixed = 0;
    for (let i = 0; i < 600; i++) {
      const parent = parentCap(r);
      const role = roleConstraint(r);
      const reqs = requirements(r);
      const registered = ['local', ...subset(r, CLASSES.slice(1))];
      const environment: CapabilityConstraints = { environmentClasses: registered };
      const wi = workItemConstraint(reqs, ['workspace/ws_1/**', 'run/run_1/**']);
      assert.equal(wi === undefined, reqs.length === 0, 'no requirements, no work-item constraint');
      const child = attenuateCapability(parent, [role, ...(wi ? [wi] : []), environment], { subjectAgentId: 'ag_child', workItemId: 'wi_child' });
      const withoutWorkItem = attenuateCapability(parent, [role, environment], { subjectAgentId: 'ag_child', workItemId: 'wi_child' });
      const ctx = `case ${i}: ${JSON.stringify({ parent, role, reqs, registered })}`;
      // never amplified, and inside each operand of the intersection
      assert.equal(capabilityAmplification(child, parent), undefined, ctx);
      assert.equal(capabilityAmplification(child, withoutWorkItem), undefined, ctx);
      assert.ok(within(child, role), `role: ${ctx}`);
      assert.ok(within(child, environment), `environment: ${ctx}`);
      if (wi) {
        assert.ok(within(child, wi), `work item: ${ctx}`);
        // the work item grants no effect beyond the baseline and what it requires
        for (const e of child.allowedEffects) assert.ok(BASELINE_EFFECTS.includes(e) || reqs.some((q) => q.effect === e), `${e} was not required: ${ctx}`);
      } else {
        assert.deepEqual(child.allowedEffects, withoutWorkItem.allowedEffects, ctx);
        assert.deepEqual(child.resourceScopes, withoutWorkItem.resourceScopes, ctx);
      }
      // completeness: a requirement the other operands allow is granted (the work item never over-restricts it)
      const unmet = unmetRequirements(child, reqs);
      let classless = false;
      for (const q of reqs) {
        // a classless requirement on environment-addressable scopes keeps every class the other operands allow (it is
        // never silently confined to the classes other requirements name — that loss would not be in the unmet report)
        if (covers(withoutWorkItem, q)) assert.ok(coversIn(child, q, withoutWorkItem.environmentClasses), `requirement ${JSON.stringify(q)} lost: ${ctx}`);
        if (q.environmentClass === undefined && addressesEnvironments(q) && reqs.some((o) => o.environmentClass !== undefined)) classless = true;
        const reported = unmet.some((u) => u.requirement === q);
        assert.equal(reported, !covers(child, q), `unmet report of ${JSON.stringify(q)}: ${ctx}`);
        if (covers(child, q)) granted++;
        else unmetSeen++;
      }
      for (const u of unmet) assert.ok(u.missing.length > 0);
      if (classless) mixed++;
    }
    assert.ok(granted > 50 && unmetSeen > 50, `the generator exercises both outcomes (granted ${granted}, unmet ${unmetSeen})`);
    assert.ok(mixed > 20, `the generator mixes classless environment requirements with classed ones (${mixed})`);
  });

  test('requirement validation: unknown effects, empty or non-canonical scopes and empty classes are problems', () => {
    assert.deepEqual(requirementProblems([{ effect: 'read', resourceScopes: ['env/**'], environmentClass: 'staging' }]), []);
    assert.deepEqual(requirementProblems('x'), ['capabilityRequirements must be a list']);
    const problems = requirementProblems([{ effect: 'teleport', resourceScopes: [] }, { effect: 'read', resourceScopes: ['workspace/../etc', ''] }, { effect: 'read', resourceScopes: ['a'], environmentClass: '' }, 7]);
    assert.deepEqual(problems, [
      'capabilityRequirements[0].effect must be one of read, record, write_workspace, execute, external, destructive',
      'capabilityRequirements[0].resourceScopes must be a non-empty list',
      'capabilityRequirements[1].resourceScopes: "workspace/../etc" is not a canonical resource pattern (segment "..")',
      'capabilityRequirements[1].resourceScopes: "" is not a canonical resource pattern (empty resource key)',
      'capabilityRequirements[2].environmentClass must be a non-empty string',
      'capabilityRequirements[3] must be an object',
    ]);
    const unmet = unmetRequirements(
      { capabilityId: 'c', runId: 'r', subjectAgentId: 'a', workItemId: 'w', tools: ['*'], resourceScopes: ['env/sbx/**'], allowedEffects: ['read'], credentialScopes: [], maxRiskClass: 'low', environmentClasses: ['local'], expiresAt: '2030-01-01T00:00:00.000Z' },
      [{ effect: 'external', resourceScopes: ['env/**'], environmentClass: 'staging' }],
    );
    assert.deepEqual(describeUnmet(unmet), ['external on env/** in staging: not granted — effect external; resource scope env/** (granted only env/sbx/**); environment class staging']);
  });

  test('environment classes: named classes confine the grant unless a classless requirement may address environments', () => {
    const base = ['workspace/ws_1/**', 'run/run_1/**'];
    // agent-local scopes (workspace files, run records) need no class: the named class confines the grant
    assert.deepEqual(workItemConstraint([{ effect: 'external', resourceScopes: ['env/**'], environmentClass: 'sandbox' }, { effect: 'execute', resourceScopes: ['workspace/**'] }], base)!.environmentClasses, ['sandbox']);
    assert.equal(addressesEnvironments({ resourceScopes: ['workspace/**', 'run/run_1/**'] }), false);
    // a classless requirement on environment-addressable scopes asks for every allowed class: no class confinement
    for (const scopes of [['env/**'], ['**'], ['loadgen/**'], ['workspace/**', 'env/sbx/**']]) {
      assert.equal(addressesEnvironments({ resourceScopes: scopes }), true, scopes.join(','));
      assert.equal(workItemConstraint([{ effect: 'external', resourceScopes: ['env/**'], environmentClass: 'sandbox' }, { effect: 'read', resourceScopes: scopes }], base)!.environmentClasses, undefined, scopes.join(','));
    }
    // in a grant: the classless read keeps local (the other operands allow it), and nothing is reported missing
    const parent: ActionCapability = {
      capabilityId: 'cap_p', runId: 'run_1', subjectAgentId: 'ag_p', workItemId: 'wi_p', tools: ['*'], resourceScopes: ['**'], allowedEffects: ['read', 'record', 'external'],
      credentialScopes: [], maxRiskClass: 'high', environmentClasses: ['local', 'sandbox'], expiresAt: '2030-01-01T00:00:00.000Z',
    };
    const reqs: CapabilityRequirement[] = [{ effect: 'external', resourceScopes: ['env/sbx/**'], environmentClass: 'sandbox' }, { effect: 'read', resourceScopes: ['env/**'] }];
    const child = attenuateCapability(parent, [workItemConstraint(reqs, base)!], { subjectAgentId: 'ag_c', workItemId: 'wi_c' });
    assert.deepEqual(child.environmentClasses, ['local', 'sandbox']);
    assert.deepEqual(unmetRequirements(child, reqs), []);
  });
});

const LEAD_OUT = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

describe('I2 in the worker: requirements beyond the grant are cut and reported, never granted', () => {
  test('a delegated child asking for more than its parent holds gets only the intersection; its task message names what is missing', async () => {
    const childViews: BrainView[] = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.step === 0) {
            return call('delegate', {
              role: 'code_change_analyst', objective: 'Summarise the change', title: 'narrowed child',
              capabilityRequirements: [{ effect: 'read', resourceScopes: ['env/**'], environmentClass: 'staging' }, { effect: 'execute', resourceScopes: ['workspace/**'] }, { effect: 'record', resourceScopes: [`run/${v.runId}/**`] }],
            });
          }
          return call('complete_work', { summary: 'done', output: LEAD_OUT });
        },
        code_change_analyst: (v) => {
          childViews.push(v);
          return call('complete_work', { summary: 'child done', output: { summary: 'child done', risks: [], testIdeas: ['x'] } });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'narrowed delegation', target: {} });
      const t = await h.control.tick(run.runId);
      const leadId = t.dispatched[0]!.workItemId;
      assert.equal((await h.control.executeTurn(leadId, t.dispatched[0]!.fencingToken)).status, 'waiting');
      const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
      assert.equal(child.capabilityRequirements.length, 3);
      const tc = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, child.workItemId, tc.dispatched.find((d) => d.workItemId === child.workItemId)!.fencingToken), 'completed');
      const leadAgent = (await h.deps.agents.byWorkItem(leadId))!;
      const childAgent = (await h.deps.agents.byWorkItem(child.workItemId))!;
      const parentCap = (await h.deps.subagents.capabilityOf!(leadAgent.agentId))!;
      const childCap = (await h.deps.subagents.capabilityOf!(childAgent.agentId))!;
      assert.equal(capabilityAmplification(childCap, parentCap), undefined, 'never amplified');
      assert.deepEqual(childCap.allowedEffects, ['read', 'record'], 'execute (not held by the parent nor the analyst role) is not granted');
      assert.deepEqual(childCap.environmentClasses, [], 'staging is not registered: the environment policy removes it');
      assert.ok(childCap.resourceScopes.includes('env/**') && childCap.resourceScopes.includes(`run/${run.runId}/**`), childCap.resourceScopes.join(', '));
      assert.ok(!childCap.resourceScopes.some((s) => s.startsWith('loadgen') || s.startsWith('loadjob')), 'scopes the work item does not require are dropped');
      // the agent is told what it asked for and did not get
      const task = childViews[0]!.userText;
      assert.match(task, /## Capability requirements NOT granted/);
      assert.match(task, /- read on env\/\*\* in staging: not granted — environment class staging/);
      assert.match(task, /- execute on workspace\/\*\*: not granted — effect execute; resource scope workspace\/\*\*/);
      assert.ok(!/record on run\//.test(task), 'a granted requirement is not reported');
      const unmet = await h.deps.events.read(run.runId, { types: ['capability.requirements_unmet'] });
      assert.equal(unmet.length, 1);
      assert.equal(unmet[0]!.aggregateId, child.workItemId);
      assert.equal((unmet[0]!.payload as { unmet: string[] }).unmet.length, 2);
    } finally {
      await h.dispose();
    }
  });

  test('a planned root item: the grant is narrowed to its requirements (+ the baseline); a malformed requirement rejects the plan', async () => {
    const executorViews: BrainView[] = [];
    const leadResults: string[] = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.lastResult) leadResults.push(v.lastResult.content);
          const item = (localId: string, reqs: JsonValue) => ({ localId, title: `exec ${localId}`, objective: 'run the suite', role: 'executor', dependsOn: [], objectiveIds: ['obj'], capabilityRequirements: reqs });
          const objectives = [{ objectiveId: 'obj', description: 'o', priority: 'P2' }];
          if (v.step === 0) return call('plan.propose_revision', { rationale: 'bad requirement', objectives, workItems: [item('bad', [{ effect: 'execute', resourceScopes: ['workspace/../../etc'] }])] });
          if (v.step === 1) {
            return call('plan.propose_revision', {
              rationale: 'narrow executor', objectives,
              workItems: [item('e1', [{ effect: 'execute', resourceScopes: ['workspace/**'] }, { effect: 'external', resourceScopes: ['env/**'], environmentClass: 'production' }, { effect: 'record', resourceScopes: [`run/${v.runId}/**`] }])],
            });
          }
          return call('complete_work', { summary: 'planned', output: { ...LEAD_OUT, planProposed: true } });
        },
        executor: (v) => {
          executorViews.push(v);
          return call('complete_work', { summary: 'nothing run', output: { summary: 'nothing run', executed: [], findings: [] } });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'narrowed plan', target: {} });
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
      assert.match(leadResults[0]!, /REJECTED:\n- work item bad: capabilityRequirements\[0\]\.resourceScopes: "workspace\/\.\.\/\.\.\/etc" is not a canonical resource pattern/);
      assert.equal(parsed(leadResults[1]!)['accepted'], true);
      const exec = (await items(h, run.runId)).find((w) => w.role === 'executor')!;
      assert.deepEqual(exec.capabilityRequirements, [
        { effect: 'execute', resourceScopes: ['workspace/**'] }, { effect: 'external', resourceScopes: ['env/**'], environmentClass: 'production' }, { effect: 'record', resourceScopes: [`run/${run.runId}/**`] },
      ]);
      const te = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, exec.workItemId, te.dispatched.find((d) => d.workItemId === exec.workItemId)!.fencingToken), 'completed');
      const agent = (await h.deps.agents.byWorkItem(exec.workItemId))!;
      const cap = (await h.deps.subagents.capabilityOf!(agent.agentId))!;
      assert.equal(cap.parentCapabilityId, undefined, 'a root grant has no parent');
      assert.deepEqual(cap.allowedEffects, ['read', 'record', 'execute', 'external'], 'the role allows these and the work item requires them');
      assert.deepEqual(cap.environmentClasses, [], 'production is never granted (role and environment policy)');
      assert.ok(cap.resourceScopes.every((s) => s.startsWith('workspace/') || s.startsWith(`run/${run.runId}/`) || s === 'env/**'), cap.resourceScopes.join(', '));
      assert.ok(!cap.resourceScopes.some((s) => s.startsWith('loadgen') || s.startsWith('loadjob')), 'unrequired black-box scopes are dropped');
      const task = executorViews[0]!.userText;
      assert.match(task, /- external on env\/\*\* in production: not granted — environment class production/);
      // every workspace was asked for; only the agent's own is granted (the report says exactly which part)
      assert.match(task, /- execute on workspace\/\*\*: not granted — resource scope workspace\/\*\* \(granted only workspace\/[^/]+\/\*\*\)/);
      assert.ok(!/record on run\//.test(task), 'a granted requirement is not reported');
    } finally {
      await h.dispose();
    }
  });
});
