# @hypertest/cli

The `hypertest` command line. A thin, deterministic shell over the composition root (`@hypertest/app`) and the eval
platform (`@hypertest/eval`): it parses arguments with `node:util` `parseArgs` (no third-party CLI framework), loads
`hypertest.config.yaml`, composes one Hypertest instance per command, prints human-readable output (or `--json`), and
returns an exit code. It never decides anything a model or the QualityGate owns: `run` reports the gate's verdict, it
does not compute one.

`bin/hypertest.js` at the repository root calls `main(process.argv.slice(2))` and sets `process.exitCode`.

Depends on `core`, `domain`, `app`, `eval`, `evidence`, `store` (+ `yaml`), per `scripts/check-boundaries.mjs`. The ABI is
[`src/contracts.ts`](src/contracts.ts).

## Commands

| Command | What it does |
|---|---|
| `init [--dir d] [--name n] [--force]` | Writes a commented `hypertest.config.yaml` (DeepSeek via `openai-compatible`, Anthropic, a commented local-model example, per-role model policies, budget/gate, sandbox) and adds `.hypertest/` to `.gitignore`. Refuses to overwrite (exit 1) without `--force`; never shadows an existing `.yml`/`.json` configuration. |
| `doctor [--no-connect] [--timeout-ms n]` | Node.js ≥ 22.18, configuration validity (every problem listed), provider key variables (names only), route coverage per role, BUGate binding, sandbox, storage, reachability of the configured PostgreSQL/NATS/Temporal/OPA/PowerContext (`app.diagnose`), git, docker (informational). |
| `run "<goal>" --repo p [--commit c] [--base b] \| --url u \| --environment e [--label k=v]… [--run-id id] [--timeout-ms n] [--follow] [--detach]` | Starts a run and waits for the QualityGate's decision. `--commit`/`--base` are resolved to full SHAs (a run is pinned to an immutable commit). `--follow` streams L0 events to stderr. `--detach` (Temporal only) returns after the start: the Temporal workers drive the run, the detached process hosts no worker and needs no brains. Interrupted while starting up: no run is created. `--json` interrupted: `{ runId, status: null, verdict: null, interrupted: true, runtimeManifestId, exitCode: 130 }`. |
| `status [<runId>] [--status a,b] [--limit n]` | One run (target, plan revision, manifest, verdict, reassessment flag, and its agents: `engine.inspect` state, route, model pause — A[4]) or the run list, newest first. The verdict is the run's **final** decision (`run.decisionId`) only; a non-final decision of the gate's feedback loop is shown apart (`interim …; not final`, `--json`: `interimDecision`), never as the verdict. |
| `resume [<runId>] [--detach] [--follow] [--timeout-ms n]` | `resumeIncomplete()`: resumes the non-terminal runs pinned to this runtime's manifest (I11) and waits for their verdicts; with a run id, only that run (`ht.resume`). Either way the agents PAUSED for model unavailability (A[0]) retry now (their routes' open circuits may probe at once). |
| `model switch <runId> <role\|agentId> <routeId> --by <name> [--reason t]` | (A[3]) A manual model switch: the target agents (an agent, or every agent of a role — also later ones) switch at their next safe turn boundary after the permission/profile re-check (`model.switch_requested`; applied ⇒ epoch with switchReason `manual`, refused ⇒ `model.switch_refused`, no epoch). |
| `model prices set <routeId> --input usd --output usd [--source t]` / `model prices clear <routeId>` / `model prices list` | (A[1]) The observed-prices file (`models.pricesFile`) the price guard compares against; a running Hypertest re-reads it at every turn boundary. |
| `eval apply-scores <suite-result.json> --out <scores.json> [--min-trials n]` | (coverage[7]) Derives per-route, per-role quality scores (with provenance) from an eval SuiteResult; point `models.scoresFile` at the output. |
| `report <runId> [--json] [--out f]` | The run report: markdown, or the report JSON (claims, findings, provenance…). |
| `events <runId> [--follow] [--after seq] [--types a,b]` | L0 events in seq order (`--json`: NDJSON). `--follow` reads the status before the events (as the SSE endpoint) and ends two quiet polls after the run is terminal. |
| `evidence verify <runId>` | Evidence chain, artifact hashes, seals and the signed, root-bound verdict (`verifyEvidence`); exit 1 with the problems listed. |
| `approvals [--run id] [--status a,b \| --all]` | Approval requests (pending by default). |
| `approve <approvalId> [--deny] --by <name> --reason "<text>"` | A human decision (`human:<name>` in the audit trail). The requester can never decide its own request. Refused (`permission_denied`) when `$HYPERTEST_SANDBOX` is set. |
| `oracle establish <file> --by <name>` | Establishes an oracle (the run's correctness criterion) as a named human; runs without an oracle in force are at best `inconclusive` (gate C0). An existing oracle is a `conflict` (it changes only through proposals). Refused when `$HYPERTEST_SANDBOX` is set. |
| `waive <runId> <criterionId> --by <name> --reason "<text>" [--expires <time>]` | A governed human waiver of one gate criterion (approval kind `gate_exception`), applied at the run's next gate evaluation; never C1; refused for a finished run and when `$HYPERTEST_SANDBOX` is set. |
| `experience list [--run r] [--status s1,s2 \| --all]` / `experience review <experienceId> --decision review\|approve\|publish\|reject\|quarantine --by <name>` | The learning loop's human surface: only approved/published experience is retrieved into later runs; the creator of a candidate can never review it. `review` is refused when `$HYPERTEST_SANDBOX` is set. |
| `skill list [--status s1,s2] [--json]` / `skill show <skillId> [--revision n]` / `skill propose --from <xp>[,<xp>…] --name <name> --description <text> (--body <text> \| --body-file <file>) [--role r] [--skill <skillId>] --by <name>` / `skill validate <skillId> [--revision n] (--suite <id> [--trials n] [--arm <baseline>] \| --result <file>) [--min-pass-rate r] [--min-trials n] --by <name>` / `skill publish\|reject <skillId> [--revision n] --by <name>` / `skill retire <skillId> --by <name>` | (B[7]) The learning pipeline: approved experience → candidate SKILL → eval validation bound to the revision (the eval runs the cold-track arm and the arm `skill-<id>-r<rev>-<digest>` whose config injects exactly that revision) → published into the active registry (only published skills reach prompts) → retired. The registry and the database refuse: unapproved source experience, publishing without a passing validation of the exact revision, publishing by the creator, a `--min-pass-rate` outside (0, 1] and a validation whose verdict contradicts its own numbers (review). `--result` trusts the SuiteResult file it is given. Decisions are refused when `$HYPERTEST_SANDBOX` is set. |
| `memory serve [--data-dir d] [--port 7430] [--host 127.0.0.1] [--api-key-env VAR]` | (B[4]) The L4 durable-memory service in the foreground: its own storage (default `memory.dataDir` of a `service` configuration, else `<dataDir>/memory`), the HTTP API `PowerContextClient` speaks; bearer token from `$HYPERTEST_MEMORY_API_KEY` or `--api-key-env` (at least 16 characters; required on a non-loopback host). Point a deployment at it with `memory: { kind: powercontext, baseUrl, apiKeyEnv }`. |
| `oracle proposals [...]` / `oracle decide <proposalId> [--reject] --by <name> --reason "<text>"` | Oracle change proposals: list, or decide as a human (I8). `decide` is refused when `$HYPERTEST_SANDBOX` is set. |
| `oracle invalidate <oracleId> --revision <n> --by <name> --reason "<text>"` | (D-10) Declare the latest revision of an oracle invalid as a human: an append-only `invalid` revision (history is never rewritten), every decision based on it marked needs_reassessment; a run pinned to it is at best inconclusive until a new revision is approved through a proposal (the run is then re-pinned and replans). Only the latest revision can be invalidated (`conflict` otherwise); refused when `$HYPERTEST_SANDBOX` is set. |
| `cancel <runId> --reason "<text>"` | Cancels a run; a finished run keeps its outcome (`conflict`, exit 1). |
| `runtime list \| show [<id>] \| register [--manifest f] [--allow-migration s:from=>to]… \| record-suite <id> --kind engine_contract\|replay (--suite s [--revision r] --passed\|--failed [--total n] [--failures n] \| --from-eval SuiteResult.json) [--report f] \| promote <id> [--canary-percent n] [--canary-label k=v]… \| rollback [<id>] \| migrate <runId> --to <id> [--checkpoint-timeout-ms n] \| migrate <runId> --abort` (decisions: `--by <name>` (`human:<name>`, or `ci:<pipeline>`) and `--reason`) | Runtime release management over the store's registry (`ht.releases`): `<id>` is a manifest id, a unique prefix or `current` (this installation's runtime). `record-suite --from-eval` takes suite id, revision and pass/fail (every trial must pass) from an eval SuiteResult and binds the record to the file's sha256. `promote` goes one step (candidate → shadow → canary → active) over the latest passing `engine_contract` + `replay` results. `rollback` prints the quarantined runs. `migrate` never drives the run (the target runtime resumes it); `migrate --abort` releases the checkpoint of a migration whose process died before the re-pin (the run, paused `migrating`, continues on the runtime it is still pinned to). Every decision is refused (`permission_denied`) under `$HYPERTEST_SANDBOX`. |
| `eval run <suite> [--trials n] [--arms a,b] [--work-dir d] [--keep-work-dir] [--timeout-ms n] [--mode in-process\|child-process] [--judge scripted] [--out f] [--report f]` | Runs an eval suite (`runSuite`) with per-trial progress on stderr; prints `renderSuiteReport` (or a summary table). `--out` persists the **SuiteResult JSON** (whatever the display format: the input of `eval gate` and `runtime record-suite --from-eval`); `--report` writes the displayed report; `--judge scripted` appends the independent LLM judge (`llmRubric`, last) to every task with the calibrated scripted judge. `runSuite` takes no cancellation signal: an interrupt returns 130 at once and says that the trials in progress finish in the background (a second Ctrl-C terminates the process). |
| `eval gate --baseline <suite-result.json> --candidate <suite-result.json> [--baseline-arm a] [--candidate-arm b] [--alpha p] [--report f]` | The eval release gate (`evaluateReleaseGate`): comparable results (suite, revision, eval harness revision and trial mode, grader and oracle revisions), full coverage of the baseline's graded pairs, critical false release not worse, defect recall not significantly lower (exact McNemar, α default 0.05), security violations = 0 and duplicate side effects = 0 (read from every candidate trial that recorded them, infra errors included), evidence completeness 100 % for decisions. Prints the markdown report (or `--json`); exit 0 pass, 1 fail; unreadable/malformed files, a bad `--alpha` or an unknown/ambiguous arm are usage errors (2). `npm run eval:gate` gates the core suites against `packages/eval/baselines/core-scripted-multi-llm.json` (CI). |
| `serve [--port 7420] [--host h] [--token-env VAR] [--no-resume]` | Serves the REST API (`startApiServer`), then resumes incomplete runs, and drives runs in this process until SIGINT/SIGTERM. The token (≥ 16 characters) and a non-loopback host are validated before the store is opened; the server listens before anything is resumed, so a server that cannot start drives nothing. |
| `worker` | Hosts the Temporal worker for clients configured with `durable: { kind: temporal, workerMode: external }`. |
| `help [cmd]`, `version`, `<cmd> --help` | Help and version. |

Global options: `-c/--config <file>` (else `$HYPERTEST_CONFIG`, else the nearest `hypertest.config.{yaml,yml,json}` in
the working directory or an ancestor), `--scripted-brains <module>`, `--log-level debug|info|warn|error` (JSON lines on
stderr; default `warn`, `serve`/`worker` default to the configuration's level; `$HYPERTEST_LOG_LEVEL`), `--json`,
`-h/--help`.

### Exit codes (`EXIT_CODES`)

| Code | Meaning |
|---|---|
| 0 | ok — for `run`: verdict **pass** |
| 1 | failure (HypertestError or unexpected error; `run`: the run ended without a verdict — failed/cancelled; `evidence verify`: problems; `doctor`: an error check; `eval run`: a trial did not pass; `eval gate`: a check failed) |
| 2 | usage error (unknown command/option, missing argument, invalid value, scripted provider without `--scripted-brains`) |
| 3 | `run`: verdict **fail** |
| 4 | `run`: verdict **conditional** |
| 5 | `run`: verdict **inconclusive** |
| 130 | interrupted (SIGINT/SIGTERM or `io.signal`) — a foreground run stays resumable with `hypertest resume` (Temporal: it keeps running on the workers); interrupted before the first side effect, `run`/`resume`/`eval run` create, resume or start nothing |

`resume` exits 0 only when every resumed run completed with a verdict (the verdicts are printed / in `--json`).

### `--scripted-brains <module>`

An ES module (a `.ts` file works on Node ≥ 22.18) exporting `brains` (or a default export): a map provider id →
`ScriptedBrain`, or a factory `(ctx: { command, config, env, cwd }) => map | Promise<map>`. Optional `evalBrains(task,
fixture)` gives the `config` eval arm per-task brains. Commands that execute agent turns (`run`, `resume` — not with
`--detach` —, `serve`, `worker`) require a brain for every `scripted` provider (usage error otherwise); the other
commands get inert brains (a scripted provider is never invoked there, and they host no Temporal worker). See
`test/fixtures/brains.ts` (scenarios pass / fail / inconclusive; `hooks.onReplan` lets a test stop a run exactly
between the interim gate and the replan it asked for).

### `eval run` arms and suites

`@hypertest/eval` is resolved by duck typing (`EvalModuleLike`): suites from `suites[id]` or the contract's factories
(`poc-a-whitebox` → `pocAWhiteboxSuite()`); arms from `suite.arms`, `arms`, `builtinArms()`, `defaultArms()` or `ARMS`.
The CLI adds a **`config` arm** — the configuration file's `models` and `roles` merged over each trial's base
configuration (fresh store per trial) with the `--scripted-brains` brains — used when the eval platform offers no arms
or when requested with `--arms config`.

## Invariants and where they are proven

| Invariant | Test |
|---|---|
| Verdict-aware exit codes: pass 0 / fail 3 / conditional 4 / inconclusive 5 (never pass without the required evidence), no verdict 1 | `test/run.e2e.test.ts` (real scripted runs per verdict), `test/cli.test.ts` (mapping), `test/bin.e2e.test.ts` (process exit code) |
| Evidence verification through the CLI: chain + seal + signed verdict verify; a tampered artifact fails (I6) | `test/run.e2e.test.ts` |
| Human decisions: recorded as `human:<name>` with the reason; the requester cannot decide its own approval; decisions are final; unknown ids are `not_found` | `test/run.e2e.test.ts` |
| Secrets: the template names keys only through `apiKeyEnv`; `doctor` prints variable names, never values (sentinels), never echoes inline secrets; the store URL comes from `urlEnv` and is not printed; the API token is read from the environment only | `test/init-doctor.test.ts`, `test/infra.int.test.ts`, `test/serve.e2e.test.ts` |
| Fail fast without side effects: usage errors (exit 2) before anything is opened; a scripted provider without brains before the store is opened; `--detach` on the local runtime, a bad `--commit` or run id create no run | `test/cli.test.ts`, `test/run.e2e.test.ts` |
| Commits are pinned: `--commit HEAD` is resolved to the full SHA; refs are never passed to git as options | `test/run.e2e.test.ts`, `test/cli.test.ts` |
| Crash safety: an interrupted foreground run (in-process signal or real SIGINT) exits 130 and is resumed to its verdict by `resume` or `serve` | `test/run.e2e.test.ts`, `test/bin.e2e.test.ts`, `test/serve.e2e.test.ts` |
| No leaked handles: the real executable exits on its own after a run | `test/bin.e2e.test.ts` |
| `--follow`: every event once, in seq order, including the ones committed with the terminal transition | `test/run.e2e.test.ts`, `test/wait.test.ts` |
| `init` template: loads and validates; routes every core role and the GUI role (doctor ok with the key variables set; `local_private` warns: no local route); the local-model example is valid once uncommented; overwrite protection | `test/init-doctor.test.ts` |
| `runtime`: register → suites (explicit and `--from-eval`, failures never recorded as a pass) → promote step by step (refused without passing suites or a canary selection) → list/show; rollback with nothing to return to refused; migration of another runtime's live run onto the active release (epoch, `run.migrated`, operator pause kept; a second migration onto the same manifest refused); sandbox refusal; usage errors; rollback of the active release to a registered earlier runtime (`register --manifest`): the pointer returns, the live run is quarantined (status, report note, `list`), and `run` on the rolled-back runtime fails (exit 1) without creating a run; `migrate --abort` (usage error with `--to`, refused for a run not held at a migration checkpoint and under the sandbox, releases an abandoned checkpoint: `run.migration_released`) | `test/runtime.e2e.test.ts` |
| `model switch` records the request on L0 (unknown run/route/target refused, `--by` required); `model prices set/list/clear` maintain the prices file (malformed prices, unknown routes refused); `eval apply-scores` writes scores with provenance accepted by `models.scoresFile` | `test/model.e2e.test.ts` |
| Infrastructure: doctor probes reachable/unreachable PostgreSQL, NATS, Temporal, OPA; `worker` executes runs of external-mode clients (run, `--detach`, `resume --detach`) | `test/infra.int.test.ts` |
| A process that executes no agent turn never hosts a Temporal worker (`clientOnlyConfig`): `run --detach` (without brains), `approve` and `cancel` on an embedded-mode configuration leave no poller on the task queue | `test/infra.int.test.ts`, `test/cli.test.ts` |
| Only the final decision is a verdict: a run stopped between the interim gate and its replan shows no verdict (the interim decision apart); `resume` reaches the final decision, which supersedes the interim one | `test/run.e2e.test.ts` |
| No side effect after an early interrupt: `run` creates no run, `resume` resumes nothing, `serve` neither listens nor resumes, `eval run` starts no trial | `test/run.e2e.test.ts`, `test/serve.e2e.test.ts`, `test/eval.test.ts` |
| `eval gate`: pass ⇒ 0, a failed check ⇒ 1 (report and `--json` name it), malformed inputs ⇒ 2; `eval run --out` persists the SuiteResult JSON even for a markdown display; `--judge scripted` puts the judge last on every task | `test/eval.test.ts` (the real gate of @hypertest/eval on persisted results) |
| `serve` listens before it resumes: a server that cannot start (port in use, short token, open host without token) leaves an interrupted run untouched | `test/serve.e2e.test.ts` |
| Cancelling a live (interrupted) run sweeps its open work, leaves nothing to resume, and is idempotent | `test/run.e2e.test.ts` |
| Human decisions are refused when `$HYPERTEST_SANDBOX` is set (before any store is opened) | `test/cli.test.ts` |
| `init` writes the configuration atomically (never truncated; an existing file is never overwritten without `--force`) | `test/init-doctor.test.ts` |

## Operational notes

- **PGlite admits one process per data directory.** While `hypertest run` (or `serve`) drives a run, other CLI
  processes on the same data directory are refused (`precondition_failed` naming the holder). To decide an approval
  a paused run waits for: stop the foreground command (Ctrl-C: the run stays resumable), `hypertest approve …`, then
  `hypertest resume` — or run `hypertest serve` and decide over the API (with a token), or use PostgreSQL.
- `--detach` needs `durable.kind: temporal` (with the local runtime the CLI process *is* the run loop). Commands
  that execute no agent turn (`status`, `report`, `events`, `evidence verify`, `approvals`, `approve`, `oracle`,
  `cancel`, `run --detach`, `resume --detach`) use the configuration with `durable.workerMode: external`: the Temporal
  runtime starts its embedded worker lazily on the first start/signal, and a short-lived command must never poll the
  task queue (it would take activities of live runs — with inert brains — and abandon them on exit).
- **Human decisions from agents.** `shell.exec` allows `node` by default, so a command an agent runs can reach this
  CLI. `approve`/`oracle decide`/`oracle establish` refuse when `$HYPERTEST_SANDBOX` is set; both sandboxes of `@hypertest/tools` (local
  and OCI) set it in every child process, last, so neither the environment allowlist nor a caller can remove or spoof
  it. It is defence in depth, not a trust boundary: the local sandbox runs as the same OS user (see the tools README),
  so the other protection remains that agents cannot open the store (PGlite: the driving process holds the lock;
  PostgreSQL: the URL comes from `urlEnv`, which the sandbox scrubs — do not use a passwordless inline `store.url`
  reachable from the sandbox).
- Every worker must use the same configuration as its clients: a run is only driven by a runtime with the manifest it
  is pinned to (I11). `worker` hosts the embedded Temporal worker of that configuration.
- Read commands (`status`, `report`, `events`, `evidence verify`, `approvals`) compose a full instance (store, outbox
  relay, reactor subscription): the app has no read-only composition. After a crash such a command may publish the
  run's pending outbox events; every consumer dedupes by event id (I5), so this is idempotent, but not strictly
  read-only.
- `--commit`/`--base` resolution uses `git rev-parse --end-of-options` (git ≥ 2.24).

## Contract changes (additive)

- `main(argv, io?: Partial<CliIo>)` — `CliIo { stdout, stderr, env, cwd, signal?, loadEval? }` (every member optional
  when calling `main`).
- New types: `CliOutput`, `CliIo`, `ScriptedBrainMap`, `ScriptedBrainFn`, `ScriptedBrainsContext`,
  `ScriptedBrainsFactory`, `ScriptedBrainsModule`, `EvalModuleLike`, `DoctorCheck`, `DoctorReport`.
- New exports: `EXIT_CODES`, `verdictExitCode`, `COMMANDS`, `UsageError`, `splitCommand`, `parseCommand`,
  `GLOBAL_OPTIONS`, `findConfig`, `loadBrainsModule`, `CONFIG_FILE_NAMES`, `CONFIG_ENV`, `LOG_LEVEL_ENV`,
  `configTemplate`, `GITIGNORE_ENTRIES`, `TEMPLATE_KEY_VARIABLES`, `ensureGitignore`, `projectNameFrom`,
  `MIN_NODE_VERSION`, `nodeVersionCheck`, `availableSuites`, `availableArms`, `suiteFactoryName`, `suiteIdOf`,
  `DEFAULT_API_PORT`, `DEFAULT_API_TOKEN_ENV`, `FOLLOW_POLL_MS`, `FOLLOW_QUIET_POLLS`, `WAIT_POLL_MS`, `resolveCommit`.
- Commands beyond the original listing: `cancel`, `oracle proposals`, `help`, `version`; `--json` on every command
  that prints data.
- (review) `status --json` adds `interimDecision` (and `decision` is the final decision only); `run --json`
  interrupted prints `{ runId, status: null, verdict: null, interrupted: true, runtimeManifestId, exitCode: 130 }`;
  `resume --json` interrupted before starting prints `{ resumed: [], outcomes: [], interrupted: true }`; `approve` /
  `oracle decide` refuse under `$HYPERTEST_SANDBOX`; new exports `clientOnlyConfig`, `SANDBOX_ENV`,
  `MIN_API_TOKEN_LENGTH`, `writeConfigAtomically`.
- (hardening) `oracle establish <file> --by <name>` (conformance-1: a human establishes an oracle from a YAML/JSON
  file — one oracle, a list, or `{ oracles: [...] }`; refused under `$HYPERTEST_SANDBOX`; an existing oracle is a
  `conflict`); the `init` template documents `gate.requireOracle` and a commented `oracles:` example; the template's
  reviewer lists every evidence-producing role in `independentFromRoles`.
- (hardening, conformance-13/11) `experience list` / `experience review`, and `waive` (both in `COMMANDS`).
- (context-learning) `skill list|show|propose|validate|publish|retire|reject` (B[7]) and `memory serve` (B[4]); tests
  `test/skill.e2e.test.ts`, `test/memory.e2e.test.ts`.
- (gate-governance) the `init` template documents `gate.requireContracts` (commented; default true). The CLI e2e
  scenario brains record a SystemModel first, and the test oracle states its judge policy explicitly.
- (runtime release management) `runtime list | show | register | record-suite | promote | rollback | migrate`
  (`runtimeCommand`, in `COMMANDS`) over `HypertestInstance.releases`; decisions take `--by <name>` (`human:<name>`, or
  `ci:<pipeline>`) and `--reason`, and are refused (`permission_denied`) under `$HYPERTEST_SANDBOX`. New exports
  `releaseActor`, `parseAllowances`, `parseCanary`, `suiteFromEval`. A start refused by the release registry (not the
  active release, an unselected canary, `runtime.requireActiveRelease`, or a rollback racing the creation: the run is
  quarantined) is a `precondition_failed` failure (exit 1) of `run`. The `init` template names `vision_gui` and
  `local_private`, lists both in the reviewer's `independentFromRoles`, and says that `local_private` needs a local route.
  (review fix) `runtime migrate <runId> --abort --by <name> --reason "<text>"` (`HypertestInstance.releases
  .releaseCheckpoint`; a usage error with `--to`/`--checkpoint-timeout-ms`, refused under `$HYPERTEST_SANDBOX`).
- (eval platform completion) `eval gate --baseline <file> --candidate <file> [--baseline-arm a] [--candidate-arm b]
  [--alpha p] [--report f] [--json]`; `eval run --judge scripted` and `--report <file>`. **Behaviour change:** `eval run
  --out <file>` now always writes the SuiteResult JSON (before: the displayed report — markdown unless `--json`); the
  displayed report goes to `--report`. Output directories are created. `EvalModuleLike` gains `evaluateReleaseGate?`,
  `renderReleaseGateReport?`, `scriptedJudge?`; new export `withJudge(suite)`.

## Side-effect governance commands (audit wave 2)

- `hypertest reject <approvalId> --by <name> --reason "…"` — the explicit counterpart of `approve --deny`.
- `hypertest operations list [--run <runId>] [--status … | --all] [--json]` and
  `hypertest operations resolve <opId> --outcome succeeded|failed|compensated --by <name> --note "…"` — a human
  resolves a manual review (audited); refused inside a sandbox.
- `hypertest resume <runId> --raise-tokens <n> | --raise-cost-usd <x> | --raise-tool-calls <n> | --raise-wall-clock-ms <n> |
  --raise-work-items <n> | --raise-compute-minutes <x> | --raise-artifact-bytes <n> --by <name> --reason "…"` — raise a
  PAUSED_BUDGET run's budget, then resume it; refused inside a sandbox.
- `run --follow`/`watch` announce every pending approval (action and budget), with `approve`/`reject`. (review) An action
  approval is shown as the exact action it authorizes — tool, effect/risk, target, environment class, arguments
  (`approvalSubjectSummary`) — and a budget extension as its dimension, limit and proposed raise, in the notice and in
  `hypertest approvals` (never only the opaque digest).
- (review, E[3]) `hypertest run … --on-budget-exhausted gate|pause|approval` — this run's exhaustion policy (overrides the
  configured `budget.onExhausted`).

## How to run

```bash
npx tsc -p packages/cli --noEmit
node scripts/check-boundaries.mjs
node scripts/run-tests.mjs --package cli                              # PGlite (+ infra int tests when infra is up)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package cli   # the e2e runs on PostgreSQL 16 (fresh schema each)
```

`*.int.test.ts` skip with a reason when `HYPERTEST_TEST_PG_URL` / `_NATS_URL` / `_TEMPORAL_ADDRESS` / `_OPA_URL` are
absent (`npm run infra:up` writes `.infra/env`).
- (unit model-runtime, wave 1) New command `model` (`switch`, `prices set|clear|list`); `eval apply-scores`;
  `resume [<runId>]`; `status <runId>` prints the run's agents (`--json`: `agents`). The init template declares every
  route's capability profile explicitly (classification, action risk) and explains unknown prices.

## Tool surface (audit wave 3, additive)

- `hypertest run --url <sutUrl>`: the URL must be one of `tools.httpAllowlist` (a non-loopback one also needs
  `tools.urlEnvironmentClass`: a remote URL is never classified by default); it resolves to the ad-hoc environment
  `url-<host>-<port>` (http.request / load / metrics on it are permitted and evidenced) — test `test/blackbox-url.e2e.test.ts`
  (scripted brains: probe → evidence → verdict; an unlisted URL is refused before a run is created; a second run scrapes
  metrics and runs a load experiment by URL).
- `hypertest tool-worker --tools <ids> [--id w1] [--listen host:port] [--secret-env NAME]` serves delegated tools to
  `tools.remoteWorkers` over HMAC-signed HTTP (default secret variable `HYPERTEST_TOOL_WORKER_SECRET`; `--json` prints the
  URL); `packages/app/test/remote-worker.e2e.test.ts` runs it as a second process.

## Release stages and the eval platform (audit wave 3, unit release-eval, additive)

- `runtime record-suite … --kind engine_contract|compatibility|production_replay|release_gate` (`replay` = the legacy
  name of `compatibility`): each kind takes its own evidence — `engine_contract --run` (executed here) or `--passed
  --report <file>` (a CI attestation with its digest); `compatibility --from-eval` (every trial must have run under the
  manifest); `production_replay --from-shadow` (the shadow comparisons); `release_gate --from-eval <core> --baseline
  <file> [--baseline-arm a] [--candidate-arm b] [--max-critical-false-release r] [--bridge f]` (the eval gate of the
  core suite, computed here). `runtime shadow [<runId> …]` mirrors finished production runs on a shadow release
  (dry-run). Tests: `test/runtime.e2e.test.ts` (the whole CLI walk through every gate, with the refusals),
  `test/release-eval.e2e.test.ts` (`eval run --arms deployment` trials run under the deployment's manifest and certify
  it; another arm's result is refused). (review) The `deployment` arm evaluates on the task's fixtures only: the
  deployment's own `environments` and `tools.httpAllowlist` targets (not part of the manifest) are left out of its
  trials (`deploymentTrialConfig`); a cancelled (partial) `eval run` result never certifies a release; `--kind
  release_gate` refuses a candidate or baseline named core that is not the built-in core suite (revision + content
  fingerprint), and `eval run --suite-dir` refuses a private suite reusing a built-in suite id.
- `eval run`: `--tier`, `--track cold|learning`, `--experience`, `--arm-file` (external agent arms), `--suite-dir`
  (private suites), `sanity --dataset --repos`, `--judge scripted|config`, `--judge-route`, `--judge-packets`,
  `--calibration`, `--bridge-grader`, `--timeout` / Ctrl-C (cancels through `SuiteOptions.signal`, keeps the partial
  result, exit 1 / 130), pass@k and pass^k per k in the summary; `eval bridge`, `eval calibrate [label]` (`label` is a
  human decision: refused when `$HYPERTEST_SANDBOX` is set); `eval gate
  --max-critical-false-release`, `--bridge`. Tests: `test/eval-platform.test.ts` (real @hypertest/eval exports; a real
  external-agent trial over a private suite; real cancellation), `test/eval.test.ts`.
- `test/exit-codes.e2e.test.ts` (e2e[6]): the verdict-aware exit codes from real scripted runs (pass 0, fail 3,
  conditional 4, inconclusive 5), each run converged (no schema-refused plan, no repetitive loop) — the `fail` fixture
  proposed an objective status (`failed`) the plan schema refuses; it now uses `unsatisfiable`.
