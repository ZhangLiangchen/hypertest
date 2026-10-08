/**
 * stubs[8]: an operation escalated to manual review blocks the work that issued it until a HUMAN resolves it
 * (`hypertest operations resolve`); the resolution unblocks it with the recorded outcome. Agents never resolve operations.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import type { WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, RoleCatalog, type RoleDefinition } from '@hypertest/agents';
import type { SideEffectAdapter } from '@hypertest/operation';
import type { ToolSpec } from '@hypertest/tools';
import { call, createHarness, runItem, type BrainView, type Harness, type RoleBrain } from './harness.ts';

/** A schema migration whose outcome cannot be looked up: an ambiguous dispatch ⇒ manual_review (never re-sent). */
class Migration {
  applied = 0;
  adapter(): SideEffectAdapter {
    const adapter: SideEffectAdapter = {
      adapterId: 'fake.migrate',
      capabilities: { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: false, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'non_reconcilable', riskClass: 'high' },
      prepare: async (op, input) => ({ desiredState: input, desiredStateHash: sha256Hex(JSON.stringify(input)), target: op.operation.target }),
      dispatch: async () => {
        this.applied++;
        throw new Error('connection reset after the request was sent');
      },
      observe: async () => ({ state: 'uncertain', detail: 'no lookup by operation id' }),
      verify: async () => ({ status: 'pending' }),
    };
    return adapter;
  }
}

const MIGRATE: ToolSpec<{ version: string }> = {
  id: 'ops.migrate',
  title: 'Migrate',
  description: 'Apply a schema migration (high risk, no lookup).',
  inputSchema: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'string' } } },
  effect: 'external',
  riskClass: 'high',
  resources: () => ['env/local/db'],
  environmentClass: () => 'local',
  sideEffect: { adapterId: 'fake.migrate', operationType: 'migrate', target: () => ({ resourceKey: 'env/local/db', kind: 'database' }) },
  timeoutMs: 10_000,
  execute: async () => {
    throw new Error('side-effect tools never execute directly');
  },
};

const MIGRATOR: RoleDefinition = {
  role: 'migrator', description: 'migrates', systemPrompt: 'You are {{role}}. Goal: {{runGoal}}. Objective: {{objective}}. Protocol: {{protocol}}', phase: 'execution', taskType: 'deploy',
  defaultModelPolicy: { requiredCapabilities: ['tool_use'] }, toolPolicy: { allow: ['ops.migrate', 'experiment.define', 'complete_work', 'fail_work'] }, permissionProfile: 'test_executor',
  workspace: 'scratch', dataClassification: 'internal', subscriptions: [], canDelegateTo: [], maxDepth: 0, defaultBudget: {},
};

const EXPERIMENT = { hypothesis: 'the migration applies', isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/local/db', mode: 'write_exclusive' }] } };

const lead: RoleBrain = (v) => {
  if (v.step === 0) return call('plan.propose_revision', { rationale: 'migrate', objectives: [{ objectiveId: 'o', description: 'migrate', priority: 'P2' }], workItems: [{ localId: 'm', title: 'migrate', objective: 'apply v7', role: 'migrator', dependsOn: [], objectiveIds: ['o'] }] });
  return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
};

test('an operation in manual review keeps its work item waiting (no guess, no re-send); a human resolution resumes it with the outcome', async () => {
  const migration = new Migration();
  const views: BrainView[] = [];
  const migrator: RoleBrain = (v) => {
    views.push(v);
    if (v.step === 0) return call('experiment.define', EXPERIMENT);
    if (v.step === 1) return call('ops.migrate', { version: 'v7' });
    return call('complete_work', { summary: 'migrated after review' });
  };
  const roles = new RoleCatalog(BUILTIN_ROLES, { custom: [MIGRATOR] }, { extraToolIds: ['ops.migrate'] });
  const h: Harness = await createHarness({ roles, brains: { lead, migrator } });
  (h.deps.adapters as unknown as { register(a: SideEffectAdapter): void }).register(migration.adapter());
  h.deps.registry.register(MIGRATE);
  try {
    const run = await h.control.startRun({ goal: 'migrate', target: {} });
    const t1 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t1.dispatched[0]!.workItemId, t1.dispatched[0]!.fencingToken), 'completed');
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
    const waited = await h.control.executeTurn(d.workItemId, d.fencingToken);
    const [op] = (await h.deps.ledger.list({ runId: run.runId })).filter((o) => o.operationType === 'migrate');
    assert.ok(op);
    assert.equal(op.status, 'manual_review');
    assert.deepEqual(waited, { status: 'waiting', workItemId: d.workItemId, operationIds: [op.operationId] });
    assert.equal(migration.applied, 1);
    // still under review: the item keeps waiting (before: it resumed at once and the agent guessed)
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'waiting');
    assert.deepEqual((await h.control.tick(run.runId)).waiting, [{ workItemId: d.workItemId, operationIds: [op.operationId] }]);

    // agents never resolve; a human does, after checking the target
    await assert.rejects(h.control.resolveOperation!(op.operationId, 'succeeded', '', 'x'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    const resolved = await h.control.resolveOperation!(op.operationId, 'succeeded', 'dba-alice', 'schema v7 present on the database');
    assert.equal(resolved.status, 'verified');
    const audit = (await h.deps.events.read(run.runId, { types: ['operation.resolved'] })).map((e) => e.payload as Record<string, unknown>);
    assert.deepEqual(audit.map((p) => [p['operationId'], p['outcome'], p['by']]), [[op.operationId, 'succeeded', 'human:dba-alice']]);

    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    const item = (await h.deps.blackboard.getWorkItem(d.workItemId)) as WorkItem;
    assert.equal(await runItem(h.control, d.workItemId, item.claim!.fencingToken), 'completed');
    assert.match(views[2]!.lastResult?.content ?? '', new RegExp(`waiting for a human manual review of operation ${op.operationId}`));
    assert.match(views[2]!.userText, new RegExp(`- operation ${op.operationId} \\(migrate\\) verified`));
    assert.equal(migration.applied, 1, 'never re-sent');
  } finally {
    await h.dispose();
  }
});
