/**
 * (F[6]) The chaos suite cases end to end — one trial each of the scripted multi-LLM arm, real fixtures:
 *  - kill after an external SUCCESS (child process, real SIGKILL right after the restart was verified): never repeated;
 *  - budget exhaustion: the run converges without the evidence it could not afford — never a pass;
 *  - competing fault experiments on one environment: serialized by admission, no contaminated measurement;
 *  - an unknown outcome on a target that cannot be queried: manual review, never re-sent; a human operator resolves it.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import {
  chaosBudgetExhaustionTask, chaosCompetingFaultsTask, chaosKillAfterSuccessTask, chaosSuite, chaosUnqueryableTargetTask, runTrial, scriptedMultiLlmArm, type EvalTask, type EvalTrial,
} from '../src/index.ts';
import { assertSchemasDropped, capture, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('k');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-chaos-')));
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

test('the chaos suite lists its cases', () => {
  assert.deepEqual(chaosSuite().tasks.map((t) => t.taskId), ['chaos-kill-after-success', 'chaos-budget-exhaustion', 'chaos-competing-faults', 'chaos-unqueryable-target']);
});

test('chaos: SIGKILL right after the restart succeeded externally — the resumed process never restarts again', async () => {
  const acceptance = capture((ctx) => ({ restarts: ctx.data.harness.restarts, effects: ctx.data.probes['sideEffects'] as Record<string, number> }));
  const task = chaosKillAfterSuccessTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { mode: 'child-process', graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'pass');
  const a = acceptance.value();
  assert.equal(a.restarts, 1);
  assert.equal(a.effects['kv:restarts'], 1);
});

test('chaos: budget exhaustion converges to an honest verdict (inconclusive), never a pass', async () => {
  const acceptance = capture((ctx) => ({ exhausted: ctx.data.events.filter((e) => e.eventType === 'budget.exhausted').length, reasons: ctx.data.decision?.reasons ?? [] }));
  const task = chaosBudgetExhaustionTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'inconclusive');
  assert.ok(acceptance.value().exhausted >= 1);
  assert.ok(acceptance.value().reasons.some((r) => /unproven: no metric evidence/.test(r)), acceptance.value().reasons.join('\n'));
});

test('chaos: competing fault experiments are serialized by admission; each measurement saw only its own fault', async () => {
  const acceptance = capture((ctx) => ({
    refused: ctx.data.events.filter((e) => e.eventType === 'admission.refused').map((e) => (payloadOf(e)['conflicts'] as string[]).some((c) => c.startsWith('env/kv@'))),
    jobs: (ctx.data.probes['loadJobs'] as Array<{ errorRate?: number }>).map((j) => (j.errorRate ?? -1) > 0).sort(),
  }));
  const task = chaosCompetingFaultsTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'fail');
  const a = acceptance.value();
  assert.ok(a.refused.length >= 1 && a.refused.every(Boolean), JSON.stringify(a));
  // the latency experiment's load saw no errors, the error-rate experiment's load did: no cross-contamination
  assert.deepEqual(a.jobs, [false, true]);
});

test('chaos: an unknown write on an unqueryable target goes to manual review, is never re-sent, and a human resolves it', async () => {
  const acceptance = capture((ctx) => ({
    resolutions: ctx.data.probes['operatorResolutions'] as Array<{ outcome: string }>,
    writes: (ctx.data.probes['writes'] as Array<{ key: string }>).filter((w) => w.key === 'maintenance').length,
    restarts: ctx.data.harness.restarts,
  }));
  const task = chaosUnqueryableTargetTask();
  const trial = await trialOf({ ...task, graders: [...task.graders, 'acceptance'] }, { graders: { acceptance: acceptance.grader } });
  assertPassed(trial, 'pass');
  const a = acceptance.value();
  assert.deepEqual([a.restarts, a.writes, a.resolutions.map((r) => r.outcome)], [1, 1, ['succeeded']]);
});

test('chaos: a scripted operator needs the live instance — a child-process trial of the unqueryable case is refused up front', async () => {
  const trial = await trialOf(chaosUnqueryableTargetTask(), { mode: 'child-process' });
  assert.equal(trial.result, 'infra_error');
  assert.match(trial.error ?? '', /a scripted operator \(fixture\.operator\) acts on the live instance: run it in-process/);
});
