/**
 * A[3] the ModelEpoch switch sequence and its triggers, and A[0] the invoker's PAUSE:
 *  - order: the permission/profile re-check of a switch happens BEFORE its epoch is recorded; a refused switch records
 *    no epoch (`model.switch_refused`) and the turn re-routes;
 *  - triggers at safe boundaries, each with its switchReason: policy (the epoch's route no longer eligible), quality
 *    (catalog scores changed), cost (budget pressure ⇒ a strictly cheaper eligible route), manual (an operator request);
 *  - an engine without providerSwitch stays on its provider (emulated) or refuses;
 *  - no route for now ⇒ a durable ModelPause with a backoff; a success clears it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { SqlDatabase } from '@hypertest/core';
import type { EventContext, ModelPolicy } from '@hypertest/domain';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ModelCapabilityProfile, type ModelRouter, type ScriptedBrain } from '@hypertest/model';
import { createTestDatabase } from '@hypertest/store';
import {
  FakeContextProvider, FakeDispatcher, NativeEngine, createAgentRepository, createEpochManager, createModelInvoker, createSessionStore, qualityOnlyChange, runtimeMigrations,
  type EpochManager, type InvokerDeps, type ModelInvoker, type SessionStore, type TurnLimits,
} from '../src/index.ts';
import { baseDeps } from './helpers.ts';

const LIMITS: TurnLimits = { maxToolCallsPerTurn: 8, repetitionThreshold: 3 };

function profile(routeId: string, provider: string, extra: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    routeId, provider, model: `${routeId}-model`, capabilities: ['tool_use', 'structured_output'], structuredOutput: 'native', reasoning: 'none', contextWindow: 200_000, maxOutputTokens: 2048,
    continuationCompatibilityClass: `cls-${routeId}`, maxDataClassification: 'confidential', quality: { default: 0.8 }, toolReliability: 0.9, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 4,
    typicalLatencyMs: 100, maxActionRisk: 'high', enabled: true, ...extra,
  };
}

describe('A[3] model switches at safe boundaries; A[0] the invoker pauses', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let deps: ReturnType<typeof baseDeps>;
  let sessions: SessionStore;
  let epochs: EpochManager;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps('2026-06-01T00:00:00.000Z');
    sessions = createSessionStore({ ...deps, db });
    epochs = createEpochManager({ ...deps, db, sessions, events: deps.events });
  });
  after(async () => dispose());

  async function newSession(role = 'executor'): Promise<{ sessionId: string; runId: string; agentId: string; ctx: EventContext }> {
    n += 1;
    const runId = `run_s${n}`;
    const agentId = `ag_s${n}`;
    const sessionId = `sess_s${n}`;
    await sessions.create({ sessionId, runId, agentId, engineKind: 'native' });
    await sessions.appendTranscript(sessionId, [{ turn: 0, message: { role: 'user', content: 'task' } }]);
    await createAgentRepository({ ...deps, db }).create({
      agentId, runId, role, workItemId: `wi_s${n}`, depth: 0, engineKind: 'native', sessionId, status: 'active', capabilityId: `cap_s${n}`, continuable: false, background: false,
      createdAt: deps.clock.isoNow(), updatedAt: deps.clock.isoNow(),
    });
    return { sessionId, runId, agentId, ctx: { runId, correlationId: `corr_s${n}`, actorId: `agent:${agentId}`, agentId } };
  }

  /** One scripted provider per route provider; `calls` counts each route's calls. */
  function stack(profiles: ModelCapabilityProfile[], brains: Record<string, ScriptedBrain> = {}, catalog = new ModelCatalog(profiles)) {
    const calls: Record<string, number> = {};
    const providers = new ProviderRegistry(
      [...new Set(profiles.map((p) => p.provider))].map(
        (id) => new ScriptedProvider({ providerId: id, brain: (req, info) => ((calls[info.routeModel] = (calls[info.routeModel] ?? 0) + 1), (brains[info.routeModel] ?? (() => ({ text: 'ok' })))(req, info)) }),
      ),
    );
    const router = createModelRouter({ ...deps, catalog, providers, events: deps.events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    return { router, calls, catalog };
  }

  function invokerFor(s: { sessionId: string; runId: string; agentId: string; ctx: EventContext }, router: ModelRouter, extra: Partial<InvokerDeps> = {}, policy: ModelPolicy = {}, role = 'executor'): ModelInvoker {
    return createModelInvoker({
      ...deps, router, epochs, sessions, budgetScopes: [`run/${s.runId}`], agent: { agentId: s.agentId, runId: s.runId, role, sessionId: s.sessionId }, policy, taskType: 'execute_tests',
      dataClassification: 'internal', actionRisk: 'low', maxOutputTokens: 512, eventContext: s.ctx, events: deps.events, ...extra,
    });
  }

  const engine = () => new NativeEngine({ ...deps, sessions });
  const turn = (s: { sessionId: string; runId: string; ctx: EventContext }, model: ModelInvoker) => {
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const host = { model, tools, context: new FakeContextProvider({ tools: () => tools.definitions(), runId: s.runId }), sessions, eventContext: s.ctx, events: deps.events };
    return engine().runTurn({ session: { sessionId: s.sessionId, engineKind: 'native' }, host, limits: LIMITS, signal: new AbortController().signal });
  };
  const reasons = async (sessionId: string) => (await epochs.list(sessionId)).map((e) => [e.routeId, e.switchReason]);
  const refusals = (runId: string) => deps.events.events.filter((e) => e.eventType === 'model.switch_refused' && e.runId === runId).map((e) => e.payload as Record<string, unknown>);

  test('order: a pending fallback that fails the boundary re-check records NO epoch; the turn re-routes (before A[3] the epoch was recorded first)', async () => {
    const s = await newSession();
    const { router, calls } = stack(
      [profile('a', 'pa', { quality: { default: 0.9 } }), profile('b', 'pb', { quality: { default: 0.8 } }), profile('c', 'pc', { quality: { default: 0.7 }, maxDataClassification: 'restricted' })],
      { 'a-model': () => ({ error: 'unavailable', message: 'down' }) },
    );
    let classification: 'internal' | 'restricted' = 'internal';
    const invoker = invokerFor(s, router, { routeRequestExtras: async () => ({ dataClassification: classification }) });
    assert.equal((await turn(s, invoker)).boundary, 'retry_next_turn');
    assert.equal((await epochs.pendingFallback!(s.sessionId))?.decision.routeId, 'b');
    // the agent's context now carries restricted data: the pending fallback b no longer passes the security re-check
    classification = 'restricted';
    const r = await turn(s, invoker);
    assert.equal(r.status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['a', 'initial'], ['c', 'unavailable']], 'no epoch was ever recorded for the refused route b');
    assert.equal(calls['b-model'] ?? 0, 0);
    assert.equal(calls['c-model'], 1);
    const [refused] = refusals(s.runId);
    assert.deepEqual([refused!['routeId'], refused!['stage'], refused!['switchReason'], refused!['fromRouteId']], ['b', 'security', 'unavailable', 'a']);
    assert.equal(await epochs.pendingFallback!(s.sessionId), undefined);
  });

  test('policy: the epoch route is no longer eligible at the boundary ⇒ a new epoch (policy) before any call — no wasted turn', async () => {
    const s = await newSession();
    const { router, calls } = stack([profile('a', 'pa', { quality: { default: 0.9 } }), profile('r', 'pr', { quality: { default: 0.6 }, maxDataClassification: 'restricted' })]);
    let classification: 'internal' | 'restricted' = 'internal';
    const invoker = invokerFor(s, router, { routeRequestExtras: async () => ({ dataClassification: classification }) });
    assert.equal((await turn(s, invoker)).status, 'continue');
    classification = 'restricted';
    assert.equal((await turn(s, invoker)).status, 'continue', 'the switch happened at the boundary: the same turn ran on the new route');
    assert.deepEqual(await reasons(s.sessionId), [['a', 'initial'], ['r', 'policy']]);
    assert.deepEqual([calls['a-model'], calls['r-model']], [1, 1]);
  });

  test('quality: catalog scores changed (a new catalog revision) ⇒ re-route with switchReason quality; a profile change ⇒ policy', async () => {
    const s = await newSession();
    const profiles = [profile('a', 'pa', { quality: { default: 0.9 } }), profile('b', 'pb', { quality: { default: 0.8 } })];
    const first = stack(profiles);
    assert.equal((await turn(s, invokerFor(s, first.router, { catalog: first.catalog }))).status, 'continue');
    const routing = await epochs.routing!((await epochs.current(s.sessionId))!.epochId);
    assert.deepEqual(routing?.profile, first.catalog.get('a'), 'the epoch recorded its route profile');
    // eval feedback: b now scores better for executors (ModelCatalog.withScores ⇒ a new revision)
    const rescored = first.catalog.withScores({ b: { executor: 0.99 } });
    const second = stack(profiles, {}, rescored);
    assert.equal((await turn(s, invokerFor(s, second.router, { catalog: rescored }))).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['a', 'initial'], ['b', 'quality']]);
    assert.equal(qualityOnlyChange(first.catalog.get('a'), rescored.get('a')), true);
    // a non-quality change of the epoch's route is a policy switch
    const s2 = await newSession();
    assert.equal((await turn(s2, invokerFor(s2, first.router, { catalog: first.catalog }))).status, 'continue');
    const changed = new ModelCatalog([profile('a', 'pa', { quality: { default: 0.9 }, maxActionRisk: 'medium' }), profiles[1]!]);
    const third = stack(profiles, {}, changed);
    assert.equal((await turn(s2, invokerFor(s2, third.router, { catalog: changed }))).status, 'continue');
    assert.deepEqual(await reasons(s2.sessionId), [['a', 'initial'], ['a', 'policy']], 'same route, but its profile changed: a policy re-validation epoch');
  });

  test('cost: budget pressure switches to a strictly cheaper eligible route (cost); without pressure nothing changes', async () => {
    const s = await newSession();
    const { router, calls } = stack([
      profile('dear', 'pd', { quality: { default: 0.9 }, costPerMillionInputUsd: 10, costPerMillionOutputUsd: 40 }),
      profile('cheap', 'pc', { quality: { default: 0.7 }, costPerMillionInputUsd: 0.1, costPerMillionOutputUsd: 0.4 }),
      profile('below-floor', 'pf', { quality: { default: 0.2 }, costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 }),
    ]);
    let pressure: { remainingUsd: number; limitUsd: number } | undefined = { remainingUsd: 9, limitUsd: 10 };
    const invoker = invokerFor(s, router, { costBudgeted: true, costPressure: async () => pressure }, { minQuality: 0.5 });
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['dear', 'initial']], 'no pressure: no switch');
    pressure = { remainingUsd: 1, limitUsd: 10 };
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['dear', 'initial'], ['cheap', 'cost']], 'the quality floor still holds: below-floor is never chosen');
    assert.equal(calls['below-floor-model'] ?? 0, 0);
    // already on the cheapest eligible route: pressure changes nothing more
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.equal((await epochs.list(s.sessionId)).length, 2);
  });

  test('cost: "cheaper" compares like with like — a dearer per-token route with a smaller output cap is not taken for cheaper', async () => {
    const s = await newSession();
    // cur: $1/$2 per M, output capped at 1024; dearer: $1.2 per M input, $0.5 output, cap 4096. For the same input, cur's
    // dearest call (E + 1024×2) is below dearer's (1.2E + 4096×0.5): no cost switch. Before the fix cur was priced with the
    // invoker's 4096-token output reserve (E + 4096×2) against dearer's own cap, so dearer passed as "cheaper".
    const { router, calls, catalog } = stack([
      profile('cur', 'pc', { quality: { default: 0.9 }, maxOutputTokens: 1024, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 2 }),
      profile('dearer', 'pd', { quality: { default: 0.8 }, maxOutputTokens: 4096, costPerMillionInputUsd: 1.2, costPerMillionOutputUsd: 0.5 }),
    ]);
    const invoker = invokerFor(s, router, { costBudgeted: true, costPressure: async () => ({ remainingUsd: 1, limitUsd: 10 }), maxOutputTokens: 4096, catalog });
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['cur', 'initial']], 'under pressure, but no route is cheaper on the same basis');
    assert.equal(calls['dearer-model'] ?? 0, 0);
    // a route that IS cheaper on that basis is taken (the trigger itself still works)
    const t = await newSession();
    const two = stack([
      profile('cur', 'pc', { quality: { default: 0.9 }, maxOutputTokens: 1024, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 2 }),
      profile('cheaper', 'pk', { quality: { default: 0.8 }, maxOutputTokens: 4096, costPerMillionInputUsd: 0.5, costPerMillionOutputUsd: 0.2 }),
    ]);
    const inv2 = invokerFor(t, two.router, { costBudgeted: true, costPressure: async () => ({ remainingUsd: 1, limitUsd: 10 }), maxOutputTokens: 4096, catalog: two.catalog });
    assert.equal((await turn(t, inv2)).status, 'continue');
    assert.equal((await turn(t, inv2)).status, 'continue');
    assert.deepEqual(await reasons(t.sessionId), [['cur', 'initial'], ['cheaper', 'cost']]);
  });

  test('manual: an operator request is applied at the next boundary (manual) after the re-check; a refused one records no epoch', async () => {
    const s = await newSession();
    const { router, calls } = stack([profile('a', 'pa', { quality: { default: 0.9 } }), profile('b', 'pb', { quality: { default: 0.8 } }), profile('weak', 'pw', { quality: { default: 0.9 }, maxActionRisk: 'low' })]);
    const invoker = invokerFor(s, router, {}, {}, 'executor');
    assert.equal((await turn(s, invoker)).status, 'continue');
    const req = await epochs.requestSwitch!({ runId: s.runId, target: { kind: 'role', role: 'executor' }, routeId: 'b', requestedBy: 'human:alice', reason: 'compare models' }, s.ctx);
    assert.ok(deps.events.events.some((e) => e.eventType === 'model.switch_requested' && (e.payload as { switchId: string }).switchId === req.switchId));
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['a', 'initial'], ['b', 'manual']]);
    assert.equal(calls['b-model'], 1);
    const [sw] = await epochs.listSwitches!(s.runId);
    assert.deepEqual(sw!.outcomes.map((o) => [o.agentId, o.outcome]), [[s.agentId, 'applied']]);
    // applied once: the next turn stays
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.equal((await epochs.list(s.sessionId)).length, 2);
    // a manual switch to a route that may not drive this agent's actions is refused — the current epoch continues
    await epochs.requestSwitch!({ runId: s.runId, target: { kind: 'agent', agentId: s.agentId }, routeId: 'weak', requestedBy: 'human:alice' }, s.ctx);
    const high = invokerFor(s, router, { actionRisk: 'high' });
    assert.equal((await turn(s, high)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['a', 'initial'], ['b', 'manual']], 'no epoch for the refused manual switch');
    const refused = refusals(s.runId).at(-1)!;
    assert.deepEqual([refused['switchReason'], refused['routeId'], refused['stage']], ['manual', 'weak', 'security']);
    const all = await epochs.listSwitches!(s.runId);
    assert.deepEqual(all.at(-1)!.outcomes.map((o) => o.outcome), ['refused']);
    // an unknown route is refused with the exact reason
    await epochs.requestSwitch!({ runId: s.runId, target: { kind: 'agent', agentId: s.agentId }, routeId: 'ghost', requestedBy: 'human:alice' }, s.ctx);
    await turn(s, invoker);
    assert.equal(refusals(s.runId).at(-1)!['reason'], 'route ghost is not in the model catalog');
  });

  test('A[4] an engine without providerSwitch: switches stay on its provider; another provider is refused', async () => {
    const s = await newSession();
    const { router } = stack([profile('a1', 'pa', { quality: { default: 0.9 } }), profile('a2', 'pa', { quality: { default: 0.7 } }), profile('b', 'pb', { quality: { default: 0.8 } })], { 'a1-model': () => ({ error: 'unavailable' }) });
    const invoker = invokerFor(s, router, { providerSwitch: false });
    // a1 fails ⇒ the router's fallback is b (another provider) ⇒ refused at the boundary; a2 (same provider) serves
    assert.equal((await turn(s, invoker)).boundary, 'retry_next_turn');
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.deepEqual(await reasons(s.sessionId), [['a1', 'initial'], ['a2', 'unavailable']]);
    const refused = refusals(s.runId).at(-1)!;
    assert.deepEqual([refused['routeId'], refused['stage']], ['b', 'engine']);
  });

  test('A[0] no route for now ⇒ a durable ModelPause (backoff doubling); a success clears it; a permanent refusal pauses nothing', async () => {
    const s = await newSession();
    let down = true;
    const { router } = stack([profile('only', 'p1')], { 'only-model': () => (down ? { error: 'timeout', message: 'slow' } : { text: 'back' }) });
    const invoker = invokerFor(s, router, { pauseBackoff: { baseMs: 1000, maxMs: 3000 } });
    const r1 = await turn(s, invoker);
    assert.deepEqual([r1.status, r1.boundary], ['boundary', 'model_unavailable']);
    const p1 = (await epochs.modelPause!(s.sessionId))!;
    assert.deepEqual([p1.consecutive, Date.parse(p1.resumeAt) - deps.clock.nowMs(), p1.routes], [1, 1000, ['only']]);
    await turn(s, invoker);
    const p2 = (await epochs.modelPause!(s.sessionId))!;
    assert.deepEqual([p2.consecutive, Date.parse(p2.resumeAt) - deps.clock.nowMs()], [2, 2000], 'no known retry time: the backoff doubles');
    await turn(s, invoker);
    const p3 = (await epochs.modelPause!(s.sessionId))!;
    // the 5th consecutive failure opened the route's circuit: a known retry time (its half-open time) wins over the backoff
    const circuit = router.circuits!().find((c) => c.routeId === 'only')!;
    assert.equal(circuit.state, 'open');
    assert.deepEqual([p3.consecutive, p3.resumeAt], [3, circuit.halfOpenAt]);
    assert.deepEqual((await epochs.listModelPauses!(s.runId)).map((p) => p.sessionId), [s.sessionId]);
    assert.deepEqual(await epochs.releaseModelPauses!(s.runId, deps.clock.isoNow()), [s.sessionId]);
    assert.equal((await epochs.modelPause!(s.sessionId))!.resumeAt, deps.clock.isoNow());
    // the operator's resume also lets the open circuit probe now (one call; its verdict decides)
    assert.deepEqual(router.probeNow!(), ['only']);
    assert.equal(router.circuits!().find((c) => c.routeId === 'only')!.state, 'half_open');
    down = false;
    assert.equal((await turn(s, invoker)).status, 'continue');
    assert.equal(await epochs.modelPause!(s.sessionId), undefined);
    // permanent: no route has the capability ⇒ fail closed, no pause
    const s2 = await newSession();
    const blind = stack([profile('blind', 'p2', { capabilities: [] })]);
    const r = await turn(s2, invokerFor(s2, blind.router));
    assert.deepEqual([r.status, r.boundary], ['boundary', 'model_unavailable']);
    assert.equal(await epochs.modelPause!(s2.sessionId), undefined);
  });
});
