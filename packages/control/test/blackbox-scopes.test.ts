/**
 * Black-box execution-plane scopes of spawned agents: the load generator (`load.start` ⇒ `env/<id>` + `loadgen/<host>`)
 * and its jobs (`load.observe` / `load.stop` ⇒ `loadjob/<operationId>`) must be reachable by the roles that hold those
 * tools on an environment-capable profile (environment operator, executor, metrics analyst) — and by nobody else
 * (least privilege: a workspace-only profile never gains them).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActionCapability } from '@hypertest/domain';
import { capabilityAllows, type CapabilityCheckRequest } from '@hypertest/policy';
import { call, createHarness, drive, items, type Harness, type RoleBrain } from './harness.ts';

const OBJ = { objectiveId: 'obj-load', description: 'Load the service.', priority: 'P2' };
const ROLES = ['environment', 'executor', 'metrics_analyst', 'test_designer'] as const;

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return call('plan.propose_revision', {
        rationale: 'one item per role whose capability is inspected',
        objectives: [OBJ],
        workItems: ROLES.map((role) => ({ localId: role, title: `${role} item`, objective: `Work as ${role}.`, role, dependsOn: [], objectiveIds: ['obj-load'] })),
      });
    }
    return call('complete_work', { summary: 'v1', output: { summary: 'v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-load', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('plan.propose_revision', { rationale: 'done', objectives: [{ ...OBJ, status: 'dropped' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'v2', output: { summary: 'v2', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-load', status: 'dropped', evidenceRefs: [] }] } });
};
const quit: RoleBrain = () => call('fail_work', { reason: 'agent_failed', message: 'capability inspection only' });

describe('black-box execution-plane scopes of spawned agents', () => {
  let h: Harness;
  const caps = new Map<string, ActionCapability>();
  before(async () => {
    h = await createHarness({
      brains: { lead, environment: quit, executor: quit, metrics_analyst: quit, test_designer: quit },
      environments: [{ environmentId: 'svc', environmentClass: 'local', baseUrl: 'http://127.0.0.1:8080', generation: 1 }],
    });
    const run = await h.control.startRun({ goal: 'load the service', target: { environmentId: 'svc' } });
    await drive(h, run.runId, 30);
    for (const w of await items(h, run.runId)) {
      if (!(ROLES as readonly string[]).includes(w.role)) continue;
      const agent = await h.deps.agents.byWorkItem(w.workItemId);
      assert.ok(agent, `agent of ${w.role} spawned`);
      caps.set(w.role, (await h.deps.subagents.capabilityOf!(agent.agentId)) as ActionCapability);
    }
  });
  after(() => h.dispose());

  const now = '2026-09-01T00:00:01.000Z';
  const loadStart: Omit<CapabilityCheckRequest, 'now'> = { tool: 'load.start', effect: 'external', riskClass: 'high', resources: ['env/svc', 'loadgen/127.0.0.1:8080'], environmentClass: 'local' };
  const loadObserve: Omit<CapabilityCheckRequest, 'now'> = { tool: 'load.observe', effect: 'read', riskClass: 'low', resources: ['loadjob/op_01J0000000000000000000000'] };
  const loadStop: Omit<CapabilityCheckRequest, 'now'> = { tool: 'load.stop', effect: 'external', riskClass: 'medium', resources: ['loadjob/op_01J0000000000000000000000'], environmentClass: 'local' };

  test('the environment operator and the executor may start, observe and stop load jobs', () => {
    for (const role of ['environment', 'executor']) {
      const cap = caps.get(role)!;
      assert.ok(cap, role);
      for (const req of [loadStart, loadObserve, loadStop]) assert.deepEqual(capabilityAllows(cap, { ...req, now }), { allowed: true }, `${role} ${req.tool}`);
    }
  });

  test('the metrics analyst may observe load jobs (read) but never start one', () => {
    const cap = caps.get('metrics_analyst')!;
    assert.deepEqual(capabilityAllows(cap, { ...loadObserve, now }), { allowed: true });
    assert.equal(capabilityAllows(cap, { ...loadStart, now }).allowed, false);
  });

  test('a workspace-only profile (test designer) never reaches environments, load generators or load jobs', () => {
    const cap = caps.get('test_designer')!;
    assert.ok(!cap.resourceScopes.some((s) => s.startsWith('env/') || s.startsWith('loadgen/') || s.startsWith('loadjob/')), cap.resourceScopes.join(', '));
    assert.deepEqual(capabilityAllows(cap, { ...loadObserve, tool: 'fs.read', now }), { allowed: false, reason: 'resource_out_of_scope: loadjob/op_01J0000000000000000000000' });
  });
});
