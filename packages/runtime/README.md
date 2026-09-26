# @hypertest/runtime

The Hypertest-owned **Agent Runtime ABI** and its **native engine**. Hypertest (the host) owns routing and
ModelEpochs, context assembly, tool policy/execution, budgets, persistence, agent identity and subagent semantics;
an `AgentEngine` owns only loop mechanics (how a turn turns model output into tool dispatches and when the loop
stops). Engines receive an `EngineHost` and never talk to providers or tools directly, and no engine-specific type
crosses the ABI. The binding ABI is [`src/contracts.ts`](src/contracts.ts).

Depends on `@hypertest/core`, `domain`, `model`, `context` (types), `tools` (types) and `policy` (capability cover
relations and signature verification for I2 in `SubagentRuntime.spawn`; the tests also use its signed capabilities and
the real policy engine).

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `runtimeMigrations` | `runtime/001-sessions` (`ht_sessions`, `ht_transcript`, `ht_turns`, `ht_tool_calls`, `ht_agent_inbox`, `ht_compactions`), `runtime/002-agents` (`ht_agents`), `runtime/003-epochs` (`ht_epochs`, `ht_pending_fallbacks`), `runtime/004-turn-outcome-agent-grant` (`ht_turns.outcome`, `ht_agents.capability`, `ht_agents.max_depth`). PGlite + PostgreSQL 16. |
| `createSessionStore(deps)` | SQL `SessionStore`: portable transcript, turn records, tool-call settlement, native state, compactions, input inbox. |
| `createAgentRepository(deps)` | SQL `AgentRepository` over `ht_agents` (a disposed agent is terminal). |
| `createEpochManager(deps)` | `ModelEpoch`s at safe boundaries (I3), `model.epoch_started`, `providersUsedByRoles`, pending fallbacks. |
| `createModelInvoker(deps)` | Per-agent `ModelInvoker`: routes at boundaries, epochs, budget reserve/settle/release, fallback at the next turn. |
| `NativeEngine` | `kind: 'native'`, `version` = this package's version. The Hypertest agent loop (below). |
| `createSubagentRuntime(deps)` | spawn/resume/message/interrupt/collect/children/dispose/settle/`capabilityOf` with caps, capability binding and non-amplification (I2). `capabilityAmplification(child, parent)` is the check. |
| `createAgentRunner(deps)` | `step()` = one turn (the durable activity unit); `run()` = loop with the work budget; both recover an outcome the engine committed but a crash left unapplied (`recoveredResult`, `recoveredWaiting`). `validateBudget`. |
| `buildRuntimeManifest(input, createdAt)` | Frozen RuntimeManifest, `manifestId = 'rm_' + sha256(canonicalJson(content))` (content excludes `createdAt`; engine/adapter lists sorted). `verifyRuntimeManifest`, `manifestContent`. |
| `EngineRegistry` | `register` (duplicate kind ⇒ `conflict`), `get` (unknown ⇒ `not_found`), `list`, `has`, `manifestEntries()`, `assertPinned(manifest, kind)` (I11: refuses an engine whose version differs from the pinned manifest). |
| `engineContractSuite(name, makeEngine, { openDatabase })` | node:test suite every engine must pass (see below). |
| `FakeModelInvoker`, `FakeDispatcher`, `FakeContextProvider`, `fakeHost`, `fakeSnapshot`, `completeWorkTool`, `failWorkTool` | Deterministic, recording test doubles for engine tests. |
| constants/helpers | `TEXT_ONLY_NUDGE`, `TOO_MANY_TOOL_CALLS`, `MALFORMED_ARGUMENTS`, `REPETITIVE_LOOP`, `PARALLEL_TOOL_CONCURRENCY` (4), `MAX_CONSECUTIVE_RETRY_BOUNDARIES`, `normalizeResponse`, `toolCallSignature`, `turnCompletedEventId`, `validateLimits`, `safeEpochTurn`, `switchReasonFor`, `decisionFromEpoch`. |

## The turn (NativeEngine.runTurn)

Turn = one model response + dispatch of all its tool calls — the only safe model-switch boundary.

1. **Which turn.** Last turn `model_responded` ⇒ **replay** that turn: the model is *not* called; only unsettled
   calls are dispatched, with their recorded invocation ids; `replayed: true`, zero usage. Last turn `started`
   (nothing recorded, e.g. a crash/abort during the model call) ⇒ re-run that turn. Otherwise last completed turn + 1
   (turn 0 is the initial input written by `createSession`).
2. **Inputs.** Queued inputs are drained and `request.input` appended to the transcript at the turn in one
   transaction (`drainInputInto`). A retried attempt never appends the same request input twice (deduped against
   what the turn already recorded). Input handed to a *replay* is queued for the next turn atomically with the
   completion.
3. **Context + model.** `host.context.assemble(...)` fixes the `ContextSnapshot`; `beginTurn(snapshotId)`;
   `host.model.invoke({..., snapshotId})`. `!ok` ⇒ `completeTurn('boundary')`, status `boundary` with the reason — no
   tool executes. Otherwise the (id-normalized: unique, non-empty tool-call ids) response is persisted **with one
   pending `ht_tool_calls` row per call in one transaction** before anything runs; invocation id
   `${sessionId}:${turn}:${toolCall.id}` (passed to the dispatcher as `meta.invocationId`). The turn records the
   snapshot of the attempt that produced the response (a retried `started` turn may have assembled a newer one).
4. **Dispatch.** Engine decisions first, never dispatched: repetition (below), calls beyond
   `limits.maxToolCallsPerTurn` (`too many tool calls in one turn`), malformed arguments (`rawArguments` present).
   Then, in call order, consecutive `isParallelSafe` calls run concurrently (≤ 4), every other call alone. Each
   result is settled immediately (crash ⇒ precise state). A dispatcher fault propagates after in-flight calls
   settle; unknown tools are the dispatcher's decision.
5. **Outcome** (tool-result order = call order). First `complete` ⇒ `completed` (+ `completion`); else a `fail` ⇒
   `failed`; else pending operations ⇒ `waiting` (+ `waitingOn`); else `continue`. A text-only response queues
   `TEXT_ONLY_NUDGE` as the next input (role `user`: Anthropic hoists system messages and a trailing assistant turn
   would become a prefill). **Repetition:** when the last `repetitionThreshold` turns (this one included) issued
   identical tool calls (name + canonical arguments, in order) the calls of this turn are *not executed* and the
   status is `failed` / `repetitive_loop` (`0` disables; `1` is invalid). Turns that ended at a model boundary without
   a response are skipped when counting (no model decision was made there), so a flapping provider cannot hide a loop.
6. **Commit.** `agent.turn_completed` is emitted, then assistant + tool results, queued inputs, the session status and
   the turn **outcome** (`TurnRecord.outcome`: status, completion/failure/waitingOn/boundary) are committed with
   `completeTurn('completed')` in one transaction (a failed emit leaves the turn replayable). The event id is
   deterministic (`turnCompletedEventId`): a replay after a failed commit re-appends the same event, which an
   idempotent L0 store (collab EventStore) keeps once. Boundary turns record their outcome too (their event keeps a
   fresh id: a retried boundary turn calls the model again).
7. **Abort** (request signal or `interrupt()`, including a context provider or invoker that *throws* because the signal
   aborted): status `interrupted`; nothing is fabricated — a result that arrives while aborting is *not* settled, the
   call stays pending and is re-dispatched (same invocation id) on replay. An abort alone keeps the session runnable;
   `interrupt()` marks it `interrupted` (runTurn ⇒ `precondition_failed` until `resumeChild`/`SubagentRuntime.resume`).
   The abort handle is registered *before* the session status is read, so an interrupt racing the start of a turn is
   never missed. An interrupt that lands while a turn runs in another process (which this engine cannot abort) is
   preserved: the turn completion never reactivates an `interrupted` session.

Session status after a turn: `completed`/`failed`/`waiting`, else `active` (an `interrupted` session stays
interrupted unless the turn completed/failed the work). Turns on `completed`, `failed`, `disposed` or `interrupted`
sessions are refused. `createSession` writes the session and its turn-0 input in one transaction. `spawnChild`
creates a session holding only the child's `initialMessages`; `resumeChild` reactivates an interrupted/waiting child
and runs a turn.

## SessionStore semantics

- `create(record, initialTranscript?)`: the session row and its initial transcript in one transaction.
- `beginTurn`: idempotent (returns the existing record unchanged); only the next turn after a settled one may begin.
- `recordModelResponse`: response + pending tool-call rows in one transaction; rows must be exactly the response's
  calls in order; same response ⇒ no-op, different ⇒ `conflict`; a reused invocation id ⇒ `conflict` (rolled back).
- `settleToolCall`: `result` required; same outcome ⇒ no-op, different ⇒ `conflict`; only while `model_responded`.
- `completeTurn`: `completed` requires a response with every call settled (`precondition_failed` listing the pending
  ids); `boundary`/`failed` may leave calls unsettled; same status ⇒ no-op (options not re-applied), another ⇒
  `conflict`. Options (`append`, `enqueue`, `sessionStatus`, `outcome`) are applied in the same transaction.
  `sessionStatus` 'active'/'waiting' never replaces `interrupted` (the interrupt landed while the turn ran); a
  terminal 'completed'/'failed' does; `disposed` is final.
- `drainInput`: one `UPDATE … RETURNING` — each queued message is handed out exactly once, in enqueue order.

## Epochs and the ModelInvoker (I3)

`EpochManager.start` refuses (`precondition_failed`) unless the epoch starts at the **next safe boundary**: every
earlier turn is completed/boundary/failed and the starting turn has no recorded response (it may be `started`:
begun, nothing produced). A `model_responded` turn (response with unsettled calls) always refuses.
`previousEpochId` must be the current epoch (`conflict`), identity must match the session. Emits
`model.epoch_started` in the insert transaction.

`createModelInvoker(deps).invoke()` at every turn boundary:
1. A **pending fallback** (recorded by the previous failed call) starts a new epoch *here* (reason `unavailable` /
   `rate_limit` / `policy`) and is consumed in the same transaction; else the current epoch's stored decision is
   reused; else the router routes (security → capability → …; `no_eligible_route` ⇒ `model_unavailable`, no epoch)
   and the `initial` epoch starts. The RouteRequest: role/taskType/policy/actionRisk/dataClassification from deps
   (`routeRequestExtras()` may only *tighten*: `providersToAvoid`/`excludeRoutes`/capabilities are added,
   `actionRisk`/`dataClassification` take the stricter value; policy/role/identity are never overridden), `requiredCapabilities` = policy ∪ `tool_use`
   (tools present) ∪ `structured_output` (responseFormat) ∪ extras, `contextTokensEstimate = estimateTokens(messages,
   tools)`, `contextSnapshotId` = the turn's snapshot.
2. Budget (`BudgetPort`, optional): reserve `{tokens: estimate + maxOutputTokens, costUsd: router.estimateCostUsd}`
   ⇒ exhausted ⇒ `budget_exhausted` (no call).
3. `router.invoke` with messages projected by `projectForRoute` for the epoch's continuation class and
   `excludeRoutes` = routes that already failed in this epoch sequence. ok ⇒ settle actual tokens/cost. Failure ⇒
   release; caller abort ⇒ `cancelled`; router fallback ⇒ stored for the next boundary ⇒ `retry_next_turn`; none ⇒
   `model_unavailable`. A settle/release failure is logged and the reservation kept (over-counted, never under).

## Subagents and the runner

- `spawn`: depth ≤ `maxDepth` (`permission_denied`) where a child's effective cap is `min(request.maxDepth, the
  parent's recorded cap)` — a descendant can never raise the cap its ancestor was spawned with; child depth = parent
  depth + 1; agents per run < `maxAgentsPerRun` (`budget_exhausted`, serialized per run by an advisory lock); the work
  budget is validated. The agent id is generated first and the capability (object or factory
  `(agentId) => capability`) must name it as subject and be bound to the run/work item; with `capabilitySecret` its
  signature must verify. **I2:** a child capability must name the parent's (`parentCapabilityId`) *and* be covered by
  the parent's **recorded** capability — tools, resource scopes (policy's sound cover relations), effects, credential
  scopes, environment classes (subsets), risk (≤) and expiry (≤); a parent whose capability is not on record (created
  outside `spawn`) cannot have children — all `permission_denied`. The session (child: only its `initialMessages`),
  the `AgentInstance`, the recorded grant (capability + depth cap) and `agent.spawned` (with the budget) are created in
  one transaction.
- `interrupt`/`dispose` cascade to all descendants (children first; settled agents untouched by interrupt); each
  agent's status change and its `agent.interrupted`/`agent.disposed` event commit in one transaction. `resume`
  reactivates interrupted/waiting (completed only when `continuable`) and clears the previous settled result, in one
  transaction (the continuation settles a new result); `message` queues input; `settle` records only
  summary/output/refs/failure (idempotent, different ⇒ `conflict`); `collect` returns only that.
- `AgentRunner.step`: one `runTurn`; syncs the agent status (`waiting`; `completed`/`failed` via `settle`; an abort
  leaves the agent runnable, an explicit interrupt makes it `interrupted`). **Crash recovery** (a retried step after
  the engine committed a turn but before the agent was updated): a terminal session (`completed`/`failed`) whose agent
  was never settled has the recorded outcome settled (`TurnRecord.outcome`, else the turn's terminal signals; a
  completion is never fabricated — `recoveredResult`); a `waiting` session whose agent is still `active` puts the agent
  in `waiting` and returns the recorded `waitingOn` (`recoveredWaiting`) — in both cases no turn runs, and `run`
  recovers before any budget check. An engine result `completed` without a completion is a fault. `run`: loops while `continue` (and up to
  4 consecutive `retry_next_turn` boundaries); turns budget from the persisted turn count, tokens/cost/tool calls/
  wall clock per `run()` call (the per-turn tool-call limit is clamped to the remaining budget); exhaustion ends the
  agent `failed` / `budget_exhausted` (a turn whose response is recorded is finished first).

## Engine contract suite

```ts
import { createTestDatabase } from '@hypertest/store';
import { engineContractSuite } from '@hypertest/runtime';
engineContractSuite('pi', (deps) => new PiEngine(deps), { openDatabase: (migrations) => createTestDatabase({ migrations }) });
```

`deps` = `{ db, sessions, ids, clock, logger, events }` (one database per suite; `makeEngine` is called again to
simulate a restart). Covered: identity; session persistence across restarts; response persisted before tools +
crash replay without the model re-dispatching only the unsettled call with the same invocation id; completion;
fail; waiting on pending operations; boundary on model failure (no dispatch); text-only nudge; repetition stop;
parallel-safe concurrency vs ordered exclusive calls; abort mid-dispatch (no fabricated results) + replay;
interrupt (aborts the running turn, refuses turns until resumed); an interrupt landing mid-turn from another process
is not undone by the completion; an abort during context assembly is an interruption; terminal turns record their
outcome; malformed arguments; per-turn call limit; child sessions get only their task context. (`openDatabase` is
additive: `src` may not depend on `@hypertest/store`.)

## Invariants and their tests

| Invariant | Tests |
|---|---|
| Response persisted before tools; atomic response + pending rows; replay without the model; same invocation ids | `test/native-engine.test.ts` (contract suite), `test/sessions.test.ts` (fault-injected atomicity) |
| Settlement idempotency, completion preconditions, atomic completion side effects (incl. outcome), exactly-once inbox; atomic session creation | `test/sessions.test.ts`, `test/native-engine.test.ts` ("createSession writes … atomically") |
| Exactly-once request input across retries; failed audit emit leaves the turn replayable; replay re-emits the same turn event id; the turn names the snapshot the model saw | `test/native-engine.test.ts` |
| Abort ⇒ `interrupted` (dispatch, context assembly, throwing invoker); interrupt racing the turn start; mid-turn interrupt from another process preserved | contract suite + `test/native-engine.test.ts`, `test/sessions.test.ts` ("never reactivates …") |
| Durable step: an unsettled terminal agent is recovered from the recorded outcome, a committed wait is honoured (no turn re-run, budgets never override it) | `test/runner.test.ts` ("crash between the terminal turn and the settle", "run() settles the recorded failure", "crash after a committed waiting turn") |
| Repetition not hidden by model-boundary turns | `test/native-engine.test.ts` |
| I3 safe boundary refusal; fallback only at the next turn in a new epoch; fail-closed; exclusions across the epoch sequence; opaque reasoning projection; budget boundary; route extras can only tighten security | `test/epochs-invoker.test.ts` |
| I1 (integration) out-of-capability call denied by the real ToolRuntime, never executed; permit logged | `test/runner.test.ts` (full stack) |
| I2 capability bound to the new agent, derived from **and covered by** the parent's recorded capability (8 amplification variants); unrecorded parent refused; signatures verified with `capabilitySecret` | `test/subagents.test.ts` |
| I10 correlated route/epoch/turn/tool events; interrupt status + event atomic | `test/runner.test.ts`, `test/native-engine.test.ts`, `test/subagents.test.ts` |
| I11 content-hashed manifest, no engine hot swap, unversioned pins fail closed | `test/manifest.test.ts` |
| I12 depth/agent-count caps (incl. concurrent spawns, inherited depth cap), work budgets | `test/subagents.test.ts`, `test/runner.test.ts` |

## Contract changes (additive, 0.3)

`ModelInvoker.invoke` request `snapshotId?`; `ToolDispatcher.dispatch` meta `invocationId?`;
`SessionStore.recordModelResponse(..., meta?)`, `completeTurn(..., options?: CompleteTurnOptions)`, optional
`drainInputInto?`; `EpochManager.start(..., options?: StartEpochOptions)` and optional `routing?`,
`setPendingFallback?`, `pendingFallback?` (+ `OkRouteDecision`, `EpochRouting`, `PendingFallback`);
`SpawnRequest.capability` may be a factory `(agentId) => ActionCapability`; `NativeEngineDeps`,
`EngineContractDeps`, `EngineContractSuiteOptions`; `engineContractSuite` takes `options.openDatabase`.
Review fixes (additive): `SessionStore.create(record, initialTranscript?)`; `recordModelResponse` meta `snapshotId?`;
`TurnOutcome`, `TurnRecord.outcome?`, `CompleteTurnOptions.outcome?`; `SubagentDeps.capabilitySecret?`;
`SubagentRuntime.capabilityOf?`; documented: completeTurn keeps `interrupted`, a child's `maxDepth` is capped by its
parent's, a child capability must be covered by the parent's, `routeRequestExtras` can only tighten.

## Testing

```bash
npx tsc -p packages/runtime --noEmit
node scripts/run-tests.mjs --package runtime                            # PGlite
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package runtime # PostgreSQL 16 (HYPERTEST_TEST_PG_URL)
```

All tests are hermetic unit tests (`*.test.ts`) on one migrated database per file; the full-stack test uses the real
`ModelRouter` + `ScriptedProvider`, `ToolRuntime` + `BuiltinPolicyEngine` + a signed capability, and the context
package's snapshot store, working view and prompt assembler (artifact/evidence stores are stubs that fail if touched).
