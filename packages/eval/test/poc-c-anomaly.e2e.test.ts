/**
 * (F[4], coverage[9], coverage[10]) PoC C complete — metrics → anomaly → RCA ∥ metrics ∥ executor → targeted regression,
 * one trial of the scripted multi-LLM arm with Hypertest in a CHILD PROCESS that is SIGKILLed right after the load job
 * was acknowledged. kv-service carries a seeded hot-key latency anomaly (every 10th GET of k1 takes 400 ms more).
 *
 * Asserted row by row from the recorded state: the metrics analyst found the anomaly in the load job's METRIC evidence
 * and posted a performance finding; its finding.created event created the RCA and the TestDesigner work through the
 * reactors (system:reactors, not the lead); RCA ran AT THE SAME TIME as the metrics analysis and the executor; RCA posted
 * an evidence-backed hypothesis on the finding's lineage; the TestDesigner's targeted regression test (bound to kv-slo C1)
 * failed on the anomaly; the gate failed the run on C1. And the negative control: the SAME graders fail a trial whose
 * anomaly flow did not happen (the healthy PoC C run) — they are not vacuous.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Hypothesis } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { KV_REGRESSION_TEST_PATH, maxConcurrent, pocCAnomalyTask, pocCTask, runTrial, scriptedMultiLlmArm } from '../src/index.ts';
import { assertSchemasDropped, capture, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('x');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-poc-c-anomaly-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('PoC C anomaly: a metric anomaly becomes a finding, reactor RCA runs in parallel with metrics and executor, a targeted regression fails on it', async () => {
  const acceptance = capture(async (ctx) => {
    const d = ctx.data;
    const evidence = new Map(d.evidence.map((e) => [e.evidenceId, e]));
    const roleOf = new Map(d.events.filter((e) => e.eventType === 'agent.spawned').map((e) => [String(payloadOf(e)['agentId'] ?? e.aggregateId), String(payloadOf(e)['role'])]));
    const created = d.events.filter((e) => e.eventType === 'finding.created');
    const anomaly = d.findings.find((f) => f.payload.category === 'performance');
    const createdEvent = created.find((e) => payloadOf(e)['lineageId'] === anomaly?.lineageId);
    const reactions = d.workItems.filter((w) => w.origin.kind === 'reactor' && createdEvent !== undefined && w.origin.eventId === createdEvent.eventId);
    const workCreatedBy = new Map(d.events.filter((e) => e.eventType === 'work.created').map((e) => [String(payloadOf(e)['workItemId'] ?? e.aggregateId), e.actorId]));
    const hypotheses = await ctx.ht.services.blackboard.query<Hypothesis>({ runId: d.runId!, recordType: 'hypothesis' });
    const artifacts = await ctx.ht.services.specs.listTestArtifacts(d.runId!);
    const regression = artifacts.filter((a) => a.path === KV_REGRESSION_TEST_PATH);
    const ids = (role: string) => d.workItems.filter((w) => w.role === role).map((w) => w.workItemId);
    return {
      verdict: d.decision?.verdict,
      violated: d.decision?.violatedCriteria.map((c) => c.criterionId) ?? [],
      status: d.status,
      restarts: d.harness.restarts,
      anomalyAuthor: createdEvent ? roleOf.get(createdEvent.agentId ?? '') : undefined,
      anomalyEvidence: anomaly?.evidenceRefs.map((id) => evidence.get(id)?.evidenceType) ?? [],
      anomalyStatus: anomaly?.payload.status,
      reactions: reactions.map((w) => `${w.role}←${workCreatedBy.get(w.workItemId)}`).sort(),
      hypothesisOnLineage: hypotheses.filter((h) => h.payload.findingLineageId === anomaly?.lineageId && h.evidenceRefs.length > 0).map((h) => roleOf.get(h.createdBy)),
      regression: regression.map((a) => ({ oracleRefs: a.oracleRefs.map((r) => `${r.oracleId}:${r.assertionIds.join(',')}`), by: roleOf.get(a.generatedBy?.agentId ?? ''), knownBad: a.validations.knownBad?.status })),
      regressionRuns: d.evidence.filter((e) => e.evidenceType === 'test-result' && regression.some((a) => (e.structured as { testArtifactId?: unknown }).testArtifactId === a.artifactId)).map((e) => (e.structured as { passed?: unknown }).passed),
      parallel: maxConcurrent(d.events, new Set([...ids('rca'), ...ids('metrics_analyst'), ...ids('executor')])),
      loadJobs: (d.probes['loadJobs'] as Array<{ state?: string }>).map((j) => j.state),
    };
  });
  const task = pocCAnomalyTask();
  const trial = await runTrial(
    { ...task, graders: [...task.graders, 'acceptance'] },
    scriptedMultiLlmArm,
    trialOptions(PREFIX, join(root.path, 'anomaly'), { mode: 'child-process', graders: { acceptance: acceptance.grader } }),
  );
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'fail', undefined]);
  const a = acceptance.value();
  // Durable — the process was SIGKILLed after the load job was acknowledged and a resumed process finished the run; the
  // job ran exactly once
  assert.deepEqual([a.restarts, a.status, a.loadJobs], [1, 'completed', ['completed']]);
  // Metrics → anomaly: the metrics analyst posted the performance finding on the load job's metric evidence
  assert.equal(a.anomalyAuthor, 'metrics_analyst');
  assert.ok(a.anomalyEvidence.includes('metric'), a.anomalyEvidence.join(', '));
  // → the reactors (not the lead) created the RCA and TestDesigner work from the finding.created event
  assert.deepEqual(a.reactions, ['rca←system:reactors', 'test_designer←system:reactors']);
  // → RCA posted an evidence-backed hypothesis on the finding's lineage and confirmed the finding
  assert.deepEqual(a.hypothesisOnLineage, ['rca']);
  assert.equal(a.anomalyStatus, 'confirmed');
  // RCA ∥ metrics ∥ executor
  assert.ok(a.parallel >= 3, `max ${a.parallel} concurrently`);
  // targeted regression: bound to kv-slo C1, generated by the TestDesigner reaction, its recorded run FAILED on the anomaly
  assert.deepEqual(a.regression, [{ oracleRefs: ['kv-slo:C1'], by: 'test_designer', knownBad: 'passed' }]);
  assert.ok(a.regressionRuns.includes(false), JSON.stringify(a.regressionRuns));
  // Gate — the SLO is violated on recorded metric evidence: fail (never pass)
  assert.equal(a.verdict, 'fail');
  assert.ok(a.violated.includes('C3') || a.violated.length > 0, a.violated.join(', '));
});

test('PoC C anomaly graders are not vacuous: a run without the anomaly flow fails anomalyReaction and rcaMetricsExecutorParallel', async () => {
  // the healthy PoC C run (no anomaly, no reactions) graded with the anomaly graders
  const task = pocCTask({ chaos: {}, graders: ['anomalyReaction', 'rcaMetricsExecutorParallel'] });
  const trial = await runTrial(task, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'healthy')));
  const byId = Object.fromEntries(trial.graders.map((g) => [g.graderId, g]));
  assert.equal(byId['anomalyReaction']?.pass, false, JSON.stringify(trial.graders));
  assert.match(byId['anomalyReaction']!.detail, /no performance finding posted by the metrics analyst/);
  assert.equal(byId['rcaMetricsExecutorParallel']?.pass, false);
  assert.match(byId['rcaMetricsExecutorParallel']!.detail, /RCA \(reactor\), the metrics analysis and the executor completed/);
  assert.equal(trial.result, 'fail');
});
