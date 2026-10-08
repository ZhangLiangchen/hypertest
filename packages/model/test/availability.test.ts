/**
 * Model availability and price governance:
 *  - e2e[3]: a provider whose required credential is missing is unavailable — rejected at the capability stage, its
 *    complete() refuses locally; a recording fetch sees zero requests;
 *  - A[0]: a failed routing / invoke without a fallback is classified transient (pause) or permanent (fail closed);
 *  - A[3]: validate() re-checks a decision without calling, acquiring a probe slot or emitting events;
 *  - A[2]: an undeclared price is unknown: never used by a cost-limited request; cheaperThanUsd keeps strictly cheaper routes;
 *  - A[1]: an observed price beyond priceGuard.maxIncreasePct opens the route's circuit (L0 events), the prices file is
 *    re-read at the next safe point.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import { InMemoryEventSink } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  AnthropicProvider, ModelCatalog, OpenAICompatibleProvider, PiAiProvider, ProviderRegistry, ScriptedProvider, createFilePriceSource, createModelRouter, deriveRouteScores,
  parsePricesFile, parseRouteScoresFile, readPricesFile, updatePricesFile, type ObservedPrice, type RouteDecision, type ScriptedBrain,
} from '../src/index.ts';
import { profile, routeRequest } from './helpers.ts';

const ctx = eventCtx('run_av', { correlationId: 'corr_av', agentId: 'agt_1' });
type Ok = Extract<RouteDecision, { ok: true }>;
const ok: ScriptedBrain = () => ({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } });

function recordingFetch(): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  return { calls, fetch: (async (input: Parameters<typeof fetch>[0]) => (calls.push(String(input)), new Response('{}', { status: 401 }))) as typeof fetch };
}

test('e2e[3]: HTTP providers requiring a key are unavailable without it and never send a request', async () => {
  const rec = recordingFetch();
  const providers = [
    new OpenAICompatibleProvider({ providerId: 'ds', baseUrl: 'https://api.example.invalid/v1', requireApiKey: true, apiKeySource: 'DS_KEY', fetchImpl: rec.fetch }),
    new AnthropicProvider({ providerId: 'claude', requireApiKey: true, apiKey: '   ', apiKeySource: 'CLAUDE_KEY', fetchImpl: rec.fetch }),
    new PiAiProvider({ providerId: 'pi', piProvider: 'openai', requireApiKey: true, apiKeySource: 'PI_KEY', fetchImpl: rec.fetch }),
  ];
  for (const p of providers) {
    const a = p.availability();
    assert.equal(a.ok, false);
    assert.match((a as { reason: string }).reason, new RegExp(`^provider ${p.providerId} has no credential: environment variable .+ is not set or empty \\(fail closed: no request is sent\\)$`));
    await assert.rejects(p.complete({ model: 'm', messages: [{ role: 'user', content: 'the goal and target' }] }), (e: unknown) => {
      assert.ok(e instanceof HypertestError);
      assert.equal(e.code, 'precondition_failed');
      assert.equal(e.retryable, false);
      return true;
    });
  }
  // a key present (or no key required: a local server) ⇒ available
  assert.deepEqual(new OpenAICompatibleProvider({ providerId: 'x', baseUrl: 'http://127.0.0.1:1/v1', requireApiKey: true, apiKey: 'k', fetchImpl: rec.fetch }).availability(), { ok: true });
  assert.deepEqual(new OpenAICompatibleProvider({ providerId: 'y', baseUrl: 'http://127.0.0.1:1/v1', fetchImpl: rec.fetch }).availability(), { ok: true });
  assert.deepEqual(rec.calls, []);
});

test('e2e[3]: the router rejects every route of an unavailable provider at the capability stage — permanent (fail closed)', async () => {
  const rec = recordingFetch();
  const catalog = new ModelCatalog([profile({ routeId: 'hosted', provider: 'ds', quality: { default: 0.99 } })]);
  const providers = new ProviderRegistry([new OpenAICompatibleProvider({ providerId: 'ds', baseUrl: 'https://api.example.invalid/v1', requireApiKey: true, apiKeySource: 'DS_KEY', fetchImpl: rec.fetch })]);
  const router = createModelRouter({ ...testDeps(), catalog, providers });
  const d = await router.route(routeRequest(), ctx);
  assert.equal(d.ok, false);
  const failed = d as Extract<RouteDecision, { ok: false }>;
  assert.deepEqual(failed.rejected, [{ routeId: 'hosted', stage: 'capability', reason: 'provider ds is unavailable: provider ds has no credential: environment variable DS_KEY is not set or empty (fail closed: no request is sent)' }]);
  assert.equal(failed.unavailable?.transient, false, 'no configured route may ever serve it in this process: fail closed');
  assert.match(failed.unavailable!.reason, /^no configured model route may serve this request: hosted: capability/);
  assert.deepEqual(rec.calls, []);
});

test('A[0]: invoke without a fallback classifies the failure: availability ⇒ transient (pause), provider_error ⇒ permanent', async () => {
  const deps = testDeps();
  let brain: ScriptedBrain = () => ({ error: 'timeout', message: 'slow' });
  const catalog = new ModelCatalog([profile({ routeId: 'only' })]);
  const providers = new ProviderRegistry([new ScriptedProvider({ brain: (r, i) => brain(r, i) })]);
  const router = createModelRouter({ ...deps, catalog, providers, retry: { baseDelayMs: 1, maxDelayMs: 1 } });
  const req = routeRequest();
  const d = (await router.route(req, ctx)) as Ok;
  const t = await router.invoke({ decision: d, call: { messages: [{ role: 'user', content: 'x' }] }, ctx }, req);
  assert.equal(t.ok, false);
  const tf = t as Extract<typeof t, { ok: false }>;
  assert.equal(tf.fallback, undefined);
  assert.equal(tf.unavailable?.transient, true);
  assert.deepEqual(tf.unavailable?.routes, ['only']);
  assert.match(tf.unavailable!.reason, /^no model route is available now: route only failed \(timeout/);
  brain = () => ({ error: 'provider_error', message: 'HTTP 400 bad tool schema' });
  const p = await router.invoke({ decision: d, call: { messages: [{ role: 'user', content: 'x' }] }, ctx }, req);
  assert.equal((p as Extract<typeof p, { ok: false }>).unavailable?.transient, false);
});

test('A[0]: an open circuit is transient and carries its half-open time as retryAt', async () => {
  const deps = testDeps();
  const catalog = new ModelCatalog([profile({ routeId: 'only' })]);
  const providers = new ProviderRegistry([new ScriptedProvider({ brain: () => ({ error: 'unavailable', message: '503' }) })]);
  const router = createModelRouter({ ...deps, catalog, providers, retry: { baseDelayMs: 1, maxDelayMs: 1 }, circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 } });
  const req = routeRequest();
  const d = (await router.route(req, ctx)) as Ok;
  const out = await router.invoke({ decision: d, call: { messages: [{ role: 'user', content: 'x' }] }, ctx }, req);
  const u = (out as Extract<typeof out, { ok: false }>).unavailable!;
  assert.equal(u.transient, true);
  assert.equal(u.retryAt, new Date(deps.clock.nowMs() + 30_000).toISOString());
  const again = await router.route(req, ctx);
  assert.equal(again.ok, false);
  assert.equal((again as Extract<RouteDecision, { ok: false }>).unavailable?.transient, true);
  assert.equal((again as Extract<RouteDecision, { ok: false }>).unavailable?.retryAt, u.retryAt);
});

test('A[3]: validate() re-checks a decision without a call, a probe slot or an event; catalog changes and policy changes are refused', async () => {
  const deps = testDeps();
  const events = new InMemoryEventSink();
  const calls: string[] = [];
  const catalog = new ModelCatalog([profile({ routeId: 'a', maxDataClassification: 'internal' })]);
  const providers = new ProviderRegistry([new ScriptedProvider({ brain: () => (calls.push('x'), { text: 'x' }) })]);
  const router = createModelRouter({ ...deps, catalog, providers, events });
  const req = routeRequest();
  const d = (await router.route(req, ctx)) as Ok;
  const before = events.events.length;
  assert.deepEqual(await router.validate!(d, req), { ok: true });
  const escalated = await router.validate!(d, routeRequest({ dataClassification: 'restricted' }));
  assert.equal(escalated.ok, false);
  assert.deepEqual(
    escalated.ok ? undefined : [escalated.stage, escalated.transient],
    ['security', false],
  );
  const stale = await router.validate!({ ...d, capabilityProfileRevision: 'mc_old' }, req);
  assert.equal(!stale.ok && stale.stage, 'catalog');
  assert.equal(events.events.length, before, 'no event');
  assert.deepEqual(calls, []);
  assert.equal(router.catalogRevision, catalog.revision);
});

test('A[2]: an unknown price is never used by a cost-limited request; cheaperThanUsd keeps strictly cheaper routes only', async () => {
  const deps = testDeps();
  const noPrice = profile({ routeId: 'unpriced', quality: { default: 0.95 } });
  delete noPrice.costPerMillionInputUsd;
  delete noPrice.costPerMillionOutputUsd;
  const catalog = new ModelCatalog([noPrice, profile({ routeId: 'cheap', quality: { default: 0.8 }, costPerMillionInputUsd: 0.1, costPerMillionOutputUsd: 0.1 }), profile({ routeId: 'dear', quality: { default: 0.9 } })]);
  const providers = new ProviderRegistry([new ScriptedProvider({ brain: ok })]);
  const router = createModelRouter({ ...deps, catalog, providers });
  // no cost limit: the best route, its unknown price notwithstanding
  assert.equal(((await router.route(routeRequest(), ctx)) as Ok).routeId, 'unpriced');
  assert.ok(Number.isNaN(router.estimateCostUsd('unpriced', 1000, 1000)), 'an unknown price is NaN, never $0');
  // a run with a cost budget: never routed to the unknown price
  const budgeted = await router.route(routeRequest({ costBudgeted: true }), ctx);
  assert.equal((budgeted as Ok).routeId, 'dear');
  assert.deepEqual(budgeted.rejected.find((r) => r.routeId === 'unpriced'), { routeId: 'unpriced', stage: 'cost', reason: 'route cost is unknown (no costPerMillionInputUsd/costPerMillionOutputUsd declared or observed) and the request is cost-limited' });
  // budget pressure: strictly cheaper than the current call
  const dearCost = router.estimateCostUsd('dear', 1000, 8192);
  const cheaper = await router.route(routeRequest({ cheaperThanUsd: dearCost }), ctx);
  assert.equal((cheaper as Ok).routeId, 'cheap');
  assert.ok(cheaper.rejected.some((r) => r.routeId === 'dear' && r.stage === 'cost'));
  // usage on an unknown-price route carries no cost
  const d = (await router.route(routeRequest(), ctx)) as Ok;
  const out = await router.invoke({ decision: d, call: { messages: [{ role: 'user', content: 'x' }] }, ctx }, routeRequest());
  assert.equal(out.ok && out.response.usage.costUsd, undefined);
});

test('A[1]: an observed price beyond maxIncreasePct opens the route circuit for every request (L0), and closes once back within the guard', async () => {
  const deps = testDeps();
  const events = new InMemoryEventSink();
  let observed: Record<string, ObservedPrice> = {};
  const catalog = new ModelCatalog([profile({ routeId: 'main', quality: { default: 0.9 }, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 4 }), profile({ routeId: 'backup', quality: { default: 0.7 } })]);
  const providers = new ProviderRegistry([new ScriptedProvider({ brain: ok })]);
  const router = createModelRouter({ ...deps, catalog, providers, events, prices: { current: () => observed }, circuitBreaker: { priceGuard: { maxIncreasePct: 50 } } });
  assert.equal(((await router.route(routeRequest(), ctx)) as Ok).routeId, 'main');
  // +40%: within the guard (the observed price is what a call costs now)
  observed = { main: { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4, source: 'test' } };
  assert.equal(((await router.route(routeRequest(), ctx)) as Ok).routeId, 'main');
  assert.equal(router.estimateCostUsd('main', 1_000_000, 0), 1.4);
  // +200%: the circuit opens, the backup serves
  observed = { main: { inputPerMillionUsd: 3, outputPerMillionUsd: 4, source: 'test' } };
  const d = await router.route(routeRequest(), ctx);
  assert.equal((d as Ok).routeId, 'backup');
  const rej = d.rejected.find((r) => r.routeId === 'main')!;
  assert.equal(rej.stage, 'availability');
  assert.match(rej.reason, /^circuit open \(price_change\): observed price \$3\/\$4 per M in\/out is \+200\.0% over the catalog price \$1\/\$4 \(priceGuard\.maxIncreasePct 50%\)$/);
  const opened = events.events.filter((e) => e.eventType === 'model.circuit_opened');
  assert.equal(opened.length, 1);
  assert.equal((opened[0]!.payload as { reason: string }).reason, 'price_change');
  assert.equal((opened[0]!.payload as { increasePct: number }).increasePct, 200);
  // still open: no second event
  await router.route(routeRequest(), ctx);
  assert.equal(events.events.filter((e) => e.eventType === 'model.circuit_opened').length, 1);
  // a decision on the changed route is refused at invoke (re-validated): no call at the new price
  const mainDecision = { ...(d as Ok), routeId: 'main', provider: 'scripted', model: 'main-model', continuationCompatibilityClass: 'cc:main' };
  const refused = await router.invoke({ decision: mainDecision, call: { messages: [{ role: 'user', content: 'x' }] }, ctx }, routeRequest());
  assert.equal(refused.ok, false);
  // back within the guard: closed
  observed = {};
  assert.equal(((await router.route(routeRequest(), ctx)) as Ok).routeId, 'main');
  const closed = events.events.filter((e) => e.eventType === 'model.circuit_closed');
  assert.equal((closed.at(-1)!.payload as { reason: string }).reason, 'price_change_cleared');
  assert.throws(() => createModelRouter({ ...deps, catalog, providers, circuitBreaker: { priceGuard: { maxIncreasePct: -1 } } }), /maxIncreasePct must be a finite number ≥ 0/);
});

test('A[1]: the prices file is re-read when it changes, a broken edit keeps the last good prices, updates are atomic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ht-prices-'));
  try {
    const file = join(dir, 'state', 'model-prices.json');
    const deps = testDeps();
    const source = createFilePriceSource(file, { logger: deps.logger });
    assert.deepEqual(await source.current(), {}, 'no file: no observed prices');
    await updatePricesFile(file, 'main', { inputPerMillionUsd: 2, outputPerMillionUsd: 8, source: 'operator' });
    assert.deepEqual(await source.current(), { main: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, source: 'operator' } });
    await updatePricesFile(file, 'other', { inputPerMillionUsd: 1, outputPerMillionUsd: 1 });
    assert.deepEqual(Object.keys(await source.current()).sort(), ['main', 'other']);
    await writeFile(file, '{ broken');
    assert.deepEqual(Object.keys(await source.current()).sort(), ['main', 'other'], 'a broken edit keeps the last good prices');
    await updatePricesFile(file, 'main', undefined).catch(() => undefined); // unreadable file: the update refuses
    await writeFile(file, JSON.stringify({ version: 1, prices: {} }));
    assert.deepEqual(await source.current(), {});
    assert.deepEqual(await readPricesFile(join(dir, 'missing.json')), { version: 1, prices: {} });
    assert.throws(() => parsePricesFile({ version: 1, prices: { r: { inputPerMillionUsd: -1, outputPerMillionUsd: 1 } } }), /inputPerMillionUsd and outputPerMillionUsd must be finite numbers ≥ 0/);
    await assert.rejects(updatePricesFile(file, 'r', { inputPerMillionUsd: Number.NaN, outputPerMillionUsd: 1 }), /finite numbers/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('coverage[7]: eval trials become per-route, per-role scores (Laplace, minimum trials), validated on read', () => {
  const routes = (role: string, routeId: string) => [{ role, routeId, calls: 3 }];
  const trials = [
    { result: 'pass', modelRoutes: routes('executor', 'fast') },
    { result: 'pass', modelRoutes: routes('executor', 'fast') },
    { result: 'fail', modelRoutes: routes('executor', 'fast') },
    { result: 'infra_error', modelRoutes: routes('executor', 'fast') },
    { result: 'pass', modelRoutes: [...routes('lead', 'big'), { role: 'executor', routeId: 'idle', calls: 0 }] },
  ];
  const out = deriveRouteScores({ suiteId: 'core', revision: 'r1', trials }, { minTrials: 3, derivedAt: '2026-10-08T00:00:00.000Z' });
  assert.deepEqual(out.scores, { fast: { executor: 0.6 } }, '(2 + 1) / (3 + 2); big/lead has 1 trial (< min), idle served nothing');
  assert.equal(out.source?.trials, 4);
  assert.equal(out.source?.suiteId, 'core');
  assert.match(out.source!.inputDigest!, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseRouteScoresFile(out).scores, out.scores);
  assert.throws(() => parseRouteScoresFile({ version: 1, scores: { r: { lead: 1.5 } } }), /scores\.r\.lead must be a number in \[0, 1\]/);
  assert.throws(() => deriveRouteScores({ trials: [] }, { minTrials: 0 }), /minTrials must be an integer ≥ 1/);
});
