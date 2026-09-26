# @hypertest/control

The Hypertest-owned **control plane**: the Lead + Dynamic Scheduler (control plane), the Blackboard/event-driven
reactors (collaboration plane), bounded decentralization and convergence, work execution (AgentWorker), the
QualityGate path and the report. Models propose; this package disposes: every plan is typed Plan IR validated
deterministically, every tool call goes through the governed ToolRuntime, every state change is fenced and on L0,
and only the deterministic QualityGate produces the verdict.

Depends on `core`, `domain`, `collab`, `operation`, `policy`, `evidence`, `model`, `context`, `tools`, `runtime`
and `agents` (implemented packages; their real behaviour is relied on). The binding ABI is
[`src/contracts.ts`](src/contracts.ts); `ControlDeps` (every already-constructed service) is declared in
[`src/deps.ts`](src/deps.ts).

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `createControlPlane(deps: ControlDeps)` | The `ControlPlane` facade (+ `scheduler`, `reactors`, `convergence`, `worker`, `config`, `close()`): `startRun`, `tick`, `executeTurn`, `observeWaiting`, `recover`, `cancelRun`, `pauseRun`, `resumeRun`, `snapshot`, `report`. Registers the domain tools in the shared registry (idempotent) and the FreshnessGuard resolvers (`experiment`, `environment`, `oracle`, `record`, `finding`, `lease`) when missing. |
| `controlMigrations` | `control/001-control`: `ht_manifests`, `ht_run_gates`, `ht_reactor_cursors`, `ht_claims`, `ht_replans`, `ht_agent_hosts` (PGlite + PostgreSQL 16). |
| `validatePlan(input)` | Pure Plan IR validation (see below). |
| `createScheduler`, `createReactorService`, `createConvergenceMonitor`, `createAgentWorker` | The parts (exported for durable runtimes and tests). |
| `createDomainTools(deps)` | `blackboard.*`, `plan.read`, `plan.propose_revision`, `work.propose`, `system_model.record`, `oracle.get|list|propose_change`, `experiment.define`, `test_artifact.register|validate`, `evidence.get|query|claim`, `delegate`, `request_approval`, `complete_work`, `fail_work` — exactly `DOMAIN_TOOL_IDS` of `@hypertest/agents`. |
| `createReportBuilder(deps)` | `RunReport` with markdown + json. |
| `createToolDispatcher`, `createContextProvider`, `condenserSummarizer`, `agentHeader`/`parseAgentHeader`, `unifiedDiff`, `WorkFactory`, `ControlStore` | Building blocks of the EngineHost and the stores (exported for reuse/tests). |
| `classifyDrift`, `quarantineLifted`, `diffSections`, `invertSection`, `sectionPaths` | Post-execution test-change governance of execution tools (see ToolDispatcher). |
| `tightenModelPolicy(role, item)` | The effective model policy of a work item's agent: the role's policy tightened, never weakened, by the item's. |
| constants | `REACTOR_CONSUMER` (`reactors`), `REACTOR_SUBJECTS` (`ht.*.>`), `FEEDBACK_CRITERIA` (C3, C4, C6, C8), `MAX_GATE_ATTEMPTS` (2), `PRODUCER_ROLES`, `GOVERNED_TOOL_IDS`, `QUARANTINE_BLOCKED_TOOL_IDS`, `TERMINAL_TOOL_IDS`, `CONFIRMING_ROLES`, `RESOLVING_FINDING_STATUSES`, `DEFAULT_TURN_LIMITS`. |

`ControlConfig`: `capabilitySecret`, `runtimeManifest`, `workerId`, `defaultEngineKind`, `leaseTtlMs` (60000),
`runLeaseTtlMs` (= leaseTtlMs), `turnLimits` ({16, 4}), `defaultBudget`, `defaultGate`, `onBudgetExhausted`
(`'gate'` | `'pause'`, default gate), `targetRepoPath?`, `maxInlineContextTokens?` and (additive) `maxOutputTokens`
(4096), `heartbeatMs` (max(1000, leaseTtl/3)) and `maxWorkAttempts` (5: an item that lost its worker that often
fails `lease_lost` instead of being requeued again). `ControlDeps.catalog?` (additive) gives the route context window.

## Semantics

**startRun** — one transaction: manifest into `ht_manifests` (idempotent), `TestRun` created → running with
`budget = DEFAULT_BUDGET ⊕ config.defaultBudget ⊕ input.budget`, pinned `runtimeManifestId`, `policyRevision`,
`protocolBinding`, `oracleRevisions` (current revision of each `oracleIds`; unknown ⇒ `invalid_argument`, nothing
written), `gate = DEFAULT_GATE_SPEC ⊕ config.defaultGate ⊕ input.gate` (`ht_run_gates`), budget scope `run:<id>`
{tokens, costUsd?, toolCalls, workItems} (+ `budget.reserved`), and the lead `initial_plan` work item (objective =
goal + target + instructions for Plan v1; role budget; lead output schema). Retrying with the same `runId` returns
the stored run. Budget caps are validated (`invalid_argument`): counts/limits are integers ≥ 1 (`maxAgentDepth` ≥ 0),
optional cost/compute/QPS/bytes finite ≥ 0 — a zero concurrency or work-item cap would only stall the run.

**tick(runId)** — serialized per run in-process and across processes by the run lease `run/<runId>` (owner =
`workerId`); another live owner ⇒ idle, nothing written. Steps: terminal ⇒ final result; paused ⇒ idle; converging/
gating ⇒ gate again (crash between gate transitions). Then: (b) exhaustion (wall clock, run tokens/cost/tool calls,
no room for one more call's output — `limit − used < maxOutputTokens`; reservations of calls in flight are NOT
counted, they settle to their actual use and exhaustion is permanent —, or a model call refused by the run scope at
the current limit while no other call held a reservation) ⇒ admission stops and ready/blocked work is cancelled
(`budget.exhausted`), active work may finish; (c) reactor catch-up; (d) unblock (all dependencies completed ⇒ ready,
a failed/cancelled/missing one ⇒ failed `dependency_failed`); (e) lease expiry (claim and lease both expired ⇒ requeue:
ready, claim dropped, attempts+1 ⇒ the old token is stale; at `maxWorkAttempts` the item fails `lease_lost` instead, so
a poison item never livelocks the run); (f) replan triggers; (g) admission; (h) convergence and gate; (i) `idleMs` 0 on
progress, else exponential backoff capped at 5 s.

**Reactors** — consume L0 after the `ht_reactor_cursors` cursor (consumer `reactors`), in seq order; each event of a
subscribed type is handled in ONE transaction with `inbox.tryConsume` + work creation + cursor advance, so a
duplicate delivery (bus handler twice, bus + catch-up, two workers) creates nothing twice (I5). Matching uses
`matchesSubscription` with the actor role resolved from `agentId` (AgentRepository) or the event's work item;
`renderSubscriptionWork` renders title/objective from the event payload + the record (title, severity, summary,
component, recordId, lineageId; coverage gap title = area; `review.requested` recordId = subject id). Guards:
`maxPerRun` (items with that `origin.rule`), `maxCausalDepth` (depth = source item depth + 1), the run work-item cap
(`budget.exhausted`, the event is still consumed — never stuck). Fingerprint `ruleId:lineage`. With a bus, the
durable consumer `reactors` on `ht.*.>` runs `handleDelivered` (same dedupe). An event of a run that has ended
(completed/failed/cancelled — e.g. a late bus delivery) is consumed without creating work. Every work creation of a run
(reactions, plans, replans, delegations, proposals, the lead item) is serialized by a transaction-scoped advisory lock
(`WorkFactory.lock`, `ht_work:<runId>`), so per-rule counts and the work-item cap are exact under concurrent
deliveries on PostgreSQL; lock order: that lock before any event append of the run (no deadlock with the run's event
counter lock).

**Replans** — at most one active lead item; accepted plans < `maxPlanRevisions` and replan ordinal <
`maxPlanRevisions` (else `stalled`: `max_plan_revisions` / `livelock`). Reasons: `gate_feedback` (pending in
`ht_replans`) or `plan_drained` (no non-terminal work, latest accepted plan not readyForGate). The replan objective
is a bounded digest: objectives + statuses, work items with results/failures, blackboard changes since the last plan
(ids, severities, statuses, evidence ids), failed/cancelled work, gate feedback (unknown/violated criteria + reasons),
remaining budget. Fingerprint includes the ordinal.

**Admission** — ready items by priority desc, createdAt asc; active (claimed+running; waiting does not count) <
`maxAgentConcurrency`; resource claims all-or-nothing through ResourceAdmission (conflict ⇒ stays ready); lease
`work/<id>` (owner `workerId`, `leaseTtlMs`) ⇒ `ready → claimed` with `{ownerId, leaseId, fencingToken, expiresAt}`
(`expectedFrom: ['ready']`); a failed claim releases lease and claims.

**Convergence / gate** — gate when drained (`ready_for_gate` / `plan_drained`), stalled or exhausted AND nothing is
claimed/running/waiting/ready AND no subscribed event is unconsumed. `running → converging → gating`; GateInput from
the stores: objectives of the latest accepted plan, exactly the run's pinned oracle revisions, experiments, current
findings/risks/reviews/coverage gaps, test artifacts, evidence up to the seal, `evidence.seal()`'s root (never the
unverified `latestSeal()`; without a signer the plain root), work items, `ht_claims`, `producerProviders`
(`epochs.providersUsedByRoles` of executor/test_designer/rca/fixer), `revision`/`supersedes` of the decision chain.
The decision is signed (`signer.sign(canonicalJson(decision without signature))`) and saved in ONE transaction with
`gate.evaluated` + `gate.passed|gate.failed` (the store adds `decision.recorded`), the gate-attempt count and the run
transition. Feedback loop: verdict inconclusive with an unknown criterion in {C3 critical oracles, C4 required
evidence, C6 independent review (needs_more_evidence), C8 coverage}, accepted plans < max, replan ordinal < max (a
replan can actually follow), budget not exhausted, room for a work item and attempts < 2 ⇒ feedback recorded, run back
to `running`, the decision stays as an audit record (superseded later). Otherwise final: `decisionId`, run `completed`
(whatever the verdict; `failed` is for internal faults), one `pitfall` experience **candidate** per open/confirmed
P0–P2 product finding (never auto-approved; proposed before the final commit, deduplicated by content, so a crash
between the two loses none).

**executeTurn(workItemId, fencingToken, signal?, {expectedTurn?})** — serialized per work item in-process with
`observeWaiting` (a duplicate concurrent delivery waits and then reports the outcome; it never runs the turn twice);
terminal item ⇒ its status; paused run ⇒
`paused`; the token must equal the item's claim AND pass `leases.checkFence(work/<id>)` else `lease_lost` with
nothing written; an ended run (e.g. a cancelRun that has not swept this item yet) ⇒ the item is cancelled, no turn
runs; lease and resource claims renewed; `claimed → running`; `ensureAgent` (a spawn refusal every retry would repeat —
agent cap, capability/depth violation, parent gone — fails the item: `budget_exhausted` / `policy_denied` /
`internal_error`, instead of throwing on every dispatch); an already committed turn ≥ `expectedTurn` ⇒
`continue` without running; an agent that already settled (crash after the settle) ⇒ its result is adopted; else
one `runner.step` with a lease heartbeat. Result mapping: continue ⇒ fence re-check (`lease_lost` if reassigned),
work budget (turns, tool calls, tokens, cost, wall clock ⇒ agent + item failed `budget_exhausted`); completed ⇒
item completed with `{summary, output, evidenceRefs, recordRefs}`; failed ⇒ failed (reason mapped onto
`WorkFailureReason`); waiting ⇒ `running → waiting` (`waitingOn`); boundary retry ⇒ continue, budget ⇒ failed (+ run
paused with `onBudgetExhausted: 'pause'` when the run scope refused), model_unavailable ⇒ failed; an explicit
interrupt ⇒ cancelled; a plain abort ⇒ `HypertestError('cancelled')` (the turn replays). Every item write uses
`expectedFencingToken` (stale_fence ⇒ `lease_lost`); a write refused because the item ended meanwhile (cancelled by a
plan revision or cancelRun mid-turn — the claim is kept for the audit) reports that terminal state instead of
throwing.

**ensureAgent** — reuse `agents.byWorkItem`, else: workspace per role (`shared_readonly` ⇒ shared snapshot of the
target repo/commit, `isolated_worktree` ⇒ worktree at the target commit + **materialized test artifacts** of
dependency work (their outputs' `testArtifacts` and artifacts generated by their agents) and `test_artifact`
inputRefs, from the ArtifactStore by digest; `scratch` otherwise); capability: a signed root from the role's
permission profile scoped to `[workspace/**, run/<id>/**, env/** for env-capable profiles]`, tools = role allow ∩
item allow, expiry = now + item wall clock; a delegation child's capability is `attenuateCapability(parent's
recorded capability, …)` (I2, never a root); spawned through `SubagentRuntime.spawn` with the task message
(objective, expected output schema, evidence requirements, full input records, dependency result summaries — never
transcripts —, oracle ids); model policy = `tightenModelPolicy(role policy, item policy)` (a plan may add
requirements, never drop reviewer independence, capabilities, prohibited providers, the quality floor or the privacy
class); the host spec (capability, model/tool policies, workspace recipe, quarantine) is persisted in
`ht_agent_hosts` in the spawn transaction (the runtime does not store policies).

**EngineHost** — `createModelInvoker` (role task type/classification, action risk = max risk of offered tools,
budget scopes `run:<id>` + `work:<id>` opened on first use with `budget.reserved`, `providersToAvoid` resolved at
every boundary for `independentFromRoles`); the governed **ToolDispatcher** (below); the **ContextProvider**: a
snapshot per turn (`snapshotBuilder.build` with the model epoch and the target environment), system prompt whose
FIRST line is `[hypertest role=<role> work_item=<id> kind=<kind> run=<runId>]` followed by the role prompt with the
prepared BUGate protocol context; sections Task (required), Plan & objectives (lead, reviewer), Blackboard digest +
full input records, Relevant code (analysis/design roles, `retrieverFactory(root)`), Approved experience, Evidence
of this item, Oracles; the L2 view (`maxInlineContextTokens` or route window × 0.6); hard pressure ⇒ LLM condenser
(role `condenser` through the router; deterministic summarizer on any failure) ⇒ `sessions.addCompaction` ⇒
`context.compacted`.

**ToolDispatcher** — refuses tools outside the agent's definitions/deny list; refuses every call once the work item
was reassigned or ended (claim token ≠ the host's, item not claimed/running, or `checkFence` fails ⇒ `tool.denied`
`lease_lost`); charges one tool call on `work:<id>` (parent `run:<id>`; terminal tools exempt; exhausted ⇒ refused +
`budget.exhausted`); every refusal at this level (not offered, fence, quarantine, budget, governance, governance
unavailable) is a `tool.denied` event with its `errorCode` — a refused call is on L0 like an executed one (I10); **I8**
for `fs.write` (in-process unified diff of current vs new content, under the path's
CANONICAL form — `..`/`.` segments and symlinks resolved, so `test/../src/x.js` or a test-dir symlink into product code
is classified as the product code it writes), `fs.apply_patch` (the patch; `check: true` exempt) and `git.commit`
(`workspaces.diff`): `classifyTestChange(diff, {productFixAuthorized: holdsProductFix})` ⇒
forbidden: not executed + `policy.decided {decision: deny, reason: test_change_forbidden}`; approval_required: not
executed + one `test_change` approval per diff digest (an approved digest executes; the requester is recorded with the
model provider of its current epoch, as `request_approval` and oracle proposals do — an agent approver must be
independent of it, which is impossible to establish without the provider); conditional: executed + registered
artifacts at those paths reset to `draft`; auto_allowed: executed. Then `toolRuntime.execute` with the turn's
snapshot (replayed turns use the snapshot recorded with the turn) and the work item event context (correlation =
work item, actor = agent, causation = the item's causation event). Terminal tools return `{terminal}`; pending
results (delegation `work:<child>`, side-effect operations) put the item in `waiting`; `test.run` results emit
`test.passed`/`test.failed` `{selector, passed, failed, errors, total, evidenceIds}`.
**Execution tools** (effect `execute`: `shell.exec`, `test.run`, `coverage.collect`, `mutation.run`, …) in a writable
git worktree can rewrite test code behind the pre-execution checks (`sed -i`, `node -e`, a test that rewrites another
test): the worktree diff is taken before and after the call (`workspaces.diff`; unavailable ⇒ refused, fail-closed) and
what changed is classified like a patch (`classifyDrift`: a new/changed section as is, a vanished section as its
inverse — deleting a test the run added is `test_deleted`; product files the base commit has are governed too — a
command must not "fix" the candidate behind the fix governance —, files the base lacks (build outputs, caches,
reports) are not classified). A
conditional change resets artifacts to draft; approval_required/forbidden ⇒ the result becomes an error,
`policy.decided {decision: deny, reason: test_change_unapproved|test_change_forbidden, phase: post_execution}`, and the
worktree is **quarantined** (persisted in the host spec, survives restarts): execution tools other than `shell.exec`,
`git.commit`, `test_artifact.register` and `complete_work` are refused until every governed section is back to its
pre-command text (e.g. `shell.exec git checkout -- <path>`; restoring is never itself a violation) — else the agent
can only `fail_work`. The pre-execution diff of the call in flight is persisted with the host spec (`guard`), so a call
re-dispatched after a crash (same invocation id) is judged against the state before its FIRST execution.

**observeWaiting** — keeps (renews) or re-takes the waiting item's claim, and renews its resource claims (the external
operation still occupies them: a conflicting item is not admitted meanwhile); `work:<child>` settles when the child is
terminal (summary/refs via `subagents.collect`, never its trace); other ids via `gateway.observe` (run-scoped;
verified/failed/not_applied/manual_review/compensated settle). All settled ⇒ in one transaction the results message
is queued for the agent and the item goes `waiting → running` ⇒ `continue`; else `waiting` (nothing re-dispatched).

**recover(runId)** — reconcile unsettled operations first (Reconciler; never dispatches), resume stuck compensations
(one that cannot be resumed — e.g. its adapter is gone — is logged and stays `compensating`; it never blocks the
recovery of the run's work),
then take the run lease (a live foreign owner ⇒ `unavailable`, retryable), then requeue claimed/running items not
leased by this worker — or leased by a previous process of this worker (claims this instance never issued) — and
re-take the claims of waiting items (new fencing tokens). Requeues count attempts (`maxWorkAttempts`). A pass that
recovered anything appends ONE audit event `run.recovered` (actor `system:control:<worker>`): `{workerId, operations:
{examined, verified, notApplied, manualReview, stillPending, compensated}, requeued: [{workItemId, role, from,
attempts, to}], reattached: [{workItemId, role, waitingOn, fencingToken, claim: kept|retaken}]}` — a waiting item still
leased by this worker id but whose claim an EARLIER process issued (a restart of the same worker) is re-attached with
its claim kept; a pass with nothing to recover records nothing. `work.requeued`, `operation.reconciled` and
`run.recovered` form the recovery log of the report ("recovery by <worker>: reconciled …; re-runs … — orphaned by the
previous process; re-attached <item> (<role>) to <operations> — still waiting, nothing re-created").

**cancelRun** — the run is set `cancelled` FIRST (ticks, reactions and executeTurn stop acting on it), then every
active/waiting agent is interrupted (children of already settled parents included), then open work is cancelled and its
leases/claims released. Idempotent: a retried cancelRun of a cancelled run completes an interrupted sweep.

**Domain tools** (effect `record`, pure reads `read`; risk low; resource `run/<runId>/<area>`; domain schemas;
refusals are failed tool results, faults propagate). **Replay-safe**: a call re-dispatched with the same invocation id
(crash after its effect, before the call settled) returns the first execution's result — plan ids, claim ids,
experiment ids and new test-artifact ids derive from the invocation id; records dedupe on (agent, work item, type,
payload, evidence, superseded record); a pending approval request of the agent with the same kind/subject/rationale is
returned. **Gate inputs are governed** (C2/C7 read them): evidence-first findings (product/security/performance need ≥1
evidence id; every cited id must exist in this run; symptom fingerprint dedupe; `updatesRecordId` supersedes the
head); `confirmed` and the resolving statuses `rejected`/`accepted_risk`/`verified_fixed` only by rca/reviewer/lead
(`CONFIRMING_ROLES`), resolving also only with evidence; lowering a severity or reclassifying a
product/security/performance finding: confirming role + evidence; `duplicate` needs `duplicateOf` naming an
unresolved finding of this run at least as severe (the defect stays represented); closing an open risk or lowering its
level must cite evidence. Hypotheses/coverage gaps/risks (level = `riskLevel`)/reviews (reviewer
role + the agent's epoch provider/route; `run`/`decision` subjects count for the gate)/notes; `plan.propose_revision`
(lead; `validatePlan`; valid ⇒ ONE transaction: propose + accept + items with mapped dependencies (ready/blocked) +
cancellations + `currentPlanRevision`; invalid ⇒ recorded rejected with its issues); `work.propose` (not lead;
role ∈ canDelegateTo ∪ {reviewer, rca}; depth + 1 ≤ run maxAgentDepth, so proposals cannot chain; caps; dedupe per
proposer); `system_model.record`; `oracle.get|list` (run's
pinned revisions); `oracle.propose_change` (proposedBy = agent + provider; never approvable by the proposer);
`experiment.define` (subjects from the target, environment from the registry); `test_artifact.register` (content
into the ArtifactStore, digest = sha256, draft, designers' files are `generated`); `test_artifact.validate`
(known-good passed, known-bad failed with ≥1 failed case OF THIS ARTIFACT, mutation killed ≥1 — evidence of this run,
of the right type, about this artifact: its cases matched by exact file path (absolute/relative, pytest module ids),
never a name substring; a record linked by `testArtifactId` counts as a whole only when its cases name no file ⇒
`validated`, else draft with reasons); `evidence.get|query|claim` (a claim is stored in
`ht_claims` only when `resolveClaim` supports it); `delegate` (role ∈ canDelegateTo, depth + 1 ≤ min(role maxDepth,
run maxAgentDepth), child `delegation` item, `pending` with `work:<childId>`); `request_approval`; `complete_work`
(output validated against the item's expected output with `validateJson`; evidence requirements counted on this
item's own evidence; cited ids must exist); `fail_work`.

**validatePlan** (pure, deterministic): proposer is lead; accepted plans < max; unique objective ids and localIds;
known roles, not lead; dependsOn resolves (localId, or existing non-cancelled item not cancelled by this revision; no
self-dependency); acyclic; objectiveIds ∈ proposal; tool patterns ⊆ role allowlist (not role-denied); item budgets ≤
run limits; existing + new items ≤ maxWorkItems; valid expectedOutput schemas; cancellations exist, are not lead
planning work (the proposer's own item included) and are not waiting on side effects. An accepted revision's
transaction takes the run's work-creation lock first.

**Report** — the verdict is the run's FINAL decision (`pending` otherwise; an interim feedback-loop decision is shown as
such, never as the verdict), decision + reasons, findings table (ids, severity, status, evidence), risks, claims with evidence ids
and provenance completeness for critical claims (`provenance.traceClaim`), plan evolution, work items by role, model
routes per role from the epochs (turns), evidence count/root/seal (verified), recovery log.

## Invariants and where they are proven

| Invariant | Test |
|---|---|
| I1/I8 test-change governance before any write: weakened assertion ⇒ approval, file unchanged; deleted test ⇒ forbidden + `policy.decided`; new test file / commit allowed; refusals never reach the ToolRuntime | `test/test-governance.test.ts` |
| I8 bypasses closed: `test/../src` and symlinked test paths classified as product code; a command (`shell.exec sed`) that weakens an assertion or patches tracked product code quarantines the worktree (no test run / completion until restored; restore lifts it; a crash-replayed call is judged against its first pre-state) | `test/test-governance.test.ts` (I8 bypass attempts), `test/drift.test.ts` |
| I8 generated tests need proven sensitivity (exact file matching, the artifact's own failing case); conditional changes reset validation; artifacts materialized into later worktrees | `test/test-governance.test.ts`, `test/domain-tools.test.ts` |
| I7 gate inputs governed: findings cannot be resolved/downgraded/reclassified/duplicated away without authority + evidence; risks closed/lowered only with evidence | `test/record-governance.test.ts` |
| I5 replayed tool calls (same invocation id) never duplicate plans, work, experiments, approvals, claims or records | `test/record-governance.test.ts` |
| I3 a plan cannot weaken a role's routing policy (reviewer independence, quality floor, privacy class) | `test/robustness.test.ts` |
| I2 delegation children are attenuated from the parent's recorded capability | `test/worker.test.ts` (delegation) |
| I4 fencing: stale token ⇒ `lease_lost` with no writes; a reassigned worker's tool calls are refused; the new owner continues; settled results adopted after a crash | `test/scheduler.test.ts` |
| I4 waiting on external operations: observed, never re-dispatched; recover reconciles first, takes over orphaned claims with new tokens (other worker, restarted process) | `test/operations.test.ts` |
| Recovery audit: a recovery pass is recorded (run.recovered) and explained in the report — re-runs and waiting items re-attached by a restarted process of the same worker; nothing recorded when nothing was recovered; idempotent per process | `test/operations.test.ts` › recovery is auditable |
| I8 independent approval is possible: test-change and `request_approval` requesters carry their model provider; a same-provider agent is refused, an independent agent (other provider and role) may approve | `test/test-governance.test.ts` › weakening an assertion needs approval, `test/domain-tools.test.ts` |
| I5 duplicate delivery ⇒ one reaction (bus handler twice, bus + catch-up, in-process bus duplicate injection, two workers on PostgreSQL) | `test/reactors.test.ts`, `test/postgres.int.test.ts` |
| I7 gate: signed decision bound to the sealed root; evidence gaps ⇒ inconclusive; feedback loop bounded to 2 evaluations | `test/control.e2e.test.ts`, `test/lifecycle.test.ts` |
| I10 audit: every model route, tool call and gate decision reconstructible from L0 alone; causal chain finding → reaction | `test/control.e2e.test.ts` (audit) |
| I11 manifest pinned at start (`ht_manifests`) | `test/lifecycle.test.ts` |
| I12 bounded decentralization: concurrency, resource claims (renewed while waiting), maxPerRun (exact under concurrent deliveries on PostgreSQL), causal depth, work-item cap, turn/tool-call/token budgets, wall clock, max plan revisions, poison items (maxWorkAttempts), final spawn refusals, proposal depth | `test/scheduler.test.ts`, `test/reactors.test.ts`, `test/lifecycle.test.ts`, `test/context.test.ts`, `test/operations.test.ts`, `test/robustness.test.ts`, `test/postgres.int.test.ts` |
| Exhaustion is never declared on transient reservations; the gate is not re-evaluated when no replan can follow; interim decisions are never reported as the verdict; items ended mid-turn / runs cancelled mid-sweep; late reactions on ended runs; duplicate concurrent executeTurn; invalid budget caps | `test/robustness.test.ts`, `test/lifecycle.test.ts` |
| I10 dispatcher-level refusals are `tool.denied` events (approval/forbidden governance, quarantine, budget) | `test/test-governance.test.ts`, `test/lifecycle.test.ts` |
| Recovery is not blocked by an unresumable compensation | `test/operations.test.ts` |
| Evidence-first domain tools (unevidenced defects, unknown evidence, role-gated confirm, completion evidence requirements) | `test/worker.test.ts` |
| Plan IR validation (each issue), plan acceptance with mapped dependencies, rejected plans create nothing | `test/plan-validator.test.ts`, `test/worker.test.ts` |
| Durable idempotency (`expectedTurn`), single run-lease owner under concurrent ticks | `test/context.test.ts`, `test/postgres.int.test.ts` |
| Full product loop: plan v1 (parallel analysts) → drain replan v2 (executor, real node:test in a git repo) → finding → RCA + TestDesigner via reactors → v3 readyForGate → verdict fail; report | `test/control.e2e.test.ts` |

## How to run

```bash
npx tsc -p packages/control --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package control                            # PGlite (+ PostgreSQL int test)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package control # every test on PostgreSQL 16
```

`test/harness.ts` builds the whole real stack (collab, operation, evidence with an Ed25519 signer, policy engine +
decision log + approvals + oracle governance + QualityGate, model router over `ScriptedProvider`s, context snapshots/
freshness/working context/experience/provenance, ToolRuntime with the built-in and domain tools, runtime sessions/
epochs/subagents/runner with the NativeEngine, the built-in role catalog) on one migrated database. Scripted brains are
keyed by the header line (`roleRouter`), `drive()` is a minimal durable loop (tick → executeTurn until terminal →
observeWaiting). `test/fixture.ts` is a git repo with a seeded pricing regression and its human-approved oracle.
`*.int.test.ts` skips with a reason when `HYPERTEST_TEST_PG_URL` is absent.

## Contract changes (additive, backward compatible)

- `ControlPlane.executeTurn(workItemId, fencingToken, signal?, options?: ExecuteTurnOptions)` with
  `ExecuteTurnOptions.expectedTurn?`.
- `ControlPlane.close?(): Promise<void>` (unsubscribes the reactors from the bus).
- New named type `ExecuteTurnOptions`.
- (review) `ControlConfig.maxWorkAttempts?` (deps.ts, default 5); `AgentHostSpec.quarantine?` / `WorkspaceQuarantine`,
  `AgentHostSpec.guard?`, `ControlStore.setQuarantine` / `setGuard`; `Scheduler.requeue`; `WorkFactory.lock`; `createAgentWorker(deps, config, hooks?)`;
  new exports `classifyDrift`, `quarantineLifted`, `QUARANTINE_BLOCKED_TOOL_IDS`, `diffSections`, `invertSection`,
  `sectionPaths`, `tightenModelPolicy`, `RESOLVING_FINDING_STATUSES`. No change to `src/contracts.ts`.
- (eval integration, behaviour) `recover()` appends `run.recovered` (domain `EVENT_TYPES.runRecovered`) and the
  report's recovery log renders it; test-change / `request_approval` requesters record `modelProvider`. No change to
  `src/contracts.ts`.

- (hardening) `ControlPlane.tick(runId, options?: TickOptions)` with `TickOptions.maxDispatch?` (H6: dispatch no more
  claims than the caller has free executor slots); optional `ControlPlane.renewClaim?(workItemId, fencingToken)`
  (keeps a dispatched claim alive while it waits for an executor slot; `false` once the claim or its admission is
  lost); `TickResult.dispatched[].nextTurn?` (durability-9: the first `executeTurn` of a claim names its turn). New
  exports `claimLeaseOwner` (H4: gateway lease owner `<workerId>:<workItemId>:<fencingToken>`), `testOutcomeEventId`
  (H5), `claimFenced` (H4: non-read domain tools re-check the claim token inside their transaction and answer
  `lease_lost` to a superseded worker), `assertRunPinned`, `gateSpecProblems`, `runReviewRequestEventId`.
- (hardening, behaviour) I11: `tick`/`executeTurn`/`observeWaiting`/`recover`/idempotent `startRun` refuse a run pinned
  to another runtime manifest (`precondition_failed`), and a turn refuses an engine whose version differs from the
  manifest (H2). `startRun` validates `gate` overrides (`invalid_argument`, H3). Reviewer independence counts every
  `EVIDENCE_PRODUCER_ROLES` role. H7: before the QualityGate of a run that requires independent review, control
  emits one `review.requested` for the run (`subjectRef { kind: 'run' }`, deterministic event id per gate attempt);
  runs without a reviewer subscription are unchanged. H9: capability environment classes are the role profile's ∩
  the registered environments' classes (∪ `local`). Admission is audited: `admission.granted` / `admission.refused`
  (once per distinct conflict) / `admission.lapsed` (a lapsed resource claim yields the work claim back to `ready`
  without consuming an attempt; the turn answers `lease_lost`, durability-2). A paused run yields its claims
  (H13). Turn snapshots pin every other registered environment and the input findings' lineage heads
  (conformance-3). `recover()` releases the side-effect leases of superseded claims before reconciling.
  `plan.propose_revision` replays and validates inside one locked transaction (no duplicate revision). Test outcome
  events and budget charges are keyed by the invocation id (H5).
- (hardening, behaviour) durability-7: a waiting item fails (`budget_exhausted`, naming the still unsettled
  operations, which stay in the ledger for reconciliation) once its `maxWallClockMs` or the run's wall clock passed —
  an operation that never settles no longer keeps the run from its gate. durability-8: `cancelRun` runs under the
  tick mutex and changes the run status under the work-creation lock; `WorkFactory.create` refuses work for an ended
  run (`conflict`); the sweep re-reads and cancels an item another process moved meanwhile. durability-1: `recover()`
  releases the open budget reservations of the claims it supersedes (`BudgetLedger.releaseOpen`). durability-11: the
  per-process claim bookkeeping forgets ended claims and ended runs (`ControlPlaneInternals.bookkeeping()` reports its
  size). conformance-4: the gate input names the current approved revision of every pinned oracle. conformance-5:
  `load.start` above the run's `maxExternalQps` is denied (`external_qps_exceeded`) before it runs. conformance-9: the
  report shows the deciding gate (`**Gate:** <gateId> (spec <digest>; overrides …)`). conformance-10:
  `test_artifact.validate` binds a validation to what ran — a changed copy of the artifact's file in the evidence's
  `workspaceDelta` must be the registered content, and known-good / known-bad must have run on different code
  (`TestValidation.codeDigest`, domain, additive). conformance-11: the gate input's `exceptions` are the run's
  approved `gate_exception` approvals (they were hard-coded empty).

## Notes for integrators

- Register the domain tools (`createDomainTools(deps)`) before computing the RuntimeManifest's
  `toolCatalogRevision`; `createControlPlane` registers only missing ones.
- `executeTurn` throws `HypertestError('cancelled')` for a plain abort (the activity was cancelled); the turn replays
  on the next attempt. Explicit interrupts (cancelRun) end the item as `cancelled`.
- The dispatcher passes the work claim to the ToolRuntime (`leaseOwner = claimLeaseOwner(...)`, `claim`), so a
  side effect's gateway lease is owned by the claim that issued it; a superseded claim's leases are released by
  `recover()` before its operations are reconciled.
- The post-execution drift guard costs two `workspaces.diff` calls per execution tool in a writable worktree (one
  `git diff --no-index` per untracked file): keep build outputs git-ignored in target repositories. A command that
  rewrites a TRACKED file (e.g. `npm install` updating a committed lockfile) quarantines the worktree until the file is
  restored (`git checkout -- <file>`): the evidence must be about the candidate as committed.
- Only rca (among the roles holding `blackboard.post_finding`) may resolve findings; nobody in the built-in catalog
  can mark `verified_fixed` except rca (with evidence).
