import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import type { ChatMessage, EventContext, ModelPolicy } from '@hypertest/domain';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ModelCapabilityProfile, type ModelRouter, type ScriptedBrain } from '@hypertest/model';
import { createTestDatabase } from '@hypertest/store';
import {
  FakeContextProvider, FakeDispatcher, NativeEngine, createAgentRepository, createEpochManager, createModelInvoker, createSessionStore, runtimeMigrations, safeEpochTurn,
  type BudgetPort, type EpochManager, type InvokerDeps, type ModelInvoker, type OkRouteDecision, type SessionStore, type TurnLimits,
} from '../src/index.ts';
import { baseDeps } from './helpers.ts';

const code = (c: string) => (e: unknown) => isHypertestError(e, c as never);
const LIMITS: TurnLimits = { maxToolCallsPerTurn: 8, repetitionThreshold: 3 };

function profile(routeId: string, provider: string, model: string, cls: string, extra: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    routeId,
    provider,
    model,
    capabilities: ['tool_use', 'structured_output'],
    structuredOutput: 'native',
    reasoning: 'opaque',
    contextWindow: 200_000,
    maxOutputTokens: 2048,
    continuationCompatibilityClass: cls,
    maxDataClassification: 'confidential',
    quality: { default: 0.8 },
    toolReliability: 0.9,
    costPerMillionInputUsd: 1,
    costPerMillionOutputUsd: 4,
    typicalLatencyMs: 100,
    maxActionRisk: 'high',
    enabled: true,
    ...extra,
  };
}

class RecordingBudget implements BudgetPort {
  readonly reserved: Array<{ scopes: string[]; amounts: { tokens?: number; costUsd?: number }; reason: string }> = [];
  readonly settled: Array<{ id: string; actual: { tokens?: number; costUsd?: number } }> = [];
  readonly released: string[] = [];
  exhausted = false;
  #n = 0;
  async reserve(scopes: string[], amounts: { tokens?: number; costUsd?: number }, reason: string) {
    if (this.exhausted) return { ok: false as const, exhausted: { scope: scopes[0], remaining: 0 } };
    this.reserved.push({ scopes, amounts, reason });
    return { ok: true as const, reservationId: `res_${++this.#n}` };
  }
  async settle(id: string, actual: { tokens?: number; costUsd?: number }) {
    this.settled.push({ id, actual });
  }
  async release(id: string) {
    this.released.push(id);
  }
}

describe('ModelEpochs and the ModelInvoker (I3)', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let deps: ReturnType<typeof baseDeps>;
  let sessions: SessionStore;
  let epochs: EpochManager;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps('2026-05-01T00:00:00.000Z');
    sessions = createSessionStore({ ...deps, db });
    epochs = createEpochManager({ ...deps, db, sessions });
  });
  after(async () => dispose());

  async function newSession(role = 'executor'): Promise<{ sessionId: string; runId: string; agentId: string; ctx: EventContext }> {
    n += 1;
    const runId = `run_e${n}`;
    const agentId = `ag_e${n}`;
    const sessionId = `sess_e${n}`;
    await sessions.create({ sessionId, runId, agentId, engineKind: 'native' });
    await sessions.appendTranscript(sessionId, [{ turn: 0, message: { role: 'user', content: 'run the smoke tests' } }]);
    await createAgentRepository({ ...deps, db }).create({
      agentId, runId, role, workItemId: `wi_e${n}`, depth: 0, engineKind: 'native', sessionId, status: 'active', capabilityId: `cap_e${n}`, continuable: false, background: false,
      createdAt: deps.clock.isoNow(), updatedAt: deps.clock.isoNow(),
    });
    return { sessionId, runId, agentId, ctx: { runId, correlationId: `corr_e${n}`, actorId: `agent:${agentId}`, agentId } };
  }

  function stack(brains: Record<string, ScriptedBrain>, profiles?: ModelCapabilityProfile[]) {
    const catalog = new ModelCatalog(profiles ?? [profile('route_a', 'prov_a', 'model-a', 'cls-a'), profile('route_b', 'prov_b', 'model-b', 'cls-b')]);
    const provA = new ScriptedProvider({ providerId: 'prov_a', brains: { 'model-a': brains['model-a'] ?? (() => ({ text: 'a' })) } });
    const provB = new ScriptedProvider({ providerId: 'prov_b', brains: { 'model-b': brains['model-b'] ?? (() => ({ text: 'b' })) } });
    const router = createModelRouter({ ...deps, catalog, providers: new ProviderRegistry([provA, provB]), events: deps.events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    return { router, provA, provB };
  }

  function invokerFor(s: { sessionId: string; runId: string; agentId: string; ctx: EventContext }, router: ModelRouter, extra: Partial<InvokerDeps> = {}, policy: ModelPolicy = { preferredRoutes: ['route_a', 'route_b'] }): ModelInvoker {
    return createModelInvoker({
      ...deps,
      router,
      epochs,
      sessions,
      budgetScopes: [`run/${s.runId}`],
      agent: { agentId: s.agentId, runId: s.runId, role: 'executor', sessionId: s.sessionId },
      policy,
      taskType: 'execute_tests',
      dataClassification: 'internal',
      actionRisk: 'low',
      maxOutputTokens: 512,
      eventContext: s.ctx,
      ...extra,
    });
  }

  function engineHost(s: { sessionId: string; runId: string; ctx: EventContext }, model: ModelInvoker, tools = new FakeDispatcher([{ name: 'probe' }])) {
    return { model, tools, context: new FakeContextProvider({ tools: () => tools.definitions(), runId: s.runId }), sessions, eventContext: s.ctx, events: deps.events };
  }

  const engine = () => new NativeEngine({ ...deps, sessions });
  const turn = (s: { sessionId: string }, h: ReturnType<typeof engineHost>, signal = new AbortController().signal) =>
    engine().runTurn({ session: { sessionId: s.sessionId, engineKind: 'native' }, host: h, limits: LIMITS, signal });

  test('safe boundary: no epoch starts while a turn has an unsettled response or at a turn other than the next boundary', async () => {
    assert.deepEqual(safeEpochTurn(undefined), { ok: true, turn: 1 });
    assert.deepEqual(safeEpochTurn({ turn: 3, status: 'started' }), { ok: true, turn: 3 });
    assert.deepEqual(safeEpochTurn({ turn: 3, status: 'boundary' }), { ok: true, turn: 4 });
    assert.equal(safeEpochTurn({ turn: 3, status: 'model_responded' }).ok, false);

    const s = await newSession();
    const base = { runId: s.runId, agentId: s.agentId, sessionId: s.sessionId, routeId: 'route_a', provider: 'prov_a', model: 'model-a', capabilityProfileRevision: 'mc_x', continuationCompatibilityClass: 'cls-a', contextSnapshotId: 'cs_1', switchReason: 'initial' as const };
    const e1 = await epochs.start({ ...base, startedAtTurn: 1 }, s.ctx);
    await sessions.beginTurn(s.sessionId, 1, {});
    // turn 1 begun, nothing produced: the boundary is still turn 1 (not 2)
    await assert.rejects(epochs.start({ ...base, startedAtTurn: 2, switchReason: 'manual' }, s.ctx), code('precondition_failed'));
    await sessions.recordModelResponse(s.sessionId, 1, { role: 'assistant', content: [], toolCalls: [{ id: 'c', name: 'deploy', arguments: {} }] }, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, [{ toolCallId: 'c', name: 'deploy', invocationId: `${s.sessionId}:1:c` }]);
    // the injected fault: a model switch while deploy() is unsettled
    for (const t of [1, 2]) {
      await assert.rejects(epochs.start({ ...base, routeId: 'route_b', provider: 'prov_b', model: 'model-b', continuationCompatibilityClass: 'cls-b', startedAtTurn: t, switchReason: 'unavailable' }, s.ctx), code('precondition_failed'));
    }
    assert.deepEqual((await epochs.list(s.sessionId)).map((e) => e.epochId), [e1.epochId], 'no epoch was recorded by the refused starts');
    await sessions.settleToolCall(s.sessionId, 1, 'c', { result: { role: 'tool', toolCallId: 'c', toolName: 'deploy', content: 'ok' } });
    await sessions.completeTurn(s.sessionId, 1, 'completed');
    await assert.rejects(epochs.start({ ...base, startedAtTurn: 3, switchReason: 'manual' }, s.ctx), code('precondition_failed'));
    await assert.rejects(epochs.start({ ...base, startedAtTurn: 2, switchReason: 'manual', previousEpochId: 'ep_stale' }, s.ctx), code('conflict'));
    const e2 = await epochs.start({ ...base, routeId: 'route_b', provider: 'prov_b', model: 'model-b', continuationCompatibilityClass: 'cls-b', startedAtTurn: 2, switchReason: 'manual' }, s.ctx);
    assert.equal(e2.previousEpochId, e1.epochId);
    assert.equal((await epochs.current(s.sessionId))?.epochId, e2.epochId);
    assert.equal((await sessions.get(s.sessionId))?.currentEpochId, e2.epochId);
  });

  test('start validates identity and the decision it stores', async () => {
    const s = await newSession();
    const base = { runId: s.runId, agentId: s.agentId, sessionId: s.sessionId, routeId: 'route_a', provider: 'prov_a', model: 'model-a', capabilityProfileRevision: 'mc_x', continuationCompatibilityClass: 'cls-a', contextSnapshotId: 'cs_1', switchReason: 'initial' as const, startedAtTurn: 1 };
    await assert.rejects(epochs.start({ ...base, agentId: 'ag_other' }, s.ctx), code('invalid_argument'));
    await assert.rejects(epochs.start({ ...base, switchReason: 'whim' as never }, s.ctx), code('invalid_argument'));
    const wrong: OkRouteDecision = { ok: true, routeId: 'route_b', provider: 'prov_b', model: 'model-b', fallbackChain: [], selectedByPolicy: 'x', capabilityProfileRevision: 'mc_x', continuationCompatibilityClass: 'cls-b', rejected: [] };
    await assert.rejects(epochs.start(base, s.ctx, { decision: wrong }), code('invalid_argument'));
    await assert.rejects(epochs.start({ ...base, sessionId: 'sess_none' }, s.ctx), code('not_found'));
  });

  test('fallback happens only at the next turn: turn N fails on route A (boundary, no tool runs), turn N+1 runs route B in a new epoch', async () => {
    const s = await newSession();
    const { router, provA, provB } = stack({ 'model-a': () => ({ error: 'unavailable', message: 'A is down' }), 'model-b': () => ({ toolCalls: [{ name: 'probe', arguments: { n: 1 } }] }) });
    const invoker = invokerFor(s, router);
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const before = deps.events.events.length;

    const r1 = await turn(s, engineHost(s, invoker, tools));
    assert.equal(r1.status, 'boundary');
    assert.equal(r1.boundary, 'retry_next_turn');
    assert.equal(provA.callCount, 2, 'same-route retries only');
    assert.equal(provB.callCount, 0, 'never switched mid-turn');
    assert.equal(tools.calls.length, 0);
    const [first] = await epochs.list(s.sessionId);
    assert.equal(first?.routeId, 'route_a');
    assert.equal(first?.switchReason, 'initial');
    assert.equal(first?.startedAtTurn, 1);
    const pending = await epochs.pendingFallback!(s.sessionId);
    assert.equal(pending?.decision.routeId, 'route_b');
    assert.equal(pending?.reason, 'unavailable');
    assert.deepEqual(pending?.excludedRoutes, ['route_a']);
    assert.equal(pending?.fromEpochId, first?.epochId);

    const r2 = await turn(s, engineHost(s, invoker, tools));
    assert.equal(r2.status, 'continue');
    assert.equal(provB.callCount, 1);
    assert.equal(tools.calls.length, 1);
    const list = await epochs.list(s.sessionId);
    assert.equal(list.length, 2);
    assert.deepEqual(
      { route: list[1]!.routeId, previous: list[1]!.previousEpochId, reason: list[1]!.switchReason, turn: list[1]!.startedAtTurn, snapshot: list[1]!.contextSnapshotId },
      { route: 'route_b', previous: first!.epochId, reason: 'unavailable', turn: 2, snapshot: `cs_fake_${s.sessionId}_2` },
    );
    assert.equal(await epochs.pendingFallback!(s.sessionId), undefined, 'the fallback was consumed by the new epoch');
    const t2 = await sessions.getTurn(s.sessionId, 2);
    assert.equal(t2?.epochId, list[1]!.epochId);
    assert.equal(t2?.routeId, 'route_b');

    const started = deps.events.events.slice(before).filter((e) => e.eventType === 'model.epoch_started' && e.runId === s.runId);
    assert.deepEqual(started.map((e) => [(e.payload as { routeId: string }).routeId, (e.payload as { switchReason: string }).switchReason, (e.payload as { startedAtTurn: number }).startedAtTurn]), [['route_a', 'initial', 1], ['route_b', 'unavailable', 2]]);
    assert.equal(started[1]!.correlationId, s.ctx.correlationId);
    const fallbackEvents = deps.events.events.slice(before).filter((e) => e.eventType === 'model.fallback' && e.runId === s.runId);
    assert.deepEqual(fallbackEvents.map((e) => [(e.payload as { from: string }).from, (e.payload as { to: string }).to]), [['route_a', 'route_b']]);

    // the next turn stays in the same epoch
    await turn(s, engineHost(s, invoker, tools));
    assert.equal((await epochs.list(s.sessionId)).length, 2);
    assert.equal(provB.callCount, 2);
    assert.deepEqual(await epochs.providersUsedByRoles(s.runId, ['executor']), ['prov_a', 'prov_b']);
    assert.deepEqual(await epochs.providersUsedByRoles(s.runId, ['reviewer']), []);
  });

  test('routes that failed in the epoch sequence stay excluded: A → B → no eligible fallback ⇒ model_unavailable', async () => {
    const s = await newSession();
    const down: ScriptedBrain = () => ({ error: 'rate_limited' });
    const { router, provA, provB } = stack({ 'model-a': down, 'model-b': down });
    const invoker = invokerFor(s, router);
    const h = engineHost(s, invoker);
    assert.equal((await turn(s, h)).boundary, 'retry_next_turn');
    assert.equal((await epochs.pendingFallback!(s.sessionId))?.reason, 'rate_limit');
    const r2 = await turn(s, h);
    assert.equal(r2.status, 'boundary');
    assert.equal(r2.boundary, 'model_unavailable', 'A is not offered again as the fallback of B');
    assert.equal(provA.callCount, 2);
    assert.equal(provB.callCount, 2);
    assert.equal(await epochs.pendingFallback!(s.sessionId), undefined);
    const fb = deps.events.events.filter((e) => e.eventType === 'model.fallback' && e.runId === s.runId).at(-1);
    assert.deepEqual((fb?.payload as { excludeRoutes: string[] }).excludeRoutes, ['route_a', 'route_b']);
  });

  test('fail_closed policy: no fallback, the turn ends model_unavailable and no new epoch starts', async () => {
    const s = await newSession();
    const { router, provB } = stack({ 'model-a': () => ({ error: 'unavailable' }) });
    const invoker = invokerFor(s, router, {}, { preferredRoutes: ['route_a', 'route_b'], fallback: 'fail_closed' });
    const r = await turn(s, engineHost(s, invoker));
    assert.equal(r.boundary, 'model_unavailable');
    assert.equal(provB.callCount, 0);
    assert.equal((await epochs.list(s.sessionId)).length, 1);
    assert.equal(await epochs.pendingFallback!(s.sessionId), undefined);
  });

  test('no eligible route ⇒ model_unavailable before any epoch or budget reservation', async () => {
    const s = await newSession();
    const { router } = stack({}, [profile('route_a', 'prov_a', 'model-a', 'cls-a', { capabilities: [] })]);
    const budget = new RecordingBudget();
    const invoker = invokerFor(s, router, { budget });
    const r = await turn(s, engineHost(s, invoker));
    assert.equal(r.boundary, 'model_unavailable');
    assert.deepEqual(await epochs.list(s.sessionId), []);
    assert.deepEqual(budget.reserved, []);
  });

  test('budget: reserve estimate+maxOutput and estimated cost, settle actual usage; exhaustion ends the turn at a boundary without a model call', async () => {
    const s = await newSession();
    const { router, provA } = stack({ 'model-a': () => ({ text: 'ok', usage: { inputTokens: 100, outputTokens: 20 } }) });
    const budget = new RecordingBudget();
    const invoker = invokerFor(s, router, { budget });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello there' }];
    const ok = await invoker.invoke({ messages, tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_b1' });
    assert.equal(ok.ok, true);
    const estimate = Math.ceil(('hello there'.length + 16) / 4);
    assert.deepEqual(budget.reserved, [{ scopes: [`run/${s.runId}`], amounts: { tokens: estimate + 512, costUsd: router.estimateCostUsd('route_a', estimate, 512) }, reason: `model:${s.agentId}:turn:1` }]);
    assert.deepEqual(budget.settled, [{ id: 'res_1', actual: { tokens: 120, costUsd: router.estimateCostUsd('route_a', 100, 20) } }]);
    assert.deepEqual(budget.released, []);

    budget.exhausted = true;
    const r = await turn(s, engineHost(s, invoker));
    assert.equal(r.status, 'boundary');
    assert.equal(r.boundary, 'budget_exhausted');
    assert.equal(provA.callCount, 1, 'no model call without a reservation');
    assert.equal((await sessions.getTurn(s.sessionId, 1))?.status, 'boundary');
  });

  test('budget: a failed call releases its reservation', async () => {
    const s = await newSession();
    const { router } = stack({ 'model-a': () => ({ error: 'provider_error', message: 'bad request' }) });
    const budget = new RecordingBudget();
    const invoker = invokerFor(s, router, { budget });
    const r = await invoker.invoke({ messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_x' });
    assert.deepEqual(r.ok ? null : r.boundary, 'model_unavailable', 'provider_error never gets a fallback');
    assert.deepEqual(budget.released, ['res_1']);
    assert.deepEqual(budget.settled, []);
  });

  test('durability-10: a paid call whose model.invoked append fails is kept — its usage is SETTLED, never released', async () => {
    const s = await newSession();
    const catalog = new ModelCatalog([profile('route_a', 'prov_a', 'model-a', 'cls-a')]);
    const provA = new ScriptedProvider({ providerId: 'prov_a', brains: { 'model-a': () => ({ text: 'paid', usage: { inputTokens: 700, outputTokens: 50 } }) } });
    // the audit store refuses every model.invoked append (e.g. a lock timeout on the run counter)
    const sink = { emit: async (evs: Parameters<typeof deps.events.emit>[0]) => {
      if (evs.some((e) => e.eventType === 'model.invoked')) throw new Error('lock timeout on ht_run_counters');
      return deps.events.emit(evs);
    } };
    const router = createModelRouter({ ...deps, catalog, providers: new ProviderRegistry([provA]), events: sink, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    const budget = new RecordingBudget();
    const invoker = invokerFor(s, router, { budget }, { preferredRoutes: ['route_a'] });
    const r = await invoker.invoke({ messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_audit' });
    assert.equal(r.ok, true, 'the paid response is returned, not discarded');
    if (r.ok) assert.deepEqual(r.message.content, [{ type: 'text', text: 'paid' }]);
    assert.equal(provA.callCount, 1);
    assert.deepEqual(budget.settled, [{ id: 'res_1', actual: { tokens: 750, costUsd: router.estimateCostUsd('route_a', 700, 50) } }]);
    assert.deepEqual(budget.released, [], 'the reservation is never released for a paid call');
  });

  test('cross-model continuation: opaque reasoning of another class is stripped before the route sees it; same class is kept', async () => {
    const s = await newSession();
    const { router, provA, provB } = stack({});
    const seenByRouter: ChatMessage[][] = [];
    const recording: ModelRouter = {
      route: (req, ctx) => router.route(req, ctx),
      estimateCostUsd: (...a) => router.estimateCostUsd(...a),
      invoke: (req, rr) => {
        seenByRouter.push(req.call.messages);
        return router.invoke(req, rr);
      },
    };
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking done' }], reasoning: { text: 'visible', opaque: { compatibilityClass: 'cls-a', data: { sig: 'A-SECRET' } } } },
      { role: 'user', content: 'continue' },
    ];
    // route B (cls-b): the cls-a opaque block must not reach it
    const toB = invokerFor(s, recording, {}, { preferredRoutes: ['route_b', 'route_a'] });
    assert.equal((await toB.invoke({ messages: history, tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_p' })).ok, true);
    const projected = seenByRouter[0]![1]!;
    assert.deepEqual(projected, { role: 'assistant', content: [{ type: 'text', text: 'thinking done' }], reasoning: { text: 'visible' } });
    assert.ok(!JSON.stringify(provB.requests[0]!.messages).includes('A-SECRET'));

    // route A (cls-a): kept
    const s2 = await newSession();
    const toA = invokerFor(s2, recording);
    assert.equal((await toA.invoke({ messages: history, tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_p2' })).ok, true);
    assert.deepEqual(seenByRouter[1]![1], history[1]);
    assert.ok(JSON.stringify(provA.requests[0]!.messages).includes('A-SECRET'));
  });

  test('routing requirements derive from the turn: tools ⇒ tool_use, responseFormat ⇒ structured_output', async () => {
    const s = await newSession();
    const { router } = stack({}, [
      profile('route_plain', 'prov_a', 'model-a', 'cls-a', { capabilities: ['tool_use'], structuredOutput: 'none' }),
      profile('route_struct', 'prov_b', 'model-b', 'cls-b', { capabilities: ['tool_use', 'structured_output'], quality: { default: 0.5 } }),
    ]);
    const invoker = invokerFor(s, router, {}, {});
    const r = await invoker.invoke({
      messages: [{ role: 'user', content: 'report' }],
      tools: [{ name: 'probe', description: 'p', inputSchema: { type: 'object' } }],
      responseFormat: { name: 'report', schema: { type: 'object' } },
      signal: new AbortController().signal,
      turn: 1,
      snapshotId: 'cs_s',
    });
    assert.equal(r.ok && r.routeId, 'route_struct', 'the higher-quality route without structured output is filtered out');
  });

  test('a caller abort ends the model call as cancelled and the engine reports interrupted (turn stays started)', async () => {
    const s = await newSession();
    const ctrl = new AbortController();
    const { router } = stack({
      'model-a': async () => {
        ctrl.abort(new Error('shutdown'));
        return { text: 'late' };
      },
    });
    const invoker = invokerFor(s, router);
    const r = await turn(s, engineHost(s, invoker), ctrl.signal);
    assert.equal(r.status, 'interrupted');
    assert.equal((await sessions.lastTurn(s.sessionId))?.status, 'started');
    assert.equal(await epochs.pendingFallback!(s.sessionId), undefined, 'a cancellation never produces a fallback');
  });

  test('an EpochManager without durable fallback storage keeps the fallback in memory (still applied only at the next turn)', async () => {
    const s = await newSession();
    const { router, provA, provB } = stack({ 'model-a': () => ({ error: 'timeout' }) });
    const plain: EpochManager = { current: (id) => epochs.current(id), start: (i, c, o) => epochs.start(i, c, o), list: (id) => epochs.list(id), providersUsedByRoles: (r, x) => epochs.providersUsedByRoles(r, x) };
    const invoker = invokerFor(s, router, { epochs: plain });
    const h = engineHost(s, invoker);
    assert.equal((await turn(s, h)).boundary, 'retry_next_turn');
    assert.equal(provB.callCount, 0);
    assert.ok(deps.logger.entries.some((e) => e.level === 'warn' && /cannot persist pending fallbacks/.test(e.msg)));
    assert.equal((await turn(s, h)).status, 'continue');
    assert.equal(provA.callCount, 2);
    assert.equal(provB.callCount, 1);
    const list = await epochs.list(s.sessionId);
    assert.deepEqual(list.map((e) => [e.routeId, e.switchReason]), [['route_a', 'initial'], ['route_b', 'unavailable']]);
    // without stored routing data the decision is rebuilt from the epoch
    assert.equal((await turn(s, h)).status, 'continue');
    assert.equal(provB.callCount, 2);
  });

  test('routeRequestExtras may only tighten routing security (classification, risk, policy are never relaxed)', async () => {
    const profiles = [
      profile('route_a', 'prov_a', 'model-a', 'cls-a', { maxDataClassification: 'internal', maxActionRisk: 'medium' }),
      profile('route_b', 'prov_b', 'model-b', 'cls-b', { maxDataClassification: 'restricted', maxActionRisk: 'critical', quality: { default: 0.5 } }),
    ];
    const ask = async (extras: Record<string, unknown>, dataClassification: 'internal' | 'confidential' = 'confidential', policy: ModelPolicy = {}) => {
      const s = await newSession();
      const { router } = stack({}, profiles);
      const invoker = invokerFor(s, router, { dataClassification, routeRequestExtras: async () => extras as never }, policy);
      const r = await invoker.invoke({ messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, turn: 1, snapshotId: 'cs_x' });
      return r.ok ? r.routeId : r.boundary;
    };
    // confidential data may not reach route_a, whatever the extras claim
    assert.equal(await ask({ dataClassification: 'public' }), 'route_b');
    assert.equal(await ask({ actionRisk: 'low', dataClassification: 'internal' }), 'route_b');
    // extras cannot swap the policy: prov_b stays prohibited ⇒ no eligible route
    assert.equal(await ask({ policy: {} }, 'confidential', { prohibitedProviders: ['prov_b'] }), 'model_unavailable');
    // stricter extras do apply: internal data escalated to restricted / risk escalated to high ⇒ route_a is out
    assert.equal(await ask({}, 'internal'), 'route_a');
    assert.equal(await ask({ dataClassification: 'restricted' }, 'internal'), 'route_b');
    assert.equal(await ask({ actionRisk: 'high' }, 'internal'), 'route_b');
    assert.equal(await ask({ providersToAvoid: ['prov_a'] }, 'internal'), 'route_b');
    assert.equal(await ask({ excludeRoutes: ['route_a'] }, 'internal'), 'route_b');
    await assert.rejects(ask({ dataClassification: 'top-secret' }), code('invalid_argument'));
  });

  test('invoke requires a snapshot to route and refuses malformed turns', async () => {
    const s = await newSession();
    const { router } = stack({});
    const invoker = invokerFor(s, router);
    await assert.rejects(invoker.invoke({ messages: [], tools: [], signal: new AbortController().signal, turn: 1 }), code('invalid_argument'));
    await assert.rejects(invoker.invoke({ messages: [], tools: [], signal: new AbortController().signal, turn: 0, snapshotId: 'cs' }), code('invalid_argument'));
  });
});
