# @hypertest/policy

Governance outside the model. This package decides, deterministically and without any LLM, **what an
agent may do** (capabilities + action permits), **how correctness criteria may change** (oracle
governance + self-heal classification) and **whether a pass may be claimed** (the QualityGate). It also
binds Hypertest to the **BUGate protocol** (`ProtocolBinding` + `PreparedProtocolContext`).

Depends only on `@hypertest/core`, `@hypertest/domain` and `yaml`. The binding ABI is
[`src/contracts.ts`](src/contracts.ts).

## Public API

| Area | Exports |
|---|---|
| Patterns | `matchesPattern(pattern, value, kind?)`, `matchesToolPattern`, `matchesResourcePattern`, `toolPatternCovers`, `resourcePatternCovers`, `intersectPatterns`, `matchesGlob` |
| Capabilities (I2) | `PERMISSION_PROFILES`, `createRootCapability(input, secret)`, `attenuateCapability(parent, constraints \| constraints[], child, { secret }?)`, `capabilityAllows(cap, req)`, `signCapability`, `verifyCapability`, `nonCanonicalResource`, `PRODUCT_FIX_SCOPE`, `holdsProductFix` |
| Permits (I1) | `BuiltinPolicyEngine(rules, revision, options?)`, `DEFAULT_POLICY_RULES`, `POLICY_RULE_SCHEMA`, `OpaPolicyEngine({ url, path, timeoutMs, revision })`, `CompositePolicyEngine(engines)`, `intersectConstraints` |
| Audit | `createPolicyDecisionLog(deps)` (`ht_policy_decisions`), `createApprovalService(deps)` (`ht_approvals`), `policyMigrations` |
| BUGate phases | `POLICY_PHASES`, `requestPhase`, `flaggedActionsOf`, `IMPLICIT_EVIDENCE_TYPES`, `actionOutcomeFacts`, `acceptanceFacts`, `applyPhasePermit`, `withPolicyHold`, types `PolicyPhase`, `ActionOutcomeFacts`, `TransitionFacts`, `AcceptanceFacts`, `PolicyHold` |
| Oracles (I8) | `createOracleGovernance(deps)` (+ `invalidate`), `assertMayDecide`, `agentIndependenceViolation`, `authorityProblems` |
| Test artifacts (D-0/D-1) | `sensitivityBinding(evidence, artifact, purpose)`, `artifactEligibility(artifact, ctx)`, `artifactCaseStatuses`, `executedTestsOf`, `codeRevisionOf`, `isBaseRevisionRun`, `sameTestFile`, `caseInFile`, `normalizeTestPath`, `oracleRefProblems`, `reviewProblems` |
| Experiments (D-3/D-4/D-5) | `planViolation`, `faultMatches`, `evaluateStopConditions`, `observedErrorRate`, `exclusiveResourcesOf`, `experimentValidity`, `ACTION_MAY_HAVE_HAPPENED`, `FAULT_TOOL_IDS`, `LOAD_TOOL_IDS` |
| Self-heal (I8) | `classifyTestChange(diff, options?)`, `categoryDecision`, `DEFAULT_TEST_PATH_PATTERNS`, `parseUnifiedDiff` |
| Gate (I7) | `QualityGate#evaluate(input)`, `DEFAULT_GATE_SPEC`, `GATE_CRITERIA`, `currentRecords`, `evaluateOracleCheck` (the C3 check evaluator), `OracleCheckOutcome`, `ORACLE_AUTHORITY_KINDS`, `oracleAuthorityProblems` |
| BUGate | `resolveProtocolBinding({ bugatePath? })`, `prepareProtocolContext(protocol, request)`, `EMBEDDED_PRINCIPLES`, `PREPARED_PROTOCOL_CONTEXT_SCHEMA` |

### Semantics worth knowing

- **Patterns.** Tools: exact id, trailing-`*` prefix glob (`git.*`, `oracle.approve*`) or `*`. Resources:
  `/` segments, `*` = one segment, `**` = zero or more. Resource keys follow `workspace/<id>/<path>`,
  `env/<id>/…`, `run/<runId>/…`.
- **Attenuation.** Tool/resource patterns of the child are the constraint patterns covered by a parent
  pattern plus the parent patterns covered by a constraint pattern (a sound under-approximation of the
  intersection); effects/credentials/environments intersect; risk and expiry take the minimum; omitted
  fields inherit; an array of constraints applies role ∩ work item ∩ environment. Without options the
  result is unsigned — sign it with `signCapability`. With `{ secret }` the parent HMAC is verified first
  (`permission_denied` otherwise, so a tampered parent cannot be laundered into a validly signed child)
  and the child comes back signed. Resource keys must be canonical: empty, `.` and `..` segments,
  backslashes and NUL are denied (`resource_not_canonical`) before any scope is consulted.
- **Profiles.** `read_only`/`analyst`: read+record; `test_author`: +write_workspace+execute on
  `workspace/**`; `test_executor`: +execute+external on local/sandbox; `environment_operator`:
  +external+destructive, max risk high, local/sandbox/staging; `product_fixer`: write_workspace+execute
  with the `workspace:product_write` credential scope. No built-in profile grants `production`.
- **Built-in engine.** A malformed request or capability is denied (`malformed_request`,
  `capability_malformed`), never thrown. The capability (signature when a secret is configured, run id,
  subject agent and work item when the request names them — no confused deputy — and `capabilityAllows`)
  is checked first; then *all* matching rules are evaluated and the most restrictive decision wins
  (deny > approval_required > allow); no matching rule ⇒ deny. Allow rules with `resources` need a
  non-empty resource list fully inside the patterns; deny/approval rules match on any resource.
  `DEFAULT_POLICY_RULES`: read/record allowed; write_workspace/execute inside `workspace/**`; external on
  local|sandbox allowed, on staging approval; destructive on local|sandbox allowed, ≥ high on
  sandbox|staging and anything on staging approval, critical approval; destructive and anything > read on
  production denied; `oracle.approve*`, `oracle.decide*`, `approval.decide*` denied.
- **Phases (BUGate four time points).** `ActionRequest.phase` is `before_action` (default; the ToolRuntime's permit),
  `after_action` (+ `outcome`: the evidence types an executed call wrote vs the ones its tool declares), `before_transition`
  (+ `transition`: `subject` work_item | plan | run, `from`, `to`, the subject's flagged calls, requester, details) or
  `before_acceptance` (+ `acceptance`: `acceptanceFacts(gateInput, decision, …)`, a bounded digest of the gate input —
  evidence counted by type, never its payloads — and the gate's verdict). A rule without `match.phases` applies to
  `before_action` only, so every existing rule set keeps its meaning; the phase conditions `transitions`
  (`<subject>:<to>` tool-style patterns), `undeclaredEvidence`, `flaggedActions` and `verdicts` never match a request
  without the corresponding facts; a malformed phase or fact is `malformed_request` (deny), a malformed flagged count
  counts as flagged. Defaults: `allow-after-action` + `flag-undeclared-evidence` (deny = flag),
  `allow-transitions` + `deny-completion-with-flagged-actions`, `allow-acceptance` + `review-flagged-actions`
  (approval_required). No matching rule in a phase ⇒ deny (fail closed). `applyPhasePermit(decision, permit, phase)`:
  a non-allow before_transition / before_acceptance permit withholds a gate decision (`withPolicyHold`: pass /
  conditional ⇒ inconclusive, fail stays fail, requiresHumanReview, the hold listed as an unknown criterion
  `policy.<phase>`). The decision log's `policy.decided` event carries the phase; stored requests are replayable
  (re-evaluation with the same rules and a clock at `decidedAt` gives the same permit).
- **OPA.** `POST {url}/v1/data/{path}` with `{ input: request }` (capability signature stripped; `input.phase` always
  present, the phase facts included); expects
  `{ allow, approval_required?, reasons?, constraints? }`. Transport error, timeout, non-2xx, undefined or
  malformed result ⇒ `deny` with first reason `opa_unavailable`. `path` must be package segments. The
  composite engine treats a throwing engine or a malformed permit as `deny`. Engines keep a deep-frozen
  private copy of their rules.
- **Oracle governance.** Only humans/system establish oracles, and `establish` only creates (an existing
  id is a `conflict`; changes go through propose/decide so prior decisions get invalidated). Agents propose only when
  `agentMayPropose`; `fromRevision` must be current (`conflict`). Approval is refused for the proposer,
  system actors, approver kinds not listed in `changePolicy.approvers`, agents whose provider or role is
  unknown or equal to an agent proposer's (fail closed), and non-humans when the change would flip a
  recorded failure and humans are approvers — the flip is re-evaluated at decision time. Approval writes
  exactly revision `current + 1` (compare-and-set against the store; decisions per oracle are also
  serialized in-process), then marks decisions on the old revision `needs_reassessment` (when
  `invalidatesPriorDecisions` or the change flips a failure), then closes the proposal; a retry by the same
  approver resumes an interrupted approval without writing a second revision.
- **Classifier.** Decision table: locator/environment_setup ⇒ auto_allowed; fixture/test_implementation/
  timeout ⇒ conditional; assertion/threshold/unknown ⇒ approval_required; test_deleted/test_skipped/
  exception_swallowed/product_code ⇒ forbidden (product_code ⇒ approval_required with
  `productFixAuthorized`). Conservative by design: a renamed test title counts as a deleted test; an
  existing assertion guarded by new code that may not run it is an assertion change: dead branches
  (also brace-less), uncalled functions/closures, deferred callbacks (`setTimeout`, `.then`), new early
  exits anywhere on a line (`if (CI) return;`, escaping enclosing blocks), and new block comments /
  docstrings / multi-line template literals around unchanged code (regions follow braces or Python
  indentation, not a fixed window). Only comment/string regions opened by added lines are tracked, so a
  mis-detection can only make the result stricter. Re-indented Python assertions, snapshot/golden/
  expected-output files are assertions; runner exclusions (`testPathIgnorePatterns`, `--deselect`,
  `collect_ignore`, `pytest_ignore_collect`, `//go:build ignore`, …) and outcome-inverting or chained
  modifiers (`it.fails`, `test.failing`, `it.concurrent.skip`, `test.describe.skip`) are skips; test
  selection changes in runner config and pytest collection hooks are `unknown` (approval). Malformed
  hunks (truncated, or `+`/`-` lines outside any hunk; `DiffFile.issues`) are `unknown`, never auto-allowed.
  Default test paths add `**/test/**`, `**/fixtures/**`, `**/testdata/**` to the spec'd JS/Python/Go set.
- **Test artifacts (gate-governance, D-0/D-1).** `sensitivityBinding` decides whether a test-result / mutation-result
  provably executed an artifact: its recorded `executedTests` name the artifact's file with exactly the registered
  content digest and ≥ 1 case, its `codeRevision` records the code (tree digest); a mutation run must have executed
  ONLY that file (complete attribution), and its recorded `mutatedFile` must be the candidate's PRODUCT code — not the
  artifact, not another test (`isTestPath`: `TEST_FILE_PATH_PATTERNS`, shared with the tools), not a file written in the
  workspace (review: an insensitive test used to "prove" sensitivity by killing mutants of its own tautological
  assertion). The problem text is exact (`test_artifact.validate` refuses with it).
  `artifactEligibility` re-derives the whole lifecycle from the cited evidence and review records — static check of
  this content, known-good (passing, bound, on the run's base commit when run on the base revision — a pass on the
  candidate workspace or a recorded "unavailable" reason keeps the artifact eligible but never lets it support or
  violate a P0/P1 assertion: `criticalSupport` needs a base-revision known-good, `knownGoodRevision` says where it ran),
  sensitivity (a bound failing known-bad on other code, or a bound mutation run with a killed mutant), oracle refs naming
  assertions of oracles in force, an approving oracle consistency review of this digest by another agent of another
  role — and never trusts a stored state or score.
- **Superseded experiments and prose claims (review).** An experiment whose oracleRefs name a revision no longer in force
  is superseded: its evidence never counts (reasons list it) and C10 does not judge it, so a NEW experiment re-run under
  the revision in force decides. A critical claim without a value (its fact only in the prose of the statement) is
  unknown in C9.
- **Experiments (D-3/D-4/D-5).** `planViolation` (a fault outside the fault plan, load above the workload),
  `evaluateStopConditions` (duration since the first action, error rate, metric threshold, manual; the earliest met
  condition), `experimentValidity` (C10: isolation held, no foreign action on its exclusive resources during it,
  environment generation unchanged except by its own verified restarts/deploys, executed == declared, no action after a
  met stop condition, evidence requirements met, dedicated environment registered, oracle refs still in force;
  contradictions ⇒ violations, missing facts ⇒ unknowns). Pure functions over the gate input.
- **QualityGate.** Pure and deterministic. Criteria C0–C12 (see `GATE_CRITERIA` and the header of
  `src/gate.ts`; gate-governance added C10 experiment_validity, C11 environment_validity, C12 domain_contracts and made
  C3 bind artifacts, C4 count experiment requirements, C6 follow oracle judge policies and C9 evaluate claims);
  verdict precedence fail > inconclusive > conditional > pass. Beyond the letter of the
  spec: C1 is also `unknown` with zero evidence, zero *eligible* evidence (only ineligible generated
  tests) or foreign-run evidence (a pass without evidence is impossible and C1 is never waivable); C2 treats unresolved P0/P1 test/infra/environment findings as
  `unknown`; C3 evaluates the latest *build* (by `environment.buildDigest`/`provenance.commit`) so a fix
  followed by a green regression passes while a fail+pass on the same build stays a violation; evidence
  without a build identity (e.g. a request to a URL that names no registered environment) belongs to the
  build current when it was recorded, so it can never become "the latest build" on its own and hide the
  current build's failures; `xfail`
  violates, `skipped`/`error`/`xpass` are unproven; C5 also counts unfinished work; C6 counts rejects
  from any reviewer; exceptions approved by agents or expired are ignored. Coverage thresholds > 1 are
  read as percentages.
- **BUGate.** With a checkout (`protocol/v2/manifest.yaml`) the digest is
  `sha256(canonicalJson({ manifest, schema, method, sop }))` over the file SHA-256s; methodology =
  embedded principles + `method:<heading>` sections of `docs/qa-methodology/METHOD.md`. A malformed
  checkout is an error. Without one, the embedded protocol (`embedded-2.0.0-dev`) is used.
  `prepareProtocolContext` renders phase/role-specific markdown bounded to `maxBytes` UTF-8 bytes (default
  6000, cut on code-point boundaries, `render.bytes` exact) and validates it against the schema.
  Caller text (concerns, posture keys, task id, role) is flattened to one line in the markdown so it
  cannot inject headings; the structured fields are carried unchanged. The schema path must stay inside
  `protocol/v2` also after resolving symlinks. The embedded schema is deep-frozen.
- **Approvals.** The requester never decides; agents never decide `action`/`budget`/`manual_review`
  approvals and decide `test_change`/`oracle_change` approvals only when independent of an agent
  requester. The event context must belong to the approval's run; the requester's rationale is kept in
  `approval.requested`.
- **Storage.** U+0000 cannot be stored by PostgreSQL; agent-influenced audit data (tool input, approval
  subject/rationale) is stored with U+0000 → U+FFFD and `requestHash` covers the stored form, so audit
  writes never fail on it and stored rows re-verify.

## Invariants enforced (tests)

| Invariant | Tests |
|---|---|
| I1 permit before tool: capability checked first, signature/run/subject/work-item binding, malformed input denied, fail-closed defaults, OPA fail-closed, immutable rules | `test/engine.test.ts`, `test/opa.test.ts`, `test/opa.int.test.ts` |
| I2 no amplification: attenuation per field, greedy child, tampered parent refused, non-canonical keys, seeded randomized property (400 capabilities × 50 actions) | `test/capabilities.test.ts`, `test/patterns.test.ts` |
| I7 gate: one test per criterion (satisfied/violated/unknown), precedence, exceptions, determinism, zero (eligible) evidence, LLM-only critical, ineligible generated tests, latest build (unidentified evidence never hides the current build's failure) | `test/gate.test.ts` |
| Gate-governance: the D-0 audit scenario (an insensitive test + another file's mutation result never passes), binding problems, lifecycle stages and unavailable known-good, symmetric C3 eligibility, critical test failed, claim evaluation (C9), C10 contradictions/unknowns and stop conditions (seeded property test), C11, C12, the five contract revisions on the decision, agent waivers ignored, D-7 authorities / judge policy / invalidation | `test/governance-lifecycle.test.ts` |
| I8/conformance-2: evidence carrying a `workspaceDelta` counts only when every test file added/modified since the base commit is covered by the LATEST revision of a TestArtifact with exactly that content digest that proved its sensitivity (draft/quarantined/retired/insensitive/`existing`-claimed artifacts do not cover; one uncovered file taints the record even with an eligible declared artifact); an unavailable delta counts only for a read-only workspace | `test/gate.test.ts` › conformance-2 |
| H8: `evaluateOracleCheck` is the gate's own C3 evaluator (same outcome and refs as C3) | `test/gate.test.ts` › H8 |
| I8 oracles: self-approval, same/unknown provider or role, approver kinds, flip needs human (re-checked at decision time), stale proposal, create-only establish, concurrent approvals (in-process and across instances), resumable approval, new revision + reassessment | `test/oracle-governance.test.ts` |
| I8 self-heal: JS/TS/Python/Go diffs, deletion/skip/swallow/assertion/threshold, evasion attempts (comments, wrappers, exits, modifiers, hooks, selection, malformed hunks) and false-positive guards, real git multi-file diff | `test/classifier.test.ts` |
| I10 audit: decision log append-only (trigger), event in the same transaction (sink failure rolls back), approvals decided once (conditional UPDATE + trigger), agent deciders, NUL-safe storage, concurrent deciders on PostgreSQL | `test/persistence.test.ts`, `test/persistence.int.test.ts` |
| BUGate binding + context rendering, byte bounds, schema identity with a checkout | `test/bugate.test.ts` |
| BUGate four time points: phase-scoped rules (action rules never judge another phase), fail-closed phases and facts, defaults per phase, custom transition/verdict rules, the capability checked in every phase, decision log phase + replay, acceptance facts (no evidence payloads) and holds (never pass); OPA receives the phase and facts (mock and real server, composite deny wins) | `test/phases.test.ts`, `test/opa.test.ts`, `test/opa.int.test.ts` |

## Contract changes (additive)

`PatternKind`, `PermissionProfileName`, `RootCapabilityInput`, `ChildCapabilityIdentity`, `AttenuateOptions`
(optional 4th argument of `attenuateCapability`), `PolicyEngineOptions`, `OpaPolicyEngineOptions`;
`GateInput.producerProviders?`, `GateInput.revision?`,
`GateInput.supersedes?`; `ProtocolContextRequest.workspaceDigest?`; the `PolicyRule` doc comment now
states the evaluate-all / most-restrictive / fail-closed semantics.

(hardening) Exports `evaluateOracleCheck(check, evidence)` and type `OracleCheckOutcome` (H8: the gate's own check
evaluator, for deterministic consumers such as the oracle-change flip detector — no re-implementation that drifts).
Gate behaviour (conformance-2): evidence eligibility is also derived from its recorded `workspaceDelta` (written by
`test.run` from the workspace itself): new or modified test files must be covered by a validated/approved artifact
with that exact `artifactDigest`; evidence without a delta is judged as before (declared `testArtifactId` only).

(hardening, upper) `GateSpec.requireOracle?` (domain, default `true` in `DEFAULT_GATE_SPEC`) and gate criterion
**C0 `oracle_in_force`** (conformance-1), evaluated first: satisfied when the run pins an approved oracle revision
with at least one deterministic P0/P1 assertion (not `llm_rubric` / `llm_semantic`), or when the gate explicitly sets
`requireOracle: false`; otherwise `unknown` ⇒ the verdict is at best `inconclusive` (never `pass` without a
correctness criterion decided by a human). H3: an unrecognised `failOnUnresolvedSeverity` / `conditionalOnRiskLevel`
fails closed (strictest threshold, criterion at least `unknown`).

(hardening) conformance-4: `GateInput.currentOracleRevisions?` — the latest approved revision of each pinned oracle;
a pinned revision below it (an oracle approved in a new revision during the run) makes C0 `unknown` ("superseded …
judge the candidate against the new revision in a new run"), whatever `requireOracle` says. conformance-9: every
`QualityDecision` carries `gateSpecDigest` (sha256 of the canonical effective GateSpec, signed with the decision) and
`gateOverrides` (`field=value` for each field that differs from `DEFAULT_GATE_SPEC`; new export `gateOverrides`), so a
weakened run-level override is visible in the decision and the report. conformance-11: approval kind
`gate_exception` (subject `{ criterionId, expiresAt? }`; migration `policy/003-gate-exception-approvals` widens the
`ht_approvals.kind` check) — the governed waiver the gate's exception rules (never C1, never agent-approved, never
expired) apply to.

(B1 governance completion, phases) `PolicyPhase` (named; `ActionRequest.phase` has the same four values);
`ActionRequest.outcome?` / `transition?` / `acceptance?` with `ActionOutcomeFacts`, `TransitionFacts`,
`AcceptanceFacts`; `PolicyRule.match.phases?` / `transitions?` / `undeclaredEvidence?` / `flaggedActions?` /
`verdicts?` (+ `POLICY_RULE_SCHEMA`); new exports of `src/phases.ts` (table above); `DEFAULT_POLICY_RULES` gains six
phase rules (the action rules are unchanged, so `builtin:<digest>` revisions change); `policy.decided` gains `phase`;
the OPA input always has `phase`. Behaviour: a request with an unknown phase or malformed phase facts is denied
(`malformed_request`).

(gate-governance, additive) `GateInput.systemModel?` / `operations?` (`GateOperation`) / `experimentFacts?` /
`environments?` (`EnvironmentFacts`) / `claimData?`; `OracleGovernance.invalidate?()`; new modules `src/sensitivity.ts`
and `src/experiments.ts` (table above). Behaviour: criteria C10–C12 (all fail-type when violated; C11/C12 report
`unknown`); `DEFAULT_GATE_SPEC.requireContracts: true`; the decision records `systemModelId`, `buildDigests` and
`testArtifactRevisions`; a pinned oracle declared `invalid` makes C0 unknown; ungoverned or invalidated oracles are not
in force. (The control plane re-pins a run to a newly approved oracle revision before gating — D-10 — so the
conformance-4 "superseded" C0 detail remains only as a guard for a gate input assembled without re-pinning.)

## Approval gate and credential scopes (audit wave 2, additive)

- **E[8] `ApprovalGatedPolicyEngine(inner, { approvals, clock, approvalTtlMs? })`** wraps the composed engine (revision =
  the inner engine's). A `before_action` request the inner engine sends to `approval_required` becomes: `allow` when an
  approval of kind `action` bound to the exact action (`actionDigest`: run, work item, tool, effect, risk, resources,
  environment class, digest of the redacted input) is approved by an independent human/system actor, unexpired, and
  can be CONSUMED by this request (exactly once: append-only `ht_approval_consumptions`, migration
  `policy/004-approval-consumptions`; a replay of the same request finds its own consumption); `deny` when the latest
  decision on that action is a denial or the request expired (no silent re-request); else `approval_required` with the
  `approvalId` of the pending request (created when none is pending, `subject.expiresAt` = now + TTL, default 24 h).
  `ActionRequest.approvalId?` names an approval; one of another action is refused (`approval_mismatch`).
  `ApprovalService.consume?/consumption?/expire?` (events `approval.consumed`, `approval.expired`); `decide` refuses
  an expired request.
- **coverage[8]** `ActionRequest.credentialScopes?` reach the capability check (`credential_scope_not_permitted`).
- `PERMISSION_PROFILES.environment_operator.maxRiskClass` is `critical` (env.deploy is reachable; every critical
  external/destructive action still needs a human approval through `approve-critical-risk`).
- (review) An approval authorizes only the action its subject DESCRIBES: `subjectActionDigest(approval)` re-digests the
  subject's tool, effect, risk, resources, work item, environment class and arguments (what the decider was shown) and
  the gate honours an approval only when that equals its `actionDigest` and it has a decision window
  (`subject.expiresAt`). An approval filed with a forged digest (e.g. an agent's `request_approval` showing a harmless GET
  while carrying the digest of a deploy) neither authorizes nor blocks anything; named explicitly it is refused
  (`approval_mismatch … does not describe the action it is bound to`). `actionDigest` is computed over the stored form of
  the arguments (U+0000 → U+FFFD), so an approval re-verifies after the round trip through the store.
- (review) `ActionRequest.noApprovalRequest?`: a caller that cannot wait for a human decision (a sandboxed command's
  relayed write) gets `approval_required` without an approval request being filed.
- (review) `ActionRequest.relayedWrite?: { callEffect }`: the effect is a write a sandboxed command of the call sends to a
  relayed SUT endpoint; `checkCapability` then bounds the CALL (tool, `callEffect`, risk, environment class — required —
  and expiry) instead of `effect`/`resources`, while the rules judge the external effect on the environment class as for
  any call (staging ⇒ approval, production ⇒ deny).

## Testing

```bash
npx tsc -p packages/policy --noEmit
node scripts/run-tests.mjs --package policy                          # PGlite + local OPA/PostgreSQL integration
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package policy # same suite on PostgreSQL 16
```

Integration tests (`*.int.test.ts`) use `HYPERTEST_TEST_OPA_URL` / `HYPERTEST_TEST_PG_URL` (from the
environment or `.infra/env`) and skip with an explicit reason when they are absent. BUGate checkout tests
use `HYPERTEST_BUGATE_PATH` (default `/home/user/BUGate`) and skip when no checkout exists.
