import type { BaseDeps, JsonSchema, JsonValue } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, DataClassification, DomainEventSink, EventContext, ModelCapability, ModelPolicy, RiskClass, ToolDefinition } from '@hypertest/domain';

/**
 * @hypertest/model — native Multi-LLM: provider-neutral message IR, providers, capability catalog and
 * the security-first, fail-closed router (I3).
 *
 * Implementations to export from src/index.ts:
 *   class ScriptedProvider implements ModelProvider      (deterministic "brains" for tests/PoCs; see ScriptedBrain)
 *   class OpenAICompatibleProvider implements ModelProvider  (fetch; /chat/completions; tools; response_format
 *                                                          json_schema; SSE streaming; usage incl. cached tokens)
 *   class AnthropicProvider implements ModelProvider     (fetch; /v1/messages; tools; streaming; thinking opaque blocks
 *                                                          carried as reasoning.opaque with compat class `anthropic:<model>`)
 *   class PiAiProvider implements ModelProvider          (adapts @earendil-works/pi-ai stream/complete for any pi-ai
 *                                                          supported provider; only this module imports pi-ai)
 *   class ModelCatalog                                   (profiles, revision = hash of profiles; get/list/withScores)
 *   createModelRouter(deps: RouterDeps): ModelRouter
 *   ProviderRegistry                                     (register(provider), get(providerId))
 *   estimateCostUsd(profile, inputTokens, outputTokens)   (per-million prices → USD)
 *   MODEL_CAPABILITY_PROFILE_SCHEMA                      (JSON Schema used by ModelCatalog validation)
 *
 * Circuit breaker (additive): per route, in the router; open routes are rejected at the routing stage `availability`
 * (after security → capability → role → quality, before latency → cost) and refused by invoke() without a provider call
 * (precondition_failed ⇒ re-validated fallback unless fail_closed). Emits `model.circuit_opened` / `model.circuit_closed`.
 *
 * Provider error mapping (HypertestError codes): 429 → rate_limited, 408/5xx/network → unavailable,
 * timeout → timeout, 400 schema/tool errors → provider_error (non-retryable), abort → cancelled.
 * A stream cut mid-event is an incomplete stream (unavailable), never a malformed payload; an exception thrown by
 * the caller's `onDelta` is `internal` (non-retryable, never answered with a fallback).
 */

// ----------------------------------------------------------------------------- message IR
// The IR lives in @hypertest/domain (shared by context/runtime/control); re-exported here for convenience.
export type { ChatMessage, ContentPart, ToolCall, OpaqueReasoning, ToolDefinition, AssistantMessage } from '@hypertest/domain';

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'content_filter' | 'error' | 'aborted';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface ModelCallRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  responseFormat?: { type: 'json_schema'; name: string; schema: JsonSchema };
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Provider-specific extra body fields from the route profile. */
  extra?: Record<string, JsonValue>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ModelCallResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: ModelUsage;
  providerResponseId?: string;
  latencyMs: number;
}

export type StreamDelta = { type: 'text'; text: string } | { type: 'tool_call_start'; id: string; name: string } | { type: 'tool_call_args'; id: string; text: string } | { type: 'reasoning'; text: string };

export interface ModelProvider {
  /** Provider id used in catalog profiles (e.g. `openai`, `anthropic`, `deepseek`, `local`, `scripted`). */
  readonly providerId: string;
  /** Package + version for the RuntimeManifest. */
  readonly adapterInfo: { package: string; version: string };
  complete(request: ModelCallRequest, options?: { onDelta?: (d: StreamDelta) => void }): Promise<ModelCallResponse>;
  /**
   * (additive, optional) Whether the provider can serve calls at all in this process — e.g. a provider configured with a
   * required credential whose variable is unset or empty is unavailable. The router rejects every route of an
   * unavailable provider at the `capability` stage (no request ever leaves the process); absent ⇒ available.
   */
  availability?(): ProviderAvailability;
}

/** (additive) ModelProvider.availability(). */
export type ProviderAvailability = { ok: true } | { ok: false; reason: string };

/** Deterministic brain for ScriptedProvider: decides the next assistant message from the request. */
export type ScriptedBrain = (request: ModelCallRequest, info: { callIndex: number; routeModel: string }) => ScriptedReply | Promise<ScriptedReply>;
export type ScriptedReply =
  | { text?: string; toolCalls?: Array<{ name: string; arguments: JsonValue; id?: string }>; usage?: Partial<ModelUsage>; stopReason?: StopReason }
  | { error: 'timeout' | 'rate_limited' | 'unavailable' | 'provider_error'; message?: string };

// ----------------------------------------------------------------------------- catalog + routing

export interface ModelCapabilityProfile {
  routeId: string;
  provider: string;
  model: string;
  displayName?: string;
  capabilities: ModelCapability[];
  structuredOutput: 'native' | 'prompted' | 'none';
  reasoning: 'native' | 'visible' | 'opaque' | 'none';
  contextWindow: number;
  maxOutputTokens: number;
  continuationCompatibilityClass: string;
  /** Highest data classification this route may receive (e.g. local models: restricted). */
  maxDataClassification: DataClassification;
  /** 0..1 quality scores by role or task type (from evals); `default` used when missing. */
  quality: Record<string, number>;
  /** Tool-call reliability 0..1 (executors weigh it). */
  toolReliability: number;
  /**
   * USD per million input/output tokens. (contract change, A[2]) Optional: an undeclared price is UNKNOWN, never 0 — a
   * cost-limited request (policy.maxCostPerCallUsd, or RouteRequest.costBudgeted) is never routed to a route whose cost
   * is unknown, and usage on such a route carries no `costUsd` (the provider's reported cost is kept when it has one).
   */
  costPerMillionInputUsd?: number;
  costPerMillionOutputUsd?: number;
  typicalLatencyMs: number;
  /** Highest risk class of actions this route may drive. */
  maxActionRisk: RiskClass;
  reasoningEffort?: 'low' | 'medium' | 'high';
  extra?: Record<string, JsonValue>;
  enabled: boolean;
}

export interface RouteRequest {
  runId: string;
  agentId: string;
  role: string;
  taskType: string;
  policy: ModelPolicy;
  requiredCapabilities: ModelCapability[];
  structuredOutput?: boolean;
  /** Highest risk class of tools available to the agent this turn. */
  actionRisk: RiskClass;
  dataClassification: DataClassification;
  contextTokensEstimate: number;
  contextSnapshotId: string;
  /** Providers already used by roles listed in policy.independentFromRoles (reviewer heterogeneity). */
  providersToAvoid?: string[];
  /** Routes that already failed in this epoch sequence (excluded from fallback). */
  excludeRoutes?: string[];
  /**
   * (additive) The run or work item has a USD cost budget: a route whose cost is unknown (no declared price) is rejected
   * at the `cost` stage — cost budgets must deplete with real prices, never silently at $0.
   */
  costBudgeted?: boolean;
  /**
   * (additive, cost switch) Only routes whose estimated call cost is strictly below this USD amount pass the `cost`
   * stage (budget pressure: a cheaper eligible route, still after security → capability → role → quality floor).
   */
  cheaperThanUsd?: number;
}

/**
 * (additive) Why no route can serve a request now. `transient`: a route may serve it again later (a circuit is open or
 * half-open, a rate limit / timeout / unavailability, a price guard, routes that failed earlier in this epoch sequence) —
 * the work PAUSES and resumes no earlier than `retryAt` (when known). Not transient: no configured route may serve it
 * (security, capability incl. a missing credential, role, quality, latency, cost policy, a malformed request) — the work
 * fails closed with `reason`.
 */
export interface ModelUnavailability {
  transient: boolean;
  reason: string;
  /** Earliest moment a route is expected back (a circuit's half-open time, a provider's Retry-After), ISO-8601. */
  retryAt?: string;
  /** The routes involved (the failed route and the rejected candidates). */
  routes: string[];
}

/** (additive) ModelRouter.validate(): the pure re-check of a decision for a request (no call, no event). */
export type DecisionCheck =
  | { ok: true }
  | { ok: false; stage: RouteRejection['stage'] | 'catalog'; reason: string; transient: boolean; retryAt?: string };

export interface RouteRejection {
  routeId: string;
  /**
   * (additive) `availability`: the route's circuit breaker is open (or half-open with its probe in flight), or its
   * catalog price is above the configured ceiling for a cost-limited request. Evaluated AFTER security → capability →
   * role → quality, so an availability rejection is only ever reported for a route that passed all of them.
   */
  stage: 'security' | 'capability' | 'role' | 'quality' | 'availability' | 'latency' | 'cost' | 'excluded';
  reason: string;
}

export type RouteDecision =
  | {
      ok: true;
      routeId: string;
      provider: string;
      model: string;
      reasoningEffort?: 'low' | 'medium' | 'high';
      fallbackChain: string[];
      selectedByPolicy: string;
      capabilityProfileRevision: string;
      continuationCompatibilityClass: string;
      rejected: RouteRejection[];
    }
  | {
      ok: false;
      reason: 'no_eligible_route';
      rejected: RouteRejection[];
      /** (additive) Transient (pause) or permanent (fail closed), with the earliest retry time when known. */
      unavailable?: ModelUnavailability;
    };

export interface InvokeRequest {
  decision: Extract<RouteDecision, { ok: true }>;
  call: Omit<ModelCallRequest, 'model'>;
  ctx: EventContext;
  /** Retries of the same route for retryable errors before reporting failure. */
  maxAttempts?: number;
  /** Streaming deltas of the (single) route being invoked. Added in 0.3 (additive). */
  onDelta?: (d: StreamDelta) => void;
}

export type InvokeOutcome =
  | {
      ok: true;
      response: ModelCallResponse;
      routeId: string;
      attempts: number;
      /**
       * (additive) Set when the `model.invoked` audit event could not be appended after the provider answered (retried
       * first): the paid response and its usage are still returned — never discarded over an audit write, which would
       * lose the usage from the budget (under-count) and re-pay the call on retry. Callers must settle the usage and log.
       */
      auditPending?: { code: string; message: string };
    }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      attempts: number;
      /**
       * Fail-closed fallback: a re-validated alternative route to use at the NEXT safe turn boundary
       * (new ModelEpoch), or undefined when policy is fail_closed / no eligible route remains.
       */
      fallback?: Extract<RouteDecision, { ok: true }>;
      /**
       * (additive) Set when there is no fallback (and the call was not cancelled): whether the failure is transient
       * (the work pauses until `retryAt` / a route is back) or permanent (fail closed). See ModelUnavailability.
       */
      unavailable?: ModelUnavailability;
    };

export interface RouterDeps extends BaseDeps {
  catalog: ModelCatalogLike;
  providers: ProviderRegistryLike;
  events?: DomainEventSink;
  /** Same-route retry backoff (defaults: base 250ms, max 4000ms). Added in 0.3 (additive). */
  retry?: { baseDelayMs?: number; maxDelayMs?: number };
  /**
   * (additive) Per-route circuit breaker + optional price guard (technology-selection §关键风险). Enabled with the
   * defaults of DEFAULT_CIRCUIT_BREAKER when omitted; `false` disables it (every route stays available).
   */
  circuitBreaker?: CircuitBreakerOptions | false;
  /**
   * (additive, A[1]) Observed route prices, read at a safe point (the start of every route() / invoke() / validate(),
   * i.e. a turn boundary). An observed price is what the call costs now: cost estimates and budget reservations use it,
   * the price guard's ceilings apply to it, and an increase over the catalog price beyond `priceGuard.maxIncreasePct`
   * opens the route's circuit (`model.circuit_opened` reason `price_change`) until the price is back within the guard.
   */
  prices?: PriceSource;
}

/** (additive) A route's observed price (USD per million tokens). */
export interface ObservedPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** When/where the price was observed (audit only). */
  observedAt?: string;
  source?: string;
}

/** (additive) Source of observed prices (e.g. a prices file reloaded when it changes, provider-reported pricing). */
export interface PriceSource {
  /** Observed prices by route id; a route without an entry is priced from the catalog. Errors fail the routing call. */
  current(): Promise<Record<string, ObservedPrice>> | Record<string, ObservedPrice>;
}

/** (additive) Catalog price ceiling (USD per million tokens); an absent side is not checked. */
export interface PriceCeiling {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
}

/**
 * (additive) Circuit breaker configuration. A route opens after `failureThreshold` consecutive availability failures
 * (rate_limited / unavailable / timeout, counted per provider attempt) or after a rate-limit storm (`count` rate_limited
 * failures within `windowMs`, successes in between notwithstanding); after `cooldownMs` it is half-open and admits ONE
 * probe call (no same-route retries): success closes it, an availability failure re-opens it with the cooldown multiplied
 * by `cooldownBackoff` (capped at `maxCooldownMs`). Open routes are rejected at the routing stage `availability`.
 */
export interface CircuitBreakerOptions {
  /** Default 5. */
  failureThreshold?: number;
  /** Default { count: 8, windowMs: 60000 }; false disables storm detection. */
  rateLimitStorm?: { count: number; windowMs: number } | false;
  /** Default 30000. */
  cooldownMs?: number;
  /** Default 2 (≥ 1). */
  cooldownBackoff?: number;
  /** Default 600000. */
  maxCooldownMs?: number;
  /**
   * Price-change guard: a route whose catalog price is above its ceiling (`routes[routeId]`, else `default`) is
   * unavailable to cost-limited requests (policy.maxCostPerCallUsd set; `appliesTo: 'all'` for every request). Recorded
   * as `model.circuit_opened` / `model.circuit_closed` with reason `price_ceiling`.
   */
  priceGuard?: {
    default?: PriceCeiling;
    routes?: Record<string, PriceCeiling>;
    appliesTo?: 'cost_limited' | 'all';
    /**
     * (additive, A[1]) Largest accepted increase (percent, ≥ 0) of an OBSERVED price (RouterDeps.prices) over the
     * route's catalog price, for every request: beyond it the route's circuit opens (`model.circuit_opened` reason
     * `price_change`) and closes again (`price_change_cleared`) once the observed price is back within the guard.
     */
    maxIncreasePct?: number;
  };
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/** (additive) Observable state of one route's breaker (ModelRouter.circuits). */
export interface CircuitSnapshot {
  routeId: string;
  state: CircuitState;
  consecutiveFailures: number;
  rateLimitsInWindow: number;
  probeInFlight: boolean;
  openedAt?: string;
  /** When an open breaker becomes half-open. */
  halfOpenAt?: string;
  reason?: 'consecutive_failures' | 'rate_limit_storm' | 'probe_failed';
}

export interface ModelCatalogLike {
  readonly revision: string;
  list(): ModelCapabilityProfile[];
  get(routeId: string): ModelCapabilityProfile | undefined;
}

export interface ProviderRegistryLike {
  get(providerId: string): ModelProvider;
  has(providerId: string): boolean;
  list(): ModelProvider[];
}

export interface ModelRouter {
  /**
   * Deterministic selection in the order security → capability → role suitability → quality → latency → cost.
   * Never cost-first. Emits model.routed with rejections.
   */
  route(request: RouteRequest, ctx: EventContext): Promise<RouteDecision>;
  /**
   * Calls the provider for the decided route; on failure computes a re-validated fallback (never swaps mid-call).
   * The decision is re-validated against `routeRequest` (the CURRENT request) before any call: a stale catalog
   * revision, a forged decision, or a route that no longer passes every stage (e.g. the data classification or
   * action risk escalated, a provider must now be avoided, the context no longer fits) is refused with
   * `precondition_failed` (attempts 0). The fallback re-route also requires the tool compatibility the call used
   * (tools → tool_use, responseFormat → structured output, images → vision) as far as the failed route declared it.
   * Malformed inputs (non-finite maxAttempts, invalid routeRequest) are thrown as `invalid_argument`; a failure to
   * record the audit events after a successful call is thrown as a fault (never reported as a model failure).
   */
  invoke(request: InvokeRequest, routeRequest: RouteRequest): Promise<InvokeOutcome>;
  /** Cost estimate for budget reservation (NaN when the route's price is unknown). */
  estimateCostUsd(routeId: string, inputTokens: number, outputTokens: number): number;
  /** (additive, optional) The circuit breaker state of every route that has one (sorted by route id). */
  circuits?(): CircuitSnapshot[];
  /**
   * (additive, optional) Pure re-check of `decision` for `routeRequest` — the same checks invoke() makes before a call
   * (catalog revision, the route unchanged, every stage including availability) — without calling, acquiring a probe
   * slot or emitting events. The permission/profile re-check of a model switch BEFORE its new epoch is recorded (I3).
   */
  validate?(decision: Extract<RouteDecision, { ok: true }>, routeRequest: RouteRequest): Promise<DecisionCheck>;
  /** (additive, optional) The catalog revision the router routes against now. */
  readonly catalogRevision?: string;
}

// ----------------------------------------------------------------------------- provider options (additive)

export interface ScriptedProviderOptions {
  /** Defaults to `scripted`. */
  providerId?: string;
  /** Brain used for every model without a dedicated entry in `brains`. */
  brain?: ScriptedBrain;
  /** Brains keyed by model name (the route's `model`). */
  brains?: Record<string, ScriptedBrain>;
  /** Simulated latency per call (respects the call's signal and timeoutMs). */
  latencyMs?: number;
}

export interface OpenAICompatibleProviderOptions {
  providerId: string;
  /** Base URL including the version prefix, e.g. `https://api.openai.com/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey?: string;
  /**
   * (additive, e2e[3]) A key is required (the configuration names an apiKeyEnv): without a non-empty `apiKey` the provider
   * is unavailable — availability() reports it and complete() refuses locally (precondition_failed) before any request.
   */
  requireApiKey?: boolean;
  /** (additive) Where the key comes from (e.g. the environment variable name), for the unavailability reason only. */
  apiKeySource?: string;
  headers?: Record<string, string>;
  /** Whole-call deadline (connect + stream). Default 120000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AnthropicProviderOptions {
  /** Defaults to `anthropic`. */
  providerId?: string;
  /** Defaults to `https://api.anthropic.com`; `/v1/messages` is appended. */
  baseUrl?: string;
  apiKey?: string;
  /**
   * (additive, e2e[3]) A key is required (the configuration names an apiKeyEnv): without a non-empty `apiKey` the provider
   * is unavailable — availability() reports it and complete() refuses locally (precondition_failed) before any request.
   */
  requireApiKey?: boolean;
  /** (additive) Where the key comes from (e.g. the environment variable name), for the unavailability reason only. */
  apiKeySource?: string;
  /** `anthropic-version` header. Default `2023-06-01`. */
  version?: string;
  headers?: Record<string, string>;
  /** Whole-call deadline (connect + stream). Default 120000. */
  timeoutMs?: number;
  /** `max_tokens` when the call does not set maxOutputTokens (the API requires it). Default 4096. */
  defaultMaxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** A model definition for PiAiProvider when the model is not in pi-ai's built-in catalog (e.g. a local server). */
export interface PiAiModelDefinition {
  id: string;
  /** pi-ai API id: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `mistral-conversations`, ... */
  api: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  headers?: Record<string, string>;
  /** Passed through as the pi-ai model `compat` object. */
  compat?: Record<string, JsonValue>;
}

export interface PiAiProviderOptions {
  /** Hypertest provider id used in catalog profiles. */
  providerId: string;
  /** pi-ai provider id (built-in catalog lookup, e.g. `openai`, `anthropic`, `deepseek`, `openrouter`) or a custom name. */
  piProvider: string;
  apiKey?: string;
  /**
   * (additive, e2e[3]) A key is required (the configuration names an apiKeyEnv): without a non-empty `apiKey` the provider
   * is unavailable — availability() reports it and complete() refuses locally (precondition_failed) before any request.
   */
  requireApiKey?: boolean;
  /** (additive) Where the key comes from (e.g. the environment variable name), for the unavailability reason only. */
  apiKeySource?: string;
  /** Overrides the model's base URL (custom gateways, local servers). */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Custom model definitions; take precedence over the built-in catalog. */
  models?: PiAiModelDefinition[];
  /** API used for models found neither in `models` nor in the catalog when `baseUrl` is set. Default `openai-completions`. */
  defaultApi?: string;
  /** Whole-call deadline. Default 120000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
