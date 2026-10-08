import { HypertestError, canonicalJson, isHypertestError } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, EVENT_TYPES, RISK_ORDER, estimateTokens, eventFrom, projectForRoute, type DataClassification, type ModelCapability, type ModelEpoch, type ModelPolicy,
  type ModelSwitchReason, type RiskClass,
} from '@hypertest/domain';
import type { DecisionCheck, InvokeRequest, ModelCapabilityProfile, ModelUnavailability, RouteRejection, RouteRequest } from '@hypertest/model';
import type { InvokerDeps, ModelBudgetRefusal, ModelInvocation, ModelInvoker, ModelPause, ModelSwitchRequest, OkRouteDecision, PendingFallback, TokenCalibration } from './contracts.ts';
import { assertTurnNumber } from './util.ts';

/** (A[0]) Default backoff of a pause whose resume time is not known (doubling per consecutive pause). */
export const DEFAULT_PAUSE_BACKOFF = Object.freeze({ baseMs: 5_000, maxMs: 300_000 });
/** (A[3]) Budget pressure: remaining cost budget below this fraction of the limit ⇒ switch to a cheaper eligible route. */
export const DEFAULT_COST_PRESSURE_RATIO = 0.25;

/**
 * Token-estimate calibration bounds: the measured ratio actual/estimate is clamped to [min, max] and smoothed
 * (exponentially weighted, `weight` for the newest sample) per route.
 */
export const CALIBRATION_BOUNDS = Object.freeze({ min: 0.5, max: 3, weight: 0.5 });

/**
 * A per-route calibration of `estimateTokens` (a chars/4 heuristic) against the input tokens providers report. Hosts keep
 * one per process (shared by the agents of a worker); an invoker without one keeps its own.
 */
export function createTokenCalibration(): TokenCalibration {
  const ratios = new Map<string, number>();
  return {
    ratio: (routeId) => ratios.get(routeId) ?? 1,
    observe(routeId, estimated, actual) {
      if (!(Number.isFinite(estimated) && estimated > 0 && Number.isFinite(actual) && actual > 0)) return;
      const sample = Math.min(CALIBRATION_BOUNDS.max, Math.max(CALIBRATION_BOUNDS.min, actual / estimated));
      const prev = ratios.get(routeId);
      ratios.set(routeId, prev === undefined ? sample : prev + CALIBRATION_BOUNDS.weight * (sample - prev));
    },
  };
}

/** The ledger's typed refusal (`{scope, dimension, limit, used, reserved, requested}`), when the port reports one. */
function typedExhaustion(x: unknown): { scope: string; dimension: string; limit: number; used: number; reserved: number; requested: number } | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const e = x as Record<string, unknown>;
  const num = (k: string): number | undefined => (typeof e[k] === 'number' && Number.isFinite(e[k]) ? (e[k] as number) : undefined);
  const limit = num('limit');
  if (typeof e['scope'] !== 'string' || typeof e['dimension'] !== 'string' || limit === undefined) return undefined;
  return { scope: e['scope'], dimension: e['dimension'], limit, used: num('used') ?? 0, reserved: num('reserved') ?? 0, requested: num('requested') ?? 0 };
}

function amount(dimension: string, v: number): string {
  return dimension === 'costUsd' ? `$${Number(v.toFixed(6))}` : String(Math.round(v));
}

/** Maps the router's failure code to the ModelEpoch switch reason of the fallback epoch. */
export function switchReasonFor(code: string): ModelSwitchReason {
  switch (code) {
    case 'rate_limited':
      return 'rate_limit';
    case 'precondition_failed':
      return 'policy';
    default:
      return 'unavailable';
  }
}

/** Rebuilds the decision of an epoch that was started without a stored decision (legacy/foreign EpochManager). */
export function decisionFromEpoch(epoch: ModelEpoch, policy: ModelPolicy): OkRouteDecision {
  const d: OkRouteDecision = {
    ok: true,
    routeId: epoch.routeId,
    provider: epoch.provider,
    model: epoch.model,
    fallbackChain: [],
    selectedByPolicy: 'epoch',
    capabilityProfileRevision: epoch.capabilityProfileRevision,
    continuationCompatibilityClass: epoch.continuationCompatibilityClass,
    rejected: [],
  };
  if (policy.reasoningEffort !== undefined) d.reasoningEffort = policy.reasoningEffort;
  return d;
}

/**
 * (A[3]) After a catalog change, whether the epoch's route changed in its quality scores only (or not at all — the change
 * is elsewhere in the catalog, e.g. other routes' scores): the re-route is then a `quality` switch, otherwise `policy`.
 */
export function qualityOnlyChange(before: ModelCapabilityProfile | undefined, after: ModelCapabilityProfile | undefined): boolean {
  if (!before || !after) return false;
  const { quality: _a, ...restBefore } = before;
  const { quality: _b, ...restAfter } = after;
  return canonicalJson(restBefore as never) === canonicalJson(restAfter as never);
}

/** The stricter of the configured value and an extra (extras may only tighten routing security, never relax it). */
function stricter<K extends string>(order: Record<K, number>, configured: K, extra: unknown, what: string): K {
  if (extra === undefined) return configured;
  if (typeof extra !== 'string' || !Object.hasOwn(order, extra)) throw new HypertestError('invalid_argument', `routeRequestExtras: unknown ${what} ${String(extra)}`);
  return order[extra as K] > order[configured] ? (extra as K) : configured;
}

function union<T>(...lists: ReadonlyArray<readonly T[] | undefined>): T[] {
  const out: T[] = [];
  for (const l of lists) for (const x of l ?? []) if (!out.includes(x)) out.push(x);
  return out;
}

function withExcluded(req: RouteRequest, excluded: readonly string[]): RouteRequest {
  const all = union(req.excludeRoutes, excluded);
  const out: RouteRequest = { ...req };
  if (all.length > 0) out.excludeRoutes = all;
  else delete out.excludeRoutes;
  return out;
}

/** Classification of a failed routing for routers that do not classify (foreign routers): availability/excluded ⇒ transient. */
function classifyRejections(rejected: readonly RouteRejection[], prefix: string): ModelUnavailability {
  const transient = rejected.some((r) => r.stage === 'availability' || r.stage === 'excluded');
  const why = rejected.map((r) => `${r.routeId}: ${r.stage} (${r.reason})`).join('; ');
  return { transient, reason: `${prefix}${why ? `: ${why}` : ''}`, routes: rejected.map((r) => r.routeId) };
}

interface SwitchCandidate {
  decision: OkRouteDecision;
  reason: ModelSwitchReason;
  excluded: string[];
  source: 'manual' | 'fallback' | 'reroute' | 'initial';
  switchId?: string;
}

/**
 * Per-agent ModelInvoker (runtime ownership of routing + epochs + budgets). Every call is a turn boundary (I3):
 *   1. the turn's route — switch triggers in order: a manual switch request (`manual`), the pending fallback of the
 *      previous failed call (`rate_limit` / `unavailable` / `policy`), the current epoch's own re-check at this boundary
 *      (route no longer eligible ⇒ `policy`; catalog changed in scores only ⇒ `quality`; circuit open ⇒ `unavailable`),
 *      budget pressure (a strictly cheaper eligible route ⇒ `cost`); no epoch yet ⇒ the initial route.
 *   2. a switch is re-checked (permission/profile: router.validate against THIS turn's request and snapshot) BEFORE its
 *      epoch is recorded; a refused switch records no epoch (`model.switch_refused`) and the turn re-routes.
 *   3. budget reserve {tokens: estimate + maxOutputTokens, costUsd: estimate} ⇒ exhausted ⇒ boundary budget_exhausted.
 *   4. router.invoke on the decision with messages projected for the route's continuation class; ok ⇒ settle usage (and
 *      clear a model pause); failure ⇒ release, then ALLOW (store the router's re-validated fallback for the NEXT
 *      boundary: retry_next_turn) or PAUSE (no route for now: a durable ModelPause until a half-open time / Retry-After /
 *      backoff — boundary model_unavailable with `pause`) or fail closed (no route may ever serve: model_unavailable
 *      without a pause); caller abort ⇒ cancelled.
 */
export function createModelInvoker(deps: InvokerDeps): ModelInvoker {
  const { router, epochs, agent, policy, logger } = deps;
  const memoryFallbacks = new Map<string, PendingFallback>();
  const memoryPauses = new Map<string, ModelPause>();
  let warnedMemory = false;
  const backoff = { baseMs: deps.pauseBackoff?.baseMs ?? DEFAULT_PAUSE_BACKOFF.baseMs, maxMs: deps.pauseBackoff?.maxMs ?? DEFAULT_PAUSE_BACKOFF.maxMs };
  if (!(backoff.baseMs > 0) || !(backoff.maxMs >= backoff.baseMs)) throw new HypertestError('invalid_argument', 'pauseBackoff: baseMs must be > 0 and maxMs ≥ baseMs');
  const pressureRatio = deps.costPressureRatio ?? DEFAULT_COST_PRESSURE_RATIO;
  if (!(pressureRatio >= 0 && pressureRatio <= 1)) throw new HypertestError('invalid_argument', `costPressureRatio must be in [0, 1] (got ${String(pressureRatio)})`);
  const canSwitchProvider = deps.providerSwitch !== false;
  const sessionId = agent.sessionId;
  const calibration = deps.calibration ?? createTokenCalibration();
  const minOutputTokens = deps.minOutputTokens ?? Math.min(deps.maxOutputTokens, 1024);
  if (!(Number.isInteger(minOutputTokens) && minOutputTokens >= 1 && minOutputTokens <= deps.maxOutputTokens)) {
    throw new HypertestError('invalid_argument', `minOutputTokens must be an integer in [1, maxOutputTokens ${deps.maxOutputTokens}] (got ${String(minOutputTokens)})`);
  }

  function warnMemory(what: string): void {
    if (warnedMemory) return;
    warnedMemory = true;
    logger.warn(`EpochManager cannot persist ${what}; keeping them in process memory (lost on restart)`, { sessionId });
  }

  async function pendingFallback(): Promise<PendingFallback | undefined> {
    if (epochs.pendingFallback) return epochs.pendingFallback(sessionId);
    return memoryFallbacks.get(sessionId);
  }

  async function setPendingFallback(fb: Omit<PendingFallback, 'createdAt'>): Promise<void> {
    if (epochs.setPendingFallback) return epochs.setPendingFallback(sessionId, fb);
    warnMemory('pending fallbacks');
    memoryFallbacks.set(sessionId, { ...fb, createdAt: deps.clock.isoNow() });
  }

  async function clearPendingFallback(): Promise<void> {
    memoryFallbacks.delete(sessionId);
    if (epochs.clearPendingFallback) await epochs.clearPendingFallback(sessionId);
  }

  async function currentPause(): Promise<ModelPause | undefined> {
    if (epochs.modelPause) return epochs.modelPause(sessionId);
    return memoryPauses.get(sessionId);
  }

  async function clearPause(): Promise<void> {
    memoryPauses.delete(sessionId);
    if (epochs.clearModelPause) await epochs.clearModelPause(sessionId);
  }

  async function validate(decision: OkRouteDecision, req: RouteRequest): Promise<DecisionCheck> {
    return router.validate ? router.validate(decision, req) : { ok: true };
  }

  async function switchRefused(payload: Record<string, unknown>): Promise<void> {
    logger.warn('model switch refused at the boundary re-check (no epoch recorded)', payload);
    if (!deps.events) return;
    await deps.events.emit([eventFrom(deps.eventContext, EVENT_TYPES.modelSwitchRefused, 'model', agent.agentId, { sessionId, ...payload })]);
  }

  async function switchOutcome(request: ModelSwitchRequest, outcome: 'applied' | 'refused', detail: string, epochId?: string): Promise<void> {
    if (!epochs.recordSwitchOutcome) return;
    const o: Parameters<NonNullable<typeof epochs.recordSwitchOutcome>>[0] = { switchId: request.switchId, agentId: agent.agentId, outcome, detail };
    if (epochId !== undefined) o.epochId = epochId;
    await epochs.recordSwitchOutcome(o);
  }

  /** PAUSE (transient: a durable ModelPause) or fail closed (permanent). */
  async function unavailable(u: ModelUnavailability, turn: number, previous: ModelPause | undefined): Promise<ModelInvocation> {
    if (!u.transient) return { ok: false, boundary: 'model_unavailable', message: u.reason, unavailable: u };
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const nowMs = deps.clock.nowMs();
    const known = u.retryAt !== undefined ? Date.parse(u.retryAt) : Number.NaN;
    const backoffMs = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(consecutive - 1, 30));
    const resumeAtMs = Number.isFinite(known) && known > nowMs ? known : nowMs + backoffMs;
    const record: Omit<ModelPause, 'createdAt'> = {
      sessionId, runId: agent.runId, agentId: agent.agentId, turn, reason: u.reason, resumeAt: new Date(resumeAtMs).toISOString(), routes: [...u.routes], consecutive,
    };
    let pause: ModelPause;
    if (epochs.setModelPause) pause = await epochs.setModelPause(record);
    else {
      warnMemory('model pauses');
      pause = { ...record, createdAt: deps.clock.isoNow() };
      memoryPauses.set(sessionId, pause);
    }
    logger.warn('model unavailable: the agent pauses until a route is back', { agentId: agent.agentId, resumeAt: pause.resumeAt, consecutive, reason: u.reason });
    return { ok: false, boundary: 'model_unavailable', message: `${u.reason}; paused until ${pause.resumeAt}`, unavailable: u, pause };
  }

  return {
    async invoke(request): Promise<ModelInvocation> {
      assertTurnNumber(request?.turn);
      if (!Array.isArray(request.messages)) throw new HypertestError('invalid_argument', 'messages must be an array');
      const tools = request.tools ?? [];
      if (request.signal.aborted) return { ok: false, boundary: 'cancelled', message: 'model call cancelled before it started' };
      const current = await epochs.current(sessionId);
      const pending = await pendingFallback();
      const paused = await currentPause();
      const snapshotId = request.snapshotId ?? current?.contextSnapshotId;
      if (!snapshotId) throw new HypertestError('invalid_argument', 'invoke: snapshotId is required to route (I3: the snapshot is fixed at the boundary)');

      const extras = deps.routeRequestExtras ? await deps.routeRequestExtras() : {};
      const contextTokensEstimate = estimateTokens(request.messages, tools);
      const derived: ModelCapability[] = [];
      if (tools.length > 0) derived.push('tool_use');
      if (request.responseFormat) derived.push('structured_output');
      // Identity, role, task and policy come from the invoker's deps; extras may only ADD restrictions (providers to
      // avoid, excluded routes, capabilities, structured output, a stricter risk/classification) — never relax them.
      const routeRequest: RouteRequest = {
        role: agent.role,
        taskType: deps.taskType,
        policy,
        actionRisk: stricter<RiskClass>(RISK_ORDER, deps.actionRisk, extras.actionRisk, 'actionRisk'),
        dataClassification: stricter<DataClassification>(CLASSIFICATION_ORDER, deps.dataClassification, extras.dataClassification, 'dataClassification'),
        runId: agent.runId,
        agentId: agent.agentId,
        requiredCapabilities: union(policy.requiredCapabilities, derived, extras.requiredCapabilities),
        contextTokensEstimate,
        contextSnapshotId: snapshotId,
      };
      if (request.responseFormat || extras.structuredOutput === true) routeRequest.structuredOutput = true;
      if (extras.providersToAvoid !== undefined) routeRequest.providersToAvoid = union(extras.providersToAvoid);
      if (extras.excludeRoutes !== undefined && extras.excludeRoutes.length > 0) routeRequest.excludeRoutes = union(extras.excludeRoutes);
      if (deps.costBudgeted === true || extras.costBudgeted === true) routeRequest.costBudgeted = true;
      // A[4] an engine that cannot switch providers keeps its session on the current provider (emulation: same-provider routes)
      const restrict = (req: RouteRequest): RouteRequest =>
        !canSwitchProvider && current
          ? { ...req, policy: { ...req.policy, allowedProviders: (req.policy.allowedProviders ?? [current.provider]).filter((p) => p === current.provider) } }
          : req;
      // a paused agent that resumes starts a fresh epoch sequence: routes that failed before the pause are tried again
      const resuming = paused !== undefined;
      const ctx = deps.eventContext;

      // ---------------------------------------------------------------- 1. the turn's route (switch triggers)
      let epoch: ModelEpoch | undefined;
      let decision: OkRouteDecision | undefined;
      let excluded: string[] = [];
      let candidate: SwitchCandidate | undefined;
      let currentValid = false;

      const manual = epochs.pendingSwitch ? await epochs.pendingSwitch(agent.runId, agent.agentId, agent.role) : undefined;
      if (manual) {
        if (current && current.routeId === manual.routeId) {
          await switchOutcome(manual, 'applied', `already on route ${manual.routeId} (epoch ${current.epochId})`, current.epochId);
        } else {
          const preferred = [manual.routeId, ...(policy.preferredRoutes ?? []).filter((r) => r !== manual.routeId)];
          const routed = await router.route(restrict({ ...routeRequest, policy: { ...policy, preferredRoutes: preferred } }), ctx);
          if (routed.ok && routed.routeId === manual.routeId) {
            candidate = { decision: routed, reason: 'manual', excluded: [], source: 'manual', switchId: manual.switchId };
          } else {
            const rejection = routed.rejected.find((r) => r.routeId === manual.routeId);
            const reason = rejection
              ? `${rejection.stage}: ${rejection.reason}`
              : !canSwitchProvider && current
                ? `the ${current.provider} session's engine cannot switch provider, and route ${manual.routeId} is not a ${current.provider} route`
                : `route ${manual.routeId} is not in the model catalog`;
            await switchRefused({ switchReason: 'manual', switchId: manual.switchId, routeId: manual.routeId, fromRouteId: current?.routeId ?? null, stage: rejection?.stage ?? 'catalog', reason });
            await switchOutcome(manual, 'refused', reason);
          }
        }
      }
      if (!candidate && pending) {
        candidate = { decision: pending.decision, reason: pending.reason, excluded: resuming ? [] : pending.excludedRoutes, source: 'fallback' };
      }
      if (!candidate && current) {
        const routing = epochs.routing ? await epochs.routing(current.epochId) : undefined;
        decision = routing?.decision ?? decisionFromEpoch(current, policy);
        excluded = resuming ? [] : (routing?.excludedRoutes ?? []);
        epoch = current;
        const check = await validate(decision, withExcluded(routeRequest, excluded));
        if (!check.ok) {
          // the epoch's route no longer holds at this boundary: switch HERE, before any call (I3)
          if (check.transient && policy.fallback === 'fail_closed') {
            return unavailable({ transient: true, reason: `route ${decision.routeId} is unavailable (${check.reason}) and the role's policy is fail_closed (no fallback)`, routes: [decision.routeId], ...(check.retryAt ? { retryAt: check.retryAt } : {}) }, request.turn, paused);
          }
          const reason: ModelSwitchReason = check.stage === 'catalog' ? (qualityOnlyChange(routing?.profile, deps.catalog?.get(decision.routeId)) ? 'quality' : 'policy') : check.transient ? 'unavailable' : 'policy';
          const exclude = check.transient ? union(excluded, [decision.routeId]) : excluded;
          const routed = await router.route(restrict(withExcluded(routeRequest, exclude)), ctx);
          if (!routed.ok) {
            const u = routed.unavailable ?? classifyRejections(routed.rejected, `no eligible model route for ${agent.role}/${deps.taskType}`);
            return unavailable(check.transient && !u.transient ? { ...u, transient: true } : u, request.turn, paused);
          }
          candidate = { decision: routed, reason, excluded: exclude, source: 'reroute' };
          epoch = undefined;
          decision = undefined;
        } else {
          currentValid = true;
          if (deps.costPressure) {
            const pressure = await deps.costPressure();
            // the call's own cost (calibrated input + the output the route can return: the router caps a call's output
            // at the route's maxOutputTokens) decides whether the budget is under pressure ...
            const routeMaxOut = deps.catalog?.get(decision.routeId)?.maxOutputTokens;
            const callOut = routeMaxOut !== undefined ? Math.min(deps.maxOutputTokens, routeMaxOut) : deps.maxOutputTokens;
            const estimate = pressure ? router.estimateCostUsd(decision.routeId, Math.ceil(contextTokensEstimate * calibration.ratio(decision.routeId)), callOut) : Number.NaN;
            // ... and "cheaper" compares like with like: the router prices each candidate at the request's input estimate +
            // the candidate's maxOutputTokens, so the current route is priced on exactly that basis (else a dearer
            // per-token route with a smaller output cap could pass as cheaper)
            const basis = pressure && routeMaxOut !== undefined ? router.estimateCostUsd(decision.routeId, contextTokensEstimate, routeMaxOut) : estimate;
            if (pressure && Number.isFinite(estimate) && Number.isFinite(basis) && (pressure.remainingUsd < pressureRatio * pressure.limitUsd || estimate > pressure.remainingUsd)) {
              const routed = await router.route(restrict({ ...withExcluded(routeRequest, excluded), cheaperThanUsd: basis }), ctx);
              if (routed.ok && routed.routeId !== decision.routeId) {
                logger.info('budget pressure: switching to a cheaper eligible route', { agentId: agent.agentId, from: decision.routeId, to: routed.routeId, remainingUsd: pressure.remainingUsd });
                candidate = { decision: routed, reason: 'cost', excluded, source: 'reroute' };
              }
            }
          }
        }
      }
      if (!candidate && !current) {
        const routed = await router.route(routeRequest, ctx);
        if (!routed.ok) return unavailable(routed.unavailable ?? classifyRejections(routed.rejected, `no eligible model route for ${agent.role}/${deps.taskType}`), request.turn, paused);
        candidate = { decision: routed, reason: 'initial', excluded: [], source: 'initial' };
      }

      // ---------------------------------------------------------------- 2. switch: re-check BEFORE the new epoch (I3)
      if (candidate) {
        let refusal: { stage: string; reason: string; transient: boolean; retryAt?: string } | undefined;
        if (!canSwitchProvider && current && candidate.decision.provider !== current.provider) {
          refusal = { stage: 'engine', reason: `the session's engine cannot switch provider (${current.provider} → ${candidate.decision.provider})`, transient: true };
        } else {
          const check = await validate(candidate.decision, withExcluded(routeRequest, candidate.excluded));
          if (!check.ok) refusal = { stage: check.stage, reason: check.reason, transient: check.transient, ...(check.retryAt ? { retryAt: check.retryAt } : {}) };
        }
        if (refusal) {
          await switchRefused({
            switchReason: candidate.reason, routeId: candidate.decision.routeId, fromRouteId: current?.routeId ?? null, stage: refusal.stage, reason: refusal.reason, ...(candidate.switchId ? { switchId: candidate.switchId } : {}),
          });
          if (candidate.switchId && manual) await switchOutcome(manual, 'refused', `${refusal.stage}: ${refusal.reason}`);
          if (candidate.source === 'fallback') await clearPendingFallback();
          if (current && !currentValid && (candidate.source === 'manual' || candidate.reason === 'cost')) {
            // a refused manual switch: the current epoch continues when it still holds at this boundary
            const routing = epochs.routing ? await epochs.routing(current.epochId) : undefined;
            const d = routing?.decision ?? decisionFromEpoch(current, policy);
            const ex = resuming ? [] : (routing?.excludedRoutes ?? []);
            if ((await validate(d, withExcluded(routeRequest, ex))).ok) {
              epoch = current;
              decision = d;
              excluded = ex;
              currentValid = true;
            }
          }
          if (current && currentValid) {
            // a refused manual / cost switch: the current epoch (re-checked) simply continues
            candidate = undefined;
          } else {
            // the refused route is not used; the turn re-routes under its own request (fully re-validated by route())
            const exclude = union(candidate.excluded, [candidate.decision.routeId]);
            const routed = await router.route(restrict(withExcluded(routeRequest, exclude)), ctx);
            if (!routed.ok) {
              const u = routed.unavailable ?? classifyRejections(routed.rejected, `no eligible model route for ${agent.role}/${deps.taskType}`);
              return unavailable(refusal.transient && !u.transient ? { ...u, transient: true, reason: `${u.reason} (after a refused switch: ${refusal.reason})` } : u, request.turn, paused);
            }
            candidate = { ...candidate, decision: routed, excluded: exclude, source: 'reroute' };
            delete candidate.switchId;
          }
        }
      }
      if (candidate) {
        const d = candidate.decision;
        const input: Omit<ModelEpoch, 'epochId' | 'startedAt'> = {
          runId: agent.runId,
          agentId: agent.agentId,
          sessionId,
          routeId: d.routeId,
          provider: d.provider,
          model: d.model,
          capabilityProfileRevision: d.capabilityProfileRevision,
          continuationCompatibilityClass: d.continuationCompatibilityClass,
          contextSnapshotId: snapshotId,
          switchReason: candidate.reason,
          startedAtTurn: request.turn,
        };
        if (current) input.previousEpochId = current.epochId;
        const options: Parameters<typeof epochs.start>[2] = { decision: d, excludedRoutes: candidate.excluded, consumeFallback: pending !== undefined };
        const profile = deps.catalog?.get(d.routeId);
        if (profile) options!.profile = profile;
        epoch = await epochs.start(input, ctx, options);
        memoryFallbacks.delete(sessionId);
        if (candidate.switchId && manual) await switchOutcome(manual, 'applied', `epoch ${epoch.epochId} on route ${d.routeId}`, epoch.epochId);
        decision = d;
        excluded = candidate.excluded;
      }
      if (!epoch || !decision) throw new HypertestError('internal', `no route decision for agent ${agent.agentId} at turn ${request.turn}`);

      // ---------------------------------------------------------------- 3. budget reserve
      // The reservation is what the call can cost at most: the CALIBRATED input estimate (measured per route against the
      // provider-reported input tokens) + the output reserve. When the remaining budget cannot hold the full output
      // reserve, the call's maxOutputTokens shrinks to what remains (never below minOutputTokens) instead of refusing a
      // call that fits; the reservation settles to the actual usage after the call.
      let reservationId: string | undefined;
      let maxOutputTokens = deps.maxOutputTokens;
      if (deps.budget) {
        const routeId = decision.routeId;
        const inputTokens = Math.ceil(contextTokensEstimate * calibration.ratio(routeId));
        const price = (outputTokens: number): number | undefined => {
          try {
            const c = router.estimateCostUsd(routeId, inputTokens, outputTokens);
            return Number.isFinite(c) ? c : undefined;
          } catch (e) {
            // The route vanished from the catalog: the router refuses the call below (and computes a fallback).
            if (!isHypertestError(e, 'not_found')) throw e;
            return undefined;
          }
        };
        if (deps.budget.remaining) {
          const left = await deps.budget.remaining(deps.budgetScopes);
          let fit = maxOutputTokens;
          if (left.tokens !== undefined) fit = Math.min(fit, Math.floor(left.tokens - inputTokens));
          const inputCost = price(0);
          const perOutput = inputCost !== undefined ? ((price(1_000_000) ?? inputCost) - inputCost) / 1_000_000 : undefined;
          if (left.costUsd !== undefined && inputCost !== undefined && perOutput !== undefined && perOutput > 0) fit = Math.min(fit, Math.floor((left.costUsd - inputCost) / perOutput));
          if (fit < maxOutputTokens && fit >= minOutputTokens) {
            logger.info('budget nearly spent: the call\'s output reserve shrinks to what remains', { agentId: agent.agentId, routeId, maxOutputTokens: fit, configured: maxOutputTokens, remaining: left });
            maxOutputTokens = fit;
          }
        }
        const amounts: { tokens: number; costUsd?: number } = { tokens: inputTokens + maxOutputTokens };
        const cost = price(maxOutputTokens);
        if (cost !== undefined) amounts.costUsd = cost;
        else logger.warn('model cost is unknown for this route; reserving tokens only', { routeId });
        const reserved = await deps.budget.reserve(deps.budgetScopes, amounts, `model:${agent.agentId}:turn:${request.turn}`);
        if (!reserved.ok) {
          const needed = `route ${routeId} needed ${amounts.tokens} tokens (input ${inputTokens} + output reserve ${maxOutputTokens})${amounts.costUsd !== undefined ? `, $${Number(amounts.costUsd.toFixed(6))}` : ''}`;
          const x = typedExhaustion(reserved.exhausted);
          if (!x) return { ok: false, boundary: 'budget_exhausted', message: `model budget exhausted for scopes ${deps.budgetScopes.join(', ')}: ${needed}` };
          const refusal: ModelBudgetRefusal = { ...x, routeId, neededTokens: amounts.tokens };
          if (amounts.costUsd !== undefined) refusal.neededCostUsd = amounts.costUsd;
          const d = x.dimension;
          const message =
            `model budget exhausted at ${x.scope} on ${d}: ${amount(d, x.used)} used + ${amount(d, x.reserved)} reserved by calls in flight + ${amount(d, x.requested)} for this call > limit ${amount(d, x.limit)}; ${needed}`;
          return { ok: false, boundary: 'budget_exhausted', message, budget: refusal };
        }
        reservationId = reserved.reservationId;
      }
      const release = async (): Promise<void> => {
        if (!deps.budget || reservationId === undefined) return;
        try {
          await deps.budget.release(reservationId);
        } catch (e) {
          logger.error('budget release failed (the reservation stays held: over-counted, never under-counted)', { reservationId, error: String(e) });
        }
      };

      // ---------------------------------------------------------------- 4. the call
      const call: InvokeRequest['call'] = {
        // Cross-model continuation rule: opaque reasoning only reaches routes of the same compatibility class.
        messages: projectForRoute(request.messages, decision.continuationCompatibilityClass),
        maxOutputTokens,
        signal: request.signal,
      };
      if (tools.length > 0) call.tools = tools;
      if (request.responseFormat) call.responseFormat = { type: 'json_schema', name: request.responseFormat.name, schema: request.responseFormat.schema };
      const invokeRouteRequest = withExcluded(routeRequest, excluded);
      const excludeRoutes = invokeRouteRequest.excludeRoutes ?? [];

      let outcome;
      try {
        outcome = await router.invoke({ decision, call, ctx }, invokeRouteRequest);
      } catch (e) {
        await release();
        throw e;
      }

      if (outcome.ok) {
        const usage = outcome.response.usage;
        if (outcome.auditPending) {
          // The router could not append model.invoked after the provider answered (retried already). The call is paid:
          // keep the response and settle its usage below (durability-10); the gap in L0 is logged loudly here.
          logger.error('model.invoked audit event missing for a paid call; response kept and usage settled', {
            routeId: outcome.routeId, turn: request.turn, code: outcome.auditPending.code, error: outcome.auditPending.message,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          });
        }
        if (deps.budget && reservationId !== undefined) {
          const actual: { tokens: number; costUsd?: number } = { tokens: usage.inputTokens + usage.outputTokens };
          if (usage.costUsd !== undefined) actual.costUsd = usage.costUsd;
          try {
            await deps.budget.settle(reservationId, actual);
          } catch (e) {
            // Never lose a paid-for response over accounting: the reservation stays held (over-counted).
            logger.error('budget settle failed after a successful model call (reservation kept)', { reservationId, error: String(e) });
          }
        }
        // the estimator, measured: the next reservations of this route use the calibrated estimate
        calibration.observe(outcome.routeId, contextTokensEstimate, usage.inputTokens);
        // a successful call ends a pause sequence (the next pause backs off from the start again)
        if (paused) await clearPause();
        return { ok: true, message: outcome.response.message, usage, routeId: outcome.routeId, epochId: epoch.epochId, stopReason: outcome.response.stopReason };
      }

      await release();
      const error = outcome.error;
      if (error.code === 'cancelled' || request.signal.aborted) return { ok: false, boundary: 'cancelled', message: error.message };
      if (outcome.fallback) {
        const fb: Omit<PendingFallback, 'createdAt'> = {
          decision: outcome.fallback,
          reason: switchReasonFor(error.code),
          fromRouteId: decision.routeId,
          fromEpochId: epoch.epochId,
          error: { code: error.code, message: error.message },
          excludedRoutes: union(excludeRoutes, [decision.routeId]),
        };
        await setPendingFallback(fb);
        return {
          ok: false,
          boundary: 'retry_next_turn',
          message: `route ${decision.routeId} failed (${error.code}: ${error.message}); fallback ${outcome.fallback.routeId} starts a new epoch at the next turn`,
        };
      }
      // ALLOW is impossible: PAUSE (transient) or fail closed (permanent), as the router classified it
      const u: ModelUnavailability = outcome.unavailable ?? {
        transient: ['rate_limited', 'unavailable', 'timeout'].includes(error.code),
        reason: `route ${decision.routeId} failed (${error.code}: ${error.message}); no eligible fallback`,
        routes: [decision.routeId],
      };
      return unavailable(u, request.turn, paused);
    },
  };
}
