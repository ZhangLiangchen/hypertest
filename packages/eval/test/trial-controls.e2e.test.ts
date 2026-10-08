/**
 * (row 310/319, coverage[16], F[14]) What a trial enforces and records, end to end (scripted multi-LLM arm, in-process):
 *  - allowedTools / safetyConstraints become deny rules of the trial's own policy: the run cannot use a tool the task
 *    does not allow (L0 tool.denied names the rule), and the trial records the constraints and its environment digest;
 *  - tracks: the cold track (default) refuses a memory shared across trials; the learning track seeds ONLY approved
 *    experience into the trial's memory;
 *  - cancellation: an aborted suite marks the running trial cancelled, never counted, and keeps the partial result.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { apiBlackboxTask, contextFreshnessTask, runSuite, runTrial, scriptedMultiLlmArm, type EvalArm, type EvalTask, type EvalTrial, type SuiteResult } from '../src/index.ts';
import { assertSchemasDropped, baseConfig, capture, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('t');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-trial-controls-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

let n = 0;
async function trialOf(task: EvalTask, extra: Parameters<typeof trialOptions>[2] = {}, arm: EvalArm = scriptedMultiLlmArm): Promise<EvalTrial> {
  return runTrial(task, arm, trialOptions(PREFIX, join(root.path, `t${++n}`), extra));
}

test('allowedTools: a tool the task does not allow is denied by the trial policy (never executed) and the trial records it', async () => {
  const denied = capture((ctx) => ctx.data.events.filter((e) => e.eventType === 'tool.denied').map((e) => `${String(payloadOf(e)['toolId'])}: ${String(payloadOf(e)['reason']).slice(0, 160)}`));
  const allowed = ['fs.*', 'test.run', 'shell.exec', 'evidence.*'];
  const task = { ...apiBlackboxTask({ allowedTools: allowed, fixtureFiles: ['fixtures/bank-api'] }), graders: ['verdict', 'acceptance'] };
  const trial = await trialOf(task, { graders: { acceptance: denied.grader } });
  assert.deepEqual(trial.allowedTools, allowed);
  assert.match(trial.environmentImageDigest ?? '', /^files:[0-9a-f]{64}$/);
  assert.ok(denied.value().some((d) => /^http\.request: .*eval\.allowed-tools/.test(d)), denied.value().join('\n'));
  assert.notEqual(trial.verdict, 'fail', 'the defect cannot be found without the API: no evidence, never a fail on a guess');
  assert.notEqual(trial.verdict, 'pass');
});

test('safetyConstraints no_writes: every write to the system under test is denied; recorded on the trial', async () => {
  const denied = capture((ctx) => ({
    denied: ctx.data.events.filter((e) => e.eventType === 'tool.denied').map((e) => `${String(payloadOf(e)['toolId'])}: ${String(payloadOf(e)['reason']).slice(0, 200)}`),
    writes: ctx.data.operations.filter((o) => o.operationType === 'http.request').length,
  }));
  const task = { ...apiBlackboxTask({ safetyConstraints: [{ kind: 'no_writes' }] }), graders: ['verdict', 'acceptance'] };
  const trial = await trialOf(task, { graders: { acceptance: denied.grader } });
  assert.deepEqual(trial.safetyConstraints, [{ kind: 'no_writes' }]);
  const a = denied.value();
  assert.equal(a.writes, 0, 'no write reached the bank');
  assert.ok(a.denied.some((d) => /^http\.request: .*eval\.safety\.1/.test(d)), a.denied.join('\n'));
  assert.notEqual(trial.verdict, 'pass');
});

test('malformed task constraints are refused before any environment exists', async () => {
  const trial = await trialOf({ ...contextFreshnessTask(), allowedTools: ['Not A Tool!'] });
  assert.equal(trial.result, 'infra_error');
  assert.match(trial.error ?? '', /allowedTools must be tool ids or prefix\.\* patterns/);
});

test('cold track (default): a memory shared across trials is refused — benchmark contamination', async () => {
  const shared: EvalArm = { ...scriptedMultiLlmArm, armId: 'shared-memory', config: (base, ctx) => ({ ...scriptedMultiLlmArm.config(base, ctx), memory: { kind: 'powercontext', baseUrl: 'http://127.0.0.1:9/' } as never }) };
  const trial = await trialOf(contextFreshnessTask(), {}, shared);
  assert.equal(trial.result, 'infra_error');
  assert.equal(trial.track, 'cold');
  assert.match(trial.error ?? '', /cold track: memory\.kind powercontext .* benchmark contamination/);
});

test('learning track: only approved experience is seeded into the trial memory', async () => {
  const seen = capture(async (ctx) => (await ctx.ht.services.memory.list({})).map((x) => `${x.status}:${x.content}`).sort());
  const task = { ...contextFreshnessTask(), graders: [...contextFreshnessTask().graders, 'acceptance'] };
  const trial = await trialOf(task, {
    graders: { acceptance: seen.grader },
    track: 'learning',
    experience: [
      { kind: 'lesson', status: 'approved', content: 'restart before publishing the marker' },
      { kind: 'pitfall', status: 'published', content: 'a stale snapshot is refused' },
      { kind: 'lesson', status: 'proposed', content: 'unreviewed guess' },
    ],
  });
  assert.equal(trial.track, 'learning');
  const memory = seen.value();
  assert.ok(memory.includes('approved:restart before publishing the marker'), memory.join('\n'));
  assert.ok(memory.includes('published:a stale snapshot is refused'), memory.join('\n'));
  assert.ok(!memory.some((m) => m.includes('unreviewed guess')), 'unapproved experience never enters a trial');
});

test('cancellation: an aborted suite keeps its partial result, the running trial is marked cancelled (never counted)', async () => {
  const ctrl = new AbortController();
  const cfg = baseConfig(PREFIX);
  const suite = { suiteId: 'cancel-me', revision: '1', tasks: [contextFreshnessTask(), contextFreshnessTask({ taskId: 'context-freshness-2' })] };
  let partial: SuiteResult | undefined;
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await runSuite(suite, { arms: [scriptedMultiLlmArm], trials: 1, workDir: join(root.path, 'cancel'), signal: ctrl.signal, ...(cfg ? { baseConfig: cfg } : {}) });
    assert.fail('a cancelled suite must not resolve as complete');
  } catch (e) {
    assert.ok(isHypertestError(e, 'cancelled'), String(e));
    partial = (e as { details?: { result?: SuiteResult } }).details?.result;
  } finally {
    clearTimeout(timer);
  }
  assert.ok(partial, 'the partial result travels with the cancellation');
  assert.equal(partial.cancelled, true);
  assert.ok(partial.trials.length >= 1);
  const t = partial.trials[0]!;
  assert.equal(t.cancelled, true);
  assert.notEqual(t.result, 'pass');
  assert.equal(partial.perArm['scripted-multi-llm']?.passRate ?? 0, 0, 'a cancelled trial is never counted as a pass');
});
