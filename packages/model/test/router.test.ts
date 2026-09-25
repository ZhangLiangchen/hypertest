import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import { InMemoryEventSink, type DomainEventInput, type DomainEventSink, type DomainEvent } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ModelCapabilityProfile, type ModelCatalogLike, type RouteDecision, type RouteRequest } from '../src/index.ts';
import { profile, routeRequest } from './helpers.ts';

function setup(profiles: ModelCapabilityProfile[], options: { providers?: string[]; events?: DomainEventSink; catalog?: ModelCatalogLike } = {}) {
  const ids = options.providers ?? [...new Set(profiles.map((p) => p.provider))];
  const registry = new ProviderRegistry(ids.map((id) => new ScriptedProvider({ providerId: id, brain: () => ({ text: 'ok' }) })));
  const catalog = options.catalog ?? new ModelCatalog(profiles);
  const events = options.events ?? new InMemoryEventSink();
  const router = createModelRouter({ ...testDeps(), catalog, providers: registry, events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  return { router, catalog, registry, events: events as InMemoryEventSink };
}

const ctx = eventCtx('run_1', { correlationId: 'corr_1', causationId: 'evt_cause', agentId: 'agt_1', workItemId: 'wi_1' });

function ok(d: RouteDecision): Extract<RouteDecision, { ok: true }> {
  assert.equal(d.ok, true, `expected a route, got ${JSON.stringify(d)}`);
  return d as Extract<RouteDecision, { ok: true }>;
}
function stageOf(d: RouteDecision, routeId: string): string | undefined {
  return d.rejected.find((r) => r.routeId === routeId)?.stage;
}

test('security: disabled routes, allowed/prohibited providers are rejected at the security stage', async () => {
  const { router } = setup([
    profile({ routeId: 'off', enabled: false, quality: { default: 0.99 } }),
    profile({ routeId: 'p_x', provider: 'x', quality: { default: 0.95 } }),
    profile({ routeId: 'p_y', provider: 'y', quality: { default: 0.9 } }),
    profile({ routeId: 'p_z', provider: 'z', quality: { default: 0.5 } }),
  ]);
  const d = ok(await router.route(routeRequest({}, { allowedProviders: ['scripted', 'y', 'z'], prohibitedProviders: ['y'] }), ctx));
  assert.equal(d.routeId, 'p_z');
  assert.deepEqual(d.rejected, [
    { routeId: 'off', stage: 'security', reason: 'route disabled' },
    { routeId: 'p_x', stage: 'security', reason: 'provider x not in allowedProviders' },
    { routeId: 'p_y', stage: 'security', reason: 'provider y is prohibited' },
  ]);
});

test('privacy: restricted data is never routed to a cloud route, even if preferred, better and cheaper', async () => {
  const { router } = setup([
    profile({ routeId: 'cloud', provider: 'cloud', maxDataClassification: 'confidential', quality: { default: 0.99 }, costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 }),
    profile({ routeId: 'local', provider: 'local', maxDataClassification: 'restricted', quality: { default: 0.4 }, costPerMillionInputUsd: 50, costPerMillionOutputUsd: 50 }),
  ]);
  const d = ok(await router.route(routeRequest({ dataClassification: 'restricted' }, { preferredRoutes: ['cloud'] }), ctx));
  assert.equal(d.routeId, 'local');
  assert.equal(stageOf(d, 'cloud'), 'security');
  assert.deepEqual(d.fallbackChain, []);
  // policy.privacyClass is applied when stricter than the request's classification
  const d2 = ok(await router.route(routeRequest({ dataClassification: 'public' }, { privacyClass: 'restricted' }), ctx));
  assert.equal(d2.routeId, 'local');
  // a looser policy never relaxes the request classification
  const d3 = ok(await router.route(routeRequest({ dataClassification: 'restricted' }, { privacyClass: 'public' }), ctx));
  assert.equal(d3.routeId, 'local');
});

test('privacy: with the only restricted-capable route disabled there is NO route (never a cloud fallback)', async () => {
  const { router, events } = setup([
    profile({ routeId: 'cloud', provider: 'cloud', maxDataClassification: 'confidential' }),
    profile({ routeId: 'local', provider: 'local', maxDataClassification: 'restricted', enabled: false }),
  ]);
  const d = await router.route(routeRequest({ dataClassification: 'restricted' }), ctx);
  assert.equal(d.ok, false);
  assert.deepEqual(d.rejected.map((r) => [r.routeId, r.stage]), [['cloud', 'security'], ['local', 'security']]);
  const ev = events.ofType('model.routed');
  assert.equal(ev.length, 1);
  const payload = ev[0]!.payload as Record<string, unknown>;
  assert.equal(payload['ok'], false);
  assert.equal(payload['routeId'], null);
  assert.equal(payload['reason'], 'no_eligible_route');
});

test('security: action risk above the route maximum is rejected', async () => {
  const { router } = setup([profile({ routeId: 'weak', maxActionRisk: 'medium', quality: { default: 0.99 } }), profile({ routeId: 'strong', maxActionRisk: 'critical' })]);
  const d = ok(await router.route(routeRequest({ actionRisk: 'high' }), ctx));
  assert.equal(d.routeId, 'strong');
  assert.deepEqual(d.rejected, [{ routeId: 'weak', stage: 'security', reason: 'route may drive actions up to medium; request needs high' }]);
});

test('independence: providersToAvoid removes the executor provider for the reviewer even when preferred and best', async () => {
  const { router } = setup([
    profile({ routeId: 'gpt', provider: 'openai', quality: { default: 0.95 } }),
    profile({ routeId: 'claude', provider: 'anthropic', quality: { default: 0.8 } }),
  ]);
  const d = ok(await router.route(routeRequest({ role: 'reviewer', providersToAvoid: ['openai'] }, { preferredRoutes: ['gpt'], independentFromRoles: ['executor'] }), ctx));
  assert.equal(d.routeId, 'claude');
  assert.deepEqual(d.rejected, [{ routeId: 'gpt', stage: 'security', reason: 'provider openai must be avoided (independence)' }]);
});

test('stage order: a route is reported at its FIRST failing stage (security → capability → role → quality → latency → cost)', async () => {
  const { router } = setup([
    // fails everything → security
    profile({ routeId: 'r_sec', maxDataClassification: 'public', capabilities: [], quality: { default: 0.1 }, typicalLatencyMs: 99_999, costPerMillionInputUsd: 999 }),
    // fails capability, quality, latency, cost → capability
    profile({ routeId: 'r_cap', capabilities: [], quality: { default: 0.1 }, typicalLatencyMs: 99_999, costPerMillionInputUsd: 999 }),
    // explicit zero for role + latency → role
    profile({ routeId: 'r_role', quality: { analyst: 0, default: 0.9 }, typicalLatencyMs: 99_999 }),
    // fails quality, latency, cost → quality
    profile({ routeId: 'r_q', quality: { default: 0.1 }, typicalLatencyMs: 99_999, costPerMillionInputUsd: 999 }),
    // fails latency, cost → latency
    profile({ routeId: 'r_lat', typicalLatencyMs: 99_999, costPerMillionInputUsd: 999 }),
    // fails cost only → cost
    profile({ routeId: 'r_cost', costPerMillionInputUsd: 999 }),
    profile({ routeId: 'r_ok' }),
  ]);
  const d = ok(await router.route(routeRequest({ requiredCapabilities: ['tool_use'] }, { minQuality: 0.5, latencyBudgetMs: 5000, maxCostPerCallUsd: 0.1 }), ctx));
  assert.equal(d.routeId, 'r_ok');
  assert.deepEqual(d.rejected.map((r) => [r.routeId, r.stage]), [
    ['r_sec', 'security'],
    ['r_cap', 'capability'],
    ['r_role', 'role'],
    ['r_q', 'quality'],
    ['r_lat', 'latency'],
    ['r_cost', 'cost'],
  ]);
});

test('capability: request ∪ policy capabilities, structured output, context window fit, registered adapter', async () => {
  const est = 10_000;
  const { router } = setup(
    [
      profile({ routeId: 'no_vision', capabilities: ['tool_use'] }),
      profile({ routeId: 'no_tools', capabilities: ['vision'] }),
      profile({ routeId: 'no_struct', capabilities: ['tool_use', 'vision'], structuredOutput: 'none' }),
      profile({ routeId: 'tight', capabilities: ['tool_use', 'vision'], contextWindow: est + 4096 - 1, maxOutputTokens: 8192 }),
      profile({ routeId: 'exact', capabilities: ['tool_use', 'vision'], contextWindow: est + 4096, maxOutputTokens: 8192, quality: { default: 0.5 } }),
      profile({ routeId: 'small_out', capabilities: ['tool_use', 'vision'], contextWindow: est + 1000, maxOutputTokens: 1000, quality: { default: 0.4 } }),
      profile({ routeId: 'orphan', provider: 'unregistered', capabilities: ['tool_use', 'vision'], quality: { default: 0.99 } }),
    ],
    { providers: ['scripted'] },
  );
  const d = ok(await router.route(routeRequest({ requiredCapabilities: ['tool_use'], structuredOutput: true, contextTokensEstimate: est }, { requiredCapabilities: ['vision'] }), ctx));
  assert.equal(d.routeId, 'exact');
  assert.deepEqual(d.fallbackChain, ['small_out']);
  assert.deepEqual(d.rejected, [
    { routeId: 'no_vision', stage: 'capability', reason: 'missing capabilities: vision' },
    { routeId: 'no_tools', stage: 'capability', reason: 'missing capabilities: tool_use' },
    { routeId: 'no_struct', stage: 'capability', reason: 'structured output not supported' },
    { routeId: 'tight', stage: 'capability', reason: `context window ${est + 4095} < ${est + 4096} (context + output reserve)` },
    { routeId: 'orphan', stage: 'capability', reason: 'no adapter registered for provider unregistered' },
  ]);
});

test('quality: score = quality[role] ?? quality[taskType] ?? quality.default ?? 0; minQuality boundary is inclusive', async () => {
  const { router } = setup([
    profile({ routeId: 'by_role', quality: { executor: 0.6, execute_tests: 0.99, default: 0.99 } }),
    profile({ routeId: 'by_task', quality: { execute_tests: 0.7, default: 0.1 } }),
    profile({ routeId: 'by_default', quality: { default: 0.65 } }),
    profile({ routeId: 'none', quality: {} }),
  ]);
  const d = ok(await router.route(routeRequest({ role: 'executor', taskType: 'execute_tests' }, { minQuality: 0.6 }), ctx));
  assert.equal(d.routeId, 'by_task');
  assert.deepEqual(d.fallbackChain, ['by_default', 'by_role']);
  assert.deepEqual(d.rejected, [{ routeId: 'none', stage: 'quality', reason: 'quality 0 < minQuality 0.6' }]);
  // Object prototype keys are never mistaken for scores.
  const d2 = ok(await router.route(routeRequest({ role: 'constructor', taskType: 'toString' }), ctx));
  assert.equal(d2.rejected.length, 0);
});

test('latency and cost budgets reject over-budget routes (boundaries inclusive)', async () => {
  const est = 1000;
  const cheapCost = (est * 1 + 8192 * 4) / 1e6;
  const { router } = setup([
    profile({ routeId: 'slow', typicalLatencyMs: 3001, quality: { default: 0.99 } }),
    profile({ routeId: 'pricey', typicalLatencyMs: 3000, costPerMillionOutputUsd: 40, quality: { default: 0.95 } }),
    profile({ routeId: 'fits', typicalLatencyMs: 3000 }),
  ]);
  const d = ok(await router.route(routeRequest({ contextTokensEstimate: est }, { latencyBudgetMs: 3000, maxCostPerCallUsd: cheapCost }), ctx));
  assert.equal(d.routeId, 'fits');
  assert.deepEqual(d.rejected.map((r) => [r.routeId, r.stage]), [['slow', 'latency'], ['pricey', 'cost']]);
  assert.equal(router.estimateCostUsd('fits', est, 8192), cheapCost);
  assert.throws(() => router.estimateCostUsd('nope', 1, 1), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
});

test('ranking: preferred routes first (listed order), then quality, then latency, cost, routeId; selectedByPolicy names the decider', async () => {
  const base = [
    profile({ routeId: 'hq', quality: { default: 0.9 }, costPerMillionInputUsd: 10 }),
    profile({ routeId: 'mq', quality: { default: 0.8 }, costPerMillionInputUsd: 0.1 }),
    profile({ routeId: 'lq', quality: { default: 0.6 }, costPerMillionInputUsd: 0 }),
  ];
  const { router } = setup(base);
  let d = ok(await router.route(routeRequest({}, { preferredRoutes: ['lq', 'mq'] }), ctx));
  assert.deepEqual([d.routeId, ...d.fallbackChain], ['lq', 'mq', 'hq']);
  assert.equal(d.selectedByPolicy, 'preferred_route');
  d = ok(await router.route(routeRequest(), ctx));
  assert.deepEqual([d.routeId, ...d.fallbackChain], ['hq', 'mq', 'lq']);
  assert.equal(d.selectedByPolicy, 'quality');

  const tie = setup([
    profile({ routeId: 't_c', typicalLatencyMs: 500, costPerMillionInputUsd: 1 }),
    profile({ routeId: 't_b', typicalLatencyMs: 500, costPerMillionInputUsd: 2 }),
    profile({ routeId: 't_a', typicalLatencyMs: 900, costPerMillionInputUsd: 0 }),
  ]).router;
  d = ok(await tie.route(routeRequest(), ctx));
  assert.deepEqual([d.routeId, ...d.fallbackChain], ['t_c', 't_b', 't_a']);
  assert.equal(d.selectedByPolicy, 'cost');

  const ids = setup([profile({ routeId: 'z' }), profile({ routeId: 'a' })]).router;
  d = ok(await ids.route(routeRequest(), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy], ['a', 'route_id']);

  const lat = setup([profile({ routeId: 'slow', typicalLatencyMs: 900, costPerMillionInputUsd: 0 }), profile({ routeId: 'fast', typicalLatencyMs: 100 })]).router;
  d = ok(await lat.route(routeRequest(), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy], ['fast', 'latency']);

  const one = setup([profile({ routeId: 'solo' })]).router;
  d = ok(await one.route(routeRequest(), ctx));
  assert.equal(d.selectedByPolicy, 'only_eligible_route');
});

test('ranking: executor-like roles weigh tool reliability after quality (before latency/cost); others do not', async () => {
  const ps = [
    profile({ routeId: 'flaky_fast', toolReliability: 0.5, typicalLatencyMs: 100, costPerMillionInputUsd: 0 }),
    profile({ routeId: 'steady', toolReliability: 0.95, typicalLatencyMs: 900, costPerMillionInputUsd: 5 }),
  ];
  const { router } = setup(ps);
  let d = ok(await router.route(routeRequest({ role: 'executor', taskType: 'run' }), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy], ['steady', 'tool_reliability']);
  d = ok(await router.route(routeRequest({ role: 'test_designer', taskType: 'execute_regression' }), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy], ['steady', 'tool_reliability']);
  d = ok(await router.route(routeRequest({ role: 'analyst', taskType: 'analyze' }), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy], ['flaky_fast', 'latency']);
});

test('a cheaper route never wins over a higher-quality eligible route; cost only breaks exact ties', async () => {
  const { router } = setup([
    profile({ routeId: 'free', quality: { default: 0.69 }, costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0, typicalLatencyMs: 10 }),
    profile({ routeId: 'best', quality: { default: 0.7 }, costPerMillionInputUsd: 30, costPerMillionOutputUsd: 60, typicalLatencyMs: 5000 }),
  ]);
  const d = ok(await router.route(routeRequest(), ctx));
  assert.deepEqual([d.routeId, d.selectedByPolicy, d.fallbackChain], ['best', 'quality', ['free']]);
});

test('decision carries catalog revision, continuation class and reasoning effort (policy overrides route)', async () => {
  const { router, catalog } = setup([profile({ routeId: 'r', reasoningEffort: 'low', continuationCompatibilityClass: 'anthropic:m' })]);
  let d = ok(await router.route(routeRequest(), ctx));
  assert.equal(d.capabilityProfileRevision, catalog.revision);
  assert.equal(d.continuationCompatibilityClass, 'anthropic:m');
  assert.equal(d.reasoningEffort, 'low');
  d = ok(await router.route(routeRequest({}, { reasoningEffort: 'high' }), ctx));
  assert.equal(d.reasoningEffort, 'high');
});

test('model.routed is emitted with correlation context (I10) and the full decision audit', async () => {
  const { router, events, catalog } = setup([profile({ routeId: 'a', quality: { default: 0.9 } }), profile({ routeId: 'b' }), profile({ routeId: 'c', enabled: false })]);
  await router.route(routeRequest({ contextSnapshotId: 'ctx_42' }), ctx);
  const [ev] = events.ofType('model.routed');
  assert.ok(ev);
  assert.equal(ev.runId, 'run_1');
  assert.equal(ev.correlationId, 'corr_1');
  assert.equal(ev.causationId, 'evt_cause');
  assert.equal(ev.agentId, 'agt_1');
  assert.equal(ev.workItemId, 'wi_1');
  assert.equal(ev.aggregateType, 'model');
  assert.equal(ev.aggregateId, 'agt_1');
  assert.deepEqual(ev.payload, {
    ok: true,
    routeId: 'a',
    provider: 'scripted',
    model: 'a-model',
    selectedByPolicy: 'quality',
    score: 0.9,
    reasoningEffort: null,
    fallbackChain: ['b'],
    rejected: [{ routeId: 'c', stage: 'security', reason: 'route disabled' }],
    snapshotId: 'ctx_42',
    catalogRevision: catalog.revision,
    role: 'analyst',
    taskType: 'analyze',
    agentId: 'agt_1',
  });
});

test('fail closed on malformed requests: unknown classification/risk, bad token estimate, missing snapshot', async () => {
  const { router, events } = setup([profile({ routeId: 'a' })]);
  const bad: Array<Partial<RouteRequest>> = [
    { dataClassification: 'secret' as never },
    { actionRisk: 'extreme' as never },
    { contextTokensEstimate: Number.NaN },
    { contextTokensEstimate: -1 },
    { contextSnapshotId: '' },
  ];
  for (const b of bad) {
    await assert.rejects(router.route(routeRequest(b), ctx), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument', JSON.stringify(b));
  }
  await assert.rejects(router.route(routeRequest({}, { privacyClass: 'top_secret' as never }), ctx), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
  assert.equal(events.events.length, 0);
});

test('fail closed on a foreign catalog with malformed profiles: unknown class, NaN quality, NaN cost are never selected', async () => {
  const good = profile({ routeId: 'good', quality: { default: 0.2 } });
  const foreign: ModelCatalogLike = {
    revision: 'foreign_1',
    list: () => [
      { ...profile({ routeId: 'weird_class', quality: { default: 1 } }), maxDataClassification: 'secret' as never },
      { ...profile({ routeId: 'weird_risk', quality: { default: 1 } }), maxActionRisk: 'extreme' as never },
      { ...profile({ routeId: 'nan_quality' }), quality: { default: Number.NaN } },
      { ...profile({ routeId: 'nan_cost', quality: { default: 1 } }), costPerMillionInputUsd: Number.NaN },
      good,
    ],
    get: (id) => (id === 'good' ? good : undefined),
  };
  const { router } = setup([], { providers: ['scripted'], catalog: foreign });
  const d = ok(await router.route(routeRequest({}, { minQuality: 0.1, maxCostPerCallUsd: 10 }), ctx));
  assert.equal(d.routeId, 'good');
  assert.deepEqual(d.rejected.map((r) => [r.routeId, r.stage]), [
    ['weird_class', 'security'],
    ['weird_risk', 'security'],
    ['nan_quality', 'quality'],
    ['nan_cost', 'cost'],
  ]);
});

test('an allowedProviders list that is empty allows nothing (fail closed)', async () => {
  const { router } = setup([profile({ routeId: 'a' })]);
  const d = await router.route(routeRequest({}, { allowedProviders: [] }), ctx);
  assert.equal(d.ok, false);
});

test('routing is not silent: an event sink failure fails the route call (I10)', async () => {
  const failing: DomainEventSink = {
    emit: async (_e: DomainEventInput<unknown>[]): Promise<DomainEvent<unknown>[]> => {
      throw new HypertestError('unavailable', 'event store down');
    },
  };
  const { router } = setup([profile({ routeId: 'a' })], { events: failing });
  await assert.rejects(router.route(routeRequest(), ctx), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable');
});

test('excluded routes are reported with stage "excluded" and never selected', async () => {
  const { router } = setup([profile({ routeId: 'a', quality: { default: 0.9 } }), profile({ routeId: 'b' })]);
  const d = ok(await router.route(routeRequest({ excludeRoutes: ['a'] }, { preferredRoutes: ['a'] }), ctx));
  assert.equal(d.routeId, 'b');
  assert.deepEqual(d.rejected, [{ routeId: 'a', stage: 'excluded', reason: 'route already failed in this epoch sequence' }]);
});

// ----------------------------------------------------------------------------- adversarial review fixes

test('fail closed on list fields that are not arrays: a string allowedProviders never substring-matches a provider', async () => {
  const { router, events } = setup([profile({ routeId: 'a', provider: 'openai' })]);
  // `'openai-proxy'.includes('openai')` is true: without validation this would ALLOW provider openai.
  const bad: Array<[Partial<RouteRequest>, Record<string, unknown>]> = [
    [{}, { allowedProviders: 'openai-proxy' }],
    [{}, { prohibitedProviders: 'x' }],
    [{}, { preferredRoutes: 'a' }],
    [{}, { requiredCapabilities: 'tool_use' }],
    [{}, { independentFromRoles: 'executor' }],
    [{ providersToAvoid: 'openai' as never }, {}],
    [{ excludeRoutes: 'a' as never }, {}],
    [{ requiredCapabilities: undefined as never }, {}],
    [{ providersToAvoid: [1] as never }, {}],
  ];
  for (const [req, policy] of bad) {
    await assert.rejects(router.route(routeRequest(req, policy as never), ctx), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument', JSON.stringify([req, policy]));
  }
  await assert.rejects(router.route({ ...routeRequest(), policy: null as never }, ctx), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
  assert.equal(events.events.length, 0);
});

test('fail closed on a foreign catalog whose enabled flag is not exactly true or whose capabilities are not an array', async () => {
  const good = profile({ routeId: 'good', quality: { default: 0.1 } });
  const foreign: ModelCatalogLike = {
    revision: 'foreign_2',
    list: () => [
      { ...profile({ routeId: 'truthy', quality: { default: 1 } }), enabled: 'yes' as never },
      { ...profile({ routeId: 'caps_string', quality: { default: 1 } }), capabilities: 'tool_use,vision' as never },
      good,
    ],
    get: (id) => (id === 'good' ? good : undefined),
  };
  const { router } = setup([], { providers: ['scripted'], catalog: foreign });
  const d = ok(await router.route(routeRequest({ requiredCapabilities: ['tool_use'] }), ctx));
  assert.equal(d.routeId, 'good');
  assert.deepEqual(d.rejected, [
    { routeId: 'truthy', stage: 'security', reason: 'route disabled' },
    { routeId: 'caps_string', stage: 'capability', reason: 'missing capabilities: tool_use' },
  ]);
});

test('independence that was not resolved (independentFromRoles set, providersToAvoid undefined) is logged as a warning', async () => {
  const deps = testDeps();
  const catalog = new ModelCatalog([profile({ routeId: 'a' })]);
  const router = createModelRouter({ ...deps, catalog, providers: new ProviderRegistry([new ScriptedProvider({ brain: () => ({ text: 'x' }) })]) });
  await router.route(routeRequest({ role: 'reviewer' }, { independentFromRoles: ['executor'] }), ctx);
  assert.deepEqual(deps.logger.entries.filter((e) => e.level === 'warn').map((e) => e.fields['independentFromRoles']), [['executor']]);
  deps.logger.entries.length = 0;
  await router.route(routeRequest({ role: 'reviewer', providersToAvoid: [] }, { independentFromRoles: ['executor'] }), ctx);
  assert.equal(deps.logger.entries.filter((e) => e.level === 'warn').length, 0, '[] means resolved: nothing to warn about');
});
