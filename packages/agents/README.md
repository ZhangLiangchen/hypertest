# @hypertest/agents

The role catalog. Roles are **policy as data**, not code paths: system prompts (with the BUGate
`{{protocol}}` injection slot), default `ModelPolicy` (every role routes independently: native
multi-LLM), tool allowlists, permission profile, workspace, output contract (JSON Schema), event
subscriptions (decentralized collaboration) and delegation limits. Stateless: no tables, no migrations.

Depends only on `@hypertest/core` and `@hypertest/domain`.

## Public API

| Export | Purpose |
|---|---|
| `BUILTIN_ROLES` | The 14 built-in roles (deep-frozen): `lead`, `code_change_analyst`, `architecture_analyst`, `historical_bug_analyst`, `test_designer`, `executor`, `rca`, `fixer`, `reviewer`, `metrics_analyst`, `environment`, `condenser`, `vision_gui`, `local_private`. |
| `SPECIALIST_ROLES` | (additive) `vision_gui`, `local_private`: roles only a special route can serve (a vision route; a route accepting restricted data, i.e. a local model). `hypertest doctor` reports their route coverage separately. |
| `new RoleCatalog(roles, overrides?, options?)` | Effective, validated, deep-frozen catalog: `get`, `require` (unknown ⇒ `HypertestError('not_found')`), `list`, `subscriptions()` (flattened with `role`), `revision()` (SHA-256 hex of the canonical effective roles). |
| `renderTemplate(template, vars)` | Single-pass `{{name}}` substitution; unknown ⇒ `''`; values never re-expanded; own properties only; `$` literal. |
| `renderRolePrompt(role, {objective, runGoal, protocol?})` | Renders a system prompt; blank inputs become explicit notices (`NO_PROTOCOL_NOTICE`, `NO_OBJECTIVE_NOTICE`, `NO_RUN_GOAL_NOTICE`). |
| `renderSubscriptionWork(sub, vars)` | Work for a matched event: event text sanitized (single-line title), title ≤ 200 and objective ≤ 4000 UTF-16 units, event values shortened before the template's own instructions are cut, no live `{{placeholder}}` in the output (even from adjacent values), missing vars ⇒ `(not provided)`. |
| `matchesSubscription(sub, subject)`, `matchesSubscriptionFilter` | Reactor filter semantics: constraints AND-ed, missing fields and empty lists fail closed; `excludeFromRoles` drops events produced by those roles (self-trigger guard). |
| `KNOWN_TOOL_IDS` (`BUILTIN_TOOL_IDS` + `DOMAIN_TOOL_IDS`), `TERMINAL_TOOLS`, `WORKSPACE_WRITE_TOOL_IDS`, `DYNAMIC_TOOL_NAMESPACES` | Tool ids role allowlists may reference (`mcp.*` is dynamic); the workspace-writing subset. |
| `matchesToolPattern`, `isKnownToolPattern`, `toolPermitted` | Tool-pattern semantics identical to `@hypertest/policy`. |
| `ROLE_DEFINITION_SCHEMA`, `validateRoleDefinition(role, options?)` | Structural + semantic role validation (returns issues). |
| `EVIDENCE_PRODUCER_ROLES` | (additive) The roles whose agents produce evidence, findings, test artifacts or fixes (`executor`, `test_designer`, `rca`, `fixer`, `metrics_analyst`, `environment`, `vision_gui`, `local_private`); the reviewer's `independentFromRoles`. Use it wherever producers are counted (e.g. the gate's `producerProviders`), so routing and gate agree. |
| `*_OUTPUT_SCHEMA` | Output contracts validated on `complete_work` (JSON Schema 2020-12 incl. `if/then` — meant for Ajv validation of the completion, not for strict provider `response_format`). |

### Overrides (`hypertest.config.yaml` → `roles:`)

Deep merge: plain objects merge per key; **arrays replace** (e.g. `toolPolicy.allow`, `subscriptions`);
**`outputSchema` replaces wholesale**; `undefined` is ignored. Overrides for unknown roles, a `role` key,
unknown keys and `__proto__`/`constructor`/`prototype` are rejected. `custom` roles are appended and may be
overridden too. Unknown tools/events can be admitted explicitly with `options.extraToolIds` /
`options.extraEventTypes`.

### Role summary

| Role | Phase | Profile / workspace | Model policy (default) | Subscriptions |
|---|---|---|---|---|
| lead | analysis | analyst / shared_readonly | tool_use+reasoning+long_context, minQuality 0.75, high effort | – (delegates to analysts, maxDepth 2) |
| code_change / architecture analyst | analysis | analyst / shared_readonly | +long_context, 0.7, high effort | – |
| historical_bug_analyst | analysis | analyst / shared_readonly | tool_use+reasoning, 0.65, medium | – |
| test_designer | design | test_author / isolated_worktree | +structured_output, 0.7 | `finding.created` (≥P2; product_defect/security/performance), `coverage.gap_detected` |
| executor | execution | test_executor / isolated_worktree | tool_use+structured_output, 0.6, low effort, taskType `execute_tests` (router ranks by tool reliability) | – |
| rca | diagnosis | test_executor / isolated_worktree | tool_use+reasoning, 0.7, high | `finding.created` (≥P2; product_defect/performance/security/unknown) |
| fixer | implementation | product_fixer / isolated_worktree | 0.75, **fallback fail_closed** | – |
| reviewer | review | test_executor / isolated_worktree | +structured_output+reasoning, 0.75, **independentFromRoles = `EVIDENCE_PRODUCER_ROLES`** (executor/test_designer/rca/fixer/metrics_analyst/environment) | `review.requested`, `finding.confirmed` (≥P1) |
| metrics_analyst | diagnosis | analyst / scratch | 0.65, medium | `finding.created` (performance, not its own findings) |
| environment | execution | environment_operator / scratch | tool_use, 0.6, **fail_closed** | – |
| condenser | analysis | read_only / scratch | tool_use+long_context, **0.5, cost cap $0.5/call** | – |
| vision_gui | execution | test_executor / scratch | tool_use+structured_output+**vision**, 0.65, taskType `gui_testing`; tools `browser.*`, `http.request`, findings/notes, `evidence.*` (no shell, files or environment control); prompt: DOM first, API second, screenshots judged visually last, computer use only when such a tool is offered (none by default), never guessed coordinates | – |
| local_private | analysis | test_executor / isolated_worktree | tool_use+structured_output, 0.55, **privacyClass restricted + dataClassification restricted** (the router's security stage admits only routes with `maxDataClassification: restricted`: local models), **fallback fail_closed**; read-repo tools, `test.run`, findings/notes, evidence reads; **deny** `http.request`, `browser.*`, `load.*`, `metrics.*` (no egress, even when a configuration widens the allowlist); prompt: never reproduce a restricted value in a record or output (`withheld` lists the kinds kept out) | – |

All subscriptions carry livelock guards (`maxPerRun`, `maxCausalDepth`); `work.expectedOutput` defaults to
the role `outputSchema`; `priority` is 0–100, higher = more urgent.

## Invariants enforced here

| Invariant | Where | Tests |
|---|---|---|
| Least privilege: allowlists only name known tools (typos rejected, no bare `*`, namespaced globs), no tool beyond the permission profile's effects (built-ins); any role holding `fs.write`/`fs.apply_patch`/`git.commit` must use `isolated_worktree` (built-in, override or custom) | `validation.ts`, roles | `test/roles.test.ts` (least privilege, worktree), `test/catalog.test.ts` (unknown tool/deny typo/wildcards, workspace-writing tools) |
| I8 structurally: only `test_designer` and `fixer` can write; executor/reviewer/RCA cannot; only the test designer proposes oracle changes | roles | `test/roles.test.ts` (I8 structurally, governance tools) |
| Every role terminates explicitly (`complete_work` and `fail_work`) | `validation.ts` | `test/catalog.test.ts` (cannot terminate) |
| Evidence-first output contracts: executions/observations cite `ev_…`; id lists are sets (a minimum count cannot be met by repeating one id); XPASS/NOT RUN are distinct non-pass outcomes; every review verdict is posted and approve/reject need inspected evidence; a confirmed root cause needs evidence and a stated one a posted hypothesis; `fixed` needs a SHA-shaped commit + passing regression; `readyForGate` needs a non-empty objective list with none open; an environment with a pending/unknown action is not ready; validated tests need two distinct (known-good + known-bad) evidence ids | `roles/*.ts` schemas | `test/roles.test.ts` (output contract tests) |
| Every prompt has the `{{protocol}}` slot, only known and well-formed placeholders, the universal discipline, names only tools the role holds and explains every tool it holds | `validation.ts`, `roles/shared.ts` | `test/roles.test.ts` (prompts …), `test/catalog.test.ts` (malformed placeholders) |
| I3 reviewer heterogeneity declared (`independentFromRoles`): independent from EVERY role that produces evidence, findings, test artifacts or fixes (a role holding a producing tool and missing from the list fails the test) | reviewer | `test/roles.test.ts` (reviewer, H10) |
| I12 livelock guards on every subscription; unique rule ids catalog-wide; self-trigger guard (`excludeFromRoles`), no contradictory actor filters | `validation.ts`, `catalog.ts`, `subscriptions.ts` | `test/roles.test.ts`, `test/catalog.test.ts` (ruleId reuse, actor filters), `test/subscriptions.test.ts` (self-trigger) |
| Immutability + pinning: roles deep-frozen, inputs never mutated, revision changes iff effective roles change | `catalog.ts` | `test/catalog.test.ts` (frozen, revision) |
| Config safety: prototype pollution, unknown roles/keys, dangling role references, reserved ids (`constructor`, `prototype`) and malformed options rejected with `invalid_argument` | `catalog.ts`, `validation.ts` | `test/catalog.test.ts` (fault injection section) |
| Template safety: single pass, no prototype lookups, event text neutralized (no live placeholder even across adjacent values) and bounded without cutting template instructions | `template.ts` | `test/template.test.ts` |
| Reactor filters fail closed | `subscriptions.ts` | `test/subscriptions.test.ts` |

## Contract changes (additive)

See the "Additive exports" block in `src/contracts.ts`: `RoleValidationOptions`, `RoleCatalogOptions`,
`RolePromptVars`, `SubscriptionSubject`, `RenderedSubscriptionWork`, the exports listed above, and doc
clarifications (`maxDepth` semantics, `ruleId` uniqueness, filter AND/fail-closed, priority scale,
`expectedOutput` default), `SubscriptionFilter.excludeFromRoles`, `WORKSPACE_WRITE_TOOL_IDS`, reserved role/rule
ids, and the `renderSubscriptionWork` bounds (UTF-16 units, data shortened first, no live placeholders). The condenser holds `fail_work` in addition to `complete_work` so it can hand
over to the deterministic condenser instead of producing an unfaithful summary.

(hardening) `EVIDENCE_PRODUCER_ROLES` export; the reviewer's default `independentFromRoles` now also names `fixer`,
`metrics_analyst` and `environment` (before, a reviewer could be routed to the provider that produced the fix or the
metric/environment evidence it judged, and the gate would then discard or — counting fewer producers — accept that
self-review).

(B1 governance completion) `DOMAIN_TOOL_IDS` gains `delegate.status`, `delegate.collect`, `delegate.message` and
`delegate.release` (the control plane's handles on background / continuable delegated children); the lead — the only
delegating role — holds them and its prompt explains `background` / `continuable` delegation.

(gate-governance) `DOMAIN_TOOL_IDS` gains `experiment.stop` (60 known tool ids). The lead, executor, environment and
vision_gui roles hold `experiment.define` / `experiment.stop` and their prompts say that writes, load and faults run
only for an active experiment (refused `experiment_required` otherwise); the test designer's prompt describes the whole
artifact lifecycle (static check, known-good on the base revision via `test.run` revision "base" or a recorded
`knownGoodUnavailableReason` — only a base-revision known-good lets the artifact decide a P0/P1 assertion —, a mutation
run of the candidate's PRODUCT source naming only its own file, the independent oracle consistency review); the
reviewer's prompt describes that review (`blackboard.post_review` on subjectRef `test_artifact`). Catalog revision
changes (prompts and tool lists). Tests: `test/roles.test.ts`, `test/tools.test.ts`.

(runtime-roles unit) Two built-in roles (catalog revision changes): `vision_gui` and `local_private` (above), their
output contracts `GUI_OUTPUT_SCHEMA` (`{summary, checks: [{check, method: dom|api|visual, outcome: passed|failed|error|
not_run, expected, actual, evidenceIds ≥ 1}], findings, screenshots}`) and `PRIVATE_OUTPUT_SCHEMA` (`{summary,
observations: [{statement, evidenceIds ≥ 1}], findings, withheld}`), `GUI_CHECK_METHODS`, `SPECIALIST_ROLES`;
`EVIDENCE_PRODUCER_ROLES` (and so the reviewer's default `independentFromRoles`) includes both; the lead's prompt names
them. Domain (additive): `BuiltinRole` gains `vision_gui` | `local_private`. Tests: `test/roles.test.ts` (vision_gui /
local_private sections, prompts, least privilege, reviewer independence), `test/catalog.test.ts`.

**Known limit (`local_private`).** The role keeps restricted data off hosted models only for what it writes itself.
Evidence its tools record (for example `test.run` output) is stored with the default classification `internal`, and
`evidence.get` returns a preview of it to any agent of the run, including agents on hosted routes. Until evidence is
recorded with the agent's classification and evidence reads check the reader's clearance (tools and control), the
role's prompt tells it to run only checks whose output prints no restricted value and to cite evidence by id.

## Testing

```bash
npx tsc -p packages/agents --noEmit
node scripts/run-tests.mjs --package agents        # hermetic unit tests (no infra, no SQL: the package is stateless)
```
