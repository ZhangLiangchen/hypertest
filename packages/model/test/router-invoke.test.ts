import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import { InMemoryEventSink, type ChatMessage, type DomainEventSink, type ModelPolicy } from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  ModelCatalog,
  OpenAICompatibleProvider,
  ProviderRegistry,
  ScriptedProvider,
  createModelRouter,
  type InvokeRequest,
  type ModelCapabilityProfile,
  type RouteDecision,
  type RouteRequest,
  type ScriptedBrain,
  type StreamDelta,
} from '../src/index.ts';
import { profile, routeRequest, startMockServer, writeSse } from './helpers.ts';

const ctx = eventCtx('run_inv', { correlationId: 'corr_inv', agentId: 'agt_1', workItemId: 'wi_9' });
const okText: ScriptedBrain = () => ({ text: 'done', usage: { inputTokens: 1000, outputTokens: 500 } });

function setup(profiles: ModelCapabilityProfile[], brains: Record<string, ScriptedBrain>) {
  const providers = Object.fromEntries(Object.entries(brains).map(([id, brain]) => [id, new ScriptedProvider({ providerId: id, brain })]));
  const registry = new ProviderRegistry(Object.values(providers));
  const catalog = new ModelCatalog(profiles);
  const events = new InMemoryEventSink();
  const router = createModelRouter({ ...testDeps(), catalog, providers: registry, events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  return { router, providers, events, catalog, registry };
}

async function decide(router: ReturnType<typeof createModelRouter>, req: RouteRequest): Promise<Extract<RouteDecision, { ok: true }>> {
  const d = await router.route(req, ctx);
  assert.equal(d.ok, true);
  return d as Extract<RouteDecision, { ok: true }>;
}

function invokeReq(decision: Extract<RouteDecision, { ok: true }>, extra: Partial<InvokeRequest> = {}): InvokeRequest {
  return { decision, call: { messages: [{ role: 'user', content: 'go' }] }, ctx, ...extra };
}

function failing(code: 'timeout' | 'rate_limited' | 'unavailable' | 'provider_error', times = Infinity): ScriptedBrain {
  return (_req, { callIndex }) => (callIndex < times ? { error: code, message: `${code} #${callIndex}` } : { text: 'recovered' });
}

const three = [
  profile({ routeId: 'primary', provider: 'pa', quality: { default: 0.9 }, costPerMillionInputUsd: 2, costPerMillionOutputUsd: 8 }),
  profile({ routeId: 'secondary', provider: 'pb', quality: { default: 0.8 } }),
  profile({ routeId: 'tertiary', provider: 'pc', quality: { default: 0.7 } }),
];

test('invoke: calls the decided route with decision model/effort, policy temperature, clamped max tokens, merged extra', async () => {
  const ps = [profile({ routeId: 'primary', provider: 'pa', model: 'm-primary', maxOutputTokens: 2048, reasoningEffort: 'medium', extra: { top_p: 0.9, seed: 1 } })];
  const { router, providers, events } = setup(ps, { pa: okText });
  const rq = routeRequest({}, { temperature: 0.2 });
  const decision = await decide(router, rq);
  const out = await router.invoke(invokeReq(decision, { call: { messages: [{ role: 'user', content: 'go' }], maxOutputTokens: 99_999, extra: { seed: 7 } } }), rq);
  assert.equal(out.ok, true);
  const sent = providers['pa']!.requests[0]!;
  assert.equal(sent.model, 'm-primary');
  assert.equal(sent.reasoningEffort, 'medium');
  assert.equal(sent.temperature, 0.2);
  assert.equal(sent.maxOutputTokens, 2048);
  assert.deepEqual(sent.extra, { top_p: 0.9, seed: 7 });
  if (out.ok) {
    assert.equal(out.attempts, 1);
    assert.equal(out.routeId, 'primary');
    // Cost filled from catalog prices when the provider reports none (1000 in × $1/M + 500 out × $4/M).
    assert.equal(out.response.usage.costUsd, (1000 * 1 + 500 * 4) / 1e6);
  }
  const inv = events.ofType('model.invoked');
  assert.equal(inv.length, 1);
  const p = inv[0]!.payload as Record<string, unknown>;
  assert.equal(p['ok'], true);
  assert.equal(p['routeId'], 'primary');
  assert.equal(p['attempts'], 1);
  assert.deepEqual(p['usage'], { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, costUsd: 0.003 });
  assert.equal(inv[0]!.workItemId, 'wi_9');
  assert.equal(inv[0]!.correlationId, 'corr_inv');
});

test('invoke: opaque reasoning is replayed only to a route with the same continuation class', async () => {
  const ps = [profile({ routeId: 'claude', provider: 'pa', continuationCompatibilityClass: 'anthropic:m1' })];
  const { router, providers } = setup(ps, { pa: okText });
  const rq = routeRequest();
  const decision = await decide(router, rq);
  const messages: ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }], reasoning: { text: 'r1', opaque: { compatibilityClass: 'anthropic:m1', data: ['same'] } } },
    { role: 'assistant', content: [{ type: 'text', text: 'a2' }], reasoning: { text: 'r2', opaque: { compatibilityClass: 'openai:o3', data: ['foreign'] } } },
  ];
  await router.invoke(invokeReq(decision, { call: { messages } }), rq);
  const sent = providers['pa']!.requests[0]!.messages;
  assert.deepEqual(sent[1], messages[1]);
  assert.deepEqual(sent[2], { role: 'assistant', content: [{ type: 'text', text: 'a2' }], reasoning: { text: 'r2' } });
});

test('invoke: retryable error retries the SAME route, then succeeds (no fallback)', async () => {
  const { router, providers, events } = setup(three, { pa: failing('rate_limited', 1), pb: okText, pc: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(providers['pa']!.callCount, 2);
  assert.equal(providers['pb']!.callCount, 0);
  assert.equal(events.ofType('model.fallback').length, 0);
});

test('invoke: maxAttempts bounds same-route retries', async () => {
  const { router, providers } = setup(three, { pa: failing('unavailable'), pb: okText, pc: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq), { maxAttempts: 3 }), rq);
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 3);
  assert.equal(providers['pa']!.callCount, 3);
});

test('invoke (revalidated): exhausted retries yield a re-validated fallback for the NEXT boundary; the fallback is never called mid-invoke', async () => {
  const { router, providers, events } = setup(three, { pa: failing('unavailable'), pb: okText, pc: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.deepEqual(out.error, { code: 'unavailable', message: 'unavailable #1', retryable: true });
  assert.equal(out.attempts, 2);
  assert.equal(out.fallback?.routeId, 'secondary');
  assert.deepEqual(out.fallback?.fallbackChain, ['tertiary']);
  assert.deepEqual(out.fallback?.rejected, [{ routeId: 'primary', stage: 'excluded', reason: 'route already failed in this epoch sequence' }]);
  assert.equal(providers['pb']!.callCount, 0, 'fallback route must not be called within the same invoke');
  assert.equal(providers['pc']!.callCount, 0);
  assert.deepEqual(events.events.map((e) => e.eventType), ['model.routed', 'model.invoked', 'model.routed', 'model.fallback']);
  assert.deepEqual(events.ofType('model.fallback')[0]!.payload, { from: 'primary', to: 'secondary', reason: 'unavailable', policy: 'revalidated', excludeRoutes: ['primary'], snapshotId: 'ctx_1' });
});

test('invoke (fail_closed): no fallback is offered and no other route is considered', async () => {
  const { router, providers, events } = setup(three, { pa: failing('timeout'), pb: okText, pc: okText });
  const rq = routeRequest({}, { fallback: 'fail_closed' });
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'timeout');
  assert.equal(out.fallback, undefined);
  assert.equal(providers['pb']!.callCount + providers['pc']!.callCount, 0);
  assert.deepEqual(events.events.map((e) => e.eventType), ['model.routed', 'model.invoked', 'model.fallback']);
  assert.deepEqual(events.ofType('model.fallback')[0]!.payload, { from: 'primary', to: null, reason: 'timeout', policy: 'fail_closed', excludeRoutes: ['primary'], snapshotId: 'ctx_1' });
});

test('invoke: provider_error (bad request) is neither retried nor masked by a fallback model', async () => {
  const { router, providers, events } = setup(three, { pa: failing('provider_error'), pb: okText, pc: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.deepEqual(out.error, { code: 'provider_error', message: 'provider_error #0', retryable: false });
  assert.equal(out.attempts, 1);
  assert.equal(providers['pa']!.callCount, 1);
  assert.equal(out.fallback, undefined);
  assert.equal(events.ofType('model.fallback').length, 0);
});

test('fallback re-validates capabilities: a cheaper, better route lacking tool_use is skipped', async () => {
  const ps = [
    profile({ routeId: 'primary', provider: 'pa', quality: { default: 0.9 } }),
    profile({ routeId: 'no_tools', provider: 'pb', capabilities: ['reasoning'], quality: { default: 0.85 }, costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 }),
    profile({ routeId: 'tools', provider: 'pc', quality: { default: 0.6 }, costPerMillionInputUsd: 20 }),
  ];
  const { router } = setup(ps, { pa: failing('unavailable'), pb: okText, pc: okText });
  const rq = routeRequest({ requiredCapabilities: ['tool_use'] });
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.fallback?.routeId, 'tools');
  assert.deepEqual(out.fallback?.rejected.map((r) => [r.routeId, r.stage]), [['primary', 'excluded'], ['no_tools', 'capability']]);
});

test('fallback re-validates security: restricted data never falls back to a cloud route', async () => {
  const ps = [
    profile({ routeId: 'local', provider: 'pa', maxDataClassification: 'restricted', quality: { default: 0.5 } }),
    profile({ routeId: 'cloud', provider: 'pb', maxDataClassification: 'confidential', quality: { default: 0.99 }, costPerMillionInputUsd: 0 }),
  ];
  const { router, providers, events } = setup(ps, { pa: failing('unavailable'), pb: okText });
  const rq = routeRequest({ dataClassification: 'restricted' });
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.fallback, undefined);
  assert.equal(providers['pb']!.callCount, 0);
  const fb = events.ofType('model.fallback')[0]!.payload as Record<string, unknown>;
  assert.equal(fb['to'], null);
  const rerouted = events.ofType('model.routed')[1]!.payload as Record<string, unknown>;
  assert.deepEqual(rerouted['rejected'], [
    { routeId: 'local', stage: 'excluded', reason: 'route already failed in this epoch sequence' },
    { routeId: 'cloud', stage: 'security', reason: 'route accepts data up to confidential; request carries restricted' },
  ]);
});

test('fallback accumulates earlier failures (excludeRoutes) and respects reviewer independence', async () => {
  const { router } = setup(three, { pa: okText, pb: failing('unavailable'), pc: okText });
  const rq = routeRequest({ excludeRoutes: ['primary'], providersToAvoid: ['pc'] }, { independentFromRoles: ['executor'] });
  const decision = await decide(router, rq);
  assert.equal(decision.routeId, 'secondary');
  const out = await router.invoke(invokeReq(decision), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.fallback, undefined, 'primary already failed and tertiary shares the executor provider');
});

test('invoke: caller cancellation is not retried and never triggers a fallback', async () => {
  const ctrl = new AbortController();
  const brain: ScriptedBrain = () => {
    ctrl.abort();
    return new Promise(() => undefined);
  };
  const { router, providers, events } = setup(three, { pa: brain, pb: okText, pc: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq), { call: { messages: [{ role: 'user', content: 'go' }], signal: ctrl.signal } }), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'cancelled');
  assert.equal(out.attempts, 1);
  assert.equal(out.fallback, undefined);
  assert.equal(providers['pa']!.callCount, 1);
  assert.equal(events.ofType('model.fallback').length, 0);
});

test('invoke: a decision from another catalog revision is refused (precondition_failed) and re-routed on the current catalog', async () => {
  const { router: oldRouter } = setup(three, { pa: okText, pb: okText, pc: okText });
  const rq = routeRequest();
  const stale = await decide(oldRouter, rq);
  const updated = three.map((p) => (p.routeId === 'tertiary' ? { ...p, quality: { default: 0.95 } } : p));
  const { router, providers } = setup(updated, { pa: okText, pb: okText, pc: okText });
  const out = await router.invoke(invokeReq(stale), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'precondition_failed');
  assert.equal(out.attempts, 0);
  assert.equal(providers['pa']!.callCount, 0);
  assert.equal(out.fallback?.routeId, 'tertiary');
});

test('invoke: streaming deltas of the single invoked route are forwarded', async () => {
  const { router } = setup(three, { pa: () => ({ text: 'hi', toolCalls: [{ name: 'fs.read', arguments: { path: 'a' } }] }), pb: okText, pc: okText });
  const rq = routeRequest();
  const deltas: StreamDelta[] = [];
  const out = await router.invoke(invokeReq(await decide(router, rq), { onDelta: (d) => deltas.push(d) }), rq);
  assert.equal(out.ok, true);
  assert.deepEqual(deltas, [
    { type: 'text', text: 'hi' },
    { type: 'tool_call_start', id: 'call_1', name: 'fs.read' },
    { type: 'tool_call_args', id: 'call_1', text: '{"path":"a"}' },
  ]);
});

test('invoke: policy with no fallback field defaults to revalidated fallback', async () => {
  const policy: ModelPolicy = {};
  const { router } = setup(three, { pa: failing('rate_limited'), pb: okText, pc: okText });
  const rq = routeRequest({}, policy);
  const out = await router.invoke(invokeReq(await decide(router, rq), { maxAttempts: 1 }), rq);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.attempts, 1);
    assert.equal(out.fallback?.routeId, 'secondary');
  }
});

// ----------------------------------------------------------------------------- adversarial review fixes

test('invoke: an event-sink failure after a SUCCESSFUL call is a fault, never reported as a model failure with a fallback (I10)', async () => {
  const inner = new InMemoryEventSink();
  let failInvokedOnce = true;
  const sink: DomainEventSink = {
    emit: async (evs) => {
      if (failInvokedOnce && evs.some((e) => e.eventType === 'model.invoked')) {
        failInvokedOnce = false;
        throw new HypertestError('unavailable', 'event store down');
      }
      return inner.emit(evs);
    },
  };
  const providers = { pa: new ScriptedProvider({ providerId: 'pa', brain: okText }), pb: new ScriptedProvider({ providerId: 'pb', brain: okText }), pc: new ScriptedProvider({ providerId: 'pc', brain: okText }) };
  const router = createModelRouter({ ...testDeps(), catalog: new ModelCatalog(three), providers: new ProviderRegistry(Object.values(providers)), events: sink, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  const rq = routeRequest();
  const decision = await decide(router, rq);
  await assert.rejects(router.invoke(invokeReq(decision), rq), (e: unknown) => e instanceof HypertestError && e.code === 'unavailable' && e.message === 'event store down');
  assert.equal(providers.pa.callCount, 1, 'the successful call is not retried');
  assert.equal(providers.pb.callCount + providers.pc.callCount, 0);
  assert.deepEqual(inner.events.map((e) => e.eventType), ['model.routed'], 'no false model.invoked(ok:false), re-route or model.fallback');
});

test('invoke re-validates the decided route against the CURRENT request: escalated data classification never reaches a cloud route', async () => {
  const ps = [
    profile({ routeId: 'cloud', provider: 'pa', maxDataClassification: 'confidential', quality: { default: 0.95 } }),
    profile({ routeId: 'local', provider: 'pb', maxDataClassification: 'restricted', quality: { default: 0.5 } }),
  ];
  const { router, providers, events } = setup(ps, { pa: okText, pb: okText });
  const decision = await decide(router, routeRequest({ dataClassification: 'internal' }));
  assert.equal(decision.routeId, 'cloud');
  // The context now carries restricted data (e.g. a secret was read in the previous turn).
  const escalated = routeRequest({ dataClassification: 'restricted' });
  const out = await router.invoke(invokeReq(decision), escalated);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'precondition_failed');
  assert.equal(out.error.retryable, false);
  assert.match(out.error.message, /^route cloud is not eligible for this request \(security\): route accepts data up to confidential; request carries restricted$/);
  assert.equal(out.attempts, 0);
  assert.equal(providers['pa']!.callCount, 0, 'restricted data must never be sent to the cloud route');
  assert.equal(out.fallback?.routeId, 'local');
  assert.equal(providers['pb']!.callCount, 0, 'the fallback is for the next boundary, not called now');
  const inv = events.ofType('model.invoked').at(-1)!.payload as Record<string, unknown>;
  assert.deepEqual(inv['error'], { code: 'precondition_failed', message: out.error.message, retryable: false });
});

test('invoke re-validation under fail_closed: escalated action risk or a newly avoided provider refuses the call and offers no fallback', async () => {
  const ps = [
    profile({ routeId: 'weak', provider: 'pa', maxActionRisk: 'medium', quality: { default: 0.95 } }),
    profile({ routeId: 'strong', provider: 'pb', maxActionRisk: 'critical', quality: { default: 0.5 } }),
  ];
  const { router, providers } = setup(ps, { pa: okText, pb: okText });
  const policy: ModelPolicy = { fallback: 'fail_closed' };
  const decision = await decide(router, routeRequest({ actionRisk: 'low' }, policy));
  assert.equal(decision.routeId, 'weak');
  let out = await router.invoke(invokeReq(decision), routeRequest({ actionRisk: 'high' }, policy));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.code, 'precondition_failed');
    assert.equal(out.fallback, undefined);
  }
  out = await router.invoke(invokeReq(decision), routeRequest({ actionRisk: 'low', providersToAvoid: ['pa'] }, policy));
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error.message, /must be avoided \(independence\)/);
  assert.equal(providers['pa']!.callCount + providers['pb']!.callCount, 0);
  // Unchanged request: the same decision is still honoured.
  out = await router.invoke(invokeReq(decision), routeRequest({ actionRisk: 'low' }, policy));
  assert.equal(out.ok, true);
});

test('invoke re-validation: a decided route listed in excludeRoutes, or whose context window no longer fits, is refused', async () => {
  const ps = [profile({ routeId: 'small', provider: 'pa', contextWindow: 20_000, maxOutputTokens: 4096, quality: { default: 0.9 } }), profile({ routeId: 'big', provider: 'pb', contextWindow: 1_000_000 })];
  const { router, providers } = setup(ps, { pa: okText, pb: okText });
  const decision = await decide(router, routeRequest({ contextTokensEstimate: 1000 }));
  assert.equal(decision.routeId, 'small');
  let out = await router.invoke(invokeReq(decision), routeRequest({ contextTokensEstimate: 1000, excludeRoutes: ['small'] }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error.code, 'precondition_failed');
  out = await router.invoke(invokeReq(decision), routeRequest({ contextTokensEstimate: 50_000 }));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error.message, /not eligible for this request \(capability\): context window 20000 < 54096/);
    assert.equal(out.fallback?.routeId, 'big');
  }
  assert.equal(providers['pa']!.callCount, 0);
});

test('invoke: a non-finite maxAttempts is rejected up front (never zero calls, never unbounded retries)', async () => {
  const { router, providers, events } = setup(three, { pa: failing('unavailable'), pb: okText, pc: okText });
  const rq = routeRequest();
  const decision = await decide(router, rq);
  for (const maxAttempts of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(router.invoke(invokeReq(decision, { maxAttempts }), rq), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument', String(maxAttempts));
  }
  assert.equal(providers['pa']!.callCount, 0);
  assert.deepEqual(events.events.map((e) => e.eventType), ['model.routed']);
});

test('invoke: a forged decision (continuation class differs from the catalog) is refused before any call', async () => {
  const ps = [profile({ routeId: 'claude', provider: 'pa', continuationCompatibilityClass: 'anthropic:m1' })];
  const { router, providers } = setup(ps, { pa: okText });
  const rq = routeRequest();
  const decision = await decide(router, rq);
  const forged = { ...decision, continuationCompatibilityClass: 'openai:o3' };
  const out = await router.invoke(invokeReq(forged), rq);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error.code, 'precondition_failed');
  assert.equal(providers['pa']!.callCount, 0);
});

test('invoke: a response whose opaque reasoning class differs from the route declaration is flagged (catalog misconfiguration)', async () => {
  const ps = [profile({ routeId: 'claude', provider: 'pa', continuationCompatibilityClass: 'anthropic' })];
  const deps = testDeps();
  const brain: ScriptedBrain = () => ({ text: 'x' });
  const provider = new ScriptedProvider({ providerId: 'pa', brain });
  // Simulate a provider that tags opaque reasoning with its own class (as AnthropicProvider does: anthropic:<model>).
  const tagging = { providerId: 'pa', adapterInfo: provider.adapterInfo, complete: async (r: Parameters<ScriptedProvider['complete']>[0]) => {
    const res = await provider.complete(r);
    res.message.reasoning = { text: 't', opaque: { compatibilityClass: `anthropic:${r.model}`, data: [] } };
    return res;
  } };
  const router = createModelRouter({ ...deps, catalog: new ModelCatalog(ps), providers: new ProviderRegistry([tagging]) });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq)), rq);
  assert.equal(out.ok, true);
  const warn = deps.logger.entries.find((e) => e.level === 'warn');
  assert.deepEqual(warn?.fields, { routeId: 'claude', declaredClass: 'anthropic', responseClass: 'anthropic:claude-model' });
});

test('invoke: a throwing onDelta callback (HTTP provider) is neither retried nor answered with a fallback route', async () => {
  const server = await startMockServer((_req, res) => writeSse(res, [{ id: 'x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
  try {
    const events = new InMemoryEventSink();
    const pb = new ScriptedProvider({ providerId: 'pb', brain: okText });
    const pc = new ScriptedProvider({ providerId: 'pc', brain: okText });
    const registry = new ProviderRegistry([new OpenAICompatibleProvider({ providerId: 'pa', baseUrl: server.url }), pb, pc]);
    const router = createModelRouter({ ...testDeps(), catalog: new ModelCatalog(three), providers: registry, events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    const rq = routeRequest();
    const out = await router.invoke(invokeReq(await decide(router, rq), { onDelta: () => { throw new Error('ui bug'); } }), rq);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.code, 'internal');
    assert.equal(out.error.retryable, false);
    assert.equal(out.attempts, 1);
    assert.equal(out.fallback, undefined);
    assert.equal(server.requests.length, 1, 'not retried');
    assert.equal(pb.callCount + pc.callCount, 0);
    assert.equal(events.ofType('model.fallback').length, 0);
  } finally {
    await server.close();
  }
});

test('fallback re-validates TOOL COMPATIBILITY from the call itself (I3): tools / structured output / images used by the call must be served by the fallback', async () => {
  const ps = [
    profile({ routeId: 'primary', provider: 'pa', capabilities: ['tool_use', 'vision'], structuredOutput: 'native', quality: { default: 0.9 } }),
    profile({ routeId: 'no_tools', provider: 'pb', capabilities: ['vision'], structuredOutput: 'native', quality: { default: 0.85 } }),
    profile({ routeId: 'no_struct', provider: 'pb', capabilities: ['tool_use', 'vision'], structuredOutput: 'none', quality: { default: 0.8 } }),
    profile({ routeId: 'blind', provider: 'pb', capabilities: ['tool_use'], structuredOutput: 'native', quality: { default: 0.75 } }),
    profile({ routeId: 'ok', provider: 'pc', capabilities: ['tool_use', 'vision'], structuredOutput: 'prompted', quality: { default: 0.5 } }),
  ];
  const { router, events } = setup(ps, { pa: failing('unavailable'), pb: okText, pc: okText });
  // The caller did not declare requirements in the route request, but the call uses tools, a response format and an image.
  const rq = routeRequest({ requiredCapabilities: [] });
  const decision = await decide(router, rq);
  assert.equal(decision.routeId, 'primary');
  const call = {
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image' as const, mimeType: 'image/png', dataBase64: 'AAAA' }] }],
    tools: [{ name: 'fs.read', description: 'r', inputSchema: { type: 'object' } }],
    responseFormat: { type: 'json_schema' as const, name: 'v', schema: { type: 'object' } },
  };
  const out = await router.invoke(invokeReq(decision, { call }), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.fallback?.routeId, 'ok');
  assert.deepEqual(out.fallback?.rejected.map((r) => [r.routeId, r.stage]), [['primary', 'excluded'], ['no_tools', 'capability'], ['no_struct', 'capability'], ['blind', 'capability']]);
  assert.equal(events.ofType('model.routed').length, 2);
});

test('fallback tool compatibility only requires what the failed route itself declared (an under-declared catalog is not made unroutable)', async () => {
  const ps = [
    profile({ routeId: 'primary', provider: 'pa', capabilities: [], quality: { default: 0.9 } }),
    profile({ routeId: 'secondary', provider: 'pb', capabilities: [], quality: { default: 0.8 } }),
  ];
  const { router } = setup(ps, { pa: failing('unavailable'), pb: okText });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq), { call: { messages: [{ role: 'user', content: 'go' }], tools: [{ name: 't', description: '', inputSchema: {} }] } }), rq);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.fallback?.routeId, 'secondary');
});

test('invoke: a caller abort during the retry backoff is reported as cancelled (whatever the abort reason) and never answered with a fallback', async () => {
  const ctrl = new AbortController();
  const brain: ScriptedBrain = () => {
    // The caller's own turn deadline fires while the router is backing off before attempt 2.
    setTimeout(() => ctrl.abort(new HypertestError('timeout', 'turn deadline exceeded')), 5);
    return { error: 'unavailable', message: 'down' };
  };
  const events = new InMemoryEventSink();
  const pa = new ScriptedProvider({ providerId: 'pa', brain });
  const pb = new ScriptedProvider({ providerId: 'pb', brain: okText });
  const pc = new ScriptedProvider({ providerId: 'pc', brain: okText });
  const router = createModelRouter({ ...testDeps(), catalog: new ModelCatalog(three), providers: new ProviderRegistry([pa, pb, pc]), events, retry: { baseDelayMs: 200, maxDelayMs: 200 } });
  const rq = routeRequest();
  const out = await router.invoke(invokeReq(await decide(router, rq), { call: { messages: [{ role: 'user', content: 'go' }], signal: ctrl.signal } }), rq);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, 'cancelled');
  assert.equal(out.error.retryable, false);
  assert.equal(out.fallback, undefined);
  assert.equal(pa.callCount, 1);
  assert.equal(events.ofType('model.fallback').length, 0);
});
