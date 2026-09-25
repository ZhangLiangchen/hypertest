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
}

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
  costPerMillionInputUsd: number;
  costPerMillionOutputUsd: number;
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
}

export interface RouteRejection {
  routeId: string;
  stage: 'security' | 'capability' | 'role' | 'quality' | 'latency' | 'cost' | 'excluded';
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
  | { ok: false; reason: 'no_eligible_route'; rejected: RouteRejection[] };

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
  | { ok: true; response: ModelCallResponse; routeId: string; attempts: number }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      attempts: number;
      /**
       * Fail-closed fallback: a re-validated alternative route to use at the NEXT safe turn boundary
       * (new ModelEpoch), or undefined when policy is fail_closed / no eligible route remains.
       */
      fallback?: Extract<RouteDecision, { ok: true }>;
    };

export interface RouterDeps extends BaseDeps {
  catalog: ModelCatalogLike;
  providers: ProviderRegistryLike;
  events?: DomainEventSink;
  /** Same-route retry backoff (defaults: base 250ms, max 4000ms). Added in 0.3 (additive). */
  retry?: { baseDelayMs?: number; maxDelayMs?: number };
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
  /** Cost estimate for budget reservation. */
  estimateCostUsd(routeId: string, inputTokens: number, outputTokens: number): number;
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
