# @hypertest/eval

The long-lived **Eval Platform** of Hypertest (BLUEPRINT §5 eval, §6 PoCs; design: "Agent 评测基准与对比实验设计" in
`docs/design/architecture-improvements.zh-CN.md`). It runs versioned `EvalTask`s under experiment `EvalArm`s in a
**fresh environment per trial**, grades the **outcome** (environment state first, then deterministic records and
evidence consistency — never the agent's narrative), keeps trajectory metrics as explanation only, and compares arms
with **paired** statistics (exact McNemar, seeded paired bootstrap, pass@k / pass^k).

This package is the platform the PoC suites plug into. The PoC fixtures, their scripted brains, the suite factories
(`pocAWhiteboxSuite()`, `pocBEventDrivenSuite()`, `pocCDurableLoadSuite()`, `oracleRobustnessSuite()`,
`recoveryChaosSuite()`) and the PoC e2e tests are implemented by a follow-up unit on top of this API.

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

## How to run

```bash
npx tsc -p packages/eval --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package eval                              # PGlite trials
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package eval   # a fresh PostgreSQL schema per trial
```

`test/fixtures/toy.ts` holds the toy tasks proving the harness: `toyDefectTask` (git repo with a seeded regression,
faithful and lazy arms) and `toyRestartTask()` (a process-supervised service the environment role restarts once;
`killAfterOperationDispatch: 1`), plus `toyBrains` (the child-process brains export). `test/fixtures/fake-child.ts`
is a protocol-only child for the kill/restart helper tests.

## Contract changes (additive, backward compatible)

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

## Known gaps

- `load.start` cannot execute through the built-in control plane: its resources include `loadgen/<host>`, which no
  role capability covers (control grants `workspace/**`, `run/<id>/**`, `env/**`) ⇒ `capability_denied:
  resource_out_of_scope`. PoC C's load generator needs a fix in control (scope) or tools (resources); the toy chaos
  task uses `env.restart` instead.
- Trial isolation covers local paths and PostgreSQL (fresh schema per trial). Trials configured on a NATS bus or
  Temporal share that server's stream/task queue across (sequential) trials; eval cannot create or drop NATS streams
  (the SDK is confined to collab).
- In child-process trials the injected model timeout belongs to the first child: a plan whose N-th call would come after
  the kill is reported as not exercised rather than carried over.
- `evidenceIntegrity` seals the chain again while grading (a write to the trial's own store; custom graders running
  after it see that extra seal).
