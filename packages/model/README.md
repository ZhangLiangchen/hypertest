# @hypertest/model

Native multi-LLM layer of Hypertest: model providers, a revisioned capability catalog and the
security-first, **fail-closed** router (invariant **I3**). The provider-neutral message IR
(`ChatMessage`, `ToolCall`, `OpaqueReasoning`, …) lives in `@hypertest/domain` and is re-exported here.
Provider-native shapes never leave this package.

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `ModelCatalog(profiles)` | Immutable, validated (`MODEL_CAPABILITY_PROFILE_SCHEMA`) set of `ModelCapabilityProfile`s. `revision = 'mc_' + sha256(canonicalJson(profiles))[0..16]`. `list()` (includes disabled), `get(routeId)`, `withScores(scores)` → new catalog/revision. Duplicate routeIds, unknown classes/capabilities, NaN → `invalid_argument`. |
| `ProviderRegistry` | `register(provider, {replace?})` (duplicate ⇒ `conflict`), `get` (unknown ⇒ `not_found`), `has`, `list`, `adapters()` (for `RuntimeManifest.providerAdapters`). |
| `createModelRouter(deps)` | `route()`, `invoke()`, `estimateCostUsd()` (see below). `deps.retry` sets same-route backoff. |
| `ScriptedProvider` | Deterministic brains (`brain` or `brains[model]`), `callIndex` 0-based per instance, generated tool ids `call_<n>`, error replies ⇒ `HypertestError` with the same code, estimated usage, optional `latencyMs`. `requests`/`callCount` for assertions. |
| `OpenAICompatibleProvider` | `POST {baseUrl}/chat/completions`, SSE (`stream_options.include_usage`) or plain JSON, tools/`tool_choice`/`response_format: json_schema (strict)`/`reasoning_effort`, `reasoning_content` → `reasoning.text`, cached/reasoning token usage. |
| `AnthropicProvider` | `POST {baseUrl}/v1/messages`, SSE or JSON, tool_use/tool_result mapping, merged same-role turns, thinking ⇒ `reasoning.text` + `reasoning.opaque` (`anthropic:<model>`, replayed only to that class), `responseFormat` emulated via a forced `structured_output` tool. Extended thinking is configured via profile `extra.thinking`. |
| `PiAiProvider` | Adapter over `@earendil-works/pi-ai` (only module importing it). Model = custom definition → pi-ai built-in catalog (`piProvider`) → synthesized from `baseUrl` + `defaultApi`. Dispatches on `model.api` directly (no pi-ai env-key resolution), pi-ai retries disabled, HTTP status observed through an injected fetch. |
| helpers | `estimateCostUsd`, `ToolNameMap`, `buildOpenAIBody`, `toAnthropicMessages`, `toPiContext`, `fromPiAssistant`, `mapPiUsage`, `ROUTING_STAGES`, `SAME_ROUTE_RETRYABLE`, `FALLBACK_ELIGIBLE`, `codeForHttpStatus`. |

### Routing (`route`)

Stages, first failure recorded as a `RouteRejection`:

1. **security** – enabled; provider ∈ `allowedProviders` (if set; `[]` allows nothing) and ∉ `prohibitedProviders`;
   `maxDataClassification ≥ max(request.dataClassification, policy.privacyClass)`; `maxActionRisk ≥ actionRisk`;
   provider ∉ `providersToAvoid` (reviewer independence). Routes in `excludeRoutes` are reported as `excluded`.
2. **capability** – adapter registered for the provider; `requiredCapabilities` (request ∪ policy);
   structured output; `contextWindow ≥ contextTokensEstimate + min(maxOutputTokens, 4096)`.
3. **role** – an explicit `0` score for the role/taskType means "unsuitable"; **quality** –
   `score = quality[role] ?? quality[taskType] ?? quality.default ?? 0` must be `≥ minQuality`.
4. **latency** – `typicalLatencyMs ≤ latencyBudgetMs`. 5. **cost** – `(ctx in, maxOutputTokens out) ≤ maxCostPerCallUsd`.

Survivors are ranked: preferred routes (listed order) → score ↓ → (executor-like: role `executor` or
taskType containing `execute`) tool reliability ↓ → latency ↑ → cost ↑ → routeId. `selectedByPolicy`
names the deciding criterion (`preferred_route`, `quality`, `tool_reliability`, `latency`, `cost`,
`route_id`, `only_eligible_route`); `fallbackChain` is the rest of the ranking. Malformed input (unknown
classification/risk, NaN, list fields that are not string arrays — `'openai-proxy'.includes('openai')` would
fail open) is `invalid_argument`; a foreign catalog's `enabled` must be exactly `true`. Emits `model.routed`.
`policy.independentFromRoles` without resolved `providersToAvoid` is logged as a warning (independence
can only be enforced from the resolved provider list; `[]` means resolved).

### Invocation (`invoke`)

One route per invoke. **Before any call the decision is re-validated against the CURRENT `routeRequest`**:
same catalog revision, route unchanged (provider/model/continuation class — a forged decision is refused),
and every routing stage passing for this request. A decision reused across the turns of an epoch is
therefore refused (`precondition_failed`, `attempts: 0`, `details.stage`) as soon as the data classification
or action risk escalates, a provider must now be avoided, the route is excluded, or the context no longer
fits. Opaque reasoning is projected for the route's continuation class; model, reasoning effort (call ⊕
decision), temperature (call ⊕ policy), `maxOutputTokens` (clamped) and `extra` (profile ⊕ call) are applied.
Retryable errors (`rate_limited`/`unavailable`/`timeout`) retry the **same** route up to `maxAttempts`
(default 2; non-finite ⇒ `invalid_argument`). On final failure: `fail_closed` ⇒ no fallback; otherwise the
request is **fully re-routed** with the failed route excluded and the result is returned as `fallback` for
the next safe turn boundary (never called inside the same invoke). The fallback must also serve the **tool
compatibility** the failed call used (tools ⇒ `tool_use`, `responseFormat` ⇒ structured output, images ⇒
`vision`), as far as the failed route declared those capabilities. `provider_error`, `cancelled` (any caller
abort, whatever its reason) and internal errors (including an exception thrown by the caller's `onDelta`)
never produce a fallback. Emits `model.invoked` (usage incl. `costUsd`, attempts, latency) and
`model.fallback` (`from`, `to|null`, `reason`, `policy`). A failure to emit the audit events after a
successful call is thrown as a fault — it is never reported as a model failure with a fallback.

Streaming deltas are a preview: a same-route retry streams again after the failed attempt's partial
deltas; the returned response is authoritative. A response whose opaque reasoning carries a different
continuation class than the route declares is logged as a catalog misconfiguration (it would never be
replayed): Anthropic routes must declare `anthropic:<model>`, pi-ai routes `pi-ai:<api>:<piProvider>:<model>`.

### Conventions

- Error taxonomy: 429 ⇒ `rate_limited`; 408/5xx/network ⇒ `unavailable`; deadline ⇒ `timeout` (all
  retryable); other 4xx, malformed payloads ⇒ `provider_error` (not retryable); caller abort ⇒ `cancelled`.
  In-stream error objects use their numeric `code`/`status` first (vLLM `code: 400` ⇒ `provider_error`),
  then type keywords. A stream cut mid-line at EOF drops the partial line, so truncation surfaces as an
  incomplete stream (`unavailable`), never as malformed JSON. API keys and credential-like custom header
  values are scrubbed from messages; redirects are refused. `timeoutMs` must be positive (capped at 2³¹−1 ms).
- Tool-call ids a server omits (or sends empty) are generated as `call_<seed>_<i>` with a seed derived from
  the conversation, so they never repeat across turns yet are reproducible for the same request.
- `ModelUsage.inputTokens` **includes** cached tokens (OpenAI convention); Anthropic/pi-ai usage is
  normalized accordingly. Missing provider usage is estimated, never reported as zero.
- Tool names: `.` ⇄ `__` per request (`ToolNameMap`, exact round-trip, hashed disambiguation for
  collisions/invalid names).
- Profile `extra` is merged into the request body; `null` deletes a default field; Hypertest-owned keys
  (`model`, `messages`, `stream`, `tools`, `tool_choice`, …) cannot be overridden.

## Invariants enforced (tests)

| Invariant | Tests |
|---|---|
| I3 routing order security → capability → role → quality → latency → cost, never cost-first | `test/router.test.ts` (stage order, ranking), `test/router-property.test.ts` (400 seeded catalogs vs. an independent reference; metamorphic "free route never wins / security violator never selected") |
| I3 privacy & independence (restricted data never to cloud, reviewer provider avoidance) | `test/router.test.ts`, `test/router-invoke.test.ts` |
| I3 fail-closed fallback (re-validation, tool compatibility, `fail_closed`, no mid-invoke switch, no masking of bad requests, cancellation) | `test/router-invoke.test.ts` |
| I3 decision re-validated at every invoke (escalated classification/risk, avoided provider, excluded route, context fit, forged decision) | `test/router-invoke.test.ts` |
| I3 opaque continuation replayed only to the same class | `test/router-invoke.test.ts`, `test/anthropic.test.ts`, `test/pi-ai.test.ts` |
| I10 route/invoke/fallback events with full correlation; sink failure fails the call (never masked as a model failure) | `test/router.test.ts`, `test/router-invoke.test.ts`, `test/events.int.test.ts` (jsonb round-trip on PGlite and PostgreSQL 16) |
| Provider error mapping, timeout vs cancel, SSE robustness (truncation), caller-callback faults, secret scrubbing | `test/openai.test.ts`, `test/anthropic.test.ts`, `test/pi-ai.test.ts`, `test/transport.test.ts`, `test/scripted.test.ts` |
| Catalog immutability / validation | `test/catalog-registry.test.ts` |

## Contract changes (additive, 0.3)

`RouterDeps.retry?`, `InvokeRequest.onDelta?`, provider option interfaces (`ScriptedProviderOptions`,
`OpenAICompatibleProviderOptions`, `AnthropicProviderOptions`, `PiAiProviderOptions`,
`PiAiModelDefinition`), and the documented exports `estimateCostUsd` / `MODEL_CAPABILITY_PROFILE_SCHEMA`.
Review hardening (no type changes): `ModelRouter.invoke` doc now states the per-invoke re-validation,
fallback tool compatibility and fault semantics; the provider error-mapping note covers truncated streams
and `onDelta` exceptions.

## Testing

```bash
npx tsc -p packages/model --noEmit
node scripts/run-tests.mjs --package model                          # unit + integration (PGlite)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package model # integration on PostgreSQL
```

Unit tests are hermetic: providers are exercised against `node:http` mock servers on 127.0.0.1. The
PostgreSQL-specific integration test skips with an explicit reason when `HYPERTEST_TEST_PG_URL` is unset.
