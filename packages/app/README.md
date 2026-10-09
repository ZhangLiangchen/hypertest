# @hypertest/app

Configuration and **composition root** of Hypertest: the only package that knows every other package. It loads and
validates `hypertest.config.yaml`, wires stores, bus, evidence, operations, governance, models, context, tools, agent
runtime, control plane and durable runtime into one `Hypertest` facade, pins every run to a content-addressed
`RuntimeManifest` (I11), and serves the REST API. `hypertest doctor` is backed by `diagnose()`.

Depends on every runtime package (`scripts/check-boundaries.mjs` ALLOWED) and the `yaml` package. The binding ABI is
[`src/contracts.ts`](src/contracts.ts).

## Public API (`src/index.ts`)

| Export | Purpose |
|---|---|
| `defaultConfig(overrides?)` | Defaults ⊕ deep-merged overrides (`HypertestConfigInput`, deep partial; arrays replace; a section whose `kind` changes is replaced). |
| `loadConfig(path, { env? })` | YAML or JSON → interpolation → defaults → relative paths resolved against the file's directory → validation (throws `invalid_argument` listing every problem). |
| `validateConfig(config)` | Human-readable problems (`string[]`); never reads the environment. |
| `validateRunOverrides({ budget?, gate? })` | Problems of a run's own overrides (same rules as the configuration's `budget`/`gate`). |
| `createHypertest(config, overrides?)` | The composition root → `HypertestInstance` (the contract's `Hypertest` + `manifest`, `services`, `listRuns`, `events`, `listApprovals`, `cancel`). |
| `startApiServer(ht, { port, host?, token?, eventPollMs?, maxBodyBytes? })` | node:http REST API (below) → `{ url, close() }`. |
| `diagnose(config, { env?, connect?, timeoutMs? })` | `hypertest doctor`: config, secrets (presence only), route coverage per role (core roles, then the specialist roles `vision_gui` — a vision route, computer-use fallback reported — and `local_private` — a route accepting restricted data, and a warning for every such route whose provider is not local: `providerLocality`), BUGate binding, sandbox, storage and infrastructure reachability. |
| `HypertestInstance.releases` | Runtime release management (`RuntimeReleaseService`, below): `list`, `register`, `recordSuite`, `promote`, `rollback` (+ quarantine), `migrate`, `epochs`, `resolve`, `registry`. |
| helpers | `mergeConfig`, `interpolateConfig`, `secretVariableNames`, `resolveConfigPaths`, `withDerivedPaths`, `completeRoute`, `providerCompatibilityClass`, `roleOverrides`, `buildCatalog`, `sandboxProfile`, `defaultWorkerId`, `loadSigningKeys`, `loadCapabilitySecret`, `recordedFailureFlipDetector`, `changedAssertions`, `testCaseMatches`, `isLoopbackHost`, `pinnedControlPlane`, `decisionProblems`, `persistentEnvironmentRegistry`, `resolveEnvironments`, `acquireDirectoryLock`, `lockFileFor`, `lockHolder`, `processAlive`; constants `ROUTE_DEFAULTS`, `PROVIDER_KINDS`, `ENGINE_KINDS`, `DEFAULT_ENV_ALLOWLIST`, `ALL_MIGRATIONS`, `HYPERTEST_VERSION`, `RELAY_POLL_MS` (200), `MAX_AGENTS_PER_RUN` (1000), `TOOL_SCHEMA_VERSION`, `RUN_ID_RE`, `ENVIRONMENT_STATE_FILE`. |

### Configuration

Defaults: `project {name: hypertest, dataDir: .hypertest}`, store PGlite at `<dataDir>/db`, in-process bus, local
durable runtime (`maxConcurrentTurns` 4), filesystem artifacts at `<dataDir>/artifacts`, **no providers and no routes**,
engine `native`, local sandbox with `network: loopback` and `envAllowlist [PATH, HOME, LANG, LC_ALL, TMPDIR]`, tools
with the built-in shell allowlist, SQL experience memory.

```yaml
version: 1
project: { name: shop, dataDir: .hypertest }        # relative to this file
models:
  providers:
    - { id: claude, kind: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
    - { id: local, kind: openai-compatible, baseUrl: "${LOCAL_LLM_URL:-http://127.0.0.1:11434/v1}" }
  routes:
    - { routeId: claude-main, provider: claude, model: claude-x,
        capabilities: [tool_use, parallel_tool_calls, structured_output, reasoning, long_context], quality: { default: 0.9 } }
gate: { requireIndependentReview: true }
```

- **Secrets never live in the configuration.** `*Env` fields (`apiKeyEnv`, `urlEnv`, `capabilitySecretEnv`,
  `accessKeyIdEnv`, `secretAccessKeyEnv`, `environments[].control.tokenEnv`) NAME an environment variable that is read
  when Hypertest starts. Inline credential fields (`apiKey`, `token`, `password`, …) and credential headers
  (`Authorization`, `x-api-key`, and any header named like `*auth*`/`*token*`/`*secret*`/`*session*`/`*cookie*`) are
  validation errors; a postgres `store.url` with a password or a credential query parameter (`?password=`) is an error
  (use `urlEnv`); NATS server URLs with userinfo are errors; an inline supervisor token in
  `environments[].control.target` (`#token=`) is an error — set `control.tokenEnv` (process environments only): the
  token is attached to the target at composition, where the env.* adapters read it; secret-looking variables in
  `sandbox.envAllowlist` are errors. Budget caps the control plane requires as integers (`maxWorkItems`,
  `maxToolCalls`, `maxAgentDepth`, …) are checked at load, not at the first start. Every `gate` field is checked
  (severity/risk enums, `requiredEvidence` entries, `minCoverage` in [0, 100]): the QualityGate trusts its spec, and an
  unknown `failOnUnresolvedSeverity` would silently disable the rule that unresolved P0/P1 findings fail the gate. A
  run's own `budget`/`gate` overrides (`StartRunInput`, `POST /runs`) get the same rules (`validateRunOverrides`;
  `start()` refuses them with `invalid_argument` before a run exists). `providers[].maxRetries` is
  accepted but ignored (retries and fallback are the router's): `createHypertest` logs and `diagnose` warns.
- **Interpolation** `${VAR}`, `${VAR:-default}`, `$${` (literal) applies to string values only; never to keys, never to
  `*Env` fields, and never with a variable named by a `*Env` field or whose name looks like a credential (KEY, SECRET,
  TOKEN, PASSWORD, …). All problems are reported together; secret values never appear in messages.
- **Routes** (A[2]: every route has an EXPLICIT CapabilityProfile) name at least `routeId`, `provider` (declared in
  `models.providers`), `model` and **`capabilities`** (required: "nothing is assumed"); undeclared fields take
  CONSERVATIVE defaults (`ROUTE_DEFAULTS`): maxDataClassification `internal`, maxActionRisk `low`, structuredOutput
  `prompted` when the `structured_output` capability is declared (else `none`), reasoning `none`, contextWindow 128000,
  maxOutputTokens 4096, quality `{default: 0.7}`, toolReliability 0.8, typicalLatencyMs 2000, enabled. Cost is
  **unknown** unless both `costPerMillionInputUsd` and `costPerMillionOutputUsd` are declared (one without the other is
  an error): a run or work item with a USD budget (`maxModelCostUsd` / `maxCostUsd`) never routes to a cost-unknown
  route, and the condenser (a per-call cost cap) never does. `defaultedRouteFields(route)` lists what a route left to
  the defaults; `diagnose` warns about defaulted fields and unknown prices. `continuationCompatibilityClass` is the
  provider's tag: `anthropic:<model>`, `pi-ai:<api>:<piProvider>:<model>` (resolved pi model), `<providerId>:<model>`
  for openai-compatible/scripted; a pinned different tag for anthropic/pi-ai is refused. Declare capabilities, quality,
  classification and risk per route — `diagnose` lists the roles no route can serve.
- **Model governance keys** (`models.*`): `priceGuard` (A[1]: `{ maxIncreasePct?, default?, routes?, appliesTo? }`,
  validated; an observed price beyond `maxIncreasePct` over the catalog price opens the route's circuit with an L0
  event), `pricesFile` (default `<dataDir>/state/model-prices.json`: the observed prices, maintained by `hypertest
  model prices set|clear` and re-read by a running Hypertest at every turn boundary), `scoresFile` (coverage[7]: eval
  scores from `hypertest eval apply-scores`, merged into the catalog with `ModelCatalog.withScores` at start and
  recorded in the RuntimeManifest as `modelScores` `{ digest, routes, source }`; scores for unconfigured routes are
  refused).
- **Plugins** (A[6]): `plugins: [{ id, version, kind: tool | engine | provider | context-hook, entry, digest:
  sha256:<hex>, capabilities: [...], config? }]` — local ES modules, digest-pinned (a mismatch refuses the start:
  nothing of the plugin is loaded), loaded by the runtime's plugin kernel (init → start → health; stopped on close),
  recorded in the RuntimeManifest (`plugins`). Plugin tools join the tool registry (and its catalog revision) after the
  built-in and domain tools — a plugin tool reusing a governed tool id is refused (`conflict`) — and pass the same
  capability check, policy permit, operation ledger and evidence as built-in tools. The digest pins the entry file only
  (modules it imports are not pinned: ship a plugin as one bundled file); plugin providers are
  declared as `models.providers[].kind: plugin`; plugin engines may be `engines.default`; context hooks add labelled
  reference sections to every turn (data, never instructions).
- **Roles**: built-in catalog ⊕ `models.defaultPolicy` (applied to every role's model policy) ⊕ the condenser as a
  plain summarizer (`requiredCapabilities: []`, it is invoked without tools) ⊕ `roles.<role>` (wins).
- **Missing credentials fail closed** (e2e[3]): a provider whose `apiKeyEnv` variable is unset or empty (and a hosted
  `anthropic` provider without `apiKeyEnv` or `baseUrl`) is UNAVAILABLE — the router never routes to its routes and its
  `complete()` refuses before any request is sent (zero fetch calls); `createHypertest` logs a warning (name only),
  a run whose roles have no other route is refused at start with the exact reason, and `diagnose` reports it.

### Composition (`createHypertest`)

Validation, then pure construction (providers; catalog) before anything is created — a missing scripted brain
(`overrides.scriptedBrains[providerId]`) or an unresolvable route fails without touching the disk. Then: data dir
(0700); **keys** — the Ed25519 evidence signer from `signing.keyFile` (must exist) or `<dataDir>/keys/evidence-ed25519.pem`
(generated once, 0600) plus one `ed25519-<hex>.pub.pem` per key (every `*.pub.pem` stays trusted by `verifyEvidence`,
so rotated keys still verify old seals), and the capability HMAC secret from `policy.capabilitySecretEnv` or
`<dataDir>/keys/capability.secret` (generated once, 0600); for PGlite the **store lock** `<store dataDir>.lock` (one
process per embedded data directory, see below); store + **all** migrations (collab, operation, evidence, policy,
context, runtime, control); bus (`InProcessEventBus`, or NATS JetStream with optional `stream`/`subjectPrefix`,
or `overrides.bus`); collab repositories; ONE `OutboxRelay` (poll 200 ms); artifacts (fs/S3); evidence ledger with the
signer; environments (config with `control.tokenEnv` resolved + `overrides.environments`) behind the **persistent
generation registry** (`<dataDir>/state/environments.json`); operation ledger, leases, `AdapterRegistry` with
`builtinSideEffectAdapters({stateDir: <dataDir>/state})`, gateway, reconciler, admission, budget; policy =
`BuiltinPolicyEngine(DEFAULT_POLICY_RULES + policy.rules)` (revision `builtin:<hash>`) composed deny-wins with
`OpaPolicyEngine` when `policy.opa` is set, both verifying capability HMACs; decision log; approvals; oracle
governance over the spec store (no `events`: the store emits `oracle.change_*`) with the recorded-failure flip
detector (every finding revision + the run's recorded test results); QualityGate; BUGate binding; provider registry, catalog, router; snapshot store/builder, resolvers
(`environment`, `oracle`, `experiment`, `record`, `lease`, and `file` for the workspaces this process opened; control
adds `finding`), the observation log (`ht_context_observations`), freshness guard, experience memory (SQL or
PowerContext), provenance (`services.provenance`), working context, per-root L3 retrievers (symbol graph + single-line
exact search + a workspace vector retriever, RRF-fused; vector corpora built lazily per root and commit, at most 8 per
process, stored in pgvector when the store has the extension — probed once — else in memory; `HashEmbedder`
feature-hashing embeddings unless `retrieval.embedder` routes them through an OpenAI-compatible `/embeddings`
provider); workspace manager (`<dataDir>/workspaces`), local/OCI
sandbox, tool registry (built-in tools with `stateDir`, then the control domain tools), tool runtime wrapped by
`observeToolRuntime` (every tool result feeds the observation log before it returns; a read — `fs.read`, `git.show`,
`blackboard.read`, `metrics.query`, `metrics.scrape` — whose observation cannot be recorded is returned
`failed`/`unavailable` with its output withheld); sessions, agents, epochs, `EngineRegistry` (native + pi; + dsh when
`engines.default: dsh`), subagents, runner;
roles; the **RuntimeManifest**; control plane wrapped by `pinnedControlPlane` (I11, below) and
`releaseGovernedControlPlane` (runtime release admission, below; its router has the condenser privacy floor); the
runtime release service (`ht.releases`); durable runtime (`LocalDurableRuntime` or `TemporalDurableRuntime`, with
`getRun` and a `resolveClaim` that only returns claims held by this worker). A failure closes whatever was opened.
Runs are **not** resumed automatically — call `resumeIncomplete()` (`hypertest resume`).

**RuntimeManifest** (the runtime BOM): `hypertest` = `version` (monorepo root package.json), `sourceDigest`, `gitSha`
(`git rev-parse HEAD` of the installation when it is the top level of a git checkout — never a parent repository's
commit; absent otherwise) and `imageDigest` (`HYPERTEST_IMAGE_DIGEST` of the composition environment, `sha256:<64 hex>`;
a malformed value fails the composition before anything is created); `agentEngines` (`native` = @hypertest/runtime
version, `pi` = pi-agent-core version, `dsh` (only when it is the default engine) = the pinned dsh-agent version, each
with its `adapter` package/version — `@hypertest/runtime-pi` for pi, `@hypertest/runtime-dsh` for dsh);
`defaultEngine`; `providerAdapters` (every model provider + `engine:native` @hypertest/runtime, `engine:pi`
@hypertest/runtime-pi and @earendil-works/pi-agent-core, `engine:dsh` @hypertest/runtime-dsh and every pinned
`@deepseek-ai` package of the DSH train); `modelCatalogRevision`; `schemas` (last migration id of
collab/context/operation/evidence; `tools/1`); `policyBundleRevision` (`<policy revision>+roles:<role catalog
revision>`); `roleCatalogRevision`; `toolCatalogRevision` (`toolCatalogRevision(tools, adapters)` of @hypertest/runtime:
built-in + domain tools with their timeouts and side-effect bindings, and the side-effect adapters' capabilities);
`protocol`. The id is content-addressed: the same runtime yields the same id across restarts.

**Runtime releases** (`ht.releases`, `hypertest runtime …`; registry in @hypertest/runtime). New runs pass the
release registry's admission in the control plane handed to the facade and the durable runtime
(`releaseGovernedControlPlane`): once a release is active, a run is created only under the active release or under a
canary whose selection (run-id percentage bucket or labels) picks it — every other runtime gets `precondition_failed`
and creates nothing; an installation that never activated a release runs unmanaged (any runtime except a rolled-back
one), unless `runtime.requireActiveRelease: true`. `promote` goes one step along candidate → shadow → canary → active,
each over the latest passing `engine_contract` and `replay` suite results; activating retires the previous release
once no live run is pinned to it (`list` and `promote` retire drained releases). `rollback` moves the active pointer
back (or stops a canary/shadow/candidate), leaves old runs on their pinned manifest, and — in the same transaction —
quarantines every live run of the rolled-back release: paused with `pauseReason: quarantined` (converging/gating runs
through `running`, the only legal path) and `run.quarantined` on L0 with its previous status; `resumeRun` of a
quarantined (or `migrating`) run is refused. Admission and creation are not one transaction, so the creator re-checks a
run it just admitted (`afterCreate` → `releases.quarantineIfRolledBack`): a run admitted before a rollback committed but
created after the rollback's sweep is quarantined with that rollback's actor, reason and transition, and its start fails
`precondition_failed` (`details.quarantined: true`) — either the sweep sees the run or the re-check sees the rollback.
A quarantine reads and changes the run under the run's lock, so concurrent quarantines of one run (a sweep racing a
re-check) pause it once and record one `run.quarantined`. Should the creator die (or its re-check fail) between the
creation and the re-check, the run is quarantined before anything drives it: the governed control plane re-checks a run
before `recover` — the first step of every durable loop (a start, a migration's drive, a Temporal workflow) — and before
an operator's `resumeRun` (`beforeDrive`, failing closed when the re-check cannot be made), and `resumeIncomplete()`
quarantines such a run instead of resuming it. `resumeRun` re-checks again after the control plane's resume: a rollback
whose sweep quarantined the run between the check and the resume is not undone by it (quarantined again, refused). `migrate(runId, { to, by, reason, checkpointTimeoutMs?, drive? })` is the
only way a live run changes runtime: checkpoint (under the run's lock, on the run as it is then: a running run is paused
`migrating`, a paused one keeps its pause — a quarantine or operator pause committed meanwhile is never overwritten —
then wait until no work item holds a live claim), canonical ContextSnapshot, operation reconciliation (refused while any operation of the run is unsettled —
prepared, dispatching, acknowledged, outcome_unknown, reconciling, compensating or manual_review — or a work item waits),
compatibility (`runtimeCompatibility`: target active/canary, same schemas or an explicit allowed migration, the engines
the run used, same protocol), then ONE transaction: under the registry's lock (`registry.lock(tx)`, taken before the
run's locks — the rollback's order) the target is read again and the compatibility checked again, so a rollback or
promotion of the target can never commit between the check and the re-pin (a rollback committing later finds the
re-pinned run in its sweep); the run must still be paused by the checkpoint's pause (`migrating`, or the pause it had;
`quarantined` by a rollback of its source is accepted) — a run resumed and paused again meanwhile moved past the
snapshot and the migration fails `conflict`; then the target manifest stored in `ht_manifests`, a RuntimeEpoch, the
re-pin, `run.migrated`, and the resume (`running`, or the run's own earlier pause: an operator/budget/approval pause, or
the pause a quarantine replaced, is kept). A failed migration releases the checkpoint it took, under the run's lock and
only while the run is still paused `migrating` on its source (a quarantine that replaced it is kept). When the migrating
process dies between its checkpoint and the re-pin, the run stays paused `migrating` (resume refused):
`releaseCheckpoint(runId, { by, reason })` (`hypertest runtime migrate <runId> --abort`) puts it back to `running` on
the manifest it is still pinned to, with `run.migration_released` on L0 (a run whose release was rolled back is
quarantined instead); a migration still in progress for it then fails (`conflict`) and re-pins nothing. The report of a run
carries its quarantine, migration and released-checkpoint notes (`## Runtime release`, `recovery`, `json.runtimeRelease`). Proven with the
local durable runtime; with Temporal the source runtime's run workflow fails on its next tick (the I11 refusal of the
re-pinned run) and `resume` on the target runtime starts the run's workflow on the target's task queue (not exercised
against a live Temporal server).

**Condenser privacy floor**: the router the control plane uses raises a `condenser` request to the classification of
the agent whose context it condenses (its role's `dataClassification`, its role's and its work item's `privacyClass`),
on `route` and on `invoke`: a `local_private` agent's context is never summarized on a hosted model.

**I11 at restart and upgrade.** A run is driven only by a runtime with the manifest it is pinned to:
`resumeIncomplete()` resumes only resumable runs pinned to this instance's manifest (the others are logged and left
alone for their own runtime, or a cancel); `start({ runId })` of an existing live run pinned elsewhere is refused; and
the ControlPlane handed to the durable runtime (Local, and the Temporal activities) refuses `tick`, `recover`,
`executeTurn` and `observeWaiting` of a live run pinned to another manifest with the non-retryable
`precondition_failed` (finished runs stay readable). Changing the configuration's routes, policy rules, roles or the
Hypertest version is an upgrade: finish or cancel in-flight runs first, or keep the old runtime for them (Temporal:
one task queue per runtime version).

Facade: `start` (a caller's `runId` must match `RUN_ID_RE` without `..`, its `budget`/`gate` overrides must pass
`validateRunOverrides`; preflight: fails fast with
`precondition_failed` when no enabled route exists or no route can serve the lead — no run is created; then
`control.startRun` + `durable.startRun` — when the latter fails, the error names the created run, which
`resumeIncomplete` drives), `run` (start + `awaitCompletion`; a timeout rejects while the run continues),
`resumeIncomplete` (pinned runs only), `status`, `report`, `verifyEvidence` (unknown run ⇒ `not_found`;
`evidence.verify` with the trusted public keys, plus the verdict itself: the run's QualityDecision must be signed by a
trusted key over its content and bound to the root of the first `evidenceCount` records — `decision_signature`,
`decision_root`, `decision_missing` problems), `approve` (human decision, then a best-effort `wake` of a live run: a
failed signal is logged, never reported as a failed decision), `decideOracleProposal` (same), `cancel`
(`control.cancelRun` + durable cancel signal; a completed/failed run is a `conflict`, a cancelled one is idempotent),
`listRuns`, `events`, `listApprovals`, `close` (idempotent: durable shutdown → relay stop → control close →
browser/MCP resources (only when the browser was enabled; process-wide) → S3 client → bus (unless injected) →
database → store lock).

### REST API (`startApiServer`)

| Method | Path | Result |
|---|---|---|
| GET | `/health` | `{ ok, manifestId, durable }` |
| POST | `/runs` | `StartRunInput` → `202 { run }` (unknown fields refused) |
| GET | `/runs?status=a,b&limit=n` | `{ runs }` |
| GET | `/runs/:id` | `{ run }` |
| GET | `/runs/:id/events?afterSeq=n` | SSE: `id: <seq>`, `event: <type>`, `data: <DomainEvent>`; polled every 500 ms from the last seq (`Last-Event-ID` resumes); each poll reads the run status BEFORE the events, and `event: end` follows two quiet polls after the run was terminal (the events committed with the terminal transition — gate.evaluated, run.completed — are always sent first); keep-alive comments |
| GET | `/runs/:id/report[?format=markdown]` | `RunReport` (or its markdown) |
| GET | `/runs/:id/evidence/verify` | `{ ok, problems }` |
| POST | `/runs/:id/cancel` | `{ reason }` → `{ ok }` |
| POST | `/runs/:id/resume` | → `{ ok, releasedPauses }` (A[0]: releases model pauses — the paused agents retry now — and resumes a paused run). An operator decision: requires the API token (403 `token_required` without one), so an agent reaching the loopback API cannot un-pause a run. A quarantined or migrating run is refused (release governance) before any pause is released |
| GET | `/runs/:id/agents` | `{ agents }` (A[4]: each agent's `engine.inspect` state, capability modes, epoch, model pause) |
| POST | `/runs/:id/model-switch` | `{ target: role \| agentId, routeId, by, reason? }` → `{ switch }` (A[3]: a manual model switch applied at the target agents' next safe turn boundary after the re-check); **requires the API token** |
| GET | `/approvals?runId=&status=` | `{ approvals }` |
| POST | `/approvals/:id`, `/oracle-proposals/:id` | `{ approve, by, rationale }` → `{ ok }` (decided by the human `by`); **requires the API token** (403 `token_required` on a server without one) |

Errors are JSON `{ error: { code, message } }` (HypertestError codes → 400/403/404/409/429/501/502/503/504; anything
else → 500 `internal error`, details only in the log; a malformed percent-encoded path is a 400). **Security**: binds
`127.0.0.1` and has no authentication by default; the `Host` header must name the loopback listener (DNS-rebinding
guard); bodies must be `application/json` (no cross-site form posts) and ≤ 1 MiB. A non-loopback host is refused
unless `token` (≥ 16 chars) is set, which then requires `Authorization: Bearer <token>` on every request
(constant-time compare). **Human decisions always need the token**: loopback is not a trust boundary on a Hypertest
host — agents reach loopback services of `local` environments through `http.request`, and the code under test runs in
the local sandbox — so an unauthenticated decision endpoint would let either approve its own side effect or oracle
change as a "human" (I1, I8). Reads, `POST /runs` and cancellation stay open on loopback. Put TLS in front for remote
use.

## Invariants and where they are proven

| Invariant | Test |
|---|---|
| I11 a run is pinned to the manifest built at composition (engines incl. pi-agent-core + adapter versions, providers, catalog/tool/policy+roles revisions, schemas, protocol); same runtime ⇒ same id across restarts | `test/app.e2e.test.ts` (tiny run, restart) |
| `engines.default: dsh`: the tiny run completes on the DeepSeek Harness adapter with the same governance and verdict; the manifest pins the DSH engine, its adapter and the whole pinned DSH train; an installation that does not select DSH neither registers nor pins it | `test/engine-dsh.e2e.test.ts` |
| I11 a runtime with another manifest never drives a pinned live run: `resumeIncomplete` skips it, `start({runId})` refuses it, the durable runtime's control boundary refuses tick/recover/executeTurn/observeWaiting; the original runtime completes it | `test/app.e2e.test.ts` (I11 restart with another runtime), `test/compose.test.ts` (pinnedControlPlane) |
| I7 the verdict is the QualityGate's: signed over its content, bound to the sealed evidence root; evidence verifies with the persisted key; `verifyEvidence` reports an altered, unsigned or re-bound decision and refuses unknown runs | `test/app.e2e.test.ts` |
| I8 an oracle change flipping a recorded failure needs a human (independent agents refused) — including when the proposer cites nothing (the run's failed test cases matching a changed `test_outcome` selector) and when the citing finding was later superseded as rejected; additions flip nothing; unknown base fails closed | `test/governance.test.ts`, `test/app.e2e.test.ts` (facade operations) |
| I1/I8 human decisions over the API need the token (403 without one, never reaching the facade) | `test/api.test.ts` |
| One process per PGlite data directory (a second instance/process is refused; stale locks of dead processes are taken over; close() and a failed composition release it) | `test/lock.test.ts`, `test/compose.test.ts` |
| Freshness: environment generation bumps (deploy/restart) survive restarts; a re-verified operation (crash between bump and `verified`) is bumped once; a corrupt state file fails closed | `test/environments.test.ts`, `test/compose.test.ts` |
| Secrets never interpolated or inlined (also credential-named headers, `?password=`, NATS userinfo, inline supervisor tokens → `control.tokenEnv`); missing key variables reported by name only | `test/config.test.ts`, `test/compose.test.ts`, `test/environments.test.ts`, `test/diagnose.test.ts` |
| I7 a gate spec (config or a run's override) cannot silently disable a gate rule (unknown severity, malformed required evidence) | `test/config.test.ts`, `test/app.e2e.test.ts` (facade robustness) |
| Keys persist with 0600 (dir 0700), are reloaded, tightened when loose; configured-but-missing keys are faults; rotated keys stay trusted; capability secret stable / from env (≥ 16) | `test/keys.test.ts` |
| Fail fast: invalid config, missing brain, unresolvable route before anything is created; no routes / unroutable lead ⇒ `start()` refuses, no run | `test/app.e2e.test.ts`, `test/compose.test.ts` |
| A[0] a timing-out single route PAUSES the work (`work.paused` model_unavailable), the durable runtime resumes it after the backoff and the run completes — local and Temporal; `ht.resume(runId)` releases the pause before its backoff (`model.pauses_released`) and refuses a quarantined run before releasing anything | `test/model-pause.e2e.test.ts` |
| A[6] a plugin tool reusing a built-in or domain tool id (`complete_work`, `fs.read`) refuses the composition | `test/plugins.e2e.test.ts` |
| A[3] a manual switch of the executor role (requested while the lead plans) is applied: every executor call runs on the requested route, `switchReason: manual` | `test/model-governance.e2e.test.ts` |
| e2e[3] a missing credential fails closed: zero fetch calls, the exact reason, doctor reports it | `test/credentials.e2e.test.ts` |
| A[1] price guard configured and validated; an observed price change beyond it opens the circuit (L0) and the other route serves; coverage[7] eval scores change routing and the manifest (`modelScores`) | `test/model-governance.e2e.test.ts` |
| A[5] nested delegation (depth 2) end to end with depth and work-item caps; parents get only their child's result | `test/nested-delegation.e2e.test.ts` |
| A[6] kernel plugins: manifest record, digest mismatch refuses the composition, plugin tool through capability check / policy permit / operation ledger / evidence, context hooks, stop on close | `test/plugins.e2e.test.ts` |
| A[0]/A[3]/A[4] operator endpoints (resume, model switch with the token, agent inspection) | `test/api.test.ts` |
| Crash safety: a run interrupted mid-turn by `close()` is resumed by the next instance over the same data dir and completes | `test/app.e2e.test.ts` (restart) |
| `close()` releases every handle (a child process that composed, ran and closed exits on its own) | `test/app.e2e.test.ts` + `test/fixtures/exit-probe.ts` |
| API: validation, media type, body limit, Host guard, bearer token, JSON errors without internals, malformed paths, SSE ordering/resume/end (never before the final events) | `test/api.test.ts`, `test/app.e2e.test.ts` (REST API over a real instance) |
| Production wiring: PostgreSQL + NATS JetStream (delivery proven by a probe consumer) + OPA composed with the built-in rules; Temporal durable runtime (through the pinned control boundary); doctor is read-only on PostgreSQL | `test/app.int.test.ts` |
| I11 runtime releases: new runs only under the active release or a selecting canary (refused starts create nothing); promotion over recorded passing suites; rollback moves the pointer back, old runs continue on their pinned manifest, the rolled-back release's runs are quarantined (paused, `run.quarantined`, report note, resume refused); explicit migration (checkpoint, snapshot, reconciliation, compatibility, RuntimeEpoch + `run.migrated` + re-pin + resume) completes the run on the new runtime; migration refusals (checkpoint timeout, unknown ids, non-promoted target, unsettled operation) leave the run as it was; a rollback committing between the admission and the creation of a run (the run escapes both sweeps) still quarantines it through its creator's re-check and refuses the start; concurrent quarantines of one run record exactly one (PostgreSQL shows the race); `runtime.requireActiveRelease`; drained releases retire; the image digest is part of the BOM; a rollback of the migration target committing after the migration's last pre-transaction check refuses the re-pin (and one committing after the re-pin quarantines the migrated run); runs whose creator died before its re-check are quarantined by the next loop start (`recover`), by `resumeIncomplete()` and by an operator resume, never driven (nor released from an abandoned migration checkpoint); an abandoned migration checkpoint is released explicitly (`run.migration_released`, report note), and a live migration whose checkpoint is released, or released and paused again, fails `conflict` and re-pins nothing; a quarantine committing after a migration read the run is neither overwritten by its checkpoint nor undone when it fails; a quarantine racing the release of a failed migration's checkpoint is kept | `test/releases.e2e.test.ts` |
| Runtime BOM inputs (git commit of the installation only, image digest format), condenser privacy floor (restricted agents condensed on restricted routes only, replayed hosted decisions refused), admission wrapper and its post-create re-check, the `beforeDrive` re-check before `recover`/`resumeRun` (fails closed) and after `resumeRun` (a quarantine racing the resume is restored), pin-cache eviction, report notes (incl. a released checkpoint) | `test/releases.test.ts` |
| Doctor route coverage of the specialist roles (vision + computer-use fallback, restricted data only on local routes) | `test/diagnose.test.ts` |
| The specialist roles in a real run: every model call of a `local_private` agent reaches only the restricted (local) route and every `vision_gui` call only the vision route (provider calls and `model.epoch_started` agree); without a restricted route the `local_private` item fails with a security-stage refusal (`no_eligible_route`) and the hosted provider never sees it | `test/specialist-roles.e2e.test.ts` |

## How to run

```bash
npx tsc -p packages/app --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package app                             # PGlite (+ infra int tests)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package app  # e2e runs on PostgreSQL 16 (fresh schema each)
```

`test/helpers.ts` has scripted brains keyed by the agent header line (`roleRouter`), the tiny run
(`tinyRunBrains`: lead plan → executor `test.run` on a real node:test repo → lead readyForGate), `scriptedConfig` and
`testStore` (PostgreSQL schema when `HYPERTEST_TEST_DB=postgres`). `*.int.test.ts` skip with a reason when
`HYPERTEST_TEST_PG_URL` / `_NATS_URL` / `_OPA_URL` / `_TEMPORAL_ADDRESS` are absent.

## Operational notes

- `InProcessEventBus` retains every published message in memory for the life of the process — fine for local runs;
  use NATS for long-lived servers.
- Exactly one `OutboxRelay` per `Hypertest` instance: run one instance per database per process.
- **One process per PGlite data directory**, enforced: PGlite has no locking of its own (two processes on one
  directory silently lose each other's writes) and both would be the same worker. `<store dataDir>.lock` holds
  `{pid, hostname}`; a second instance (in this or another process) fails with `precondition_failed` naming the
  holder; a lock of a dead process (or of this pid but not held here — a restarted container) is taken over; a lock of
  another host is never broken (remove it once that host is gone). `hypertest doctor` warns when the directory is in
  use. Use PostgreSQL for several processes.
- Worker identity (`overrides.workerId`): default `worker:<hostname>` for PGlite (one process per data dir, so a
  restarted process re-takes its own leases at once) and `worker:<hostname>:<pid>` for PostgreSQL (a restarted process
  waits for the old leases to expire — set a stable `workerId` per worker instead).
- Workers sharing a PostgreSQL store must share `policy.capabilitySecretEnv` (and the signing key via
  `signing.keyFile`): capabilities and seals are verified by other workers (`diagnose` warns).
- Environment generations are durable per data directory (`<dataDir>/state/environments.json`, written synchronously
  on every bump, merged by max): a restart never forgets a deploy, so a snapshot from before it stays stale. The file
  also records which operation made each bump (`operations`, the latest 1024): the adapter bumps while verifying,
  before the ledger records `verified`, so a process killed in between re-verifies the operation after the restart and
  gets the recorded bump back — one restart is never counted twice. Workers
  sharing a PostgreSQL store each keep their own registry (a bump in one worker is not seen by the others).
- `tools.enableBrowser` browsers and lazily started MCP servers are process-wide; `close()` releases them.
- In the integration test the NATS stream `HT_APP_INT_<suffix>` stays on the dev server (only @hypertest/collab may use
  the NATS SDK to delete streams).

## Contract changes (additive, backward compatible)

- `loadConfig(path, options?: LoadConfigOptions)` (`env`); `defaultConfig(overrides?: HypertestConfigInput)` (deep
  partial, widens `Partial<HypertestConfig>`).
- `HypertestConfig.bus` nats: `subjectPrefix?`.
- `HypertestOverrides.env?`, `HypertestOverrides.bus?`.
- `Hypertest` optional members `manifest?`, `listRuns?`, `events?`, `listApprovals?`, `cancel?`; new
  `HypertestInstance` (all of them required + `services: HypertestServices`) returned by `createHypertest`.
- New types `RouteConfig`, `HypertestConfigInput`, `LoadConfigOptions`, `HypertestServices`, `HypertestInstance`,
  `ApiServerOptions`, `ApiServer`, `DiagnosticCheck`, `DiagnosticReport`, `DiagnoseOptions`; new export `diagnose`.
- REST additions: `GET /health`, `GET /approvals`, `POST /runs/:id/cancel`, `POST /oracle-proposals/:id`.
- (review) `HypertestConfig.environments` is `EnvironmentConfig[]` (an `EnvironmentDescriptor` whose `control` may
  carry `tokenEnv`; every `EnvironmentDescriptor[]` is still accepted). New exports `pinnedControlPlane`, `PinLookup`,
  `decisionProblems`, `RUN_ID_RE`, `persistentEnvironmentRegistry`, `resolveEnvironments`, `ENVIRONMENT_STATE_FILE`,
  `acquireDirectoryLock`, `lockFileFor`, `lockHolder`, `processAlive`, `DirectoryLock`, `testCaseMatches`,
  `validateRunOverrides`; `FlipDetectorDeps.testResults?`.
- (review, behaviour) human decisions over the API require the token; `cancel()` of a completed/failed run is a
  `conflict`; `verifyEvidence()` of an unknown run is `not_found` and also verifies the decision; `resumeIncomplete()`
  resumes only runs pinned to this manifest.
- (eval review, behaviour) `persistentEnvironmentRegistry().bumpGeneration(id, digest?, operationId?)` records the bump
  of an operation in the state file (`operations`, additive) and returns it when the same operation is re-verified in a
  later process: no double bump after a crash between the adapter's bump and the ledger's `verified`.
- (hardening) `HypertestConfig.oracles?: OracleConfig[]` (conformance-1): oracles established at composition by
  their named human authority (`establishedBy`, recorded as `{ kind: 'human' }`); an existing oracle is never changed
  by a config edit (it changes only through governed proposals). A run that names no `oracleIds` pins the configured
  oracles. `gate.requireOracle` (boolean). New exports `oracleConfigProblems`, `oracleSpecFromConfig`,
  `manifestTaskQueue`, `flipsRecordedViolation`; `FlipDetectorDeps.evidence?` (H8: the flip detector evaluates the
  proposed revision with the gate's `evaluateOracleCheck`).
- (hardening, behaviour) `store.kind: postgres` uses the shared SQL environment registry (`toolsMigrations`,
  H12); freshness resolves environments with `load`. A Temporal worker's default id is
  `worker:temporal:<namespace>/<taskQueue>` (durability-4) and its effective task queue is
  `manifestTaskQueue(taskQueue, manifestId)` = `<taskQueue>@<manifest digest prefix>` (durability-6: workers of
  another runtime manifest never poll a run's tasks — point external workers at the same effective queue).
  `gate.failOnUnresolvedSeverity` accepts P0–P3 only (P4 is not a finding severity).
- (hardening, security-2/H1, behaviour) the default local sandbox (`network: loopback`) now runs agents' commands in
  user + network (+ PID + mount) namespaces with only their own loopback (tools README), hiding `sandboxHiddenPaths()`
  (new export: keys, state, the PGlite store, the fs artifacts) and every other workspace, and relaying only
  `sandboxEgressOrigins()` (new export: the registered environments' base URLs and URL entries of
  `tools.httpAllowlist`; loopback endpoints only); `diagnose()` reports the
  strategy, a warning when only the network is isolated or for `network: open`, and an error when the host cannot
  enforce the configured network.
- (context engine completion) `HypertestServices.provenance?: ProvenanceService` (additive, optional). **Behaviour:**
  the composed tool runtime is observing (`observeToolRuntime` of @hypertest/context): tool results feed the agent's
  read set, and a read whose observation cannot be recorded is returned `failed`/`unavailable` with its output withheld
  (effect tools' results are returned unchanged); the `file` resolver is registered for the workspaces this process
  opens; each workspace root's retriever fuses the symbol graph, exact search and a vector retriever (pgvector when
  available). Migration `context/003-observations` is part of `ALL_MIGRATIONS`.
- (runtime release management) `HypertestConfig.runtime?: { requireActiveRelease?: boolean }`; env
  `HYPERTEST_IMAGE_DIGEST`; `HypertestInstance.releases: RuntimeReleaseService` (`Hypertest.releases?`); new types
  `RuntimeReleaseService`, `RuntimeReleaseView`, `MigrateRunInput`, `RunMigrationResult`; `HypertestServices.adapters?`;
  `pinnedControlPlane` returns `ControlPlane & { forgetPin(runId) }`. New exports `providerLocality`, `hypertestGitSha`,
  `imageDigestFrom`, `IMAGE_DIGEST_ENV`, `condenserPrivacyFloor`, `agentClassification`, `releaseGovernedControlPlane`,
  `createReleaseService`, `runtimeReleaseNotes`, `withRuntimeReleaseNotes`, `DEFAULT_CHECKPOINT_TIMEOUT_MS`,
  `ReleaseServiceDeps`; `RuntimeReleaseService.quarantineIfRolledBack(runId)` and the `afterCreate` option of
  `releaseGovernedControlPlane` (the creator's re-check of a new run against a concurrent rollback).
  (review fixes) `RuntimeReleaseService.releaseCheckpoint(runId, { by, reason })` (an abandoned migration's checkpoint;
  `run.migration_released`); the `beforeDrive` option of `releaseGovernedControlPlane` (the re-check before `recover`
  and `resumeRun`); (behaviour) `resumeIncomplete()` quarantines, instead of resuming, a live run of this runtime whose
  release was rolled back; `resumeRun` re-checks after resuming; `migrate` takes and releases its checkpoint under the
  run's lock (a concurrent quarantine is never overwritten or undone), re-checks the target under the registry's lock
  inside its transaction and fails `conflict` when the run left its checkpoint's pause. (behaviour) the manifest's `toolCatalogRevision` is the runtime's `toolCatalogRevision` (tools
  with timeouts/bindings + adapter capabilities) instead of the tool registry's revision, and the manifest carries
  `gitSha`/`imageDigest`/engine adapters/`defaultEngine`/`roleCatalogRevision`: manifest ids change once with this
  version (runs pinned to an older runtime are driven by that runtime, or migrated); `diagnose` reports the specialist
  roles separately (`every core role can be routed`); the facade's `report` appends runtime-release notes; the control
  plane's `startRun`/`resumeRun` are release-governed.
- (hardening) conformance-8: `RuntimeManifest.hypertest.sourceDigest` (domain, additive) = `hypertestSourceDigest()`
  (new export): sha256 over every file under the packages' `src/` — changed code at the same version is another
  runtime (I11). conformance-12: an OPA policy engine's revision is `opa:<path>@<digest>` of the policy modules of the
  decision package served by OPA (`GET /v1/policies`; new export `opaPolicyRevision`; `@unverified` when OPA cannot list
  them), so a changed policy changes `policyRevision` and the manifest.
- (runtime-dsh) `HypertestConfig.engines.default` accepts `dsh` (`ENGINE_KINDS` = `native, pi, dsh`): the DeepSeek
  Harness adapter (`@hypertest/runtime-dsh`, new dependency; pinned, experimental) is registered — and pinned by the
  manifest: `agentEngines` `dsh` = the pinned dsh-agent version with its adapter, `providerAdapters` `engine:dsh` = the
  adapter and every pinned `@deepseek-ai` package — only when it is the configured default engine; `close()` disposes its
  DSH kernel. A drifted DSH install fails the composition (`precondition_failed`), never a run. Installations that do not
  select it are unchanged (same manifest).
- (unit model-runtime, wave 1) Config: `ProviderConfig.kind` `plugin`; `models.priceGuard` / `pricesFile` /
  `scoresFile`; `plugins?: PluginConfig[]`; route `capabilities` REQUIRED and conservative `ROUTE_DEFAULTS`
  (`internal`, `low`, unknown cost; both prices or none). `HypertestOverrides.fetch?` (the HTTP providers' fetch, for
  tests); `HypertestInstance.requestModelSwitch`, `agents(runId)`, `resume(runId)`; `HypertestServices.toolRuntime?`,
  `workspaces?`, `plugins?`. New exports `defaultedRouteFields`, `applyScoresFile`, `modelPricesFile` and re-exports
  `deriveRouteScores`, `parseRouteScoresFile`, `readPricesFile`, `updatePricesFile`. API: `POST /runs/:id/resume`,
  `GET /runs/:id/agents`, `POST /runs/:id/model-switch` (token). **Behaviour:** a provider whose credential is missing
  is unavailable (never called); `resumeIncomplete()` and `resume()` release model pauses; the RuntimeManifest records
  `modelScores` and `plugins` (manifest ids change when they are configured).
- (unit gate-governance, wave 1) Config: `gate.requireContracts` (boolean; default `true` through the gate's
  `DEFAULT_GATE_SPEC` — turning it off in a run override is a gate weakening that needs `gateOverrideBy`) and
  `environments[].isolation: { dedicated, namespace?, database?, account? }` (validated: `dedicated` boolean, the names
  strings, unknown keys refused) — the operator's registration that lets an experiment use isolation mode
  `dedicated_environment`. Behaviour reachable through the composition: every write/fault/load call needs an active
  experiment of its work item, test artifacts follow the full lifecycle (bound evidence, base-revision known-good,
  independent review), and a run needs a SystemModel to pass (gate C12). Tests: `test/config.test.ts`; the e2e fixtures
  (`test/helpers.ts`) record a SystemModel and declare the configured oracle's judge policy.

## Side-effect governance (audit wave 2, additive)

- The composed policy is `ApprovalGatedPolicyEngine(builtin ⊕ OPA)`; `approve()` sends the run an ApprovalSignal (a
  plain wake when the signal cannot be delivered) and applies a decided budget extension at once.
- Configuration: `budget.onExhausted: gate | pause | approval` (also per run); `sandbox.egressWrites: ledger | refuse`;
  `sandbox.insecureAllowUnhiddenSecrets` (the loud opt-in — without it a local sandbox that cannot hide keys, capability
  secret and store, or `network: open`, refuses the composition: `assertSecretsHidden`; doctor reports an ERROR);
  `environments[].credentials` (brokered credentials, validated with `brokeredCredentialProblems`; the registry keeps
  names only), `environments[].honoursIdempotencyKey`, `environments[].rawEgress`. A configured `signing.keyFile` is
  hidden from agent commands too.
- Facade: `resume(runId, { raise?, by?, rationale? })` (`ResumeRunOptions`), `listOperations(filter?)`,
  `resolveOperation(opId, outcome, actor, note)`. API: `POST /runs/:id/resume` accepts `{ raise, by, rationale }`;
  `GET /operations`, `POST /operations/:id/resolve` (token). Overrides `sandboxIsolation`, `credentialFetch` (tests).
- Tests: `test/secrets-governance.test.ts`, `test/api.test.ts`, `test/app.e2e.test.ts` (approval gate, budget policy),
  `test/config.test.ts`, `test/diagnose.test.ts`.

## Context and learning (unit context-learning, additive)

- **Configuration.** `memory: { kind: service, dataDir?, apiKeyEnv? }` (B[4]): createHypertest starts the L4 memory
  service as a CHILD PROCESS (`startMemoryServiceProcess`: this package's `memory-service.ts` run by the current node
  binary, its own PGlite store at `dataDir` — default `<project dataDir>/memory`, held exclusively —, a random per-start
  bearer token unless `apiKeyEnv` names one, only PATH/HOME/TMPDIR/LANG passed on), talks to it through
  `PowerContextClient`, and stops it on `close()` (SIGTERM, SIGKILL after 10 s); `memory: { kind: powercontext,
  baseUrl, apiKeyEnv? }` reaches a service started elsewhere (`hypertest memory serve`, or `serveMemory()`). With either,
  the experience decisions the service accepted are also on this deployment's L0 (`withExperienceEvents`).
  `retrieval: { embedder: { provider, model, dimensions, timeoutMs? } }` (B[6]): semantic L3 embeddings through the
  `/embeddings` endpoint of a configured `openai-compatible` provider (its baseUrl, apiKeyEnv, headers; the `fetch`
  override applies); every answer's dimensions are verified; a missing credential sends nothing (the hashing embedder is
  used and a warning logged); another provider kind is a configuration error. pgvector keeps one vector size per
database: when `ht_vectors` already holds vectors of another size (e.g. from the hashing embedder), the corpora of the
new embedder stay in memory (logged at startup of the first search). Code leaves the machine to that provider:
  configure a local endpoint for private code. (review, privacy) An agent whose context is classified `restricted`
  (local_private, or a work item with `modelPolicy.privacyClass: restricted`) never has its workspace embedded by a
  provider outside this host / private network (`providerLocality`): its retrieval embeds with the local hashing embedder
  into in-memory corpora of its own. `skills: { trial: SkillRevision[] }` (B[7], set by `hypertest skill validate` on the
  eval arm bound to a revision): those candidate revisions — digest-checked — reach this instance's prompts, marked as
  under evaluation; an instance started with it logs a warning (an evaluation setting, never for production runs).
- **Composition.** `services.skills` (the store-enforced Skill Registry; L1 shows only published skills, plus the trial
  ones); the runtime SessionStore wrapped by `recordTranscriptOnL0` (B[8]: every transcript entry on L0 in the same
  transaction); the freshness pass log; plugin record tools wrapped by `freshnessChecked` (B[1]); the code tools'
  retrieval port `createCodeToolRetrieval` (B[6]: `code.symbols` / `code.references` answer from the syntax-tree symbol
  graph, "who writes X" included). The Go `go/ast` helper (it runs in this process, outside the sandbox) is built in
  `<dataDir>/state/parsers` — inside the state directory every sandboxed command finds hidden — never at a shared temp
  path (review: a sandboxed command could otherwise replace it and have the host execute it).
- **Exports.** `cachedRetrievers` (the per-root L3 retrievers, with the restricted path), `serveMemory`, `startMemoryServiceProcess`, `MemoryServiceConfig`, `MemoryServiceProcess`,
  `RunningMemoryService`; `renderSkillMarkdown`, `skillArmId`, `skillDigest`, `SKILL_NAME_RE`, `SKILL_STATUSES` and the
  skill types.
- **Tests.** `test/memory-service.e2e.test.ts` (a real child process: own storage surviving a restart, bearer auth,
  server-side invariants, one process per data directory; `memory.kind: service` end to end: approved experience from
  the service in the executor's prompt, decisions on L0, process stopped on close), `test/retrieval.e2e.test.ts`
  (`retrieval.embedder` through a fake fetch; the lead's `code.references` answered from the symbol graph; missing
  credential and config errors), `test/context-review.e2e.test.ts` (through createHypertest: a withdrawn prompt-only
  finding refuses the executor's record call until it is told, a merely confirmed one does not block; every record tool
  of the composed catalog is freshness-checked; the Go helper in the hidden state directory; a restricted root never
  reaches an off-host embedder), `test/skills.e2e.test.ts`, `test/event-catalog.e2e.test.ts` (every event type of the
  typical catalog on a scripted run's L0, `test.recovered` included). Behaviour changes reflected in existing tests: the
  unknown-key message lists `retrieval` and `skills`; the code section's heading names its retrievers.

## Tool surface (audit wave 3, unit tool-surface, additive)

Configuration keys (validated in `config.ts`, problems from `tool-config.ts`; every accepted key is honoured or refused):

- `tools.urlEnvironmentClass` — class of non-loopback allowlisted URL targets (no default: without it a non-loopback
  URL is not an environment and a warning names it — the class decides what the policy lets agents do there).
  `compose.ts` registers one environment per classified `tools.httpAllowlist` URL (`urlTargetEnvironments`);
  `run({target: {sutUrl}})` resolves the URL to it (`resolveUrlTarget`: ambiguous → invalid_argument, nothing serves it →
  precondition_failed).
- `tools.mcpServers` (`mcpServerProblems`, `mcpServerConfigs`: variables by NAME, a missing one makes the server
  unavailable), `tools.acpAgents` (`acpAgentConfigs`), `tools.remoteWorkers` (`withRemoteWorkers`; `startToolWorker`
  serves `hypertest tool-worker`), `tools.computerUse` (`computerUseOptions`); `withToolRoleGrants` offers `mcp.<id>.*`,
  `acp.<id>.*`, `computer.*` to the configured roles (defaults `DEFAULT_MCP_ROLES`, `DEFAULT_ACP_ROLES`,
  `DEFAULT_COMPUTER_ROLES`).
- `environments[].grpc|logs|traces|database|control.context` (`environmentToolProblems`; database credentials only by
  variable name). The instance environment is passed to the tools (`BuiltinToolOptions.env`) for `database.urlEnv`.
- `sandbox.allowedHosts` (only with `network: egress_allowlist`, local sandbox, loopback host:port), `cpuLimit`,
  `memoryMb` (`sandboxKeyProblems`), and `sandbox.roles.<role>: {tier: read_only | isolated | separate, kind, image,
  network, allowedHosts, cpuLimit, memoryMb}` (`sandboxRoleProblems`; read_only is refused for roles holding workspace
  write tools). `isolationResolver(config, blackboard)` is the ToolRuntime's isolation tier per call (role tier, made
  stricter by the work item's capability requirements; a work item whose requirements cannot be read fails the call
  closed — never the wider role tier — and the failure is not cached). When a tier names the other sandbox kind both
  runners are composed (`routedSandbox`).
- Oracles and gate requirements never name evidence type `inconclusive` (refused by `validateConfig`): evidence a call
  records after a refused sandbox write is kept as `inconclusive` and must not satisfy or violate anything.

Tests: `test/tool-surface-config.test.ts`, `test/environments.test.ts`, `test/mcp-tools.e2e.test.ts`, `test/container-faults.e2e.test.ts`,
`test/vision-gui.e2e.test.ts`, `test/acp-agent.e2e.test.ts`, `test/remote-worker.e2e.test.ts`,
`test/computer-use.e2e.test.ts`, `test/sandbox-tiers.e2e.test.ts`.

## Release stages, verified migration drive, harness features (audit wave 3, unit release-eval, additive)

- **Per-stage release gates (F[0])** — `RuntimeReleaseService` (`releases.ts`): `recordEvalSuite` records a
  `compatibility` result from an eval SuiteResult only when every trial ran under the certified manifest
  (`evalTrialManifests`; e2e[5]) and the result is complete (a CANCELLED partial result is refused, as by the release
  gate); `recordReleaseGate` records the `release_gate` result of a CORE eval candidate
  (bound to the manifest, with the candidate and baseline digests; a candidate gated against itself or against a
  baseline that ran under the same release is refused); `mirror(runId)` runs a finished production run again on a SHADOW
  release (label `hypertest.shadow_of`, admitted only by a shadow — a shadow admits nothing else, also before any
  release is active; the source must be a run of the active release, or, unmanaged, of no rolled-back/retired one) and records the comparison of decisions
  (`shadowDivergences`: run status, verdict, violated/unknown criteria, human review); `shadowCandidates()` picks the
  runs `runtime.shadow: {percentage, labels, minRuns, timeoutMs}` selects; `recordProductionReplay` turns the
  comparisons into the `production_replay` result (≥ minRuns, no divergence). `compose.ts` wraps every side-effect
  adapter in `shadowDryRunAdapters`: an operation of a mirrored run is prepared, recorded `not_applied: dry_run` and
  never dispatched (gateway and reconciler alike).
- **Migration drive (F[1])** — `migrate(…, {drive: true})` and `drive(runId)` start this runtime's durable loop on a run
  migrated here and wait for `run.migration_driven` (recorded by the loop's first `recover`, `markDriven`); a previous
  loop still open (Temporal: the run workflow on the SOURCE manifest's task queue) is woken, and when no source worker
  is left a handover worker (`handoverControlPlane`, refusing only that run) serves the source queue briefly.
  `HypertestInstance.resume(runId)` goes through `drive`: a migrated run is never resumed by a silent no-op start
  (`unavailable` with the remedy instead); so does `resumeIncomplete()` (`hypertest resume` without a run id, `serve`):
  a migrated run that was not taken over is left out of the resumed runs (warning with the remedy). Item 17: a work item waiting ONLY on model pauses migrates (its pause carries
  over: `RuntimeEpoch.carriedModelPauses`); any other wait still refuses.
- **Harness features (F[8])** — `harness.features` (`harness-features.ts`: subagents, dynamicScheduler, blackboard,
  contextFreshness, oracleGovernance) switch subsystems off for the eval's causal arms, honoured only for an eval trial
  instance (`HypertestOverrides.evalTrial`); a deployment configuration that disables one is refused at composition.
- **Arm overrides (item 6)** — `HypertestOverrides.fetch` (the HTTP model adapters' transport) and `env` let the eval's
  three-provider-class arm run the anthropic, openai-compatible and pi-ai adapters over a scripted wire transport;
  `configuredModels(config, …)` builds providers and routes for the configured judge.

Contract changes (additive): `RuntimeReleaseService.recordEvalSuite`, `recordReleaseGate` (+ `baseline?`), `mirror`,
`shadowCandidates`, `recordProductionReplay`, `markDriven`, `drive`; `MigrateRunInput.drive`, `driveTimeoutMs`,
`signal`; `RunMigrationResult.driven`, `driveProblem`; `config.runtime.shadow`, `config.harness.features`;
`HypertestOverrides.evalTrial`, `fetch`, `env`. Behaviour change: `resume` of a migrated, not yet driven run waits for
the take-over (or fails `unavailable`); `resumeIncomplete()` takes such runs over too (or leaves them out).

Tests: `test/release-stages.e2e.test.ts` (shadow mirroring dry-run and decision comparison, each stage's gate and its
refusals, the item-17 migration and its other-wait refusal, `driven` never claimed without a drive, `resume` refusing
a take-over that did not happen, and on a live Temporal cluster: the source worker alive, the source runtime gone, and a
migration without drive taken over by `resume`), `test/releases.e2e.test.ts`, `test/harness-features.test.ts`.
