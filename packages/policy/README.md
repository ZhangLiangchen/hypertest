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
| Oracles (I8) | `createOracleGovernance(deps)`, `assertMayDecide`, `agentIndependenceViolation` |
| Self-heal (I8) | `classifyTestChange(diff, options?)`, `categoryDecision`, `DEFAULT_TEST_PATH_PATTERNS`, `parseUnifiedDiff` |
| Gate (I7) | `QualityGate#evaluate(input)`, `DEFAULT_GATE_SPEC`, `GATE_CRITERIA`, `currentRecords` |
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
- **OPA.** `POST {url}/v1/data/{path}` with `{ input: request }` (capability signature stripped); expects
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
- **QualityGate.** Pure and deterministic. Criteria C1–C9 (see `GATE_CRITERIA` and the header of
  `src/gate.ts`); verdict precedence fail > inconclusive > conditional > pass. Beyond the letter of the
  spec: C1 is also `unknown` with zero evidence, zero *eligible* evidence (only ineligible generated
  tests) or foreign-run evidence (a pass without evidence is impossible and C1 is never waivable); C2 treats unresolved P0/P1 test/infra/environment findings as
  `unknown`; C3 evaluates the latest *build* (by `environment.buildDigest`/`provenance.commit`) so a fix
  followed by a green regression passes while a fail+pass on the same build stays a violation; `xfail`
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
| I7 gate: one test per criterion (satisfied/violated/unknown), precedence, exceptions, determinism, zero (eligible) evidence, LLM-only critical, ineligible generated tests | `test/gate.test.ts` |
| I8 oracles: self-approval, same/unknown provider or role, approver kinds, flip needs human (re-checked at decision time), stale proposal, create-only establish, concurrent approvals (in-process and across instances), resumable approval, new revision + reassessment | `test/oracle-governance.test.ts` |
| I8 self-heal: JS/TS/Python/Go diffs, deletion/skip/swallow/assertion/threshold, evasion attempts (comments, wrappers, exits, modifiers, hooks, selection, malformed hunks) and false-positive guards, real git multi-file diff | `test/classifier.test.ts` |
| I10 audit: decision log append-only (trigger), event in the same transaction (sink failure rolls back), approvals decided once (conditional UPDATE + trigger), agent deciders, NUL-safe storage, concurrent deciders on PostgreSQL | `test/persistence.test.ts`, `test/persistence.int.test.ts` |
| BUGate binding + context rendering, byte bounds, schema identity with a checkout | `test/bugate.test.ts` |

## Contract changes (additive)

`PatternKind`, `PermissionProfileName`, `RootCapabilityInput`, `ChildCapabilityIdentity`, `AttenuateOptions`
(optional 4th argument of `attenuateCapability`), `PolicyEngineOptions`, `OpaPolicyEngineOptions`;
`GateInput.producerProviders?`, `GateInput.revision?`,
`GateInput.supersedes?`; `ProtocolContextRequest.workspaceDigest?`; the `PolicyRule` doc comment now
states the evaluate-all / most-restrictive / fail-closed semantics.

## Testing

```bash
npx tsc -p packages/policy --noEmit
node scripts/run-tests.mjs --package policy                          # PGlite + local OPA/PostgreSQL integration
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package policy # same suite on PostgreSQL 16
```

Integration tests (`*.int.test.ts`) use `HYPERTEST_TEST_OPA_URL` / `HYPERTEST_TEST_PG_URL` (from the
environment or `.infra/env`) and skip with an explicit reason when they are absent. BUGate checkout tests
use `HYPERTEST_BUGATE_PATH` (default `/home/user/BUGate`) and skip when no checkout exists.
