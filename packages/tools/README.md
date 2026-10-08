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
| Environments | `createEnvironmentRegistry(initial?)` (in-memory `EnvironmentRegistry` for `ToolRuntimeDeps.environments`); (H12) `createSqlEnvironmentRegistry({ db, clock?, logger? }, initial?)` — generations shared by every process through the core `SqlDatabase` port — and `toolsMigrations` (`ht_environments`, `ht_environment_bumps`) |
| Ledgered effects | (conformance-7) `recordEffectAdapters()`, `RECORD_EFFECT_ADAPTER_ID` (`tool.effect`), `RECORD_EFFECT_RESENDABLE_ADAPTER_ID` (`tool.effect.resendable`), `bindRecordEffect` |
| Workspaces | `createWorkspaceManager(deps)`, `workspaceIdFor`, `confineExisting`, `normalizeRel`, `workspaceResource` |
| Sandboxes | `createLocalSandbox(options?)`, `createOciSandbox({ image, docker?, user? })`, `buildDockerArgs`, `dockerNetwork`, `dockerCliEnv`, `dockerContainerEnv`, `allowlistedEnv`, `sandboxCwd`, `spawnProcess`, `SANDBOX_MARKER_ENV` (`HYPERTEST_SANDBOX`); argument confinement `argumentPathDenial(ws, cwd, argv)`, `argumentPathTokens`; trusted git: `SAFE_GIT_CONFIG`, `trustedGitEnv`, `TRUSTED_GIT_ENV_KEYS` |
| Runners | `nodeTestRunner`, `vitestRunner`, `jestRunner`, `pytestRunner`, `goTestRunner`, `commandRunner({ command, allowNoCases? })`, `defaultTestRunners()`; parsers `parseJunitCases`, `parseJestJson`, `parseGoTestJson`, `applyPytestSummary`; `buildResult` |
| Coverage | `parseCoverageJson` (coverage.py), `parseLcov`, `parseCobertura`, `parseGoCoverProfile`, `parseCoverage`, `detectCoverageFormat` |
| Mutation | `generateMutants(file, source, language, { operators? })`, `applyMutant`, `selectMutants`, `maskSource`, `runMutationAnalysis(input)`, `classifyMutantRun`, `MUTATION_OPERATORS` |
| Tools | `builtinTools(options)`, `whiteboxTools(options)`, `DEFAULT_SHELL_ALLOWLIST`, `shellDenial`, `patchPaths`, `parseNumstatPaths`, `assertNotGitMetadata`, `selectRunner`, `extractSymbols`; (conformance-2) `workspaceDelta(ws, workspaces, selector?)`, `TEST_FILE_PATTERNS`, `isTestFilePath` |
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
   `freshness.validate`; stale (or a throwing guard) ⇒ `stale_context` listing the stale entries. Exception: the
   REPLAY of a side-effect call whose operation was already dispatched (same invocation id, operation found through
   `gateway.find`, status beyond `prepared`/`not_applied`) on a snapshot that is stale by now — e.g. after a crash,
   when the recovery (or a parallel item) moved the environment on. Its act already happened (or may have), so a
   refusal would hide the recorded outcome and invite a duplicate act: the call only settles that operation
   (`reconcileOnly`: never dispatched again) and `tool.called` names it (`replayOfOperation`).
7. **`tool.called`** `{toolId, invocationId, effect, riskClass, resources, permitDecisionId}` — if it cannot
   be written the tool is not executed (`failed` / `unavailable`).
8. **Execution** — side-effect tools (`spec.sideEffect`) run **only** through
   `deps.sideEffects.run({ toolInvocationId: invocationId, adapterId, operationType, input, target, lease:
   { resourceKey: target.resourceKey, owner: agentId }, … })`; `spec.execute` is never called for them.
   The target's resourceKey must be one of (or beneath) the authorized `resources(input)`, else
   `failed`/`permission_denied` before anything is prepared.
   `verified` ⇒ `success` (structured = result), `pending` ⇒ `pending` + `operationId`, `not_applied` /
   `failed` / `manual_review` / `stale_fence` ⇒ `failed` with that code. The lease owner is
   `request.leaseOwner ?? agentId` (H4: pass a claim-scoped owner such as `${agentId}#${fencingToken}`, so a stale
   worker of the same agent never reuses the live claim's resource lease); the gateway releases the lease once the
   operation settles (durability-3). On timeout/abort the gateway's
   signal is aborted and it gets `SIDE_EFFECT_SETTLE_MS` (5 s) to record the interruption: an interrupted
   dispatch comes back as `pending` with its operation id (`outcome_unknown`), never as a bare timeout that
   would invite a duplicate call; if the gateway does not answer, the timeout/cancel text tells the model not
   to re-issue the action (re-running the same invocation reconciles it). Other tools run `spec.execute`
   under `withTimeout(min(request.timeoutMs, spec.timeoutMs, permit.maxDurationMs))` and the request
   signal: timeout ⇒ `timeout`, abort ⇒ `failed`/`cancelled`, `HypertestError` ⇒ `failed` with its code,
   anything else ⇒ `failed`/`internal` (logged). Tools without a side-effect binding get an
   **observe-only** view of the gateway (`run`/`compensate` ⇒ `permission_denied`).
   **Ledgered external effects (conformance-7, I4).** A tool WITHOUT a side-effect binding whose computed effect is
   `external` or `destructive` (http.request POST/PUT/PATCH/DELETE, browser.click/fill, mcp.*) runs — when a gateway
   is configured — through `gateway.run({ adapterId: 'tool.effect', operationType: <toolId>, toolInvocationId,
   target: <first resource> })`: the record-only adapter's dispatch executes the tool ONCE (the executor is bound to the
   invocation in this process) and its ToolOutcome is the verified result (the receipt persisted with `acknowledged` —
   it travels in the L0 event — is compact: status, error code, evidence ids, digest; a crash between acknowledgement
   and verification recovers status and evidence from it, without a structured result and never re-sending). A replay of the invocation
   (durable retry, restarted process) returns the recorded outcome and never executes again; evidence of the call names
   its operation. A call interrupted between sending and recording (timeout, abort, crash) is `outcome_unknown` ⇒
   `manual_review` (`failed`/`manual_review`, "do not re-send it as a new call") — never a blind resend — unless
   `spec.resendable(input)` (http.request to an environment declaring `honoursIdempotencyKey`, risk < high): then the
   `tool.effect.resendable` adapter lets the gateway re-send it once with the same `Idempotency-Key`. A tool failure
   (or a thrown error, unless interrupted) is a recorded outcome too. Without a gateway such tools run directly; a
   gateway without the record-only adapters refuses them (fail closed, never executed).
   `ToolContext.leaseOwner` / `ToolContext.claim` (H4) carry the request's lease owner and work-item claim (a claim on
   another work item ⇒ `denied`/`claim_work_item_mismatch`), so tools that record effects re-check the claim right
   before writing.
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

**Experiments (unit B2, conformance-6).** `request.experimentId` (set by the control plane for a work item that runs for
one experiment) is recorded as `provenance.experimentId` of EVERY evidence record the call produces — inside the
hash-chained metadata, runtime-set (a tool cannot claim or override one; without a request experiment a tool-supplied
value is dropped) — read it with `evidenceExperimentId(record)`; it is passed to the gateway for side-effect and ledgered
calls (`RunSideEffectRequest.experimentId` ⇒ the operation records it), included in `tool.called`, and handed to the tool
as `ToolContext.experimentId`.

**Resource metering (unit B2, conformance-5).** Every `execute` runs inside its own usage meter (AsyncLocalStorage):
the built-in tools run on a **metered sandbox** (`meteredSandbox`, applied by `whiteboxTools`/`builtinTools`,
idempotent), which adds each process's wall time (`ProcessResult.durationMs`) to the current call, and the runtime's
ArtifactStore is **metered** (`meteredArtifacts`): every distinct object a call stores — tool puts, evidence, output
offload — counts once. `ToolExecutionResult.usage = { computeMs, artifactBytes }` (zero for calls that never executed);
concurrent calls never mix. `request.limits.maxArtifactBytes` bounds the call's puts BEFORE they are stored: a put that
would exceed it throws `budget_exhausted` (the tool fails with that code; an offload over budget truncates without an
artifact); nothing is stored. The control plane charges the usage to the work item and its run.

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
in-process, and so is all `git worktree` administration — prune / add / remove — of one repository: a creator's
`prune` would otherwise delete another creator's half-created `.git/worktrees/<id>` and fail its `add`. Processes
sharing one repository checkout are not serialized with each other):

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
OCI), and the local sandbox cannot enforce read-only roots.

**Isolation (security-2, H1).** Unless the profile says `network: 'open'`, every local command runs in fresh
unprivileged Linux namespaces (`netns.ts`, strategy probed once per process). The preferred `userns_jail` strategy
(`unshare --user --map-root-user --net --mount` + a python3 helper) gives the command: its own network namespace with
only its own loopback (up: a test's own servers work; nothing else is reachable — not the internet, not the SUT's
control endpoint, not the store); a PID namespace with a fresh `/proc` (the Hypertest process, its environment with
API keys and its `/proc/<pid>/root` view are invisible); `LocalSandboxOptions.hiddenPaths` hidden (empty read-only
tmpfs / `/dev/null`); every workspace of `workspacesDir` but its own root and temp dir hidden; and a nested user
namespace mapped back to the caller's uid/gid, so it holds no capability over those namespaces and cannot unmount the
(locked) mounts — not even from a namespace of its own. Allowlisted egress: for `loopback` / `egress_allowlist`
profiles, `LocalSandboxOptions.egress(ws)` names origins (the app passes the registered environments' base URLs and
the URL entries of `tools.httpAllowlist`); their loopback endpoints are relayed into the namespace (a listener on the
same `host:port` inside, a unix socket served from outside), so a black-box regression test reaches the SUT and
nothing else (`loopbackEndpoints`; other hosts cannot be relayed and stay unreachable). Exit codes and terminating
signals are reported as before.
Fallbacks isolate the network only (`jail: false`): `userns_loopback` (helper without PID/mount namespaces),
`userns` (`--map-current-user`, loopback down) and `userns_root`; they relay no allowlisted endpoint (fail closed).
`none`, `loopback` and `egress_allowlist` are all enforced this way; `none` never relays anything. A host without user
namespaces (another OS, `kernel.apparmor_restrict_unprivileged_userns`, a container without them) refuses such
profiles with `precondition_failed` — never a silent downgrade; use the OCI sandbox or set `network: 'open'`
explicitly. `networkIsolation()` / `probeNetworkIsolation()` report the strategy (`hypertest doctor` shows it). A
program that does not exist is reported as before (exit 127 + `spawnError`) without starting anything outside the
namespaces. Residual: the command still runs as the same uid and sees the rest of the host file system (e.g. the
user's home) — untrusted execution needs the OCI sandbox.

Every sandboxed process (local and OCI) gets `HYPERTEST_SANDBOX=<kind>` (`SANDBOX_MARKER_ENV`), set last so neither
the allowlist nor the caller's `env` can drop or spoof it (the CLI refuses human decisions under it — H1).

**The local sandbox is not a security boundary for what a program does with its arguments (security-H1a).** It
confines the cwd and the environment only; a program resolves its arguments itself. Agent argv (`shell.exec`,
`test.run` `framework: 'command'`) is therefore confined by `argumentPathDenial` before anything runs: every path-like
token of every argument (split at whitespace, quotes and flag/list/script punctuation, so paths inside `sed`/`awk`/`-e`
scripts and `--flag=/path` are seen; `file://` URLs count as their path; network URLs are egress, not paths) is refused
(`denied`/`permission_denied`) when it climbs out with `..`, names an existing path outside the workspace, a path
under an existing directory outside it, or leaves the workspace through a symlink. Allowed outside: the workspace's
private temp dir and `/dev/null|stdin|stdout|stderr`; an absolute token whose top-level directory does not exist on
the host (a regex `/^#/d`, an API path `/api/v1`) is not a path and passes. This is **defence in depth**: interpreters
(node, python3, awk, make, npm scripts, git aliases) can compute paths at run time. Untrusted execution needs the OCI
sandbox (or another OS-level jail), and secret material (capability secret, signing keys) must live outside any
directory the sandboxed process can reach. (With the OCI sandbox runner the check is skipped: argv names container
paths there, and the container's mount namespace is the boundary.)

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
| `shell.exec` | execute/medium | `command[0]` must be a bare name in the allowlist (default: node npm npx python3 python pytest go git ls cat grep rg sed awk head tail wc diff make — no shells) ∩ permit `allowedCommands`; else `denied`/`permission_denied`; arguments may only name paths inside the workspace (`argumentPathDenial`, see Sandboxes); resources always include the workspace root (a program can touch anything, whatever its cwd); stdout/stderr evidence; non-zero exit is a successful call |
| `test.run` | execute/medium | runner auto-detection: vitest, jest (package.json), node:test (test files / `node --test` script), pytest (ini/pyproject/conftest/test_*.py), go (go.mod); `framework: 'command'` runs an allowlisted command and is never `passed` (there is no agent-controlled `allowNoCases`) |
| `coverage.collect` | execute/low | parses a report in the workspace ⇒ `coverage` evidence (absolute paths made relative) |
| `mutation.run` | execute/medium | see Mutation below ⇒ `mutation-result` evidence; resources: root + file (it copies and executes the whole suite) |
| `code.symbols` / `code.references` | read/low | `options.retrieval` when given, else a regex scan (TS/JS, Python, Go) |

**test.run evidence**: `stdout`/`stderr`, the raw report as an artifact (`rawReport {uri, sha256}` in the
payload), and a `test-result` record whose structured payload is the `TestRunResult` (+ `testArtifactId`).
With several `testArtifactIds` one `test-result` record is written **per artifact** (the QualityGate reads
the singular `testArtifactId`, so an ineligible artifact can never ride along with an eligible one).
`coverage: true` adds a `coverage` record (CoverageMap payload, gate-readable `totals.lines/branches`).

**What was tested (conformance-2).** Before the run, test.run derives the workspace's delta against its base commit
(`WorkspaceManager.changedFiles`: committed on the work branch, staged, unstaged and untracked files; a scratch
workspace lists every file as added) and records it on the test-result and coverage records (and in the structured
result) as `workspaceDelta`: `{ status: 'computed', baseCommit, readOnly, treeDigest, changedFiles, testFiles: [{ path,
change: added|modified|deleted, sha256 }] }` (`testFiles` = changed files matching `TEST_FILE_PATTERNS` — the policy's
test path patterns plus the runners' default discovery patterns — or the file the selector names; `treeDigest` =
sha256 of the canonical base + every change and its digest), or `{ status: 'unavailable', readOnly, reason }`. The
linkage is derived by the tool, never claimed by the caller: the QualityGate counts such evidence only when every
added/modified test file is covered by a validated TestArtifact with exactly that content digest (see
`@hypertest/policy`), so a run over an unregistered generated (or edited) test can never satisfy C1/C3/C4. The model
text says which test files still need registration and validation.

**What ran, on which code (gate-governance, D-0/D-1).** test.run and mutation.run also record `executedTests`
(`{ attribution: complete|partial|none, files: [{ path, sha256, cases, staticCheck? }], unattributedCases }` — the test
files the run executed with their content digest and attributed case count; a whole-suite node:test run names no file
per case, so it is honestly `none`, while a run whose selector names one file attributes every case to it) and
`codeRevision` (`{ kind: workspace|base, baseCommit, treeDigest }`). The changed test files that ran get a
framework-appropriate static check of exactly that content (`staticCheckCommand`: `node --check`; TypeScript stripped
by node and checked; `python3 -m py_compile` with the bytecode outside the workspace; `gofmt -e -l`; other languages:
the run collected cleanly), reported as `STATIC CHECK FAILED` when it fails. `test.run` input `revision: "base"`
(with the run's `baseCommit`, which the control plane injects) runs the workspace's tests on a PRIVATE copy whose
non-test changes are restored to the base commit (`runOnBaseRevision`; the workspace is never modified): the
known-good run of a regression test, marked `KNOWN-GOOD RUN ON THE BASE REVISION` and never evidence about the
candidate. mutation.run records the files of its baseline (`MutationAnalysisResult.executedTests`) and says that it
validates an artifact only when it executed exactly that artifact's file. (Review) It mutates PRODUCT code only: a
test file as the mutation target (`isTestFilePath`, the policy's `TEST_FILE_PATH_PATTERNS`) is refused
(`invalid_argument`) before anything runs, and the result records `mutatedFile: { path, isTestFile, changedSinceBase }`
— mutants of a file written in the workspace are flagged in the text and never bind. The policy's `sensitivityBinding` decides from
these records whether a run can validate an artifact.

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
| I4 + I1 the stale REPLAY of a dispatched side-effect call settles its operation (never refused, never re-dispatched); a new call or a not_applied operation on the stale snapshot is still refused | `test/runtime.test.ts` › the REPLAY of a dispatched side-effect call |
| I1 secrets redacted before policy evaluation and decision logs | `test/runtime.test.ts` › redaction |
| I4 side effects only via the SideEffectGateway; same invocation id twice ⇒ one external effect; pending never re-dispatched; not_applied mapped; read tools cannot dispatch; a target outside the authorized resources is refused | `test/runtime.test.ts` (real `createSideEffectGateway` over PGlite/PostgreSQL) |
| I9 offload: > 16 KiB ⇒ artifact + `tool-output` evidence + bounded head/marker/tail text | `test/runtime.test.ts` › offload |
| I10 `tool.called`/`tool.completed`/`tool.denied` with run/work item/agent/correlation/causation; evidence producer/provenance | `test/runtime.test.ts` |
| Path confinement: absolute, `..`, symlink escapes (existing and not-yet-existing targets) | `test/workspaces.test.ts`, `test/whitebox-tools.test.ts` (fs.read/fs.write/fs.apply_patch) |
| Worktree isolation, idempotent re-attach across restarts (branch never reset), concurrent creators, parallel work items on one repository (with concurrent disposals), diff incl. untracked, dispose keeps the repo | `test/workspaces.test.ts` |
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
| security-H1a/H1: agent argv cannot read or write outside the workspace (the PoC: `cat <abs>`, `sed 'w ../sibling/x'`; `node -e` with a literal path, `ls ..`, `git -C`, `file://`, PATH lists, symlinks); ordinary scripts/regexes/git ranges/URLs keep working; `HYPERTEST_SANDBOX` is always set and cannot be spoofed | `test/sandbox.test.ts` › H1, H1a; `test/whitebox-tools.test.ts` › security-H1a |
| H4: side-effect leases are owned by `request.leaseOwner` (a stale worker of the same agent is refused as busy, nothing dispatched); claim + owner reach the ToolContext; a claim on another work item is refused | `test/runtime.test.ts` › H4 |
| durability-3: after agent A's side effect is verified, agent B acts on the resource at once (no resource_busy, no orphaned `prepared`) | `test/runtime.test.ts` › durability-3 (tools) |
| conformance-2: test.run records the tool-derived workspace delta (added/modified test files with digests, tree digest); the gate refuses an unregistered generated test and accepts it once a validated artifact has its digest | `test/whitebox-tools.test.ts` › conformance-2 |
| conformance-7 (I4): external effects without an adapter are executed once per invocation through the ledger; replays (also after a restart) return the recorded outcome; an interrupted call ⇒ manual_review, never re-sent; a gateway without the record adapters fails closed; a POST killed between send and settle is sent exactly once; a kill between receipt and verification recovers the outcome from the compact receipt (L0 event stays small); an `honoursIdempotencyKey` environment gets one resend with the same key (applied once) | `test/runtime.test.ts` › conformance-7, `test/blackbox-http.test.ts` › conformance-7 |
| conformance-5: computeMs = wall time of the call's sandbox processes (concurrent calls never mix; the built-in tools' sandbox is metered, wrapping idempotent); artifactBytes = distinct stored objects (puts, evidence, offload); `limits.maxArtifactBytes` refuses a put before storing (typed `budget_exhausted`), an offload over budget truncates without storing | `test/usage-experiment.test.ts` |
| conformance-6: a call made for an experiment records `provenance.experimentId` in every evidence record (verified chain), in `tool.called` and on its operation; a tool cannot claim an experiment itself | `test/usage-experiment.test.ts` |
| H12: the SQL registry never forgets a bump across restarts (descriptors/secrets never stored), one operation bumps once across processes, concurrent bumps never lose an update, `load`/`refresh` read the store, sync members queue durable writes; env adapters bump through `bumpGenerationAsync` | `test/sql-environments.test.ts` (PGlite and PostgreSQL) |

### Contract changes (additive, backward compatible)

- `WorkspaceHandle.tempDir?` — private per-workspace directory outside the root.
- `ProcessResult.spawnError?` — set when the program could not start (exit code 127).
- `SandboxRunner.kind?` and `SandboxRunner.available?()`.
- Documented (no signature change): `SideEffectBinding.target()` must name one of (or a resource beneath)
  the tool's `resources(input)`.
- New types: `MutationOperator`, `MutationLanguage`, `Mutant`, `MutantStatus`, `MutationAnalysisResult`,
  `LocalSandboxOptions`, `OciSandboxOptions`, `TestRunnerOptions`.
- `BuiltinToolOptions.stateDir?` — passed through `builtinTools()` to the black-box tools (load job state).
- (eval integration) `ToolContext.recordEvidence(input)` accepts `environment?: EnvironmentRef`. When omitted, the runtime
  records the environment the tool's input addresses (`input.environmentId` of a registered environment, at its
  generation at execution time; unknown ids record none). Black-box evidence (HTTP exchanges, scrapes, load results)
  therefore has a provenance anchor: without it, L5 reported "records neither an environment nor a commit" for every
  black-box number. Test: `test/runtime.test.ts` › evidence records the environment the tool addressed.
- (hardening) `ToolExecutionRequest.leaseOwner?`, `ToolExecutionRequest.claim?`, `ToolContext.leaseOwner?`,
  `ToolContext.claim?`, new type `ToolClaim` (H4).
- (hardening) `ToolSpec.resendable?(input, ctx)`, `EnvironmentDescriptor.honoursIdempotencyKey?` (conformance-7);
  behaviour: external/destructive tools without a binding are ledgered when a gateway is configured (the gateway must
  have `recordEffectAdapters()` registered — `builtinSideEffectAdapters` includes them).
- (hardening) `WorkspaceManager.changedFiles?(ws)` and `WorkspaceChange` (conformance-2); test-result/coverage
  structured payloads gain `workspaceDelta`.
- (hardening) `EnvironmentRegistry.load?` / `bumpGenerationAsync?` (optional members), `SqlEnvironmentRegistry`,
  `SqlEnvironmentRegistryDeps`, `createSqlEnvironmentRegistry`, `toolsMigrations` (H12; the package's first
  migrations: `tools/001-environments`).
- (hardening) Behaviour: sandboxed processes get `HYPERTEST_SANDBOX`; agent argv is confined (`argumentPathDenial`).
  New exports: `SANDBOX_MARKER_ENV`, `sandboxCwd`, `argumentPathDenial`, `argumentPathTokens`, `TEST_FILE_PATTERNS`,
  `isTestFilePath`, `workspaceDelta`, `recordEffectAdapters`, `RECORD_EFFECT_ADAPTER_ID`,
  `RECORD_EFFECT_RESENDABLE_ADAPTER_ID`, `bindRecordEffect`.
- (hardening, security-2/H1) `LocalSandboxOptions.networkIsolation?`, `.hiddenPaths?`, `.workspacesDir?`, `.egress?`;
  new exports `networkIsolation`, `probeNetworkIsolation`, `resolveProgram`, `loopbackEndpoints`, types
  `NetworkIsolation`, `NetworkIsolationOptions`, `IsolationSpec`. Behaviour: the local sandbox enforces every network profile but `open` with user + network (and,
  where available, PID + mount) namespaces and refuses them where it cannot isolate the network.
- (unit B2, conformance-5/6) `ToolExecutionRequest.experimentId?`, `ToolExecutionRequest.limits?: { maxArtifactBytes? }`,
  `ToolExecutionResult.usage?: ToolUsage`, `ToolContext.experimentId?`; new types `ToolUsage`, `ExperimentProvenance`
  (`Provenance` + `experimentId?` — the domain `Provenance` has no such field yet); new exports `evidenceExperimentId`,
  `UsageMeter`, `runMetered`, `currentMeter`, `meteredSandbox`, `meteredArtifacts`. Behaviour: `whiteboxTools` /
  `builtinTools` wrap the given sandbox in `meteredSandbox`; the runtime's artifact store is metered per call.
- (hardening, security-1) `WorkspaceManager.diff()` / `changedFiles()` no longer trust the worktree's git index or
  repository configuration: they hash the worktree bytes themselves (`worktree-state.ts`: `worktreeChanges`,
  `renderWorktreeDiff`) against the base commit's tree, so skip-worktree / assume-unchanged bits, `git replace`
  refs, clean/diff filters, textconv, `info/exclude` and sparse-checkout cannot hide a change from the drift guard;
  diffs are rendered by `git diff --no-index` over copies outside the repository (no filters, no external diff).

- (gate-governance) `MutationAnalysisResult.executedTests?`, `ToolExecutionRequest.systemModelRevision?`,
  `ExperimentProvenance.systemModelRevision?` (evidence provenance names the run's SystemModel revision),
  `EnvironmentDescriptor.isolation?` (`{ dedicated, namespace?, database?, account? }` — an operator registration);
  test.run input `revision` / `baseCommit`; test-result / coverage / mutation-result payloads gain `executedTests` and
  `codeRevision`; new exports `attributeExecutedTests`, `staticCheckCommand`, `staticChecks`, `collectedCleanly`,
  `workspaceCodeRevision`, `changedSubset`, `runOnBaseRevision`, types `ExecutedTestsRecord`, `ExecutedTestFileRecord`,
  `StaticCheck`, `BaseRunInput`. Tests: `test/execution-binding.test.ts`, `test/whitebox-tools.test.ts`.

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
| `startProcessSupervisor(options)` (+ `process-supervisor-cli.ts` at `PROCESS_SUPERVISOR_CLI_PATH`), `CONTROL_TOKEN_HEADER` | Tiny reusable supervisor for local SUT processes (restart, kill, proxy-level fault injection) with a token-protected control API. Run it through the CLI when the SUT's latency must not depend on the launcher's event loop (the eval kv-service fixture). |
| `BrowserSessionManager`, `browserTools()`, `chromiumExecutablePath()`, `BrowserEgressGuard`, `BlockedRequest` | Playwright (playwright-core) browser fallback with a context-wide egress guard. |
| `McpToolBridge`, `mcpToolId`, `normalizeMcpSchema` | MCP stdio bridge. |
| `parsePrometheusText`, `histogramQuantile`, `summarizeMetrics`, `parsePrometheusApiResponse` | Pure metric parsers. |
| `checkEgress`, `checkHost`, `controlEndpointReason`, `CONTROL_PATH_PREFIX`, `hostMatches`, `isLoopbackHost`, `environmentClassForUrl`, `joinUrl`, `splitControlTarget`, `publicControlTarget`, `redactHeaders`, `redactUrl`, `redactJsonSecrets` | Egress guard, control-target and redaction helpers. |
| `closeBlackboxResources()` | Closes lazily created MCP servers and the default browser manager (shutdown/tests). |

### Tool catalog

| Tool | Effect / risk | Resources | Notes |
|---|---|---|---|
| `http.request` | read/low for GET/HEAD/OPTIONS, else external/medium | `env/<id>` or `url/<host>` | `url` or `environmentId`+`path` (joined under the baseUrl path prefix; `..`/`%2e%2e` segments are normalized first and may not climb above it or change the origin). Non-2xx is `success` (domain outcome). Redirects are returned, never followed. Non-idempotent methods get `Idempotency-Key: <invocationId>` unless set, and (with a gateway) are recorded in the Operation Ledger through the record-only adapter (conformance-7): a replay returns the recorded response; an interrupted request ⇒ manual_review, or one resend with the same key for an environment declaring `honoursIdempotencyKey`. `api-response` evidence: artifact = full response body; structured = redacted request (credential headers, secret-named query params and JSON body fields ⇒ `[REDACTED]`) and response (body text truncated at 1 MiB), duration. Timeouts (`timeout`) and connection failures (`failed`/`unavailable`) are recorded too; a body that breaks off after the status line keeps the bytes read and sets `bodyError` (never a silent short body). |
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
  from the scheduled time (coordinated-omission corrected). The schedule clock starts only once the worker's
  own HTTP client is usable: `fetch` initializes lazily on its first call (60–90 ms on an idle host, far more on a
  busy one), so a local `data:` warm-up request (never the target) runs first — the generator's start-up is never
  charged to the target (it was the p99 of every short job). Every request carries `X-Hypertest-Operation`.
  A `stop-*.json` marker in the job directory is a **durable stop request**: honoured at startup (before any
  request — a stop is never overtaken by a slow launch) and on every status tick (a stop whose signal was
  lost still takes effect within ~500 ms).
- `HttpLoadAdapter` (`load.http`; native idempotency, lookup by operation id, compensation, deterministic,
  risk high): the job directory `<abs stateDir>/loadjobs/<operationId>/` **is** the external effect (always
  absolute: the worker runs with it as cwd). `dispatch` claims it with an exclusive `mkdir` (an existing
  directory ⇒ receipt for the existing job, never a second worker), writes `spec.json` (+ desiredStateHash,
  the launching `runId` and — beside the hashed desired state — the environment's `environmentGeneration` /
  `buildDigest` at launch: what the job measured), spawns the worker detached (`unref`, stdio → `worker.log`, scrubbed env) and
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
- After a **verified** restart/deploy the adapter calls `environments.bumpGenerationAsync` when the registry has it
  (the SQL registry: atomic and idempotent per operation across processes), else `environments.bumpGeneration` (deploy with
  buildDigest = buildRef) once per operation, so snapshots that observed the old generation become stale. The
  bump names its operation (`bumpGeneration(id, digest, operationId)`): a registry returns the recorded bump when the
  same operation is verified again — by another adapter instance, e.g. the reconciliation in a process resumed after a
  crash between the bump and the ledger's `verified` — so one restart is never counted twice.
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
| Generation bump after verified restart/deploy (not after faults); once per operation, also when a fresh adapter re-verifies it (crash between bump and `verified`) | `test/blackbox-supervisor.test.ts` (› CRASH between the generation bump and the ledger's verified), `test/blackbox-envcli.test.ts` |
| I1 through the runtime: POST to a production env denied, deploy needs approval, MCP/load.stop without an environment class denied | `test/blackbox-http.test.ts`, `test/blackbox-supervisor.test.ts`, `test/blackbox-mcp.test.ts`, `test/blackbox-load.test.ts` |
| I1 control plane: unauthenticated supervisor mutations ⇒ 401 (child untouched); http.request / load.start can never address `/__hypertest` or a registered control target (even with the token, raw URL or dot segments); env.process without the token ⇒ not_applied; the token never reaches the ledger | `test/blackbox-supervisor.test.ts` › I1 control plane, › env.process without the control token, › env.restart through the ToolRuntime |
| Egress guard: allowlist, loopback-only-for-local, permit `allowedHosts` (http AND load.start, before any operation exists), base-path confinement, no redirects followed (http), redirect / link click / subresource off-allowlist blocked in the browser, no-navigate context fail-closed | `test/blackbox-http.test.ts`, `test/blackbox-load.test.ts` › egress, `test/blackbox-browser.test.ts` |
| Run isolation: load.observe / load.stop of another run's job refused; the job keeps running | `test/blackbox-load.test.ts` › run isolation |
| I6/I9 evidence: full body in the artifact, bounded structured/preview, redacted credentials (headers, query, JSON body fields), NUL-safe, partial bodies flagged; metric evidence once per load operation | `test/blackbox-http.test.ts`, `test/blackbox-load.test.ts` |
| Non-2xx is a successful tool call; timeouts/connection failures still produce evidence | `test/blackbox-http.test.ts` |
| Measurement: the load generator's own client start-up is never charged to the target (a preload makes the first fetch take 400 ms; the warm-up sends nothing to the target) | `test/blackbox-load.test.ts` › the worker's own HTTP client start-up |
| Provenance: load results evidence records the environment the job MEASURED (generation at launch, even when observed after a restart); a bare-URL job records none | `test/blackbox-load.test.ts` › the results evidence records the environment |
| MCP: per-server availability, reconnect after server exit, one caller's abort does not fail the others | `test/blackbox-mcp.test.ts` |

### Contract changes

None to `src/contracts.ts`. New exports only (see the API table). Behavioural changes of part-2 exports (no
consumer outside this package): `ProcessSupervisor.controlUrl` now carries the control token in its fragment
(new `controlBaseUrl`, `controlToken`); `loadStartTool` takes optional `{ httpAllowlist }`;
`resolveLoadTarget` also returns `trustedOrigins`; `BrowserSessionManager.page()` takes an optional egress
guard (new `drainBlocked()`); `readBodyLimited` returns partial bytes + `error` instead of throwing;
`HttpRequestResult.bodyError` (additive).

Eval integration (additive): `PROCESS_SUPERVISOR_CLI_PATH`; `LoadJobSpec.environmentGeneration?` /
`buildDigest?` (written at dispatch, outside the desired-state hash); load results evidence carries the job's
environment; api-response evidence records `request.path` (the path an oracle's `http_expectation` names); load
results carry `errorRate` (errors / completed requests, null before any completed); the worker warms its client up
before the schedule starts; `EnvironmentRegistry.bumpGeneration(environmentId, buildDigest?, operationId?)` (the
optional operation id makes the bump idempotent per operation; the in-memory registry remembers the last 4096);
`tool.called` of a stale replay carries `replayOfOperation` (behaviour: such a replay settles its operation
reconcile-only instead of being refused as `stale_context`).

### How to test

```bash
node --test packages/tools/test/blackbox-*.test.ts                          # PGlite
HYPERTEST_TEST_DB=postgres node --test packages/tools/test/blackbox-*.test.ts  # with .infra/env loaded
node --test packages/tools/test/blackbox-docker.int.test.ts                 # real docker; skips without a daemon
```

docker/kubectl are exercised with fake CLIs (shell scripts in a temp dir, passed as the adapters' binary
path). Browser tests use `/opt/pw-browsers/chromium` (or `HYPERTEST_CHROMIUM_PATH`) and skip with a reason
when Chromium cannot launch. The MCP test server is `test/blackbox-mcp-server.mjs`.
