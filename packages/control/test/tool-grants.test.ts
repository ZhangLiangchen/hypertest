/**
 * (wave 3, E[5]) Operator scope grants attached to configured tools (ToolSpec.grant — e.g. an MCP server's
 * `mcp/<server>/**`): an agent whose permission profile is named receives the scopes in its root capability; any other
 * agent does not (least privilege), and malformed or catch-all grants are never honoured.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActionCapability } from '@hypertest/domain';
import { capabilityAllows } from '@hypertest/policy';
import type { ToolSpec } from '@hypertest/tools';
import { toolGrantScopes } from '../src/index.ts';
import { call, createHarness, drive, items, type Harness, type RoleBrain } from './harness.ts';

describe('toolGrantScopes', () => {
  test('only the named profiles receive canonical scopes (sorted, deduplicated); ** and malformed patterns are dropped', () => {
    const tools = [
      { grant: { scopes: ['mcp/calc/**'], profiles: ['test_executor', 'environment_operator'] } },
      { grant: { scopes: ['mcp/calc/**', 'desktop/:99'], profiles: ['test_executor'] } },
      { grant: { scopes: ['**', 'mcp/../x', 'mcp//y'], profiles: ['test_executor'] } },
      { grant: { scopes: ['acp/coder/**'], profiles: ['product_fixer'] } },
      {},
    ];
    assert.deepEqual(toolGrantScopes(tools, 'test_executor'), ['desktop/:99', 'mcp/calc/**']);
    assert.deepEqual(toolGrantScopes(tools, 'environment_operator'), ['mcp/calc/**']);
    assert.deepEqual(toolGrantScopes(tools, 'test_author'), []);
  });
});

const OBJ = { objectiveId: 'obj-mcp', description: 'Use the MCP server.', priority: 'P2' };
const ROLES = ['executor', 'test_designer'] as const;
const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return call('plan.propose_revision', { rationale: 'inspect grants', objectives: [OBJ], workItems: ROLES.map((role) => ({ localId: role, title: role, objective: `Work as ${role}.`, role, dependsOn: [], objectiveIds: ['obj-mcp'] })) });
    }
    return call('complete_work', { summary: 'v1', output: { summary: 'v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-mcp', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('plan.propose_revision', { rationale: 'done', objectives: [{ ...OBJ, status: 'dropped' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'v2', output: { summary: 'v2', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-mcp', status: 'dropped', evidenceRefs: [] }] } });
};
const quit: RoleBrain = () => call('fail_work', { reason: 'agent_failed', message: 'capability inspection only' });

describe('the worker grants operator tool scopes to the named profiles only', () => {
  let h: Harness;
  const caps = new Map<string, ActionCapability>();
  before(async () => {
    h = await createHarness({ brains: { lead, executor: quit, test_designer: quit } });
    const tool: ToolSpec = {
      id: 'mcp.calc.add', title: 'calc add', description: 'add', inputSchema: { type: 'object' }, effect: 'external', riskClass: 'medium', resources: () => ['mcp/calc/add'], timeoutMs: 1000,
      grant: { scopes: ['mcp/calc/**'], profiles: ['test_executor'] },
      execute: async () => ({ status: 'success' }),
    };
    h.deps.registry.register(tool);
    const run = await h.control.startRun({ goal: 'grants', target: { description: 'grants' } });
    await drive(h, run.runId, 30);
    for (const w of await items(h, run.runId)) {
      if (!(ROLES as readonly string[]).includes(w.role)) continue;
      const agent = await h.deps.agents.byWorkItem(w.workItemId);
      assert.ok(agent, w.role);
      caps.set(w.role, (await h.deps.subagents.capabilityOf!(agent.agentId)) as ActionCapability);
    }
  });
  after(() => h.dispose());

  test('the executor (test_executor) may act on mcp/calc/**; the test designer (test_author) may not', () => {
    const req = { tool: 'mcp.calc.add', effect: 'external' as const, riskClass: 'medium' as const, resources: ['mcp/calc/add'], now: '2026-09-01T00:00:01.000Z' };
    assert.ok(caps.get('executor')!.resourceScopes.includes('mcp/calc/**'));
    assert.deepEqual(capabilityAllows({ ...caps.get('executor')!, tools: ['*'] }, req), { allowed: true });
    assert.equal(caps.get('test_designer')!.resourceScopes.includes('mcp/calc/**'), false);
    const denied = capabilityAllows({ ...caps.get('test_designer')!, tools: ['*'], allowedEffects: ['read', 'record', 'external'] }, req);
    assert.equal(denied.allowed, false);
  });
});
