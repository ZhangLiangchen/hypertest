# @hypertest/durable

**Durable execution** for Hypertest runs. Temporal (or the in-process local runtime) owns *how accepted work
survives failure*; the control plane owns *what should happen next*; SQL owns every domain fact. Nothing in this
package holds business state: a crashed process loses only its loops, and the next process rebuilds them from the
control plane (`recover` ⇒ `tick` ⇒ dispatch). Workflow code is deterministic (no LLM, I/O, `Date.now` or
randomness — only activities, timers and signals).

Depends on `core`, `domain`, `control` (the `ControlPlane` facade: `tick`, `executeTurn`, `observeWaiting`,
`recover`, `cancelRun`) and `@temporalio/*` (confined to this package). The binding ABI is
[`src/contracts.ts`](src/contracts.ts).

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `LocalDurableRuntime(options: LocalDurableOptions)` | In-process `DurableRuntime` (`kind: 'local'`). |
| `TemporalDurableRuntime(options: TemporalDurableOptions)` | `DurableRuntime` on Temporal (`kind: 'temporal'`); embedded worker by default, `workerMode: 'external'` for a separate `hypertest worker`. `start()` (additive) connects eagerly; `taskQueue` getter. |
| `createTemporalWorker(options: TemporalWorkerOptions)` | A standalone Temporal worker (workflows + activities bound to a control plane) → `TemporalWorkerHandle { taskQueue, done, shutdown() }`. Used by the embedded mode and by `hypertest worker`. |
| `bundleTemporalWorkflows({ logger? })` | Bundles `src/temporal/workflows.ts` once (webpack + swc handle the `.ts` file); pass as `workflowBundle` to skip bundling at worker start. |
| `createTemporalActivities(control, { resolveClaim? })` | `{ recover, tick, executeTurn, observeWaiting, cancelRun, resolveClaim, claimAfterResume }`: plain async functions over the facade; faults become `ApplicationFailure`s (`toApplicationFailure`). |
| workflows (`src/temporal/workflows.ts`) | `testRunWorkflow(runId, state?)`, `workItemWorkflow(input)`, signals `wake` / `cancel`; ids `runWorkflowId(runId)` = `run-<runId>`, `workItemWorkflowId(id, token?)` = `wi-<id>-<token>` (`wi-<id>-observe` for an untracked waiting item). |
| `NON_RETRYABLE_ERROR_CODES`, `isRetryableFault` | The shared retry classification (below). |
| `durableMigrations` | `[]` — this package owns no tables (lifecycle truth is `ht_runs` / work items / leases of the control plane, plus the Temporal history). |
| constants | `RESUMABLE_RUN_STATUSES` (created, running, converging, gating), `OBSERVE_BACKOFF_MIN_MS` 250 / `OBSERVE_BACKOFF_MAX_MS` 2000, `DEFAULT_MAX_IDLE_MS` 5000, `DEFAULT_MAX_ATTEMPTS` 5, `DEFAULT_MAX_WORKFLOW_ITERATIONS` 200, `DEFAULT_WORKFLOW_MAX_IDLE_MS` 5000, `DEFAULT_TEMPORAL_NAMESPACE` `default`, `DEFAULT_TEMPORAL_TASK_QUEUE` `hypertest`, `TEMPORAL_WORKFLOWS_PATH`. |

### Contract changes (all additive, backward compatible)

- `DurableHooks` (extended by both option types, every field optional): `getRun(runId)` (point lookup for
  `awaitCompletion`; default `listRuns()` filtered — supply it when `listRuns` returns only non-terminal runs, as the
  app's does, or a finished run reads as `not_found`), `resolveClaim(workItemId)` (the fencing token of the claim THIS
  worker holds — must check the claim owner — see "waiting items" below), `logger` (default `control.deps.logger`).
- `LocalDurableOptions.maxAttempts` (default 5).
- `TemporalDurableOptions.workflowBundle`, `.maxWorkflowIterations` (default 200), `.maxIdleMs` (default 5000: cap of
  the run workflow's idle wait and interval of its recover standby — the idle cap was a fixed 60 s before; the control
  plane never suggests more than 5 s).
- New types `TemporalWorkflowBundle`, `TemporalWorkerOptions`, `TemporalWorkerHandle`; activity
  `claimAfterResume({ workItemId, fencingToken? })` (+ type `ClaimAfterResumeInput`); `TestRunWorkflowState.maxIdleMs`.
  `WorkItemWorkflowInput.mayReresolve` is deprecated and ignored.
- (hardening) `LocalDurableOptions.claimKeepaliveMs` (default 10 s; H6): the local loop ticks with
  `maxDispatch` = its free turn slots and renews (`ControlPlane.renewClaim`) a claim that still waits for a slot.
  `TemporalDurableOptions.turnTimeoutMs` (default 24 h, ≥ 1000; durability-5): the `executeTurn` activity's
  start-to-close timeout (was 2 h 10 min, shorter than a turn may legitimately run), inherited by the item workflows
  (`TestRunWorkflowState.turnTimeoutMs`, `WorkItemWorkflowInput.turnTimeoutMs`); `DEFAULT_TURN_ACTIVITY_TIMEOUT_MS`.
  Both runtimes pass the dispatch's `nextTurn` as the first call's `expectedTurn` (durability-9).

## Semantics

**LocalDurableRuntime** — `startRun(runId)` launches one loop per run (idempotent while it runs):
`recover` once, then `loop { tick; a work loop per dispatched claim; a work loop (observe first) per waiting item
without one; wait for a wake or min(idleMs, maxIdleMs) }` until the tick is final, which resolves `awaitCompletion`
with `{ runId, status, decision }`. A work loop calls `executeTurn(id, token, signal, { expectedTurn })` while it
returns `continue` (turns are bounded by one `Semaphore(maxConcurrentTurns)` for the whole runtime; the permit is held
per call), polls `observeWaiting` with backoff 250 ms → 2 s while `waiting` — and while it answers `lease_lost` (another
worker still holds the waiting item's lease, e.g. right after a takeover: ending there made the run loop restart an
observer at once, a tick + observe hot loop) — and stops on completed/failed/cancelled/paused/lease_lost, waking the run
loop. Once `observeWaiting` resumes the item, the loop continues under the claim THIS worker holds at that moment
(`resolveClaim`, looked up once, right after the resume: `observeWaiting` may have re-taken the claim under a new
token), else under the token it knows. A `lease_lost` turn is final for the loop: a newer token is never adopted (it can
be a claim the scheduler re-dispatched to another work loop — adopting it made two loops drive one claim).
`signal(wake)` ends the idle wait (and the observe backoffs); `signal(cancel)` calls `control.cancelRun` first, then
aborts the run's in-flight turns; the next tick reports the cancelled run as final. `resumeIncomplete()` starts every
run in `RESUMABLE_RUN_STATUSES` (a paused run waits for `resumeRun`). `startRun` on a run whose loop is still stopping
(it failed and waits for an in-flight turn to honour the abort) waits for that loop and then starts a new one (it was a
silent no-op before, leaving the run undriven). `shutdown()` aborts every loop and in-flight turn (the turn replays on
the next attempt) and waits for them; pending `awaitCompletion`s reject `cancelled`; later calls reject
`precondition_failed`.

Faults: a call failing with a retryable fault is retried with backoff (≤ `maxAttempts`, same `expectedTurn`); a
non-retryable fault (or exhausted attempts) stops a work loop (the item keeps its claim until the lease expires, then
the scheduler requeues it — bounded by `maxWorkAttempts`) or fails the run loop (`awaitCompletion` rejects with the
fault; `startRun` may start it again). `recover` and `tick` failing `unavailable` (another live worker owns the run, or
the store is down) are retried without a bound — past `maxAttempts` every `maxIdleMs` (standby): the run loop is the
only thing that re-dispatches the run's work in this process, so a store outage must not end it (it did after ~1.5 s
before; work loops stay bounded, an item cannot livelock the run). A control plane that reports progress forever (`idleMs` 0) cannot spin the loop: after
`ZERO_IDLE_STREAK` (20) such ticks it yields 50 ms. `awaitCompletion` also polls the run status (fallback for runs
without a loop here); `timeoutMs` ⇒ `timeout`; unknown run ⇒ `not_found`.

**Temporal** — `startRun` starts `testRunWorkflow` with workflow id `run-<runId>` and `ALLOW_DUPLICATE_FAILED_ONLY`
(already started / completed ⇒ no-op; a failed execution may be started again). `testRunWorkflow`: `recover` (once,
not repeated by continueAsNew; `unavailable` — the run is owned by another live worker — is a standby, retried every
`maxIdleMs` without bound as in the local runtime, instead of failing the workflow after the policy's five attempts;
a `cancel` signal during the standby calls `cancelRun` at once) → loop { cancel pending ⇒ `cancelRun`; `tick`;
`startChild(workItemWorkflow)` per dispatched claim (`wi-<id>-<token>`), an observer child per untracked waiting item;
`condition(wake, min(idleMs, maxIdleMs))`; a `tick`/`cancelRun` still `unavailable` after the retry policy (a store
outage) makes the workflow stand by (every `maxIdleMs`) instead of failing; after `WORKFLOW_ZERO_IDLE_STREAK` (20) consecutive ticks reporting idle 0 it
yields 50 ms, as the local loop } until final; on the final outcome still-tracked children are asked to cancel — and
also when the run workflow itself fails or is cancelled (below). A child is untracked by its `wake` signal or by its
close event (so a child terminated or cancelled by an operator never leaves its waiting item unobserved forever).
`workItemWorkflow`: `executeTurn({workItemId, fencingToken, expectedTurn})` while `continue` (expectedTurn = previous
turn + 1, so an activity retried after a crash replays a committed turn instead of advancing twice); `waiting` (or an
observation answering `lease_lost`) ⇒ `sleep(backoff 250 ms → 2 s)` + `observeWaiting`; after the resume
`claimAfterResume` names the claim to continue under (the hook's answer, else the known token; none ⇒ `no_claim`); a
`lease_lost` turn ends the child. On its end — also when cancelled — it signals the parent `wake` with
`{ workItemId, workflowId, status }`. Both continue as new after `maxWorkflowIterations` (200), carrying only the
in-flight children / the item's cursor (SQL is truth).
Activities: tick/observe/cancel/resolveClaim/claimAfterResume `startToCloseTimeout` 2 min; turn/recover 10 min with a
60 s heartbeat timeout (the activity heartbeats every 10 s, so a crashed worker's turn is retried after ≤ 60 s instead
of 10 min); retry `{ maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_CODES }` (recover adds
`unavailable`: the workflow's standby handles it). `awaitCompletion` = the workflow
result (following continueAsNew); a failed workflow rejects with the root fault's code (e.g. a non-retryable tick
fault); no workflow ⇒ a terminal run answers from the control plane, otherwise `not_found`. `signal(cancel)` without
a workflow goes straight to `control.cancelRun`. The Temporal Runtime is installed once per process with SDK and core
logs forwarded to the Hypertest `Logger` (warn+) and **no** SIGINT/SIGTERM hijacking.

**Children are ABANDONed on parent close** (the spec suggested TERMINATE): `continueAsNew` closes the parent run, and
with TERMINATE it would kill every in-flight turn every 200 iterations (the items would only come back through lease
expiry, spending `maxWorkAttempts`). With ABANDON the children survive, signal the parent by workflow id (the latest
run), and the parent cancels any child still tracked when the run is final; a child also ends on its own at its next
activity once the control plane reports the item terminal. Because ABANDON also applies when the run workflow *fails*
(a non-retryable tick fault, exhausted retries) or is cancelled, the workflow catches that close and asks its tracked
children to cancel first: otherwise the children of the failed execution kept driving their items untracked while the
restarted execution started observers of its own for the same waiting items (two drivers of one claim). Only an
operator's *terminate* of the run workflow still leaves children running (no workflow code runs then).

**Retry classification** (`NON_RETRYABLE_ERROR_CODES`, shared by the local loop, the activity mapping and the workflow
retry policy — the workflow file keeps a literal copy, asserted equal by a test): `invalid_argument`, `not_found`,
`permission_denied`, `stale_fence`, `schema_violation`, `integrity_violation`, `unsupported`, `budget_exhausted`,
`precondition_failed`, `provider_error`. Everything else (`cancelled` = an aborted turn that replays, `timeout`,
`unavailable`, `rate_limited`, `conflict`, `stale_context`, `internal`) is retried.

**Waiting items after a restart** — `recover` re-takes a waiting item's claim under a new fencing token and
`observeWaiting` may do the same after a lapsed lease, but neither returns the token. With the `resolveClaim` hook the
runtime looks the token up once (after `observeWaiting` resumed the item, or for an item found waiting without a
loop) and continues at once; without it the item resumes through the scheduler (lease expiry ⇒ requeue ⇒ dispatch,
one work attempt).

## Invariants and their tests

| Invariant | Test |
|---|---|
| One loop per run; turns strictly in order; each call names the expected turn | `test/local.test.ts` "recover once, tick, turns while continue…"; `test/temporal.int.test.ts` "a run with two work items…" |
| Bounded concurrency (I12) | `local.test.ts` "turns are bounded by maxConcurrentTurns" |
| Crash safety: a killed process loses nothing; a new runtime over the same DB resumes; no turn runs twice; finished work is never re-invoked | `local.test.ts` "a process killed mid-turn (beforeCommit / afterCommit)…" (PGlite / PostgreSQL); `temporal.int.test.ts` "worker crash mid-turn (beforeCommit / afterCommit)…" |
| A retried call after a committed turn replays (expectedTurn), never advances twice | `local.test.ts` "a retryable fault after a committed turn…"; `temporal.int.test.ts` crash (afterCommit) |
| Waiting items are observed, not re-dispatched, across a crash (with / without resolveClaim) | `local.test.ts` "a crash while an item waits on an operation…" ×2; "observeWaiting re-took the claim…" |
| Fencing: lease_lost stops the loop, the stale token is never reused | `local.test.ts` "lease_lost stops the work loop" |
| One driver per claim: after a resume the claim is resolved at once; a lease_lost turn never adopts a newer (re-dispatched) claim | `local.test.ts` "lease_lost after a resume never adopts a newer claim…", "observeWaiting re-took the claim…"; `temporal.int.test.ts` "observeWaiting re-took the claim under a new token…" |
| A waiting item another worker still leases is polled, not abandoned (no observer restart hot loop) | `local.test.ts` "observeWaiting answering lease_lost…"; `temporal.int.test.ts` "observeWaiting answering lease_lost keeps the child polling…" |
| A failed run workflow cancels its children; the restarted one is the only driver | `temporal.int.test.ts` "a run workflow that fails cancels its in-flight children…" |
| No stale child tracking: a child cancelled / terminated by an operator is untracked and its waiting item observed again | `temporal.int.test.ts` "a child cancelled or terminated by an operator…" |
| Restart of a failed run loop is never lost (startRun waits for the stopping loop) | `local.test.ts` "startRun while the failed loop still stops…" |
| Faults: non-retryable ⇒ no retry; retryable ⇒ ≤ maxAttempts; tick fault fails the run loop / workflow and it can be restarted | `local.test.ts` "a non-retryable fault…", "retryable faults are retried at most maxAttempts…", "recover: unavailable… tick fault…"; `temporal.int.test.ts` "activity faults…" |
| Cancel goes through the control plane first; in-flight work stops | `local.test.ts` "cancel: …"; `temporal.int.test.ts` "cancel signal: …" |
| Wake / idle bounds; no hot spin | `local.test.ts` "signal wake ends an idle wait…", "a control plane reporting progress forever…"; `temporal.int.test.ts` "a control plane reporting progress forever: the run workflow yields…" |
| Recover standby while another live worker owns the run (both runtimes); cancel not delayed by it | `local.test.ts` "recover: unavailable (another live owner) is waited out…"; `temporal.int.test.ts` "recover standby…" |
| A store outage (tick `unavailable`) longer than the retry bound never ends the run loop / fails the run workflow; other faults stay bounded | `local.test.ts` "a store outage (tick unavailable) longer than maxAttempts…"; `temporal.int.test.ts` "a store outage longer than the activity retry policy…" |
| Bounded history: continueAsNew keeps children and expectedTurn; recover not repeated | `temporal.int.test.ts` "continueAsNew bounds both histories…" |
| Determinism of the workflow code | `temporal.int.test.ts` replays the recorded parent and child histories (`Worker.runReplayHistory`) |
| Error mapping and retry policy parity | `test/temporal-activities.test.ts` |
| resumeIncomplete / awaitCompletion / validation / shutdown | `local.test.ts` last suites; `temporal.int.test.ts` "external worker mode…"; `temporal-activities.test.ts` "options are validated…" |

The tests drive a fake control plane (`test/fake-control.ts`) with the facade semantics the runtimes rely on
(fenced, `expectedTurn`-idempotent `executeTurn`; recover requeues claims its process did not issue and re-takes
waiting ones; lease expiry ⇒ requeue) over a world kept in memory or in one row of a real database, so two instances
over the same world are two processes over the same database.

## Known limitations

- **Claims waiting for a turn permit are not kept alive.** The scheduler claims up to `maxAgentConcurrency` items per
  run; the local runtime runs at most `maxConcurrentTurns` turns across all runs, and nothing renews the lease of an
  item queued behind the semaphore (only `executeTurn`/`observeWaiting` do). With several runs, or long turns, a queued
  item's lease can lapse ⇒ requeue ⇒ one work attempt spent. Keep `maxConcurrentTurns` ≥ the concurrent runs ×
  `maxAgentConcurrency` (see openIssues: the control plane has no capacity-aware admission / claim keep-alive).
- **Paused runs** leave their claimed items to lease expiry (control plane behaviour; see openIssues).
- **Embedded worker death** (the SDK's `Worker.run()` rejecting after start) is logged; the runtime does not restart the
  worker — supervise the process (or run `workerMode: 'external'` workers under a supervisor).
- **Workflow code changes are not replay-compatible** with running histories (this revision changed the command
  sequence of both workflows): drain or restart running workflows on upgrade, or use `patched()`.
- An operator's *terminate* of a run workflow, or of a child carried across continueAsNew, is not seen by workflow code:
  a waiting item whose carried child was terminated is re-observed only after the next restart of the run workflow.

## How to run

```bash
npx tsc -p packages/durable --noEmit
node scripts/run-tests.mjs --package durable                           # PGlite; Temporal tests need the dev server
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package durable
npm run infra:up    # PostgreSQL + Temporal dev server (writes .infra/env: HYPERTEST_TEST_TEMPORAL_ADDRESS, …)
```

`test/temporal.int.test.ts` skips with an explicit reason when `HYPERTEST_TEST_TEMPORAL_ADDRESS` is not set; each
test uses its own task queue and run ids; at the end whatever still runs on those task queues is terminated.
