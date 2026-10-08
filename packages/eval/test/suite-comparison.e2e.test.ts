/**
 * The arm comparison on every PoC task (`pocAllSuite`): one paired trial per task of the scripted multi-LLM arm and the
 * scripted single-provider arm (in-process). The same role policies run in both arms; what differs is the model
 * routing. With one provider for every role the reviewer — whose policy demands a provider independent of the producers
 * — cannot be routed: no independent review exists, the QualityGate asks for human review, and every task that needs an
 * independent approval fails for that arm. The suite result compares the arms with exact McNemar over the discordant
 * pairs and renders the markdown report.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { POC_ARMS, mcnemarExact, pocAllSuite, renderSuiteReport, runSuite, type EvalSuite, type Grader } from '../src/index.ts';
import { assertSchemasDropped, baseConfig, schemaPrefix } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('s');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-suite-comparison-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('multi-LLM vs single provider on every PoC task: paired trials, McNemar computed, the single arm loses exactly where independent review is required', async () => {
  // a capture grader on every task: the gate's view of the review requirement per trial (always passes)
  const seen: Array<{ taskId: string; armId: string; verdict?: string; humanReview?: boolean; c6?: string }> = [];
  const reviewGate: Grader = (ctx) => {
    const d = ctx.data.decision;
    const c6 = d ? ([...d.satisfiedCriteria, ...d.violatedCriteria, ...d.unknownCriteria].find((c) => c.criterionId === 'C6')) : undefined;
    const row: (typeof seen)[number] = { taskId: ctx.task.taskId, armId: ctx.armId };
    if (d) Object.assign(row, { verdict: d.verdict, humanReview: d.requiresHumanReview });
    if (c6) row.c6 = d!.satisfiedCriteria.includes(c6) ? 'satisfied' : d!.violatedCriteria.includes(c6) ? 'violated' : 'unknown';
    seen.push(row);
    return { graderId: 'reviewGate', pass: true, score: 1, detail: 'captured' };
  };
  const base = pocAllSuite();
  const suite: EvalSuite = { ...base, tasks: base.tasks.map((t) => ({ ...t, graders: [...t.graders, 'reviewGate'] })) };
  const progress: string[] = [];
  const cfg = baseConfig(PREFIX);
  const result = await runSuite(suite, {
    arms: [...POC_ARMS], trials: 1, workDir: join(root.path, 'suite'), timeoutMs: 240_000, graders: { reviewGate },
    onTrial: (t) => progress.push(`${t.taskId}/${t.armId}:${t.result}`),
    ...(cfg ? { baseConfig: cfg } : {}),
  });
  const outcome = (armId: string) =>
    Object.fromEntries(result.trials.filter((t) => t.armId === armId).map((t) => [t.taskId, `${t.result}${t.verdict ? `/${t.verdict}` : ''}`]));
  const detail = JSON.stringify(result.trials.map((t) => ({ task: t.taskId, arm: t.armId, result: t.result, verdict: t.verdict, error: t.error, failed: t.graders.filter((g) => !g.pass).map((g) => `${g.graderId}: ${g.detail}`) })), null, 1);
  assert.equal(result.trials.length, 12, detail);
  assert.equal(progress.length, 12);
  assert.ok(result.trials.every((t) => t.result !== 'infra_error'), detail);
  // the multi-LLM arm passes every PoC task (the expected verdicts included)
  assert.deepEqual(outcome('scripted-multi-llm'), {
    'poc-a-whitebox': 'pass/fail', 'poc-b-event-driven': 'pass/fail', 'poc-c-durable-load': 'pass/pass', 'poc-c-insufficient': 'pass/inconclusive', 'oracle-robustness': 'pass/fail', 'recovery-chaos': 'pass/pass',
  }, detail);
  // the single arm reaches the same verdicts where no release is at stake, but fails every task that needs an independent
  // review: no approving independent review exists (A, B), and a healthy service cannot be released on its own — the
  // gate says conditional and asks for human review (C, recovery-chaos)
  assert.deepEqual(outcome('scripted-single'), {
    'poc-a-whitebox': 'fail/fail', 'poc-b-event-driven': 'fail/fail', 'poc-c-durable-load': 'fail/conditional', 'poc-c-insufficient': 'pass/inconclusive', 'oracle-robustness': 'pass/fail', 'recovery-chaos': 'fail/conditional',
  }, detail);
  for (const t of result.trials.filter((x) => x.armId === 'scripted-single' && x.result === 'fail')) {
    const failed = t.graders.filter((g) => !g.pass).map((g) => g.graderId);
    assert.ok(failed.includes('independentReview') || failed.includes('verdict'), `${t.taskId}: ${failed.join(', ')}`);
  }
  const gate = (taskId: string, armId: string) => seen.find((r) => r.taskId === taskId && r.armId === armId)!;
  for (const taskId of ['poc-c-durable-load', 'recovery-chaos']) {
    assert.deepEqual(gate(taskId, 'scripted-multi-llm'), { taskId, armId: 'scripted-multi-llm', verdict: 'pass', humanReview: false, c6: 'satisfied' });
    assert.deepEqual(gate(taskId, 'scripted-single'), { taskId, armId: 'scripted-single', verdict: 'conditional', humanReview: true, c6: 'violated' });
  }
  // per arm and the paired comparison: 6 pairs, 4 discordant in favour of the multi arm, none against: exact McNemar
  assert.equal(result.perArm['scripted-multi-llm']!.passRate, 1);
  assert.equal(result.perArm['scripted-single']!.passRate, 2 / 6);
  assert.equal(result.comparisons.length, 1);
  const c = result.comparisons[0]!;
  assert.deepEqual([c.armA, c.armB, c.pairs, c.b, c.c], ['scripted-multi-llm', 'scripted-single', 6, 4, 0]);
  assert.equal(c.mcnemarP, mcnemarExact(4, 0));
  assert.equal(c.mcnemarP, 0.125);
  assert.ok(c.passDiffCI !== undefined && Math.abs(c.passDiffCI.mean - 4 / 6) < 1e-9 && c.passDiffCI.lo <= c.passDiffCI.mean && c.passDiffCI.hi <= 1);
  const report = renderSuiteReport(result);
  assert.match(report, /^# Eval suite poc-all \(revision poc-2\)/);
  assert.match(report, /\| scripted-multi-llm \| scripted-single \| 6 \| 4 \| 0 \| 0\.1250 \|/);
});
