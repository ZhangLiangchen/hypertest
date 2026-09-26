/**
 * PoC B — event-driven black-box defect loop, one trial of the scripted multi-LLM arm with every bus message delivered
 * twice. Every grader of the task passes and the acceptance table ("首批 PoC：Event-driven 黑盒缺陷闭环") is asserted
 * row by row from the recorded state and the bank API's own ground truth.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Hypothesis } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { pocBTask, runTrial, scriptedMultiLlmArm } from '../src/index.ts';
import { assertSchemasDropped, capture, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('b');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-poc-b-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('PoC B: finding.created wakes RCA and the test designer without the lead; duplicates change nothing; the report traces to HTTP evidence', async () => {
  const acceptance = capture(async (ctx) => {
    const d = ctx.data;
    const evidence = new Map(d.evidence.map((e) => [e.evidenceId, e]));
    const created = d.events.find((e) => e.eventType === 'finding.created');
    const creators = new Map(d.events.filter((e) => e.eventType === 'work.created').map((e) => [String(payloadOf(e)['workItemId']), e.actorId]));
    const hypotheses = await ctx.ht.services.blackboard.query<Hypothesis>({ runId: d.runId!, recordType: 'hypothesis' });
    const artifacts = await ctx.ht.services.specs.listTestArtifacts(d.runId!);
    const reactions = d.workItems.filter((w) => w.origin.kind === 'reactor');
    return {
      verdict: d.decision?.verdict,
      status: d.status,
      violated: d.decision?.violatedCriteria.map((c) => c.criterionId).sort(),
      planned: d.workItems.filter((w) => w.origin.kind === 'plan').map((w) => w.role).sort(),
      reactions: reactions.map((w) => `${w.role}←${creators.get(w.workItemId)}${w.causationEventId === created?.eventId ? ' (caused by finding.created)' : ''}:${w.state}`).sort(),
      duplicateDelivery: d.harness.duplicateDelivery,
      effects: Object.values(d.probes['sideEffects'] as Record<string, number>),
      fingerprints: new Set(d.workItems.map((w) => w.fingerprint)).size === d.workItems.length,
      findings: d.findings.map((f) => ({ title: f.payload.title, status: f.payload.status, evidence: [...new Set(f.evidenceRefs.map((id) => evidence.get(id)?.evidenceType))].sort() })),
      hypotheses: hypotheses.map((h) => ({ status: h.payload.status, lineage: h.payload.findingLineageId === d.findings[0]?.lineageId, evidence: h.evidenceRefs.length > 0 })),
      artifacts: artifacts.map((a) => `${a.path}:${a.approvalState}`),
      reportFindingEvidence: [...new Set((d.report?.findings ?? []).flatMap((f) => f.evidenceRefs.map((id) => evidence.get(id)?.evidenceType)))].sort(),
      acceptedNegative: d.evidence.filter((e) => {
        const s = e.structured as { request?: { method?: string; path?: string; body?: string }; response?: { status?: number } } | undefined;
        return e.evidenceType === 'api-response' && s?.request?.method === 'POST' && s.request.path === '/transfers' && s.response?.status === 201 && /"amount":\s*-30\b/.test(s.request.body ?? '');
      }).length,
      open: d.workItems.filter((w) => !['completed', 'failed', 'cancelled'].includes(w.state)).length,
      // the environment (and its generation) each HTTP exchange cited by the findings was captured in (provenance anchor)
      findingHttpEnvironments: [...new Set(d.findings.flatMap((f) => f.evidenceRefs.map((id) => evidence.get(id)).filter((e) => e?.evidenceType === 'api-response').map((e) => (e!.environment ? `${e!.environment.environmentId}@${e!.environment.generation}` : 'none'))))],
      health: d.probes['bankHealth'],
    };
  });
  const task = pocBTask();
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'trial'), { graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'fail', undefined]);
  const a = acceptance.value();

  // Event-driven + Decentralized — the lead planned only the executor; RCA and the test designer were created by the
  // reactors from the finding.created event (never by the lead), exactly once each
  assert.deepEqual(a.planned, ['executor']);
  assert.deepEqual(a.reactions.filter((r) => !r.startsWith('reviewer')), [
    'rca←system:reactors (caused by finding.created):completed', 'test_designer←system:reactors (caused by finding.created):completed',
  ]);
  // Blackboard — finding, hypothesis and regression test are separate records
  assert.deepEqual(a.findings, [{ title: 'POST /transfers accepts a negative amount and moves money backwards', status: 'confirmed', evidence: ['api-response', 'stdout'] }]);
  assert.deepEqual(a.hypotheses, [{ status: 'supported', lineage: true, evidence: true }]);
  assert.deepEqual(a.artifacts, ['regression/negative-transfer.test.mjs:validated']);
  // Duplicate event — delivered twice, yet no duplicate work (unique fingerprints) and every external effect exactly once
  assert.equal(a.duplicateDelivery, true);
  assert.equal(a.fingerprints, true);
  assert.ok(a.effects.length >= 4, `effects ${JSON.stringify(a.effects)}`);
  assert.deepEqual([...new Set(a.effects)], [1]);
  // Claim — one valid lease owner per work item (singleLeaseOwner passed above); Causal chain (causalChain passed above)
  assert.equal(trial.graders.find((g) => g.graderId === 'singleLeaseOwner')?.pass, true);
  assert.equal(trial.graders.find((g) => g.graderId === 'causalChain')?.pass, true);
  // Convergence — a final decision, the run completed, no open work
  assert.deepEqual([a.status, a.open], ['completed', 0]);
  // Evidence — the verdict and the report trace to the recorded HTTP exchange (POST /transfers amount -30 ⇒ 201)
  assert.equal(a.acceptedNegative, 1);
  assert.ok(a.violated?.includes('C3'), `violated ${a.violated?.join(', ')}`);
  assert.ok(a.reportFindingEvidence.includes('api-response'), a.reportFindingEvidence.join(', '));
  assert.deepEqual(a.findingHttpEnvironments, ['bank@1']);
  // ground truth: money is conserved (the defect is invisible to the total — only the contract test catches it). The
  // executor opened alice (100) and bob (50); the regression test run opened two more accounts (10 each)
  assert.deepEqual(a.health, { status: 'ok', accounts: 4, total: 170, deposited: 170, balanceConserved: true });
});
