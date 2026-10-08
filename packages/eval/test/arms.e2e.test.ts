/**
 * (F[8], coverage[14], item 6) The eval arms end to end:
 *  - the three-provider-class arm: the SAME goal (PoC C) through the Anthropic, OpenAI-compatible and pi-ai adapters over
 *    the scripted wire transport, a scripted outage switching the metrics analyst's provider CLASS mid-run, every
 *    exchange audited on L0 — and no request leaving the process;
 *  - the causal arms H0…H6 at a fixed model: the features are recorded per trial, and an ablation is visible in the
 *    outcome (no blackboard ⇒ no RCA/regression reaction; no subagents ⇒ the lead alone cannot run the role plan);
 *  - the product arms: the same task on the Pi and DSH agent engines (another runtime manifest);
 *  - the external-agent arm (a fake command standing in for Claude Code / Codex / OpenHands): outcome-graded only,
 *    a fake-green report fails, an invalid report and a crash are faults of the arm.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import {
  CAUSAL_ARMS, THREE_CLASS_PROVIDERS, apiBlackboxTask, causalArm, externalAgentArm, performanceSloTask, pocBTask, pocCTask, productEngineArm, runTrial, scriptedMultiLlmArm, threeProviderClassArm,
  type EvalArm, type EvalTask, type EvalTrial,
} from '../src/index.ts';
import { assertSchemasDropped, capture, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('r');
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-external-agent.mjs', import.meta.url));
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-arms-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

let n = 0;
async function trialOf(task: EvalTask, arm: EvalArm, extra: Parameters<typeof trialOptions>[2] = {}): Promise<EvalTrial> {
  return runTrial(task, arm, trialOptions(PREFIX, join(root.path, `t${++n}`), extra));
}

test('three provider classes: the same goal over anthropic, openai-compatible and pi-ai, a class switch mid-run, every call audited', async () => {
  const acceptance = capture((ctx) => {
    const calls = ctx.data.probes['wireCalls'] as Array<{ provider: string; wireClass: string; role: string; status: number }>;
    return {
      classesByRole: Object.fromEntries([...new Set(calls.map((c) => c.role))].sort().map((r) => [r, [...new Set(calls.filter((c) => c.role === r && c.status === 200).map((c) => c.wireClass))].sort()])),
      outage: calls.filter((c) => c.status !== 200).map((c) => `${c.role}@${c.wireClass}:${c.status}`),
      fallbacks: ctx.data.events.filter((e) => e.eventType === 'model.fallback').map((e) => `${String(payloadOf(e)['from'])}→${String(payloadOf(e)['to'])}`),
    };
  });
  // PoC C without its harness chaos (the wire arm has no in-process brains to inject a timeout into); its scripted
  // provider outage (reason-a fails the metrics analyst's first call) stays
  const base = pocCTask({ chaos: {} });
  const task = { ...base, graders: [...base.graders.filter((g) => g !== 'pocCWorkflow' && g !== 'recoveryAudit'), 'providerClassesAudited', 'acceptance'] };
  const trial = await trialOf(task, threeProviderClassArm(), { graders: { acceptance: acceptance.grader } });
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders.filter((g) => !g.pass), null, 1));
  assert.deepEqual([trial.result, trial.verdict], ['pass', 'pass']);
  const a = acceptance.value();
  assert.deepEqual(THREE_CLASS_PROVIDERS, { 'reason-a': 'anthropic', 'fast-b': 'openai-compatible', 'judge-c': 'pi-ai' });
  assert.deepEqual(a.classesByRole['lead'], ['anthropic']);
  assert.deepEqual(a.classesByRole['environment'], ['openai-compatible']);
  assert.deepEqual(a.classesByRole['reviewer'], ['pi-ai']);
  // the metrics analyst started on anthropic (outage) and continued on openai-compatible: a cross-class switch
  assert.ok(a.outage.length >= 1 && a.outage.every((o) => o.startsWith('metrics_analyst@anthropic:')), a.outage.join(', '));
  assert.ok(a.fallbacks.includes('reason-a-large→fast-b-tools'), a.fallbacks.join(', '));
  assert.deepEqual(a.classesByRole['metrics_analyst'], ['openai-compatible']);
});

test('the three-provider-class arm needs the live instance: a child-process trial is refused up front', async () => {
  const trial = await trialOf(pocCTask({ chaos: {} }), threeProviderClassArm(), { mode: 'child-process' });
  assert.equal(trial.result, 'infra_error');
  assert.match(trial.error ?? '', /has no child spec \(EvalArm\.child\) for a child-process trial/);
});

test('causal arms: features recorded per trial; removing the blackboard removes the RCA/regression reaction (H2 fails, H6 passes)', async () => {
  assert.deepEqual(CAUSAL_ARMS.map((a) => a.armId), ['h0-single-agent', 'h1-subagents', 'h2-dynamic-scheduler', 'h3-blackboard', 'h4-context-freshness', 'h5-oracle-governance', 'h6-full']);
  assert.ok(CAUSAL_ARMS.every((a) => a.family === 'causal'));
  const roles = capture((ctx) => [...new Set(ctx.data.workItems.map((w) => w.role))].sort());
  const task = { ...apiBlackboxTask(), graders: [...apiBlackboxTask().graders, 'acceptance'] };
  const h2 = await trialOf(task, causalArm('h2-dynamic-scheduler'), { graders: { acceptance: roles.grader } });
  assert.deepEqual(h2.harnessFeatures, { subagents: true, dynamicScheduler: true, blackboard: false, contextFreshness: false, oracleGovernance: false });
  assert.deepEqual(roles.value(), ['executor', 'lead'], 'no reaction without the blackboard');
  assert.equal(h2.result, 'fail');
  assert.ok(failures(h2).some((f) => /^causalChain: .*no evidence-backed hypothesis/.test(f)), failures(h2).join('\n'));
  const full = capture((ctx) => [...new Set(ctx.data.workItems.map((w) => w.role))].sort());
  const h6 = await trialOf(task, causalArm('h6-full'), { graders: { acceptance: full.grader } });
  assert.deepEqual(h6.harnessFeatures, { subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: true, oracleGovernance: true });
  assert.deepEqual(failures(h6), []);
  assert.deepEqual(full.value(), ['executor', 'lead', 'rca', 'reviewer', 'test_designer']);
  assert.notEqual(h2.runtimeManifestId, h6.runtimeManifestId, 'an ablated harness is another runtime');
});

test('causal arm H0: the lead is the only agent (the role plan of the scripted brains cannot run) — never a pass', async () => {
  const roles = capture((ctx) => [...new Set(ctx.data.workItems.map((w) => w.role))].sort());
  const task = { ...apiBlackboxTask(), graders: [...apiBlackboxTask().graders, 'acceptance'] };
  const h0 = await trialOf(task, causalArm('h0-single-agent'), { graders: { acceptance: roles.grader } });
  assert.deepEqual(h0.harnessFeatures, { subagents: false, dynamicScheduler: false, blackboard: false, contextFreshness: false, oracleGovernance: false });
  assert.deepEqual(roles.value(), ['lead']);
  assert.notEqual(h0.verdict, 'pass');
  assert.equal(h0.result, 'fail');
});

test('product arms: the same task on the Pi and DSH agent engines (another runtime manifest, same outcome)', async () => {
  const native = await trialOf(performanceSloTask(), scriptedMultiLlmArm);
  assert.deepEqual(failures(native), []);
  for (const engine of ['pi', 'dsh'] as const) {
    const trial = await trialOf(performanceSloTask(), productEngineArm(engine));
    assert.deepEqual(failures(trial), [], `${engine}: ${failures(trial).join('\n')}`);
    assert.deepEqual([trial.result, trial.verdict, trial.armId], ['pass', 'pass', `engine-${engine}`]);
    assert.notEqual(trial.runtimeManifestId, native.runtimeManifestId);
  }
  assert.throws(() => productEngineArm('claude' as never), /unknown product engine/);
});

test('external agent arm: a command that really probes the SUT is graded on its outcome; fake green fails; bad reports are faults', async () => {
  const arm = (mode: string) => externalAgentArm(`fake-${mode}`, `fake external agent (${mode})`, { command: process.execPath, args: [FAKE_AGENT, mode, '{sutUrl}', '{report}'] });
  const probe = await trialOf(pocBTask({ chaos: {} }), arm('probe'));
  assert.equal(probe.armId, 'fake-probe');
  assert.deepEqual([probe.result, probe.verdict], ['pass', 'fail'], JSON.stringify(probe.graders));
  assert.equal(probe.outcomeMetrics['evidenceCompleteness'], 0, 'nothing an external agent claims is verified evidence');
  const green = await trialOf(pocBTask({ chaos: {} }), arm('green'));
  assert.equal(green.result, 'fail');
  assert.ok(green.graders.some((g) => !g.pass && /externalDefectDetected|externalVerdict/.test(g.graderId)), JSON.stringify(green.graders));
  const garbage = await trialOf(pocBTask({ chaos: {} }), arm('garbage'));
  assert.equal(garbage.result, 'infra_error');
  assert.match(garbage.error ?? '', /verdict must be one of/);
  const crash = await trialOf(pocBTask({ chaos: {} }), arm('crash'));
  assert.equal(crash.result, 'infra_error');
  assert.throws(() => externalAgentArm('x', 'x', { command: 'claude', args: ['-p', '{goal}'] }), /an argument must name \{report\}/);
});
