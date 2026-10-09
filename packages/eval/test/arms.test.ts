/**
 * The PoC arms (hermetic): the scripted multi-LLM arm steers ≥3 roles to distinct providers (reviewer independent of
 * the producers), the single arm has one route for all, brains arguments cannot be overridden by a fixture, the live
 * arm is opt-in and never stores a key; plus eval oracles are established by a human authority (never an agent).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultConfig } from '@hypertest/app';
import {
  EVAL_ORACLE_AUTHORITY, LEDGER_ORACLE, MULTI_ROUTES, POC_ARMS, POC_BRAINS_MODULE, SINGLE_ROUTES, brainArgsFor, builtinArms, establishOracles, liveArm, liveArmAvailable,
  scriptedMultiLlmArm, scriptedSingleArm, type EvalOracle,
} from '../src/index.ts';

const CTX = { workDir: '/tmp/trial', seed: 's', trial: 0 };

/** The route whose quality for `role` is highest (the router's quality stage; ties keep the first). */
function bestRoute(routes: typeof MULTI_ROUTES, role: string): string {
  let best = routes[0]!;
  for (const r of routes) if ((r.quality?.[role] ?? r.quality?.['default'] ?? 0) > (best.quality?.[role] ?? best.quality?.['default'] ?? 0)) best = r;
  return best.provider;
}

describe('scripted arms', () => {
  test('multi: three scripted providers; lead/analysts/metrics → reason-a, executor/test designer/RCA/environment → fast-b, reviewer → judge-c', () => {
    const cfg = scriptedMultiLlmArm.config(defaultConfig(), CTX);
    assert.deepEqual(cfg.models.providers, [{ id: 'reason-a', kind: 'scripted' }, { id: 'fast-b', kind: 'scripted' }, { id: 'judge-c', kind: 'scripted' }]);
    assert.deepEqual(cfg.models.routes.map((r) => [r.routeId, r.provider]), [['reason-a-large', 'reason-a'], ['fast-b-tools', 'fast-b'], ['judge-c-review', 'judge-c']]);
    const steering = Object.fromEntries(['lead', 'code_change_analyst', 'metrics_analyst', 'executor', 'test_designer', 'rca', 'environment', 'reviewer'].map((role) => [role, bestRoute(MULTI_ROUTES, role)]));
    assert.deepEqual(steering, {
      lead: 'reason-a', code_change_analyst: 'reason-a', metrics_analyst: 'reason-a', executor: 'fast-b', test_designer: 'fast-b', rca: 'fast-b', environment: 'fast-b', reviewer: 'judge-c',
    });
    // every route may carry every action risk and capability the PoC tools need (no silent routing failure)
    for (const r of cfg.models.routes) assert.deepEqual([r.maxActionRisk, r.capabilities?.includes('tool_use'), r.contextWindow], ['critical', true, 200_000], r.routeId);
    // the config holds copies: mutating a trial's config never changes the arm
    cfg.models.routes[0]!.quality!['default'] = 0;
    assert.equal(MULTI_ROUTES[0]!.quality!['default'], 0.9);
  });

  test('single: one provider and one route for every role (independent review impossible)', () => {
    const cfg = scriptedSingleArm.config(defaultConfig(), CTX);
    assert.deepEqual(cfg.models.providers, [{ id: 'solo', kind: 'scripted' }]);
    assert.deepEqual(cfg.models.routes.map((r) => r.provider), ['solo']);
    assert.equal(SINGLE_ROUTES.length, 1);
    assert.deepEqual(POC_ARMS.map((a) => a.armId), ['scripted-multi-llm', 'scripted-single']);
  });

  test('both arms run in-process and in trial children with the same brains arguments; a fixture cannot override task or arm', () => {
    const task = { taskId: 'poc-a-whitebox' };
    const fixture = { brainArgs: { observationsFile: '/tmp/o.jsonl', taskId: 'forged', arm: 'single' } };
    assert.deepEqual(brainArgsFor(task, fixture, 'multi'), { observationsFile: '/tmp/o.jsonl', taskId: 'poc-a-whitebox', arm: 'multi' });
    assert.deepEqual(brainArgsFor(task, { brainArgs: [1, 2] }, 'single'), { taskId: 'poc-a-whitebox', arm: 'single' });
    assert.deepEqual(brainArgsFor(task, {}, 'single'), { taskId: 'poc-a-whitebox', arm: 'single' });
    for (const arm of POC_ARMS) {
      assert.deepEqual([arm.child?.brainsModule, arm.child?.brainsExport], [POC_BRAINS_MODULE, 'pocChildBrains'], arm.armId);
      const full = { ...task, suiteRevision: 'r', title: 't', goal: 'g', hiddenFaults: [], expectedVerdict: 'fail' as const, graders: [], setup: async () => ({ target: {}, cleanup: async () => undefined }) };
      assert.deepEqual(arm.child!.args!(full, { target: {}, cleanup: async () => undefined, brainArgs: { variant: 'x' } }), { variant: 'x', taskId: 'poc-a-whitebox', arm: arm === scriptedMultiLlmArm ? 'multi' : 'single' });
      assert.deepEqual(Object.keys(arm.brains!(full, { target: {}, cleanup: async () => undefined })), arm === scriptedMultiLlmArm ? ['reason-a', 'fast-b', 'judge-c'] : ['solo']);
    }
  });
});

describe('live arm', () => {
  const ENV = { HYPERTEST_EVAL_LIVE: '1', HYPERTEST_EVAL_LIVE_KIND: 'anthropic', HYPERTEST_EVAL_LIVE_MODEL: 'claude-x', HYPERTEST_EVAL_LIVE_API_KEY: 'sk-test' };

  test('opt-in only, and every missing setting is named', () => {
    assert.deepEqual(liveArmAvailable({}), { ok: false, reason: 'HYPERTEST_EVAL_LIVE is not 1 (live model calls are opt-in)' });
    assert.deepEqual(liveArmAvailable({ ...ENV, HYPERTEST_EVAL_LIVE_KIND: 'other' }), { ok: false, reason: 'HYPERTEST_EVAL_LIVE_KIND must be anthropic or openai-compatible' });
    assert.deepEqual(liveArmAvailable({ ...ENV, HYPERTEST_EVAL_LIVE_MODEL: '' }), { ok: false, reason: 'HYPERTEST_EVAL_LIVE_MODEL is not set' });
    assert.deepEqual(liveArmAvailable({ ...ENV, HYPERTEST_EVAL_LIVE_API_KEY: undefined }), { ok: false, reason: 'HYPERTEST_EVAL_LIVE_API_KEY is not set' });
    assert.deepEqual(liveArmAvailable({ ...ENV, HYPERTEST_EVAL_LIVE_KIND: 'openai-compatible' }), { ok: false, reason: 'HYPERTEST_EVAL_LIVE_BASE_URL is required for openai-compatible' });
    assert.deepEqual(liveArmAvailable(ENV), { ok: true });
    // (F[8], item 6) the causal arms H0…H6, the product engine arms and the three-provider-class arm are always offered
    // (scripted, no network); only the live arm is opt-in
    const always = ['scripted-multi-llm', 'scripted-single', 'h0-single-agent', 'h1-subagents', 'h2-dynamic-scheduler', 'h3-blackboard', 'h4-context-freshness', 'h5-oracle-governance', 'h6-full', 'engine-pi', 'engine-dsh', 'three-provider-classes'];
    assert.deepEqual(builtinArms({}).map((a) => a.armId), always);
    assert.deepEqual(builtinArms(ENV).map((a) => a.armId), [...always, 'live']);
  });

  test('the key is read through apiKeyEnv at composition, never stored in the config; no scripted brains', () => {
    const arm = liveArm({ ...ENV, HYPERTEST_EVAL_LIVE_KIND: 'openai-compatible', HYPERTEST_EVAL_LIVE_BASE_URL: 'https://llm.invalid/v1' });
    const cfg = arm.config(defaultConfig(), CTX);
    assert.deepEqual(cfg.models.providers, [{ id: 'live', kind: 'openai-compatible', apiKeyEnv: 'HYPERTEST_EVAL_LIVE_API_KEY', baseUrl: 'https://llm.invalid/v1', timeoutMs: 120_000 }]);
    assert.deepEqual(cfg.models.routes.map((r) => [r.provider, r.model]), [['live', 'claude-x']]);
    assert.equal(JSON.stringify(cfg).includes('sk-test'), false);
    assert.equal(arm.brains, undefined);
    assert.equal(liveArm(ENV).config(defaultConfig(), CTX).models.providers[0]!.kind, 'anthropic');
  });
});

describe('eval oracles', () => {
  function fakeServices(existing: string[]) {
    const established: Array<{ oracleId: string; authority: unknown; ctx: unknown }> = [];
    const services = {
      specs: { getOracle: async (id: string) => (existing.includes(id) ? { oracleId: id } : undefined) },
      oracles: { establish: async (spec: EvalOracle, authority: unknown, ctx: unknown) => void established.push({ oracleId: spec.oracleId, authority, ctx }) },
    };
    return { ht: { services } as never, established };
  }

  test('established by the human eval authority before the run; an existing oracle (resumed trial) is kept as it is', async () => {
    const other = { ...LEDGER_ORACLE, oracleId: 'other' };
    const { ht, established } = fakeServices(['other']);
    assert.deepEqual(await establishOracles(ht, [LEDGER_ORACLE, other], 'run_1'), ['ledger-contract', 'other']);
    assert.deepEqual(established, [{ oracleId: 'ledger-contract', authority: { kind: 'human', id: 'eval:oracle-authority' }, ctx: { runId: 'setup-run_1', correlationId: 'setup-run_1', actorId: 'human:eval:oracle-authority' } }]);
    assert.equal(EVAL_ORACLE_AUTHORITY.kind, 'human');
    assert.ok(Object.isFrozen(EVAL_ORACLE_AUTHORITY));
    assert.deepEqual(await establishOracles(fakeServices([]).ht, undefined, 'run_2'), []);
  });
});
