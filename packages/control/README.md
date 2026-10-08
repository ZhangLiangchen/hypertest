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
| `controlMigrations` | `control/001-control`: `ht_manifests`, `ht_run_gates`, `ht_reactor_cursors`, `ht_claims`, `ht_replans`, `ht_agent_hosts`; `control/002-governance`: gate authority columns of `ht_run_gates`, `ht_delegations` (PGlite + PostgreSQL 16). |
| `validatePlan(input)` | Pure Plan IR validation (see below). |
| `createScheduler`, `createReactorService`, `createConvergenceMonitor`, `createAgentWorker` | The parts (exported for durable runtimes and tests). |
| `createDomainTools(deps)` | `blackboard.*`, `plan.read`, `plan.propose_revision`, `work.propose`, `system_model.record`, `oracle.get|list|propose_change`, `experiment.define|stop`, `test_artifact.register|validate`, `evidence.get|query|claim`, `delegate`, `delegate.status|collect|message|release`, `request_approval`, `complete_work`, `fail_work` — exactly `DOMAIN_TOOL_IDS` of `@hypertest/agents`. |
| `createPhaseGovernor(deps, config)` | BUGate time points evaluated by the control plane: `afterAction`, `beforeTransition`, `beforeAcceptance`, `flaggedActions` (see below). `TOOL_EVIDENCE_TYPES` / `declaredEvidenceTypes`, `POLICY_FLAGGED_EVENT`, `flagEventId`. |
| `workItemConstraint`, `unmetRequirements`, `describeUnmet`, `requirementProblems`, `addressesEnvironments`, `ENVIRONMENT_FREE_NAMESPACES`, `BASELINE_EFFECTS`, `CAPABILITY_REQUIREMENT_SCHEMA` | I2: the work item's share of parent ∩ role ∩ work item ∩ environment, and the report of what exceeds the grant. |
| `gateWeakenings(base, effective)`, `EXECUTION_EVIDENCE_TYPES`, `authorizedGateWeakenings(reference, effective, recorded)`, `gateReference`, `GATE_AUTHORITY_KINDS` | conformance-9: the fields in which a run's gate is weaker than its base (DEFAULT_GATE_SPEC ⊕ config), and which of them a recorded human/system authority covers (the gate path and the report judge alike). |
| `inputWaitOperationId`, `parseInputWaitOperationId`, `isAwaitingInput`, `delegationSettled`, `delegationChatMessage`, `unreadMessages` | Background / continuable delegation helpers. `PLAN_PROPOSAL_INPUT_SCHEMA`: the plan tool's input (domain schema + `capabilityRequirements`). |
| `createReportBuilder(deps)` | `RunReport` with markdown + json. |
| `createToolDispatcher`, `createContextProvider`, `condenserSummarizer`, `agentHeader`/`parseAgentHeader`, `unifiedDiff`, `WorkFactory`, `ControlStore` | Building blocks of the EngineHost and the stores (exported for reuse/tests). |
| `classifyDrift`, `quarantineLifted`, `diffSections`, `invertSection`, `sectionPaths` | Post-execution test-change governance of execution tools (see ToolDispatcher). |
| `tightenModelPolicy(role, item)` | The effective model policy of a work item's agent: the role's policy tightened, never weakened, by the item's. |
| `declaredExperimentIds`, `runExperimentIds`, `heldClaims`, `experimentClaimsProblem`, `experimentResourceProblem`, `experimentEffectsRunning`, `resourceAliases`, `syncExperimentClaims`, `releaseRunIsolation`, `releaseStrandedReservations`, `settleExternalQps`, `qpsKey`, `qpsInvocationId`, `qpsJobMayRun`, `onToolBudgetExhausted`, `experimentIsolation`, `defaultStopConditions`, `defaultContaminationRules`, `EXPERIMENT_GUARDED_EFFECTS`, `EXPERIMENT_EXEMPT_TOOLS`, `EXPERIMENT_COVERED_PREFIXES`, `FAULT_TOOLS`, `QPS_KEY_PREFIX`, `QPS_REASON_PREFIX` | Unit B2: experiment isolation (conformance-6) and budget leases (conformance-5) — see "Experiments and budget leases". |
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
{tokens, costUsd?, toolCalls, workItems, computeMs?, artifactBytes?, externalQps?} (+ `budget.reserved`), and the lead `initial_plan` work item (objective =
goal + target + instructions for Plan v1; role budget; lead output schema). Retrying with the same `runId` returns
the stored run. Budget caps are validated (`invalid_argument`): counts/limits are integers ≥ 1 (`maxAgentDepth` ≥ 0),
optional cost/compute/QPS/bytes finite ≥ 0 — a zero concurrency or work-item cap would only stall the run.

**Gate override authority (conformance-9)** — `startRun` compares the effective gate with its base
(`DEFAULT_GATE_SPEC ⊕ config.defaultGate`; the default gate when the configured one is unusable): `gateWeakenings`
names a lowered `failOnUnresolvedSeverity`, a raised `conditionalOnRiskLevel`, a disabled
`requireDeterministicForCritical` / `requireIndependentReview` / `requireOracle`, a lowered or removed coverage
threshold, and required evidence no longer required (a bipartite matching: every base requirement needs a distinct
effective one with ≥ its `minCount` and the same type, or both deterministic execution evidence types — so a black-box
run may require `api-response` / `metric` instead of `test-result`, but not `stdout`). A weakening needs
`gateOverrideBy` (human or system `ActorRef`) + `gateOverrideRationale`: missing ⇒ `invalid_argument`; an agent
(`kind: 'agent'`, or a call whose event context names an `agentId`) ⇒ `permission_denied`; nothing is written. The
base, the weakened fields and the authority are stored with the gate (`ht_run_gates`), emitted as
`gate.override_authorized` and bound into every decision of the run (a reason line inside the signed content,
`gate.evaluated.gateOverrideBy`, the report's `Gate override authority` line). At the gate the effective gate is judged
again (`authorizedGateWeakenings`) against the recorded base — the configured base when no base is on record — and a
weakening the recorded authority does not cover withholds the verdict (`gate.override_authority`, see holds below): a
gate row written around `startRun`, an authority record that is not a human/system actor with a rationale, or a gate
weakened beyond the weakenings the authority was given for.

**BUGate time points (technology-selection §BUGate)** — the ToolRuntime evaluates `before_action`; the control plane
evaluates the other three through `createPhaseGovernor`, each decision recorded in the policy decision log (request +
permit + policy revision: replayable) and emitted as `policy.decided` with its `phase`:
- `after_action` (dispatcher, every executed call with an outcome to judge — it wrote or cited evidence, or its tool
  declares evidence types; bookkeeping calls that touch no evidence are not judged): the request the call was
  authorized with, plus
  `outcome` = the types of the evidence the call wrote vs the types its tool declares (`ToolSpec.evidenceTypes` when a
  spec carries it, else `TOOL_EVIDENCE_TYPES`; domain, `mcp.*` and every other undeclared tool declare none — fail
  closed: a deployment tool that records evidence must declare its types; `tool-output` is implicit). A call is judged
  whatever status it reports once it wrote evidence (a tool that reports `denied` after writing is judged too). A
  non-allow permit FLAGS the call: `policy.flagged` (one per invocation), a note in the tool result. A failed check
  flags the call (fail closed), it never re-runs it.
- `before_transition`: `work_item:completed` in `complete_work` (refused ⇒ `policy_denied`, the agent may fail its
  item) and again at the transition itself when the item has flagged calls (a call of the completing turn dispatched
  after `complete_work` is judged there: refused ⇒ the item fails `policy_denied`, a continuable task does not settle), `plan:accepted` in `plan.propose_revision` (refused ⇒ the revision is rejected with the policy's reasons),
  `run:gating` at every gate attempt (the run is gated regardless — the scheduler keeps convergence authority — but a
  refusal withholds the verdict). Facts: subject, from/to, the subject's flagged calls, requester, details.
- `before_acceptance`: `acceptanceFacts` (policy) — the gate input digest (evidence counted by type, never payloads;
  findings, risks, reviews, work items by state, claims, oracle revisions, gate overrides and their authority, flagged
  calls) and the deterministic verdict. A refusal withholds the verdict.
- A withheld verdict (`applyPhasePermit` / `withPolicyHold`): pass/conditional/inconclusive ⇒ `inconclusive`, fail
  stays fail, `requiresHumanReview`, the hold is an unknown criterion (`policy.before_transition`,
  `policy.before_acceptance`, `gate.override_authority`); applied before signing. Never `pass`.
- Default rules (policy `DEFAULT_POLICY_RULES`): after_action allows and flags undeclared evidence; transitions are
  allowed except the completion of a work item with flagged calls; acceptance is allowed except a run with flagged
  calls (approval_required). Non-action requests carry a short-lived signed system capability (subject
  `system:control:<workerId>`, `record` on `run/<runId>/**`, tool `transition.<subject>` / `gate.accept`). OPA receives
  the phase and the facts in its input.

**Capability grant (I2)** — an agent's capability is parent (or the root profile) ∩ role ∩ WorkItem.capabilityRequirements
∩ environment policy (registered environment classes ∪ `local`). With requirements, the work item's constraint is the
least flat capability covering them plus the baseline every agent needs (read/record, its own workspace and the run's
records): effects = baseline ∪ required, scopes = baseline ∪ required, classes = the named ones (if any, and unless a
requirement without a class may address environments — its scopes reach beyond `workspace/…` and `run/…` — which asks
for every class the other operands allow; a classless requirement is never silently confined). Requirements
beyond the grant are never granted; the missing part (effect, scope — with the part that was granted — or class) is
listed in the agent's task message (`## Capability requirements NOT granted`) and on L0
(`capability.requirements_unmet`). A root grant is narrowed in place (no parent id); a child is attenuated from its
parent's recorded capability. Requirements come from plans (`plan.propose_revision` accepts `capabilityRequirements` per
work item; malformed ones reject the plan) and from `delegate`.

**Delegation (subagents)** — `delegate` creates a child work item (+ an `ht_delegations` row, one transaction). By
default the parent waits (`pending` on `work:<child>`). `background: true` returns the child id at once; the parent
keeps working, reads the child with `delegate.status` / `delegate.collect` (the result channel only: summary, output,
cited ids, failure — never the transcript) and gets an inbox note (`[delegation <id> (<role>) completed] …`) when a task
ends. `continuable: true`: after `complete_work` the child's item waits on `input:<child>` with its task result recorded
(a foreground parent waiting on `work:<child>` resumes then); `delegate.message` queues a follow-up (the child's session
inbox via `SubagentRuntime.message`, or its initial messages when it has not started; retry-stable message id);
`observeWaiting` of the waiting child resumes it (`SubagentRuntime.resume`) when a message is unread, and completes it
with its last result (agent disposed) once released — by `delegate.release`, by the parent's work item ending
(`tick` auto-release, `delegation.released` `auto: true`) or by its wall clock. Refusals: a child of another work item
(`not_found`), messages to non-continuable / released / ended children (`precondition_failed`), releasing a
non-continuable child (`invalid_argument`). Depth and count caps are unchanged; a background child's crash is
recovered like any work item (requeue, new fencing token, same agent and session).

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
`WorkFailureReason`); waiting ⇒ `running → waiting` (`waitingOn`); boundary retry ⇒ continue; budget ⇒ see **Model
budget boundary** below; model_unavailable ⇒ PAUSE (a transient unavailability: the item waits on `model:<agentId>`,
L0 `work.paused` pauseReason `model_unavailable`, resumed by `observeWaiting` after the pause's resumeAt — durable in
the local and Temporal runtimes, which poll waiting items — or by an operator resume; bounded by the item's and run's
wall clock) or failed closed with the exact reason (no configured route may ever serve the role); an explicit
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
full input records, Relevant code (every role, `retrieverFactory(root)`), Skills (published only), Evidence of this
item, Durable memory (approved experience), Oracles, Available tools — each with its own token budget
(`SECTION_BUDGETS`; see "Context and learning" below); the L2 view (`maxInlineContextTokens` or route window × 0.6). **HARD** pressure ⇒ mandatory
condensation: LLM condenser (role `condenser` through the router; deterministic summarizer on any failure; its call is
charged to the run budget with its tokens AND its USD cost) ⇒ `sessions.addCompaction` ⇒ `context.compacted` (with its
level). **SOFT** pressure ⇒ deferrable condensation, only when
`softCondensationDue` (≥ keepRecentTurns + 2 turns since the last cut) and only through the LLM condenser
(`condenserSummarizer(…, { fallback: false })`) within `SOFT_CONDENSE_TIMEOUT_MS` (60 s): any failure (no route, a failed
or empty answer, nothing to condense, the deadline) defers it — the turn goes on — and records
`context.condensation_deferred` `{sessionId, turn, retryTurn, reason}` on L0; the session's next soft attempt waits
until `retryTurn` = turn + keepRecentTurns + 2 (the back-off is read from L0 because the provider is rebuilt every turn).
The turn's snapshot **read set** (`observedReadSet` + the agent's observations): every registered environment, the
lineage head of each input record (`finding` for findings), the live side-effect leases of in-flight operations the
current claim owns, and — through the app's observing ToolRuntime and the snapshot builder's `observer` — what the agent
observed through its tool calls (files read or written, blackboard records read or posted, one metric window per
target, environments it addressed; context README). Findings and environments are always re-checked, so after another
agent supersedes an observed finding or redeploys an observed environment every mutating action of the agent is
`stale_context` until it observes that resource again (`blackboard.read {lineageId}` or a list query refreshes a
finding pin; `{recordId: <lineageId>}` returns the lineage's first version).

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

## Model budget boundary

The model invoker reserves the calibrated input estimate + the output reserve (see `@hypertest/runtime`); a refusal
carries the ledger's typed refusal, so the worker knows WHICH scope and dimension refused:

- **Fit before refusing.** The worker's context wrapper measures the remaining run/work budget (tokens, and USD priced
  on the agent's current route) before each assembly: the working view's SOFT/HARD condensation thresholds are
  relative to `min(context window budget, what the budget can still pay for)` (the prompt/tool overhead measured at the
  session's previous assembly subtracted), and a turn that still does not fit is condensed again with the exact cap
  BEFORE the model call (`context.budget_condensed`, plus the usual `context.compacted`). The invoker shrinks the
  call's output reserve to what remains (≥ `minOutputTokens`), and under budget pressure switches to a cheaper eligible
  route (`cost` epoch).
- **Work-scope refusal** (the item's own budget): agent + item failed `budget_exhausted` with the exact message.
- **Run-scope refusal while other calls hold reservations** (`used + requested ≤ limit`): contention, not exhaustion —
  the item waits on `budget:<runId>` (L0 `work.paused`, pauseReason `budget`, `contention: true`); `observeWaiting`
  resumes it when the room is back (`work.resumed`); if the other calls settle without freeing room the exhaustion
  policy applies (under `'pause'` the run pauses once and the item's pause is recorded as a run pause — `work.paused`
  `runPaused: true` — so a resume without room ends the item with the exact reason instead of pausing again).
- **Run-scope exhaustion**: L0 `budget.exhausted` `{ scope: run:<id>, reason: model_tokens | model_cost, dimension,
  limit, used, requested, remaining, reservedByOthers, routeId, neededTokens, neededCostUsd }`. Under
  `onBudgetExhausted: 'pause'` the item is NEVER failed: it waits on `budget:<runId>` with its agent and session, and the
  run pauses (`pauseReason: 'budget'`); after an operator raised the limit and resumed, `observeWaiting` resumes the SAME
  agent; resumed without room, the item fails with the exact reason ("the run was resumed but its budget still has no
  room …") and the gate decides. Under `'gate'` the item fails with the exact reason and convergence gates the run —
  limit: the convergence monitor (another unit's `convergence.ts`) reads only `model_tokens` refusal markers, so a
  run-scope USD exhaustion (`model_cost`) reaches the gate through the replan livelock guard instead of
  `exhausted (budget)` (or once `used ≥ limit`).

## Experiments and budget leases (unit B2)

**experiment.define (conformance-6)** — records the environment the experiment runs against (the authoritative
generation — `EnvironmentRegistry.load` when present —, build digest, `topologyRef` from the environment's control
target), subjects, the workload and fault plan, `fixtures` (deduplicated), `randomSeeds` (one is generated —
`sha256(runId, invocationId, 'seed')[0..16]`, retry-stable — when none is given), `stopConditions` (default: the
workload's duration; a manual stop for open-ended load or faults), `contaminationRules` (default: the admitted claims,
admission-enforced while held) and its isolation. Isolation defaults (`experimentIsolation`) derive from what the
experiment does to `env/<environmentId>` (the key black-box tools act on): a fault plan ⇒ `fault_exclusive`, a workload
or an exclusive / dedicated mode ⇒ `write_exclusive`, else `read_shared`; declared claims must cover it (a fault plan
needs a `fault_exclusive` claim, a workload a write/fault claim, `shared_readonly` holds only `read_shared` claims)
— else `isolation_insufficient`, nothing admitted. The claims are then admitted ATOMICALLY through ResourceAdmission
with holder = experimentId (compatible with the defining work item's own claims): a conflict refuses the experiment
(`resource_conflict`, structured `{ admitted: false, holders, conflicts }`, `admission.refused` aggregate `experiment`)
— it is NOT created (no spec, no `experiment.defined`, not on the run). Admitted ⇒ `admission.granted` (aggregate
`experiment`, a deterministic event id: recorded once); a save that fails releases the claims (unless the experiment
exists after all: a save that failed after its commit, or cannot be checked — then they are kept). Once the experiment is
saved it keeps its claims whatever fails afterwards (they follow its owners); a replayed call returns the recorded
experiment and completes what the failed call left undone (the run's `experimentIds`, `admission.granted`).

**Claims follow their owners** — the owners of an experiment are the work item that defined it and every work item of
the run that declares it (`inputRefs` kind `experiment`). Every tick (`Scheduler.syncIsolation`, before admission)
renews the claims (TTL `leaseTtlMs`; compatible with the owners' own claims) while an owner is not terminal — or an
operation recorded for the experiment may still act (`experimentEffectsRunning`: e.g. its load job outlives the item
that started it; an unreadable ledger counts as running) — and releases them once none is (`admission.released`, reason `owners_ended`) or the run ended (`run_ended`: the gate's
final tick, `cancelRun`, and every later tick of a finished run — idempotent). A renewal refused by another holder is
recorded once per conflict set (`admission.lapsed`, aggregate `experiment`, phase `experiment_renewal`). A paused run
is not ticked: its claims lapse after the TTL and are re-admitted (if still free) when it resumes. Work-item
admission (scheduler, heartbeat renewal) treats the claims of the item's declared experiments OF ITS RUN as compatible
(`runExperimentIds`) — an item that runs for an experiment is never refused by it; naming another run's experiment
shares nothing.

**Write/fault tools need the claims held** — the dispatcher resolves the experiments a work item runs for (declared +
defined by its agent). A call whose effect is `external` or `destructive` (http non-GET, load.start, env.*, browser
clicks, MCP) is refused `experiment_claims_missing` (a `tool.denied`, never executed) when an experiment is unknown to
the run, holds no write/fault claim (`env.inject_fault` needs `fault_exclusive`), or its claims are not all held right
now (lapsed, released, taken). Held claims license a write/fault call only on what they claim: every SUT resource of
the call (`env/…`, `url/…` keys, `EXPERIMENT_COVERED_PREFIXES`) must be covered by a claim of one of the item's
experiments (same key or an ancestor; `fault_exclusive` for a fault tool, else `write_exclusive`/`fault_exclusive`),
else `experiment_claims_missing` — a claim on `service/payment` does not license `env.inject_fault` on `env/svc`. A
`url/<host>` resource also names every registered environment one of whose URLs has that host (`resourceAliases`):
covered by a claim on that environment, and conflicting with one (no alias bypass).
And no work item — one running for an experiment or not — writes to or faults a resource a live claim of ANOTHER
experiment overlaps (any mode, any run): `experiment_resource_conflict`, naming the holder (the recorded contamination
rule, enforced; checked against the live claims at call time — `experimentResourceProblem`). `load.stop` is exempt (it
only ends an effect). When the item runs for exactly one experiment of its run, every call names it
(`ToolExecutionRequest.experimentId`); an item running for several names, on a write/fault call, the one experiment
whose claims cover it. Its evidence carries `provenance.experimentId` and its operations `experimentId`, so the gate
can judge experiment validity.

**Budget leases (conformance-5)** — the run scope carries `computeMs` (`maxComputeMinutes` × 60000), `artifactBytes`
(`maxArtifactBytes`) and `externalQps` (`maxExternalQps`). Before a non-terminal call the dispatcher reads the headroom
(`BudgetLedger.remaining`): an `execute` tool with no compute left is refused `budget_exhausted` before it runs (else
its timeout is capped at the compute left); the call's artifact puts are bounded by `limits.maxArtifactBytes`, and
with no artifact headroom left a write/fault call (effect `external`/`destructive`, except `load.stop`) is refused
`budget_exhausted` before it acts (its evidence could not be stored: an unevidenced side effect and a retry of it). After
the call, its metered usage (`ToolExecutionResult.usage`: sandbox wall time, distinct stored bytes) is recorded on
`work:<id>` and the run (`BudgetLedger.consume`: in full, never refused). An exhaustion — recorded, pre-checked, or a
refused put — is typed: `budget.exhausted` `{ scope, dimension, limit, used, reserved, requested, reason:
compute | artifact_bytes | external_qps, toolId, invocationId }` and a note to the model; a RUN-scope exhaustion pauses
the run under `onBudgetExhausted: 'pause'`, and under `'gate'` the convergence monitor reports `budget` (it now checks
`computeMs` and `artifactBytes` too): pending work is cancelled, the gate decides — never a silent downgrade.
`load.start` reserves its `ratePerSecond` as `externalQps` (key `qps:<invocationId>`, reason `load:<invocationId>`,
idempotent for replays — a replay whose reservation was already given back reserves again under `qpsKey(id, n)`, so a
job never runs on a released rate) against
the run's `maxExternalQps` across all concurrent jobs: a job that does not fit is refused `external_qps_exhausted`
(transient: never exhausts the run). The rate is released when the call started no job (not applied, denied, failed
without an operation), when `load.stop` verified the stop, when `load.observe` or the tick's sweep finds the job's
operation settled (verified / failed / not_applied / compensated), when its work item ended without a job, and when
the run ends; an operation in `manual_review` keeps it (the job may run). A call that throws keeps the rate while its
job may run (`qpsJobMayRun`: an operation recorded and not ended, or the ledger unreadable). `recover()` releases the open reservations of
a claim taken from a dead worker (durability-1) EXCEPT these QPS reservations (`releaseStrandedReservations`): the
external job outlives its worker (recovery re-attaches it), so its rate stays reserved until the job ends.

## Gate governance (unit gate-governance)

**Experiments govern every write, load and fault (D-3/D-4)** — a call whose effect is `external` or `destructive`
(except `load.stop`) needs an experiment of its work item: none ⇒ `experiment_required` (a resource another experiment
holds is named first: `experiment_resource_conflict`); several, none of which alone covers the call ⇒
`experiment_ambiguous`. The attributed experiment must be ACTIVE (`experimentActionCheck`): not stopped
(`experiment.stop`, or a stop condition — duration since its first action, `error_rate_above`, `metric_threshold` —
evaluated deterministically on its evidence and ledger operations before the call and then recorded once,
`experiment.stopped`, deterministic id) ⇒ `experiment_stopped`; inside its plan (a fault in its fault plan, load within
its workload) ⇒ else `experiment_plan_violation`; inside its budget (`maxWallClockMs` since definition, `maxToolCalls`
charged on the scope `experiment:<id>` under the run's; `maxExternalQps` reserved and `maxComputeMinutes` settled on
that scope too) ⇒ else `experiment_budget_exhausted` (`budget.exhausted`, reason `experiment_*`). Each admitted action
is recorded once per invocation (`experiment.action`: kind, target, params, rate, duration, concurrency) — the facts the
gate compares with the plan (C10). `experiment.define` also accepts `budget`; contamination rules beyond the defaults
become admitted claims (`claimsWithRules`: write_exclusive, or read_shared for a read-only experiment); the isolation
records its `plan` (contamination checks; for `dedicated_environment` — refused unless the environment is REGISTERED
dedicated, `environments[].isolation.dedicated` — the dedicated namespace/database/account). An item's own claims and
the experiments its agent defined are mutually compatible (`runExperimentIds` with `agents`).

**Test artifacts (D-0/D-1)** — `test_artifact.register` checks the oracle refs exist, addresses the run's artifact of
the same path (unchanged content ⇒ the current revision, `unchanged: true`, never demoted; changed content ⇒ a new
draft revision, `contentChanged: true`, with a message). `test_artifact.validate` refuses evidence that did not execute
exactly the artifact's file and content (`foreign_evidence`, the policy's `sensitivityBinding` text) and a base-revision
known-good of another base commit; it records static / known-good (or `knownGoodUnavailableReason`) / known-bad /
mutation stages bound to the artifact digest and code; a complete validation requests the oracle consistency review
(`review.requested`, subjectRef `test_artifact`, once per revision) which the reviewer answers with
`blackboard.post_review` (approve ⇒ `approved` + `oracleReview`, never by the creator agent or role, only with oracle
refs in force; reject ⇒ draft; `test_artifact.reviewed`). (Review) A review applies only to the content it was
requested for (`reviewedArtifactDigest`: the revision named by the reviewer item's `review.requested`): a review of
content that changed meanwhile is recorded but not applied, with the exact reason; register / validate / review write
the next artifact revision compare-and-set (`supersedes`), so a concurrent write is a conflict, never a lost update. A
known-good pass on workspace (candidate) code is accepted but reported as `passed (workspace: no P0/P1 support)`. The
dispatcher injects the run's `target.baseCommit` into `test.run` revision `base` (none ⇒ `no_base_revision`) and appends
a precise `[test artifact mismatch: …]` hint when a run executed a registered file whose content changed. `load.stop` is
attributed to the experiment of the job it ends, whoever calls it (C12). `evidence.claim` refuses a critical claim that
states no value with `evidenceQuery.field`, and the report labels each claim `evaluated` or `reference only`.

**Gate input and replanning (D-9/D-10/D-11, coverage-1/-17)** — the gate input carries the run's SystemModel, every
external/destructive operation with its experiment and recorded action (`gateOperations`), admission lapses and stops
(`experimentFacts`), the environments used with their registered generation and dedication (`environmentFacts`), the
data of JSON artifacts cited by claims (`claimData`), superseded findings/reviews and an `invalid` latest oracle
revision. `system_model.record` validates data assets / security boundaries against the declared components and records
the registered environment's build digest. Before every replan decision the run is re-pinned to a newly approved oracle
revision (`repinOracles`: `run.oracle_repinned`, this run's decisions on the old revision ⇒ needs_reassessment) and a
lead replan with reason `oracle_changed` follows (deduplicated; `replan.triggered`). A new unresolved P0/P1 product
finding (`finding.created`/`updated`) schedules one replan with reason `critical_finding`; its event ids are consumed
through the inbox (consumer `lead-replan:critical-finding`), so redelivery never replans twice. Gate feedback now also
covers C10–C12.

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
| I2 parent ∩ role ∩ work-item requirements ∩ environment: seeded property over generated requirements (never amplified, inside each operand, a requirement granted iff the other operands allow it — a classless requirement on environment-addressable scopes in every class they allow —, exact unmet report); a child and a planned root item get no excess and are told what is missing; malformed requirements reject a plan | `test/capability-grant.test.ts` |
| Subagents: background delegation (status, collect, inbox note, no trace), continuable children (message → resume, release, auto-release when the parent ends), refusals, crash/resume of a background child (new token, same agent) | `test/subagents.test.ts` |
| BUGate four time points: undeclared evidence flagged after action ⇒ completion refused ⇒ a verdict the gate alone would pass is withheld (inconclusive + human review); a tool that declares nothing and a call that reports `denied` after writing are judged too; a flagged call dispatched after `complete_work` in the same turn fails the item at the transition; the same run without the forgery passes; operator rules on `plan:*` and `run:gating`; every phase decision logged with its phase | `test/phases.test.ts` |
| conformance-9 gate override authority: weakenings named; missing / agent authority refused; recorded, on L0, signed into the decision, in the report; a weakened gate row without authority, a whole authority record gone, an agent-named record or a gate weakened beyond its authority withholds the verdict | `test/gate-authority.test.ts` |
| Never pass from agent text: success claimed in summary, output, a critical claim, an approving review and the lead's plan while the only test-result failed ⇒ fail (C3) | `test/evidence-verdict.e2e.test.ts` |
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
| Observed read set through the dispatcher: a file another agent changed after the read ⇒ `stale_context` until re-read; `git.show` of the committed version never refreshes the pin; input findings and owned leases pinned; SOFT condensation through the LLM condenser only, deferred on failure with the L0-recorded back-off, HARD still mandatory | `test/context-readset.test.ts` |
| conformance-6 (chaos: two fault experiments compete): admission rejects the second (not created, holder named, audited) — also when both are defined concurrently (exactly one holder); a different service is admitted; recorded environment/fixtures/seed/stop/contamination/default claims; replay admits once; insufficient isolation refused; write/fault tools refused while claims are lapsed/taken/released or the experiment is read-only / unknown / foreign, reads and load.stop still run, calls name the experiment; claims renewed/re-admitted while an owner lives, lapse recorded once, released when owners end or the run ends; same-run items share claims, foreign items do not; (review B2) a write/fault call outside the experiment's claims (another environment, a bare URL, an abstract-service claim for an environment fault) is refused and a covered one is attributed to its covering experiment; a write/fault call on a resource another experiment holds is refused for every work item (also one running for no experiment), reads still run; a failure after the experiment was saved keeps its claims and the replay records it on the run; the claims outlive the owners while the experiment's load job runs (a competing experiment stays refused) and are released when it ends | `test/isolation-budget.test.ts` |
| conformance-5: run scope limits; real sandbox metering charged to work + run; compute headroom caps / refuses execute tools, recorded in full, convergence `budget`; artifact headroom passed as limits, exhaustion recorded; pause policy pauses the run; externalQps reserved across concurrent jobs (typed refusal, transient), released on settle / stop / not-applied / observe / run end; recovery from a dead worker keeps a running job's QPS reservation (a job over the cap stays refused) while releasing its stranded model reservations; (review B2) an execution that throws after its job was dispatched keeps the job's rate, and a replayed load.start whose reservation was already given back reserves again (never a job on a released rate); a spent artifact budget refuses write/fault calls before they act (reads and load.stop still run) | `test/isolation-budget.test.ts` |
| Full product loop: plan v1 (parallel analysts) → drain replan v2 (executor, real node:test in a git repo) → finding → RCA + TestDesigner via reactors → v3 readyForGate → verdict fail; report | `test/control.e2e.test.ts` |
| Gate governance: the D-0 audit scenario on real tools (foreign mutation evidence refused, the insensitive test stays draft, never pass) and the positive path (bound known-bad, base-revision known-good, independent review ⇒ approved, eligible, C3 violated by its failure, contract revisions on the decision); re-registration and the drift hint; manual stop, met stop condition, plan violation, experiment budget, ambiguity; dedicated environments; oracle re-pin + needs_reassessment; critical-finding replan deduplicated by event id | `test/gate-governance.test.ts` |
| Experiment requirement and rule-claims: writes/faults/load without an experiment refused (also after a contamination conflict is ruled out); rule resources admitted as claims (read_shared for read-only experiments); validation refusals of foreign / content-mismatched evidence; system model fields | `test/isolation-budget.test.ts`, `test/domain-tools.test.ts`, `test/test-governance.test.ts`, `test/operations.test.ts` |

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

- (B1 governance completion) `StartRunInput.gateOverrideBy?: ActorRef` and `gateOverrideRationale?: string`
  (conformance-9). **Behaviour:** a run-level `gate` override that weakens the gate relative to
  `DEFAULT_GATE_SPEC ⊕ config.defaultGate` is refused without them (`invalid_argument`) or with an agent authority
  (`permission_denied`); callers that weaken a run's gate (e.g. `gate: { requireOracle: false }` or
  `requireIndependentReview: false` in `StartRunInput`) must now name the human/system authority — configured defaults
  need none. Migration `control/002-governance` (`ht_run_gates` authority columns, `ht_delegations`); `ControlStore`
  gains `putGate(…, authority?)`, `gateAuthority`, `putDelegation`, `delegation`, `delegations`,
  `setDelegationMessages`, `releaseDelegation`. New domain tools `delegate.status`, `delegate.collect`,
  `delegate.message`, `delegate.release`; `delegate` accepts `background`, `continuable`, `capabilityRequirements`;
  `plan.propose_revision` accepts `capabilityRequirements` per work item. New L0 event types (strings, not in the
  domain catalog): `gate.override_authorized`, `policy.flagged`, `capability.requirements_unmet`,
  `delegation.message_queued`, `delegation.released`; `gate.evaluated` gains `policy` (phase decision ids and holds) and
  `gateOverrideBy`. Worker: the spawn carries `continuable` / `background` of the delegation; the capability is
  intersected with the work item's requirements. New exports listed in the API table. No change to the existing
  `src/contracts.ts` types beyond the two optional fields.
- (B1 review fixes, behaviour) `declaredEvidenceTypes` never returns undefined: a tool that declares nothing declares
  `[]` and is judged at after_action (fail closed); a call that reports `denied` / `stale_context` after writing
  evidence is judged; the worker re-evaluates `before_transition work_item:completed` at the transition when the item
  has flagged calls (a flagged call dispatched after `complete_work` in the same turn fails the item `policy_denied`);
  the gate path and the report judge a run's gate with `authorizedGateWeakenings` (configured base when no base is on
  record; only a human/system authority with a rationale; only the weakenings it was given for); a classless
  requirement on environment-addressable scopes keeps every environment class the other operands allow. New exports:
  `addressesEnvironments`, `ENVIRONMENT_FREE_NAMESPACES`, `authorizedGateWeakenings`, `gateReference`,
  `GATE_AUTHORITY_KINDS`, `GateAuthorityJudgement`.

- (context engine completion, additive) `condenserSummarizer(deps, input, options?: { fallback?: boolean })`:
  `fallback: false` throws instead of falling back to the deterministic summarizer (SOFT condensation defers).
  `src/context-provider.ts` exports `SOFT_CONDENSE_TIMEOUT_MS` (60 000) and `SOFT_CONDENSATION_DEFERRED`
  (`context.condensation_deferred`, aggregate `context`/sessionId; a new L0 event string, not in the domain catalog);
  neither is re-exported from `src/index.ts` yet. **Behaviour:** SOFT pressure now condenses (LLM condenser only,
  deferrable with a back-off of keepRecentTurns + 2 turns); the ContextProvider's read set also pins the live
  side-effect leases the claim owns, and the snapshot builder adds the agent's recorded observations (`observer`).
- (unit B2, conformance-5/6) Optional `Scheduler.syncIsolation?(run, items)` and `Scheduler.releaseRun?(runId)`; new
  module `isolation.ts` (exports in the API table); `experiment.define` input gains `fixtures`, `randomSeeds`,
  `stopConditions`, `contaminationRules` and returns `isolation`, `fixtures`, `randomSeeds`, `stopConditions`,
  `contaminationRules`. **Behaviour:** `experiment.define` admits its claims (refusal `resource_conflict` /
  `isolation_insufficient`, experiment not created) and always records at least one claim; write/fault tools of a work
  item running for an experiment are refused `experiment_claims_missing` unless its claims are held; calls name their
  experiment; the run scope gets `computeMs` / `artifactBytes` / `externalQps` limits from the budget envelope and tool
  usage is charged; `load.start` reserves QPS (`external_qps_exhausted`); convergence exhaustion includes `computeMs`
  and `artifactBytes`; run end releases experiment claims and QPS reservations; `recover()` keeps the QPS reservations
  of a dead worker's still-running load jobs (it releases only its other open reservations). (review B2) Write/fault
  calls are also refused outside the experiment's claims (`experiment_claims_missing`) and, for every work item, on
  resources another experiment holds (new tool-denial code `experiment_resource_conflict`); a replayed load.start whose
  QPS reservation was given back re-reserves under `qpsKey(invocationId, n)` (QPS reservations carry the reason
  `load:<invocationId>`); a throwing load.start keeps its rate while its job may run; `experiment.define` keeps a saved
  experiment's claims when a later step fails (the replay completes it; `admission.granted` has a deterministic id);
  with the artifact budget spent, write/fault calls are refused `budget_exhausted` before they act.
  Experiment claims are kept while an operation of the experiment may still act (a running load job), not only while
  an owner work item lives. New exports: `experimentResourceProblem`, `experimentEffectsRunning`, `resourceAliases`, `qpsInvocationId`, `qpsJobMayRun`, `EXPERIMENT_COVERED_PREFIXES`,
  `QPS_REASON_PREFIX`. New L0 event strings (not in the domain
  catalog): `admission.released`; `admission.granted|refused|lapsed` are also emitted with aggregate `experiment`.
  No change to `src/contracts.ts`.

- (unit model-runtime, wave 1) `ControlPlane.releaseModelPauses?(runId, by?)` and `requestModelSwitch?(runId,
  target, routeId, requestedBy, reason?)` (contracts); `ControlDeps.contextHooks?` (kernel plugin context hooks:
  bounded reference sections appended as data, L0 `context.hook_applied`). New exports in `delegation.ts`:
  `modelWaitOperationId`, `parseModelWaitOperationId`, `isModelPaused`, `budgetWaitOperationId`, `isBudgetPaused`; in
  `worker.ts`: `CONTEXT_HOOK_MAX_CHARS`, `MIN_BUDGET_VIEW_TOKENS`; `TurnState` (context-provider) gains
  `viewBudgetCap?`, `viewTokens?`, `compactedLevel?`. **Behaviour:** a transient model unavailability PAUSES the item
  (never fails it); `resumeRun` releases model pauses (and probes the paused routes' circuits); the model budget
  boundary as described above (the previous behaviour — the item failed, the scope and the `model_tokens` reason guessed
  from the token dimension — reported a run-scope USD exhaustion as the item's own token exhaustion).

(gate-governance) Domain tool `experiment.stop`; `experiment.define` input `budget`; `test_artifact.validate` input
`knownGoodUnavailableReason` and output `stages`; `test_artifact.register` output `unchanged` / `contentChanged`;
`system_model.record` input `dataAssets` / `securityBoundaries` / `sources` and output `buildDigests` / `sources`;
`blackboard.post_review` on subjectRef kind `test_artifact`. New exports: `experimentScope`, `experimentStopEventId`,
`artifactReviewRequestEventId`, `claimsWithRules`; `runExperimentIds(deps, item)` also returns the experiments the
item's agent defined when `deps.agents` is given. `ReplanReason` gains `critical_finding` and `oracle_changed`. Events
`experiment.action`, `experiment.stopped`, `test_artifact.reviewed`, `run.oracle_repinned`, `replan.triggered`.
Behaviour changes (each the correct behaviour per the audit; the tests that encoded the old one were rewritten): a
write/fault/load call needs an active experiment; validation evidence must be bound; a run needs a SystemModel to pass
(gate C12, unless `requireContracts: false`).

## Side-effect governance (audit wave 2, additive)

- **E[0]** `claimCommitGuard`: the dispatcher hands the gateway a commit guard that re-checks the caller's work claim
  inside the dispatching transaction (external effects and record-effect tools).
- **E[1] effect claims** (`isolation.ts`: `admitEffectClaim`, `settleEffectClaims`, `lastingEffectMs`): every
  write/fault/load call against an environment is admitted a call-scoped ResourceClaim (`fault_exclusive` for a fault,
  else `write_exclusive`; holder `effect:<group>:<workItemId>:<invocationId>`) before it runs — overlapping faults are
  refused (`resource_claim_conflict`); a time-boxed effect keeps its claim for its window.
- **E[8] approval loop** (`approvals.ts`): a call denied `approval_required` with a recorded approval makes the item WAIT
  on `approval:<id>`; `observeWaiting` resumes it once decided (approved: issue the same call again; denied/expired:
  must not run). Durable: the wait is SQL state.
- **E[3] budget exhaustion policy** (`budget-exhaustion.ts`): `exhaustionPolicy(run, config)` = the run's
  `budget.onExhausted` ⊕ `ControlConfig.onBudgetExhausted` (now `'gate' | 'pause' | 'approval'`). `applyExhaustionPolicy`
  pauses the run (`budget`), or requests a budget extension and pauses (`approval`), or converges to the gate; a resume
  without a raise converges to the gate. `ControlPlane.raiseBudget?(runId, raise, by, rationale)` (amounts ADDED; L0
  `budget.raised`), `resolveBudgetApproval?(runId)`; `resumeRun` refuses to bypass a pending extension.
  (review) Only extension requests the control plane filed itself (requester `system:budget`, `BUDGET_EXTENSION_REQUESTER`)
  count: an agent's look-alike `budget` approval (request_approval with the same subject and another raise) — even
  approved — never extends the budget nor ends the wait.
  `ConvergenceMonitor.exhaustionDetail?(run, { caps? })`: every dimension, USD refusals included (item 10); `caps` adds
  the work-item cap and experiments' own budgets.
- **item 11** a cancelled (or decided) run closes its model pauses (`model.pauses_released` with `closed: true`).
- **stubs[8]** `ControlPlane.resolveOperation?(opId, outcome, by, note)`; a call that ended in manual review makes its
  item wait until a human resolves it.
- **coverage[8]** `brokeredCredentialScopes(environments, profile)`: capabilities carry the credential scopes granted to
  the role's permission profile.
- Tests: `test/side-effect-governance.test.ts`, `test/approval-loop.test.ts`, `test/budget-exhaustion.test.ts`,
  `test/manual-review.test.ts`.

## Context and learning (unit context-learning, additive)

- **B[1] every mutating call is freshness-checked.** The ToolRuntime skips the guard for `record` effects, so
  `createDomainTools` wraps every record-effect domain tool with `freshnessChecked(deps, spec)` (inside `claimFenced`'s
  transaction): the call's snapshot is validated against the resources it changes (`plan` `run/<id>/plan` for
  `plan.propose_revision` — a compare-and-set against the plan revision the lead saw —, `record:` / `finding:` /
  `finding_withdrawal:` of a superseded lineage for `blackboard.post_*`, plus every always-checked type) and a stale
  call is refused `stale_context` with each stale resource, its reason and current version, and a refresh hint. A pass
  is logged (`deps.freshnessPasses`) so a replayed invocation is not re-judged. `@hypertest/app` wraps plugin record
  tools the same way. `FRESHNESS_CHECKED` lists the wrapped tools; `test/freshness-coverage.test.ts` enumerates every
  mutating tool of the built-in + domain catalog and fails when one is neither runtime-checked nor wrapped.
- **B[5] L1 sections with budgets.** `SECTION_BUDGETS` (tokens): plan 2500, blackboard 3000, code 1500, experience 800,
  skills 2000, evidence 1000, oracles 800, tools 700; a section is present exactly when its source has something for the
  agent (`test/l1-sections.test.ts`). Every prompt's deliveries are recorded as observations (`PROMPT_OBSERVER_TOOL_ID`
  = `context.assemble`) under the turn snapshot, so what reached the agent only through its prompt (records, plan,
  code lines, skills, environments) is pinned; a "Changed since you last saw them" notice names what moved since. A
  finding merely LISTED among the open records is pinned as `record` (checked for actions naming its lineage) plus
  `finding_withdrawal` (always checked); the always-checked `finding` version only for a finding the agent acts on (an
  input record, or one it read in full or posted) — review: otherwise a confirmation of any listed finding refused every
  mutating action of every agent that saw the list (`test/freshness-coverage.test.ts`). A `restricted` context
  (local_private, or `modelPolicy.privacyClass: restricted`) asks `retrieverFactory(root, {restricted: true})`: no
  off-host embedding route. Stale refusals of record tools carry refresh hints for records, plans, files, metric windows,
  oracles, environments and leases.
- **B[7] skills.** `deps.skills.forPrompt` (the registry's active, published revisions; plus `skills.trial` in an eval
  arm) fills the Skills section.
- **B[8] compaction on L0.** `recordCompaction` stores the compaction and its `context.compacted` event (with the summary)
  atomically; with the app's L0 transcript recording an agent's context is rebuilt from L0 alone
  (`test/l0-context.test.ts`).
- **B[9] strategies and decisions.** `blackboard.post_strategy` (TestStrategy: objectiveIds of the accepted plan,
  approach, techniques, description; `updatesRecordId` revises its lineage) and `blackboard.post_decision` (DecisionNote:
  topic, decision, rationale, evidence) — capability-checked like every domain tool, evidence-checked, versioned with
  lineage (`test/strategy-decision.test.ts`). Held by the lead (both) and the test designer (strategy).
- **Row 155 test.recovered.** The reactors (consumer `reactors:test-recovery`, inbox-deduped) append `test.recovered`
  (deterministic id `testRecoveredEventId`) when a test (framework + selector) that last failed in the run passes on later
  evidence — never for a known-good pass on the BASE revision — citing both events, their evidence and invocations
  (`test/test-recovery.test.ts`).

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

## Tool surface (audit wave 3, additive)

- `toolGrantScopes(tools, profileName)` (`capability-grant.ts`): the resource scopes of tools whose `ToolSpec.grant` names
  the permission profile (e.g. an unbound MCP server's `mcp/<server>/**`, computer use's `desktop/<id>`); the worker adds
  them to an agent's root capability. Tests: `test/tool-grants.test.ts`.
- `request_approval`'s description now says it is for decisions that are not tool calls; an action that needs approval
  is filed by the policy gate itself (`approval_required`).
