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
| `createModelRouter(deps)` | `route()`, `invoke()`, `estimateCostUsd()`, `circuits()` (see below). `deps.retry` sets same-route backoff; `deps.circuitBreaker` configures (or, `false`, disables) the per-route circuit breaker and price guard. |
| `CircuitBreakers`, `DEFAULT_CIRCUIT_BREAKER`, `AVAILABILITY_FAILURES`, `MODEL_CIRCUIT_EVENTS` | The breaker state machine used by the router (exported for tests/operators), its defaults, the error codes that count as availability failures, and the event names `model.circuit_opened` / `model.circuit_closed`. |
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
4. **availability** – the route's circuit breaker is closed, or half-open with its single probe slot free; and, for a
   cost-limited request (`policy.maxCostPerCallUsd` set, or every request with `priceGuard.appliesTo: 'all'`), the
   catalog price is within the configured ceiling (a non-finite price never passes). It comes AFTER every eligibility
   stage, so it only ever removes routes those stages accepted — it can never admit an ineligible one.
5. **latency** – `typicalLatencyMs ≤ latencyBudgetMs`. 6. **cost** – `(ctx in, maxOutputTokens out) ≤ maxCostPerCallUsd`.

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
`model.fallback` (`from`, `to|null`, `reason`, `policy`). A failure to append `model.invoked` after a
successful (paid) call is never reported as a model failure with a fallback, and never discards the response: the
append is retried (`AUDIT_APPEND_ATTEMPTS` = 3, short backoff); if the store stays unavailable the response is returned
with `auditPending: { code, message }` (logged as an error) so the caller settles its usage instead of releasing the
reservation and re-paying the call (durability-10). Audit failures around a FAILED call are still thrown as faults.

Streaming deltas are a preview: a same-route retry streams again after the failed attempt's partial
deltas; the returned response is authoritative. A response whose opaque reasoning carries a different
continuation class than the route declares is logged as a catalog misconfiguration (it would never be
replayed): Anthropic routes must declare `anthropic:<model>`, pi-ai routes `pi-ai:<api>:<piProvider>:<model>`.

### Circuit breaker (technology-selection §关键风险: 模型价格/限流突然变化)

Per route, in memory of the router instance (one per worker process; re-learned after a restart). Enabled by default
(`DEFAULT_CIRCUIT_BREAKER`); `RouterDeps.circuitBreaker: false` disables it.

- **closed → open** after `failureThreshold` (default 5) consecutive availability failures (`rate_limited`, `unavailable`,
  `timeout`; each provider attempt counts) or a **rate-limit storm**: `rateLimitStorm.count` (default 8) `rate_limited`
  failures within `windowMs` (default 60 s), successes in between notwithstanding. A bad request (`provider_error`), a
  caller cancellation or an internal fault is no availability signal: it neither counts nor resets.
- Same-route retries stop as soon as the breaker opens (never a retry into an open circuit).
- **open → half-open** after `cooldownMs` (default 30 s): the route is selectable again, and the next invoke takes the
  single **probe** slot (one attempt, no same-route retries). Concurrent calls are refused while the probe is out.
  Probe success ⇒ **closed** (`model.circuit_closed`, reason `probe_succeeded`); an availability failure ⇒ **open** again
  with the cooldown × `cooldownBackoff` (default 2, capped at `maxCooldownMs`, default 10 min); a probe without an
  availability verdict (bad request, caller cancel) frees the slot and stays half-open. Only the probe closes an open
  breaker: a call that started while closed and answers after the breaker opened proves nothing.
- **Fail-closed interaction with fallbacks**: `invoke()` re-validates the decision including `availability`, so a
  decision whose route opened since (or whose probe slot is taken) is refused **without a provider call**
  (`precondition_failed`, `attempts: 0`, `details.stage: 'availability'`); under `fallback: 'fail_closed'` there is no
  fallback, otherwise the full re-route (every stage, security first) excludes the route — an open route or an
  ineligible (e.g. security-rejected) one is never a fallback.
- **Price guard** (`priceGuard: { default?, routes?, appliesTo? }`, ceilings in USD per million input/output tokens): a
  catalog price above the ceiling opens the breaker **for cost-limited policies**; recorded once as
  `model.circuit_opened` (reason `price_ceiling`, price, ceiling, catalog revision) and as `model.circuit_closed`
  (`price_ceiling_cleared`) when a later catalog revision brings it back under.
- **Price-change guard** (A[1]; `priceGuard.maxIncreasePct`, configured as `models.priceGuard` by the app): runtime
  prices are observable through a `PriceSource` (`RouterDeps.prices`; the app's is the prices file,
  `createFilePriceSource`, re-read at every routing/invoke boundary when its inode/mtime/size changes, the last good
  prices kept when it becomes unreadable). An observed price more than `maxIncreasePct` above the catalog price opens the
  route's circuit for **all** requests (`model.circuit_opened`, reason `price_change`, with `increasePct`,
  `observedPrice`, `catalogPrice`); a later observation back within the guard closes it (`price_change_cleared`). The
  observed price also becomes the route's price for cost estimation and the cost stage.
- **Unknown cost** (A[2]): `costPerMillionInputUsd` / `costPerMillionOutputUsd` are optional. `estimateCostUsd` returns
  `NaN` for an unknown price (`costKnown(profile)`); a cost-limited request (`policy.maxCostPerCallUsd`, or
  `RouteRequest.costBudgeted` — the run or work item has a USD budget) never routes to a cost-unknown route (cost stage:
  "route cost is unknown … and the request is cost-limited"); `RouteRequest.cheaperThanUsd` keeps only strictly cheaper
  routes (the runtime's cost switch).
- Events (aggregate `model`, aggregateId = routeId): `model.circuit_opened` `{ routeId, provider, model, reason
  (consecutive_failures | rate_limit_storm | probe_failed | price_ceiling), code, consecutiveFailures, rateLimitsInWindow,
  cooldownMs, halfOpenAt }` and `model.circuit_closed` — appended in ONE batch with the `model.invoked` of the call that
  caused them (a sink failure around a failed call is a fault, as for `model.invoked`).
- `router.circuits()` lists the state of every route that has a breaker (`closed | open | half_open`, counts, times).

### Availability, credentials and the PAUSE signal (A[0], e2e[3])

- `ModelProvider.availability?()` reports whether a provider can be called at all. The HTTP providers take
  `requireApiKey` / `apiKeySource`: a required credential that is missing or empty makes the provider unavailable
  (`provider X has no credential: environment variable VAR is not set or empty (fail closed: no request is sent)`) — the
  router rejects its routes at the capability stage and `complete()` throws `precondition_failed` before any fetch.
- A failed `route()` / `invoke()` carries `unavailable: ModelUnavailability` `{ transient, reason, retryAt?, routes }`:
  `transient` when only availability stopped every route (open circuits, rate limits / timeouts after retries; `retryAt`
  from Retry-After or the earliest half-open time) — the runtime PAUSES the agent; otherwise no configured route may
  ever serve the request (security, capability, a missing credential …) and the runtime fails closed with that exact
  reason.
- `router.validate(decision, request)` re-checks a decision without calling (the runtime's switch re-check before an
  epoch), `router.catalogRevision`, and `router.probeNow(routeIds?)` makes open circuits half-open now (an operator
  resume; the probe still decides).

### Eval scores (coverage[7])

`deriveRouteScores({ suiteId, revision, trials }, { minTrials = 3 })` turns graded eval trials (each with the
`modelRoutes` its agents used) into a `RouteScoresFile` `{ version: 1, scores: { routeId: { role: score } }, source }`:
score = (passes + 1) / (graded trials + 2) per (route, role) with at least `minTrials` graded trials (infra errors are
not graded), with provenance (`suiteId`, `revision`, `inputDigest`, `trials`, `method`). `parseRouteScoresFile`
validates one. The app merges it into the catalog (`ModelCatalog.withScores`) from `models.scoresFile`.

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
| I10 route/invoke/fallback events with full correlation; a sink failure is never masked as a model failure; after a paid call the append is retried and a persistent failure returns the response `auditPending` (never discarded, never re-called, no fallback) | `test/router.test.ts`, `test/router-invoke.test.ts`, `test/events.int.test.ts` (jsonb round-trip on PGlite and PostgreSQL 16) |
| Provider error mapping, timeout vs cancel, SSE robustness (truncation), caller-callback faults, secret scrubbing | `test/openai.test.ts`, `test/anthropic.test.ts`, `test/pi-ai.test.ts`, `test/transport.test.ts`, `test/scripted.test.ts` |
| Catalog immutability / validation | `test/catalog-registry.test.ts` |
| Availability (A[0]/e2e[3]): transient vs permanent unavailability, retryAt, missing credential ⇒ unavailable with zero fetch calls; price-change guard opens/closes with L0 events; unknown cost refused for cost-limited requests | `test/availability.test.ts` |
| Circuit breaker: open after N consecutive failures / rate-limit storm, no retry into an open circuit, single half-open probe (concurrent calls refused), backoff, stale successes never close it, fail-closed interaction with fallbacks (no provider call, no fallback under fail_closed, never an open or insecure fallback), property: availability only ever removes candidates, price guard for cost-limited policies, events batched with the call | `test/circuit-breaker.test.ts` |

## Contract changes (additive, 0.3)

`RouterDeps.retry?`, `InvokeRequest.onDelta?`, provider option interfaces (`ScriptedProviderOptions`,
`OpenAICompatibleProviderOptions`, `AnthropicProviderOptions`, `PiAiProviderOptions`,
`PiAiModelDefinition`), and the documented exports `estimateCostUsd` / `MODEL_CAPABILITY_PROFILE_SCHEMA`.
(hardening) `InvokeOutcome` ok variant `auditPending?: { code, message }`; export `AUDIT_APPEND_ATTEMPTS`.
Review hardening (no type changes): `ModelRouter.invoke` doc now states the per-invoke re-validation,
fallback tool compatibility and fault semantics; the provider error-mapping note covers truncated streams
and `onDelta` exceptions.
(unit B2, circuit breaker) `RouterDeps.circuitBreaker?: CircuitBreakerOptions | false` (default: enabled with
`DEFAULT_CIRCUIT_BREAKER`); `RouteRejection.stage` gains `'availability'`; `ROUTING_STAGES` lists `availability` after
`quality`; optional `ModelRouter.circuits?()`; new types `CircuitBreakerOptions`, `PriceCeiling`, `CircuitState`,
`CircuitSnapshot`; exports `CircuitBreakers`, `DEFAULT_CIRCUIT_BREAKER`, `AVAILABILITY_FAILURES`, `MODEL_CIRCUIT_EVENTS`
(`model.circuit_opened` / `model.circuit_closed` — not yet in the domain `EVENT_TYPES` catalog). Behaviour: an open
route is rejected at routing and refused by `invoke()` before any provider call (`precondition_failed`).

(unit model-runtime, wave 1)
- `ModelCapabilityProfile.costPerMillionInputUsd` / `costPerMillionOutputUsd` are **optional** (unknown cost);
  `estimateCostUsd` returns `NaN` for them; new `costKnown`. The catalog schema no longer requires them.
- `ModelProvider.availability?(): ProviderAvailability`; provider options `requireApiKey?`, `apiKeySource?`; helpers
  `credentialAvailability`, `missingCredentialError`.
- `RouteRequest.costBudgeted?`, `cheaperThanUsd?`; `ModelUnavailability`; failure variants of `RouteDecision` /
  `InvokeOutcome` gain `unavailable?`; `DecisionCheck`; `ModelRouter.validate?`, `catalogRevision?`, `probeNow?`.
- `RouterDeps.prices?: PriceSource` (`ObservedPrice`); `CircuitBreakerOptions.priceGuard.maxIncreasePct?`; new
  `src/prices.ts` (`parsePricesFile`, `createFilePriceSource`, `readPricesFile`, `updatePricesFile` — atomic write) and
  `src/scores.ts` (`deriveRouteScores`, `parseRouteScoresFile`, `ROUTE_SCORES_METHOD`, `RouteScoresFile`, `ScoredTrial`).
- `model.invoked` (ok) payload gains `estimatedInputTokens` (the caller's input estimate, measured against
  `usage.inputTokens` for the runtime's token calibration).

## Testing

```bash
npx tsc -p packages/model --noEmit
node scripts/run-tests.mjs --package model                          # unit + integration (PGlite)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package model # integration on PostgreSQL
```

Unit tests are hermetic: providers are exercised against `node:http` mock servers on 127.0.0.1. The
PostgreSQL-specific integration test skips with an explicit reason when `HYPERTEST_TEST_PG_URL` is unset.
