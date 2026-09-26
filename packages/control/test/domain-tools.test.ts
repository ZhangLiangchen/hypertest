import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DOMAIN_TOOL_IDS } from '@hypertest/agents';
import type { ToolSpec } from '@hypertest/tools';
import { ControlStore, createDomainTools } from '../src/index.ts';
import { call, createHarness, items, parsed, runItem, type Harness, type RoleBrain } from './harness.ts';
import { pricingOracle, pricingRepo } from './fixture.ts';

type Result = { name: string; content: string; isError: boolean };

function recorder(into: Result[], script: (step: number, v: Parameters<RoleBrain>[0]) => ReturnType<RoleBrain>): RoleBrain {
  return (v) => {
    if (v.lastResult) into.push(v.lastResult);
    return script(v.step, v);
  };
}

describe('createDomainTools', () => {
  test('implements exactly the domain tool ids the role catalog references, as record/read tools scoped to run/<id>/<area>', async () => {
    const h = await createHarness();
    try {
      const specs: ToolSpec[] = createDomainTools(h.deps);
      assert.deepEqual(specs.map((s) => s.id).sort(), [...DOMAIN_TOOL_IDS].sort());
      for (const s of specs) {
        assert.ok(s.effect === 'record' || s.effect === 'read', s.id);
        assert.equal(s.riskClass, 'low');
        assert.match(s.resources({}, { runId: 'run_x', workspace: {} as never, environments: h.deps.environments })[0]!, /^run\/run_x\/[a-z_]+$/);
      }
      const reads = specs.filter((s) => s.effect === 'read').map((s) => s.id).sort();
      assert.deepEqual(reads, ['blackboard.read', 'evidence.get', 'evidence.query', 'oracle.get', 'oracle.list', 'plan.read']);
    } finally {
      await h.dispose();
    }
  });
});

describe('domain tools on the real pipeline: specs, oracles, experiments, approvals, work proposals', () => {
  let h: Harness;
  const results: Result[] = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: recorder(results, (step) => {
          switch (step) {
            case 0:
              return call('system_model.record', { components: [{ componentId: 'pricing', name: 'pricing', kind: 'module', paths: ['src/pricing.js'] }], changedComponents: ['pricing'], invariants: ['discounts never increase a price'] });
            case 1:
              return call('oracle.list', {});
            case 2:
              return call('oracle.get', { oracleId: 'oracle.pricing' });
            case 3:
              return call('experiment.define', { hypothesis: 'the discount service handles 50 rps', isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/local/app', mode: 'write_exclusive' }] } });
            case 4:
              return call('request_approval', { kind: 'manual_review', subject: { topic: 'pricing sign-off' }, rationale: 'a human must sign off pricing' });
            case 5:
              return call('work.propose', { title: 'review pricing', objective: 'review the pricing evidence', role: 'reviewer', rationale: 'independent review' });
            case 6:
              return call('work.propose', { title: 'review pricing', objective: 'review the pricing evidence', role: 'reviewer', rationale: 'independent review' });
            case 7:
              return call('work.propose', { title: 'fix pricing', objective: 'fix it', role: 'fixer', rationale: 'fast' });
            case 8:
              return call('plan.read', {});
            default:
              return call('complete_work', { summary: 'explored', output: { summary: 'explored', planProposed: false, readyForGate: false, objectives: [] } });
          }
        }),
      },
    });
    await pricingOracle(h);
  });
  after(async () => h.dispose());

  test('each tool validates, writes through its owning store and answers with ids', async () => {
    const run = await h.control.startRun({ goal: 'tools', target: { commit: 'abc1234' }, oracleIds: ['oracle.pricing'] });
    const t = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
    const [sm, list, get, exp, appr, prop1, prop2, prop3, plan] = results;
    assert.deepEqual(parsed(sm!.content), { systemModelId: `sm_${run.runId}`, revision: 1 });
    const after = (await h.deps.runs.get(run.runId))!;
    assert.equal(after.systemModelRevision, 1);
    assert.equal((await h.deps.specs.latestSystemModel(run.runId))!.changedComponents[0], 'pricing');
    assert.deepEqual((parsed(list!.content)['pinned'] as Array<{ oracleId: string; revision: number }>).map((o) => [o.oracleId, o.revision]), [['oracle.pricing', 1]]);
    assert.equal(parsed(get!.content)['pinnedByRun'], true);
    const experimentId = parsed(exp!.content)['experimentId'] as string;
    const experiment = (await h.deps.specs.getExperiment(experimentId))!;
    assert.deepEqual(experiment.oracleRefs, [{ oracleId: 'oracle.pricing', revision: 1 }]);
    assert.deepEqual(experiment.subjects, [{ role: 'candidate', buildDigest: 'abc1234', commit: 'abc1234' }]);
    assert.equal(experiment.isolation.mode, 'exclusive_write');
    assert.deepEqual(after.experimentIds, [experimentId]);
    const approvalId = parsed(appr!.content)['approvalId'] as string;
    const approval = (await h.deps.approvals.get(approvalId))!;
    assert.equal(approval.kind, 'manual_review');
    assert.equal(approval.requestedBy.role, 'lead');
    // the requester's model provider is recorded: an agent approver must be independent of it (I8)
    assert.equal(approval.requestedBy.modelProvider, 'alpha');
    const proposed = parsed(prop1!.content);
    assert.equal(proposed['created'], true);
    assert.equal(parsed(prop2!.content)['created'], false, 'identical proposals are deduplicated');
    assert.equal(parsed(prop2!.content)['workItemId'], proposed['workItemId']);
    assert.equal(prop3!.isError, true);
    assert.match(prop3!.content, /permission_denied: role lead may propose work only for code_change_analyst, architecture_analyst, historical_bug_analyst, reviewer, rca/);
    const reviewItem = (await items(h, run.runId)).find((w) => w.workItemId === proposed['workItemId'])!;
    assert.deepEqual(reviewItem.origin, { kind: 'system', reason: `proposed_by:${(await h.deps.agents.byWorkItem(t.dispatched[0]!.workItemId))!.agentId}` });
    assert.equal(reviewItem.role, 'reviewer');
    assert.match(reviewItem.objective, /^review the pricing evidence\n\nRationale \(proposed by lead ag_\w+\): independent review$/);
    const planView = parsed(plan!.content);
    assert.equal(planView['plan'], null);
    assert.equal((planView['workItems'] as unknown[]).length, 2);
  });
});

describe('evidence claims, oracle change proposals and artifact validation refusals', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const exec: Result[] = [];
  const design: Result[] = [];
  let runId = '';
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.step === 0) {
            return call('plan.propose_revision', {
              rationale: 'run and design',
              objectives: [{ objectiveId: 'o', description: 'd', priority: 'P1' }],
              workItems: [
                { localId: 'e', title: 'run', objective: 'run the suite and claim', role: 'executor', dependsOn: [], objectiveIds: ['o'] },
                { localId: 'd', title: 'design', objective: 'test design', role: 'test_designer', dependsOn: ['e'], objectiveIds: ['o'] },
              ],
            });
          }
          return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
        },
        executor: recorder(exec, async (step, v) => {
          const all = await h.deps.evidence.query({ runId: v.runId, workItemId: v.workItemId });
          const tr = all.find((e) => e.evidenceType === 'test-result')?.evidenceId;
          const out = all.find((e) => e.evidenceType === 'stdout')?.evidenceId;
          switch (step) {
            case 0:
              return call('test.run', { framework: 'node_test' });
            case 1:
              return call('evidence.claim', { statement: 'the pricing suite fails on the candidate', value: false, evidenceRefs: [tr!], critical: true, evidenceQuery: { evidenceType: 'test-result', field: 'passed' } });
            case 2:
              return call('evidence.claim', { statement: 'stdout is a test result', evidenceRefs: [out!], evidenceQuery: { evidenceType: 'test-result' } });
            case 3:
              return call('evidence.get', { evidenceId: tr! });
            default:
              return call('complete_work', { summary: 'claimed', evidenceRefs: [tr!], output: { summary: 'claimed', executed: [{ selector: 'all', passed: false, outcome: 'failed', evidenceIds: [tr!] }], findings: [] } });
          }
        }),
        test_designer: recorder(design, async (step, v) => {
          const [tr] = await h.deps.evidence.query({ runId: v.runId, evidenceType: 'test-result' });
          const [out] = await h.deps.evidence.query({ runId: v.runId, evidenceType: 'stdout' });
          switch (step) {
            case 0:
              return call('oracle.propose_change', {
                oracleId: 'oracle.pricing', fromRevision: 1, rationale: 'the current behaviour looks intended',
                proposedAssertions: [{ assertionId: 'discount-10', description: 'discount applied', kind: 'llm_semantic', severity: 'P3' }], relatedEvidenceRefs: [tr!.evidenceId],
              });
            case 1:
              return call('test_artifact.register', { path: 'test/pricing.test.js', sourceType: 'existing', runner: { framework: 'node_test', selector: 'test/pricing.test.js' }, oracleRefs: [] });
            case 2:
              return call('test_artifact.validate', { artifactId: parsed(design[1]!.content)['artifactId'] as string, knownGoodEvidenceId: out!.evidenceId, knownBadEvidenceId: tr!.evidenceId });
            default:
              return call('complete_work', { summary: 'nothing validated', output: { summary: 'nothing validated', testArtifacts: [] } });
          }
        }),
      },
    });
    await pricingOracle(h);
    const run = await h.control.startRun({ goal: 'claims', target: { repoPath: repo.path, commit: repo.head }, oracleIds: ['oracle.pricing'] });
    runId = run.runId;
    for (let i = 0; i < 3; i++) {
      const t = await h.control.tick(runId);
      for (const d of t.dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
    }
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('evidence.claim stores only claims supported by matching, intact evidence; critical claims reach the gate input', async () => {
    const [ran, claimed, refused, got] = exec;
    assert.match(ran!.content, /NOT PASSED/);
    assert.equal(claimed!.isError, false, claimed!.content);
    assert.equal(parsed(claimed!.content)['critical'], true);
    assert.equal(refused!.isError, true);
    assert.match(refused!.content, /unsupported_claim: claim not supported by its evidence: evidence ev_\w+ has type stdout, claim requires test-result/);
    const claims = await new ControlStore(h.db).claims(runId);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.statement, 'the pricing suite fails on the candidate');
    const view = parsed(got!.content);
    assert.equal(view['evidenceType'], 'test-result');
    assert.equal((view['structured'] as { passed: boolean }).passed, false);
    assert.match(view['preview'] as string, /"passed":false/);
    const report = await h.control.report(runId);
    assert.equal(report.claims.length, 1);
    assert.match(report.markdown, /- \*\*critical\*\* the pricing suite fails on the candidate = false — evidence ev_\w+ — provenance complete/);
  });

  test('an agent may only propose an oracle change (pending, attributed to its provider); weak validations keep an artifact draft', async () => {
    const [proposal, registered, validation] = design;
    assert.equal(proposal!.isError, false, proposal!.content);
    const p = (await h.deps.specs.getOracleProposal(parsed(proposal!.content)['proposalId'] as string))!;
    assert.equal(p.status, 'pending');
    assert.deepEqual(p.proposedBy, { kind: 'agent', id: p.proposedBy.id, role: 'test_designer', modelProvider: 'alpha' });
    assert.equal((await h.deps.specs.getOracle('oracle.pricing'))!.revision, 1, 'the oracle is unchanged until an independent approval');
    assert.equal(parsed(registered!.content)['sourceType'], 'generated');
    const v = parsed(validation!.content);
    assert.equal(v['approvalState'], 'draft');
    const reasons = v['reasons'] as string[];
    assert.equal(reasons.length, 3);
    assert.equal(reasons[0], 'known-good: known-good evidence must be a test-result (got stdout)');
    assert.match(reasons[1]!, /^known-bad: test-result ev_\w+ does not run artifact ta_\w+ \(test\/pricing\.test\.js\)$/);
    assert.equal(reasons[2], 'sensitivity not demonstrated (needs a failing known-bad run or a killed mutant)');
  });
});

describe('test_artifact.validate binds sensitivity proofs to the artifact\'s own file (never a name substring or another file\'s failure)', () => {
  test('failures of other files (a suffix-named file, a mislabelled link, a mixed run) prove nothing; the artifact\'s own failing case does', async () => {
    const repo = await pricingRepo();
    const design: Result[] = [];
    const ev: Record<string, string> = {};
    let h!: Harness;
    const seed = async (runId: string, key: string, structured: Record<string, unknown>) => {
      const run = (await h.deps.runs.get(runId))!;
      const artifact = await h.deps.artifacts.put(Buffer.from(key), { mimeType: 'text/plain' });
      ev[key] = (await h.deps.evidence.append({ runId, evidenceType: 'test-result', artifact, summary: key, structured: structured as never, producer: { workerId: 'seed', runtimeManifestId: run.runtimeManifestId }, provenance: {} })).evidenceId;
    };
    const failed = (file: string) => ({ id: `${file}::t`, name: 't', file, status: 'failed' });
    const passed = (file: string) => ({ id: `${file}::t`, name: 't', file, status: 'passed' });
    h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.step === 0) return call('plan.propose_revision', { rationale: 'design', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P1' }], workItems: [{ localId: 'd', title: 'design', objective: 'design', role: 'test_designer', dependsOn: [], objectiveIds: ['o'] }] });
          return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
        },
        test_designer: recorder(design, async (step, v) => {
          const artifactId = design[1] ? (parsed(design[1].content)['artifactId'] as string) : '';
          switch (step) {
            case 0:
              return call('fs.write', { path: 'test/a.test.js', content: "import { test } from 'node:test';\ntest('t', () => {});\n" });
            case 1:
              return call('test_artifact.register', { path: 'test/a.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/a.test.js' }, oracleRefs: [] });
            case 2:
              await seed(v.runId, 'suffix', { passed: false, totals: { failed: 1 }, cases: [failed('test/data.test.js')] });
              await seed(v.runId, 'mislinked', { passed: false, totals: { failed: 1 }, testArtifactId: artifactId, cases: [failed('test/data.test.js')] });
              await seed(v.runId, 'mixed', { passed: false, totals: { failed: 1 }, cases: [passed('test/a.test.js'), failed('test/data.test.js')] });
              await seed(v.runId, 'own', { passed: false, totals: { failed: 1 }, cases: [passed('test/data.test.js'), failed('/abs/ws/test/a.test.js')] });
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: ev['suffix']! });
            case 3:
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: ev['mislinked']! });
            case 4:
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: ev['mixed']! });
            case 5:
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: ev['own']! });
            default:
              return call('complete_work', { summary: 'validated', output: { summary: 'validated', testArtifacts: [] } });
          }
        }),
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'sensitivity', target: { repoPath: repo.path, commit: repo.head } });
      for (let i = 0; i < 2; i++) for (const d of (await h.control.tick(run.runId)).dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
      const [, registered, suffix, mislinked, mixed, own] = design;
      assert.equal(registered!.isError, false, registered!.content);
      for (const r of [suffix, mislinked]) {
        assert.equal(parsed(r!.content)['approvalState'], 'draft');
        assert.match(r!.content, /known-bad: test-result ev_\w+ does not run artifact ta_\w+ \(test\/a\.test\.js\)/);
      }
      assert.equal(parsed(mixed!.content)['approvalState'], 'draft');
      assert.match(mixed!.content, /known-bad: the test did not fail with an assertion failure on the known-bad code/);
      assert.equal(parsed(own!.content)['approvalState'], 'validated', own!.content);
      const v = parsed(own!.content)['validations'] as { knownBad: { detail: string } };
      assert.equal(v.knownBad.detail, 'failed on known-bad code (1 failed cases of this artifact)');
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });
});
