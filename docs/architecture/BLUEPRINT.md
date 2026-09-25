# Hypertest Implementation Blueprint

Status: normative for the v0.3 rebuild. Sources: [technology selection](../design/technology-selection.zh-CN.md)
and [architecture improvements](../design/architecture-improvements.zh-CN.md). Where the two disagree, the
improvements document wins (it revises the selection report). Every package's `src/contracts.ts` is the
binding ABI; this document explains it.

## 1. What we are building

> **Hypertest is a versioned, multi-model, durable and evidence-verifiable autonomous testing system whose
> agents may explore freely, but whose truth, side effects and quality decisions are governed outside the model.**

Input is a **testing goal** ("assess whether this change is releasable"), not a workflow. Hypertest itself
decides how to decompose the goal, which risks to verify, white-box vs black-box, how many subagents, which
model per role, which tools, whether to add tests, and when to replan. It then executes the loop

```
analysis → risk → test design → environment → implementation → execution → dynamic extra testing →
defect analysis (RCA) → authorized fixes → regression → quality acceptance → report → experience/test improvement
```

Three things are **never decided by a model**:

1. **What is correct** – versioned `OracleSpec` (+ `SystemModel`, `ExperimentSpec`), changed only through
   governed `OracleChangeProposal`s that the proposing agent can never self-approve.
2. **What actually happened in the external world** – the `OperationLedger` (+ reconciliation, fencing) and
   the tamper-evident `EvidenceLedger`.
3. **Whether a pass may be claimed** – `QualityDecision`, produced only by the deterministic `QualityGate`
   from evidence, oracles, findings, risks and reviews. Evidence gaps yield `inconclusive`, never `pass`.

### 1.1 State authority (single owner per fact)

| Fact | Authority | Package |
|---|---|---|
| Run / work lifecycle (when durable) | Temporal workflow history, else `ht_run_lifecycle` | durable |
| WorkItems, Findings, Hypotheses, CoverageGaps, Risks, Reviews, Plans | Blackboard (PostgreSQL) | collab |
| Immutable execution + domain history | Event Store L0 (PostgreSQL, append-only) | collab |
| Whether an external side effect happened | Operation Ledger + external reconciliation | operation |
| Correctness criteria | OracleSpec revisions | domain/policy |
| Experiment conditions | ExperimentSpec revisions | domain |
| Raw results | Evidence Ledger + content-addressed Artifact Store | evidence |
| Final verdict | QualityDecision store (written only by QualityGate) | policy/control |
| What a model saw | ContextSnapshot – a projection, never truth | context |
| Event propagation | Event bus (in-process or NATS JetStream, at-least-once) – never truth | collab |

### 1.2 Hard invariants (tests must prove each; see §7)

- I1 Models propose; deterministic code disposes. No tool executes without a capability check, a policy
  permit and (for mutating tools) a freshness validation.
- I2 Child capability = parent ∩ role policy ∩ work-item requirements ∩ environment policy. Never amplified.
- I3 Model/provider switches happen only at a safe turn boundary (response complete, all tool calls settled,
  no pending structured output, snapshot fixed, permissions re-checked) and start a new `ModelEpoch`.
  Fallback is fail-closed: security → capability → tool compatibility → quality floor are re-validated.
  Routing order is security → capability → role suitability → quality → latency → cost. Never cost-first.
- I4 Every external/destructive tool call has a stable `operationId`; retries reconcile before
  re-dispatching; unknown outcomes become `outcome_unknown`, never `failed`; stale fencing tokens are refused.
- I5 Event delivery is at-least-once; every consumer dedupes by `eventId` (inbox); duplicate delivery never
  duplicates side effects or work items (fingerprints).
- I6 Evidence is append-only with SHA-256 artifact hashes, a per-run hash chain and Merkle root; agents
  cannot delete or rewrite evidence.
- I7 P0/P1 gates cannot be satisfied by an LLM-only judgement; missing required evidence ⇒ `inconclusive`.
- I8 An agent can never weaken an oracle, assertion, threshold, or delete/skip a failing test to get green;
  such patches are classified and require independent approval, then a new experiment.
- I9 Large tool outputs are artifact-offloaded; only bounded digests enter model messages.
- I10 All model routes, tool calls, permits, gate evaluations and state transitions emit L0 events with
  `runId`, `workItemId`, `agentId`, `correlationId`, `causationId`.
- I11 A running TestRun is pinned to its `RuntimeManifest`; runtime upgrades never hot-swap a live run.
- I12 Bounded decentralization: concurrency, depth, agent count, token, cost, tool-call and wall-clock
  budgets are enforced by the scheduler; the scheduler keeps convergence authority.

## 2. Toolchain and conventions

- Node.js ≥ 22.18, TypeScript 5.9, ESM, npm workspaces (`packages/*`). **No build step**: Node strips
  types natively, so every package's `package.json` exports `./src/index.ts`.
- Only **erasable** TypeScript (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter
  properties, no decorators. Use string-literal unions and `as const` objects.
- `verbatimModuleSyntax`: use `import type` for type-only imports. Relative imports use the `.ts` extension.
- Tests: `node:test` + `node:assert/strict`, files in `packages/<pkg>/test/`. `*.test.ts` unit (hermetic),
  `*.int.test.ts` integration (local infra; **skip with an explicit reason** when env vars are missing),
  `*.e2e.test.ts` end-to-end. Run `npm test`, `npm run test:unit`, `node scripts/run-tests.mjs --package x`.
- Typecheck the whole monorepo with `npm run typecheck`; boundaries with `npm run check:boundaries`.
- IDs: `newId(prefix)` from core → `run_01J…` (time-sortable, 26 char Crockford base32). Inject
  `IdGenerator`/`Clock` everywhere for deterministic tests.
- Integers that the design documents type as `bigint` (event seq, revisions, fencing tokens) are JS
  `number` (safe integers) and PostgreSQL `bigint`; the SQL layer converts.
- Timestamps: ISO-8601 UTC strings in domain objects.
- Errors: throw `HypertestError` (code, message, retryable, details) for faults; return domain outcomes
  (`status: 'failed'`) for legitimate negative results. A failing test is a successful tool call with a
  failed outcome, never a thrown error.
- Validation: plain JSON Schema objects (`JsonSchema` type) + `validateJson` (Ajv 2020, cached) from core.
- Persistence: every stateful component talks to `SqlDatabase` (core port). `@hypertest/store` provides
  PGlite (embedded, dev/tests) and node-postgres (server) implementations plus the migrator. Each package
  exports `migrations: Migration[]` with `ht_`-prefixed tables and ids `<pkg>/<nnn>-<name>`; SQL must run on
  both PGlite and PostgreSQL 16.
- No network in unit tests. LLMs in tests are `ScriptedProvider`s or local mock HTTP servers.
- Logging through the core `Logger` port; no `console.log` in library code.
- Every production change includes failure-path tests.

## 3. Packages and dependency DAG

Enforced by `scripts/check-boundaries.mjs` (`ALLOWED` map).

| Package | Responsibility | May depend on |
|---|---|---|
| `core` | ids, clock, errors, canonical JSON, hashing, JSON-schema validation, `SqlDatabase`/`Migration`, `EventBus` port, logger, abort/timeout utils | – |
| `domain` | all domain types (TestRun, Plan IR, WorkItem, Blackboard records, SystemModel, OracleSpec, ExperimentSpec, TestArtifact, QualityDecision, Evidence, Operation, ContextSnapshot, ModelEpoch, RuntimeManifest …), event catalog, state machines, pure invariants | core |
| `store` | PGlite + node-postgres `SqlDatabase`, migrator, `createTestDatabase()` | core |
| `testkit` | test helpers: fixed clock/ids, temp dirs, git repo builder, infra env detection | core, domain, store |
| `evidence` | ArtifactStore (fs, S3), EvidenceLedger (hash chain, Merkle root, Ed25519 signer, verifier), claims | core, domain |
| `operation` | OperationLedger + state machine, LeaseService (monotonic fencing), SideEffectGateway, Reconciler, SideEffectAdapter protocol, ResourceAdmission (claims), BudgetLedger (reserve/settle) | core, domain |
| `collab` | EventStore (L0), transactional Outbox + relay, Inbox dedupe, EventBus impls (in-process with fault injection, NATS JetStream), Blackboard (records, work items, plans, claims) | core, domain |
| `policy` | capabilities (attenuation), PolicyEngine (built-in rules + OPA adapter + decision log), OracleGovernance, TestChangeClassifier (self-heal policy), QualityGate, BUGate ProtocolBinding / PreparedProtocolContext | core, domain |
| `model` | ModelCatalog/CapabilityProfiles, ModelRouter (fail-closed fallback), provider-neutral message IR, providers (scripted, OpenAI-compatible, Anthropic, pi-ai reuse), usage + cost | core, domain |
| `context` | ContextSnapshot builder/store, FreshnessGuard, L1 PromptAssembler, L2 WorkingContext + condensers (hard/soft) + artifact offload, L3 retrieval (exact/FTS, symbol index, vector), L4 ExperienceStore + PowerContext client, L5 provenance queries | core, domain, collab, evidence |
| `tools` | ToolSpec, ToolRuntime pipeline (validate→capability→permit→freshness→operation→execute→offload→evidence→events), WorkspaceManager (shared snapshot, git worktree, OCI sandbox), built-in white-box and black-box tools | core, domain, evidence, operation, policy |
| `runtime` | **AgentEngine ABI**, NativeEngine (Hypertest agent loop), SessionStore, SubagentRuntime, RuntimeManifest builder, engine contract test-suite | core, domain, model, context, tools, policy |
| `runtime-pi` | Pi engine adapter (`pi-agent-core`) passing the AgentEngine contract suite | core, domain, model, runtime |
| `runtime-dsh` | DeepSeek Harness adapter (pinned, experimental; pin + adapter, no fork) | core, domain, model, runtime |
| `agents` | role catalog: prompts, default ModelPolicy, tool allowlists, output schemas, event subscriptions | core, domain |
| `control` | Plan IR validation, DynamicScheduler (admission, deps, budgets, concurrency, resource claims), reactors (event → work), ConvergenceMonitor, RunDriver + AgentWorker, domain tools (blackboard/plan/oracle/evidence/delegate/complete_work) | core, domain, collab, operation, policy, evidence, model, context, tools, runtime, agents |
| `durable` | DurableRuntime port, LocalDurableRuntime, Temporal workflows/activities/worker/client | core, domain, control |
| `app` | configuration (`hypertest.config.yaml`), composition root `createHypertest()`, HTTP API | all runtime packages |
| `eval` | EvalTask/Trial, harness (fresh env per trial), graders, stats (McNemar, paired bootstrap, pass^k), suites incl. PoC A/B/C, scripted brains | see ALLOWED |
| `cli` | `hypertest` commands | core, domain, app, eval, evidence, store |

Third-party containment: `pi-agent-core` only in runtime-pi; `pi-ai` in runtime-pi and model;
`@deepseek-ai/*` only runtime-dsh; `@temporalio/*` only durable; `@nats-io/*` only collab; `pg` and
`@electric-sql/*` only store; `@aws-sdk/*` only evidence; `playwright` and `@modelcontextprotocol/*` only
tools; `ajv` only core.

## 4. Key flows

### 4.1 Run lifecycle

1. `app.createHypertest(config)` wires stores, bus, router, policy, tools, engines, scheduler, durable runtime.
2. `startRun({goal, target, budget})` creates `TestRun` + pinned `RuntimeManifest` + `ProtocolBinding`
   (BUGate) + initial `ContextSnapshot` and a `lead` WorkItem (`kind: 'initial_plan'`). Emits `run.created`.
3. The durable runtime drives `RunDriver.tick(runId)` until convergence:
   - consume pending domain events through reactors (inbox-deduped) → new WorkItems (fingerprint-deduped);
   - apply accepted `PlanRevision`s (Lead proposes typed Plan IR via `plan.propose_revision`; the
     `PlanValidator` + policy + scheduler admission accept or reject it — never arbitrary code);
   - admission: deps satisfied, budget reservable, concurrency/depth/agent caps, resource claims → claim
     (lease + fencing token) → dispatch to an `AgentWorker`;
   - replan triggers (plan drained with objectives open, new P0/P1 finding, gate feedback) → Lead WorkItem;
   - convergence (nothing runnable/running/waiting, no unconsumed events, no pending replan) → QualityGate.
4. QualityGate → `QualityDecision` (`pass|fail|conditional|inconclusive`) signed and bound to the evidence
   root, oracle/experiment revisions and manifest. If the gate requests more evidence and budget/replan caps
   allow, the Lead replans once more; otherwise the decision is final.
5. Report generation (claims → evidence queries), experience candidates (L4, pending review) and `run.completed`.

### 4.2 Agent work item execution (one WorkItem)

`AgentWorker.execute(workItemId)` → resolve `AgentSpec` (role catalog + work item) → capability attenuation →
`SubagentRuntime` creates/resumes an `AgentInstance` + engine session → loop `engine.runTurn()`:

- Turn start: build/refresh `ContextSnapshot`; Router picks a route (new `ModelEpoch` only at this
  boundary); `PromptAssembler` builds L1 from role, objective, work item, BUGate context, tools, working
  context (L2), retrieval (L3), durable memory (L4), evidence refs (L5).
- Model call (budget reserve → settle). The assistant response is persisted **before** any tool executes.
- Each tool call → `ToolRuntime.execute` with idempotency key `sessionId:turn:toolCallId`.
- Results are offloaded if large; the turn is committed. Durable retry of a turn replays the committed
  response and only re-executes tool calls that are not settled (side-effect calls reconcile through the
  Operation Ledger).
- `complete_work` validates structured output against `WorkItem.expectedOutput`; `fail_work` records a
  failure. Limits (turns, tokens, cost, wall clock, tool calls, repetition) end the item as `failed` with
  reason `budget_exhausted` – never silently downgraded.
- `pending` tools (long-running operations) put the item in `waiting` with operation ids; the durable
  runtime polls `observe` with durable timers, then resumes the next turn.

### 4.3 Event-driven collaboration (no Lead in the path)

Executor posts `finding.created` (Blackboard write + outbox in one transaction) → outbox relay publishes →
reactors subscribed by role (`agents` subscriptions: e.g. RCA on `finding.created` severity ≥ P2, TestDesigner
on `finding.created` and `coverage.gap_detected`, Reviewer on `review.requested`) create claimable WorkItems
with deterministic fingerprints → scheduler admits → agents claim with leases. RCA posts hypotheses; the
TestDesigner registers a regression `TestArtifact`; the Reviewer judges evidence (never only the executor
narrative). Causal chain: `causationId` links every step. Livelock guards: causal depth limit, per-rule
rate limits, fingerprint dedupe, global work-item cap.

### 4.4 Crash recovery

All truth is in PostgreSQL/Temporal. On restart: the durable runtime resumes incomplete runs; each
work item resumes from its SessionStore (last committed turn); `OperationLedger` entries in
`dispatching/acknowledged/outcome_unknown` are reconciled via adapters (`observe` by operationId) before any
re-dispatch; `verified` operations return their recorded result; expired leases are re-granted with a new
fencing token and stale workers are refused.

## 5. Package specifications

Each package owns: `src/contracts.ts` (ABI, written first), implementation modules, `src/index.ts`
(re-exports), `migrations` (if stateful), tests. Contract changes must be backward compatible and noted in
the package `README.md`.

### core
Exports: `newId`, `IdGenerator`, `Clock` (+ `systemClock`, `FixedClock`), `HypertestError`/codes,
`canonicalJson`, `sha256Hex`, `validateJson`/`compileSchema`, `JsonSchema`, `SqlDatabase`/`SqlExecutor`/
`Migration`, `EventBus`/`EventEnvelope`/`DeliveredEvent`/`Subscription`, `Logger` (+ `noopLogger`,
`consoleJsonLogger`), `withTimeout`, `sleep`, `AbortError` helpers, `Result`.

### domain
Pure types + pure functions: state-transition tables (`canTransitionWorkItem`, `canTransitionOperation`,
`canTransitionRun`), `workItemFingerprint`, oracle strength ordering, severity ordering, event catalog
(`EVENT_TYPES`), and the JSON Schemas for LLM-facing domain payloads (plan proposal, finding, hypothesis,
coverage gap, review, oracle change proposal, test artifact registration).

### store
`openDatabase({ kind: 'pglite', dataDir? } | { kind: 'postgres', url })`, `migrate(db, migrations)`
(idempotent, ordered, recorded in `ht_migrations`, runs in a transaction per migration), and
`createTestDatabase()` (fresh in-memory PGlite; or a fresh schema on `HYPERTEST_TEST_PG_URL` when
`HYPERTEST_TEST_DB=postgres`). PGlite gets pgvector enabled when requested.

### evidence
- `ArtifactStore`: `put(bytes|stream, {mimeType, classification})` → `ArtifactRef` (`sha256`, `size`, `uri`);
  content-addressed, idempotent; `get`, `head`, `exists`. Implementations: filesystem, S3-compatible.
- `EvidenceLedger`: `append(input)` computes `recordHash = sha256(canonical(metadata) || artifactSha256 ||
  previousRecordHash)` under a per-run advisory lock; `get`, `query`, `rootHash(runId)` (Merkle root over
  record hashes), `verify(runId)` (chain + artifacts + signatures), `seal(runId)` signs the root.
- `Signer` (Ed25519 via node:crypto; key id; KMS port). Signer identity is separate from writers.
- Claims: `ReportClaim { statement, value?, evidenceQuery, evidenceRefs }` + `resolveClaim`.

### operation
- `OperationLedger` exactly per the improvements document (`prepared → dispatching → acknowledged →
  verified`, `outcome_unknown → reconciling → verified|not_applied|manual_review`, compensation states).
- `LeaseService.acquire(resourceKey, owner, ttl)` → `ResourceLease` with a **monotonic fencing token**
  (PostgreSQL sequence per resource); `renew`, `release`, `validateFence(resourceKey, token)`.
- `SideEffectGateway.run(op, adapter, input)` implements the retry switch (verified → cached; prepared/
  not_applied → dispatch; dispatching/acknowledged/outcome_unknown → reconcile). Non-reconcilable high-risk
  operations are never auto-retried (→ `manual_review`).
- `ResourceAdmission`: hierarchical keys (`cluster/x/ns/y`), modes `read_shared|write_exclusive|
  fault_exclusive`; conflicts on ancestor/descendant overlap; atomic multi-claim admission.
- `BudgetLedger`: `reserve(scope, amounts)`, `settle(reservationId, actual)`, `release`, `remaining(scope)`;
  exhaustion returns a typed outcome consumed by the scheduler (`paused_budget`, never silent downgrade).

### collab
- `EventStore` (L0): `append(events, tx?)` assigns per-run `seq`; `read(runId, fromSeq)`, `readByType`.
- `Outbox`: written in the same transaction as the state change; `OutboxRelay` publishes to the bus and
  marks sent; `Inbox.dedupe(consumer, eventId, tx)`.
- `EventBus` implementations: `InProcessEventBus` (durable consumers, ack/redelivery, fault injection:
  duplicate delivery, delayed ack) and `NatsJetStreamEventBus` (`@nats-io/jetstream`, explicit acks).
- `Blackboard`: typed record CRUD with revisions/supersedes (`postRecord`, `supersede`, `query`), work items
  (`createWorkItem` with fingerprint uniqueness, `transitionWorkItem` with state machine + fencing,
  `claimWorkItem` lease, `listRunnable`), plan revisions (`proposePlan`, `acceptPlan`, `rejectPlan`), all
  emitting domain events through the outbox; `revision(runId)` gives the blackboard revision.

### policy
- Capabilities: `ActionCapability` + `attenuate(parent, ...constraints)`; HMAC-signed `CapabilityToken`.
- `PolicyEngine.evaluate(ActionRequest) → ActionPermit` (`allow|deny|approval_required` + constraints),
  built-in rule set (effects × risk × environment class × role) and `OpaPolicyEngine` (HTTP data API) with
  a composite "deny wins" combinator; every decision recorded (`PolicyDecisionRecord` with decision id,
  input hash, policy revision).
- `OracleGovernance`: propose/approve/reject; self-approval forbidden; approval by an independent actor
  (different agent + different model provider, or human) according to `OracleSpec.changePolicy`; an approved
  change that flips a recorded failure invalidates dependent decisions (`needs_reassessment`).
- `TestChangeClassifier`: classifies unified diffs of test code into the self-heal categories (locator,
  env setup, fixture, test bug, timeout, **assertion**, **threshold**, product code, **deleted/skipped test**)
  across Python/JS/TS/Go patterns; returns `auto_allowed | conditional | approval_required | forbidden`.
- `QualityGate.evaluate(GateInput) → QualityDecision` (deterministic rules from §1.2; reviewer decisions are
  inputs; P0/P1 require deterministic oracle evidence; evidence completeness check on critical claims).
- BUGate: `ProtocolBinding` (id, version, digest) resolved from a BUGate checkout (`protocol/v2/manifest.yaml`
  + methodology files), `PreparedProtocolContext` rendered per role/phase and validated against BUGate's
  JSON schema; injected into every agent prompt (subagent inheritance).

### model
- Message IR: `ChatMessage`, `ContentPart`, `ToolCall`, `ToolDefinition`, `ModelRequest`, `ModelResponse`,
  `ModelUsage`, `StopReason`, opaque reasoning with `continuationCompatibilityClass`.
- `ModelProvider.complete(request, opts)` (streaming via `onDelta`). Providers: `ScriptedProvider` (test
  brains), `OpenAICompatibleProvider` (chat.completions + tools + json_schema + streaming), `AnthropicProvider`
  (messages API + tools), `PiAiProvider` (reuses pi-ai provider normalization for the long tail).
- `ModelCatalog` of `ModelCapabilityProfile`s (revisioned). `ModelRouter.route(RouteRequest) → RouteDecision`
  with the ordered filters from I3 and `independentFrom` for reviewer heterogeneity; `ModelRouter.invoke`
  executes with timeouts/retries and **fail-closed fallback** (returns a new decision to start a new epoch at
  the next boundary; never swaps mid-turn). Emits `model.routed`, `model.invoked`, `model.fallback`.

### context
- `ContextSnapshotStore.create(input)` (immutable, content-hashed id) with ReadSet and freshness policies.
- `FreshnessGuard.validate(snapshotId, proposedAction)` using registered `ResourceVersionResolver`s
  (environment generation, build digest, oracle revision, finding status, lease owner, time windows).
- `PromptAssembler.assemble(AssemblyInput) → ChatMessage[]` with token budgets per section.
- `WorkingContext`: portable history view; `condense(level: 'soft'|'hard')` via a condenser (LLM
  summarizer through the router, or deterministic fallback) preserving evidence refs; artifact offload
  threshold; L0 keeps everything, so compaction is reversible.
- Retrieval: `ExactSearch` (ripgrep if present, else JS), `SymbolIndex` (regex/tree-lite symbol extraction
  for TS/JS/Python/Go + references), `VectorIndex` (pgvector when available, else in-memory cosine) with an
  `Embedder` port (hash embedding for tests, provider embeddings in prod), `HybridRetriever` fusion (RRF).
- `ExperienceStore` (L4): candidate → reviewed → approved → published; quarantine; only approved items are
  retrievable. `PowerContextClient` (HTTP `prepare_context`) implements the same `DurableMemory` port.
- `Provenance` (L5): `trace(claimOrEvidenceId)` → lineage (evidence → tool run → operation → environment →
  commit/build) for reports and gates.

### tools
- `ToolSpec` (id, schemas, effect, riskClass, resource scopes, side-effect binding, freshness, timeout,
  `execute`). `ToolRuntime.execute(ToolExecutionRequest)` implements the pipeline of §4.2 and emits events.
- `WorkspaceManager`: `sharedSnapshot(target, commit)` (read-only), `isolatedWorktree(...)` (git worktree
  on a run/work branch), `sandbox` profile (`local` process with scrubbed env / `oci` docker when available).
  Path confinement (no `..`, no symlink escape).
- White-box tools: `fs.read|list|search|write|apply_patch`, `git.diff|log|show|blame|status`,
  `shell.exec` (allowlisted), `test.run` (runner adapters: node:test, vitest/jest JSON, pytest (junit),
  go test -json, generic command) → `TestRunResult`, `coverage.collect` (coverage.py JSON, LCOV, Cobertura,
  Go coverprofile), `mutation.run` (operator-based source mutation for sensitivity validation),
  `code.symbols|references` (via context retrieval port).
- Black-box tools: `http.request` (records request/response evidence), `metrics.query` (Prometheus HTTP
  API + text exposition scrape), `load.start|observe|stop` (built-in HTTP load generator as an external job
  via SideEffectAdapter with operation-id labelling), `env.deploy|restart|inject_fault` adapters (process,
  docker, kubectl) as SideEffectAdapters, `browser.*` (Playwright, optional), `mcp.*` bridge (MCP stdio).

### runtime
- **AgentEngine ABI** (`createSession, runTurn, spawnChild, resumeChild, interrupt, inspect, dispose`,
  `EngineCapabilities`). Engines receive Hypertest-provided `ModelInvoker`, `ToolDispatcher`,
  `ContextProvider` and `EngineEventSink`; engines never talk to providers or tools directly, so routing,
  policy and evidence always stay in Hypertest.
- `NativeEngine`: the Hypertest agent loop (turn = one model response + all its tool calls), repetition
  detection, limits, cancellation propagation, structured completion.
- `SessionStore` (SQL): portable transcript, turn records (response persisted before tools), tool-call
  settlement, engine-native opaque state with compatibility class, epochs.
- `SubagentRuntime`: spawn/resume/message/interrupt/collect children, `continuable`/`background`,
  depth/count caps, capability attenuation, budget reservation; child receives only its task context
  (no parent trace), parent receives a summary.
- `RuntimeManifest` builder (content-hashed) and `engineContractSuite(factory)` shared by all engines.

### agents
Role catalog (`lead`, `code_change_analyst`, `architecture_analyst`, `historical_bug_analyst`,
`test_designer`, `executor`, `rca`, `fixer`, `reviewer`, `metrics_analyst`, `environment`, `condenser`):
system prompt templates (with BUGate injection slot), default `ModelPolicy`, tool allowlists, output
schemas, subscriptions (event type + filter + work template), permission profile, max depth.

### control
`PlanValidator` (acyclic deps, known roles, tools ⊆ role allowlist, budgets within envelope, depth/count
caps, schema validity), `DynamicScheduler` (admission, priority, concurrency per role/global, budget
reservation, resource claims, lease/fencing claims, escalation), `Reactors` (subscriptions → work, dedupe,
causal depth), `ConvergenceMonitor` (drain detection, livelock/TTL, max plan revisions), `RunDriver`
(tick/finalize), `AgentWorker` (engine turns + completion), domain tools, `ReportBuilder`.

### durable
`DurableRuntime { startRun, signal, awaitCompletion, resumeIncomplete, shutdown }`.
`LocalDurableRuntime` (in-process loop; crash-safe because all state is in SQL) and `TemporalDurableRuntime`
(`testRunWorkflow` → `tick` activity loop + `workItemWorkflow` children → `executeTurn`/`observe`/
`finalize` activities; signals for events, approvals, cancel; no LLM or I/O in workflow code).

### app / cli
`hypertest.config.yaml` (models + providers (keys from env), role model policies, budgets, policy rules,
store, bus, durable, artifacts, BUGate path, sandbox). `createHypertest(config)`. CLI: `init`, `run`,
`status`, `resume`, `report`, `evidence verify`, `approve`, `eval run`, `worker`, `serve`.

### eval
`EvalTask`, `EvalTrial`, `runSuite(suite, arms, {trials})` with a fresh environment per trial (temp copy,
fresh database, fixed manifest), graders (environment-state checkers first, then deterministic oracles,
evidence consistency, LLM rubric last), metrics (critical false release, defect recall, FP rate,
duplicate side effects, orphan operations, policy violations, stale-context actions, evidence completeness,
pass^k), stats (exact McNemar, paired bootstrap CI). Suites: `poc-a-whitebox`, `poc-b-event-driven`,
`poc-c-durable-load`, `oracle-robustness`, `recovery-chaos`.

## 6. PoCs (executable acceptance)

- **PoC A – Multi-LLM white-box autonomous regression.** A git fixture repo with a seeded regression. The
  goal "analyse this change and decide releasability" must produce ≥2 PlanRevisions, parallel analysts
  (code change / architecture / historical bug), two test designers, an executor, RCA and a reviewer; ≥3
  roles with distinct route policies; the seeded defect is detected with execution evidence; the verdict is
  `fail`; every route/tool/gate decision is reconstructible from L0.
- **PoC B – Event-driven black-box defect loop.** An HTTP service with a hidden defect. `test.failed →
  finding.created` wakes RCA and TestDesigner through reactors without the Lead; duplicate delivery injected
  on the bus creates no duplicate work or side effects; one lease owner per item; Finding → Hypothesis →
  Test → Evidence traceable; convergence detected; the report traces to HTTP evidence.
- **PoC C – Durable load + fault recovery.** A local service + metrics endpoint + built-in load generator.
  During the run: kill the Hypertest process after a load job is dispatched, inject a model timeout, a
  duplicate event and a large output. After restart: the load job is re-attached (not re-created),
  evidence is intact, context is rebuilt from L0, metrics claims cite metric evidence, and insufficient
  data yields `inconclusive`, never `pass`.

All three run in CI with scripted brains (deterministic `ScriptedProvider` policies per role); with provider
keys configured they also run live.

## 7. Invariant test matrix (minimum)

| Invariant | Test location |
|---|---|
| I1 permit before tool | tools: runtime pipeline tests |
| I2 attenuation | policy: capability tests; runtime: subagent tests |
| I3 safe-boundary switch, fail-closed fallback, routing order | model: router tests; runtime: epoch tests |
| I4 operation reconcile/fencing | operation: chaos tests (crash after dispatch, stale fence) |
| I5 duplicate delivery | collab: bus/inbox tests; eval: PoC B |
| I6 evidence chain | evidence: tamper tests |
| I7 gate rules | policy: gate tests |
| I8 self-heal/oracle | policy: classifier + oracle governance tests; eval: oracle-robustness |
| I9 offload | context/tools: offload tests |
| I10 audit completeness | control: e2e audit reconstruction |
| I11 manifest pinning | runtime/app: manifest tests |
| I12 budgets | control: scheduler tests |
