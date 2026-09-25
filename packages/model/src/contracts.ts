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
 *
 * Provider error mapping (HypertestError codes): 429 → rate_limited, 408/5xx/network → unavailable,
 * timeout → timeout, 400 schema/tool errors → provider_error (non-retryable), abort → cancelled.
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
  /** Calls the provider for the decided route; on failure computes a re-validated fallback (never swaps mid-call). */
  invoke(request: InvokeRequest, routeRequest: RouteRequest): Promise<InvokeOutcome>;
  /** Cost estimate for budget reservation. */
  estimateCostUsd(routeId: string, inputTokens: number, outputTokens: number): number;
}
