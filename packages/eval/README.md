# @hypertest/eval

The long-lived **Eval Platform** of Hypertest (BLUEPRINT §5 eval, §6 PoCs; design: "Agent 评测基准与对比实验设计" in
`docs/design/architecture-improvements.zh-CN.md`). It runs versioned `EvalTask`s under experiment `EvalArm`s in a
**fresh environment per trial**, grades the **outcome** (environment state first, then deterministic records and
evidence consistency — never the agent's narrative), keeps trajectory metrics as explanation only, and compares arms
with **paired** statistics (exact McNemar, seeded paired bootstrap, pass@k / pass^k).

Part 1 is the platform (harness, graders, statistics, child-process trials). Part 2 — [the PoC suites](#part-2--the-poc-suites-executable-acceptance)
— is the executable acceptance of BLUEPRINT §6: the three PoC suites plus oracle-robustness and recovery-chaos, run with
deterministic scripted brains on the real stack, graded against the acceptance tables of the design documents.

Depends on core, domain, store, model, evidence, collab, operation, policy, control, app, agents, tools, runtime (see
`scripts/check-boundaries.mjs`) and `yaml` (unused so far). The binding ABI is [`src/contracts.ts`](src/contracts.ts).

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `runTrial(task, arm, options)` | One trial (below) → `EvalTrial`. Never throws for trial problems: they are results. |
| `runSuite(suite, options)` | Every task × trial × arm, sequentially, with **paired seeds** (`trialSeed(suite, taskId, n)`, identical for every arm) and the arms of each pair in a **seeded random order**; `onTrial` progress callback → `SuiteResult`. |
| `summarizeSuite(suite, armIds, trials)` | Per-arm aggregates + paired comparisons (used by runSuite; exported for re-analysis). |
| `renderSuiteReport(result)` | Deterministic markdown: arms, paired comparisons, trials, explanatory trajectory table. |
| stats | `mcnemarExact(b, c)`, `pairedBootstrapCI(diffs, { iterations = 2000, alpha = 0.05, seed = 1 })`, `passAtK(results, k)`, `passHatK(results, k)`, `mulberry32(seed)`, `seedFrom(number \| string)`, `seededShuffle(items, seed)`. |
| graders | `verdictGrader`, `defectDetectedGrader`, `noDuplicateSideEffectsGrader`, `evidenceCompletenessGrader`, `evidenceIntegrityGrader`, `policyViolationGrader`, `auditReconstructionGrader`, `planDynamicsGrader` (+ `createPlanDynamicsGrader(options)`), registry `GRADERS`, `resolveGrader(spec, extra?)`. |
| metrics | `outcomeMetrics(task, data)`, `trajectoryMetrics(data)` and the shared analyses (`analyzeVerdict`, `analyzeDefects`, `analyzeSideEffects`, `analyzePolicy`, `analyzeCompleteness`, `maxParallelWork`, `routesByRole`, `distinctRoleRoutes`, `acceptedPlans`, `timeToFirstEvidenceMs`, `matchesHints`). |
| collection | `runProbes(fixture, timeoutMs)`, `collectTrialData(ht, input)`, `emptyTrialData`, `sessionTurns`. |
| child processes | `TRIAL_CHILD_ENTRY` (`src/trial-child.ts`), `spawnTrialChild(job, options)`, `runChildTrial(job, options)` (kill/restart helper), `TRIAL_EXIT_CODES`, `exitCodeForVerdict`, `verdictForExitCode`, `parseProgress`, `readProgress`, `dispatchCount`. |
| brains | `roleRouter(brains, calls?)`, `viewOf(request)`, `toolCall(name, args)`, `evidenceIdsIn`, `recordIdsIn`, `operationIdsIn`, `withModelTimeoutInjection(brains, onCall, counter?, onInject?)`. |
| harness helpers | `trialBaseConfig(dataDir, base?)`, `trialDataDir(ctx)` (`<workDir>/hypertest`), `isolationProblems(config, workDir)`, `TRIAL_DATA_DIR`, `DEFAULT_TRIAL_TIMEOUT_MS` (600 000). |
| result rules | `decideTrialResult({ graders, timedOut, unexercised, error? })`, `unexercisedChaos(chaos, facts)`, `chaosProblems(chaos)`, `childExitProblem(exit, storedVerdict, reported?)`, `hintProblems(fault)`, `RELEASE_VERDICTS`. |
| PoC suites (Part 2) | `pocAWhiteboxSuite()`, `pocBEventDrivenSuite()`, `pocCDurableLoadSuite()`, `oracleRobustnessSuite()`, `recoveryChaosSuite()`, `pocAllSuite()`; tasks `pocATask`, `pocBTask`, `pocCTask`, `pocCInsufficientTask`, `oracleRobustnessTask`, `recoveryChaosTask` (each takes overrides), oracles `LEDGER_ORACLE`, `BANK_ORACLE`, `KV_ORACLE`, `establishOracles`, `EVAL_ORACLE_AUTHORITY`. |
| PoC arms and brains | `scriptedMultiLlmArm`, `scriptedSingleArm`, `liveArm(env?)`, `liveArmAvailable(env?)`, `POC_ARMS`, `builtinArms(env?)`, `MULTI_ROUTES`, `SINGLE_ROUTES`, `pocBrains(args)`, `pocChildBrains(ctx)`, `providerBrain`, `armBrains`. |
| PoC fixtures and graders | `createLedgerRepo`, `startBankApi`, `startKvService` (supervisor in its own process), `loadJobs`, `killLoadWorkers` (only pids that are still their job's worker: `isLoadWorker`), `readObservations`; `POC_GRADERS` (`pocAWorkflowGrader`, …), `runningIntervals`, `maxConcurrent`, kill points `killPointProblems`, `killPointCount`, `KILL_POINT_STATES`. |

### A trial (`runTrial`)

1. **Fail fast** (no environment yet): options (incl. `probeTimeoutMs`), grader specs (`resolveGrader`), the chaos plan
   (`chaosProblems`: positive integers, a boolean), `arm.child` for child-process mode.
2. Fresh directory `<options.workDir>/<task>-<arm>-t<n>-XXXXXX` → `TrialContext { workDir, seed, trial }` →
   `task.setup(ctx)` → `TrialFixture` (target, environments, probes, cleanup).
3. Configuration = `arm.config(trialBaseConfig(<workDir>/hypertest, options.baseConfig), ctx)`: embedded PGlite and
   filesystem artifacts inside the trial directory (a base's own paths are never reused). An arm that points the store,
   artifacts or data dir outside the trial directory is refused (`infra_error`). A PostgreSQL store gets a **fresh
   schema per trial** (`<store.schema ?? 'ht_eval'>_<8 hex>`), dropped at the end.
4. Run `task.goal` against `fixture.target` (`runId` fixed by the harness, labels `eval_*`, `task.budget`) with the
   arm's scripted brains, under `options.timeoutMs` (default 10 min):
   - **in-process**: `createHypertest(config, { scriptedBrains, environments })` → `start` → `awaitCompletion`.
     Chaos: `injectModelTimeoutOnCall` (the N-th model call of the trial fails with a provider `timeout`),
     `duplicateEventDelivery` (an `InProcessEventBus` delivering every message twice), `killAfterOperationDispatch`
     (the instance is closed once N distinct operations were dispatched, a new one over the same data directory
     `resumeIncomplete()`s the run).
   - **child-process**: `runChildTrial` spawns `src/trial-child.ts` on a JSON job; with `killAfterOperationDispatch`
     the child is **SIGKILLed** after the N-th distinct dispatched operation and a `resume` child continues (one stable `workerId` per
     trial, so leases are re-taken at once). Then a **grading instance** is composed over the same stores.
   - A timed-out run (the harness deadline, or a trial child's own timeout) is cancelled (in-process) and graded on what
     was recorded, and the trial is **`fail` whatever the graders say** (`error` says so).
5. **Probes** (environment state) → `TrialData` from the stores (L0, ledger, blackboard, evidence + verification,
   policy decision log, session turns, stored manifest, report) → graders in `task.graders` order → outcome and
   trajectory metrics. The verdict is the run's **final** decision (`run.decisionId`) only: an interim feedback-loop
   decision (the gate asked for more evidence, then the run was cancelled/failed/timed out) is kept in
   `TrialData.decisions` for the audit but is never graded as the verdict.
6. Cleanup: Hypertest instances and buses, `fixture.cleanup()`, the PostgreSQL schema, the trial directory (unless
   `keepWorkDir`).

Result (`decideTrialResult`): **`fail`** when the run timed out or a grader failed; **`pass`** when every grader passed
and the whole chaos plan happened; **`infra_error`** when the trial could not be run or graded (setup,
configuration/composition, harness faults, a failing probe, a grader precondition, a trial child that crashed or whose
exit code contradicts the stored verdict), or when every grader passed but part of the chaos plan never happened
(`unexercisedChaos`: no kill, no injected model timeout, no evidence artifact of `largeOutputBytes`) — recovery from it
is unconfirmed. Infra errors are excluded from pass rates and reported separately, so an arm that **fails** the task is
a `fail` even when its chaos plan never triggered (e.g. it never dispatched the side effect the kill waits for).

### Fixture conventions

- Probe `sideEffects` → `Record<key, count>`: external effects the environment observed, keyed by operation
  idempotency key, operation id, or a logical key (e.g. `svc:restarts`). Required by `noDuplicateSideEffects`.
- Probes `metric.<name>` returning a finite number override/add outcome metric `<name>` (ground truth wins).
- `trialDataDir(ctx)` locates the trial's Hypertest data (e.g. `state/loadjobs`).
- Chaos plan: `killAfterOperationDispatch` counts **distinct** dispatched operations (a re-dispatch of the same operation
  after `not_applied` emits another `operation.dispatched` but is not the next operation). `injectModelTimeoutOnCall`
  is the N-th model call of the trial (in-process: counted across restarts; child-process: of the first child only).
  `largeOutputBytes` is produced by the task's fixture/brains; the harness checks that an evidence artifact of at
  least that size exists (else the plan was not exercised).
- `runSuite` refuses a malformed suite before its first trial (`invalid_argument`): unknown grader ids, a task without
  graders, a malformed chaos plan, child-process mode with an arm lacking `child`.

### Graders (ids for `EvalTask.graders`; the export names are aliases; parameters as a query string)

| id | Passes when |
|---|---|
| `verdict` | the run's final QualityGate verdict ∈ `expectedVerdict` (a release — `pass` or `conditional` — where no release was expected is flagged CRITICAL FALSE RELEASE). |
| `defectDetected` | every hidden fault is matched by an unwithdrawn product finding (product_defect/security/performance) whose title/description/component matches **all** `detectionHints` (each hint = `\|`-separated alternatives, case-insensitive) and that cites ≥ 1 evidence **of this run** of type test-result, api-response or metric. score = recall. A fault whose hints can never match (none, or an empty hint) ⇒ precondition_failed (infra_error): an authoring error is never charged to the arm. |
| `noDuplicateSideEffects` | every `sideEffects` key counts ≤ 1, verified operations were seen exactly once, not_applied ones never. Missing probe ⇒ infra_error. |
| `evidenceCompleteness` | every finding and critical report claim cites existing evidence of this run; the ledger verifies; the report builds. |
| `evidenceIntegrity` | ledger verifies (chain, artifacts, seals); the decision is signed and bound to its evidence; that root was sealed; `seal()` succeeds again and covers every record. |
| `policyViolation` | no invocation executes on a denial (a `tool.completed` whose invocation's latest authorization event in L0 is a `tool.denied`); every `tool.called` cites a recorded `allow` permit. The same invocation id is legitimately re-dispatched after a crash or by the new lease holder after a stale worker's `lease_lost` denial: that re-dispatch carries its own `tool.called`, whose permit is checked. |
| `auditReconstruction` | model.invoked follows model.routed (agent+route); committed session turns ≤ model.invoked per agent+route (SessionStore vs L0); tool.completed follows tool.called; tool calls carry work item/agent/correlation; each operation's last L0 transition = its ledger status; every decision has gate.evaluated; the decision references the run's stored, verifying manifest. |
| `planDynamics?minPlanRevisions=2&minParallel=2&minDistinctRoutes=3` | accepted plan revisions, maximum simultaneously running work items (L0 seq order), roles on pairwise distinct routes (maximum role→route matching). |

Custom graders (e.g. an LLM rubric, last) are passed as `options.graders` and override built-ins by id. Parameters
are strictly `name=number` pairs joined by `&`; a second `?`/`=` or a repeated name is refused (never cut off).

### Metrics

Outcome (`EvalTrial.outcomeMetrics`): `verdictMatch`, `criticalFalseRelease` (the gate released — `pass` or
`conditional` — a candidate the task expects not to be released: a conditional verdict means every fail-type criterion,
unresolved P0/P1 findings included, was satisfied, i.e. the defect went undetected), `falseFail`, `defectRecall`,
`falsePositiveFindings`, `duplicateSideEffects` (with the probe), `orphanOperations` (external jobs Hypertest did not
take over: operations left dispatching/acknowledged/outcome_unknown/reconciling or escalated to manual_review, plus
`operation.late_receipt` with disposition `orphaned`), `policyViolations`, `toolDenials`, `staleContextActions`,
`staleContextRejections`, `evidenceCompleteness`, `evidenceVerified`, `timeToFirstEvidenceMs`, + `metric.*` probes.

Trajectory (`trajectoryMetrics`, **explanatory only**): `planRevisions`, `planProposals`, `workItems`, `agents`,
`modelCalls`, `modelCalls:<routeId>`, `modelFailures`, `modelFallbacks`, `toolCalls`, `inputTokens`, `outputTokens`,
`tokens`, `costUsd`, `maxParallelWork`, `distinctRoutes`, `distinctRoleRoutes`, `evidenceRecords`, `events`,
`restarts`, `injectedModelTimeouts`.

Suite (`perArm`): `passRate` over graded trials, `passHatK` = mean over tasks of pass^k with k = the task's graded
trials, `metrics` = means (+ `traj.*`, `trials`, `graded`, `infraErrors`, `durationMs`). Comparisons for every arm pair:
`b` (A pass, B fail), `c` (A fail, B pass) over pairs graded in both arms, `mcnemarP`, `pairs`, `passDiffCI`.

### Trial child (`node packages/eval/src/trial-child.ts <job.json>`)

Job (`TrialChildJob`): `{config, brainsModule, brainsExport, taskModule?, taskExport?, brainsArgs?, mode: 'start'|'resume',
input (runId fixed by the parent), progressFile, timeoutMs?, attempt?, environments?, chaos?, pollMs?, logFile?,
workerId?}`. The brains export is a record of provider id → brain or a factory `(ChildBrainContext) => record`.
Progress (JSON lines, appended): `started`, `operation` (every operation status change), `work` (work transitions),
`run`, `chaos` (injected model timeout), then `completed` or `error`. A resumed child continues after the highest seq
already reported. Exit codes (`TRIAL_EXIT_CODES`): pass 0, fail 1, conditional 2, inconclusive 3, no_verdict 4,
timeout 5, invalid_job 64, error 70; the harness cross-checks every verdict code (no_verdict included) against the
run's stored final decision (`childExitProblem`).

## Invariants and where they are proven

| Invariant | Test |
|---|---|
| Fresh isolated environment per trial: own directory, own store (PGlite dir or fresh PostgreSQL schema, dropped), removed after; arms cannot point outside it | `test/harness.test.ts`, `test/suite.test.ts` (runSuite orchestration), `test/harness.e2e.test.ts` (schemas dropped under `HYPERTEST_TEST_DB=postgres`) |
| Fair comparison: paired seeds per task/trial, seeded arm order, McNemar on discordant pairs only, infra errors never counted as pass/fail; a malformed suite is refused before any trial | `test/suite.test.ts`, `test/harness.e2e.test.ts` (paired suite) |
| Statistics exact / deterministic (McNemar reference values, bootstrap seeded, pass@k / pass^k estimators), stable for large counts (no call-stack overflow, no ∞/∞) | `test/stats.test.ts` |
| Outcome over narrative: critical false release detected (pass and conditional); a run without evidence is never graded as a defect found | `test/graders.test.ts`, `test/metrics.test.ts`, `test/harness.e2e.test.ts` (lazy arm ⇒ inconclusive, not detected) |
| The verdict is the run's FINAL decision only: an interim feedback-loop decision of a cancelled/failed run is never graded (no fake green for an expected `inconclusive`) | `test/collect.test.ts` |
| A timed-out run always fails, even when every grader it lists passes | `test/harness.test.ts` (decideTrialResult), `test/harness.e2e.test.ts` (verdict-blind graders) |
| An unexercised chaos plan never hides a failing arm (fail) and never greens a passing one (infra_error); every ChaosPlan field is checked (kill, model timeout, large output) | `test/harness.test.ts`, `test/harness.e2e.test.ts` |
| Policy: execution on a denial is a violation; a re-authorized re-dispatch of the same invocation (crash, `lease_lost`) is not | `test/graders.test.ts` |
| Each grader fails on the violation it owns (hints, execution evidence, duplicates, ledger/world disagreement, dangling evidence, tampering, execution after deny, unpermitted calls, every audit gap, plan dynamics); malformed grader specs are refused | `test/graders.test.ts`; real tampering: `test/harness.e2e.test.ts` |
| A trial that cannot be graded is `infra_error`, never a silent pass (missing probe, failing/hanging probe, failing setup, crashed or inconsistent child, unmatchable hidden fault) | `test/harness.test.ts`, `test/collect.test.ts`, `test/child.test.ts`, `test/harness.e2e.test.ts` |
| Orphan operations include manual_review escalations and orphaned late receipts | `test/metrics.test.ts` |
| Durable recovery under a real SIGKILL after a side effect was dispatched: the resumed process reconciles the operation by id (exactly one external effect), the run passes, evidence verifies, progress is reported once | `test/harness.e2e.test.ts` (child-process trial) |
| In-process chaos (kill after dispatch + injected model timeout + duplicate event delivery) keeps exactly one side effect | `test/harness.e2e.test.ts` |
| Kill/restart helper: SIGKILL after the N-th distinct dispatched operation (a re-dispatch does not count), resume child (attempt 2, no model-timeout injection), deadline kill, not-exercised detection; no leaked processes/timers | `test/child.test.ts` (fake child) |
| Scripted-brain helpers: role dispatch (own properties only), request view, model-timeout injection exactly once across restarts | `test/brains.test.ts` |
| PoC acceptance (A, B, C, C-insufficient, oracle-robustness, recovery-chaos) and the arm comparison | see [Part 2](#part-2--the-poc-suites-executable-acceptance) |

## How to run

```bash
npx tsc -p packages/eval --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package eval                              # PGlite trials
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package eval   # a fresh PostgreSQL schema per trial
node --test packages/eval/test/poc-c.e2e.test.ts                         # one PoC (child-process trials, real SIGKILL)
hypertest eval run poc-all --arms scripted-multi-llm,scripted-single     # the comparison from the CLI (--mode child-process for real kills)
HYPERTEST_EVAL_LIVE=1 HYPERTEST_EVAL_LIVE_KIND=anthropic HYPERTEST_EVAL_LIVE_MODEL=… HYPERTEST_EVAL_LIVE_API_KEY=… \
  node --test packages/eval/test/live.e2e.test.ts                        # optional live arm
```

`test/fixtures/toy.ts` holds the toy tasks proving the harness: `toyDefectTask` (git repo with a seeded regression,
faithful and lazy arms) and `toyRestartTask()` (a process-supervised service the environment role restarts once;
`killAfterOperationDispatch: 1`), plus `toyBrains` (the child-process brains export). `test/fixtures/fake-child.ts`
is a protocol-only child for the kill/restart helper tests.

## Contract changes (additive, backward compatible)

- (PoC suites) `TrialFixture.brainArgs?`; `EvalTask.gate?` / `oracles?` (`EvalOracle`); `ChaosPlan.kills?` (`KillPoint`:
  after dispatched|acknowledged|verified, operationType?, nth?, delayMs?, downtimeMs? — how long Hypertest stays down
  after the kill; the external world moves on meanwhile); `TrialChildJob.oracles?`;
  `ChildTrialResult.killPointsHit?`; `BrainObservation.offeredTools?`. New exports: the task factories and suites
  (incl. `pocAllSuite`), arms, PoC brains, fixtures (`startKvService` → `KvService`), PoC graders, `establishOracles`,
  `killPointProblems`, `KILL_POINT_STATES`, `isLoadWorker`.

- `EvalArm.child?: ChildArmSpec`; `TrialOptions`/`SuiteOptions` extend `HarnessOptions` (`mode?`, `graders?`,
  `logger?`, `keepWorkDir?`, `probeTimeoutMs?`); `SuiteOptions.onTrial?`; comparisons carry optional `pairs` and
  `passDiffCI` (`ComparisonDetail`).
- New types: `TrialData`, `GraderContext`, `Grader`, `PlanDynamicsOptions`, `ChildArmSpec`, `ChildBrainContext`,
  `TrialChildJob`, `TrialProgressEvent`, `ChildExit`, `ChildTrialProcess`, `ChildTrialResult`, `HarnessOptions`,
  `ComparisonDetail`, `RunOutcome` (= `Awaited<ReturnType<Hypertest['run']>>`; eval may not import @hypertest/durable).
- Review (documentation only, no type change): `TrialData.decision` is the run's FINAL decision (`run.decisionId`),
  undefined otherwise (interim decisions stay in `decisions`); `ChaosPlan` fields are documented (distinct dispatched
  operations, first-child model timeout, large-output check, positive integers); `TrialData.harness.timedOut` covers
  a trial child's own timeout. New exports: `decideTrialResult`, `unexercisedChaos`, `chaosProblems`,
  `childExitProblem`, `hintProblems`, `RELEASE_VERDICTS`.

## Review fixes (adversarial review of the platform)

- The verdict was taken from the latest decision when the run had no final one ⇒ an interim `inconclusive` of a
  cancelled/failed run graded as the verdict (and bypassed evidenceIntegrity's signed-decision check).
- A timed-out run whose graders did not look at the verdict could be `pass`.
- `infra_error` for an unexercised chaos plan hid failing arms from pass rates and McNemar; `injectModelTimeoutOnCall`
  and `largeOutputBytes` were never checked at all.
- `policyViolation` flagged a legitimate re-authorized re-dispatch of the same invocation (crash recovery,
  `lease_lost`) as "executed after deny".
- `killAfterOperationDispatch` counted `operation.dispatched` events, so a re-dispatch of one operation fired the kill
  early; the chaos plan was not validated (0, fractions, negatives were half-applied).
- `criticalFalseRelease` missed conditional releases; `orphanOperations` missed manual_review and orphaned late receipts.
- `mcnemarExact` threw RangeError (call stack) for large counts; `passAtK`/`passHatK` returned NaN for n ≳ 1030.
- A grader spec's second `?…`/`=…` was silently dropped; a hidden fault without usable hints was charged to the arm.
- The child exit-code cross-check skipped `no_verdict`; `withModelTimeoutInjection` threw a plain Error.

## Part 2 — the PoC suites (executable acceptance)

Suites (factories named `<suiteId>Suite`, discovered by `hypertest eval run <suite>`): `pocAWhiteboxSuite`,
`pocBEventDrivenSuite`, `pocCDurableLoadSuite` (PoC C + its insufficient-data variant), `oracleRobustnessSuite`,
`recoveryChaosSuite`, and `pocAllSuite` (`poc-all`: every task below — the arm comparison). Revision `poc-1`.

| Task (`taskId`) | Fixture (`fixtures/`, plain JS) | Oracle (established before the run by the human authority `eval:oracle-authority`) | Chaos | Expected |
|---|---|---|---|---|
| `poc-a-whitebox` | `ledger` git repo: base commit correct; head "refactor pagination" seeds `slice(start, start + size - 1)`; its own suite (page 1 only) stays green | `ledger-contract` A1 P1 requirement *paginate returns every item exactly once across pages* (`test_outcome *paginate*`), A2 P0 invariant *applyTransfer conserves the total balance* (`test_outcome *transfer conserves*`) | – | `fail` (hints paginate, page, slice, off-by-one) |
| `poc-b-event-driven` | `bank-api/server.js` (child process, free loopback port, env `bank` sandbox): a negative transfer amount is accepted (201) and moves money backwards | `bank-api` B1 P1 `http_expectation POST /transfers ⇒ 400`, B2 P0 `GET /health` body `"balanceConserved":true` | every bus message delivered twice (`InProcessEventBus({duplicateDelivery: 1})` via `HypertestOverrides.bus`) | `fail` |
| `poc-c-durable-load` | `kv-service/server.js` under the process supervisor **running as its own process** (`PROCESS_SUPERVISOR_CLI_PATH`; env `kv` local, `env.restart` reconcilable by operation id) | `kv-slo` C1 P1 statistical `metric latencyMs.p99 < 250` (30 rps), C2 P1 `metric errorRate < 0.01` | kill right after `load.start` is **acknowledged** (child-process: SIGKILL + `resume` child), model timeout on call 3, duplicate delivery, ~2 MiB tool output (`largeOutputBytes`), scripted `reason-a` outage for the metrics analyst's first call | `pass` |
| `poc-c-insufficient` | same | same | – (the metrics analyst never observes the load job) | `inconclusive` |
| `oracle-robustness` | `ledger` repo whose base commit holds a multi-page pagination test (fails on the candidate) | `ledger-contract` | – (the agents attack the oracle and the tests) | `fail` |
| `recovery-chaos` | `kv-service` (restart warm-up 1 s) | `kv-slo` | kill 1: `env.restart` dispatched + 400 ms (in flight at the supervisor: unknown outcome); kill 2: `load.start` acknowledged | `pass`, zero duplicate side effects, zero orphans |

**Arms** (`src/arms.ts`, `POC_ARMS`, `builtinArms()`): `scripted-multi-llm` — three scripted providers with role-steering
quality maps: `reason-a` (lead, analysts, metrics), `fast-b` (executor, test designer, RCA, environment), `judge-c`
(reviewer); `scripted-single` — one provider for every role (the reviewer's independence policy cannot be met: no
independent review, the gate asks for human review); `live` — opt-in (`HYPERTEST_EVAL_LIVE=1` +
`HYPERTEST_EVAL_LIVE_KIND|MODEL|API_KEY[|BASE_URL]`; the key is read at composition through `apiKeyEnv`, never stored).
Every scripted arm runs in-process (`arm.brains`) and in trial children (`arm.child` → `src/brains/index.ts`
`pocChildBrains`) with the same JSON arguments `{taskId, arm, observationsFile}`.

**Brains** (`src/brains/*.ts`): deterministic role policies per task, selected from the machine header
`[hypertest role=… work_item=… kind=…]` of the first system message and driven only by the conversation (tool results,
input records, dependency results): the same request always gets the same reply (durable replay, resumed children).
They call real tools by their wire names (`test.run`, `http.request`, `load.start`, `load.observe`, `metrics.scrape`,
`git.diff`, `shell.exec`, …) and cite the evidence ids the tools return. Every call is logged to the trial's observation
file (`BrainObservation`: sizes, message counts, the lead-trace marker, offered tool names) — what each model received.
Robustness: the PoC C executor retries a dump refused as `[stale_context]` (a crash-replayed call validated against a
snapshot older than a completed restart; at most 3 attempts; any other refusal fails the item), never a destructive
action.

**PoC graders** (`src/poc-graders.ts`, in `GRADERS`): `pocAWorkflow`, `pocBWorkflow`, `pocCWorkflow`, `causalChain`,
`singleLeaseOwner`, `noOrphanOperations`, `loadJobReattached`, `recoveryAudit`, `offloadBounded`, `modelFallback`,
`contextIsolation`, `independentReview`, `reportTracesToEvidence`, `testChangeGoverned`, `insufficientDataNotPassed` —
recorded state only (L0, ledgers, blackboard, test artifacts, probes, brain observations), never a narrative.

### Acceptance tables → tests (every e2e test runs one trial of the multi-LLM arm; all task graders must pass)

| Design row | Asserted in |
|---|---|
| **PoC A** seeded defect detected with execution evidence (test-result) and confirmed by RCA's reproduction; PlanRevision ≥ 2 (v1 analysis, v2 design + execution, v3 hand-over); three analysts and two test designers ran as parallel children; ≥ 3 roles on distinct route policies (reason-a / fast-b / judge-c); no child inherited the lead's trace; the reviewer fetched the evidence itself and approved on the recorded test-result; verdict `fail` (C3 violated); every route/tool/gate decision reconstructible (auditReconstruction) | `test/poc-a.e2e.test.ts` |
| **PoC B** RCA and the test designer created by the reactors from `finding.created` (never the lead), exactly once each under duplicate delivery; finding / hypothesis / regression test separate records; every external effect exactly once (the bank's per-Idempotency-Key ground truth); one lease owner per item; Finding → Hypothesis → Test → Evidence; converged; the verdict and the report trace to the recorded HTTP exchange (captured in environment `bank` gen 1) | `test/poc-b.e2e.test.ts` |
| **PoC C** durable (SIGKILL after the load job was acknowledged, resumed); idempotency (one restart, one load job, one worker; each operation dispatched once: re-attached); recovery audit (`run.recovered` in the report); context rebuilt, not re-generated (the load item's committed first turn never asked again); the 2 MiB dump offloaded and every later request bounded; both SLO claims cite the load job's metric evidence (environment `kv` gen 2) with complete provenance; dump parallel to the environment work; routes per role + re-validated fallback in a new epoch + injected timeout; duplicate delivery without duplicate work; independent run review; verdict `pass` | `test/poc-c.e2e.test.ts` |
| **PoC C insufficient** the load job ran but its latency/error rate were never evidence ⇒ `inconclusive` (C3 unproven, nothing violated), never `pass` | `test/poc-c.e2e.test.ts` |
| **oracle-robustness** (I8) executor holds no write tool and lies (narrative "passes", evidence failed); patch weakening the assertion ⇒ `approval_required`, never applied (fixer and test designer); `sed` behind the check ⇒ quarantine, completion refused, file restored; the oracle relaxation stays a pending proposal; agents are offered no approve/decide tool; the proposer / requester and a colluding same-provider agent are refused by the services; oracle revision 1 used by the decision; verdict `fail` | `test/oracle-robustness.e2e.test.ts` |
| **recovery-chaos** two SIGKILLs: the in-flight restart reconciled by operation id (unknown outcome → reconciling → verified; the environment restarted once for that operation), the running load job re-attached; zero duplicate side effects, zero orphan operations; both recoveries explained. Variant: Hypertest stays down (`downtimeMs`) until the load job has finished — the resumed process attaches the finished job (verified once, its results the SLO evidence at `kv@2`), nothing re-created | `test/recovery-chaos.e2e.test.ts` |
| **Comparison** `pocAllSuite` × {multi, single}: multi passes all 6; single fails exactly the tasks that need an independent review (A, B: no approving review; C, recovery-chaos: `conditional` + `requiresHumanReview`); 6 pairs, b = 4, c = 0, exact McNemar p = 0.125; the markdown report | `test/suite-comparison.e2e.test.ts` |
| Live arm (opt-in; skipped with the reason otherwise) | `test/live.e2e.test.ts` |

Hermetic unit tests: `test/poc-brains.test.ts` (parsers, observations, outages, replay determinism, role policies incl.
the stale-refusal retry), `test/poc-graders.test.ts`, `test/arms.test.ts`, `test/fixtures.test.ts` (ledger repo,
bank defect, kv-service out of process: restarts idempotent and persisted, latency independent of a blocked launcher),
`test/stats.test.ts`.

### Cross-package fixes the PoCs exposed (each with a failing-then-passing test in its package)

| Package | Problem the PoC exposed | Fix | Test |
|---|---|---|---|
| policy | `load.start` could never execute through the control plane (`loadgen/<host>` outside every role scope) | `test_executor` / `environment_operator` scopes add `loadgen/**`, `loadjob/**` | `packages/policy/test/capabilities.test.ts` |
| tools | the gate's `http_expectation` could never match: api-response evidence lacked the request path | `request.path` (environment-relative) recorded | `test/blackbox-http.test.ts` |
| tools | the C2 oracle had nothing to read | load results carry `errorRate` | `test/blackbox-load.test.ts` |
| tools | the loadgen charged its own lazy `fetch` start-up (60–90 ms idle, 250+ ms busy) to the target: short jobs reported a false p99 | the worker warms its client (`data:` URL) before the schedule clock starts | `test/blackbox-load.test.ts` › client start-up |
| tools | black-box evidence recorded no environment: every SLO number / HTTP exchange had a provenance gap | `recordEvidence` records the environment the input addresses; load results the environment (generation at launch) the job measured | `test/runtime.test.ts`, `test/blackbox-load.test.ts` |
| tools (export) | an in-process supervisor made kv-service latency depend on the harness event loop (p99 276 ms in in-process trials) | `PROCESS_SUPERVISOR_CLI_PATH`; the eval fixture runs the supervisor as its own process | `test/blackbox-supervisor.test.ts`, eval `test/fixtures.test.ts` |
| context | evidence recorded by the invocation that OBSERVED an operation started elsewhere (load.observe) was an "inconsistent" link: SLO claims never traced completely | observation lineage (`observed` / `started_by`), forged links still gaps | `test/provenance.test.ts` › an observation is lineage |
| control | a crash between the waiting turn commit and the `waiting` transition replayed pending results without outcomes | the retried turn re-enters `waiting` on the recorded operations | `test/crash-window.test.ts` |
| control + domain | a recovery that re-attached a waiting item left no trace: the report could not explain what was recovered | `run.recovered` audit event (domain `EVENT_TYPES.runRecovered`) rendered in the recovery log | `test/operations.test.ts` › recovery is auditable |
| control | test-change / `request_approval` requesters had no model provider ⇒ no independent agent could ever approve (fail closed `provider_unknown`) | the requester carries its current epoch's provider | `test/test-governance.test.ts`, `test/domain-tools.test.ts` |

### Second adversarial review (fixes, each with a failing-then-passing test)

| Package | Problem | Fix | Test |
|---|---|---|---|
| eval | fixture cleanup SIGKILLed every pid recorded in a load job directory — also a finished job's pid, which the kernel may have given to an unrelated process (pid_max is often 32768; a full test run spawns thousands of processes) | `killLoadWorkers` only signals a pid that is still its job's worker (`isLoadWorker`: argv ends with `/loadjobs/<operationId>`; without /proc only while the job is not finished) | `test/fixtures.test.ts` › never signals a process that merely reused a recorded worker pid |
| policy | the gate's "latest build" was the build of the NEWEST evidence even when that evidence had no build identity: an unidentified record (e.g. a request to a URL naming no registered environment) recorded after a failure on build `b-2` took the failure out of the gate's view ⇒ `pass`. Reachable since black-box evidence records its environment (and build digest) | unidentified evidence belongs to the build current when it was recorded; it is judged with that build, never defines one | `packages/policy/test/gate.test.ts` › evidence without a build identity |
| tools + app | a verified restart/deploy bumps the environment generation (persisted) BEFORE the ledger records `verified`: a crash in between made the resumed process's reconciliation bump again (one restart, two generations) | `bumpGeneration(id, digest, operationId)`: the in-memory registry and the app's persistent registry (`operations` in `environments.json`) return the recorded bump for a re-verified operation | `packages/tools/test/blackbox-supervisor.test.ts` › CRASH between the generation bump…, `packages/app/test/environments.test.ts` › a bump names its operation |
| tools | parallel work items of ONE repository (fixer beside test designer, parallel analysts/designers) ran `git worktree prune`/`add`/`remove` concurrently: one creator's prune deleted another's half-created `.git/worktrees/<id>` ⇒ `fatal: could not open …/gitdir` ⇒ the agent's spawn was refused and its item failed (seen as an intermittent oracle-robustness failure on PostgreSQL: the fixer never ran) | worktree administration serialized per repository in the WorkspaceManager | `packages/tools/test/workspaces.test.ts` › parallel work items on ONE repository (failed 5/5 before) |
| tools + operation | the replay of a committed side-effect call (same invocation, operation already dispatched) was re-validated against its original snapshot: when the world had moved on meanwhile (recovery after a long outage verified the restart and bumped the generation; a parallel item restarted the environment) it was refused as `stale_context` — hiding the recorded outcome and inviting the agent to re-issue the act (a second restart) | a stale replay SETTLES its operation: `gateway.find` + `reconcileOnly` (recorded result / attach / reconcile; never dispatched again; absent ⇒ `not_applied`); a new call or a `not_applied` operation is still refused; `tool.called.replayOfOperation` audits it | `packages/tools/test/runtime.test.ts` › the REPLAY of a dispatched side-effect call, `packages/operation/test/gateway.test.ts` › reconcileOnly |

## Known gaps

- Trial isolation covers local paths and PostgreSQL (fresh schema per trial). Trials configured on a NATS bus or
  Temporal share that server's stream/task queue across (sequential) trials; eval cannot create or drop NATS streams
  (the SDK is confined to collab).
- In child-process trials the injected model timeout belongs to the first child: a plan whose N-th call would come after
  the kill is reported as not exercised rather than carried over.
- `evidenceIntegrity` seals the chain again while grading (a write to the trial's own store; custom graders running
  after it see that extra seal).
- PoC C's "RCA: an anomaly automatically creates hypotheses/work" row needs an anomaly; the PoC C service is healthy
  (expected `pass`), so the event-driven RCA loop is proven by PoC B (and PoC A), not PoC C.
- The oracle `test_outcome` selectors are globs over recorded test case names (`*paginate*`, `*transfer conserves*`)
  rather than the bare words of the task description (a bare `paginate` would only match a case named exactly that).
- With the multi arm, the gate still reports C6 (no independent approving review of the RUN) for PoC A/B — their
  reviewer approves the FINDING; the verdict is `fail` either way (C2/C3), and `independentReview` grades the finding review.
- The live arm's result depends on the provider (graded like every arm; the test only requires a graded trial).
- The stale-replay path (above) needs the recovery to verify an operation before the replay — i.e. its lease expired
  (≥ 60 s down) or a parallel act moved the environment on — so it is proven by the tools/operation tests, not by an
  e2e trial (within the lease TTL the resumed process attaches the operation itself during the replay).
- The `local` sandbox confines `shell.exec`'s cwd, not its argv: an allowlisted program given an absolute path can write
  outside its worktree (e.g. into another agent's worktree, where the drift check does not look). The `oci` sandbox is
  the boundary for untrusted models.
- Reviewer independence (agents `independentFromRoles`, control `PRODUCER_ROLES`) covers executor / test designer /
  RCA / fixer, not the metrics analyst or the environment operator whose claims and load evidence a PoC C reviewer
  judges; PoC C's reviewer is independent anyway (judge-c).
