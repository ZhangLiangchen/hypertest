/**
 * PoC A — Multi-LLM white-box autonomous regression, one trial of the scripted multi-LLM arm on the real stack
 * (PGlite, or a fresh PostgreSQL schema with HYPERTEST_TEST_DB=postgres). Every grader of the task passes and the
 * acceptance table ("首批 PoC：Multi-LLM 白盒自主回归") is asserted row by row from the recorded state.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Review } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { FIXTURES_DIR, maxConcurrent, pocATask, runTrial, scriptedMultiLlmArm, type BrainObservation } from '../src/index.ts';
import { assertSchemasDropped, capture, failures, routesOfRoles, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('a');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-poc-a-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('PoC A: the seeded pagination regression is found by a dynamic multi-LLM team and the release is refused', async () => {
  const acceptance = capture(async (ctx) => {
    const d = ctx.data;
    const evidence = new Map(d.evidence.map((e) => [e.evidenceId, e]));
    const reviews = await ctx.ht.services.blackboard.query<Review>({ runId: d.runId!, recordType: 'review' });
    const artifacts = await ctx.ht.services.specs.listTestArtifacts(d.runId!);
    const obs = d.probes['observations'] as unknown as BrainObservation[];
    const analysts = d.workItems.filter((w) => w.role.endsWith('_analyst')).map((w) => w.workItemId);
    const designers = d.workItems.filter((w) => w.role === 'test_designer' && w.origin.kind === 'plan').map((w) => w.workItemId);
    return {
      verdict: d.decision?.verdict,
      violated: d.decision?.violatedCriteria.map((c) => c.criterionId).sort(),
      satisfied: d.decision?.satisfiedCriteria.map((c) => c.criterionId).sort(),
      acceptedPlans: d.plans.filter((p) => p.status === 'accepted' || p.status === 'superseded').map((p) => p.revision),
      work: d.workItems.map((w) => `${w.role}/${w.origin.kind}/${w.state}`).sort(),
      parallelAnalysts: maxConcurrent(d.events, new Set(analysts)),
      parallelDesigners: maxConcurrent(d.events, new Set(designers)),
      routes: routesOfRoles(d.events),
      findings: d.findings.map((f) => ({
        title: f.payload.title, status: f.payload.status, category: f.payload.category, testArtifact: artifacts.find((a) => a.artifactId === f.payload.testArtifactId)?.path,
        evidenceTypes: [...new Set(f.evidenceRefs.map((id) => evidence.get(id)?.evidenceType))].sort(),
      })),
      reviews: reviews.map((r) => ({ verdict: r.payload.verdict, provider: r.payload.modelProvider, subject: r.payload.subjectRef.kind, checked: [...new Set(r.payload.checkedEvidenceRefs.map((id) => evidence.get(id)?.evidenceType))].sort() })),
      artifacts: artifacts.map((a) => `${a.path}:${a.approvalState}`).sort(),
      childCalls: obs.filter((o) => o.role !== 'lead').length,
      leaks: obs.filter((o) => o.sawLeadTrace).length,
      inheritedFirstCalls: obs.filter((o) => o.role !== 'lead' && o.step === 0 && (o.assistantMessages > 0 || o.toolMessages > 0)).length,
      candidate: d.probes['candidateSource'],
    };
  });
  const task = pocATask();
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'trial'), { graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'fail', undefined]);
  assert.deepEqual(trial.graders.map((g) => g.graderId), [...task.graders, 'acceptance']);
  const a = acceptance.value();

  // Seeded defect — detected with execution evidence (test-result), confirmed by RCA with its reproduction (stdout)
  assert.deepEqual(a.findings, [{ title: 'paginate drops the last item of every page', status: 'confirmed', category: 'product_defect', testArtifact: 'tests/paginate-pages.test.js', evidenceTypes: ['stdout', 'test-result'] }]);
  // Dynamic planning — ≥2 accepted plan revisions (v1 analysis, v2 design + execution, v3 hand-over)
  assert.ok(a.acceptedPlans.length >= 2, `plans ${a.acceptedPlans.join(', ')}`);
  // Subagents — the three analysts and the two designers ran as parallel children; RCA and reviewer reacted to the finding
  assert.deepEqual([a.parallelAnalysts, a.parallelDesigners], [3, 2]);
  for (const w of ['architecture_analyst/plan/completed', 'code_change_analyst/plan/completed', 'historical_bug_analyst/plan/completed', 'executor/plan/completed', 'rca/reactor/completed', 'reviewer/reactor/completed']) {
    assert.ok(a.work.includes(w), `${w} in ${a.work.join(', ')}`);
  }
  assert.equal(a.work.filter((w) => w === 'test_designer/plan/completed').length, 2);
  // Multi-LLM — ≥3 roles on distinct route policies: reasoning, tool-reliable, independent judge
  assert.deepEqual([a.routes['lead'], a.routes['code_change_analyst'], a.routes['executor'], a.routes['test_designer'], a.routes['rca'], a.routes['reviewer']], [
    ['reason-a-large'], ['reason-a-large'], ['fast-b-tools'], ['fast-b-tools'], ['fast-b-tools'], ['judge-c-review'],
  ]);
  // Context — no child received the lead's private trace; every child started from its own task
  assert.ok(a.childCalls > 10);
  assert.deepEqual([a.leaks, a.inheritedFirstCalls], [0, 0]);
  // Evidence + Review — the reviewer (another provider) fetched every cited evidence itself and approved on the recorded
  // test-result (pocAWorkflow: the approval rests on test-result evidence the reviewer fetched with evidence.get)
  assert.deepEqual(a.reviews, [
    { verdict: 'approve', provider: 'judge-c', subject: 'record', checked: ['stdout', 'test-result'] },
    // H7: the run-level review the gate requires, requested by the control plane before the gate, judged on test-result
    { verdict: 'approve', provider: 'judge-c', subject: 'run', checked: ['test-result'] },
  ]);
  // …and it is independent of every producer's provider: C6 is satisfied in the multi-LLM arm
  assert.ok(a.satisfied?.includes('C6'), `satisfied ${a.satisfied?.join(', ')}`);
  assert.deepEqual(a.artifacts, ['tests/paginate-pages.test.js:validated', 'tests/transfer-conservation.test.js:validated']);
  // BUGate — the unresolved defect violates the critical oracle assertion: no release
  assert.equal(a.verdict, 'fail');
  assert.ok(a.violated?.includes('C3'), `violated ${a.violated?.join(', ')}`);
  // the candidate itself was never modified (agents worked in worktrees)
  assert.equal(a.candidate, readFileSync(join(FIXTURES_DIR, 'ledger', 'v2', 'src', 'ledger.js'), 'utf8'));
  // Audit — every route/tool/gate decision reconstructible from L0 (auditReconstruction passed above)
  assert.equal(trial.graders.find((g) => g.graderId === 'auditReconstruction')?.pass, true);
});
