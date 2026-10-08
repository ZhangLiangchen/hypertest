/**
 * (CONFORMANCE "Typical event catalog emitted (work.*, finding.*, hypothesis.*, coverage.gap_detected, evidence.attached,
 * test.failed/recovered, review.requested/completed, gate.*)"): every event type of the design's typical catalog is emitted
 * by REAL runs of the composed product — scanned from L0 of two scripted runs: a defect run (a failing-then-recovering test,
 * reactors waking RCA and the test designer, an independent run review, gate fail) and the tiny passing run (gate pass).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createGitRepo, tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { FULL_ROUTE, OBJECTIVE, SUM_TEST, call, evidenceIds, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type RoleBrain } from './helpers.ts';

/** The design's typical events (technology-selection §Blackboard / Event). */
const TYPICAL = [
  'work.created', 'work.claimed', 'work.completed',
  'finding.created', 'finding.confirmed', 'finding.rejected',
  'hypothesis.created', 'hypothesis.refuted',
  'coverage.gap_detected',
  'evidence.attached',
  'test.failed', 'test.recovered',
  'review.requested', 'review.completed',
  'gate.failed', 'gate.passed',
] as const;

const rec = (text: string) => /"recordId":"(rec_\w+)"/.exec(text)?.[1];

let dir: Awaited<ReturnType<typeof tempDir>>;
let markers: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof createGitRepo>>;
let tiny: Awaited<ReturnType<typeof sumRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
let defectHt: HypertestInstance | undefined;
let passHt: HypertestInstance | undefined;

before(async () => {
  dir = await tempDir('ht-app-catalog-');
  markers = await tempDir('ht-app-catalog-marker-');
  db = await testStore();
  const marker = join(markers.path, 'flaky-seen');
  repo = await createGitRepo({
    'package.json': '{ "name": "calc", "type": "module", "private": true }\n',
    'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
    'test/sum.test.js': SUM_TEST,
    // fails on its first run, passes afterwards: a failing test that recovers on later evidence
    'test/flaky.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync, writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(marker)};\ntest('sum survives a cold cache', () => {\n  if (!existsSync(marker)) {\n    writeFileSync(marker, 'seen');\n    assert.fail('cold cache: the first run fails');\n  }\n});\n`,
  });
  tiny = await sumRepo();
});
after(async () => {
  await defectHt?.close();
  await passHt?.close();
  await db?.dispose();
  await repo?.cleanup();
  await tiny?.cleanup();
  await markers?.cleanup();
  await dir?.cleanup();
});

function defectBrains(): Record<string, RoleBrain> {
  const lead: RoleBrain = (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'sum', name: 'sum module', kind: 'module', paths: ['src/sum.js'] }], sources: [{ kind: 'file', id: 'src/sum.js' }] });
      if (v.step === 1) {
        return call('plan.propose_revision', {
          rationale: 'Run the flaky-prone suite on the candidate.', objectives: [OBJECTIVE],
          workItems: [{ localId: 'run', title: 'Run the suite', objective: 'Run test/flaky.test.js on the candidate and report with evidence.', role: 'executor', dependsOn: [], objectiveIds: ['obj-sum'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] }],
        });
      }
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-sum', status: 'open', evidenceRefs: [] }] } });
    }
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'Executed; hand over to the gate.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready for the gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status: 'satisfied', evidenceRefs: [] }] } });
  };
  const finding = (title: string, extra: Record<string, unknown>) => ({ title, description: `${title}: observed on the candidate`, severity: 'P1', category: 'product_defect', component: 'sum', ...extra });
  const executor: RoleBrain = (v) => {
    if (v.step === 0 || v.step === 1) return call('test.run', { framework: 'node_test', selector: 'test/flaky.test.js' });
    const ids = [...new Set(v.toolResults.flatMap((r) => evidenceIds(r.content)))];
    if (v.step === 2) return call('blackboard.post_finding', finding('sum fails on a cold cache', { evidenceRefs: ids.slice(0, 1) }));
    return call('complete_work', {
      summary: 'The suite failed on a cold cache and passed on the retry.', evidenceRefs: ids, recordRefs: [rec(v.toolResults.at(-1)!.content)!],
      output: { summary: 'flaky failure', executed: [{ selector: 'test/flaky.test.js', passed: false, outcome: 'failed', evidenceIds: ids }], findings: [rec(v.toolResults.at(-1)!.content)!] },
    });
  };
  const rca: RoleBrain = (v) => {
    const target = /Determine the root cause of finding (rec_\w+)/.exec(v.userText)?.[1];
    const ev = evidenceIds(v.userText).slice(0, 1);
    const results = v.toolResults;
    switch (v.step) {
      case 0: return call('blackboard.post_hypothesis', { findingRecordId: target!, statement: 'A cold cache returns a stale sum.', confidence: 0.4, suggestedChecks: ['rerun cold'] });
      case 1: return call('blackboard.post_hypothesis', { updatesRecordId: rec(results[0]!.content)!, findingRecordId: target!, statement: 'A cold cache returns a stale sum.', status: 'refuted', confidence: 0.1, evidenceRefs: ev });
      case 2: return call('blackboard.post_finding', { ...finding('sum fails on a cold cache', { evidenceRefs: ev }), updatesRecordId: target!, status: 'confirmed' });
      case 3: return call('blackboard.post_finding', { title: 'the cold-cache test is mis-written', description: 'suspected test defect', severity: 'P3', category: 'test_defect', evidenceRefs: [] });
      case 4: return call('blackboard.post_finding', { title: 'the cold-cache test is mis-written', description: 'not a test defect after all', severity: 'P3', category: 'test_defect', evidenceRefs: ev, updatesRecordId: rec(results[3]!.content)!, status: 'rejected' });
      default: return call('complete_work', {
        summary: 'Hypothesis refuted; the defect is confirmed.', recordRefs: [target!],
        output: { summary: 'confirmed', hypotheses: [rec(results[0]!.content)!], rootCause: { status: 'hypothesis', statement: 'unknown cold-cache path' }, reproduction: 'not_attempted', findingRecordId: target! },
      });
    }
  };
  const testDesigner: RoleBrain = (v) => {
    if (v.step === 0) return call('blackboard.report_coverage_gap', { area: 'sum cold-cache path', description: 'no deterministic test covers the cold cache' });
    return call('complete_work', { summary: 'gap reported', output: { summary: 'gap reported', testArtifacts: [] } });
  };
  const reviewer: RoleBrain = (v) => {
    if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
    const ids = evidenceIds(v.toolResults[0]!.content);
    // the run-level review the gate requests (review.requested) judges the run; any other review work judges its input record
    const runReview = /Review the run as a whole/.test(v.userText);
    const input = /Input record (rec_\w+) /.exec(v.userText)?.[1];
    const subjectRef = runReview || !input ? { kind: 'run', id: v.runId } : { kind: 'record', id: input };
    if (v.step === 1) return call('blackboard.post_review', { subjectRef, verdict: 'approve', rationale: 'The recorded test results show the failure and the retry.', checkedEvidenceRefs: ids });
    const r = rec(v.toolResults.at(-1)!.content)!;
    return call('complete_work', { summary: 'run review: approve', evidenceRefs: ids, recordRefs: [r], output: { summary: 'approve', verdict: 'approve', reviews: [r], checkedEvidenceIds: ids } });
  };
  return { lead, executor, rca, test_designer: testDesigner, reviewer };
}

test('every event type of the typical catalog is emitted by real runs (L0 scan of a defect run and a passing run)', async () => {
  const seen = new Set<string>();
  // the defect run: two scripted providers (the run reviewer must be independent of the producers)
  const base = scriptedConfig(join(dir.path, 'defect'));
  const config: HypertestConfig = {
    ...base,
    models: {
      ...base.models,
      providers: [{ id: 'sim', kind: 'scripted' }, { id: 'sim2', kind: 'scripted' }],
      routes: [
        { routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { default: 0.9, reviewer: 0.5 } },
        { routeId: 'sim-review', provider: 'sim2', model: 'sim-2', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { default: 0.5, reviewer: 0.99 } },
      ],
    },
    ...(db.store ? { store: db.store } : {}),
  } as HypertestConfig;
  const brain = roleRouter(defectBrains());
  defectHt = await createHypertest(config, { scriptedBrains: { sim: brain, sim2: brain }, logger: new MemoryLogger() });
  const defect = await defectHt.run({ goal: 'Is the sum module releasable under a cold cache?', target: { repoPath: repo.path, commit: repo.commits[0]! } }, { timeoutMs: 180_000 });
  assert.equal(defect.status, 'completed', JSON.stringify(defect));
  const states = (await defectHt.services.blackboard.listWorkItems({ runId: defect.runId })).map((w) => `${w.role}:${w.state}${w.failure ? ` (${w.failure.reason}: ${w.failure.message})` : ''}`);
  assert.equal(defect.decision?.verdict, 'fail', `${defect.decision?.reasons.join('\n')}\n${states.join('\n')}`);
  for (const e of await defectHt.services.events.read(defect.runId)) seen.add(e.eventType);
  const recovered = await defectHt.services.events.read(defect.runId, { types: ['test.recovered'] });
  assert.equal(recovered.length, 1, 'the cold-cache test recovered once');
  await defectHt.close();
  defectHt = undefined;

  // the tiny passing run
  const passConfig = scriptedConfig(join(dir.path, 'pass'), { gate: { requireIndependentReview: false } });
  passHt = await createHypertest(db.store ? { ...passConfig, store: db.store } : passConfig, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
  const pass = await passHt.run({ goal: 'Is the sum module releasable?', target: { repoPath: tiny.path, commit: tiny.head } }, { timeoutMs: 120_000 });
  assert.equal(pass.decision?.verdict, 'pass', pass.decision?.reasons.join('\n'));
  for (const e of await passHt.services.events.read(pass.runId)) seen.add(e.eventType);

  const missing = TYPICAL.filter((t) => !seen.has(t));
  assert.deepEqual(missing, [], `typical events never emitted: ${missing.join(', ')}`);
});
