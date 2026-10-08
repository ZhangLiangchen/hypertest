import { HypertestError } from '@hypertest/core';
import type { CircuitBreakerOptions, CircuitSnapshot, CircuitState, ModelCapabilityProfile, PriceCeiling, RouteRequest } from './contracts.ts';

/**
 * Per-route model circuit breaker (technology-selection §关键风险 "模型价格/限流突然变化": Model Catalog + budgets +
 * circuit breaker). In-memory per router instance (per worker process): it protects this process from hammering a route
 * that keeps failing and is re-learned after a restart.
 *
 *   closed ──(N consecutive availability failures | rate-limit storm in a window)──▶ open
 *   open ──(cooldown elapsed)──▶ half_open ──(single probe succeeds)──▶ closed
 *                                    └──(probe fails)──▶ open (cooldown × backoff, capped)
 *
 * Availability failures are the same-route-retryable codes (rate_limited, unavailable, timeout). A bad request
 * (provider_error), a caller cancellation or any other code is not an availability signal: it neither counts nor
 * resets, and a probe that ends that way leaves the breaker half-open (the next call probes again).
 *
 * The breaker only ever REJECTS (routing stage `availability`, after security → capability → role → quality): it can
 * never make an ineligible route eligible.
 */

export const DEFAULT_CIRCUIT_BREAKER = Object.freeze({
  failureThreshold: 5,
  rateLimitStorm: Object.freeze({ count: 8, windowMs: 60_000 }),
  cooldownMs: 30_000,
  cooldownBackoff: 2,
  maxCooldownMs: 10 * 60_000,
});

/** Error codes that are availability signals (they count towards opening the breaker). */
export const AVAILABILITY_FAILURES: ReadonlySet<string> = new Set(['rate_limited', 'unavailable', 'timeout']);

export type CircuitOpenReason = 'consecutive_failures' | 'rate_limit_storm' | 'probe_failed';

/** A state change to record on L0 (`model.circuit_opened` / `model.circuit_closed`). */
export type CircuitTransition =
  | { kind: 'opened'; routeId: string; reason: CircuitOpenReason; code: string; consecutiveFailures: number; rateLimitsInWindow: number; cooldownMs: number; reopenAt: string }
  | { kind: 'closed'; routeId: string; reason: 'probe_succeeded'; openForMs: number };

interface RouteCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  /** Times (ms) of rate_limited failures inside the storm window. */
  rateLimits: number[];
  openedAtMs?: number;
  cooldownMs: number;
  probeInFlight: boolean;
  lastReason?: CircuitOpenReason;
  lastCode?: string;
}

interface ResolvedOptions {
  failureThreshold: number;
  storm: { count: number; windowMs: number } | undefined;
  cooldownMs: number;
  cooldownBackoff: number;
  maxCooldownMs: number;
}

function positiveInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new HypertestError('invalid_argument', `circuitBreaker.${name} must be a positive integer (got ${String(v)})`);
  return v;
}

function positiveNumber(v: unknown, name: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= min) throw new HypertestError('invalid_argument', `circuitBreaker.${name} must be a finite number > ${min} (got ${String(v)})`);
  return v;
}

function resolve(options: CircuitBreakerOptions): ResolvedOptions {
  const failureThreshold = positiveInt(options.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER.failureThreshold, 'failureThreshold');
  let storm: ResolvedOptions['storm'] = { ...DEFAULT_CIRCUIT_BREAKER.rateLimitStorm };
  if (options.rateLimitStorm === false) storm = undefined;
  else if (options.rateLimitStorm !== undefined) {
    storm = { count: positiveInt(options.rateLimitStorm.count, 'rateLimitStorm.count'), windowMs: positiveNumber(options.rateLimitStorm.windowMs, 'rateLimitStorm.windowMs') };
  }
  const cooldownMs = positiveNumber(options.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER.cooldownMs, 'cooldownMs');
  const cooldownBackoff = positiveNumber(options.cooldownBackoff ?? DEFAULT_CIRCUIT_BREAKER.cooldownBackoff, 'cooldownBackoff', 0);
  if (cooldownBackoff < 1) throw new HypertestError('invalid_argument', `circuitBreaker.cooldownBackoff must be ≥ 1 (got ${cooldownBackoff})`);
  const maxCooldownMs = Math.max(cooldownMs, positiveNumber(options.maxCooldownMs ?? DEFAULT_CIRCUIT_BREAKER.maxCooldownMs, 'maxCooldownMs'));
  return { failureThreshold, storm, cooldownMs, cooldownBackoff, maxCooldownMs };
}

function validCeiling(c: PriceCeiling | undefined, name: string): void {
  if (c === undefined) return;
  if (!c || typeof c !== 'object') throw new HypertestError('invalid_argument', `circuitBreaker.${name} must be an object`);
  for (const k of ['inputPerMillionUsd', 'outputPerMillionUsd'] as const) {
    const v = c[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new HypertestError('invalid_argument', `circuitBreaker.${name}.${k} must be a finite number ≥ 0 (got ${String(v)})`);
  }
}

export type AvailabilityVerdict = { available: true; probe: boolean } | { available: false; reason: string };

/** The price guard's verdict for a route under a request (undefined: the guard does not apply or the price is fine). */
export interface PriceViolation {
  routeId: string;
  ceiling: PriceCeiling;
  price: { inputPerMillionUsd: number; outputPerMillionUsd: number };
}

export class CircuitBreakers {
  readonly #o: ResolvedOptions;
  readonly #price: CircuitBreakerOptions['priceGuard'];
  readonly #routes = new Map<string, RouteCircuit>();
  /** Routes whose price guard is currently tripped (for `model.circuit_opened|closed` reason `price_ceiling`). */
  readonly #priceTripped = new Map<string, string>();

  constructor(options: CircuitBreakerOptions = {}) {
    if (!options || typeof options !== 'object') throw new HypertestError('invalid_argument', 'circuitBreaker options must be an object');
    this.#o = resolve(options);
    const pg = options.priceGuard;
    if (pg !== undefined) {
      if (!pg || typeof pg !== 'object') throw new HypertestError('invalid_argument', 'circuitBreaker.priceGuard must be an object');
      validCeiling(pg.default, 'priceGuard.default');
      for (const [routeId, c] of Object.entries(pg.routes ?? {})) validCeiling(c, `priceGuard.routes.${routeId}`);
      const pct = pg.maxIncreasePct;
      if (pct !== undefined && !(typeof pct === 'number' && Number.isFinite(pct) && pct >= 0)) {
        throw new HypertestError('invalid_argument', `circuitBreaker.priceGuard.maxIncreasePct must be a finite number ≥ 0 (got ${String(pct)})`);
      }
      if (pg.appliesTo !== undefined && pg.appliesTo !== 'cost_limited' && pg.appliesTo !== 'all') {
        throw new HypertestError('invalid_argument', `circuitBreaker.priceGuard.appliesTo must be 'cost_limited' or 'all' (got ${String(pg.appliesTo)})`);
      }
    }
    this.#price = pg;
  }

  #get(routeId: string): RouteCircuit {
    let c = this.#routes.get(routeId);
    if (!c) {
      c = { state: 'closed', consecutiveFailures: 0, rateLimits: [], cooldownMs: this.#o.cooldownMs, probeInFlight: false };
      this.#routes.set(routeId, c);
    }
    return c;
  }

  /** open → half_open once the cooldown elapsed (lazy, monotonic in the injected clock). */
  #tick(c: RouteCircuit, nowMs: number): void {
    if (c.state === 'open' && c.openedAtMs !== undefined && nowMs >= c.openedAtMs + c.cooldownMs) c.state = 'half_open';
  }

  /**
   * Whether a route may be selected now (routing stage `availability`). A half-open route is available only while its
   * single probe slot is free; `probe: true` tells the caller that the call it makes will be that probe.
   */
  availability(routeId: string, nowMs: number): AvailabilityVerdict {
    const c = this.#routes.get(routeId);
    if (!c) return { available: true, probe: false };
    this.#tick(c, nowMs);
    if (c.state === 'closed') return { available: true, probe: false };
    if (c.state === 'half_open') {
      return c.probeInFlight ? { available: false, reason: 'circuit half-open: its single probe call is in flight' } : { available: true, probe: true };
    }
    const reopenIn = Math.max(0, (c.openedAtMs ?? nowMs) + c.cooldownMs - nowMs);
    return { available: false, reason: `circuit open (${c.lastReason ?? 'failures'}${c.lastCode ? `: ${c.lastCode}` : ''}); half-open probe in ${reopenIn}ms` };
  }

  /**
   * Takes the call slot right before a provider call: closed ⇒ `normal`; half-open with a free slot ⇒ `probe` (the slot
   * is now held: every other call is refused until `onSuccess` / `onFailure` / `releaseProbe`); otherwise refused.
   */
  acquire(routeId: string, nowMs: number): { kind: 'normal' } | { kind: 'probe' } | { kind: 'refused'; reason: string } {
    const v = this.availability(routeId, nowMs);
    if (!v.available) return { kind: 'refused', reason: v.reason };
    if (!v.probe) return { kind: 'normal' };
    this.#get(routeId).probeInFlight = true;
    return { kind: 'probe' };
  }

  /** Whether another same-route attempt may follow a failure now (never after the breaker opened, never for a probe). */
  mayRetry(routeId: string, probe: boolean): boolean {
    if (probe) return false;
    const c = this.#routes.get(routeId);
    return !c || c.state === 'closed';
  }

  /**
   * A successful provider call. Only the half-open PROBE closes an open breaker: a call that started while the breaker
   * was closed and answered after another call opened it proves nothing about recovery (the probe decides).
   */
  onSuccess(routeId: string, nowMs: number, probe: boolean): CircuitTransition | undefined {
    const c = this.#get(routeId);
    if (!probe) {
      if (c.state === 'closed') c.consecutiveFailures = 0;
      return undefined;
    }
    const openForMs = c.openedAtMs === undefined ? 0 : Math.max(0, nowMs - c.openedAtMs);
    c.consecutiveFailures = 0;
    c.state = 'closed';
    c.probeInFlight = false;
    c.rateLimits = [];
    c.cooldownMs = this.#o.cooldownMs;
    delete c.openedAtMs;
    return { kind: 'closed', routeId, reason: 'probe_succeeded', openForMs };
  }

  /** Records one failed provider attempt. Non-availability codes only free a probe slot. */
  onFailure(routeId: string, code: string, nowMs: number, probe: boolean): CircuitTransition | undefined {
    const c = this.#get(routeId);
    if (!AVAILABILITY_FAILURES.has(code)) {
      if (probe) c.probeInFlight = false;
      return undefined;
    }
    c.consecutiveFailures++;
    if (code === 'rate_limited' && this.#o.storm) {
      const from = nowMs - this.#o.storm.windowMs;
      c.rateLimits = [...c.rateLimits.filter((t) => t > from), nowMs];
    }
    if (probe) {
      c.probeInFlight = false;
      c.cooldownMs = Math.min(this.#o.maxCooldownMs, c.cooldownMs * this.#o.cooldownBackoff);
      return this.#open(c, routeId, 'probe_failed', code, nowMs);
    }
    if (c.state !== 'closed') return undefined; // already open (a call that started before it opened)
    if (c.consecutiveFailures >= this.#o.failureThreshold) return this.#open(c, routeId, 'consecutive_failures', code, nowMs);
    if (this.#o.storm && c.rateLimits.length >= this.#o.storm.count) return this.#open(c, routeId, 'rate_limit_storm', code, nowMs);
    return undefined;
  }

  /** Frees a probe slot without a verdict (the probe was never sent, or was cancelled by its caller). */
  releaseProbe(routeId: string): void {
    const c = this.#routes.get(routeId);
    if (c) c.probeInFlight = false;
  }

  #open(c: RouteCircuit, routeId: string, reason: CircuitOpenReason, code: string, nowMs: number): CircuitTransition {
    c.state = 'open';
    c.openedAtMs = nowMs;
    c.lastReason = reason;
    c.lastCode = code;
    return {
      kind: 'opened',
      routeId,
      reason,
      code,
      consecutiveFailures: c.consecutiveFailures,
      rateLimitsInWindow: c.rateLimits.length,
      cooldownMs: c.cooldownMs,
      reopenAt: new Date(nowMs + c.cooldownMs).toISOString(),
    };
  }

  /**
   * The price guard: for a cost-limited request (policy.maxCostPerCallUsd set — or every request with appliesTo 'all'),
   * a route whose catalog price exceeds the configured ceiling (per route, else the default) is unavailable. A non-finite
   * catalog price never passes a configured ceiling (fail closed). `applies: false`: no guard for this request/route.
   */
  priceCheck(profile: ModelCapabilityProfile, request: RouteRequest): { applies: false } | { applies: true; violation?: PriceViolation } {
    const pg = this.#price;
    if (!pg) return { applies: false };
    if (pg.appliesTo !== 'all' && request.policy.maxCostPerCallUsd === undefined && request.costBudgeted !== true) return { applies: false };
    const ceiling = (pg.routes && Object.hasOwn(pg.routes, profile.routeId) ? pg.routes[profile.routeId] : undefined) ?? pg.default;
    if (!ceiling) return { applies: false };
    // an unknown (undeclared) price never passes a ceiling (fail closed)
    const price = { inputPerMillionUsd: profile.costPerMillionInputUsd ?? Number.NaN, outputPerMillionUsd: profile.costPerMillionOutputUsd ?? Number.NaN };
    const over = (p: number, max: number | undefined) => max !== undefined && !(typeof p === 'number' && Number.isFinite(p) && p <= max);
    if (over(price.inputPerMillionUsd, ceiling.inputPerMillionUsd) || over(price.outputPerMillionUsd, ceiling.outputPerMillionUsd)) {
      return { applies: true, violation: { routeId: profile.routeId, ceiling, price } };
    }
    return { applies: true };
  }

  /**
   * Tracks the price-guard state of a route (call it only where the guard applies): `opened` the first time the route's
   * price is seen above its ceiling, `closed` when a later check (a new catalog revision) finds it back under.
   */
  notePrice(routeId: string, catalogRevision: string, violated: boolean): 'opened' | 'closed' | undefined {
    const was = this.#priceTripped.get(routeId);
    if (violated) {
      this.#priceTripped.set(routeId, catalogRevision);
      return was === undefined ? 'opened' : undefined;
    }
    if (was === undefined) return undefined;
    this.#priceTripped.delete(routeId);
    return 'closed';
  }

  snapshot(routeId: string, nowMs: number): CircuitSnapshot {
    const c = this.#routes.get(routeId);
    if (!c) return { routeId, state: 'closed', consecutiveFailures: 0, rateLimitsInWindow: 0, probeInFlight: false };
    this.#tick(c, nowMs);
    const out: CircuitSnapshot = {
      routeId,
      state: c.state,
      consecutiveFailures: c.consecutiveFailures,
      rateLimitsInWindow: this.#o.storm ? c.rateLimits.filter((t) => t > nowMs - this.#o.storm!.windowMs).length : 0,
      probeInFlight: c.probeInFlight,
    };
    if (c.state !== 'closed' && c.openedAtMs !== undefined) {
      out.openedAt = new Date(c.openedAtMs).toISOString();
      out.halfOpenAt = new Date(c.openedAtMs + c.cooldownMs).toISOString();
    }
    if (c.lastReason !== undefined && c.state !== 'closed') out.reason = c.lastReason;
    return out;
  }

  snapshots(nowMs: number): CircuitSnapshot[] {
    return [...this.#routes.keys()].sort().map((id) => this.snapshot(id, nowMs));
  }
}
