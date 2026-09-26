# @hypertest/runtime-pi

`AgentEngine` adapter over [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) **0.87.1** (pin +
adapter, no fork). pi-agent-core supplies the loop mechanics — request → streamed response → tool preparation →
tool execution → turn end — while Hypertest keeps everything the Agent Runtime ABI reserves for the host: the model
(routing, epochs, budgets) through `host.model`, tools (capability → permit → freshness → operation → evidence)
through `host.tools`, context assembly through `host.context`, and persistence through the `SessionStore`. pi types
never leave this package (checked by `test/public-api.test.ts`); sessions, transcripts, turn records, outcomes and
events are exactly `NativeEngine`'s, so a session is portable between engines at a turn boundary.

Depends on `@hypertest/core`, `domain`, `model` (usage mapping `mapPiUsage`), `runtime` (ABI, helpers, contract suite)
and the pinned `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 0.87.1.

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `PiEngine` | `class PiEngine implements AgentEngine`. `kind: 'pi'`; `version` = the installed pi-agent-core version (its `package.json` via `createRequire`; what RuntimeManifests pin, I11); `adapterVersion` = this package's version. Constructor takes `PiEngineDeps` (`sessions`, `ids`, `clock`, `logger`, `events?`) and throws `precondition_failed` when the installed pi-agent-core is not the pinned `0.87.1` (see *Pin*). |
| `PI_ENGINE_KIND` | `'pi'`. |
| `PiEngineDeps` | (additive contract) `= NativeEngineDeps` from `@hypertest/runtime`; the contract suite's `EngineContractDeps` satisfy it. |
| `PI_AGENT_CORE_VERSION`, `RUNTIME_PI_PACKAGE_VERSION` | The pinned engine version and the adapter version. |

Capabilities (honest): `providerSwitch: true` (the host invoker starts epochs at turn boundaries), `continuableChild: true`,
`backgroundChild: false`, `peerMessaging: true` (SessionStore input queue), `structuredOutput: true` (`responseFormat`
is passed to the host invoker), `sandboxProfiles: false`, `nativeCompaction: false` (compaction is Hypertest's context
layer; pi's harness compaction is not used), `nativeComputerUse: false`.

## The turn: one Hypertest turn = one pi turn

`runTurn` does the NativeEngine bookkeeping (status/abort registration, input drain exactly once, context assembly with
the snapshot fixed, `beginTurn`, `agent.turn_started`) and then runs **one** pi `runAgentLoop` whose state is rebuilt
from the portable SessionStore transcript (`convert.ts`, lossless IR → pi projection):

| pi extension point | Hypertest behaviour |
|---|---|
| `StreamFn` (shim, `stream.ts`) | Calls `host.model.invoke` **exactly once** with the host-assembled `TurnContext` (messages, tools, responseFormat, snapshotId — never pi's own transcript/tool declarations). `ok` ⇒ `normalizeResponse`, **`recordModelResponse` with one pending row per call before pi sees the response** (hence before any tool runs), then the response is streamed to pi as pi-ai events (`start` → text/thinking/toolcall start·delta·end → `done`). Not ok ⇒ an `error` stream (pi ends without tools; the turn completes as `boundary`); abort ⇒ `aborted` stream (turn stays `started`). A second request in the same turn is refused without calling the model. |
| AgentTools | One per declared tool **and** per name the response calls (unknown tools stay the dispatcher's decision, never pi's "tool not found"). Parameters are permissive: pi-ai validation/coercion never pre-empts the host's validation; the dispatched arguments are the recorded IR arguments. `execute` = gate → `host.tools.dispatch(call, {invocationId: sessionId:turn:callId})` → settle immediately. |
| `beforeToolCall` | Engine decisions, never dispatched: repetition (`repetitive_loop`), calls beyond `maxToolCallsPerTurn`, malformed arguments — settled as error results and blocked (pi emits the same error result). |
| `afterToolCall` | pi's error flag = the settled result's `isError`. |
| `toolExecution: 'parallel'` + `DispatchGate` (`gate.ts`) | pi's `executionMode` is per batch (one sequential tool serializes all); the gate restores the ABI's per-call order: consecutive `isParallelSafe` calls concurrently (≤ `PARALLEL_TOOL_CONCURRENCY` = 4, started in call order), every other call alone, in order. |
| `finishTurn` | `{ action: 'end' }`: pi stops after the first response's tools. |

After the loop the engine commits exactly like NativeEngine: outcome (first `complete` ⇒ `completed`, else `fail` ⇒
`failed`, else pending operations ⇒ `waiting`, else `continue`; text-only ⇒ `TEXT_ONLY_NUDGE` queued; repetition ⇒
`failed/repetitive_loop`), `agent.turn_completed` with the deterministic `turnCompletedEventId`, then
`completeTurn('completed')` with transcript, queued inputs, session status and `TurnRecord.outcome` in one transaction.
pi's own view of the turn (its `turn_end`) is cross-checked against the recorded response/results (divergence is logged;
the recorded turn wins). A debug log `pi turn trace` lists pi's lifecycle events per turn.

**Faults.** pi turns thrown tool errors into error results; the adapter therefore captures every fault (dispatcher throw,
malformed dispatcher result, settlement/recording failure, invoker throw) and rethrows it after pi's loop has drained:
nothing is fabricated, in-flight parallel calls settle, later calls are refused by the gate, and the turn stays
`started` (no response) or `model_responded` (replayable). pi finishing a turn without routing a call through the
engine is an `internal` fault (fail closed).

After a fault the turn does nothing more (as in NativeEngine, which stops at its first fault): `beforeToolCall` settles no
further engine decision and admits nothing, so every remaining call stays pending for the replay.

**Replay.** A `model_responded` turn is replayed through pi: the shim streams the recorded response (no model call),
settled calls are answered from the record, only unsettled calls are dispatched with their recorded invocation ids. The
replay registers exactly the tools the recorded response calls; like NativeEngine's it never consults the host's current
tool definitions (only `dispatch`/`isParallelSafe`).

**Resume.** `resumeChild` validates everything `runTurn` would refuse — the session and the ref must be `pi`, the limits
valid — *before* it reactivates an `interrupted`/`waiting` session: a misrouted or malformed resume never un-interrupts a
session without running a turn.

**Pin.** The adapter relies on pi-agent-core internals of the pinned version (parallel batches prepared completely before
any execution, `finishTurn` ending the loop, the live tool array). `SUPPORTED_PI_AGENT_CORE_VERSION` (`src/version.ts`,
package-private) is `0.87.1`, equal to the exact `package.json` pin (tested); a `PiEngine` refuses to be constructed over
any other installed version (`precondition_failed`), so a drifted install fails closed instead of running unverified.

**Abort / interrupt.** Identical to NativeEngine: a result arriving while aborting is not settled; later calls are not
dispatched (the gate wakes and refuses them); `interrupt()` marks the session `interrupted` and aborts the running turn;
an interrupt landing from another process is preserved by `completeTurn`.

## IR ⇄ pi conversion (`src/convert.ts`, package-private)

Lossless for every IR message: native mapping wherever pi has a slot (system/user, text, thinking ← `reasoning.text`,
tool calls with object arguments, tool results, base64 images); IR facts pi cannot hold ride in a `hypertest` extension
field on the pi object (image `artifactUri`/no inline data, assistant images, opaque reasoning — deliberately not put
into pi's provider-specific `thinkingSignature` —, empty reasoning, explicit empty `toolCalls`, non-object/raw tool
arguments, explicit `isError: false`). Pi-native messages map naturally (tool-declaration-only system messages have no IR
form; tool-result images become `[image <mime>]`). Usage: IR → pi locally, pi → IR via `@hypertest/model`'s `mapPiUsage`.

## Invariants and their tests

| Invariant | Tests |
|---|---|
| AgentEngine contract (persistence, response before tools + crash replay with the same invocation ids, completion, fail, waiting, boundary, nudge, repetition, parallel order, abort/interrupt, outcome recording, malformed args, per-turn cap, child isolation) | `test/pi-engine.test.ts` → `engineContractSuite('pi', …)` (18 tests) |
| After a fault nothing more happens (no further decision settled, nothing dispatched) — row-for-row parity with NativeEngine | "after a fault the turn does nothing more…" |
| Replay depends only on the record + `dispatch` (host tool definitions never consulted; text-only replay) | "a replay depends only on the record and dispatch…", "a text-only turn left model_responded is replayed…" |
| Abort while an exclusive call waits behind in-flight parallel calls: late results untrusted, exclusive call never dispatched, replay in order | "abort while an exclusive call waits…" |
| A misrouted/malformed `resumeChild` never un-interrupts a session | "resumeChild validates before reactivating…" |
| Malformed terminal signal from the dispatcher is a fault (call stays pending, nothing committed) | "a malformed terminal signal from the dispatcher is a fault…" |
| pi never decides tool policy: a length-limited response still reaches the host dispatcher | "a length-limited response never lets pi fail its calls…" |
| Pin: the adapter refuses any pi-agent-core but the exact pinned one | "pin + adapter: the adapter refuses to exist over any pi-agent-core other than the pinned one" |
| One Hypertest turn = one pi turn; exactly one host model call per turn (none on replay); pi drives streaming + tool execution | `pi-engine.test.ts` "one Hypertest turn = one pi turn…", "replay goes through pi…" |
| Response persisted before tools — failure path: recording fails ⇒ nothing dispatched, turn re-run | "response persisted before tools: when recording the response fails…" |
| Faults are never swallowed by pi (dispatch fault, decision settlement fault, malformed dispatcher result, model fault) | "a dispatch fault…", "a failed settlement of an engine decision…", "a dispatcher result without a tool message…", "a model fault propagates…" |
| No fabricated results on abort/interrupt; replay re-dispatches with the same invocation id | "an abort right after the response is recorded…", "interrupt while pi executes a tool…", contract suite |
| Tool policy stays with the host (I1): unknown tools and arguments reach the dispatcher unvalidated/uncoerced by pi | "a tool the context did not declare…", "arguments are dispatched exactly as recorded…" |
| The model sees exactly the host-assembled context/snapshot/responseFormat | "the model sees exactly the host-assembled context…" |
| I10 turn events identical to NativeEngine; failed emit leaves the turn replayable | "turn events carry the same payloads…", "a failed turn_completed emit…" |
| I11 version = pinned pi-agent-core; a run pinned to another version is refused | "identity…", "I11: a run pinned to another pi-agent-core version is refused…" |
| Lossless IR ⇄ pi round-trips (incl. images, reasoning, opaque, malformed calls), pi-native mapping, stream protocol | `test/convert.test.ts` |
| Host parallel-safety order, bound, abort/fault wake-up | `test/gate.test.ts`, contract suite ("parallel-safe calls overlap…"), "parallel-safe calls are bounded to 4…" |
| No pi types in exported signatures | `test/public-api.test.ts` (TypeScript declaration emit of the public surface) |

## Contract changes (additive)

`PiEngineDeps` (= `NativeEngineDeps`). Additional exports: `PiEngine.adapterVersion`, `PI_AGENT_CORE_VERSION`,
`RUNTIME_PI_PACKAGE_VERSION`.

## Testing

```bash
npx tsc -p packages/runtime-pi --noEmit
node scripts/run-tests.mjs --package runtime-pi                            # PGlite
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package runtime-pi # PostgreSQL 16 (HYPERTEST_TEST_PG_URL)
```

All tests are hermetic unit tests (`*.test.ts`): the contract suite and the engine specifics each use one migrated
database; conversion, gate and public-API tests use none (the public-API test runs the TypeScript compiler, ~7 s).
