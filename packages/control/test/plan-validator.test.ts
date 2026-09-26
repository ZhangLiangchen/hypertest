import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { DEFAULT_BUDGET, type PlannedWorkItem, type TestRun, type WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { classifyTestChange } from '@hypertest/policy';
import { tempDir } from '@hypertest/testkit';
import { unifiedDiff, validatePlan, type PlanValidationInput } from '../src/index.ts';

const exec = promisify(execFile);
const roles = new RoleCatalog(BUILTIN_ROLES);

function run(budget: Partial<TestRun['budget']> = {}): TestRun {
  return {
    runId: 'run_1', goal: 'g', target: {}, status: 'running', budget: { ...DEFAULT_BUDGET, ...budget }, runtimeManifestId: 'rm_1', policyRevision: 'p1', currentPlanRevision: 0,
    oracleRevisions: {}, experimentIds: [], labels: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function wi(localId: string, overrides: Partial<PlannedWorkItem> = {}): PlannedWorkItem {
  return { localId, title: `t ${localId}`, objective: `o ${localId}`, role: 'code_change_analyst', dependsOn: [], objectiveIds: ['obj'], ...overrides };
}

function existing(id: string, state: WorkItem['state']): WorkItem {
  return {
    workItemId: id, runId: 'run_1', kind: 'task', origin: { kind: 'system', reason: 'x' }, title: id, objective: id, role: 'executor', objectiveIds: [], capabilityRequirements: [], inputRefs: [],
    evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 }, priority: 1, state, depth: 0, fingerprint: id, resourceClaims: [],
    attempts: 0, waitingOn: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function input(workItems: PlannedWorkItem[], overrides: Partial<PlanValidationInput> = {}, proposal: Partial<PlanValidationInput['proposal']> = {}): PlanValidationInput {
  return {
    run: run(),
    proposal: { rationale: 'r', objectives: [{ objectiveId: 'obj', description: 'd', priority: 'P1', riskRefs: [], acceptanceCriteria: [], status: 'open' }], workItems, cancelWorkItems: [], readyForGate: false, ...proposal },
    existingWorkItems: [],
    roles,
    acceptedPlanCount: 0,
    proposerRole: 'lead',
    ...overrides,
  };
}

describe('validatePlan (pure)', () => {
  test('a well-formed plan with parallel and dependent items is valid', () => {
    const r = validatePlan(input([wi('a1'), wi('a2', { role: 'historical_bug_analyst' }), wi('d1', { role: 'test_designer', dependsOn: ['a1', 'a2', 'wi_done'] })], { existingWorkItems: [existing('wi_done', 'completed')] }));
    assert.deepEqual(r, { valid: true, issues: [] });
  });

  test('only the lead may propose', () => {
    assert.deepEqual(validatePlan(input([wi('a1')], { proposerRole: 'executor' })).issues, ['only the lead may propose plan revisions (proposer role: executor)']);
  });

  test('accepted plans must stay below maxPlanRevisions', () => {
    assert.deepEqual(validatePlan(input([wi('a1')], { run: run({ maxPlanRevisions: 2 }), acceptedPlanCount: 2 })).issues, ['plan revision cap reached: 2 accepted plans (maxPlanRevisions 2)']);
  });

  test('duplicate localIds and objective ids', () => {
    const r = validatePlan(input([wi('a1'), wi('a1')], {}, { objectives: [{ objectiveId: 'obj', description: 'd', priority: 'P1', riskRefs: [], acceptanceCriteria: [], status: 'open' }, { objectiveId: 'obj', description: 'e', priority: 'P2', riskRefs: [], acceptanceCriteria: [], status: 'open' }] }));
    assert.deepEqual(r.issues, ['duplicate objectiveId obj', 'duplicate localId a1']);
  });

  test('unknown roles and lead tasks are refused', () => {
    assert.deepEqual(validatePlan(input([wi('a1', { role: 'wizard' }), wi('a2', { role: 'lead' })])).issues, [
      'work item a1: unknown role wizard',
      'work item a2: role lead cannot be planned as a task (the lead replans through plan revisions)',
    ]);
  });

  test('dependsOn must resolve: self, unknown, cancelled, being cancelled', () => {
    const r = validatePlan(
      input([wi('a1', { dependsOn: ['a1'] }), wi('a2', { dependsOn: ['nope'] }), wi('a3', { dependsOn: ['wi_c'] }), wi('a4', { dependsOn: ['wi_r'] })], { existingWorkItems: [existing('wi_c', 'cancelled'), existing('wi_r', 'ready')] }, { cancelWorkItems: ['wi_r'] }),
    );
    assert.deepEqual(r.issues, [
      'work item a1: depends on itself',
      'work item a2: dependency nope is neither a localId of this revision nor an existing work item',
      'work item a3: dependency wi_c is cancelled',
      'work item a4: dependency wi_r is cancelled by this revision',
    ]);
  });

  test('dependency cycles are reported once', () => {
    const r = validatePlan(input([wi('a', { dependsOn: ['c'] }), wi('b', { dependsOn: ['a'] }), wi('c', { dependsOn: ['b'] })]));
    assert.equal(r.valid, false);
    assert.deepEqual(r.issues, ['dependency cycle: a → c → b → a']);
  });

  test('objectiveIds must reference the proposal objectives', () => {
    assert.deepEqual(validatePlan(input([wi('a1', { objectiveIds: ['obj', 'ghost'] })])).issues, ['work item a1: objectiveId ghost is not an objective of this revision']);
  });

  test('tool policies must stay inside the role allowlist', () => {
    const r = validatePlan(input([wi('a1', { toolPolicy: { allow: ['fs.read', 'fs.write', 'git.*'] } }), wi('a2', { role: 'executor', toolPolicy: { allow: ['test.run', 'metrics.query'] } })]));
    assert.deepEqual(r.issues, ['work item a1: tool pattern fs.write is outside the code_change_analyst tool allowlist', 'work item a1: tool pattern git.* is outside the code_change_analyst tool allowlist']);
  });

  test('item budgets must fit the run envelope', () => {
    const r = validatePlan(input([wi('a1', { budget: { maxTokens: 10_000, maxToolCalls: 11, maxWallClockMs: 2000, maxCostUsd: 5 } })], { run: run({ maxModelTokens: 1000, maxToolCalls: 10, maxWallClockMs: 1000, maxModelCostUsd: 1 }) }));
    assert.deepEqual(r.issues, [
      'work item a1: budget.maxTokens 10000 exceeds the run limit 1000',
      'work item a1: budget.maxToolCalls 11 exceeds the run limit 10',
      'work item a1: budget.maxWallClockMs 2000 exceeds the run limit 1000',
      'work item a1: budget.maxCostUsd 5 exceeds the run limit 1',
    ]);
  });

  test('total work items after acceptance must stay within maxWorkItems', () => {
    const r = validatePlan(input([wi('a1'), wi('a2')], { run: run({ maxWorkItems: 2 }), existingWorkItems: [existing('wi_lead', 'completed')] }));
    assert.deepEqual(r.issues, ['total work items after acceptance 3 exceed maxWorkItems 2']);
  });

  test('expectedOutput must be a valid JSON schema', () => {
    assert.deepEqual(validatePlan(input([wi('a1', { expectedOutput: { type: 'no-such-type' } })])).issues, ['work item a1: expectedOutput is not a valid JSON schema']);
  });

  test('cancelWorkItems: lead planning work (the proposer\'s own running item included) is never cancelled by a plan', () => {
    const lead = { ...existing('wi_lead', 'running'), role: 'lead', kind: 'replan' as const };
    const done = { ...existing('wi_lead0', 'completed'), role: 'lead', kind: 'initial_plan' as const };
    const r = validatePlan(input([], { existingWorkItems: [lead, done, existing('wi_r', 'running')] }, { cancelWorkItems: ['wi_lead', 'wi_lead0', 'wi_r'] }));
    assert.deepEqual(r.issues, [
      'cancelWorkItems: work item wi_lead is lead planning work and cannot be cancelled by a plan revision',
      'cancelWorkItems: work item wi_lead0 is lead planning work and cannot be cancelled by a plan revision',
    ]);
  });

  test('cancelWorkItems: unknown ids and waiting items (running side effects) are refused', () => {
    const r = validatePlan(input([], { existingWorkItems: [existing('wi_w', 'waiting'), existing('wi_r', 'running')] }, { cancelWorkItems: ['wi_x', 'wi_w', 'wi_r'] }));
    assert.deepEqual(r.issues, ['cancelWorkItems: unknown work item wi_x', 'cancelWorkItems: work item wi_w is waiting on side effects and cannot be cancelled']);
  });

  test('deterministic: the same input yields the same result', () => {
    const i = input([wi('a', { dependsOn: ['b'] }), wi('b', { dependsOn: ['a'], role: 'nobody' })]);
    assert.deepEqual(validatePlan(i), validatePlan(i));
  });
});

describe('unifiedDiff (fs.write governance input)', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['modify middle', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nX\ne\nf\ng\nh\n', true],
    ['append', 'a\nb\n', 'a\nb\nc\n', true],
    ['remove newline at end', 'a\nb\n', 'a\nb', true],
    ['add newline at end', 'a\nb', 'a\nb\n', true],
    ['two distant hunks', Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n', Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? `m${i}` : `l${i}`)).join('\n') + '\n', true],
    ['empty to content', '', 'x\ny\n', false],
  ];
  for (const [name, before, after, existed] of cases) {
    test(`${name}: git apply accepts the generated diff and reproduces the new content`, async () => {
      const dir = await tempDir('ht-diff-');
      try {
        await exec('git', ['init', '-q'], { cwd: dir.path });
        await mkdir(join(dir.path, 'test'), { recursive: true });
        if (existed) await writeFile(join(dir.path, 'test/a.test.js'), before);
        const diff = unifiedDiff('test/a.test.js', before, after, { oldExists: existed });
        await writeFile(join(dir.path, 'p.diff'), diff);
        await exec('git', ['apply', '--whitespace=nowarn', 'p.diff'], { cwd: dir.path });
        const { stdout } = await exec('cat', ['test/a.test.js'], { cwd: dir.path });
        assert.equal(stdout, after);
      } finally {
        await dir.cleanup();
      }
    });
  }

  test('no change ⇒ empty diff; the classifier sees a weakened assertion as approval_required', () => {
    assert.equal(unifiedDiff('x.js', 'a\n', 'a\n'), '');
    const diff = unifiedDiff('test/p.test.js', "test('t', () => {\n  assert.equal(f(), 900);\n});\n", "test('t', () => {\n  assert.ok(f() > 0);\n});\n");
    assert.equal(classifyTestChange(diff).decision, 'approval_required');
    const created = unifiedDiff('test/new.test.js', '', "test('n', () => {\n  assert.equal(g(), 1);\n});\n", { oldExists: false });
    assert.match(created, /^diff --git a\/test\/new\.test\.js b\/test\/new\.test\.js\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/test\/new\.test\.js\n@@ -0,0 \+1,3 @@/);
    assert.notEqual(classifyTestChange(created).decision, 'forbidden');
    assert.notEqual(classifyTestChange(created).decision, 'approval_required');
  });
});
