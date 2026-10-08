/**
 * (F[5], F[7]) The extended core suites end to end — one trial per task of the scripted multi-LLM arm, real fixtures,
 * real Hypertest (in-process): API/UI black-box, Performance, FaultTolerance, Evidence and MultiAgent. Every grader of
 * every task passes and the run reaches the task's expected verdict; selected acceptance facts are asserted from the
 * recorded state. The UI task needs the local Chromium (skipped with the reason when it is absent).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { chromiumExecutablePath } from '@hypertest/tools';
import {
  apiBlackboxTask, apiUiBlackboxSuite, evidenceMissingTask, evidenceSuite, evidenceTamperTask, faultToleranceErrorsTask, faultToleranceLatencyTask, faultToleranceSuite, multiAgentConvergenceTask,
  multiAgentDelegationTask, multiAgentSuite, performanceRegressionTask, performanceSloTask, performanceSuite, runTrial, scriptedMultiLlmArm, uiBlackboxTask, type EvalTask, type EvalTrial,
} from '../src/index.ts';
import { assertSchemasDropped, capture, failures, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('e');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-extended-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

let n = 0;
async function trialOf(task: EvalTask, extra: Parameters<typeof trialOptions>[2] = {}): Promise<EvalTrial> {
  return runTrial(task, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, `t${++n}`), extra));
}

function assertPassed(trial: EvalTrial, verdict: string): void {
  assert.deepEqual(failures(trial), [], JSON.stringify({ error: trial.error, graders: trial.graders.filter((g) => !g.pass) }, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', verdict, undefined]);
}

test('the extended suites are registered with their tasks', () => {
  assert.deepEqual(apiUiBlackboxSuite().tasks.map((t) => t.taskId), ['api-blackbox-transfers', 'ui-blackbox-transfer-feedback']);
  assert.deepEqual(performanceSuite().tasks.map((t) => t.taskId), ['performance-slo', 'performance-regression']);
  assert.deepEqual(faultToleranceSuite().tasks.map((t) => t.taskId), ['fault-tolerance-latency', 'fault-tolerance-errors']);
  assert.deepEqual(evidenceSuite().tasks.map((t) => t.taskId), ['evidence-tamper-detected', 'evidence-missing-not-passed']);
  assert.deepEqual(multiAgentSuite().tasks.map((t) => t.taskId), ['multi-agent-delegation', 'multi-agent-convergence']);
});

test('API black-box: the transfer contract over HTTP only (no white-box tool) ⇒ fail on the defect', async () => {
  assertPassed(await trialOf(apiBlackboxTask()), 'fail');
});

test('UI black-box: a real browser shows the swallowed rejection; dom-snapshot evidence ⇒ fail', { skip: existsSync(chromiumExecutablePath()) ? false : `no local Chromium at ${chromiumExecutablePath()} (the browser tools need it)` }, async () => {
  const acceptance = capture((ctx) => ({
    shown: ctx.data.evidence.filter((e) => e.evidenceType === 'dom-snapshot').map((e) => (e.structured as { text?: string }).text),
    screenshots: ctx.data.evidence.filter((e) => e.evidenceType === 'screenshot').length,
  }));
  const task = uiBlackboxTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'fail');
  assert.deepEqual(acceptance.value().shown, ['Transfer complete']);
  assert.ok(acceptance.value().screenshots >= 1);
});

test('Performance: a healthy service passes its SLO on the load job metric evidence', async () => {
  assertPassed(await trialOf(performanceSloTask()), 'pass');
});

test('Performance: a hot-key latency regression is found in the metrics, analysed and covered ⇒ fail', async () => {
  assertPassed(await trialOf(performanceRegressionTask()), 'fail');
});

test('FaultTolerance: under a controlled latency fault the error-rate invariant holds and the service recovers ⇒ pass', async () => {
  const acceptance = capture((ctx) => ({ faults: (ctx.data.probes['faults'] as Array<{ fault: { kind: string } }>).map((f) => f.fault.kind), ops: ctx.data.operations.map((o) => `${o.operationType}:${o.status}`).sort() }));
  const task = faultToleranceLatencyTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'pass');
  assert.deepEqual(acceptance.value(), { faults: ['latency'], ops: ['env.inject_fault:verified', 'load.start:verified'] });
});

test('FaultTolerance: a controlled error-rate fault breaks the invariant (no masking in kv-service) ⇒ fail', async () => {
  const acceptance = capture((ctx) => ({ violated: ctx.data.decision?.reasons.filter((r) => /violated/.test(r)) }));
  const task = faultToleranceErrorsTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'fail');
  assert.ok(acceptance.value().violated?.some((r) => /kv-resilience@1\/R1 \(P1\) violated: errorRate < 0\.01 violated/.test(r)), JSON.stringify(acceptance.value()));
});

test('Evidence: tampered, deleted and rewritten evidence is named exactly by the independent verifier', async () => {
  const acceptance = capture((ctx) => ({ attack: ctx.data.probes['afterRun'] as { tampered: string[]; missing: string[]; rewritten: string[]; updateRefused: boolean }, kinds: [...new Set((ctx.data.verification?.problems ?? []).map((p) => p.kind))].sort() }));
  const task = evidenceTamperTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'pass');
  const a = acceptance.value();
  assert.equal(a.attack.updateRefused, true);
  assert.ok(a.attack.tampered.length >= 1 && a.attack.missing.length >= 1 && a.attack.rewritten.length === 1, JSON.stringify(a.attack));
  assert.deepEqual(a.kinds, ['artifact_hash', 'artifact_missing', 'metadata_hash']);
});

test('Evidence: missing critical evidence is never a pass (inconclusive, the gate names it)', async () => {
  assertPassed(await trialOf(evidenceMissingTask()), 'inconclusive');
});

test('MultiAgent: three analyses delegated in one turn run in parallel; the lead plans from their summaries ⇒ fail on the defect', async () => {
  assertPassed(await trialOf(multiAgentDelegationTask()), 'fail');
});

test('MultiAgent: two independent executors converge on one finding, one RCA, one decision', async () => {
  assertPassed(await trialOf(multiAgentConvergenceTask()), 'fail');
});
