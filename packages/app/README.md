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
- **Routes** name at least `routeId`, `provider` (declared in `models.providers`) and `model`; `ROUTE_DEFAULTS` fill
  the rest: capabilities `[tool_use, structured_output]`, structuredOutput `native`, reasoning `none`, contextWindow
  128000, maxOutputTokens 4096, maxDataClassification `confidential`, quality `{default: 0.7}`, toolReliability 0.8,
  costs 0, typicalLatencyMs 2000, maxActionRisk `high`, enabled. `continuationCompatibilityClass` is the provider's
  tag: `anthropic:<model>`, `pi-ai:<api>:<piProvider>:<model>` (resolved pi model), `<providerId>:<model>` for
  openai-compatible/scripted; a pinned different tag for anthropic/pi-ai is refused. The defaults do **not** satisfy
  the built-in lead (reasoning + long_context, quality ≥ 0.75): declare capabilities and quality per route —
  `diagnose` lists the roles no route can serve.
- **Roles**: built-in catalog ⊕ `models.defaultPolicy` (applied to every role's model policy) ⊕ the condenser as a
  plain summarizer (`requiredCapabilities: []`, it is invoked without tools) ⊕ `roles.<role>` (wins).
- Missing `apiKeyEnv` variables are not load errors: `createHypertest` logs a warning (name only) and `diagnose`
  reports an error.

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
(`environment`, `oracle`, `experiment`, `record`, `lease`; control adds `finding`), freshness guard, experience memory
(SQL or PowerContext), provenance, working context, per-root retrievers (symbol index + single-line exact search);
workspace manager (`<dataDir>/workspaces`), local/OCI sandbox, tool registry (built-in tools with `stateDir`, then the
control domain tools), tool runtime; sessions, agents, epochs, `EngineRegistry` (native + pi), subagents, runner;
roles; the **RuntimeManifest**; control plane wrapped by `pinnedControlPlane` (I11, below) and
`releaseGovernedControlPlane` (runtime release admission, below; its router has the condenser privacy floor); the
runtime release service (`ht.releases`); durable runtime (`LocalDurableRuntime` or `TemporalDurableRuntime`, with
`getRun` and a `resolveClaim` that only returns claims held by this worker). A failure closes whatever was opened.
Runs are **not** resumed automatically — call `resumeIncomplete()` (`hypertest resume`).

**RuntimeManifest** (the runtime BOM): `hypertest` = `version` (monorepo root package.json), `sourceDigest`, `gitSha`
(`git rev-parse HEAD` of the installation when it is the top level of a git checkout — never a parent repository's
commit; absent otherwise) and `imageDigest` (`HYPERTEST_IMAGE_DIGEST` of the composition environment, `sha256:<64 hex>`;
a malformed value fails the composition before anything is created); `agentEngines` (`native` = @hypertest/runtime
version, `pi` = pi-agent-core version, each with its `adapter` package/version — `@hypertest/runtime-pi` for pi);
`defaultEngine`; `providerAdapters` (every model provider + `engine:native` @hypertest/runtime, `engine:pi`
@hypertest/runtime-pi and @earendil-works/pi-agent-core); `modelCatalogRevision`; `schemas` (last migration id of
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
quarantined (or `migrating`) run is refused. `migrate(runId, { to, by, reason, checkpointTimeoutMs?, drive? })` is the
only way a live run changes runtime: checkpoint (pause `migrating` a running run and wait until no work item holds a live
claim), canonical ContextSnapshot, operation reconciliation (refused while any operation of the run is unsettled —
prepared, dispatching, acknowledged, outcome_unknown, reconciling, compensating or manual_review — or a work item waits),
compatibility (`runtimeCompatibility`: target active/canary, same schemas or an explicit allowed migration, the engines
the run used, same protocol), then ONE transaction: the target manifest stored in `ht_manifests`, a RuntimeEpoch, the
re-pin, `run.migrated`, and the resume (`running`, or the run's own earlier pause: an operator/budget/approval pause, or
the pause a quarantine replaced, is kept). A failed migration releases the checkpoint it took. The report of a run
carries its quarantine and migration notes (`## Runtime release`, `recovery`, `json.runtimeRelease`). Proven with the
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
| Crash safety: a run interrupted mid-turn by `close()` is resumed by the next instance over the same data dir and completes | `test/app.e2e.test.ts` (restart) |
| `close()` releases every handle (a child process that composed, ran and closed exits on its own) | `test/app.e2e.test.ts` + `test/fixtures/exit-probe.ts` |
| API: validation, media type, body limit, Host guard, bearer token, JSON errors without internals, malformed paths, SSE ordering/resume/end (never before the final events) | `test/api.test.ts`, `test/app.e2e.test.ts` (REST API over a real instance) |
| Production wiring: PostgreSQL + NATS JetStream (delivery proven by a probe consumer) + OPA composed with the built-in rules; Temporal durable runtime (through the pinned control boundary); doctor is read-only on PostgreSQL | `test/app.int.test.ts` |
| I11 runtime releases: new runs only under the active release or a selecting canary (refused starts create nothing); promotion over recorded passing suites; rollback moves the pointer back, old runs continue on their pinned manifest, the rolled-back release's runs are quarantined (paused, `run.quarantined`, report note, resume refused); explicit migration (checkpoint, snapshot, reconciliation, compatibility, RuntimeEpoch + `run.migrated` + re-pin + resume) completes the run on the new runtime; migration refusals (checkpoint timeout, unknown ids, non-promoted target, unsettled operation) leave the run as it was; `runtime.requireActiveRelease`; drained releases retire; the image digest is part of the BOM | `test/releases.e2e.test.ts` |
| Runtime BOM inputs (git commit of the installation only, image digest format), condenser privacy floor (restricted agents condensed on restricted routes only, replayed hosted decisions refused), admission wrapper, pin-cache eviction, report notes | `test/releases.test.ts` |
| Doctor route coverage of the specialist roles (vision + computer-use fallback, restricted data only on local routes) | `test/diagnose.test.ts` |

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
- (runtime release management) `HypertestConfig.runtime?: { requireActiveRelease?: boolean }`; env
  `HYPERTEST_IMAGE_DIGEST`; `HypertestInstance.releases: RuntimeReleaseService` (`Hypertest.releases?`); new types
  `RuntimeReleaseService`, `RuntimeReleaseView`, `MigrateRunInput`, `RunMigrationResult`; `HypertestServices.adapters?`;
  `pinnedControlPlane` returns `ControlPlane & { forgetPin(runId) }`. New exports `providerLocality`, `hypertestGitSha`,
  `imageDigestFrom`, `IMAGE_DIGEST_ENV`, `condenserPrivacyFloor`, `agentClassification`, `releaseGovernedControlPlane`,
  `createReleaseService`, `runtimeReleaseNotes`, `withRuntimeReleaseNotes`, `DEFAULT_CHECKPOINT_TIMEOUT_MS`,
  `ReleaseServiceDeps`. (behaviour) the manifest's `toolCatalogRevision` is the runtime's `toolCatalogRevision` (tools
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
