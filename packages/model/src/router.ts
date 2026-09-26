import { HypertestError, retry, sleep, toHypertestError, type JsonValue } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER,
  EVENT_TYPES,
  RISK_ORDER,
  eventFrom,
  projectForRoute,
  type DataClassification,
  type EventContext,
  type ModelCapability,
} from '@hypertest/domain';
import type {
  InvokeOutcome,
  InvokeRequest,
  ModelCallRequest,
  ModelCapabilityProfile,
  ModelRouter,
  RouteDecision,
  RouteRejection,
  RouteRequest,
  ModelCallResponse,
  RouterDeps,
} from './contracts.ts';
import { FALLBACK_ELIGIBLE, SAME_ROUTE_RETRYABLE } from './errors.ts';
import { estimateCostUsd } from './usage.ts';

type OkDecision = Extract<RouteDecision, { ok: true }>;

/** Filter stages in their normative order (I3). `excluded` is reported for routes that already failed. */
export const ROUTING_STAGES = ['security', 'capability', 'role', 'quality', 'latency', 'cost'] as const;

/**
 * Attempts to append `model.invoked` after a SUCCESSFUL provider call (with a short backoff): the tokens are spent, so a
 * transient audit-store failure (lock or statement timeout) is retried rather than discarding the paid response.
 */
export const AUDIT_APPEND_ATTEMPTS = 3;
const AUDIT_RETRY_BASE_MS = 20;

/** Output tokens reserved inside the context window when checking fit. */
export const OUTPUT_RESERVE_CAP = 4096;

/** Deciding criteria of the ranking, in order. */
export type SelectionCriterion = 'only_eligible_route' | 'preferred_route' | 'quality' | 'tool_reliability' | 'latency' | 'cost' | 'route_id';

interface Candidate {
  profile: ModelCapabilityProfile;
  score: number;
  cost: number;
  prefIndex: number;
}

type Evaluation = { ok: true; candidate: Candidate } | { ok: false; rejection: RouteRejection };

export function createModelRouter(deps: RouterDeps): ModelRouter {
  return new DefaultModelRouter(deps);
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isExecutorLike(request: RouteRequest): boolean {
  return request.role === 'executor' || request.taskType.includes('execute');
}

/** Validates the request enums/numbers; unknown values would otherwise make comparisons fail OPEN. */
function requiredClassification(request: RouteRequest): { level: number; name: DataClassification } {
  const reqLevel = own(CLASSIFICATION_ORDER as Record<string, number>, request.dataClassification);
  if (reqLevel === undefined) throw new HypertestError('invalid_argument', `route request: unknown dataClassification ${String(request.dataClassification)}`);
  let level = reqLevel;
  let name: DataClassification = request.dataClassification;
  const privacy = request.policy.privacyClass;
  if (privacy !== undefined) {
    const p = own(CLASSIFICATION_ORDER as Record<string, number>, privacy);
    if (p === undefined) throw new HypertestError('invalid_argument', `route request: unknown policy.privacyClass ${String(privacy)}`);
    if (p > level) {
      level = p;
      name = privacy;
    }
  }
  return { level, name };
}

/** Optional list fields must be real arrays: `'openai-proxy'.includes('openai')` would otherwise fail OPEN. */
const POLICY_LISTS = ['preferredRoutes', 'requiredCapabilities', 'allowedProviders', 'prohibitedProviders', 'independentFromRoles'] as const;
const REQUEST_LISTS = ['providersToAvoid', 'excludeRoutes'] as const;

function assertList(value: unknown, field: string, required: boolean): void {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new HypertestError('invalid_argument', `route request: ${field} must be an array of strings`);
  }
}

/** `maxAttempts` must be finite: NaN would make zero calls, Infinity would retry forever. */
function normalizeAttempts(v: number | undefined): number {
  if (v === undefined) return 2;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HypertestError('invalid_argument', `invoke: maxAttempts must be a finite number (got ${String(v)})`);
  return Math.max(1, Math.floor(v));
}

function validateRequest(request: RouteRequest): void {
  if (!request || typeof request !== 'object') throw new HypertestError('invalid_argument', 'route request: must be an object');
  if (!request.policy || typeof request.policy !== 'object') throw new HypertestError('invalid_argument', 'route request: policy must be an object');
  assertList(request.requiredCapabilities, 'requiredCapabilities', true);
  for (const f of REQUEST_LISTS) assertList(request[f], f, false);
  for (const f of POLICY_LISTS) assertList(request.policy[f], `policy.${f}`, false);
  if (typeof request.role !== 'string' || typeof request.taskType !== 'string') throw new HypertestError('invalid_argument', 'route request: role and taskType must be strings');
  if (own(RISK_ORDER as Record<string, number>, request.actionRisk) === undefined) {
    throw new HypertestError('invalid_argument', `route request: unknown actionRisk ${String(request.actionRisk)}`);
  }
  if (!Number.isFinite(request.contextTokensEstimate) || request.contextTokensEstimate < 0) {
    throw new HypertestError('invalid_argument', `route request: contextTokensEstimate must be a finite non-negative number`);
  }
  if (!request.contextSnapshotId) throw new HypertestError('invalid_argument', 'route request: contextSnapshotId is required (I3: snapshot fixed at the boundary)');
}

class DefaultModelRouter implements ModelRouter {
  readonly #deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  async route(request: RouteRequest, ctx: EventContext): Promise<RouteDecision> {
    validateRequest(request);
    const classification = requiredClassification(request);
    if ((request.policy.independentFromRoles?.length ?? 0) > 0 && request.providersToAvoid === undefined) {
      // Independence can only be enforced from resolved providers; [] means "resolved, none used yet".
      this.#deps.logger.warn('model routing: policy.independentFromRoles is set but providersToAvoid was not resolved; reviewer independence is not enforced for this decision', {
        role: request.role,
        independentFromRoles: request.policy.independentFromRoles,
      });
    }
    const catalog = this.#deps.catalog;
    const revision = catalog.revision;
    const rejected: RouteRejection[] = [];
    const candidates: Candidate[] = [];
    for (const profile of catalog.list()) {
      const ev = this.#evaluate(profile, request, classification);
      if (ev.ok) candidates.push(ev.candidate);
      else rejected.push(ev.rejection);
    }

    const criteria = rankingCriteria(isExecutorLike(request));
    const compare = (a: Candidate, b: Candidate): number => {
      for (const c of criteria) {
        const r = c.cmp(a, b);
        if (r !== 0) return r;
      }
      return 0;
    };
    candidates.sort(compare);

    const base = { snapshotId: request.contextSnapshotId, catalogRevision: revision, role: request.role, taskType: request.taskType, agentId: request.agentId };
    const top = candidates[0];
    if (!top) {
      this.#deps.logger.warn('model routing: no eligible route', { role: request.role, taskType: request.taskType, rejected: rejected.length });
      await this.#emit(ctx, EVENT_TYPES.modelRouted, request.agentId, {
        ok: false,
        reason: 'no_eligible_route',
        routeId: null,
        provider: null,
        model: null,
        fallbackChain: [],
        rejected: rejected as unknown as JsonValue,
        ...base,
      });
      return { ok: false, reason: 'no_eligible_route', rejected };
    }

    let selectedByPolicy: SelectionCriterion = 'only_eligible_route';
    const second = candidates[1];
    if (second) {
      for (const c of criteria) {
        if (c.cmp(top, second) !== 0) {
          selectedByPolicy = c.name;
          break;
        }
      }
    }
    const p = top.profile;
    const decision: OkDecision = {
      ok: true,
      routeId: p.routeId,
      provider: p.provider,
      model: p.model,
      fallbackChain: candidates.slice(1).map((c) => c.profile.routeId),
      selectedByPolicy,
      capabilityProfileRevision: revision,
      continuationCompatibilityClass: p.continuationCompatibilityClass,
      rejected,
    };
    const effort = request.policy.reasoningEffort ?? p.reasoningEffort;
    if (effort !== undefined) decision.reasoningEffort = effort;

    this.#deps.logger.debug('model routed', { routeId: p.routeId, role: request.role, selectedByPolicy, rejected: rejected.length });
    await this.#emit(ctx, EVENT_TYPES.modelRouted, request.agentId, {
      ok: true,
      routeId: p.routeId,
      provider: p.provider,
      model: p.model,
      selectedByPolicy,
      score: top.score,
      reasoningEffort: effort ?? null,
      fallbackChain: decision.fallbackChain,
      rejected: rejected as unknown as JsonValue,
      ...base,
    });
    return decision;
  }

  /** Runs the ordered filter stages for one route; the first failing stage is recorded. */
  #evaluate(p: ModelCapabilityProfile, request: RouteRequest, classification: { level: number; name: DataClassification }): Evaluation {
    const reject = (stage: RouteRejection['stage'], reason: string): Evaluation => ({ ok: false, rejection: { routeId: p.routeId, stage, reason } });
    const policy = request.policy;

    // 1. security / data boundary (`enabled` must be exactly true: foreign catalogs are not trusted to be well-typed)
    if (p.enabled !== true) return reject('security', 'route disabled');
    if (request.excludeRoutes?.includes(p.routeId)) return reject('excluded', 'route already failed in this epoch sequence');
    if (policy.allowedProviders !== undefined && !policy.allowedProviders.includes(p.provider)) {
      return reject('security', `provider ${p.provider} not in allowedProviders`);
    }
    if (policy.prohibitedProviders?.includes(p.provider)) return reject('security', `provider ${p.provider} is prohibited`);
    const routeClass = own(CLASSIFICATION_ORDER as Record<string, number>, p.maxDataClassification);
    if (routeClass === undefined) return reject('security', `unknown maxDataClassification ${String(p.maxDataClassification)}`);
    if (routeClass < classification.level) {
      return reject('security', `route accepts data up to ${p.maxDataClassification}; request carries ${classification.name}`);
    }
    const routeRisk = own(RISK_ORDER as Record<string, number>, p.maxActionRisk);
    if (routeRisk === undefined) return reject('security', `unknown maxActionRisk ${String(p.maxActionRisk)}`);
    if (routeRisk < RISK_ORDER[request.actionRisk]) return reject('security', `route may drive actions up to ${p.maxActionRisk}; request needs ${request.actionRisk}`);
    if (request.providersToAvoid?.includes(p.provider)) return reject('security', `provider ${p.provider} must be avoided (independence)`);

    // 2. capability
    if (!this.#deps.providers.has(p.provider)) return reject('capability', `no adapter registered for provider ${p.provider}`);
    const required = new Set<ModelCapability>([...request.requiredCapabilities, ...(policy.requiredCapabilities ?? [])]);
    const routeCaps: readonly unknown[] = Array.isArray(p.capabilities) ? p.capabilities : [];
    const missing = [...required].filter((c) => !routeCaps.includes(c)).sort();
    if (missing.length > 0) return reject('capability', `missing capabilities: ${missing.join(', ')}`);
    if (request.structuredOutput && p.structuredOutput === 'none') return reject('capability', 'structured output not supported');
    const needed = request.contextTokensEstimate + Math.min(p.maxOutputTokens, OUTPUT_RESERVE_CAP);
    if (!(p.contextWindow >= needed)) return reject('capability', `context window ${p.contextWindow} < ${needed} (context + output reserve)`);

    // 3. role suitability, then quality floor
    const explicit = own(p.quality, request.role) ?? own(p.quality, request.taskType);
    if (explicit !== undefined && !(explicit > 0)) return reject('role', `route declares quality ${explicit} for ${request.role}/${request.taskType}`);
    const score = explicit ?? own(p.quality, 'default') ?? 0;
    if (!Number.isFinite(score)) return reject('quality', 'non-finite quality score');
    if (policy.minQuality !== undefined && !(score >= policy.minQuality)) return reject('quality', `quality ${score} < minQuality ${policy.minQuality}`);

    // 4. latency
    if (policy.latencyBudgetMs !== undefined && !(p.typicalLatencyMs <= policy.latencyBudgetMs)) {
      return reject('latency', `typical latency ${p.typicalLatencyMs}ms > budget ${policy.latencyBudgetMs}ms`);
    }

    // 5. cost (never first)
    const cost = estimateCostUsd(p, request.contextTokensEstimate, p.maxOutputTokens);
    if (policy.maxCostPerCallUsd !== undefined && !(cost <= policy.maxCostPerCallUsd)) {
      return reject('cost', `estimated cost $${Number.isFinite(cost) ? cost.toFixed(6) : 'NaN'} > limit $${policy.maxCostPerCallUsd}`);
    }

    const pref = policy.preferredRoutes?.indexOf(p.routeId) ?? -1;
    return { ok: true, candidate: { profile: p, score, cost: Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY, prefIndex: pref < 0 ? Number.POSITIVE_INFINITY : pref } };
  }

  async invoke(request: InvokeRequest, routeRequest: RouteRequest): Promise<InvokeOutcome> {
    const { decision, call, ctx } = request;
    // Malformed inputs are caller faults (thrown, no events), exactly like route().
    const maxAttempts = normalizeAttempts(request.maxAttempts);
    validateRequest(routeRequest);
    const classification = requiredClassification(routeRequest);
    const startedMs = this.#deps.clock.nowMs();
    const identity = { routeId: decision.routeId, provider: decision.provider, model: decision.model, snapshotId: routeRequest.contextSnapshotId };
    let attempts = 0;
    let response: ModelCallResponse;
    let profile: ModelCapabilityProfile;
    // Only the decision check and the provider call are inside this try: a failure there is a MODEL outcome
    // (reported + possibly a fallback). Anything after the call succeeded (e.g. the audit sink) is a fault.
    try {
      profile = this.#checkDecision(decision, routeRequest, classification);
      const provider = this.#deps.providers.get(decision.provider);
      const callRequest = buildCallRequest(call, decision, profile, routeRequest);
      const retryOptions: Parameters<typeof retry>[1] = {
        attempts: maxAttempts,
        baseDelayMs: this.#deps.retry?.baseDelayMs ?? 250,
        maxDelayMs: this.#deps.retry?.maxDelayMs ?? 4000,
        isRetryable: (e) => e instanceof HypertestError && SAME_ROUTE_RETRYABLE.has(e.code),
      };
      if (call.signal) retryOptions.signal = call.signal;
      response = await retry(async (attempt) => {
        attempts = attempt;
        if (attempt > 1) this.#deps.logger.info('model call retry', { routeId: decision.routeId, attempt });
        return provider.complete(callRequest, request.onDelta ? { onDelta: request.onDelta } : {});
      }, retryOptions);
    } catch (e) {
      let err = toHypertestError(e);
      if (call.signal?.aborted && err.code !== 'cancelled') {
        // The caller gave up (whatever its abort reason, e.g. its own turn deadline): not a route failure, no fallback.
        err = new HypertestError('cancelled', `model call cancelled by caller: ${err.message}`, { retryable: false, cause: err });
      }
      return this.#failed(err, attempts, startedMs, identity, decision, routeRequest, call, ctx);
    }
    if (response.usage.costUsd === undefined) {
      response.usage.costUsd = estimateCostUsd(profile, response.usage.inputTokens, response.usage.outputTokens);
    }
    const opaque = response.message.reasoning?.opaque;
    if (opaque && opaque.compatibilityClass !== profile.continuationCompatibilityClass) {
      // The router only replays opaque reasoning of the route's declared class; a provider that tags a different
      // class means the catalog's continuationCompatibilityClass is misconfigured for this route.
      this.#deps.logger.warn('model response carries opaque reasoning of another continuation class; it will not be replayed to this route', {
        routeId: decision.routeId,
        declaredClass: profile.continuationCompatibilityClass,
        responseClass: opaque.compatibilityClass,
      });
    }
    const invoked: Record<string, JsonValue> = {
      ok: true,
      ...identity,
      attempts,
      usage: response.usage as unknown as JsonValue,
      latencyMs: response.latencyMs,
      stopReason: response.stopReason,
      providerResponseId: response.providerResponseId ?? null,
    };
    const outcome: InvokeOutcome = { ok: true, response, routeId: decision.routeId, attempts };
    // The provider answered: its tokens are spent. An audit append that fails now must not discard the response
    // (the caller would release the budget reservation — usage never charged — and re-pay the call on retry): retry
    // the append, and if the store stays unavailable return the response flagged as audit-pending.
    for (let i = 1; ; i++) {
      try {
        await this.#emit(ctx, EVENT_TYPES.modelInvoked, routeRequest.agentId, invoked);
        break;
      } catch (e) {
        const err = toHypertestError(e);
        if (i >= AUDIT_APPEND_ATTEMPTS) {
          this.#deps.logger.error('model.invoked could not be recorded after a successful (paid) call; returning the response as audit-pending', {
            routeId: decision.routeId, provider: decision.provider, attempts: i, code: err.code, error: err.message, usage: response.usage as unknown as JsonValue,
          });
          outcome.auditPending = { code: err.code, message: err.message };
          break;
        }
        this.#deps.logger.warn('model.invoked append failed after a successful call; retrying', { routeId: decision.routeId, attempt: i, code: err.code, error: err.message });
        await sleep(AUDIT_RETRY_BASE_MS * 2 ** (i - 1));
      }
    }
    return outcome;
  }

  /**
   * The decision must still be valid for the CURRENT request (I3 fail-closed): same catalog revision, the route
   * unchanged, and every filter stage (security first) passing for this request. A decision may be reused across
   * turns of an epoch while the request changes (data classification, action risk, independence, context size).
   */
  #checkDecision(decision: OkDecision, routeRequest: RouteRequest, classification: { level: number; name: DataClassification }): ModelCapabilityProfile {
    const catalog = this.#deps.catalog;
    const profile = catalog.get(decision.routeId);
    if (!profile || profile.provider !== decision.provider || profile.model !== decision.model || profile.continuationCompatibilityClass !== decision.continuationCompatibilityClass) {
      throw new HypertestError('precondition_failed', `route ${decision.routeId} is no longer available as decided`, { retryable: false, details: { routeId: decision.routeId } });
    }
    if (decision.capabilityProfileRevision !== catalog.revision) {
      throw new HypertestError('precondition_failed', `decision was made against catalog ${decision.capabilityProfileRevision}; current is ${catalog.revision}`, { retryable: false, details: { routeId: decision.routeId } });
    }
    const ev = this.#evaluate(profile, routeRequest, classification);
    if (!ev.ok) {
      const { stage, reason } = ev.rejection;
      throw new HypertestError('precondition_failed', `route ${decision.routeId} is not eligible for this request (${stage}): ${reason}`, {
        retryable: false,
        details: { routeId: decision.routeId, stage, reason },
      });
    }
    return profile;
  }

  async #failed(
    err: HypertestError,
    attempts: number,
    startedMs: number,
    identity: Record<string, JsonValue>,
    decision: OkDecision,
    routeRequest: RouteRequest,
    call: InvokeRequest['call'],
    ctx: EventContext,
  ): Promise<InvokeOutcome> {
    const error = { code: err.code, message: err.message, retryable: err.retryable };
    await this.#emit(ctx, EVENT_TYPES.modelInvoked, routeRequest.agentId, {
      ok: false,
      ...identity,
      attempts,
      error,
      latencyMs: Math.max(0, this.#deps.clock.nowMs() - startedMs),
    });
    const outcome: InvokeOutcome = { ok: false, error, attempts };
    if (!FALLBACK_ELIGIBLE.has(err.code)) return outcome;

    const failClosed = routeRequest.policy.fallback === 'fail_closed';
    const excludeRoutes = [...new Set([...(routeRequest.excludeRoutes ?? []), decision.routeId])];
    if (failClosed) {
      this.#deps.logger.warn('model fallback blocked by fail_closed policy', { from: decision.routeId, reason: err.code });
      await this.#emit(ctx, EVENT_TYPES.modelFallback, routeRequest.agentId, {
        from: decision.routeId,
        to: null,
        reason: err.code,
        policy: 'fail_closed',
        excludeRoutes,
        snapshotId: routeRequest.contextSnapshotId,
      });
      return outcome;
    }
    // Full re-validation (security → capability incl. tool compatibility → quality → …) of every remaining route.
    const next = await this.route(fallbackRequest(routeRequest, excludeRoutes, call, this.#deps.catalog.get(decision.routeId)), ctx);
    await this.#emit(ctx, EVENT_TYPES.modelFallback, routeRequest.agentId, {
      from: decision.routeId,
      to: next.ok ? next.routeId : null,
      reason: err.code,
      policy: 'revalidated',
      excludeRoutes,
      snapshotId: routeRequest.contextSnapshotId,
    });
    if (next.ok) outcome.fallback = next;
    return outcome;
  }

  estimateCostUsd(routeId: string, inputTokens: number, outputTokens: number): number {
    const p = this.#deps.catalog.get(routeId);
    if (!p) throw new HypertestError('not_found', `unknown route ${routeId}`, { details: { routeId } });
    return estimateCostUsd(p, inputTokens, outputTokens);
  }

  async #emit(ctx: EventContext, type: string, aggregateId: string, payload: Record<string, JsonValue>): Promise<void> {
    if (!this.#deps.events) return;
    await this.#deps.events.emit([eventFrom(ctx, type, 'model', aggregateId, payload)]);
  }
}

function rankingCriteria(executorLike: boolean): Array<{ name: SelectionCriterion; cmp: (a: Candidate, b: Candidate) => number }> {
  const list: Array<{ name: SelectionCriterion; cmp: (a: Candidate, b: Candidate) => number }> = [
    { name: 'preferred_route', cmp: (a, b) => cmpNum(a.prefIndex, b.prefIndex) },
    { name: 'quality', cmp: (a, b) => cmpNum(b.score, a.score) },
  ];
  if (executorLike) list.push({ name: 'tool_reliability', cmp: (a, b) => cmpNum(finiteOr(b.profile.toolReliability, -1), finiteOr(a.profile.toolReliability, -1)) });
  list.push(
    { name: 'latency', cmp: (a, b) => cmpNum(finiteOr(a.profile.typicalLatencyMs, Number.POSITIVE_INFINITY), finiteOr(b.profile.typicalLatencyMs, Number.POSITIVE_INFINITY)) },
    { name: 'cost', cmp: (a, b) => cmpNum(a.cost, b.cost) },
    { name: 'route_id', cmp: (a, b) => (a.profile.routeId < b.profile.routeId ? -1 : a.profile.routeId > b.profile.routeId ? 1 : 0) },
  );
  return list;
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The re-route request for a fallback (I3 "tool compatibility"): besides the caller's declared requirements, the
 * fallback must serve what the failed call actually used — tools, a response format, images — as far as the failed
 * route declared those capabilities (so an under-declared catalog is not made unroutable by the fallback).
 */
function fallbackRequest(routeRequest: RouteRequest, excludeRoutes: string[], call: InvokeRequest['call'], failed: ModelCapabilityProfile | undefined): RouteRequest {
  const next: RouteRequest = { ...routeRequest, excludeRoutes };
  if (!failed) return next;
  const declared: readonly unknown[] = Array.isArray(failed.capabilities) ? failed.capabilities : [];
  const derived: ModelCapability[] = [];
  if ((call.tools?.length ?? 0) > 0 && declared.includes('tool_use')) derived.push('tool_use');
  const hasImage = call.messages.some((m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'));
  if (hasImage && declared.includes('vision')) derived.push('vision');
  if (derived.length > 0) next.requiredCapabilities = [...new Set([...routeRequest.requiredCapabilities, ...derived])];
  if (call.responseFormat && failed.structuredOutput !== 'none') next.structuredOutput = true;
  return next;
}

function buildCallRequest(call: InvokeRequest['call'], decision: OkDecision, profile: ModelCapabilityProfile, routeRequest: RouteRequest): ModelCallRequest {
  const req: ModelCallRequest = {
    ...call,
    model: decision.model,
    // Opaque reasoning is only replayed to routes of the same continuation class.
    messages: projectForRoute(call.messages, decision.continuationCompatibilityClass),
  };
  const effort = call.reasoningEffort ?? decision.reasoningEffort;
  if (effort !== undefined) req.reasoningEffort = effort;
  const temperature = call.temperature ?? routeRequest.policy.temperature;
  if (temperature !== undefined) req.temperature = temperature;
  if (call.maxOutputTokens !== undefined) req.maxOutputTokens = Math.min(call.maxOutputTokens, profile.maxOutputTokens);
  if (profile.extra || call.extra) req.extra = { ...(profile.extra ?? {}), ...(call.extra ?? {}) };
  return req;
}
