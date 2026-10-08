import { HypertestError, retry, sleep, toHypertestError, type JsonValue } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER,
  EVENT_TYPES,
  RISK_ORDER,
  eventFrom,
  projectForRoute,
  type DataClassification,
  type DomainEventInput,
  type EventContext,
  type ModelCapability,
} from '@hypertest/domain';
import type {
  CircuitSnapshot,
  DecisionCheck,
  InvokeOutcome,
  ModelUnavailability,
  ObservedPrice,
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
import { AVAILABILITY_FAILURES, CircuitBreakers, type CircuitTransition, type PriceViolation } from './circuit.ts';
import { FALLBACK_ELIGIBLE, SAME_ROUTE_RETRYABLE } from './errors.ts';
import { costKnown, estimateCostUsd } from './usage.ts';

type OkDecision = Extract<RouteDecision, { ok: true }>;

/**
 * Filter stages in their normative order (I3). `excluded` is reported for routes that already failed. (additive)
 * `availability` (circuit breaker / price guard) comes after quality: it only ever rejects routes every earlier stage
 * accepted, so it can never admit an ineligible route.
 */
export const ROUTING_STAGES = ['security', 'capability', 'role', 'quality', 'availability', 'latency', 'cost'] as const;

/** (additive) L0 events of the circuit breaker (aggregate `model`, aggregateId = routeId). */
export const MODEL_CIRCUIT_EVENTS = Object.freeze({ opened: 'model.circuit_opened', closed: 'model.circuit_closed' } as const);

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

/** Price-guard observations collected while routing (turned into circuit events). */
interface PriceNote {
  profile: ModelCapabilityProfile;
  violation?: PriceViolation;
  /** (A[1]) An observed-price change guard note (kind `change`) instead of a ceiling note. */
  change?: { violated: boolean; observed?: ObservedPrice; increasePct: number; maxIncreasePct: number };
}

/** The rejection stages after which a route may come back by itself (pause, never fail closed). */
const TRANSIENT_STAGES: ReadonlySet<RouteRejection['stage']> = new Set(['availability', 'excluded']);

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
  readonly #breakers: CircuitBreakers | undefined;
  /** (A[1]) Observed prices by route id, refreshed from deps.prices at every safe point (route/invoke/validate). */
  #observed: ReadonlyMap<string, ObservedPrice> = new Map();
  /** (A[1]) Routes whose observed price is currently beyond the change guard (circuit open, reason price_change). */
  readonly #priceChanged = new Set<string>();
  readonly #maxIncreasePct: number | undefined;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#breakers = deps.circuitBreaker === false ? undefined : new CircuitBreakers(deps.circuitBreaker ?? {});
    const pct = deps.circuitBreaker === false ? undefined : deps.circuitBreaker?.priceGuard?.maxIncreasePct;
    if (pct !== undefined && !(typeof pct === 'number' && Number.isFinite(pct) && pct >= 0)) {
      throw new HypertestError('invalid_argument', `circuitBreaker.priceGuard.maxIncreasePct must be a finite number ≥ 0 (got ${String(pct)})`);
    }
    this.#maxIncreasePct = pct;
  }

  get catalogRevision(): string {
    return this.#deps.catalog.revision;
  }

  circuits(): CircuitSnapshot[] {
    return this.#breakers ? this.#breakers.snapshots(this.#deps.clock.nowMs()) : [];
  }

  probeNow(routeIds?: string[]): string[] {
    if (!this.#breakers) return [];
    const nowMs = this.#deps.clock.nowMs();
    const ids = routeIds ?? this.#deps.catalog.list().map((p) => p.routeId);
    const probed = ids.filter((id) => this.#breakers!.forceHalfOpen(id, nowMs));
    if (probed.length > 0) this.#deps.logger.info('model circuits half-open on operator request: the next call on each is its probe', { routes: probed });
    return probed.sort();
  }

  /**
   * (A[1]) Refreshes the observed prices at a safe point (a turn boundary: the start of route / invoke / validate). A
   * failing price source keeps the last observed prices (logged): the guard never flaps open on a read error, and the
   * catalog prices stay in force for routes never observed.
   */
  async #refreshPrices(): Promise<void> {
    const source = this.#deps.prices;
    if (!source) return;
    try {
      const current = await source.current();
      const next = new Map<string, ObservedPrice>();
      for (const [routeId, price] of Object.entries(current ?? {})) {
        const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
        if (!price || !ok(price.inputPerMillionUsd) || !ok(price.outputPerMillionUsd)) {
          this.#deps.logger.warn('observed model price ignored: prices must be finite numbers ≥ 0', { routeId });
          continue;
        }
        next.set(routeId, price);
      }
      this.#observed = next;
    } catch (e) {
      this.#deps.logger.error('model price source could not be read; keeping the last observed prices', { error: (e as Error).message });
    }
  }

  /** The profile priced at its observed price (when one is observed): what a call on it costs now. */
  #priced(p: ModelCapabilityProfile): ModelCapabilityProfile {
    const o = this.#observed.get(p.routeId);
    if (!o) return p;
    return { ...p, costPerMillionInputUsd: o.inputPerMillionUsd, costPerMillionOutputUsd: o.outputPerMillionUsd };
  }

  /** (A[1]) The price-change guard: observed price vs catalog price, beyond maxIncreasePct ⇒ violated. */
  #priceChange(p: ModelCapabilityProfile): PriceNote['change'] | undefined {
    const max = this.#maxIncreasePct;
    if (max === undefined) return undefined;
    const o = this.#observed.get(p.routeId);
    // no observed price (or no catalog price to compare with): within the guard — a tripped route closes again
    if (!o || !costKnown(p)) return { violated: false, increasePct: 0, maxIncreasePct: max };
    const pct = (observed: number, catalog: number) => (observed <= catalog ? 0 : catalog === 0 ? Number.POSITIVE_INFINITY : ((observed - catalog) / catalog) * 100);
    const increasePct = Math.max(pct(o.inputPerMillionUsd, p.costPerMillionInputUsd!), pct(o.outputPerMillionUsd, p.costPerMillionOutputUsd!));
    return { violated: increasePct > max, observed: o, increasePct, maxIncreasePct: max };
  }

  /**
   * Classifies a request no route can serve: transient (an open/half-open circuit, a price guard, an availability failure,
   * routes that failed earlier in this epoch sequence) ⇒ the work pauses until `retryAt`; otherwise permanent (fail closed).
   */
  #unavailability(rejected: readonly RouteRejection[], failure?: { routeId: string; err: HypertestError }): ModelUnavailability {
    const nowMs = this.#deps.clock.nowMs();
    const routes = [...new Set([...(failure ? [failure.routeId] : []), ...rejected.map((r) => r.routeId)])];
    const retryCandidates: number[] = [];
    const halfOpenOf = (routeId: string) => {
      const snap = this.#breakers?.snapshot(routeId, nowMs);
      if (snap && snap.state === 'open' && snap.halfOpenAt) retryCandidates.push(Date.parse(snap.halfOpenAt));
    };
    let transient = false;
    const why: string[] = [];
    if (failure) {
      const { err } = failure;
      const stage = (err.details as { stage?: unknown } | undefined)?.stage;
      if (AVAILABILITY_FAILURES.has(err.code) || (err.code === 'precondition_failed' && typeof stage === 'string' && TRANSIENT_STAGES.has(stage as RouteRejection['stage']))) {
        transient = true;
        const retryAfterMs = (err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
        if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) retryCandidates.push(nowMs + retryAfterMs);
        halfOpenOf(failure.routeId);
      }
      why.push(`route ${failure.routeId} failed (${err.code}: ${err.message})`);
    }
    for (const r of rejected) {
      if (TRANSIENT_STAGES.has(r.stage)) {
        transient = true;
        halfOpenOf(r.routeId);
      }
      why.push(`${r.routeId}: ${r.stage} (${r.reason})`);
    }
    const out: ModelUnavailability = {
      transient,
      reason: `${transient ? 'no model route is available now' : 'no configured model route may serve this request'}${why.length > 0 ? `: ${why.join('; ')}` : ''}`,
      routes,
    };
    if (transient && retryCandidates.length > 0) out.retryAt = new Date(Math.min(...retryCandidates)).toISOString();
    return out;
  }

  async validate(decision: OkDecision, routeRequest: RouteRequest): Promise<DecisionCheck> {
    validateRequest(routeRequest);
    await this.#refreshPrices();
    const classification = requiredClassification(routeRequest);
    try {
      this.#checkDecision(decision, routeRequest, classification);
      return { ok: true };
    } catch (e) {
      const err = toHypertestError(e);
      if (err.code !== 'precondition_failed') throw err;
      const rawStage = (err.details as { stage?: unknown } | undefined)?.stage;
      const stage = typeof rawStage === 'string' ? (rawStage as RouteRejection['stage'] | 'catalog') : 'catalog';
      const transient = stage !== 'catalog' && TRANSIENT_STAGES.has(stage);
      const out: DecisionCheck = { ok: false, stage, reason: err.message, transient };
      if (transient) {
        const u = this.#unavailability([{ routeId: decision.routeId, stage: stage as RouteRejection['stage'], reason: err.message }]);
        if (u.retryAt) out.retryAt = u.retryAt;
      }
      return out;
    }
  }

  async route(request: RouteRequest, ctx: EventContext): Promise<RouteDecision> {
    validateRequest(request);
    await this.#refreshPrices();
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
    const priceNotes: PriceNote[] = [];
    for (const profile of catalog.list()) {
      const ev = this.#evaluate(profile, request, classification, priceNotes);
      if (ev.ok) candidates.push(ev.candidate);
      else rejected.push(ev.rejection);
    }
    await this.#notePrices(ctx, request, revision, priceNotes);

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
      return { ok: false, reason: 'no_eligible_route', rejected, unavailable: this.#unavailability(rejected) };
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
  #evaluate(p: ModelCapabilityProfile, request: RouteRequest, classification: { level: number; name: DataClassification }, priceNotes?: PriceNote[]): Evaluation {
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
    // e2e[3]: a provider without its required credential is unavailable — no request ever leaves the process for it
    const providerState = this.#deps.providers.get(p.provider).availability?.();
    if (providerState && providerState.ok !== true) return reject('capability', `provider ${p.provider} is unavailable: ${providerState.reason}`);
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

    // 4. availability (circuit breaker, price guard) — after every eligibility stage: it only ever rejects
    const priced = this.#priced(p);
    if (this.#breakers) {
      const v = this.#breakers.availability(p.routeId, this.#deps.clock.nowMs());
      if (!v.available) return reject('availability', v.reason);
      // A[1]: an observed price beyond the change guard opens the route's circuit for every request
      const change = this.#priceChange(p);
      if (change) {
        priceNotes?.push({ profile: p, change });
        if (change.violated) {
          return reject(
            'availability',
            `circuit open (price_change): observed price $${change.observed?.inputPerMillionUsd}/$${change.observed?.outputPerMillionUsd} per M in/out is ${Number.isFinite(change.increasePct) ? `+${change.increasePct.toFixed(1)}%` : 'an unbounded increase'} over the catalog price $${p.costPerMillionInputUsd}/$${p.costPerMillionOutputUsd} (priceGuard.maxIncreasePct ${change.maxIncreasePct}%)`,
          );
        }
      }
      const price = this.#breakers.priceCheck(priced, request);
      if (price.applies) {
        priceNotes?.push(price.violation ? { profile: p, violation: price.violation } : { profile: p });
        if (price.violation) {
          const { price: pr, ceiling } = price.violation;
          return reject(
            'availability',
            `circuit open for cost-limited policies: catalog price $${pr.inputPerMillionUsd}/$${pr.outputPerMillionUsd} per M in/out exceeds the ceiling $${ceiling.inputPerMillionUsd ?? '∞'}/$${ceiling.outputPerMillionUsd ?? '∞'}`,
          );
        }
      }
    }

    // 5. latency
    if (policy.latencyBudgetMs !== undefined && !(p.typicalLatencyMs <= policy.latencyBudgetMs)) {
      return reject('latency', `typical latency ${p.typicalLatencyMs}ms > budget ${policy.latencyBudgetMs}ms`);
    }

    // 6. cost (never first). A[2]: an undeclared price is unknown — never routed for a cost-limited request
    const cost = estimateCostUsd(priced, request.contextTokensEstimate, p.maxOutputTokens);
    const costLimited = policy.maxCostPerCallUsd !== undefined || request.costBudgeted === true || request.cheaperThanUsd !== undefined;
    if (costLimited && !costKnown(priced)) {
      return reject('cost', 'route cost is unknown (no costPerMillionInputUsd/costPerMillionOutputUsd declared or observed) and the request is cost-limited');
    }
    if (policy.maxCostPerCallUsd !== undefined && !(cost <= policy.maxCostPerCallUsd)) {
      return reject('cost', `estimated cost $${Number.isFinite(cost) ? cost.toFixed(6) : 'NaN'} > limit $${policy.maxCostPerCallUsd}`);
    }
    if (request.cheaperThanUsd !== undefined && !(cost < request.cheaperThanUsd)) {
      return reject('cost', `estimated cost $${Number.isFinite(cost) ? cost.toFixed(6) : 'NaN'} is not below $${request.cheaperThanUsd} (budget pressure: a cheaper route is required)`);
    }

    const pref = policy.preferredRoutes?.indexOf(p.routeId) ?? -1;
    return { ok: true, candidate: { profile: p, score, cost: Number.isFinite(cost) ? cost : Number.POSITIVE_INFINITY, prefIndex: pref < 0 ? Number.POSITIVE_INFINITY : pref } };
  }

  async invoke(request: InvokeRequest, routeRequest: RouteRequest): Promise<InvokeOutcome> {
    const { decision, call, ctx } = request;
    // Malformed inputs are caller faults (thrown, no events), exactly like route().
    const maxAttempts = normalizeAttempts(request.maxAttempts);
    validateRequest(routeRequest);
    await this.#refreshPrices();
    const classification = requiredClassification(routeRequest);
    const startedMs = this.#deps.clock.nowMs();
    const identity = { routeId: decision.routeId, provider: decision.provider, model: decision.model, snapshotId: routeRequest.contextSnapshotId };
    let attempts = 0;
    let response: ModelCallResponse;
    let profile: ModelCapabilityProfile;
    const breakers = this.#breakers;
    const transitions: CircuitTransition[] = [];
    /** A half-open probe slot this call holds until the breaker got its verdict. */
    let probe = false;
    let probeSettled = false;
    /** Price-guard observations of the decision's re-check (recorded as circuit events whatever the outcome). */
    const priceNotes: PriceNote[] = [];
    // Only the decision check and the provider call are inside this try: a failure there is a MODEL outcome
    // (reported + possibly a fallback). Anything after the call succeeded (e.g. the audit sink) is a fault.
    try {
      // the decision is re-validated for THIS request — including the availability stage: an open breaker refuses here,
      // before any provider call (precondition_failed ⇒ re-validated fallback, or none under fail_closed)
      profile = this.#checkDecision(decision, routeRequest, classification, priceNotes);
      if (breakers) {
        const slot = breakers.acquire(decision.routeId, this.#deps.clock.nowMs());
        if (slot.kind === 'refused') {
          throw new HypertestError('precondition_failed', `route ${decision.routeId} is not eligible for this request (availability): ${slot.reason}`, {
            retryable: false,
            details: { routeId: decision.routeId, stage: 'availability', reason: slot.reason },
          });
        }
        probe = slot.kind === 'probe';
        if (probe) this.#deps.logger.info('model circuit half-open: this call is the single probe', { routeId: decision.routeId });
      }
      const provider = this.#deps.providers.get(decision.provider);
      const callRequest = buildCallRequest(call, decision, profile, routeRequest);
      const retryOptions: Parameters<typeof retry>[1] = {
        // a half-open probe is ONE call: no same-route retries
        attempts: probe ? 1 : maxAttempts,
        baseDelayMs: this.#deps.retry?.baseDelayMs ?? 250,
        maxDelayMs: this.#deps.retry?.maxDelayMs ?? 4000,
        // never retry into a breaker that opened on this very failure
        isRetryable: (e) => e instanceof HypertestError && SAME_ROUTE_RETRYABLE.has(e.code) && (!breakers || breakers.mayRetry(decision.routeId, probe)),
      };
      if (call.signal) retryOptions.signal = call.signal;
      response = await retry(async (attempt) => {
        attempts = attempt;
        if (attempt > 1) this.#deps.logger.info('model call retry', { routeId: decision.routeId, attempt });
        try {
          return await provider.complete(callRequest, request.onDelta ? { onDelta: request.onDelta } : {});
        } catch (e) {
          // every failed provider attempt is an availability signal for the breaker — unless the caller gave up
          if (breakers && !call.signal?.aborted) {
            const t = breakers.onFailure(decision.routeId, toHypertestError(e).code, this.#deps.clock.nowMs(), probe);
            if (probe) probeSettled = true;
            if (t) {
              transitions.push(t);
              this.#deps.logger.warn('model circuit opened', { routeId: decision.routeId, reason: t.kind === 'opened' ? t.reason : undefined, code: toHypertestError(e).code });
            }
          }
          throw e;
        }
      }, retryOptions);
      if (breakers) {
        const t = breakers.onSuccess(decision.routeId, this.#deps.clock.nowMs(), probe);
        if (probe) probeSettled = true;
        if (t) {
          transitions.push(t);
          this.#deps.logger.info('model circuit closed: the probe succeeded', { routeId: decision.routeId });
        }
      }
    } catch (e) {
      // a probe that ended without a verdict (never sent, cancelled by the caller) frees its slot: the next call probes
      if (probe && !probeSettled) breakers?.releaseProbe(decision.routeId);
      let err = toHypertestError(e);
      if (call.signal?.aborted && err.code !== 'cancelled') {
        // The caller gave up (whatever its abort reason, e.g. its own turn deadline): not a route failure, no fallback.
        err = new HypertestError('cancelled', `model call cancelled by caller: ${err.message}`, { retryable: false, cause: err });
      }
      await this.#notePrices(ctx, routeRequest, this.#deps.catalog.revision, priceNotes);
      return this.#failed(err, attempts, startedMs, identity, decision, routeRequest, call, ctx, transitions);
    }
    await this.#notePrices(ctx, routeRequest, this.#deps.catalog.revision, priceNotes);
    if (response.usage.costUsd === undefined) {
      // priced at the observed price when one is known; an unknown price leaves the cost unknown (never $0, A[2])
      const estimated = estimateCostUsd(this.#priced(profile), response.usage.inputTokens, response.usage.outputTokens);
      if (Number.isFinite(estimated)) response.usage.costUsd = estimated;
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
      // (additive) the caller's token estimate of this call's input: measured against usage.inputTokens (calibration)
      estimatedInputTokens: Number.isFinite(routeRequest.contextTokensEstimate) ? routeRequest.contextTokensEstimate : null,
    };
    const outcome: InvokeOutcome = { ok: true, response, routeId: decision.routeId, attempts };
    // The provider answered: its tokens are spent. An audit append that fails now must not discard the response
    // (the caller would release the budget reservation — usage never charged — and re-pay the call on retry): retry
    // the append, and if the store stays unavailable return the response flagged as audit-pending.
    const circuitEvents = transitions.map((t) => this.#circuitEvent(ctx, t, decision, routeRequest.contextSnapshotId));
    for (let i = 1; ; i++) {
      try {
        // one batch: the call and the breaker transition it caused are recorded together (I10)
        if (this.#deps.events) await this.#deps.events.emit([eventFrom(ctx, EVENT_TYPES.modelInvoked, 'model', routeRequest.agentId, invoked), ...circuitEvents]);
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
  #checkDecision(decision: OkDecision, routeRequest: RouteRequest, classification: { level: number; name: DataClassification }, priceNotes?: PriceNote[]): ModelCapabilityProfile {
    const catalog = this.#deps.catalog;
    const profile = catalog.get(decision.routeId);
    if (!profile || profile.provider !== decision.provider || profile.model !== decision.model || profile.continuationCompatibilityClass !== decision.continuationCompatibilityClass) {
      throw new HypertestError('precondition_failed', `route ${decision.routeId} is no longer available as decided`, { retryable: false, details: { routeId: decision.routeId, stage: 'catalog' } });
    }
    if (decision.capabilityProfileRevision !== catalog.revision) {
      throw new HypertestError('precondition_failed', `decision was made against catalog ${decision.capabilityProfileRevision}; current is ${catalog.revision}`, {
        retryable: false,
        details: { routeId: decision.routeId, stage: 'catalog' },
      });
    }
    const ev = this.#evaluate(profile, routeRequest, classification, priceNotes);
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
    transitions: CircuitTransition[] = [],
  ): Promise<InvokeOutcome> {
    const error = { code: err.code, message: err.message, retryable: err.retryable };
    if (this.#deps.events) {
      const failed = eventFrom(ctx, EVENT_TYPES.modelInvoked, 'model', routeRequest.agentId, {
        ok: false,
        ...identity,
        attempts,
        error,
        latencyMs: Math.max(0, this.#deps.clock.nowMs() - startedMs),
      } as Record<string, JsonValue>);
      await this.#deps.events.emit([failed, ...transitions.map((t) => this.#circuitEvent(ctx, t, decision, routeRequest.contextSnapshotId))]);
    }
    const outcome: InvokeOutcome = { ok: false, error, attempts };
    const failure = { routeId: decision.routeId, err };
    if (!FALLBACK_ELIGIBLE.has(err.code)) {
      // a malformed request (provider_error), a caller-side fault: permanent — never answered by another model
      if (err.code !== 'cancelled') outcome.unavailable = this.#unavailability([], failure);
      return outcome;
    }

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
      outcome.unavailable = this.#unavailability([], failure);
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
    else outcome.unavailable = this.#unavailability(next.rejected, failure);
    return outcome;
  }

  estimateCostUsd(routeId: string, inputTokens: number, outputTokens: number): number {
    const p = this.#deps.catalog.get(routeId);
    if (!p) throw new HypertestError('not_found', `unknown route ${routeId}`, { details: { routeId } });
    return estimateCostUsd(this.#priced(p), inputTokens, outputTokens);
  }

  /** `model.circuit_opened` / `model.circuit_closed` for a breaker transition caused by a call. */
  #circuitEvent(ctx: EventContext, t: CircuitTransition, decision: OkDecision, snapshotId: string): DomainEventInput<Record<string, JsonValue>> {
    const base: Record<string, JsonValue> = { routeId: t.routeId, provider: decision.provider, model: decision.model, snapshotId };
    if (t.kind === 'opened') {
      return eventFrom(ctx, MODEL_CIRCUIT_EVENTS.opened, 'model', t.routeId, {
        ...base, reason: t.reason, code: t.code, consecutiveFailures: t.consecutiveFailures, rateLimitsInWindow: t.rateLimitsInWindow, cooldownMs: t.cooldownMs, halfOpenAt: t.reopenAt,
      });
    }
    return eventFrom(ctx, MODEL_CIRCUIT_EVENTS.closed, 'model', t.routeId, { ...base, reason: t.reason, openForMs: t.openForMs });
  }

  /** Price-guard transitions observed while routing (the guard applies to cost-limited requests only). */
  async #notePrices(ctx: EventContext, request: RouteRequest, catalogRevision: string, notes: PriceNote[]): Promise<void> {
    if (!this.#breakers || notes.length === 0) return;
    const out: Array<DomainEventInput<Record<string, JsonValue>>> = [];
    for (const n of notes) {
      if (n.change) {
        // A[1] price-change guard: opened the first time the observed price is beyond the guard, closed once back within
        const routeId = n.profile.routeId;
        const was = this.#priceChanged.has(routeId);
        if (n.change.violated === was) continue;
        const base: Record<string, JsonValue> = {
          routeId, provider: n.profile.provider, model: n.profile.model, catalogRevision, snapshotId: request.contextSnapshotId,
          catalogPrice: { inputPerMillionUsd: n.profile.costPerMillionInputUsd ?? null, outputPerMillionUsd: n.profile.costPerMillionOutputUsd ?? null },
          observedPrice: n.change.observed
            ? { inputPerMillionUsd: n.change.observed.inputPerMillionUsd, outputPerMillionUsd: n.change.observed.outputPerMillionUsd, observedAt: n.change.observed.observedAt ?? null, source: n.change.observed.source ?? null }
            : null,
          increasePct: Number.isFinite(n.change.increasePct) ? Number(n.change.increasePct.toFixed(3)) : null,
          maxIncreasePct: n.change.maxIncreasePct,
        };
        if (n.change.violated) {
          this.#priceChanged.add(routeId);
          this.#deps.logger.warn('model circuit opened by the price-change guard', { routeId, increasePct: n.change.increasePct });
          out.push(eventFrom(ctx, MODEL_CIRCUIT_EVENTS.opened, 'model', routeId, { ...base, reason: 'price_change', appliesTo: 'all_requests' }));
        } else {
          this.#priceChanged.delete(routeId);
          this.#deps.logger.info('model price-change guard cleared', { routeId });
          out.push(eventFrom(ctx, MODEL_CIRCUIT_EVENTS.closed, 'model', routeId, { ...base, reason: 'price_change_cleared' }));
        }
        continue;
      }
      const change = this.#breakers.notePrice(n.profile.routeId, catalogRevision, n.violation !== undefined);
      if (!change) continue;
      const base: Record<string, JsonValue> = {
        routeId: n.profile.routeId, provider: n.profile.provider, model: n.profile.model, catalogRevision, snapshotId: request.contextSnapshotId,
        price: { inputPerMillionUsd: this.#priced(n.profile).costPerMillionInputUsd ?? null, outputPerMillionUsd: this.#priced(n.profile).costPerMillionOutputUsd ?? null },
      };
      if (change === 'opened') {
        const ceiling = n.violation!.ceiling;
        this.#deps.logger.warn('model circuit opened by the price guard (cost-limited policies)', { routeId: n.profile.routeId, catalogRevision });
        out.push(eventFrom(ctx, MODEL_CIRCUIT_EVENTS.opened, 'model', n.profile.routeId, { ...base, reason: 'price_ceiling', appliesTo: 'cost_limited_policies', ceiling: { ...ceiling } as Record<string, JsonValue> }));
      } else {
        this.#deps.logger.info('model price guard cleared', { routeId: n.profile.routeId, catalogRevision });
        out.push(eventFrom(ctx, MODEL_CIRCUIT_EVENTS.closed, 'model', n.profile.routeId, { ...base, reason: 'price_ceiling_cleared' }));
      }
    }
    if (out.length > 0 && this.#deps.events) await this.#deps.events.emit(out);
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
