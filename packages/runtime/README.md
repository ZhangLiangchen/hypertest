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
| `runtimeMigrations` | `runtime/001-sessions` (`ht_sessions`, `ht_transcript`, `ht_turns`, `ht_tool_calls`, `ht_agent_inbox`, `ht_compactions`), `runtime/002-agents` (`ht_agents`), `runtime/003-epochs` (`ht_epochs`, `ht_pending_fallbacks`), `runtime/004-turn-outcome-agent-grant` (`ht_turns.outcome`, `ht_agents.capability`, `ht_agents.max_depth`), `runtime/005-releases` (the runtime release registry: `ht_runtime_releases`, `ht_runtime_release_pointer`, `ht_runtime_release_lock`, append-only `ht_runtime_suite_results`, `ht_runtime_release_transitions`, `ht_runtime_epochs`). PGlite + PostgreSQL 16. |
| `createSessionStore(deps)` | SQL `SessionStore`: portable transcript, turn records, tool-call settlement, native state, compactions, input inbox. |
| `createAgentRepository(deps)` | SQL `AgentRepository` over `ht_agents` (a disposed agent is terminal). |
| `createEpochManager(deps)` | `ModelEpoch`s at safe boundaries (I3), `model.epoch_started`, `providersUsedByRoles`, pending fallbacks. |
| `createModelInvoker(deps)` | Per-agent `ModelInvoker`: routes at boundaries (manual / fallback / policy / quality / cost switches re-checked before the epoch), PAUSE or fail closed, calibrated budget reserve/settle/release, fallback at the next turn. |
| `createTokenCalibration()` | Per-route calibration of the token estimator against provider-reported input tokens (shared per worker). |
| `createPluginKernel(configs, opts)` | Kernel plugins (below). |
| `inspectAgents`, `childModes`, `capabilityModes` | Engine inspection and EngineCapabilities decisions (below). |
| `NativeEngine` | `kind: 'native'`, `version` = this package's version. The Hypertest agent loop (below). |
| `createSubagentRuntime(deps)` | spawn/resume/message/interrupt/collect/children/dispose/settle/`capabilityOf` with caps, capability binding and non-amplification (I2). `capabilityAmplification(child, parent)` is the check. |
| `createAgentRunner(deps)` | `step()` = one turn (the durable activity unit); `run()` = loop with the work budget; both recover an outcome the engine committed but a crash left unapplied (`recoveredResult`, `recoveredWaiting`). `validateBudget`. |
| `buildRuntimeManifest(input, createdAt)` | Frozen RuntimeManifest, `manifestId = 'rm_' + sha256(canonicalJson(content))` (content excludes `createdAt`; engine/adapter lists sorted). `verifyRuntimeManifest`, `manifestContent` (validates the runtime-BOM fields when present: `hypertest.gitSha` non-empty (the app pins a full commit id), `hypertest.imageDigest` `sha256:<64 hex>`, `agentEngines[].adapter {package, version}`, `defaultEngine` one of the pinned engines, `roleCatalogRevision`). |
| `toolCatalogRevision(tools, adapters?)` | `tc_<sha256>` over every tool's schemas, effect/risk (`dynamic` when computed), `timeoutMs`, `maxInlineBytes`, side-effect binding (adapter, operation type, lease TTL) and the side-effect adapters' capabilities: a changed timeout, binding or adapter is another runtime (I11). Duplicates and non-positive timeouts are refused. |
| `createRuntimeReleaseRegistry({ db, ids, clock, logger })` | The runtime release registry (below): `register`, `get`, `list`, `activePointer`, `recordSuiteResult`, `suiteResults`, `promotionReadiness`, `promote`, `rollback`, `retire`, `admit`, `history`, `recordEpoch`, `epochs`, `lock(tx)`. Pure helpers `runtimeCompatibility(source, target, { usedEngines })`, `canarySelects`, `canaryBucket`, `canarySelectionProblems`, `describeSelection`; constants `RELEASE_STATES`, `PROMOTION_PATH`, `SUITE_KINDS`, `MANIFEST_SCHEMA_KEYS`, `RELEASE_MIGRATION`. |
| `EngineRegistry` | `register` (duplicate kind ⇒ `conflict`), `get` (unknown ⇒ `not_found`), `list`, `has`, `manifestEntries()`, `assertPinned(manifest, kind)` (I11: refuses an engine whose version differs from the pinned manifest). |
| `engineContractSuite(name, makeEngine, { openDatabase })` | node:test suite every engine must pass (see below). |
| `FakeModelInvoker`, `FakeDispatcher`, `FakeContextProvider`, `fakeHost`, `fakeSnapshot`, `completeWorkTool`, `failWorkTool` | Deterministic, recording test doubles for engine tests. |
| constants/helpers | `TEXT_ONLY_NUDGE`, `TOO_MANY_TOOL_CALLS`, `MALFORMED_ARGUMENTS`, `REPETITIVE_LOOP`, `PARALLEL_TOOL_CONCURRENCY` (4), `MAX_CONSECUTIVE_RETRY_BOUNDARIES`, `normalizeResponse`, `toolCallSignature`, `turnCompletedEventId`, `validateLimits`, `safeEpochTurn`, `switchReasonFor`, `decisionFromEpoch`. |

## Runtime release registry (`src/releases.ts`)

Architecture-improvements §Runtime Manifest 与版本钉死 / §回滚与恢复. Every runtime manifest a deployment may run is a
**release**: `candidate → shadow → canary → active → retiring → retired`, one audited step per `promote` (no skipping,
no promotion out of `active`/`retiring`/`retired`). Every promotion requires the **latest** recorded result of BOTH
compatibility suites of that manifest to be a pass: `engine_contract` (the AgentEngine ABI golden suite) and `replay`
(a replay / golden eval suite id with its pass/fail record); a later failing result blocks the next step. A suite
result claiming a pass over failed cases, or over zero cases (NOT RUN), is refused.

- **Active pointer** (`ht_runtime_release_pointer`, revisioned): names the release new TestRuns are created under and
  remembers the previous one. Promotion to active moves the previous active release to `retiring` (its runs continue on
  it, I11); `retire` finishes it once no live run is pinned to it (the caller checks). At most one active and one canary
  release (partial unique indexes); every mutation is serialized by a lock row.
- **Canary** selection (entering canary requires one): a deterministic percentage bucket of the run id
  (`canaryBucket` = sha256(runId) mod 100) and/or labels (every label must match; own properties only).
- **Admission** (`admit({ manifestId, runId, labels, requireActive })`): no active release ⇒ unmanaged (any runtime
  except a retired/rolled-back one; `requireActive` refuses); else only the active release, or the canary when its
  selection picks the run. Refusals carry the reason, the release state and the active manifest.
- **Rollback** (`rollback({ by, reason, manifestId? })`): the given release, else the canary, else the active one (to
  the previous active one, which must not itself be rolled back). The rolled-back release is `retired` with
  `rolledBack: true` for good (a trigger keeps the flag; never promoted again); the pointer moves back only for an
  active release. The caller quarantines the release's live runs in the same transaction (`tx`).
- **Epochs** (`recordEpoch`, `epochs`): the RuntimeEpoch chain of an explicitly migrated run (seq, previous epoch; a new
  epoch must continue from the last target; every compatibility check must be ok).
- `runtimeCompatibility(source, target, { usedEngines })`: target active or canary and not rolled back; target manifest
  verifies; each pinned schema equal or covered by an **explicit** allowed migration of the target release
  (`allowedMigrations`, recorded at registration, immutable); every engine the run's agents used is pinned with a
  version; same governing protocol id; the target differs from the source. Every check is reported.
- Append-only: suite results, transitions and epochs reject UPDATE/DELETE/TRUNCATE; a registered manifest (and its
  allowed migrations) is immutable and a release is never deleted (database triggers).

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

`createModelInvoker(deps).invoke()` at every turn boundary (I3: the permission/profile re-check happens BEFORE a new
epoch; a refused switch records no epoch):
1. **Switch triggers**, in order — **manual** (an operator's `ModelSwitchRequest` for this agent or its role,
   `EpochManager.pendingSwitch`; applied or refused once per agent, `recordSwitchOutcome`), a **pending fallback**
   (recorded by the previous failed call: reason `unavailable` / `rate_limit` / `policy`), the **current epoch re-checked**
   (`router.validate`: a route that no longer holds switches HERE — reason `quality` when only its scores changed in a
   new catalog revision, `policy` otherwise, `unavailable` for an availability stop), **cost pressure** (`costPressure()`:
   remaining USD below `costPressureRatio` × limit, or the next call costing more than remains ⇒ a strictly cheaper
   eligible route, reason `cost`; "cheaper" is priced on the router's basis for every route — the request's input
   estimate + the route's own maxOutputTokens — so a dearer per-token route with a smaller output cap never passes as
   cheaper), else the **initial** route. The RouteRequest: role/taskType/policy/actionRisk/
   dataClassification from deps (`routeRequestExtras()` may only *tighten*), `requiredCapabilities` = policy ∪ `tool_use`
   (tools) ∪ `structured_output` (responseFormat) ∪ extras, `contextTokensEstimate = estimateTokens(messages, tools)`,
   `costBudgeted` (A[2]: cost-unknown routes refused).
2. **Re-check before the epoch**: the candidate is validated against the current request (and, for an engine without
   `providerSwitch`, must stay on the session's provider — A[4] emulation); refused ⇒ `model.switch_refused`, NO epoch:
   a refused manual/cost switch keeps the current epoch, a refused fallback re-routes without the refused route.
   Accepted ⇒ `EpochManager.start` records the epoch (with the route's profile) in one transaction.
3. **PAUSE vs fail closed** (A[0]): no route for now (`ModelUnavailability.transient`: open circuits, rate limits /
   timeouts after retries, a single-route or `fail_closed` role whose route is unavailable) ⇒ a durable `ModelPause`
   (`ht_model_pauses`: resumeAt = Retry-After / the earliest half-open time, else backoff 5 s doubling to 5 min) and the
   boundary `model_unavailable` with `pause`; no configured route may EVER serve (security, capability, a missing
   credential) ⇒ `model_unavailable` with the exact reason, no pause. A successful call clears the pause.
4. **Budget** (`BudgetPort`, optional): the reservation is the CALIBRATED input estimate (`TokenCalibration`: the
   measured ratio of provider-reported input tokens to `estimateTokens` per route, smoothed, clamped [0.5, 3]; fed by
   every successful call) + the output reserve. When `BudgetPort.remaining` shows the full `maxOutputTokens` reserve
   does not fit, the call's `maxOutputTokens` shrinks to what remains (never below `minOutputTokens`, default
   min(maxOutputTokens, 1024)). A refusal ⇒ `budget_exhausted` with the ledger's typed refusal (`budget`: scope,
   dimension, limit, used, reserved, requested, route, needed tokens/USD) and an exact message (`model budget exhausted
   at run:… on costUsd: $0.999 used + $0 reserved by calls in flight + $0.0123 for this call > limit $1; …`).
5. `router.invoke` with messages projected by `projectForRoute` for the epoch's continuation class and `excludeRoutes`
   = routes that already failed in this epoch sequence. ok ⇒ settle the actual tokens/cost. Failure ⇒ release; caller
   abort ⇒ `cancelled`; router fallback ⇒ stored for the next boundary ⇒ `retry_next_turn`; none ⇒ PAUSE / fail closed
   (3). A settle/release failure is logged and the reservation kept (over-counted, never under). A response the router
   returns `auditPending` is kept and its usage SETTLED — never released: the call is paid (durability-10).

`EpochManager` (additive, `runtime/006-model-pauses-switches`): `modelPause` / `setModelPause` / `clearModelPause` /
`listModelPauses` / `releaseModelPauses(runId, at)` (an operator resume makes paused agents retry now),
`requestSwitch` (`model.switch_requested`; a newer request for the same target supersedes older ones) / `pendingSwitch`
/ `recordSwitchOutcome` / `listSwitches`, `clearPendingFallback`; epochs record the route profile (`route_profile`).

## Engine capabilities, inspection and kernel plugins

- **EngineCapabilities are consulted** (A[4], `src/capabilities.ts`): `childModes(engine, { continuable, background })`
  decides per child whether the engine provides a mode natively or the host emulates it, and refuses what cannot be
  emulated (`continuable` needs `peerMessaging`); the modes are recorded in `agent.spawned`. A continuable child is
  resumed through **`engine.resumeChild`** when the engine has `continuableChild` (the runner calls it at the child's
  next step: `ht_agents.resume_pending`), else the host reactivates the session (`agent.resumed` payload `via`:
  `engine.resumeChild` | `host_emulated`). The resume records the session's last SETTLED turn
  (`ht_agents.resume_after_turn`, migration `runtime/007-resume-after-turn`; an interrupted turn left mid-dispatch is not
  settled — the resume replays it): when the session is `active` again or a turn after it has settled, resumeChild ran
  before a crash left the flag set, so the runner consumes the resume and recovers that turn (settle / replay /
  continue) instead of running another. `providerSwitch: false` keeps model switches on the session's provider.
- `inspectAgents({ agents, engines, epochs? }, runId)` (`src/inspect.ts`) returns each agent with `engine.inspect` state
  (or the error), its capability modes, current epoch and model pause — used by `hypertest status` and
  `GET /runs/:id/agents`.
- **Kernel plugins** (A[6], `src/plugins.ts`): `PluginManifest { id, version, kind: tool | engine | provider |
  context-hook, entry, capabilities: string[], digest: sha256:<hex> }`; `createPluginKernel(configs, { logger, clock })`
  verifies the entry's digest BEFORE importing it (mismatch ⇒ `precondition_failed`, nothing of it loaded) and again
  after, then runs `init` (in order) → contributions checked against the declared capabilities (`tool:<id>`,
  `engine:<kind>`, `provider:<id>`, `context-hook:<name>`, `service:<name>`) → `start` → `health` (unhealthy ⇒ refused);
  any failure stops the started plugins in reverse order. The **Service Registry** (`ctx.services.provide/get`, shared
  by the plugins) and the **Capability Registry** (`kernel.capabilities`: which plugin owns each declared contribution;
  a contribution two plugins declare is a conflict); `tools()`, `providers()`, `engines(deps)`, `contextHooks()`,
  `health()`, `manifestEntries()` (for `RuntimeManifest.plugins`), `stop()` (reverse, idempotent). Plugin tools are
  ordinary `ToolSpec`s: the ToolRuntime applies the capability check, policy permit, freshness, operation ledger and
  evidence to them like to any built-in tool; the composition registers them after the built-in and domain tools, so a
  plugin tool reusing a governed tool id (e.g. `complete_work`, `fs.read`) is refused (`conflict`), never a replacement.
  Limits: the digest pins the ENTRY file only — modules it imports are not pinned, so ship a plugin as one bundled file;
  plugins run inside the Hypertest process (no isolation beyond the digest pin).

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
  transaction with its `agent.resumed` event (the continuation settles a new result); `message` queues input (also for
  a completed continuable agent: the control plane's follow-up to a continuable child); `settle` records only
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
| I12/I10 a paid call whose `model.invoked` append fails keeps its response and settles its usage (never released, never re-called) | `test/epochs-invoker.test.ts` › durability-10 |
| I1 (integration) out-of-capability call denied by the real ToolRuntime, never executed; permit logged | `test/runner.test.ts` (full stack) |
| I2 capability bound to the new agent, derived from **and covered by** the parent's recorded capability (8 amplification variants); unrecorded parent refused; signatures verified with `capabilitySecret` | `test/subagents.test.ts` |
| I10 correlated route/epoch/turn/tool events; interrupt status + event atomic; resume of a background continuable child + `agent.resumed` atomic | `test/runner.test.ts`, `test/native-engine.test.ts`, `test/subagents.test.ts` |
| I11 content-hashed manifest, no engine hot swap, unversioned pins fail closed; the runtime-BOM fields change the id and are validated; tool catalog revision pins timeouts, bindings and adapter capabilities | `test/manifest.test.ts` |
| I11 runtime releases: promotion only one step at a time and only over the latest passing engine-contract AND replay results; one active / one canary; admission (unmanaged, active, selected canary, refused); rollback moves the pointer back and retires for good; append-only history and immutable manifests (triggers); epoch chain; compatibility verdict; `lock(tx)` holds off a rollback until the holder's transaction ends | `test/releases.test.ts` (PGlite + PostgreSQL) |
| I12 depth/agent-count caps (incl. concurrent spawns, inherited depth cap), work budgets | `test/subagents.test.ts`, `test/runner.test.ts` |
| I3 switch triggers (manual, policy, quality, cost, fallback) re-checked BEFORE the epoch; refused switches record no epoch; PAUSE vs fail closed | `test/model-switch.test.ts` |
| A[4] EngineCapabilities: emulate or refuse; resumeChild through the engine (native, pi, DSH); inspect | `test/engine-abi.test.ts`, contract suite ("resumeChild (A[4])") |
| A[6] plugin lifecycle order, health failure, digest mismatch (nothing loaded), undeclared contributions refused | `test/plugins.test.ts` |

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
- (B1 governance completion, behaviour) `SubagentRuntime.resume` emits `agent.resumed` (`{ agentId, from, continuable,
  background, sessionId }`, correlated by the agent's work item) in the transaction of the reactivation: a resume whose
  event cannot be written changes nothing (I10). Used by the control plane to resume a continuable child for its
  parent's follow-up message.

- (runtime release management, additive) `manifestContent` validates the new optional BOM fields of the domain
  `RuntimeManifest` (`hypertest.imageDigest`, `agentEngines[].adapter`, `defaultEngine`, `roleCatalogRevision`);
  manifests without them keep their ids and still verify. New exports
  `toolCatalogRevision`, `GIT_SHA_RE`, `IMAGE_DIGEST_RE`, `TOOL_CATALOG_REVISION_FORMAT`, `ManifestSideEffectAdapter`, the
  release registry (`createRuntimeReleaseRegistry` and its types/helpers, see above) and migration
  `runtime/005-releases` appended to `runtimeMigrations`. Domain (additive): `RuntimeEpoch`, `RuntimeCompatibilityCheck`,
  `PauseReason` `quarantined` | `migrating`, `EVENT_TYPES.runMigrated` (`run.migrated`) / `runQuarantined`
  (`run.quarantined`), `BuiltinRole` `vision_gui` | `local_private`.
- (unit model-runtime, wave 1; additive) `ModelInvocation` failure `unavailable?`, `pause?`, `budget?`
  (`ModelBudgetRefusal`); `ModelPause`, `ModelSwitchRequest`, `ModelSwitchOutcome`, `TokenCalibration`;
  `BudgetPort.remaining?`; `InvokerDeps` `events?`, `catalog?`, `costBudgeted?`, `costPressure?`, `costPressureRatio?`,
  `providerSwitch?`, `pauseBackoff?`, `calibration?`, `minOutputTokens?`; `EpochManager` optional pause / switch methods
  (above), `StartEpochOptions.profile?`, `EpochRouting.profile?`; migration `runtime/006-model-pauses-switches`
  (`ht_epochs.route_profile`, `ht_agents.resume_pending`, `ht_model_pauses`, `ht_model_switches`,
  `ht_model_switch_outcomes`); exports `createTokenCalibration`, `CALIBRATION_BOUNDS`, `DEFAULT_PAUSE_BACKOFF`,
  `DEFAULT_COST_PRESSURE_RATIO`, `qualityOnlyChange`, `childModes`, `capabilityModes`, `inspectAgents`, the plugin kernel
  (`createPluginKernel`, `pluginDigest`, `validatePluginManifest`, `PLUGIN_KINDS` and types). Behaviour: the switch
  re-check precedes the epoch; continuable children resume through `engine.resumeChild` when the engine supports it
  (`SubagentRuntime.resume` then only marks the agent; the runner resumes it at its next step); the engines'
  `resumeChild` refuses failed/disposed sessions (`precondition_failed`).
- (review fix, additive) `RuntimeReleaseRegistry.lock(tx)`: takes the registry's mutation lock inside the caller's
  transaction (held until it ends; `invalid_argument` without one), so a caller that acts on a release's state (the
  app's run migration) re-reads it after every register/promotion/rollback/retirement that could change it. Lock order:
  the registry lock before any run lock. Domain (additive): `EVENT_TYPES.runMigrationReleased`
  (`run.migration_released`).

## Testing

```bash
npx tsc -p packages/runtime --noEmit
node scripts/run-tests.mjs --package runtime                            # PGlite
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package runtime # PostgreSQL 16 (HYPERTEST_TEST_PG_URL)
```

All tests are hermetic unit tests (`*.test.ts`) on one migrated database per file; the full-stack test uses the real
`ModelRouter` + `ScriptedProvider`, `ToolRuntime` + `BuiltinPolicyEngine` + a signed capability, and the context
package's snapshot store, working view and prompt assembler (artifact/evidence stores are stubs that fail if touched).
