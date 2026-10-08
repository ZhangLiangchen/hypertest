/**
 * test-generation (core suite) — the three tasks on the scripted multi-LLM arm, oracle ledger-pagination A1 (an exact
 * test name no existing test has): a generated test counts only when it kills seeded mutants.
 *   - test-generation: a correct candidate, the sensitive A1 test kills arithmetic mutants ⇒ validated ⇒ eligible ⇒ pass;
 *   - test-generation-insensitive: the same candidate, a test named after A1 that checks nothing a pagination defect
 *     changes ⇒ no mutant killed ⇒ stays a draft ⇒ its evidence is ignored ⇒ inconclusive;
 *   - test-generation-defect: the regression candidate and the insensitive test, which PASSES on it — counted, it would
 *     release the defect; it is not eligible ⇒ inconclusive (never pass: no critical false release).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { runSuite, scriptedMultiLlmArm, testGenerationSuite } from '../src/index.ts';
import { assertSchemasDropped, baseConfig, capture, failures, schemaPrefix } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('g');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-test-generation-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('test-generation: only generated tests that kill seeded mutants are eligible; an insensitive test never counts', async () => {
  const seen = new Map<string, { states: string[]; killed: number[]; reasons: string[] }>();
  const acceptance = capture(async (ctx) => {
    const artifacts = await ctx.ht.services.specs.listTestArtifacts(ctx.data.runId!);
    const latest = [...new Map(artifacts.sort((x, y) => x.revision - y.revision).map((a) => [a.artifactId, a])).values()];
    const killed = ctx.data.evidence.filter((e) => e.evidenceType === 'mutation-result').map((e) => (e.structured as { killed: number }).killed);
    seen.set(ctx.task.taskId, { states: latest.map((a) => a.approvalState), killed, reasons: ctx.data.decision?.reasons ?? [] });
    return true;
  });
  const suite = testGenerationSuite();
  const base = baseConfig(PREFIX);
  const result = await runSuite(
    { ...suite, tasks: suite.tasks.map((t) => ({ ...t, graders: [...t.graders, 'acceptance'] })) },
    { arms: [scriptedMultiLlmArm], trials: 1, workDir: join(root.path, 'suite'), timeoutMs: 240_000, graders: { acceptance: acceptance.grader }, ...(base ? { baseConfig: base } : {}) },
  );
  const by = new Map(result.trials.map((t) => [t.taskId, t]));
  for (const t of result.trials) assert.deepEqual([failures(t), t.result], [[], 'pass'], `${t.taskId}: ${JSON.stringify(t.graders, null, 1)}`);
  assert.deepEqual(['test-generation', 'test-generation-insensitive', 'test-generation-defect'].map((id) => by.get(id)?.verdict), ['pass', 'inconclusive', 'inconclusive']);

  const sensitive = seen.get('test-generation')!;
  // D-1: validated (static, known-good, bound mutation kills) and then approved by the independent oracle consistency review
  assert.deepEqual(sensitive.states, ['approved']);
  assert.ok(sensitive.killed[0]! >= 1, 'the sensitive test killed seeded mutants');
  assert.ok(by.get('test-generation')!.outcomeMetrics['mutationScore']! > 0);
  for (const id of ['test-generation-insensitive', 'test-generation-defect']) {
    const s = seen.get(id)!;
    assert.deepEqual([s.states, s.killed], [['draft'], [0]], id);
    assert.ok(s.reasons.some((r) => r.startsWith('ignored evidence from ineligible generated tests')), s.reasons.join('\n'));
    assert.equal(by.get(id)!.outcomeMetrics['mutationScore'], 0);
  }
  // the insensitive test passed on the defective candidate; counted, that would have been a critical false release
  const defect = by.get('test-generation-defect')!;
  assert.deepEqual([defect.outcomeMetrics['criticalFalseRelease'], defect.outcomeMetrics['defectRecall']], [0, 0]);
});
