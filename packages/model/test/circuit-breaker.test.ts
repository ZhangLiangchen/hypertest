import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { InMemoryEventSink, type ModelPolicy } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  MODEL_CIRCUIT_EVENTS,
  ModelCatalog,
  ProviderRegistry,
  ROUTING_STAGES,
  ScriptedProvider,
  createModelRouter,
  type CircuitBreakerOptions,
  type InvokeRequest,
  type ModelCapabilityProfile,
  type ModelCatalogLike,
  type RouteDecision,
  type RouteRequest,
  type ScriptedBrain,
} from '../src/index.ts';
import { profile, rng, routeRequest } from './helpers.ts';

/**
 * Model circuit breaker (technology-selection §关键风险 "模型价格/限流突然变化": Model Catalog + budgets + circuit breaker):
 * per-route breaker, `availability` routing stage after security/capability/role/quality, single half-open probe,
 * price guard for cost-limited policies, fail-closed interaction with fallbacks.
 */

const ctx = eventCtx('run_cb', { correlationId: 'corr_cb', agentId: 'agt_1', workItemId: 'wi_cb' });
type Ok = Extract<RouteDecision, { ok: true }>;

const ok: ScriptedBrain = () => ({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } });
const down = (code: 'unavailable' | 'rate_limited' | 'timeout' | 'provider_error' = 'unavailable'): ScriptedBrain => () => ({ error: code, message: `${code}!` });

/** A brain whose replies are switched by the test (and optionally held until released). */
function switchable(initial: ScriptedBrain): { brain: ScriptedBrain; set(b: ScriptedBrain): void; hold(): () => void } {
  let current = initial;
  let gate: Promise<void> | undefined;
  return {
    brain: async (req, info) => {
      if (gate) await gate;
      return current(req, info);
    },
    set(b) {
      current = b;
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

/** A foreign (unvalidated) catalog: the router must not trust its numbers (e.g. a NaN price). */
function rawCatalog(profiles: ModelCapabilityProfile[], revision = 'raw-1'): ModelCatalogLike {
  return { revision, list: () => profiles, get: (id) => profiles.find((p) => p.routeId === id) };
}

function setup(profiles: ModelCapabilityProfile[], brains: Record<string, ScriptedBrain>, circuitBreaker?: CircuitBreakerOptions | false, catalog?: ModelCatalogLike) {
  const providers = Object.fromEntries(Object.entries(brains).map(([id, brain]) => [id, new ScriptedProvider({ providerId: id, brain })]));
  const deps = testDeps();
  const events = new InMemoryEventSink();
  const router = createModelRouter({
    ...deps,
    catalog: catalog ?? new ModelCatalog(profiles),
    providers: new ProviderRegistry(Object.values(providers)),
    events,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
  });
  return { router, providers, events, clock: deps.clock };
}

async function decide(router: ReturnType<typeof createModelRouter>, req: RouteRequest): Promise<Ok> {
  const d = await router.route(req, ctx);
  assert.equal(d.ok, true, `expected a route, got ${JSON.stringify(d)}`);
  return d as Ok;
}

function invokeReq(decision: Ok, extra: Partial<InvokeRequest> = {}): InvokeRequest {
  return { decision, call: { messages: [{ role: 'user', content: 'go' }] }, ctx, maxAttempts: 1, ...extra };
}

function stageOf(d: RouteDecision, routeId: string): string | undefined {
  return d.rejected.find((r) => r.routeId === routeId)?.stage;
}

const pair = [
  profile({ routeId: 'primary', provider: 'pa', quality: { default: 0.9 } }),
  profile({ routeId: 'secondary', provider: 'pb', quality: { default: 0.8 } }),
];

test('the availability stage comes after security, capability, role and quality and before latency and cost', () => {
  assert.deepEqual([...ROUTING_STAGES], ['security', 'capability', 'role', 'quality', 'availability', 'latency', 'cost']);
});

test('closed → open after N consecutive availability failures: the route is rejected at `availability`, never called, and model.circuit_opened is recorded', async () => {
  const { router, providers, events } = setup(pair, { pa: down('unavailable'), pb: ok }, { failureThreshold: 3 });
  const req = routeRequest();
  for (let i = 0; i < 3; i++) {
    const d = await decide(router, req);
    assert.equal(d.routeId, 'primary', `call ${i}: still closed`);
    const out = await router.invoke(invokeReq(d), req);
    assert.equal(out.ok, false);
  }
  assert.equal(providers['pa']!.requests.length, 3);
  const opened = events.ofType(MODEL_CIRCUIT_EVENTS.opened);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.aggregateId, 'primary');
  assert.equal(opened[0]!.runId, 'run_cb');
  assert.deepEqual(
    (({ reason, code, consecutiveFailures }) => ({ reason, code, consecutiveFailures }))(opened[0]!.payload as Record<string, unknown>),
    { reason: 'consecutive_failures', code: 'unavailable', consecutiveFailures: 3 },
  );
  // open: routing rejects it at availability and picks the next eligible route
  const d = await decide(router, req);
  assert.equal(d.routeId, 'secondary');
  assert.equal(stageOf(d, 'primary'), 'availability');
  assert.match(d.rejected.find((r) => r.routeId === 'primary')!.reason, /circuit open \(consecutive_failures: unavailable\)/);
  assert.deepEqual(router.circuits!().map((c) => [c.routeId, c.state, c.reason]), [['primary', 'open', 'consecutive_failures']]);
});

test('a success resets the consecutive count; non-availability errors (provider_error) neither count nor reset', async () => {
  const sw = switchable(down('timeout'));
  const { router } = setup(pair, { pa: sw.brain, pb: ok }, { failureThreshold: 3 });
  const req = routeRequest();
  const call = async () => router.invoke(invokeReq(await decide(router, req)), req);
  await call();
  await call(); // 2 timeouts
  sw.set(ok);
  assert.equal((await call()).ok, true); // reset
  sw.set(down('timeout'));
  await call();
  await call(); // 2 timeouts again
  sw.set(down('provider_error'));
  await call(); // a bad request is no availability signal
  assert.equal(router.circuits!()[0]!.state, 'closed');
  assert.equal(router.circuits!()[0]!.consecutiveFailures, 2);
  sw.set(down('timeout'));
  await call(); // third consecutive availability failure
  assert.equal(router.circuits!()[0]!.state, 'open');
});

test('same-route retries stop as soon as the breaker opens (no retry into an open circuit)', async () => {
  const { router, providers } = setup(pair, { pa: down('unavailable'), pb: ok }, { failureThreshold: 2 });
  const req = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, req), { maxAttempts: 6 }), req);
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 2);
  assert.equal(providers['pa']!.requests.length, 2);
  // the fallback computed for the next boundary never points at the open route
  assert.equal(out.ok ? undefined : out.fallback?.routeId, 'secondary');
});

test('a rate-limit storm opens the breaker even with successes in between; rate limits spread beyond the window do not', async () => {
  const sw = switchable(down('rate_limited'));
  const { router, clock } = setup(pair, { pa: sw.brain, pb: ok }, { failureThreshold: 100, rateLimitStorm: { count: 3, windowMs: 10_000 } });
  const req = routeRequest();
  const call = async () => router.invoke(invokeReq(await decide(router, req)), req);
  for (let i = 0; i < 3; i++) {
    sw.set(down('rate_limited'));
    await call();
    sw.set(ok);
    await call();
    clock.advance(6_000); // two rate limits are never inside one 10 s window
  }
  assert.equal(router.circuits!()[0]!.state, 'closed', 'spread rate limits are no storm');
  for (let i = 0; i < 3; i++) {
    sw.set(down('rate_limited'));
    await call();
    sw.set(ok);
    if (i < 2) await call();
    clock.advance(1_000);
  }
  const c = router.circuits!()[0]!;
  assert.equal(c.state, 'open');
  assert.equal(c.reason, 'rate_limit_storm');
});

test('half-open after the cooldown admits exactly ONE probe; concurrent calls are refused (precondition_failed ⇒ re-validated fallback); success closes', async () => {
  const sw = switchable(down('unavailable'));
  const { router, providers, events, clock } = setup(pair, { pa: sw.brain, pb: ok }, { failureThreshold: 1, cooldownMs: 5_000 });
  const req = routeRequest();
  await router.invoke(invokeReq(await decide(router, req)), req);
  assert.equal(router.circuits!()[0]!.state, 'open');
  clock.advance(4_999);
  assert.equal(stageOf(await router.route(req, ctx), 'primary'), 'availability', 'still open inside the cooldown');
  clock.advance(1);
  const d1 = await decide(router, req);
  const d2 = await decide(router, req);
  assert.deepEqual([d1.routeId, d2.routeId], ['primary', 'primary'], 'half-open: the route is selectable while its probe slot is free');
  assert.equal(router.circuits!()[0]!.state, 'half_open');
  sw.set(ok);
  const release = sw.hold();
  const probe = router.invoke(invokeReq(d1, { maxAttempts: 5 }), req);
  // the probe holds the slot: a concurrent call on the same route is refused before any provider call
  const second = await router.invoke(invokeReq(d2), req);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, 'precondition_failed');
    assert.match(second.error.message, /availability.*probe call is in flight/);
    assert.equal(second.attempts, 0);
    assert.equal(second.fallback?.routeId, 'secondary');
  }
  assert.equal(stageOf(await router.route(req, ctx), 'primary'), 'availability', 'routing also skips it while the probe is out');
  release();
  const done = await probe;
  assert.equal(done.ok, true);
  assert.equal(providers['pa']!.requests.length, 2, 'one failure + one probe');
  const closed = events.ofType(MODEL_CIRCUIT_EVENTS.closed);
  assert.equal(closed.length, 1);
  assert.equal((closed[0]!.payload as Record<string, unknown>)['reason'], 'probe_succeeded');
  // the closed event is recorded with the call in one batch, after model.invoked
  const order = events.events.map((e) => e.eventType);
  assert.equal(order[order.indexOf(MODEL_CIRCUIT_EVENTS.closed) - 1], 'model.invoked');
  assert.equal(router.circuits!()[0]!.state, 'closed');
  assert.equal((await decide(router, req)).routeId, 'primary');
});

test('a call that started while closed and succeeds after the breaker opened does not close it (only the probe decides)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const brain: ScriptedBrain = async (_req, { callIndex }) => {
    if (callIndex === 0) {
      await gate;
      return { text: 'late success' };
    }
    return { error: 'unavailable', message: 'down' };
  };
  const { router, providers } = setup(pair, { pa: brain, pb: ok }, { failureThreshold: 1 });
  const req = routeRequest();
  const slow = router.invoke(invokeReq(await decide(router, req)), req);
  for (let i = 0; i < 100 && providers['pa']!.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  const failing = await router.invoke(invokeReq(await decide(router, req)), req);
  assert.equal(failing.ok, false);
  assert.equal(router.circuits!()[0]!.state, 'open');
  release();
  assert.equal((await slow).ok, true);
  assert.equal(router.circuits!()[0]!.state, 'open', 'a stale success is no evidence of recovery');
});

test('a failed probe re-opens with a longer cooldown (backoff); the probe is a single attempt whatever maxAttempts says', async () => {
  const { router, providers, events, clock } = setup(pair, { pa: down('timeout'), pb: ok }, { failureThreshold: 1, cooldownMs: 1_000, cooldownBackoff: 3, maxCooldownMs: 5_000 });
  const req = routeRequest();
  await router.invoke(invokeReq(await decide(router, req)), req);
  clock.advance(1_000);
  const out = await router.invoke(invokeReq(await decide(router, req), { maxAttempts: 4 }), req);
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 1, 'a probe is one call');
  assert.equal(providers['pa']!.requests.length, 2);
  const opened = events.ofType(MODEL_CIRCUIT_EVENTS.opened);
  assert.deepEqual(opened.map((e) => [(e.payload as Record<string, unknown>)['reason'], (e.payload as Record<string, unknown>)['cooldownMs']]), [['consecutive_failures', 1_000], ['probe_failed', 3_000]]);
  clock.advance(2_999);
  assert.equal(router.circuits!()[0]!.state, 'open');
  clock.advance(1);
  assert.equal(router.circuits!()[0]!.state, 'half_open');
  // backoff is capped
  await router.invoke(invokeReq(await decide(router, req)), req);
  assert.equal((events.ofType(MODEL_CIRCUIT_EVENTS.opened).at(-1)!.payload as Record<string, unknown>)['cooldownMs'], 5_000);
});

test('a probe that ends without an availability verdict (bad request, caller cancel) frees the slot and stays half-open', async () => {
  const sw = switchable(down('unavailable'));
  const { router, clock } = setup(pair, { pa: sw.brain, pb: ok }, { failureThreshold: 1, cooldownMs: 100 });
  const req = routeRequest();
  await router.invoke(invokeReq(await decide(router, req)), req);
  clock.advance(100);
  sw.set(down('provider_error'));
  const bad = await router.invoke(invokeReq(await decide(router, req)), req);
  assert.equal(bad.ok, false);
  assert.deepEqual((({ state, probeInFlight }) => ({ state, probeInFlight }))(router.circuits!()[0]!), { state: 'half_open', probeInFlight: false });
  // cancelled by the caller mid-probe: not a route failure either
  sw.set(ok);
  const release = sw.hold();
  const abort = new AbortController();
  const pending = router.invoke(invokeReq(await decide(router, req), { call: { messages: [{ role: 'user', content: 'go' }], signal: abort.signal } }), req);
  abort.abort();
  release();
  const cancelled = await pending;
  assert.equal(cancelled.ok ? 'ok' : cancelled.error.code, 'cancelled');
  assert.deepEqual((({ state, probeInFlight }) => ({ state, probeInFlight }))(router.circuits!()[0]!), { state: 'half_open', probeInFlight: false });
  assert.equal((await router.invoke(invokeReq(await decide(router, req)), req)).ok, true);
  assert.equal(router.circuits!()[0]!.state, 'closed');
});

test('fail closed: a decision whose route opened since is refused without a provider call — fail_closed policy ⇒ no fallback; revalidated ⇒ fallback to an eligible, closed route only', async () => {
  const routes = [
    profile({ routeId: 'primary', provider: 'pa', quality: { default: 0.9 } }),
    // closed but INELIGIBLE (security): the breaker must never make it a fallback
    profile({ routeId: 'leaky', provider: 'pc', quality: { default: 0.99 }, maxDataClassification: 'public' }),
    profile({ routeId: 'secondary', provider: 'pb', quality: { default: 0.8 } }),
  ];
  const sw = switchable(ok);
  const { router, providers, events } = setup(routes, { pa: sw.brain, pb: ok, pc: ok }, { failureThreshold: 1 });
  const strict = routeRequest({ dataClassification: 'confidential' }, { fallback: 'fail_closed' });
  const decided = await decide(router, strict);
  assert.equal(decided.routeId, 'primary');
  assert.equal(stageOf(decided, 'leaky'), 'security');
  // another call trips the breaker
  sw.set(down('unavailable'));
  const other = routeRequest({ dataClassification: 'confidential' });
  await router.invoke(invokeReq(await decide(router, other)), other);
  const before = providers['pa']!.requests.length;
  const refused = await router.invoke(invokeReq(decided), strict);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, 'precondition_failed');
    assert.match(refused.error.message, /\(availability\)/);
    assert.equal(refused.fallback, undefined, 'fail_closed: no fallback at all');
    assert.equal(refused.attempts, 0);
  }
  assert.equal(providers['pa']!.requests.length, before, 'no provider call through an open circuit');
  const fb = events.ofType('model.fallback').at(-1)!.payload as Record<string, unknown>;
  assert.deepEqual([fb['to'], fb['policy']], [null, 'fail_closed']);
  // revalidated: the fallback is re-routed through every stage — the security-rejected route stays rejected
  const lenient = routeRequest({ dataClassification: 'confidential' });
  const out = await router.invoke(invokeReq(decided), lenient);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.fallback?.routeId, 'secondary');
    assert.equal(stageOf(out.fallback!, 'leaky'), 'security');
    assert.equal(stageOf(out.fallback!, 'primary'), 'excluded');
  }
  // every route open or ineligible ⇒ no eligible route (never an open or insecure one)
  const all = setup([routes[0]!, routes[1]!], { pa: down('unavailable'), pc: ok }, { failureThreshold: 1 });
  const r2 = routeRequest({ dataClassification: 'confidential' });
  await all.router.invoke(invokeReq(await decide(all.router, r2)), r2);
  const none = await all.router.route(r2, ctx);
  assert.equal(none.ok, false);
  assert.deepEqual(none.rejected.map((r) => [r.routeId, r.stage]), [['primary', 'availability'], ['leaky', 'security']]);
});

test('property: the breaker only ever removes candidates — with random breaker states every selected route is one the breaker-free router considers eligible, and earlier-stage rejections are identical', async () => {
  const providers = ['pa', 'pb', 'pc'];
  let availabilityRejections = 0;
  let selectedWithBreakers = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const profiles: ModelCapabilityProfile[] = [];
    const n = r.int(1, 6);
    for (let i = 0; i < n; i++) {
      profiles.push(profile({
        routeId: `r${i}`,
        provider: r.pick(providers),
        quality: { default: r.pick([0, 0.4, 0.7, 0.9]) },
        maxDataClassification: r.pick(['public', 'internal', 'confidential'] as const),
        maxActionRisk: r.pick(['low', 'medium', 'high'] as const),
        capabilities: r.bool(0.8) ? ['tool_use', 'structured_output'] : ['structured_output'],
        costPerMillionInputUsd: r.pick([0.5, 2, 20, Number.NaN]),
        typicalLatencyMs: r.pick([100, 1000, 9000]),
        enabled: r.bool(0.9),
      }));
    }
    const policy: ModelPolicy = {};
    if (r.bool(0.3)) policy.minQuality = 0.5;
    if (r.bool(0.4)) policy.maxCostPerCallUsd = r.pick([0.01, 1]);
    if (r.bool(0.2)) policy.latencyBudgetMs = 2000;
    const req = routeRequest({ dataClassification: r.pick(['public', 'internal', 'confidential'] as const), actionRisk: r.pick(['low', 'medium', 'high'] as const), requiredCapabilities: r.bool(0.5) ? ['tool_use'] : [] }, policy);
    const brains = Object.fromEntries(providers.map((p) => [p, down('unavailable')]));
    const free = setup(profiles, brains, false, rawCatalog(profiles));
    const guarded = setup(profiles, brains, { failureThreshold: 1, priceGuard: { default: { inputPerMillionUsd: r.pick([1, 5, 100]) } } }, rawCatalog(profiles));
    // trip the breakers of a random subset of routes (each failing call opens its route at threshold 1)
    for (const p of profiles) {
      if (!r.bool(0.5)) continue;
      const d = await guarded.router.route(req, ctx);
      if (!d.ok || d.routeId !== p.routeId) continue;
      await guarded.router.invoke(invokeReq(d), req);
    }
    const base = await free.router.route(req, ctx);
    const withBreaker = await guarded.router.route(req, ctx);
    const baseStages = new Map(base.rejected.map((x) => [x.routeId, x.stage]));
    const eligibleWithout = new Set(base.ok ? [base.routeId, ...base.fallbackChain] : []);
    for (const x of withBreaker.rejected) {
      if (x.stage === 'availability') {
        availabilityRejections++;
        const s = baseStages.get(x.routeId);
        assert.ok(s === undefined || s === 'latency' || s === 'cost', `seed ${seed}: ${x.routeId} rejected at availability but was ${s} without the breaker`);
      } else if (['security', 'capability', 'role', 'quality', 'excluded'].includes(x.stage)) {
        assert.equal(baseStages.get(x.routeId), x.stage, `seed ${seed}: ${x.routeId} earlier-stage rejection differs`);
      }
    }
    if (withBreaker.ok) {
      selectedWithBreakers++;
      assert.ok(eligibleWithout.has(withBreaker.routeId), `seed ${seed}: breaker router selected ${withBreaker.routeId}, not eligible without it`);
      for (const f of withBreaker.fallbackChain) assert.ok(eligibleWithout.has(f), `seed ${seed}: fallback ${f} not eligible without the breaker`);
    }
  }
  // the property is exercised: breakers and price guards really rejected routes, and routes were still selected
  assert.ok(availabilityRejections >= 30, `only ${availabilityRejections} availability rejections`);
  assert.ok(selectedWithBreakers >= 20, `only ${selectedWithBreakers} selections`);
});

test('price guard: a catalog price above the ceiling opens the breaker for cost-limited policies only; recorded once; cleared by a catalog revision back under the ceiling', async () => {
  let prices = { costPerMillionInputUsd: 12, costPerMillionOutputUsd: 40 };
  let revision = 'cat-1';
  const cheap = profile({ routeId: 'cheap', provider: 'pb', quality: { default: 0.6 }, costPerMillionInputUsd: 0.1, costPerMillionOutputUsd: 0.2 });
  const catalog: ModelCatalogLike = {
    get revision() {
      return revision;
    },
    list: () => [profile({ routeId: 'premium', provider: 'pa', quality: { default: 0.95 }, ...prices }), cheap],
    get(id) {
      return this.list().find((p) => p.routeId === id);
    },
  };
  const { router, events } = setup([], { pa: ok, pb: ok }, { priceGuard: { default: { inputPerMillionUsd: 10, outputPerMillionUsd: 30 } } }, catalog);
  const limited = routeRequest({}, { maxCostPerCallUsd: 5 });
  const unlimited = routeRequest();
  const d1 = await decide(router, limited);
  assert.equal(d1.routeId, 'cheap');
  assert.equal(stageOf(d1, 'premium'), 'availability');
  assert.match(d1.rejected.find((r) => r.routeId === 'premium')!.reason, /price .*exceeds the ceiling/);
  assert.equal((await decide(router, unlimited)).routeId, 'premium', 'not cost-limited: the guard does not apply');
  await decide(router, limited);
  const opened = events.ofType(MODEL_CIRCUIT_EVENTS.opened);
  assert.equal(opened.length, 1, 'recorded once while it stays above the ceiling');
  assert.deepEqual((({ reason, routeId, catalogRevision }) => ({ reason, routeId, catalogRevision }))(opened[0]!.payload as Record<string, unknown>), { reason: 'price_ceiling', routeId: 'premium', catalogRevision: 'cat-1' });
  // a decision on the premium route made for an unlimited request cannot be invoked for a cost-limited one
  const premium = await decide(router, unlimited);
  const refused = await router.invoke(invokeReq(premium), limited);
  assert.equal(refused.ok ? 'ok' : refused.error.code, 'precondition_failed');
  // the catalog price comes back under the ceiling (new revision)
  prices = { costPerMillionInputUsd: 8, costPerMillionOutputUsd: 20 };
  revision = 'cat-2';
  assert.equal((await decide(router, limited)).routeId, 'premium');
  const closed = events.ofType(MODEL_CIRCUIT_EVENTS.closed);
  assert.deepEqual(closed.map((e) => (e.payload as Record<string, unknown>)['reason']), ['price_ceiling_cleared']);
});

test('price guard: per-route ceilings override the default; a non-finite catalog price never passes; appliesTo all covers every request', async () => {
  const ps = [
    profile({ routeId: 'a', provider: 'pa', quality: { default: 0.9 }, costPerMillionInputUsd: 15 }),
    profile({ routeId: 'b', provider: 'pb', quality: { default: 0.8 }, costPerMillionInputUsd: Number.NaN }),
    profile({ routeId: 'c', provider: 'pc', quality: { default: 0.7 }, costPerMillionInputUsd: 1 }),
  ];
  const { router } = setup(ps, { pa: ok, pb: ok, pc: ok }, { priceGuard: { default: { inputPerMillionUsd: 10 }, routes: { a: { inputPerMillionUsd: 20 } }, appliesTo: 'all' } }, rawCatalog(ps));
  const d = await router.route(routeRequest(), ctx);
  assert.equal(d.ok && d.routeId, 'a');
  assert.equal(stageOf(d, 'b'), 'availability');
  assert.deepEqual(d.ok ? d.fallbackChain : [], ['c']);
});

test('circuitBreaker: false disables the breaker; malformed options are refused', async () => {
  const { router, providers } = setup(pair, { pa: down('unavailable'), pb: ok }, false);
  const req = routeRequest();
  for (let i = 0; i < 12; i++) await router.invoke(invokeReq(await decide(router, req)), req);
  assert.equal(providers['pa']!.requests.length, 12);
  assert.equal((await decide(router, req)).routeId, 'primary');
  assert.deepEqual(router.circuits!(), []);
  for (const bad of [{ failureThreshold: 0 }, { cooldownMs: -1 }, { rateLimitStorm: { count: 0, windowMs: 10 } }, { cooldownBackoff: 0.5 }, { priceGuard: { default: { inputPerMillionUsd: -1 } } }, { priceGuard: { appliesTo: 'some' as 'all' } }]) {
    assert.throws(() => setup(pair, { pa: ok }, bad as CircuitBreakerOptions), (e: unknown) => isHypertestError(e, 'invalid_argument'), JSON.stringify(bad));
  }
});

test('an event sink failure while recording the breaker transition of a FAILED call is a fault (routing is not silent)', async () => {
  const providers = new ProviderRegistry([new ScriptedProvider({ providerId: 'pa', brain: down('unavailable') }), new ScriptedProvider({ providerId: 'pb', brain: ok })]);
  const sink = new InMemoryEventSink();
  let failOn: string | undefined;
  const router = createModelRouter({
    ...testDeps(),
    catalog: new ModelCatalog(pair),
    providers,
    events: { emit: async (evs) => { if (failOn && evs.some((e) => e.eventType === failOn)) throw new Error('store down'); return sink.emit(evs); } },
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    circuitBreaker: { failureThreshold: 1 },
  });
  const req = routeRequest();
  const d = await decide(router, req);
  failOn = MODEL_CIRCUIT_EVENTS.opened;
  await assert.rejects(router.invoke(invokeReq(d), req), /store down/);
  assert.equal(sink.ofType('model.invoked').length, 0, 'the call and its transition are one batch: nothing half-recorded');
});
