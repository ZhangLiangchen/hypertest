import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventSink, type DataClassification, type ModelCapability, type ModelPolicy, type RiskClass } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ModelCapabilityProfile, type RouteDecision, type RouteRequest } from '../src/index.ts';
import { profile, rng } from './helpers.ts';

const CLASSES: DataClassification[] = ['public', 'internal', 'confidential', 'restricted'];
const RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const CAPS: ModelCapability[] = ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'vision', 'long_context'];
const PROVIDERS = ['p1', 'p2', 'p3', 'p4'];
const ROLES = ['executor', 'reviewer', 'analyst', 'lead'];
const TASKS = ['execute_tests', 'review', 'analyze', 'plan'];
const ctx = eventCtx('run_prop');

type R = ReturnType<typeof rng>;

function subset<T>(r: R, xs: readonly T[], p = 0.5): T[] {
  return xs.filter(() => r.bool(p));
}

function randomProfile(r: R, i: number): ModelCapabilityProfile {
  const quality: Record<string, number> = {};
  if (r.bool(0.7)) quality['default'] = Math.round(r.next() * 100) / 100;
  for (const k of [...ROLES, ...TASKS]) if (r.bool(0.25)) quality[k] = r.bool(0.1) ? 0 : Math.round(r.next() * 100) / 100;
  return profile({
    routeId: `r${String(i).padStart(2, '0')}`,
    provider: r.pick(PROVIDERS),
    enabled: r.bool(0.9),
    maxDataClassification: r.pick(CLASSES),
    maxActionRisk: r.pick(RISKS),
    capabilities: subset(r, CAPS, 0.7),
    structuredOutput: r.pick(['native', 'prompted', 'none'] as const),
    contextWindow: r.int(2000, 300_000),
    maxOutputTokens: r.int(512, 16_384),
    quality,
    toolReliability: Math.round(r.next() * 10) / 10,
    costPerMillionInputUsd: r.pick([0, 0.1, 1, 3, 15]),
    costPerMillionOutputUsd: r.pick([0, 0.4, 4, 15, 60]),
    typicalLatencyMs: r.pick([100, 500, 1000, 3000, 8000]),
  });
}

function randomRequest(r: R, routeIds: string[]): RouteRequest {
  const policy: ModelPolicy = {};
  if (r.bool(0.4)) policy.minQuality = Math.round(r.next() * 60) / 100;
  if (r.bool(0.3)) policy.latencyBudgetMs = r.pick([500, 1000, 3000, 8000]);
  if (r.bool(0.3)) policy.maxCostPerCallUsd = r.pick([0.001, 0.01, 0.1, 1]);
  if (r.bool(0.2)) policy.allowedProviders = subset(r, PROVIDERS, 0.6);
  if (r.bool(0.2)) policy.prohibitedProviders = subset(r, PROVIDERS, 0.3);
  if (r.bool(0.3)) policy.privacyClass = r.pick(CLASSES);
  if (r.bool(0.3)) policy.requiredCapabilities = subset(r, CAPS, 0.2);
  if (r.bool(0.4)) policy.preferredRoutes = subset(r, routeIds, 0.3).sort(() => r.next() - 0.5);
  const req: RouteRequest = {
    runId: 'run_prop',
    agentId: 'agt',
    role: r.pick(ROLES),
    taskType: r.pick(TASKS),
    policy,
    requiredCapabilities: subset(r, CAPS, 0.2),
    actionRisk: r.pick(RISKS),
    dataClassification: r.pick(CLASSES),
    contextTokensEstimate: r.int(0, 150_000),
    contextSnapshotId: 'ctx',
  };
  if (r.bool(0.5)) req.structuredOutput = true;
  if (r.bool(0.3)) req.providersToAvoid = subset(r, PROVIDERS, 0.3);
  if (r.bool(0.3)) req.excludeRoutes = subset(r, routeIds, 0.2);
  return req;
}

const CO: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const RO: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Independent, straightforward re-statement of the routing spec (the oracle for the property tests). */
function reference(ps: ModelCapabilityProfile[], q: RouteRequest): { stages: Map<string, string>; ranked: string[] } {
  const stages = new Map<string, string>();
  const need = Math.max(CO[q.dataClassification], q.policy.privacyClass ? CO[q.policy.privacyClass] : 0);
  const caps = new Set([...q.requiredCapabilities, ...(q.policy.requiredCapabilities ?? [])]);
  const score = (p: ModelCapabilityProfile) => p.quality[q.role] ?? p.quality[q.taskType] ?? p.quality['default'] ?? 0;
  const cost = (p: ModelCapabilityProfile) => (q.contextTokensEstimate * p.costPerMillionInputUsd + p.maxOutputTokens * p.costPerMillionOutputUsd) / 1e6;
  const eligible: ModelCapabilityProfile[] = [];
  for (const p of ps) {
    let stage: string | undefined;
    if (!p.enabled) stage = 'security';
    else if (q.excludeRoutes?.includes(p.routeId)) stage = 'excluded';
    else if (
      (q.policy.allowedProviders && !q.policy.allowedProviders.includes(p.provider)) ||
      q.policy.prohibitedProviders?.includes(p.provider) ||
      CO[p.maxDataClassification] < need ||
      RO[p.maxActionRisk] < RO[q.actionRisk] ||
      q.providersToAvoid?.includes(p.provider)
    )
      stage = 'security';
    else if ([...caps].some((c) => !p.capabilities.includes(c)) || (q.structuredOutput && p.structuredOutput === 'none') || p.contextWindow < q.contextTokensEstimate + Math.min(p.maxOutputTokens, 4096))
      stage = 'capability';
    else if ((p.quality[q.role] ?? p.quality[q.taskType]) === 0) stage = 'role';
    else if (q.policy.minQuality !== undefined && score(p) < q.policy.minQuality) stage = 'quality';
    else if (q.policy.latencyBudgetMs !== undefined && p.typicalLatencyMs > q.policy.latencyBudgetMs) stage = 'latency';
    else if (q.policy.maxCostPerCallUsd !== undefined && cost(p) > q.policy.maxCostPerCallUsd) stage = 'cost';
    if (stage) stages.set(p.routeId, stage);
    else eligible.push(p);
  }
  const pref = (p: ModelCapabilityProfile) => {
    const i = q.policy.preferredRoutes?.indexOf(p.routeId) ?? -1;
    return i < 0 ? Infinity : i;
  };
  const exec = q.role === 'executor' || q.taskType.includes('execute');
  eligible.sort((a, b) => {
    const keys: Array<[number, number]> = [[pref(a), pref(b)], [score(b), score(a)]];
    if (exec) keys.push([b.toolReliability, a.toolReliability]);
    keys.push([a.typicalLatencyMs, b.typicalLatencyMs], [cost(a), cost(b)]);
    for (const [x, y] of keys) if (x !== y) return x < y ? -1 : 1;
    return a.routeId < b.routeId ? -1 : 1;
  });
  return { stages, ranked: eligible.map((p) => p.routeId) };
}

function router(ps: ModelCapabilityProfile[]) {
  const registry = new ProviderRegistry(PROVIDERS.map((id) => new ScriptedProvider({ providerId: id, brain: () => ({ text: 'x' }) })));
  return createModelRouter({ ...testDeps(), catalog: new ModelCatalog(ps), providers: registry, events: new InMemoryEventSink() });
}

function selected(d: RouteDecision): string | undefined {
  return d.ok ? d.routeId : undefined;
}

const SEEDS = 400;

test(`property (${SEEDS} seeded catalogs): router agrees with the reference spec on selection, fallback chain and first failing stage`, async () => {
  let routed = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const ps = Array.from({ length: r.int(3, 10) }, (_, i) => randomProfile(r, i));
    const q = randomRequest(r, ps.map((p) => p.routeId));
    const d = await router(ps).route(q, ctx);
    const ref = reference(ps, q);
    assert.equal(selected(d), ref.ranked[0], `seed ${seed}: selection`);
    if (d.ok) {
      routed++;
      assert.deepEqual(d.fallbackChain, ref.ranked.slice(1), `seed ${seed}: fallback chain`);
    }
    assert.deepEqual(new Map(d.rejected.map((x) => [x.routeId, x.stage])), ref.stages, `seed ${seed}: stages`);
  }
  // The generator must exercise both outcomes, otherwise the property is vacuous.
  assert.ok(routed > SEEDS * 0.2 && routed < SEEDS * 0.95, `routed ${routed}/${SEEDS}`);
});

test(`property (${SEEDS} seeds): the selected route never violates security or capability constraints`, async () => {
  for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
    const r = rng(seed);
    const ps = Array.from({ length: r.int(3, 10) }, (_, i) => randomProfile(r, i));
    const q = randomRequest(r, ps.map((p) => p.routeId));
    const d = await router(ps).route(q, ctx);
    if (!d.ok) continue;
    const p = ps.find((x) => x.routeId === d.routeId)!;
    const need = Math.max(CO[q.dataClassification], q.policy.privacyClass ? CO[q.policy.privacyClass] : 0);
    assert.ok(p.enabled, `seed ${seed}`);
    assert.ok(CO[p.maxDataClassification] >= need, `seed ${seed}: classification`);
    assert.ok(RO[p.maxActionRisk] >= RO[q.actionRisk], `seed ${seed}: risk`);
    assert.ok(!q.providersToAvoid?.includes(p.provider), `seed ${seed}: independence`);
    assert.ok(!q.excludeRoutes?.includes(p.routeId), `seed ${seed}: excluded`);
    assert.ok(!q.policy.prohibitedProviders?.includes(p.provider), `seed ${seed}: prohibited`);
    assert.ok(!q.policy.allowedProviders || q.policy.allowedProviders.includes(p.provider), `seed ${seed}: allowed`);
    for (const c of [...q.requiredCapabilities, ...(q.policy.requiredCapabilities ?? [])]) assert.ok(p.capabilities.includes(c), `seed ${seed}: ${c}`);
  }
});

test(`metamorphic (${SEEDS} seeds): making another route free never lets it beat a higher-ranked route; making a security-violating route free AND top-preferred never selects it`, async () => {
  let securityProbes = 0;
  let cheapProbes = 0;
  for (let seed = 5000; seed < 5000 + SEEDS; seed++) {
    const r = rng(seed);
    const ps = Array.from({ length: r.int(3, 8) }, (_, i) => randomProfile(r, i));
    const q = randomRequest(r, ps.map((p) => p.routeId));
    delete q.policy.preferredRoutes;
    if (seed % 2 === 0) {
      // Relaxed half: many eligible routes, so cheapness is probed against real competitors.
      q.dataClassification = 'public';
      q.actionRisk = 'low';
      q.requiredCapabilities = [];
      q.contextTokensEstimate = Math.min(q.contextTokensEstimate, 1000);
      delete q.structuredOutput;
      delete q.policy.privacyClass;
      delete q.policy.requiredCapabilities;
      delete q.policy.minQuality;
    }
    const base = await router(ps).route(q, ctx);
    const baseStages = new Map(base.rejected.map((x) => [x.routeId, x.stage]));
    for (const y of ps) {
      if (base.ok && y.routeId === base.routeId) continue;
      const free = ps.map((p) => (p.routeId === y.routeId ? { ...p, costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 } : p));
      const stage = baseStages.get(y.routeId);
      if (stage === 'security') {
        securityProbes++;
        const d = await router(free).route({ ...q, policy: { ...q.policy, preferredRoutes: [y.routeId] } }, ctx);
        assert.notEqual(selected(d), y.routeId, `seed ${seed}: security-violating ${y.routeId} selected after becoming free + preferred`);
        continue;
      }
      if (stage !== undefined && stage !== 'cost') {
        const d = await router(free).route(q, ctx);
        assert.notEqual(selected(d), y.routeId, `seed ${seed}: ${y.routeId} rejected at ${stage} selected after becoming free`);
        continue;
      }
      if (stage === undefined && base.ok) {
        // y was eligible but ranked lower: cheapness may only matter when it ties the winner on every earlier criterion.
        cheapProbes++;
        const d = await router(free).route(q, ctx);
        if (selected(d) === y.routeId) {
          const x = ps.find((p) => p.routeId === base.routeId)!;
          const s = (p: ModelCapabilityProfile) => p.quality[q.role] ?? p.quality[q.taskType] ?? p.quality['default'] ?? 0;
          const exec = q.role === 'executor' || q.taskType.includes('execute');
          assert.equal(s(y), s(x), `seed ${seed}: cheaper ${y.routeId} beat higher-quality ${x.routeId}`);
          if (exec) assert.equal(y.toolReliability, x.toolReliability, `seed ${seed}: reliability`);
          assert.equal(y.typicalLatencyMs, x.typicalLatencyMs, `seed ${seed}: latency`);
        }
      }
    }
  }
  assert.ok(securityProbes > 50, `security probes: ${securityProbes}`);
  assert.ok(cheapProbes > 50, `cheapness probes: ${cheapProbes}`);
});
