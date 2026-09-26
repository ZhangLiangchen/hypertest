# @hypertest/tools

The Tool & Capability Runtime and the testing execution plane. Every tool call an agent makes passes one
deterministic pipeline (capability → policy permit → freshness → operation ledger → evidence → events), so
the model can explore freely while side effects, truth and audit stay outside the model (I1, I4, I9, I10).

Depends on `@hypertest/core`, `@hypertest/domain`, `@hypertest/evidence`, `@hypertest/operation` and
`@hypertest/policy`. The binding ABI is [`src/contracts.ts`](src/contracts.ts). The package has two halves:

- **Part 1 (this section)**: runtime, registry, workspaces, sandboxes, white-box tools — `src/whitebox/**`.
- **Part 2**: black-box tools and side-effect adapters — `src/blackbox/**` (see its section below).

The halves meet at one export: `src/blackbox/index.ts` exports `blackboxTools(options): ToolSpec[]`, and
`builtinTools(options)` returns the white-box specs plus `blackboxTools(options)` (imported statically: a
renamed export is a compile error, never a silently smaller catalog; duplicate ids ⇒ `conflict`).

---

## Part 1 — runtime, registry, workspaces, sandbox, white-box tools

### Public API

| Area | Exports |
|---|---|
| Registry | `ToolRegistry` (`register`, `get`, `getByName`, `list`, `definitionsFor`, `revision`), `toolIdToName`, `toolNameToId`, `assertValidToolId` |
| Runtime | `createToolRuntime(deps)`, `redactSecrets`, `utf8Head`, `utf8Tail`, `DEFAULT_MAX_INLINE_BYTES` (16 KiB), `SECRET_KEY_PATTERN`, `SIDE_EFFECT_SETTLE_MS` |
| Environments | `createEnvironmentRegistry(initial?)` (in-memory `EnvironmentRegistry` for `ToolRuntimeDeps.environments`) |
| Workspaces | `createWorkspaceManager(deps)`, `workspaceIdFor`, `confineExisting`, `normalizeRel`, `workspaceResource` |
| Sandboxes | `createLocalSandbox(options?)`, `createOciSandbox({ image, docker?, user? })`, `buildDockerArgs`, `dockerNetwork`, `dockerCliEnv`, `dockerContainerEnv`, `allowlistedEnv`, `spawnProcess`; trusted git: `SAFE_GIT_CONFIG`, `trustedGitEnv`, `TRUSTED_GIT_ENV_KEYS` |
| Runners | `nodeTestRunner`, `vitestRunner`, `jestRunner`, `pytestRunner`, `goTestRunner`, `commandRunner({ command, allowNoCases? })`, `defaultTestRunners()`; parsers `parseJunitCases`, `parseJestJson`, `parseGoTestJson`, `applyPytestSummary`; `buildResult` |
| Coverage | `parseCoverageJson` (coverage.py), `parseLcov`, `parseCobertura`, `parseGoCoverProfile`, `parseCoverage`, `detectCoverageFormat` |
| Mutation | `generateMutants(file, source, language, { operators? })`, `applyMutant`, `selectMutants`, `maskSource`, `runMutationAnalysis(input)`, `classifyMutantRun`, `MUTATION_OPERATORS` |
| Tools | `builtinTools(options)`, `whiteboxTools(options)`, `DEFAULT_SHELL_ALLOWLIST`, `shellDenial`, `patchPaths`, `parseNumstatPaths`, `assertNotGitMetadata`, `selectRunner`, `extractSymbols` |
| XML | `parseXml`, `decodeEntities` (small tolerant parser used for JUnit and Cobertura) |

### Runtime pipeline (`createToolRuntime(deps).execute(request)`)

Domain outcomes never throw; every denial yields a `ToolExecutionResult` plus a `tool.denied` event with
the reason. In order:

1. **Lookup** — unknown tool ⇒ `denied` / `not_found`.
2. **Input schema** (`compileSchema`) on a private deep copy of the input ⇒ `failed` / `schema_violation`;
   the issues are in the model text. The copy is what gets classified, authorized and executed (a caller
   mutating `request.input` mid-pipeline changes nothing). A workspace handle whose `resourcePrefix` is not
   `workspace/<its workspaceId>` ⇒ `denied` (`workspace_handle_inconsistent`): scopes derive from it.
3. **Capability authenticity and binding** — `verifyCapability(cap, deps.capabilitySecret)`; the
   capability's run, subject agent and work item must equal the request's (no confused deputy) ⇒ `denied`.
4. **Classification + scope** — effect / risk (static or computed from the input), `resources(input)`,
   `environmentClass(input)`; `capabilityAllows` ⇒ `denied` with its reason (tool, effect, risk,
   non-canonical or out-of-scope resource, environment). A `resources()` that throws ⇒ `denied`.
5. **Permit** — `policy.evaluate` on the input with every key matching
   `/secret|token|password|api[_-]?key|authorization/i` redacted; recorded in the decision log **before**
   execution. `deny` ⇒ `denied`; `approval_required` ⇒ `denied` with error code `approval_required` and the
   approval reference (`permit.approvalId`, else the decision id) in the text. Permit constraints are
   enforced: `allowedPaths` (every resource must match), `maxDurationMs` (caps the timeout),
   `allowedCommands` (shell.exec / test.run command). A throwing engine, a malformed permit or an
   unrecordable decision ⇒ fail closed (never executed).
6. **Freshness** — effects beyond `read`/`record` with `deps.freshness` and `request.snapshot` ⇒
   `freshness.validate`; stale (or a throwing guard) ⇒ `stale_context` listing the stale entries.
7. **`tool.called`** `{toolId, invocationId, effect, riskClass, resources, permitDecisionId}` — if it cannot
   be written the tool is not executed (`failed` / `unavailable`).
8. **Execution** — side-effect tools (`spec.sideEffect`) run **only** through
   `deps.sideEffects.run({ toolInvocationId: invocationId, adapterId, operationType, input, target, lease:
   { resourceKey: target.resourceKey, owner: agentId }, … })`; `spec.execute` is never called for them.
   The target's resourceKey must be one of (or beneath) the authorized `resources(input)`, else
   `failed`/`permission_denied` before anything is prepared.
   `verified` ⇒ `success` (structured = result), `pending` ⇒ `pending` + `operationId`, `not_applied` /
   `failed` / `manual_review` / `stale_fence` ⇒ `failed` with that code. On timeout/abort the gateway's
   signal is aborted and it gets `SIDE_EFFECT_SETTLE_MS` (5 s) to record the interruption: an interrupted
   dispatch comes back as `pending` with its operation id (`outcome_unknown`), never as a bare timeout that
   would invite a duplicate call; if the gateway does not answer, the timeout/cancel text tells the model not
   to re-issue the action (re-running the same invocation reconciles it). Other tools run `spec.execute`
   under `withTimeout(min(request.timeoutMs, spec.timeoutMs, permit.maxDurationMs))` and the request
   signal: timeout ⇒ `timeout`, abort ⇒ `failed`/`cancelled`, `HypertestError` ⇒ `failed` with its code,
   anything else ⇒ `failed`/`internal` (logged). Tools without a side-effect binding get an
   **observe-only** view of the gateway (`run`/`compensate` ⇒ `permission_denied`).
9. **Output schema** — a `success` whose `structured` violates `outputSchema` ⇒ `failed`/`schema_violation`.
10. **Model text (I9)** — `text ?? JSON(structured)`; above `maxInlineBytes` (default 16 KiB) the full text
    goes to the ArtifactStore (`text/plain`) with a `tool-output` evidence record, and the model sees
    head (≤ max/2) + `…[output truncated: <n> bytes; full output artifact <uri> evidence <id>]` + tail
    (≤ max/4), cut on UTF-8 boundaries. Evidence ids produced by the call are always appended:
    `[evidence: ev_…]`.
11. **`tool.completed`** `{toolId, invocationId, status, durationMs, evidenceRefs, operationId,
    artifactRefs}` (`tool.denied` when the tool itself returned `denied`).

`ctx.recordEvidence` fills `producer {agentId, workerId, runtimeManifestId}`, `workItemId`, `agentId`,
`toolInvocationId`, and provenance `{toolId, toolInvocationId, workspaceId, commit: workspace.baseCommit}`
(tool-supplied `command`/`target`/`inputsHash` are kept; `toolId`/`toolInvocationId`/`workspaceId` cannot be
spoofed). Events carry the request's `runId`, `workItemId`, `agentId`, `correlationId`, `causationId`.

Idempotency: re-executing an invocation id re-runs read-only tools; for side-effect tools the gateway finds
the same operation by `(toolInvocationId, operationType)`, so there is never a second external effect.

### Registry

Ids are dotted (`fs.read`, `mcp.srv.tool`), segments `[A-Za-z0-9_-]`, no `__` (reserved), model name ≤ 64
chars. Model-visible name = `id.replaceAll('.', '__')`. `definitionsFor(capability, allow, deny)` includes a
tool iff an allow pattern matches, no deny pattern matches and `capability.tools` allows it (sorted by id).
`revision()` = sha256 of the canonical, id-sorted `[id, inputSchema, outputSchema, effect, risk]`
(computed effect/risk ⇒ `'dynamic'`); descriptions do not change it. Duplicate id ⇒ `conflict`.

### Workspaces

Deterministic layout (a restarted process re-attaches by calling the creators again; `get()` only knows
workspaces created or re-attached by this instance; concurrent creators for the same slot are serialized
in-process):

| Kind | Root | Notes |
|---|---|---|
| `sharedSnapshot({commit})` | `<baseDir>/<runId>/shared/<commit12>` | `git worktree add --detach`; read-only |
| `sharedSnapshot()` (no commit) | the repo path itself (no copy) | read-only; `baseCommit` = HEAD when it is a git repo |
| `isolatedWorktree` | `<baseDir>/<runId>/wt/<workItemId>` | branch `ht/<runId>/<workItemId>`; an existing valid worktree is reused; the base commit is stored in `<baseDir>/<runId>/meta/<workspaceId>.json` **before** `worktree add`, so a re-attach never resets the branch nor follows a moved HEAD; a different `baseCommit` ⇒ `conflict` |
| `scratch` | `<baseDir>/<runId>/scratch/<workItemId>` | plain directory |

`workspaceId = 'ws_' + sha256(slot).slice(0, 16)`, `resourcePrefix = 'workspace/<workspaceId>'`, and every
handle gets a private `tempDir` (`<baseDir>/<runId>/tmp/<workspaceId>`, outside the root) for the sandbox
HOME/TMPDIR, test reports and mutation copies. `resolvePath` rejects absolute paths, `~`, NUL, `..` escapes
and symlinks leaving the root (the deepest existing ancestor is realpath-checked). `diff` = `git diff <base>`
plus every untracked file via `git diff --no-index /dev/null <f>` (nothing is staged); it only accepts
handles this manager created or re-attached, and runs with `GIT_DIR`/`GIT_WORK_TREE` pinned at creation from
the repository's own metadata (`<common>/worktrees/*/gitdir`), so a rewritten `.git` pointer in the
(agent-writable) root can never point trusted host-side git at attacker config (filters would run outside
any sandbox). Dangling or looping symlinks are refused (`permission_denied`), never followed. `dispose`
removes worktrees (`git worktree remove --force` + prune) and scratch/temp dirs; the repository, the work
branch **and its meta file** are kept, so re-creating the workspace re-attaches the branch at its recorded
base instead of resetting it (`-B`) and losing the agent's commits. All git invocations disable fsmonitor,
hooks, external diff, pager, signing and transports; trusted (host-side) git runs with a minimal environment
(`TRUSTED_GIT_ENV_KEYS`: PATH, HOME, git config locations, proxy/CA settings) so repository filters never
see the orchestrator's secrets.

### Sandboxes

`createLocalSandbox({ killGraceMs = 2000, maxOutputBytes = 4 MiB })` (process groups still running when the
host process exits are SIGKILLed by an exit hook, so nothing outlives it): argv without a shell, cwd confined to
the root, environment = the profile's `envAllowlist` values from the parent + `PATH`, `HOME` (private home in
the workspace tempDir), `LANG`, `TMPDIR` + the caller's explicit `env` — nothing else from the parent.
Detached process group; timeout ⇒ SIGTERM to the group, SIGKILL after the grace period; abort ⇒ same, then
rejects with the abort reason; members left in the group when the command exits are killed; stdout/stderr
capped per stream with truncation flags; stdin supported; a missing program ⇒ exit 127 + `spawnError`.
A workspace whose profile says `kind: 'oci'` is refused (`precondition_failed`) — never silently run as a
host process. Limitation: a process that calls `setsid` leaves the group (no cgroup isolation locally; use
OCI), and the local sandbox cannot enforce `network` or read-only roots.

`createOciSandbox({ image })`: `docker run --rm --network none|bridge -v <root>:/workspace[:ro]
-v <tempDir>:<tempDir> -w … --user uid:gid [--cpus] [--memory] --security-opt no-new-privileges
--cap-drop ALL --env NAME…`; env values travel in the CLI's environment, never argv. The CLI process gets
`dockerCliEnv`: PATH, the parent's `DOCKER_HOST`/`DOCKER_CONTEXT`/TLS settings and `DOCKER_CONFIG` pinned to
the parent's config dir (the container's HOME must not relocate it); `DOCKER_*` names are never forwarded
into the container and no other parent variable is inherited. `egress_allowlist` cannot be enforced by
plain docker and maps to `none` (fail closed). `available()` probes `docker info`; timeout/abort also
`docker kill`s the container.

### White-box tools

| Tool | Effect/risk | Notes |
|---|---|---|
| `fs.read` | read/low | line ranges, `maxBytes`, binary detection, sha256 |
| all `fs.*` | | a path with a `.git` segment (any case) ⇒ `permission_denied`: git metadata only via `git.*` (a rewritten worktree `.git` pointer would redirect commits and trusted git) |
| `fs.list` | read/low | depth ≤ 5, glob (basename when no `/`), `.git`/`node_modules` skipped, symlinks not followed |
| `fs.search` | read/low | ripgrep `--json` in the sandbox; built-in scan when `rg` is missing |
| `fs.write` | write_workspace/medium | read-only workspace ⇒ `permission_denied`; symlink-escape checked after mkdir |
| `fs.apply_patch` | write_workspace/medium | header paths (hunk bodies skipped by their counts) are confined first; `-p1` only when EVERY header name has an `a/`/`b/` prefix, else `-p0` (a no-prefix git patch at `-p1` would land on another path); `git apply --check`, then `git apply --numstat` must name only declared paths, then apply via stdin; `check: true` validates only |
| `git.status` / `diff` / `log` / `show` / `blame` | read/low | revisions validated (no leading `-`); non-empty diffs recorded as `git-diff` evidence; in a `scratch` workspace `GIT_CEILING_DIRECTORIES` stops git from discovering an enclosing repository (e.g. a baseDir inside the target repo) |
| `git.commit` | write_workspace/medium | isolated worktree only, and only while HEAD is the workspace's own `refs/heads/ht/<run>/<wi>` (else `permission_denied`); with `paths` exactly those paths are committed (`commit --only`), other staged changes stay staged; `files` = what the commit contains; author/committer "Hypertest Agent"; `--no-verify`, hooks disabled |
| `shell.exec` | execute/medium | `command[0]` must be a bare name in the allowlist (default: node npm npx python3 python pytest go git ls cat grep rg sed awk head tail wc diff make — no shells) ∩ permit `allowedCommands`; else `denied`/`permission_denied`; resources always include the workspace root (a program can touch anything, whatever its cwd); stdout/stderr evidence; non-zero exit is a successful call |
| `test.run` | execute/medium | runner auto-detection: vitest, jest (package.json), node:test (test files / `node --test` script), pytest (ini/pyproject/conftest/test_*.py), go (go.mod); `framework: 'command'` runs an allowlisted command and is never `passed` (there is no agent-controlled `allowNoCases`) |
| `coverage.collect` | execute/low | parses a report in the workspace ⇒ `coverage` evidence (absolute paths made relative) |
| `mutation.run` | execute/medium | see Mutation below ⇒ `mutation-result` evidence; resources: root + file (it copies and executes the whole suite) |
| `code.symbols` / `code.references` | read/low | `options.retrieval` when given, else a regex scan (TS/JS, Python, Go) |

**test.run evidence**: `stdout`/`stderr`, the raw report as an artifact (`rawReport {uri, sha256}` in the
payload), and a `test-result` record whose structured payload is the `TestRunResult` (+ `testArtifactId`).
With several `testArtifactIds` one `test-result` record is written **per artifact** (the QualityGate reads
the singular `testArtifactId`, so an ineligible artifact can never ride along with an eligible one).
`coverage: true` adds a `coverage` record (CoverageMap payload, gate-readable `totals.lines/branches`).

**Fake-green guards** (`TestRunResult.passed`): true only with exit 0, no harness error, ≥ 1 passed case and
no failed/error/xpass case; skipped and xfail never make a run green on their own. node:test reports a file
that registered no test as a *passing* pseudo-case named after the file — it is dropped (a failing one is a
harness `error`). pytest exit 5 / collection errors, go build failures and unfinished tests, suite-level
jest/vitest failures and any non-zero exit without a failing case are `harnessError`s. `commandRunner`
reports `cases: []` and is never `passed` unless the trusted runner option `allowNoCases` is set (and exit
0) — it is not reachable from the model (test.run has no such input; configure it via
`BuiltinToolOptions.runners`). node's junit reporter carries no file attribute: in a multi-file node:test run
case ids are the (suite-qualified) test names, so same-named tests in different files share an id (both
statuses are kept; use a `file::pattern` selector for file-qualified ids).

**Selectors**: node `file::name-regex` | test file | name regex (`--test-name-pattern`); vitest/jest
`file::pattern` | file | `-t pattern`; pytest nodeid/path | `-k` expression; go `pkg::-run regex` |
`./pkg/...` | `-run` regex over `./...`. Selectors starting with `-` are rejected (argument injection) and
file parts must stay inside the workspace. pytest runs as `python3 -m pytest`, falling back to a `pytest`
executable; xpass (non-strict) comes from the `-rxX` summary. go runs with `GOTOOLCHAIN=local`,
`GOPROXY=off`, `GOFLAGS=-mod=readonly`, `CGO_ENABLED=0` and the host build cache.

**Coverage parsers**: coverage.py JSON (`summary.covered_lines/num_statements`, branches from
`num_branches/covered_branches` when measured, else from the branch arrays), LCOV (LF/LH/BRF/BRH, DA/BRDA
fallbacks, repeated records merged), Cobertura (per-file lines, `condition-coverage` on branch lines; a
root `branch-rate="0"` without condition data stays unknown), Go coverprofile (statement-weighted,
duplicate blocks merged). Branch data that a report does not carry is `'unknown'`, never 0; one unknown file
makes the branch total unknown.

**Mutation**: `generateMutants` masks comments, strings, template and regex literals (offsets preserved)
and skips import/require lines; operators arithmetic (`+↔-`, `*↔/`), relational (`<↔<=`, `>↔>=`, `==↔!=`,
`===↔!==`; bare `<`/`>` only as spaced binary operators, so generics/arrows/shifts are untouched), logical
(`&&↔||`, `and↔or`), boolean flip, numeric literal ±1, return value (`null`/`None`/`nil` for simple
returns; Go only for identifiers), off-by-one (drop `± 1`). Ids `m<nnn>-L<line>-<operator>`, deterministic
order (position, operator, replacement), evenly spread cap. `runMutationAnalysis` copies the workspace once
into the private temp dir (`.git` excluded; each `node_modules` mirrored entry by entry with symlinks, where
links INTO the workspace — npm/pnpm/yarn workspace packages — are re-pointed at the copy, so tests that
import a package by name exercise the mutant; absolute in-workspace symlinks are re-pointed likewise; a
mutation target whose real path is outside the copy ⇒ `precondition_failed`, so a mutant is never written
into the original), requires a **passing baseline**
(otherwise `precondition_failed` — failures would be fake kills), then per mutant writes, runs, classifies
(killed = tests fail without a harness error; survived = pass; error = build failure/timeout/no cases) and
restores. score = killed / (killed + survived), 0 when nothing was decidable. The workspace is never touched.

### Invariants and where they are proven

| Invariant | Tests |
|---|---|
| I1 no execution without capability + permit (+ freshness for mutating effects); every denial path returns a result and a `tool.denied` event: unknown tool, schema, forged/unsigned/foreign-secret capability, run/agent/work-item mismatch, tool/effect/resource scope miss, policy deny, approval_required, permit `allowedPaths`, stale context, throwing policy engine / freshness guard, unrecordable decision, unwritable audit event | `test/runtime.test.ts` (fault injection: each check removed ⇒ its test fails) |
| I1 secrets redacted before policy evaluation and decision logs | `test/runtime.test.ts` › redaction |
| I4 side effects only via the SideEffectGateway; same invocation id twice ⇒ one external effect; pending never re-dispatched; not_applied mapped; read tools cannot dispatch; a target outside the authorized resources is refused | `test/runtime.test.ts` (real `createSideEffectGateway` over PGlite/PostgreSQL) |
| I9 offload: > 16 KiB ⇒ artifact + `tool-output` evidence + bounded head/marker/tail text | `test/runtime.test.ts` › offload |
| I10 `tool.called`/`tool.completed`/`tool.denied` with run/work item/agent/correlation/causation; evidence producer/provenance | `test/runtime.test.ts` |
| Path confinement: absolute, `..`, symlink escapes (existing and not-yet-existing targets) | `test/workspaces.test.ts`, `test/whitebox-tools.test.ts` (fs.read/fs.write/fs.apply_patch) |
| Worktree isolation, idempotent re-attach across restarts (branch never reset), concurrent creators, diff incl. untracked, dispose keeps the repo | `test/workspaces.test.ts` |
| Sandbox: env scrubbing (parent secret invisible), process-group kill incl. grandchildren, SIGKILL escalation, orphan reaping, abort, truncation, stdin, cwd confinement, no shell | `test/sandbox.test.ts` (fault injection verified) |
| Fake-green: zero tests, empty-file pseudo-cases, load errors, collection errors, build failures, command runner | `test/runners.test.ts`, `test/coverage.test.ts`, `test/whitebox-tools.test.ts` |
| Unknown branch coverage never reads as 0 | `test/coverage.test.ts` |
| Mutation: good test kills, weak test kills none, failing baseline refused, workspace untouched | `test/mutation.test.ts`, `test/whitebox-tools.test.ts` |
| Shell allowlist (no shells, no paths, permit `allowedCommands`), git hooks never run, read-only workspaces refuse writes | `test/whitebox-tools.test.ts` |
| Review regressions (each verified by reverting the fix): `.git` never written/read via fs.* · git.commit only on the work branch and only the requested paths · no agent-controlled `allowNoCases` · no-prefix patches never re-rooted (+ numstat check) · shell.exec scoped to the root · nested scratch never sees the enclosing repo | `test/whitebox-tools.test.ts` › review regressions |
| Trusted git: parent secrets never reach repository filters; a rewritten `.git` pointer cannot redirect it; unregistered handles refused; dispose + re-create keeps the agent's commits; dangling/looping symlinks refused | `test/workspaces.test.ts` › review regressions |
| Local sandbox never downgrades an OCI profile; docker CLI env | `test/sandbox.test.ts` |
| I1 input bound at validation; inconsistent workspace handle refused; I4 interrupted side effect ⇒ `pending`/`outcome_unknown` with its operation id, same-invocation retry ⇒ one external effect | `test/runtime.test.ts` › review regressions |
| Mutation in a monorepo exercises the mutant; a mutant is never written into the original through a symlink | `test/mutation.test.ts` |

### Contract changes (additive, backward compatible)

- `WorkspaceHandle.tempDir?` — private per-workspace directory outside the root.
- `ProcessResult.spawnError?` — set when the program could not start (exit code 127).
- `SandboxRunner.kind?` and `SandboxRunner.available?()`.
- Documented (no signature change): `SideEffectBinding.target()` must name one of (or a resource beneath)
  the tool's `resources(input)`.
- New types: `MutationOperator`, `MutationLanguage`, `Mutant`, `MutantStatus`, `MutationAnalysisResult`,
  `LocalSandboxOptions`, `OciSandboxOptions`, `TestRunnerOptions`.
- `BuiltinToolOptions.stateDir?` — passed through `builtinTools()` to the black-box tools (load job state).

### How to test

```bash
npx tsc -p packages/tools --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package tools                            # PGlite
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package tools  # PostgreSQL 16 (.infra/env)
```

The runner tests use real `node --test`, `pytest` (skipped with a reason when neither `python3 -m pytest`
nor `pytest` exists) and `go` (skipped when absent). The OCI execution test skips with a reason when
`docker info` fails; the docker argv construction is tested hermetically.

---

## Part 2 — black-box tools and side-effect adapters

Owned by the black-box implementer (`src/blackbox/**`, tests prefixed `blackbox-`). Black-box tools probe a
running system under test (SUT) through its public surface — HTTP APIs, metrics, load, environment control,
a browser, MCP servers — and turn every observation into evidence. Everything that changes the outside
world beyond a single probe (load jobs, restarts, deploys, faults) is a `SideEffectAdapter` driven by the
`SideEffectGateway`, so a crashed or retried caller reconciles by operation id instead of acting twice (I4).

### Public API (`src/blackbox/index.ts`)

| Export | Purpose |
|---|---|
| `blackboxTools(options: BlackboxToolOptions): ToolSpec[]` | `{ stateDir; httpAllowlist?; enableBrowser?; chromiumPath?; mcpServers? }` → the catalog below (browser only when `enableBrowser`; MCP `allowTools` as lazily-connecting specs). `stateDir` is optional at runtime because `builtinTools()` passes `BuiltinToolOptions`. |
| `builtinSideEffectAdapters({ stateDir, environments, kubectl?, docker? })` | `load.http`, `load.http.stop`, `env.control` (router used by the env tools) and its backends `env.process`, `env.docker`, `env.kubectl`. |
| `createEnvironmentRegistry(initial?)` | Re-export of the part-1 in-memory registry (`bumpGeneration` increments generation, optional new buildDigest). |
| `HttpLoadAdapter`, `HttpLoadStopAdapter`, `observeLoadJob`, `stopLoadJob`, `loadJobDir`, `LOADGEN_WORKER_PATH`, `loadStartTool({ httpAllowlist? })` | Built-in load generator as an external job. |
| `ProcessEnvAdapter`, `DockerEnvAdapter`, `KubectlEnvAdapter`, `EnvControlAdapter` | Environment control adapters. |
| `startProcessSupervisor(options)` (+ `process-supervisor-cli.ts`), `CONTROL_TOKEN_HEADER` | Tiny reusable supervisor for local SUT processes (restart, kill, proxy-level fault injection) with a token-protected control API. |
| `BrowserSessionManager`, `browserTools()`, `chromiumExecutablePath()`, `BrowserEgressGuard`, `BlockedRequest` | Playwright (playwright-core) browser fallback with a context-wide egress guard. |
| `McpToolBridge`, `mcpToolId`, `normalizeMcpSchema` | MCP stdio bridge. |
| `parsePrometheusText`, `histogramQuantile`, `summarizeMetrics`, `parsePrometheusApiResponse` | Pure metric parsers. |
| `checkEgress`, `checkHost`, `controlEndpointReason`, `CONTROL_PATH_PREFIX`, `hostMatches`, `isLoopbackHost`, `environmentClassForUrl`, `joinUrl`, `splitControlTarget`, `publicControlTarget`, `redactHeaders`, `redactUrl`, `redactJsonSecrets` | Egress guard, control-target and redaction helpers. |
| `closeBlackboxResources()` | Closes lazily created MCP servers and the default browser manager (shutdown/tests). |

### Tool catalog

| Tool | Effect / risk | Resources | Notes |
|---|---|---|---|
| `http.request` | read/low for GET/HEAD/OPTIONS, else external/medium | `env/<id>` or `url/<host>` | `url` or `environmentId`+`path` (joined under the baseUrl path prefix; `..`/`%2e%2e` segments are normalized first and may not climb above it or change the origin). Non-2xx is `success` (domain outcome). Redirects are returned, never followed. Non-idempotent methods get `Idempotency-Key: <invocationId>` unless set; they are testing actions on a sandbox SUT, governed by capability + policy, **not** routed through the gateway. `api-response` evidence: artifact = full response body; structured = redacted request (credential headers, secret-named query params and JSON body fields ⇒ `[REDACTED]`) and response (body text truncated at 1 MiB), duration. Timeouts (`timeout`) and connection failures (`failed`/`unavailable`) are recorded too; a body that breaks off after the status line keeps the bytes read and sets `bodyError` (never a silent short body). |
| `metrics.query` | read/low | `env/<id>` or `url/<host>` | PromQL instant (`time`) or range (`range`) against `prometheusUrl` / the environment's; values parsed to numbers (non-finite spelled `NaN`/`+Inf`/`-Inf`); raw JSON as `metric` evidence; Prometheus errors ⇒ `failed` `prometheus_<errorType>`. |
| `metrics.scrape` | read/low | as above | Text exposition (HELP/TYPE, escaped labels, NaN/±Inf, timestamps, histogram `_bucket/_sum/_count`) ⇒ families, samples, **p50/p95/p99 per histogram family** (Prometheus `histogram_quantile` interpolation over buckets summed across label sets), counter totals; raw text as `metric` evidence with that summary. A body that breaks off mid-stream ⇒ `failed`/`unavailable` (partial metrics would silently drop series). |
| `load.start` | external/high, adapter `load.http` | `env/<id>`/`url/<host>`, `loadgen/<host>` | Open-loop HTTP load job; returns `pending` + operation id. Egress guard enforced when the runtime derives the target (before any operation is prepared) ⇒ `failed`/`permission_denied`. GET/HEAD with a body, duplicate header names and a caller-set `X-Hypertest-Operation` are refused; header names are lower-cased. |
| `load.observe` | read/low | `loadjob/<opId>` | `ctx.sideEffects.observe` ⇒ `pending` (progress) / `success` (results) / `failed`. A completed job's results are recorded **once** per (run, operation) as `metric` evidence with the operation id (marker in `<stateDir>/load-evidence/`). A job of another run ⇒ `failed`/`permission_denied`, nothing reported. |
| `load.stop` | external/medium, adapter `load.http.stop` | `loadjob/<opId>` | Stops a running job as its own governed operation (see design notes). Environment class = the job's. A job of another run is refused (`permission_denied` at prepare, `not_applied` at dispatch). |
| `env.restart` | destructive/high, adapter `env.control` | `env/<id>` | process / docker / kubectl by the environment's `control.kind`. |
| `env.inject_fault` | destructive/high | `env/<id>` | `latency {ms, jitterMs?, probability?}` or `error_rate {rate, status?}` for `durationMs` (process environments; supervisor proxy). |
| `env.deploy` | destructive/critical | `env/<id>` | process: restart with `BUILD_REF`; kubectl: the image of ONE container = buildRef (see Environment control). Critical ⇒ approval under the default policy. |
| `browser.navigate` / `.text` / `.screenshot` | read/low | `env/<id>`/`url/<host>`, `browser/<session>` | One context per (runId, agentId), pages per `sessionId`, idle timeout; screenshot ⇒ `screenshot` evidence (image/png). Requests the guard refused are listed in `blockedRequests`. |
| `browser.click` / `.fill` | external/medium | `browser/<session>` (+ `env/<id>`) | Pass `environmentId` so policy can classify it; the page must be on that environment's origin. A navigation/request the interaction triggers off the allowlist is aborted and reported in `blockedRequests`. |
| `mcp.<server>.<tool>` | per server config (default external/medium) | `mcp/<server>/<tool>` | `callTool`; text parts joined; `structuredContent` kept; `isError` ⇒ `failed` `mcp_tool_error`. |

**Egress guard** (`checkEgress`; http, metrics, load.start, browser): `permit.constraints.allowedHosts` is a hard
upper bound; within it a host is allowed when it is an origin of the addressed registered environment, on
`httpAllowlist` (`*`, `*.domain`, `host`, `host:port`), or loopback while the environment class is `local`.
A URL's environment class is that of the registered environment owning its origin, else `local` for
loopback, else undefined (the default policy then denies effects). On top of that the **environment-control
plane is never a probe target**: the reserved `/__hypertest` namespace on any host and the control target of
every registered process environment are refused, so an agent allowed to probe an environment
(`http.request` POST is external/medium) cannot restart, kill or fault it outside the governed env.* tools
(destructive/high) and the Operation Ledger. The browser applies the guard of the session's last
`browser.navigate` to **every** request of its context (Playwright `route` + `routeWebSocket`): redirects,
link clicks, form posts, popups and subresources off the allowlist are aborted (`blockedbyclient`); a
context that never navigated sends nothing (fail closed).

### Load generator

- `src/blackbox/loadgen-worker.ts` runs as `node --no-warnings loadgen-worker.ts <jobDir>` (node built-ins
  only). It installs its SIGTERM handler, writes `pid`, rewrites `status.json` every 500 ms
  (`state running|completed|failed|stopped, startedAt, updatedAt, sent, ok, errors, latencyMs{p50,p95,p99,max,mean}, achievedRps, statusCodes, …`)
  and `results.json` on completion (+ cumulative latency histogram buckets). Files are written atomically.
  Scheduling is open-loop (request *i* at `t0 + i/rate`), at most `concurrency` in flight, latency measured
  from the scheduled time (coordinated-omission corrected). Every request carries `X-Hypertest-Operation`.
  A `stop-*.json` marker in the job directory is a **durable stop request**: honoured at startup (before any
  request — a stop is never overtaken by a slow launch) and on every status tick (a stop whose signal was
  lost still takes effect within ~500 ms).
- `HttpLoadAdapter` (`load.http`; native idempotency, lookup by operation id, compensation, deterministic,
  risk high): the job directory `<abs stateDir>/loadjobs/<operationId>/` **is** the external effect (always
  absolute: the worker runs with it as cwd). `dispatch` claims it with an exclusive `mkdir` (an existing
  directory ⇒ receipt for the existing job, never a second worker), writes `spec.json` (+ desiredStateHash
  and the launching `runId`), spawns the worker detached (`unref`, stdio → `worker.log`, scrubbed env) and
  records `launch.json`; any failure before a successful spawn removes the claim ⇒ `not_applied`. `observe`:
  no directory ⇒ `absent`; corrupt `status.json`, `completed` without results, or a directory without a
  worker after `launchGraceMs` ⇒ `uncertain`; `running` with a dead pid (pid reuse checked via
  `/proc/<pid>/cmdline` containing `loadjobs/<operationId>`, independent of how the state dir is spelled) ⇒
  `failed`. `verify`: completed ⇒ verified (results); starting/running ⇒ pending (progress); stopped/failed
  ⇒ failed. `compensate`: SIGTERM (only once the worker wrote its own pid), SIGKILL after `stopWaitMs`; a
  finished job is left alone.
- `HttpLoadStopAdapter` (`load.http.stop`): dispatch writes `stop-<stopOperationId>.json` (the lookup key and
  the durable stop request), then SIGTERMs the worker; verify ⇒ verified once the job is terminal or its
  worker is gone.

### Environment control

- `startProcessSupervisor({ command, cwd?, env?, port?, stateFile?, controlToken?, … })` owns one child
  (listening on `$PORT`) and one listener: `/__hypertest/*` control API (`POST restart` / `POST faults` keyed
  by `X-Hypertest-Operation`, idempotent per operation id; `GET operations/<id>` ⇒ 404 | record; `GET status`;
  `POST kill`; `DELETE faults`) and a reverse proxy for everything else, where latency / error-rate faults
  are injected (so faults work for any child). **Mutating control endpoints require
  `X-Hypertest-Control-Token`** (401 otherwise; random token unless `controlToken` is given): the control API
  shares its port with the SUT proxy. Use `supervisor.url` as the environment `baseUrl` and
  `supervisor.controlUrl` (= `controlBaseUrl#token=<token>`; the fragment is never sent over the wire) as
  `control.target` — treat it as a secret (registry, not prompts). Restart env overrides are allowlisted
  (default `BUILD_REF`). With `stateFile`, operation records are persisted synchronously (tmp + rename, in
  order) so lookups survive a supervisor restart. `process-supervisor-cli.ts [--port N] [--state-file F]
  [--control-token T] … -- <cmd…>` runs it as its own process (so it outlives a crashed Hypertest) and prints
  `{url, controlUrl, controlBaseUrl, port, childPid, generation}`.
- `ProcessEnvAdapter` (`env.process`; native idempotency + lookup by operation id; deterministic; high). The
  token is taken from the registry at dispatch time and sent as a header; it never enters the desired state
  (hash), the ledger target or a receipt. A 400/401/403/404/413/422 answer ⇒ `not_applied`.
- `DockerEnvAdapter` (`env.docker`): `docker restart <container>`; no lookup by operation id ⇒ `best_effort`;
  observe compares `State.StartedAt` with the dispatch time (receipt, else operation creation). Restart only.
- `KubectlEnvAdapter` (`env.kubectl`, `control.target` = `[deployment/]<name>[/<container>]`): rollout + label
  in **one** `kubectl patch` (operation-id annotation on the deployment and the pod template +
  `kubectl.kubernetes.io/restartedAt` = operation createdAt). Equivalent to `rollout restart` + `annotate`,
  but atomic and re-appliable (native idempotency). A deploy sets the image of the named container, or of the
  only container; a multi-container pod without a named container, or an unknown container, is refused as
  `not_applied` before anything is patched (one image must never overwrite the sidecars). observe =
  annotation match; verify = rollout-status semantics (observedGeneration, updated/available replicas,
  `ProgressDeadlineExceeded` ⇒ failed).
- After a **verified** restart/deploy the adapter calls `environments.bumpGeneration` (deploy with
  buildDigest = buildRef) once per operation, so snapshots that observed the old generation become stale.
- `EnvControlAdapter` (`env.control`) is what the env tools bind to (a ToolSpec binding names one adapter),
  routing by `control.kind`. It declares lookup-by-operation-id so process/kubectl operations reconcile
  after a crash, and reports `uncertain` for a backend without that capability (docker) whenever no receipt
  was recorded ⇒ manual_review — exactly as safe as the backend on its own.

### Design notes, deviations and known limits

- **`load.stop` is its own operation** (`load.http.stop`), not `gateway.compensate`: the gateway only
  compensates *verified* operations (a running job is `acknowledged`), and the part-1 runtime never calls
  `execute` of bound tools and gives unbound tools an observe-only gateway. `HttpLoadAdapter.compensate`
  still stops a job (direct use; `gateway.compensate` of a completed job is a clean no-op).
- Side-effect-bound tools' `execute` returns `failed/precondition_failed`: they run only through the
  runtime's gateway path.
- MCP connections are **per server**: a server that cannot start only makes its own tools unavailable, a
  call spawns only its own server, a server whose process exits is dropped and reconnected on the next call,
  and a shared connect is bounded by the server timeout, never by one caller's abort signal. MCP tools
  cannot be discovered synchronously: `blackboxTools({ mcpServers })` registers only `allowTools` (open
  object schema, connect on first use); use `McpToolBridge.listTools()` for full discovery with input
  schemas. Operators declare effect/risk/environmentClass per server.
- Known limit (kubectl): the operation-id annotation holds only the LATEST operation. If a lost-receipt
  restart is reconciled after its lease expired AND another operation re-annotated the deployment
  meanwhile, it observes `absent` ⇒ `not_applied` ⇒ one extra rollout on retry. ReplicaSet-history lookup
  would close this; leases on `env/<id>` make it rare.
- Known limit (process): without `stateFile`, a restarted supervisor forgets operation records, so a lost
  receipt reconciles as `absent` (one extra restart on retry). Use `--state-file` for PoC fixtures.
- The `/__hypertest` path is reserved on every host for the probe tools (a SUT exposing its own
  `/__hypertest/*` routes cannot be probed there).

### Invariants and where they are proven

| Invariant | Tests |
|---|---|
| I4 crash after dispatch ⇒ a new gateway re-attaches to the SAME load job (one job dir, one worker pid, one job's requests, attempt 1) | `test/blackbox-load.test.ts` › CRASH/RECONCILE |
| I4 crash before the effect ⇒ no conclusion while the dispatcher lease is live; afterwards `absent ⇒ not_applied`, then exactly one dispatch | `test/blackbox-load.test.ts` › CRASH before the effect |
| I4 crash during load.stop after the marker, before the signal ⇒ the worker honours the marker, reconciliation attaches (attempt 1); a stop written before the worker started wins (0 requests) | `test/blackbox-load.test.ts` › CRASH during load.stop, › a stop requested before the worker started |
| I4 uncertain observation (corrupt status) ⇒ manual_review, never a blind retry; dead worker ⇒ failed; interrupted launch ⇒ uncertain | `test/blackbox-load.test.ts` › observation edge cases |
| I4 native idempotency: second dispatch for an operation never spawns; spawn failure ⇒ not_applied with the claim removed; relative state dir still launches a working job | `test/blackbox-load.test.ts` › dispatch idempotent, › a RELATIVE state dir |
| I4 env.process lost receipt ⇒ found by operation id, never restarted twice; duplicate restart requests restart once; supervisor state persisted in order | `test/blackbox-supervisor.test.ts` |
| I4 docker without receipt / failed command ⇒ manual_review (standalone and via env.control), no second restart; kubectl lost receipt ⇒ annotation lookup, no second patch; kubectl deploy never overwrites sidecars (refusal ⇒ not_applied, 0 patches) | `test/blackbox-envcli.test.ts` (fake CLIs) |
| Generation bump after verified restart/deploy (not after faults) | `test/blackbox-supervisor.test.ts`, `test/blackbox-envcli.test.ts` |
| I1 through the runtime: POST to a production env denied, deploy needs approval, MCP/load.stop without an environment class denied | `test/blackbox-http.test.ts`, `test/blackbox-supervisor.test.ts`, `test/blackbox-mcp.test.ts`, `test/blackbox-load.test.ts` |
| I1 control plane: unauthenticated supervisor mutations ⇒ 401 (child untouched); http.request / load.start can never address `/__hypertest` or a registered control target (even with the token, raw URL or dot segments); env.process without the token ⇒ not_applied; the token never reaches the ledger | `test/blackbox-supervisor.test.ts` › I1 control plane, › env.process without the control token, › env.restart through the ToolRuntime |
| Egress guard: allowlist, loopback-only-for-local, permit `allowedHosts` (http AND load.start, before any operation exists), base-path confinement, no redirects followed (http), redirect / link click / subresource off-allowlist blocked in the browser, no-navigate context fail-closed | `test/blackbox-http.test.ts`, `test/blackbox-load.test.ts` › egress, `test/blackbox-browser.test.ts` |
| Run isolation: load.observe / load.stop of another run's job refused; the job keeps running | `test/blackbox-load.test.ts` › run isolation |
| I6/I9 evidence: full body in the artifact, bounded structured/preview, redacted credentials (headers, query, JSON body fields), NUL-safe, partial bodies flagged; metric evidence once per load operation | `test/blackbox-http.test.ts`, `test/blackbox-load.test.ts` |
| Non-2xx is a successful tool call; timeouts/connection failures still produce evidence | `test/blackbox-http.test.ts` |
| MCP: per-server availability, reconnect after server exit, one caller's abort does not fail the others | `test/blackbox-mcp.test.ts` |

### Contract changes

None to `src/contracts.ts`. New exports only (see the API table). Behavioural changes of part-2 exports (no
consumer outside this package): `ProcessSupervisor.controlUrl` now carries the control token in its fragment
(new `controlBaseUrl`, `controlToken`); `loadStartTool` takes optional `{ httpAllowlist }`;
`resolveLoadTarget` also returns `trustedOrigins`; `BrowserSessionManager.page()` takes an optional egress
guard (new `drainBlocked()`); `readBodyLimited` returns partial bytes + `error` instead of throwing;
`HttpRequestResult.bodyError` (additive).

### How to test

```bash
node --test packages/tools/test/blackbox-*.test.ts                          # PGlite
HYPERTEST_TEST_DB=postgres node --test packages/tools/test/blackbox-*.test.ts  # with .infra/env loaded
node --test packages/tools/test/blackbox-docker.int.test.ts                 # real docker; skips without a daemon
```

docker/kubectl are exercised with fake CLIs (shell scripts in a temp dir, passed as the adapters' binary
path). Browser tests use `/opt/pw-browsers/chromium` (or `HYPERTEST_CHROMIUM_PATH`) and skip with a reason
when Chromium cannot launch. The MCP test server is `test/blackbox-mcp-server.mjs`.
