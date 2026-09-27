# @hypertest/runtime-dsh

`AgentEngine` adapter over the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) agent loop
**0.1.0-rc.6**. This is **pin + adapter, no fork**. DSH supplies the loop mechanics:
- the turn and step lifecycle and inbox claim;
- request assembly and stream chunk assembly;
- the tool scheduler with its parallel pool;
- the tool execution pipeline.

Hypertest keeps everything the Agent Runtime ABI reserves for the host:
- the model (routing, epochs, budgets) through `host.model`;
- tools (capability → permit → freshness → operation → evidence) through `host.tools`;
- context assembly through `host.context`;
- persistence through the `SessionStore`.

DSH types never leave this package (checked by `test/public-api.test.ts`). Sessions, transcripts, turn records,
outcomes and events are exactly `NativeEngine`'s, so a session is portable between engines at a turn boundary.

Depends on `@hypertest/core`, `domain`, `model` (usage type), `runtime` (ABI, helpers, contract suite) and the pinned DSH
train: `@deepseek-ai/dsh-*` 0.1.0-rc.6, `@deepseek-ai/cordis` 4.0.4 and the two `@deepseek-ai` libraries the train loads
through version ranges (`schemastery` 3.18.4, `cosmokit` 1.8.5), all MIT (see *Pin*). The app registers it when
`engines.default: dsh` (see `@hypertest/app`).

## Fork decision gate (architecture-improvements §Fork 决策门)

**Evaluated.** The published DSH packages are a Developer Preview release train. The `latest` dist-tag of `dsh-agent` is
0.1.0-rc.6; `next` is 0.1.7-rc.2. The adapter uses these packages and seams:

| Package | What the adapter uses |
|---|---|
| `dsh-agent` | `Agent` handle and `AgentRegistry` factory (`ctx.agents.create` with `seed` and `setup`); the events `agent/pre-step`, `agent/error` |
| `dsh-agent-loop` | `AgentLoop`, the only concrete loop: turn/step driver, `executeToolCalls` scheduler, `maxParallelToolCalls` |
| `dsh-llm` | `LlmAdapter` provider seam (`registerAdapter`), `GenerateOptions.sessionId`, the `StreamChunk` protocol, message constructors |
| `dsh-tools` | agent-scoped `ctx.tools.register` (raw JSON-schema tools, `isConcurrencySafe`), `tools/post-execute` |
| `dsh-session` | the event-sourced `Session` seeded through `create({ seed })` |
| `dsh-system-prompt` | required by the loop; its persona never reaches a model |

Required peers are pinned too: `dsh-scope`, `dsh-settings`, `dsh-timeout`, `dsh-invariants`, `dsh-typert-protocol`,
`dsh-attachment`, `dsh-brand`, `dsh-code-runtime`, `dsh-user-approval` and `dsh-session-persistence`. The last three
are only type-level or optional at runtime.

**ABI requirements against DSH's public seams:**

| ABI requirement | DSH seam | Verdict |
|---|---|---|
| Externally supplied model client (`EngineHost.model`), one model response per `runTurn` | A `hypertest` provider route served by a Hypertest `LlmAdapter`. `agent/pre-step` rejects every step after the first. The response is streamed as DSH chunks and never marked `max-tokens`, because DSH skips the calls of a length-limited step | ✓ public seam |
| Externally supplied tools (`EngineHost.tools`), host-owned validation and policy | Agent-scoped raw tools with open parameters, so DSH validates nothing and no policy plugin is loaded. The body calls `host.tools.dispatch` with the recorded IR call. A tool is registered for every name the response calls, so DSH never answers `UNKNOWN_TOOL` | ✓ public seam |
| Per-call parallel-safety order | DSH's scheduler is per call: exclusive calls are barriers, and consecutive `isConcurrencySafe` calls share a bounded rolling pool (`maxParallelToolCalls` = `PARALLEL_TOOL_CONCURRENCY`), started in order. No gate is needed, unlike pi | ✓ native |
| `SessionStore` as the persistence; transcript rebuilt from the portable IR each turn | A fresh DSH session is created per turn, seeded with a projection of the transcript (`convert.ts`). No DSH persistence plugin is loaded. DSH's log is disposable and is never read back as truth, only cross-checked | ✓ public seam |
| Response persisted before any tool runs | The adapter records the response and its pending rows, and settles the engine decisions, before it yields the first chunk | ✓ |
| Tool failures are outcomes, faults are faults | Error results use a scoped `tools/post-execute` block, so DSH's error flag equals the host's. Faults are captured, stop the DSH agent (`cancel`) and are rethrown after DSH drains | ✓ |
| Abort / interrupt; no fabricated results | The ABI signal triggers `agent.cancel({kind:'parent'})`. DSH drains started calls; results arriving after the abort are not settled. DSH's synthetic `ABORTED_BEFORE_DISPATCH` results stay in its disposable log | ✓ |
| No engine types in the domain; version pinning (I11) | DSH types are package-private. `version` is the pinned dsh-agent version, and construction fails closed on any drift | ✓ |

**Decision: pin + adapter.** No surgical patch or vendoring was needed, and no DSH package is forked. The
irreducible-gap conditions of the gate did not occur:
- Hypertest does not need to change DSH's persistent state semantics, security boundary or lifecycle.
- No Hypertest domain concept enters DSH's internal state: DSH sees text, tool names, argument text and results.

The DSH capabilities Hypertest owns itself are simply not loaded. These are subagents, workflows, jobs, persistence,
compaction, retry, permission, sandbox and provider adapters.

**Conditions to revisit:**
- **A DSH upgrade.** DSH has no semver promise. Pin the new train in `package.json` and `DSH_PINS`, then re-run the
  contract suite and this package's tests. Any change to one of these must be re-verified: `agent/pre-step` rejection
  semantics, the per-call scheduler (`executeToolCalls`), the finish kinds (`max-tokens` skips tools),
  `tools/post-execute` blocks, `LlmAdapter.stream` errors (normalized to terminal finishes), seed validation.
- **A DSH turn-budget or step-limit seam.** If one appears, it could replace the `agent/pre-step` rejection.
- **A per-call parallel-safety seam** (the classifier sees only arguments). The per-tool rule below would become exact.
- **A cost problem with the per-turn agent** (about 1–5 ms per turn plus an O(transcript) seed rebuild). This would
  justify a long-lived DSH agent per session, which needs a seam that resumes from a Hypertest-owned log.
- **Any feature that would require DSH to own model routing, tool policy or persistence.** That fails the gate, and the
  feature must be built in Hypertest.

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `DshEngine` | `class DshEngine implements AgentEngine`. `kind: 'dsh'`. `version` is the installed `@deepseek-ai/dsh-agent` version, which RuntimeManifests pin (I11). `adapterVersion` is this package's version. The constructor takes `DshEngineDeps` and throws `precondition_failed` when any pinned DSH package is not installed at exactly its pin (see *Pin*). `close()` (additive) disposes the DSH kernel; a later turn boots a new one. Call it once turns are drained (the app closes it after the durable runtime): closing under a running turn disposes that turn's DSH agent, which leaves the turn `started` or `model_responded` (replayed later), never a fabricated result. `liveDshSessions()` (additive, diagnostics) returns 0 between turns. |
| `DSH_ENGINE_KIND` | `'dsh'`. |
| `DshEngineDeps` | (additive contract) `= NativeEngineDeps` from `@hypertest/runtime`; the contract suite's `EngineContractDeps` satisfy it. |
| `DSH_AGENT_VERSION`, `SUPPORTED_DSH_VERSION`, `DSH_PINS`, `RUNTIME_DSH_PACKAGE_VERSION` | The installed dsh-agent version, the supported train (`0.1.0-rc.6`), the frozen map of every pinned `@deepseek-ai` package to its exact version (what the app records in the manifest), and the adapter version. |

Capabilities (honest):
- `providerSwitch: true`: the host invoker starts epochs at turn boundaries.
- `continuableChild: true`, `backgroundChild: false`.
- `peerMessaging: true`: through the SessionStore input queue.
- `structuredOutput: true`: `responseFormat` is passed to the host invoker.
- `sandboxProfiles: false`.
- `nativeCompaction: false`: no DSH compaction plugin is loaded.
- `nativeComputerUse: false`.

## The turn: one Hypertest turn = one DSH turn of one step

`runTurn` does the NativeEngine bookkeeping first: status and abort registration, draining inputs exactly once, context
assembly with the snapshot fixed, `beginTurn`, `agent.turn_started`. It then creates a DSH agent through the public
factory (`ctx.agents.create`) over a fresh DSH session seeded with the projection of the portable transcript, and wakes
it once:

| DSH extension point | Hypertest behaviour |
|---|---|
| `LlmAdapter` for route `hypertest` (`kernel.ts`, keyed by the `sessionId` the loop stamps on every request) | Calls `host.model.invoke` **exactly once** with the host-assembled `TurnContext` (messages, tools, responseFormat, snapshotId), never with DSH's derived history, tool schemas or system prompt. On `ok`: `normalizeResponse`; **`recordModelResponse` with one pending row per call**; the engine decisions (repetition, per-turn cap, malformed arguments) are settled in call order; tools are registered for called names the context did not declare; then the response is streamed (block start/delta/end per block, then `finish` = `tool-calls` or `stop`, never `max-tokens`). Not `ok`: an `error` finish (its failure message is never empty: DSH refuses empty failure messages), so DSH ends the step without tools and the turn completes as `boundary`. On abort: an `aborted` finish, and the turn stays `started`. A second request in the same turn is refused without calling the model. |
| Agent-scoped tools (`setup`) | One per declared tool **and** per name the response calls. DSH's listing is never shown to a model, so a definition DSH could not log (a description that is not a string) gets a placeholder description instead of stopping the turn before the model is asked. Names are escaped bijectively, because DSH reserves `run_code` (the empty name and the escape prefix are escaped too). Parameters are open: DSH validates only `defineTool` schemas, never these, and its argument snapshot receives the re-serialized IR arguments (lossless JSON: `-0` never reaches DSH). `execute`: a call settled or decided earlier answers from the record; otherwise the body runs `host.tools.dispatch(call, {invocationId: sessionId:turn:callId})` with the recorded IR call and settles immediately. `isConcurrencySafe` is `host.tools.isParallelSafe(name)`. A tool whose every call in the turn only answers from the record is parallel-safe, so it neither splits a parallel batch nor overlaps an exclusive call (NativeEngine batching). |
| `tools/post-execute` (scoped) | A host error result becomes a DSH failure with the identical content (`block`). DSH's error flag is the settled result's. |
| `agent/pre-step` (scoped) | Step 1 of the live DSH turn enters with the Hypertest turn's input. That is the inputs after the last response, or a `[Hypertest turn N]` plugin notice when there is none, because DSH enters a step only with input. Every other step is rejected, so after the tools DSH closes the turn `blocked` (a text-only step closes `completed`). |
| `agent/error` (scoped) | DSH-reported failures are collected for diagnostics and for internal-fault messages. |

After DSH is idle, the DSH agent and its session are disposed. The engine then commits exactly like NativeEngine:
- **Outcome:** the first `complete` ⇒ `completed`, else `fail` ⇒ `failed`, else pending operations ⇒ `waiting`, else
  `continue`. A text-only turn queues `TEXT_ONLY_NUDGE`; repetition ⇒ `failed/repetitive_loop`.
- **Event:** `agent.turn_completed` with the deterministic `turnCompletedEventId`.
- **Commit:** `completeTurn('completed')` with the transcript, queued inputs, session status and `TurnRecord.outcome` in
  one transaction.

DSH's own record of the live turn (`viewOfTurn`: steps, calls, results) is cross-checked against the recorded response
and results. A divergence is logged and the recorded turn wins. A debug log `dsh turn trace` lists DSH's session events
for the turn.

**Faults.** A dispatcher throw, a malformed dispatcher result, a settlement or recording failure and an invoker throw
are all captured. The DSH agent is cancelled, so no further call starts; in-flight calls drain and settle. The fault is
rethrown after DSH is idle. Nothing is fabricated, and the turn stays `started` (no response) or `model_responded`
(replayable). If DSH finishes a turn without routing a call through the engine, or refuses the agent (seed), that is an
`internal` fault (fail closed). Engine decisions are settled before anything is dispatched, and a failed settlement
stops the turn: later decisions stay unsettled, row for row as in NativeEngine.

**Replay.** A `model_responded` turn is replayed through DSH. The adapter streams the recorded response (no model call),
settled calls answer from the record, and only unsettled calls are dispatched, with their recorded invocation ids. The
replay registers exactly the tools the recorded response calls and never consults the host's current tool definitions
(only `dispatch` and `isParallelSafe`).

**Resume.** `resumeChild` validates everything `runTurn` would refuse before it reactivates an `interrupted` or
`waiting` session: the session and the ref must be `dsh`, and the limits valid.

**Abort / interrupt.** Identical to NativeEngine:
- A result arriving while aborting is not settled, and later calls are not dispatched.
- `interrupt()` marks the session `interrupted` and aborts the running turn (DSH ends it `aborted`).
- An interrupt landing from another process is preserved by `completeTurn`.

**Pin.** `DSH_PINS` (`src/version.ts`) must equal the exact `@deepseek-ai` pins in `package.json` (tested). It covers
the dsh-* 0.1.0-rc.6 train, including required peers (npm would otherwise resolve them to newer release candidates),
cordis 4.0.4, and `schemastery` 3.18.4 and `cosmokit` 1.8.5: the train loads these two at runtime but declares them as
ranges (`^3.18.1`, `~1.8.5`), so without their own pins they could drift unnoticed. The pin set is closed: every
`@deepseek-ai` dependency or required peer of a pinned package is itself pinned (tested). A `DshEngine` refuses to be
constructed unless every pinned package resolves at exactly its pin (`precondition_failed` listing the drift), so a
drifted install fails closed instead of running unverified. The app records every pin in the RuntimeManifest.

## The DSH kernel (`src/kernel.ts`, package-private)

Each engine has one cordis root, booted lazily at the first turn; a failed boot is retried by the next turn. It carries
exactly `agents`, `sessions` (in memory), `llm`, `systemPrompt`, `tools` and `agentLoop` (`maxParallelToolCalls` =
`PARALLEL_TOOL_CONCURRENCY` = 4), plus the `hypertest` route. It loads no provider adapter, tool plugin, persistence,
retry, compaction, permission, sandbox, subagent or workflow plugin. Cordis log records are forwarded to the Hypertest
`Logger`: errors and warnings as warnings, the rest at debug level. Nothing goes to the console, and an idle root holds
no handle open.

## IR → DSH projection (`src/convert.ts`, package-private)

DSH's log is **faithful** on everything DSH acts on: turn and step structure, tool-call ids, names and argument text,
tool results with their error flags, and reasoning text. DSH turns are cut at model responses: the inputs since the
previous response enter the step whose response follows them (turn-0 task input, wake-ups, the nudge, inputs of
boundary turns). A call with no recorded result gets a synthetic error result, and an orphan result becomes a plugin
notice, so a seed never has a dangling call. Seed events are stamped from the engine `Clock`, truncated and clamped to
the safe-integer time DSH's session boundary requires (a non-finite reading becomes 0): any legal `Clock`, including a
fractional-millisecond one, serves every turn.

DSH has no core slot for some IR facts. It **approximates** them:
- System messages become `user/message`s with a plugin source (`hypertest`, form `instructions`).
- Images become text placeholders, because DSH images need its attachment service.
- Opaque reasoning is not projected: provider continuation compatibility is the host's (`projectForRoute`).

None of this reaches a model, because the host context is what the model sees.

## Invariants and their tests

| Invariant | Tests |
|---|---|
| AgentEngine contract (persistence, response before tools, crash replay with the same invocation ids, completion, fail, waiting, boundary, nudge, repetition, parallel order, abort/interrupt, outcome recording, malformed args, per-turn cap, child isolation) | `test/dsh-engine.test.ts` → `engineContractSuite('dsh', …)` (18 tests) |
| One Hypertest turn = one DSH turn of one step; exactly one host model call per turn (none on replay); DSH drives streaming and tool execution; every DSH agent is disposed | "one Hypertest turn = one DSH turn of one step…", "replay goes through DSH…" |
| Pin: every `@deepseek-ai` dependency is an exact pin, installed as pinned, and the pin set is closed over the train's `@deepseek-ai` dependencies and required peers; any drift (single package, range, missing, a range-resolved library) is refused | "pin + adapter: every @deepseek-ai dependency is an exact pin…" |
| I11: version = pinned dsh-agent; a run pinned to another version is refused | "identity…", "I11: a run pinned to another DSH version is refused…" |
| Parallel-safety order and bound through DSH's scheduler; an engine-decided call does not split a parallel batch (NativeEngine parity) | contract suite, "parallel-safe calls are bounded to 4…", "an engine-decided call between parallel-safe calls…" |
| Tool policy stays with the host (I1): undeclared tools, DSH-reserved names (`run_code`) and raw arguments reach the dispatcher; arguments are dispatched exactly as recorded | "a tool the context did not declare — or whose name DSH reserves…", "arguments are dispatched exactly as recorded…" |
| DSH never decides tool policy from a finish reason: a length-limited response still reaches the dispatcher | "a length-limited response never lets DSH skip its calls…" |
| The model sees exactly the host-assembled context, never DSH's history or persona | "the model sees exactly the host-assembled context…" |
| Response persisted before tools (failure path: recording fails ⇒ nothing dispatched, turn re-run) | "response persisted before tools…" |
| A model boundary ends DSH's step as that boundary, even without a host message | "a model boundary without a message still ends the DSH step cleanly…" |
| Faults are never swallowed by DSH (dispatch fault with in-flight settlement, decision settlement fault, malformed dispatcher result, malformed terminal, model fault); after a fault nothing more happens (parity with NativeEngine) | "a dispatch fault…", "a failed settlement of an engine decision…", "a dispatcher result without a tool message…", "a malformed terminal signal…", "a model fault propagates…", "after a fault the turn does nothing more…" |
| No fabricated results on abort/interrupt; replay re-dispatches with the same invocation id | "an abort right after the response is recorded…", "interrupt while DSH executes a tool…", "abort while an exclusive call waits…", contract suite |
| I10 turn events identical to NativeEngine; a failed emit leaves the turn replayable | "turn events carry the same payloads…", "a failed turn_completed emit…", "a text-only turn left model_responded…" |
| A replay depends only on the record and `dispatch` | "a replay depends only on the record and dispatch…" |
| A misrouted or malformed `resumeChild` never un-interrupts a session; other engines' sessions are refused | "resumeChild validates before reactivating…", "sessions of another engine kind are refused" |
| Concurrent turns share one kernel without crossing; `close()` disposes the kernel and the next turn boots a new one | "concurrent turns of different sessions…", "close() disposes the DSH kernel…" |
| Rich transcripts (system input, images, reasoning, opaque continuation, malformed calls, boundary turns, reused call ids) project into DSH without divergence | "rich transcripts … project into DSH without divergence" |
| Projection: bijective tool-name escaping, lossless argument text, a valid seed accepted by DSH's `Session` with the expected derived history, chunk assembly equal to the projected message (never `max-tokens`), the turn view | `test/convert.test.ts` |
| Any `Clock` serves (a fractional-millisecond clock never makes DSH refuse a seeded agent); a host tool definition DSH could not log (no string description) still reaches the model untouched | "any Clock serves…", "a host tool definition DSH could not log…", `test/convert.test.ts` ("any Clock reading stamps a seed DSH accepts…") |
| Kernel: boot fails closed (and DSH's error log reaches the Hypertest logger); an unserved session's request fails its step; a live DSH session id is exclusive; DSH refuses malformed seeds | `test/kernel.test.ts` |
| No DSH or cordis type in exported signatures | `test/public-api.test.ts` (TypeScript declaration emit of the public surface) |
| `engines.default: dsh` end to end (tiny run, same verdict; manifest pins the DSH train) | `packages/app/test/engine-dsh.e2e.test.ts` |

## Contract changes (additive)

This is a new package. It adds the `DshEngineDeps` type (= `NativeEngineDeps`) and the exports `DshEngine` (with the
additive `adapterVersion`, `close()` and `liveDshSessions()`), `DSH_ENGINE_KIND`, `DSH_AGENT_VERSION`,
`SUPPORTED_DSH_VERSION`, `DSH_PINS` and `RUNTIME_DSH_PACKAGE_VERSION`. The ABI of `@hypertest/runtime` is unchanged.

## Testing

```bash
npx tsc -p packages/runtime-dsh --noEmit
node scripts/run-tests.mjs --package runtime-dsh                            # PGlite
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package runtime-dsh # PostgreSQL 16 (HYPERTEST_TEST_PG_URL)
```

All tests are hermetic unit tests (`*.test.ts`). The contract suite and the engine specifics each use one migrated
database; conversion, kernel and public-API tests use none. The public-API test runs the TypeScript compiler (about
7 s).
