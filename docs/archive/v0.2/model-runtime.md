# HyperTest model runtime boundary

HyperTest has two planner execution modes. The default is an offline,
deterministic planner. The optional model runtime adds one bounded planner
augmentation loop; it does not replace the deterministic state machine,
quality gate, artifact store, diagnosis rules, or repair policy.

```text
CLI / profile
  -> OpenAI-compatible endpoint
  -> @earendil-works/pi-agent-core
  -> streamed assistant/tool events
  -> HyperTest-owned read-only contract tools
  -> parsed and schema-validated augmentation
  -> deterministic semantic validation and TestPlan merge
  -> model-usage.json + structured run events
```

## Deterministic and model modes

`runtime.provider: deterministic` is the default in examples and CI. It makes
no Provider calls, reports zero tokens and zero estimated cost, and produces a
TestPlan solely from `SutContract`.

`runtime.provider: openai-compatible` enables the real model path. HyperTest
must be able to construct a configured runtime; configuration errors fail the
run and never fall back to deterministic behavior. `--fake-result` remains an
explicit development-test override rather than a deployment fallback.

The model can propose additional planner cases. HyperTest still creates the
final `TestPlan`, applies deterministic de-duplication, and owns all state
transitions. The model cannot decide a BUGate verdict or advance the run state.

## Pi adapter type boundary

`@earendil-works/pi-agent-core` is the only SDK-level agent runtime. The direct
`@earendil-works/pi-ai` dependency supplies the official LLM transport and
nominal stream types used by that runtime; it is not a second agent loop or
policy authority. All Pi package imports, including test-fixture re-exports,
are confined to `src/runtime/pi/**`. The adapter uses the SDK's public
`Agent`, event, tool, model, context, and streaming types directly, so an
incompatible SDK API change is visible to TypeScript. Core, planner,
orchestrator, and CLI code use only HyperTest-owned contracts.

The adapter does not dynamically assemble or import a package name. There are
no Core-owned copies of Pi event or context interfaces, and Pi's core event
conversion path does not use `any` or `unknown as Pi...` assertions.

## Provider configuration

A profile selects the runtime and may supply non-secret defaults:

```json
{
  "runtime": {
    "provider": "openai-compatible",
    "model": "provider-model-exact-id",
    "baseUrl": "https://provider.example/v1",
    "timeoutMs": 30000,
    "maxRetries": 2,
    "maxOutputTokens": 2048,
    "budgets": {
      "maxTurns": 4,
      "maxToolCalls": 8,
      "maxRepairRounds": 0,
      "wallClockMs": 120000,
      "tokenBudget": 20000
    }
  }
}
```

Environment variables override profile values:

| Variable | Meaning |
|---|---|
| `HYPERTEST_MODEL_PROVIDER` | `deterministic` or `openai-compatible` |
| `HYPERTEST_MODEL_ID` | Exact Provider model identifier; no implicit `latest` |
| `HYPERTEST_MODEL_BASE_URL` | HTTPS OpenAI-compatible base URL; HTTP is loopback-only |
| `HYPERTEST_MODEL_API_KEY` | Required secret; environment only |
| `HYPERTEST_MODEL_TIMEOUT_MS` | Per-request timeout, 100–600000 ms |
| `HYPERTEST_MODEL_MAX_RETRIES` | Retry limit, 0–10 |
| `HYPERTEST_MODEL_MAX_OUTPUT_TOKENS` | Output cap, 1–131072 |

The URL cannot contain credentials, a query, or a fragment. Non-loopback
endpoints must use HTTPS; plain HTTP is accepted only for `localhost`, the
`127.0.0.0/8` range, and `[::1]` so local protocol mocks remain available. The
URL is normalized before use. Telemetry records only an irreversible SHA-256
endpoint fingerprint, never the URL. A compatible service, including a
DeepSeek-style OpenAI-compatible deployment, is selected only through the
generic base URL and exact model ID; Core has no Provider-specific fields.

The API key is never accepted from a profile. HyperTest checks that the
environment variable is present without printing its value. Unknown runtime
profile keys are rejected; legacy flattened budget keys remain accepted for
existing profiles.

## CLI activation

`hypertest plan` and `hypertest run` load the profile, apply environment
overrides, validate all bounds, and construct `PiAgentRuntime` when the
resolved Provider is `openai-compatible`.

```bash
export HYPERTEST_MODEL_PROVIDER=openai-compatible
export HYPERTEST_MODEL_ID=provider-model-exact-id
export HYPERTEST_MODEL_BASE_URL=https://provider.example/v1
export HYPERTEST_MODEL_API_KEY='...'
export HYPERTEST_MODEL_TIMEOUT_MS=30000
export HYPERTEST_MODEL_MAX_RETRIES=2
export HYPERTEST_MODEL_MAX_OUTPUT_TOKENS=2048

node dist/src/cli.js plan \
  --profile profiles/model-planner.example.json \
  --workspace .
```

The repository does not include a live Provider profile because examples and
default CI must remain offline and zero-cost. Operators should copy an
existing deterministic profile and change only its `runtime` section.

## Streaming and terminal semantics

Each run produces exactly one `started` event and exactly one terminal event.
The terminal event is either `completed` or `failed`; no event is emitted after
it. A duplicate active run ID is rejected.

Pi subscription callbacks write immediately to an asynchronous queue. The
consumer can observe `text_delta` before the Provider request or
`agent.prompt()` resolves. `tool_requested` is made visible before execution;
`tool_completed` follows execution and carries the same call ID, tool name,
duration, status, and structured result.

Success, Provider failure, cancellation, deadline, output limit, and tool-loop
termination close the queue and remove the active run. Cancellation is
idempotent. The wall-clock deadline uses a timer and aborts the in-flight Pi
request rather than waiting for a whole turn to finish.

## Failure classification

Runtime failures use stable codes:

- `cancelled`, `deadline_exceeded`;
- `provider_error`, `provider_protocol_error`, `provider_rate_limited`;
- `model_output_parse_error`, `model_output_schema_error`;
- `tool_input_schema_error`, `tool_execution_error`, `tool_loop_limit`;
- `output_limit`, `budget_exhausted`.

A failure includes a safe message, a retryable flag, and the Provider request
ID when available. Provider transport/protocol failures are distinct from
model JSON parsing and schema failures. Authentication failures, bad requests,
protocol violations, schema failures, cancellation, and deadlines are not
replayed as whole turns.

## JSON parsing and validation

`expectedResultSchema` is executed by the shared HyperTest validation layer for
`PiAgentRuntime`, `FakeAgentRuntime`, and `ScriptedAgentRuntime`.

The parser accepts a JSON document or one exact fenced JSON document. Empty or
non-JSON output fails with `model_output_parse_error`. Schema mismatch fails
with `model_output_schema_error` and reports only a safe JSON Pointer or
validation path. HyperTest never degrades invalid output to `{ "text": ... }`
and does not put the complete model response into an error or log.

The planner augmentation schema requires a bounded `cases` array. Each case
has bounded `title` and `objective` strings, at least one step, non-empty
`operationId` values, and an `oracle` object. Unknown properties are rejected.
The whole result and streamed output also have byte/token limits.

After structural validation, deterministic planner validation verifies every
operation ID, destructive-operation policy, non-empty case, and existing risk
and oracle constraints. One invalid model case fails the complete augmentation;
it is not silently filtered. Only then does the deterministic planner merge
and de-duplicate cases and write the final artifact.

## Usage and token budgets

Every Provider call emits a usage record containing:

- Provider, model, endpoint fingerprint, and request ID;
- input, output, and cached tokens as separate values when reported;
- latency, retry count, stop reason, and estimated cost when available;
- `usageUnavailable: true` when the Provider omits usage.

A missing usage report is not represented as zero tokens. It is distinct from
the deterministic path, which has zero Provider calls and therefore zero
usage and cost. Per-call records are aggregated by run and persisted as
`model-usage.json`; each physical retry attempt has its own record. Failed
attempts without Provider usage are marked unavailable instead of being folded
into the successful attempt. The summary's aggregate fields are checked
deterministically against its records before persistence.

Before each Provider request, the runtime checks the remaining hard token
budget and shrinks `maxTokens` to the remaining output allowance. Once
reported cumulative input, output, cache-read, and cache-write usage reaches the budget,
another turn is forbidden and the run fails with `budget_exhausted`. If any
earlier physical attempt or tool round supplied no usage, HyperTest fails
closed rather than authorizing another model turn. Planning and an existing
policy-gated repair proposal share the same run-level token ledger; repair
does not receive a fresh budget. If a final request reports more usage than
the pre-request estimate and crosses the limit, its result is rejected with
`budget_exhausted` while the actual usage remains persisted.

## Retry boundary

Retries share the original run deadline and are bounded by configuration. A
whole Provider turn may be retried only for HTTP 429, HTTP 502/503/504,
connection establishment failure, or a retryable network interruption before
the first visible text/tool delta. A valid `Retry-After` seconds or HTTP-date
value is honored up to a one-second local cap and the original run deadline.

Once text is visible, a tool call is visible, or a previous tool result exists
in context, whole-turn replay is disabled. Therefore a retry cannot execute a
tool twice. HTTP 400/401/403, malformed SSE, output/schema errors,
cancellation, and timeout are not retried. Retry count is included in usage
and structured logs. Redirect following is disabled so an allowed endpoint
cannot redirect the Authorization header to another origin.

Successful SSE is validated incrementally before it enters the upstream
OpenAI parser. Malformed `data:` payloads become a redacted protocol error and
are not echoed to stderr. Both an individual SSE event and the unterminated
pending buffer are capped at 1 MiB.

## Planner read-only tools

The model receives a fixed allowlist:

- `contract.list_operations` returns operation ID, title when present,
  effects, interaction kind, input-schema digest, and a small capability view.
- `contract.get_operation` accepts `{ "operationId": "..." }` and returns a
  deterministic JSON view of that operation.

Both tools read only the current in-memory `SutContract`. They cannot read an
arbitrary file, invoke a shell, access a network, write the workspace, call
BUGate, publish a change, or advance the HyperTest state machine. Input is
validated against the declared JSON Schema before execution. Unknown
operations return a structured tool error that the model may handle in the
same bounded loop.

The model cannot register a tool. Turn count, tool-call count, repeated
no-progress calls, output bytes, tokens, and deadline all have hard limits.

## Tests and CI

Default tests instantiate the real `PiAgentRuntime` and use a local loopback
HTTP server speaking real OpenAI-compatible HTTP/SSE. The protocol suite covers
live deltas, incremental tool-call fields, tool results and a second turn,
usage and cached tokens, request IDs, invalid/empty/schema-mismatched output,
rate-limit and service retries, connection interruption before and after a
visible delta, timeout, cancellation, tool loops, output flooding, and secret
redaction.

A separate CLI integration test starts the real CLI process and proves:

```text
profile + environment
  -> PiAgentRuntime
  -> local HTTP/SSE server
  -> model tool request
  -> HyperTest tool execution
  -> second Provider turn
  -> validated model case
  -> deterministic TestPlan merge
  -> TestPlan and usage artifacts
```

No default test requires credentials, calls a public Provider, incurs model
cost, or produces an external side effect.

## Optional live smoke

`npm run test:model:live` performs one bounded read-only planner request only
when all required model variables are explicitly present. With variables
missing, it prints a clear skip message and exits successfully without making
a request.

A live run sends the planner prompt and synthetic read-only contract metadata
to the configured Provider and may incur cost. It has a 30-second deadline,
one retry at most, a small output cap, a 512-token run budget, three turns, and
two tool calls. It prints only Provider/model identity, endpoint fingerprint,
request IDs, aggregate usage, latency, retry count, stop reasons, and case
count. It does not persist the Provider response. The command never prints the
API key.

## Secret handling

Do not place credentials in profiles, source, examples, or artifacts.
`Authorization`, cookies, complete request headers, complete Provider requests,
and unknown response fields that may contain secrets are not logged. HTTP
error bodies and malformed SSE payloads are reduced to stable safe messages.
Provider request IDs are retained only after trimming, a 128-character bound,
a conservative ASCII allowlist, and rejection of any value containing the
configured API key. Unsafe IDs are omitted from events and usage artifacts.

## Known limitations

- Diagnosis remains deterministic rules; it is not a model phase.
- Source-symbol and coverage-guided exploratory testing are not implemented.
- No real Pilot profile has been executed by the default validation.
- A final Provider request can report slightly more tokens than estimated
  before the call; HyperTest records the actual usage and fails the run with
  `budget_exhausted` instead of accepting an over-budget result.
- Provider cache-read and cache-write tokens are both recorded and budgeted in
  the aggregate `cachedTokens` field; the current public `AgentUsage` contract
  does not expose the two cache categories separately.
- Local mock compatibility proves HyperTest's protocol behavior, not every
  external Provider's availability, conformance, or SLA.
- The live paid smoke is optional and is not part of default CI.
- This slice is single-agent and the autonomous read-only tool loop is
  planner-only. The pre-existing repair proposal call has no model tools and
  remains deterministic-policy and BUGate gated. Diagnosis, exploration,
  production-code edits, BUGate tool access, and publication are intentionally
  outside the model runtime boundary.
