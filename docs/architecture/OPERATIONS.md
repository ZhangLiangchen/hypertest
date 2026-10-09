# Operating Hypertest

English | [简体中文](OPERATIONS.zh-CN.md)

How to deploy, secure, recover, release and upgrade Hypertest. The configuration reference is the
[app README](../../packages/app/README.md); every command is described in the [CLI README](../../packages/cli/README.md).
The profiles below were run end to end on the development host (PostgreSQL 16, NATS JetStream, Temporal dev server and
OPA from `npm run infra:up`) with scripted models, except where a row says otherwise.

## 1. Deployment profiles

| Profile | Store | Bus | Durable runtime | Processes | Use it for | Verified |
|---|---|---|---|---|---|---|
| Local | PGlite (`<dataDir>/db`) | in-process | local | one process per data directory (enforced by a lock file) | a developer machine, CI | yes |
| Server | PostgreSQL | in-process or NATS | local | one driving process (`hypertest serve`) plus any number of CLI clients | a shared team host | yes |
| Distributed | PostgreSQL | NATS JetStream | Temporal, `workerMode: external` | N `hypertest worker` processes plus clients (`run --detach`, `status`, `approve`, …) | several hosts, long runs | yes (one worker) |

Optional add-ons: OPA policy (verified), S3 artifact store with Object Lock (implemented; not run against a live
endpoint), PowerContext memory (implemented; not run against a live service), the Hypertest memory service (`memory: {
kind: service }` or `hypertest memory serve`: a separate process with its own storage; verified), semantic retrieval
through an OpenAI-compatible embeddings endpoint (verified against a fake endpoint only).

### Local

The configuration `hypertest init` writes. `hypertest run` drives the run in the CLI process. After a crash or Ctrl-C,
`hypertest resume` continues it. PGlite admits one process: while a run is in progress, other commands on the same data
directory are refused and name the holder.

### Server

```yaml
store: { kind: postgres, urlEnv: HYPERTEST_PG_URL, schema: hypertest }
bus: { kind: nats, servers: "nats://127.0.0.1:4222" }     # the in-process bus keeps every message in memory
```

```bash
export HYPERTEST_PG_URL=postgres://hypertest@db.internal:5432/hypertest   # a URL with a password is fine here: it comes from the environment
export HYPERTEST_API_TOKEN=$(openssl rand -hex 24)
hypertest serve --port 7420 --token-env HYPERTEST_API_TOKEN   # REST API; resumes incomplete runs, then drives new ones
hypertest status                                              # other processes read and decide on the same store
```

### Distributed

```yaml
store: { kind: postgres, urlEnv: HYPERTEST_PG_URL, schema: hypertest }
bus: { kind: nats, servers: "nats://nats.internal:4222", stream: HYPERTEST, subjectPrefix: ht }
durable: { kind: temporal, address: "temporal.internal:7233", namespace: default, taskQueue: hypertest, workerMode: external }
policy: { capabilitySecretEnv: HYPERTEST_CAPABILITY_SECRET }
signing: { keyFile: /etc/hypertest/evidence-ed25519.pem }
```

```bash
openssl genpkey -algorithm ed25519 -out /etc/hypertest/evidence-ed25519.pem && chmod 600 /etc/hypertest/evidence-ed25519.pem
export HYPERTEST_PG_URL=… HYPERTEST_CAPABILITY_SECRET=…      # the secret: at least 16 characters, identical on every process
hypertest doctor                                             # probes PostgreSQL, NATS, Temporal and OPA
hypertest worker                                             # on each worker host; prints its manifest and task queue
hypertest run "Is this change releasable?" --repo . --commit HEAD --detach   # from any client
hypertest status <runId>
```

Rules for more than one process:

- **Same code and same configuration everywhere.** They yield the same `RuntimeManifest`. Workers poll the task queue
  `<taskQueue>@<first 16 hex digits of the manifest>`, so a worker with another manifest never receives the run's
  activities (section 5). During a canary, or while a retiring release still has live runs, two manifests run side by
  side: keep workers of each of them.
- **Shared secrets.** `policy.capabilitySecretEnv` (capability tokens are checked by other workers) and
  `signing.keyFile` (seals are verified by other processes). `hypertest doctor` warns when a PostgreSQL store has no
  shared capability secret; it does not check the signing key.
- **Worker identity.** Temporal workers of one deployment share the identity `worker:temporal:<namespace>/<taskQueue>`,
  so leases survive an activity moving to another worker.
- **Environment generations** (deploys and restarts of registered environments) are stored in PostgreSQL and shared by
  all workers.

### Policy with OPA

```yaml
policy: { opa: { url: "http://127.0.0.1:8181", path: hypertest/agents } }
```

```rego
package hypertest.agents

default allow := false

allow if {
  input.effect in {"read", "record", "execute"}
}

reasons contains "agents may read, record and execute" if allow
```

Load it with `curl -X PUT -H 'content-type: text/plain' --data-binary @agents.rego http://127.0.0.1:8181/v1/policies/agents`.
Hypertest posts `{ input: ActionRequest }` (`tool`, `effect`, `riskClass`, `resources`, `environmentClass`, `role`,
redacted `input`, …) to `/v1/data/<path>`. It expects `{ allow, approval_required?, reasons?, constraints? }`. OPA is
combined with the built-in rules, and a deny from either one wins. An unreachable OPA or a malformed answer is a deny
(`opa_unavailable`). The policy revision includes a digest of the package's modules, so a policy change is a new
runtime manifest.

### S3 artifacts

```yaml
artifacts: { kind: s3, region: eu-central-1, bucket: hypertest-evidence, prefix: prod/, objectLockDays: 365,
             accessKeyIdEnv: AWS_ACCESS_KEY_ID, secretAccessKeyEnv: AWS_SECRET_ACCESS_KEY }   # endpoint + forcePathStyle for MinIO
```

With `objectLockDays` every artifact is written with `ObjectLockMode=COMPLIANCE` (the bucket must have Object Lock
enabled). Without it, and with the default `fs` store, evidence is tamper-evident (hash chain, seal) but not WORM.

### Memory service, semantic retrieval and skills

L4 durable memory (approved experience) can live in a separate service with its own storage:

```yaml
memory: { kind: service }                       # Hypertest starts the service as a child process (storage <dataDir>/memory) and stops it on close
# or, a service you run yourself (`hypertest memory serve --port 7430 --api-key-env HYPERTEST_MEMORY_API_KEY`):
memory: { kind: powercontext, baseUrl: "http://127.0.0.1:7430", apiKeyEnv: HYPERTEST_MEMORY_API_KEY }
```

The service keeps the store's rules (only approved/published experience is retrieved; the creator never reviews) and
its decisions are also recorded on the deployment's L0. `memory serve` refuses a non-loopback host without a token of
at least 16 characters. One service process per storage directory.

Semantic code retrieval through an OpenAI-compatible `/embeddings` endpoint (default: feature-hashing embeddings, no
request leaves the host):

```yaml
models:
  providers:
    - { id: local-embed, kind: openai-compatible, baseUrl: "http://127.0.0.1:11434/v1" }
retrieval: { embedder: { provider: local-embed, model: nomic-embed-text, dimensions: 768 } }
```

Code chunks are sent to that endpoint: use a local one for private code. A missing credential sends nothing (the
hashing embedder is used and a warning logged). Agents whose context is `restricted` (local_private) never have their
workspace embedded by an endpoint outside this host or private network: they use the local hashing embedder. The code
tools (`code.symbols`, `code.references`) and the prompts' code section use syntax-tree symbols (TypeScript compiler
API; python3 and Go when installed, otherwise a regex fallback per file). The Go helper is compiled into
`<dataDir>/state/parsers`, which sandboxed commands cannot see.

Skills: `hypertest skill propose --from <approved experience> …` → `skill validate <id> --suite <suite> --by <name>`
(an eval run with an arm bound to that revision) → `skill publish <id> --by <other name>` → `skill retire`. Only
published skills reach agent prompts; the database refuses to publish a revision without a passing validation of
exactly that revision (`--min-pass-rate` must be above 0, and a validation row whose verdict contradicts its own
numbers is refused). `skill validate --result <file>` judges a SuiteResult file you supply instead of running the eval:
it is trusted as given. The `skills.trial` configuration key is set by `skill validate` on its own eval instances; an
instance started with it shows those unpublished revisions to its agents and logs a warning — never set it on a
production deployment.

### Tool surface: URL targets, MCP, ACP, remote workers, gRPC, computer use, observation, isolation tiers

Black-box runs against a URL: every `tools.httpAllowlist` URL becomes an environment `url-<host>-<port>` (class `local`
for loopback, else `tools.urlEnvironmentClass` — never allowlist a production URL under a lower class).
`tools.urlEnvironmentClass` has no default: without it a non-loopback URL is not an environment (a warning names it),
because the class decides what agents may do there (on `sandbox` the default policy allows writes and deletes without
approval). `hypertest run "<goal>" --url http://127.0.0.1:8080` targets it; a URL nothing serves is refused.

```yaml
tools:
  httpAllowlist: ["http://127.0.0.1:8080"]
  mcpServers:                                   # mcp.<id>.<tool>; effects ledgered, mcp-response evidence
    - { id: tickets, command: node, args: [server.mjs], envFrom: { TICKETS_TOKEN: HT_TICKETS_TOKEN }, allowTools: [create_ticket, list_tickets],
        toolEffects: { list_tickets: { effect: read, riskClass: low } }, environmentId: shop, roles: [executor] }
    - { id: tracker, url: "https://mcp.example.test/mcp", headersFromEnv: { authorization: MCP_TRACKER_AUTH }, allowTools: [list], effect: read }
  acpAgents:                                    # acp.<id>.prompt: an external coding agent in the caller's workspace sandbox
    - { id: coder, command: my-acp-agent, envFrom: { AGENT_KEY: HT_AGENT_KEY }, roles: [test_designer] }
  remoteWorkers:                                # delegated tools run on `hypertest tool-worker` (HMAC-signed HTTP)
    - { id: w1, url: "http://10.0.0.7:7441", secretEnv: HT_WORKER_SECRET, tools: [http.request, metrics.query] }
  computerUse: { backend: x11, display: ":99", displayId: kiosk }   # computer.* for vision_gui (x11 | xdotool | fake)
environments:
  - environmentId: shop
    environmentClass: local
    generation: 0
    baseUrl: "http://127.0.0.1:8080"
    control: { kind: kubectl, target: deployment/shop/app, namespace: shop, context: kind-dev }
    grpc: { target: "127.0.0.1:50051", reflection: true, readMethods: ["shop.Catalog/Get*"] }
    logs: { files: [/var/log/shop/app.log] }
    traces: { kind: tempo, url: "http://127.0.0.1:3200", service: shop }
    database: { kind: postgres, urlEnv: SHOP_DB_URL, schemas: [public] }
```

The remote worker: `HT_WORKER_SECRET=… hypertest -c worker.yaml tool-worker --tools http.request,metrics.query --id w1
--listen 0.0.0.0:7441` (secret of at least 16 characters, by name only). Tools with their own side-effect adapter
(env.*, load.*) are not delegable. Requests and answers are HMAC-signed; an answer's signature also covers the request
it answers, so a captured answer is never accepted for another call. Upgrade the main process and its workers together
(an older worker's answers no longer verify).

Observation tools (all reads): `logs.query` (supervisor output — start the supervisor with `--log-file` —,
`docker logs`, `kubectl logs`, declared files), `trace.query` (OTLP/JSON file, Jaeger, Tempo), `net.capture` (a pcap of
the environment's host:port; needs tcpdump with capture privilege, else it fails `unsupported`/`permission_denied`),
`db.introspect` (schema, read-only, through psql / sqlite / mysql). `test.run` and `shell.exec` take `captureNetwork:
true` to record every HTTP exchange of their commands. Code intelligence: `lsp.*` (TypeScript language service),
`analysis.run` (tsc, workspace eslint, pyflakes or a compile check, go vet).

Fault injection: `env.inject_fault` kinds `latency`/`error_rate` (process environments), `pause`/`kill`/
`network_disconnect`/`netem` (docker; netem needs `tc` and NET_ADMIN in the container), `pod_delete`/`scale_zero`/
`network_deny` (kubectl). A fault is time-boxed: a detached reverter, started before the fault is applied, undoes it at
`durationMs` even if Hypertest stops (jobs under `<dataDir>/state/faults/<operationId>`). An apply whose outcome is
unknown (its command timed out, or Hypertest died while it ran) is treated as applied: it blocks a second fault on the
environment and is reverted at expiry. If a revert fails, the environment refuses further operations until you repair
it and delete that job directory.

Isolation tiers and sandbox keys — every accepted key is enforced or the start/command is refused:

```yaml
sandbox:
  kind: local
  network: egress_allowlist
  allowedHosts: ["127.0.0.1:9000"]     # local sandbox only, loopback host:port, relayed HTTP-aware
  memoryMb: 2048                       # local: prlimit --data per process; oci: --memory
  cpuLimit: 2                          # local: ceil(cpuLimit) CPUs (taskset); oci: --cpus
  roles:
    reviewer: { tier: read_only }                                  # workspace bound read-only for its commands
    executor: { tier: separate, network: loopback, memoryMb: 4096 }
    rca:      { tier: isolated, kind: oci, image: "node:22" }      # its commands run in a container
```

A work item whose capability requirements grant no `write_workspace` runs its commands read-only; one whose
requirements name no environment runs them without egress. gVisor/Firecracker runtimes are not supported (deferred).

## 2. Security

| Control | Default | Guidance |
|---|---|---|
| Agent command sandbox | `sandbox: { kind: local, network: loopback }` | On Linux with unprivileged user namespaces and python3, each command runs in its own user, network, PID and mount namespaces. It reaches only its own loopback plus the relayed endpoints of registered environments and `tools.httpAllowlist`; keys, the store, artifacts and other workspaces are hidden; argv may not name paths outside the workspace. Hosts without namespaces refuse these profiles. Where the sandbox cannot hide the keys, the capability secret and the store (no PID/mount jail — e.g. no python3 — or `network: open`) Hypertest refuses to start and `doctor` reports an ERROR, unless you accept it with `sandbox.insecureAllowUnhiddenSecrets: true` (logged as INSECURE at every start). A command's state-changing HTTP request to a relayed SUT endpoint becomes a ledgered `sandbox.http` operation (operation id, `Idempotency-Key`, evidence; a replay answers from the record) or, with `sandbox.egressWrites: refuse`, a 403; non-HTTP traffic is refused unless the environment sets `rawEgress: true`. Such a write is authorized like a tool call of its own: the environment's class must be one the agent's capability may act on, the policy must allow an external effect there (a write that needs approval — e.g. on `staging` — is refused with a 403: use `http.request`, which waits for the approval); a call one of whose writes was refused ends as a tool fault (`egress_refused`), never as a test outcome; a method-override header (`X-HTTP-Method-Override` …) on a GET makes it a write, and the environment-control path `/__hypertest` is never reachable from a command. **Residual:** commands run as the same OS user and can read the rest of the host file system. |
| Untrusted models or code | – | Use `sandbox: { kind: oci, image: <image with your toolchain>, network: none, cpuLimit, memoryMb }` (docker, `--cap-drop ALL`, no new privileges). `network: open` removes egress control for the local sandbox; use it only on hosts where that is acceptable. |
| Secrets | none in the file | `*Env` fields name environment variables; inline keys, tokens, passwords and credential headers are configuration errors. Sandboxed commands get only `sandbox.envAllowlist` (default PATH, HOME, LANG, LC_ALL, TMPDIR). `doctor` prints variable names, never values. Agents never receive a long-lived credential: declare SUT credentials per environment (`credentials: [{ name, kind: jwt_hs256 \| oauth2_client_credentials, secretEnv, header?, ttlMs?, audience?, tokenUrl?, clientId?/clientIdEnv?, scope?, grantTo? }]`); an agent names one (`http.request` `credential`) and the secret broker mints a short-lived credential for that call (a JWT HS256 valid `ttlMs`, default 5 min, or an OAuth2 client-credentials token). Its scope `credential:<environmentId>/<name>` must be granted to the agent's permission profile (`grantTo`, default test_executor and environment_operator) and allowed by the permit's `credentialScope`. Secrets and minted values are redacted from tool output and evidence. env.process sends per-operation control tokens: the supervisor's control token never goes over the wire. |
| Data directory | `.hypertest/` (0700) | Holds the database, artifacts, `keys/` (0600) and workspaces. Keep it out of git (`init` adds it to `.gitignore`). |
| REST API | `127.0.0.1`, no token | Always set a token of at least 16 characters in `HYPERTEST_API_TOKEN` (or name another variable with `--token-env`). A non-loopback `--host` requires a token. Human decisions over the API always require it, because agents can reach loopback services. Put TLS in front for remote use. |
| Human decisions | CLI or API | `approve`, `reject`, `operations resolve`, `resume --raise-…`, `oracle establish`, `oracle decide`, `waive`, `experience review`, `skill propose|validate|publish|reject|retire` and the runtime release decisions (`runtime register`, `record-suite`, `promote`, `rollback`, `migrate`) need `--by <name>` (plus `--reason` where the command asks for it) and are recorded as `human:<name>` (`--by ci:<pipeline>` for release steps taken by CI). A requester never decides its own request. All of them are refused when `HYPERTEST_SANDBOX` is set, which both sandboxes set in every command, so an agent can never promote the runtime it is judged by. |
| Permits | built-in rules | Reads and records are allowed; writes and execution only inside the workspace. External effects are allowed on `local`/`sandbox` environments and need approval on `staging`. Destructive effects need approval on `staging`, at high risk on `sandbox` and at critical risk anywhere. Anything above read on `production` is denied, and agents can never decide approvals or oracle changes. An action that needs approval is not executed: an approval request bound to that exact call (tool, arguments, target, risk, run, work item) is recorded and the work item waits — `hypertest approvals`, then `hypertest approve <approvalId> --by <name> --reason …` or `hypertest reject …` (or `POST /approvals/:id` with the token); approved, the same call runs exactly once; rejected or expired (24 h), it is denied. An approval authorizes only the action its request describes (an approval whose shown tool, arguments and target do not match the action it is bound to authorizes nothing). Add `policy.rules` or OPA to tighten. |
| Environments | none | Register black-box targets in `environments:` with an `environmentClass`. Control-plane tokens come from `control.tokenEnv`, never the file. Writes, load and faults against an environment run only for an experiment of the work item (`experiment_required` otherwise). Register an environment that is yours alone with `isolation: { dedicated: true, namespace?, database?, account? }`: only then may an experiment use isolation mode `dedicated_environment` (it holds the whole environment and records the namespace/database/account). |
| Model credentials | fail closed | A provider whose `apiKeyEnv` variable is unset or empty is unavailable: its routes are never routed to and no request is ever sent. A run whose roles have no other route is refused at start with the exact reason; `doctor` reports the provider. |
| Kernel plugins | none | `plugins:` loads local ES modules pinned by `digest: sha256:<hex>`; a changed file refuses the start (nothing of it is loaded). Plugin tools pass the same capability check, policy permit, operation ledger and evidence as built-in tools. A plugin tool may not reuse a built-in or domain tool id (the start is refused). The digest pins the entry file only: ship a plugin as one bundled file (modules it imports are not pinned). Review a plugin's code before you pin its digest: it runs in the Hypertest process. |

With PGlite a paused run holds the store lock, so a human cannot approve from a second process. Stop the foreground
command (Ctrl-C; the run stays resumable), run `hypertest approve …`, then `hypertest resume`, or use `serve` and the API.

## 3. Recovery runbook

| Situation | What Hypertest does | What you do |
|---|---|---|
| The CLI process crashed or was interrupted (exit 130) | The run stays in the store; open operations stay in the ledger | `hypertest resume` (or restart `hypertest serve`, which resumes at start unless `--no-resume`) |
| A Temporal worker died | Activities heartbeat; another worker of the deployment retries them within about a minute | Restart workers with the same code and configuration |
| Restart with side effects in flight | `verified` operations return their recorded result; `dispatching`, `acknowledged` and `outcome_unknown` ones are observed and reconciled before any re-dispatch; external load jobs are re-attached by operation id; expired leases get new fencing tokens; leaked budget reservations are released | Nothing. The report's "Recovery log" lists what was reconciled and re-run |
| `precondition_failed` naming a lock holder (PGlite) | A lock left by a dead process on this host is taken over automatically | If the holder is on another host and gone, delete `<dataDir>/db.lock` |
| An operation ended in `manual_review` | It is never retried automatically: its outcome cannot be known or it must not be repeated; the work item that issued it waits for your resolution (bounded by its wall clock) | `hypertest operations list` (or `GET /operations`); check the target system using the operation id (it is the idempotency key and the job label); then `hypertest operations resolve <opId> --outcome succeeded\|failed\|compensated --by <name> --note "what you checked"` (or `POST /operations/:id/resolve` with the token). The waiting work resumes with that outcome; the resolution is on L0 (`operation.resolved`). Agents can never resolve operations |
| An oracle change that flips a recorded failure was approved | Decisions that relied on the old revision are flagged; history is not rewritten | `hypertest status <runId>` shows the reassessment flag; start a new run, which pins the new revision |
| A pinned oracle was superseded during a run | The run is re-pinned to the newly approved revision (append-only: `run.oracle_repinned`), its earlier decisions are flagged for reassessment, and the lead replans (`oracle_changed`) to define new experiments; the gate judges under the new revision | Nothing; `hypertest events <runId> --types run.oracle_repinned,replan.triggered` shows what changed |
| A run is `inconclusive` with C12 domain_contracts unknown | The run recorded no SystemModel, or a write/fault/load action belongs to no ExperimentSpec | Make sure the lead records the system (`system_model.record`) and that writes run under experiments; `gate: { requireContracts: false }` is a recorded, authorized weakening (`gateOverrideBy`) |
| An oracle revision turns out to be wrong | – | `hypertest oracle invalidate <oracleId> --revision <n> --by <name> --reason "…"`: an append-only `invalid` revision; decisions based on it are flagged for reassessment; a run pinned to it is at best `inconclusive` (C0) until a corrected revision is approved through `oracle decide` (the run is then re-pinned and replans). Experiments that ran under the old revision no longer count: their criteria stay unproven until new experiments re-run them |
| C3 stays unknown although a generated test passed (`… neither satisfy nor violate a critical assertion`) | A generated test supports or violates a P0/P1 assertion only after its whole lifecycle, with its known-good run on the BASE revision (`test.run` revision "base") and its sensitivity shown on product code; a known-good pass on the candidate itself, or a recorded "known-good unavailable" reason, keeps it out of P0/P1 decisions | Check `hypertest report <runId>` (ignored evidence) and the artifact's stages; give the run a `target.baseCommit` so regression tests can be validated against the base revision |
| The run budget ran out (`budget.onExhausted: gate`, the default) | The run goes to the gate with the evidence it has (never a silent downgrade); gaps make it `inconclusive`. Every dimension counts: model tokens and USD, tool calls, compute, artifact bytes, wall clock | Raise `budget` in the configuration (or in `POST /runs`) and start a new run, or choose `pause` / `approval` (configuration `budget.onExhausted`, or per run: `hypertest run … --on-budget-exhausted pause\|approval`, `POST /runs` `budget.onExhausted`) |
| A run is paused `budget` (`budget.onExhausted: pause`) | The run's budget is exhausted (`budget.exhausted` names the scope and dimension); waiting items keep their agents and sessions; nothing is cancelled | `hypertest resume <runId> --raise-tokens <n> \| --raise-cost-usd <x> \| --raise-tool-calls <n> \| --raise-wall-clock-ms <n> \| --raise-work-items <n> … --by <name> --reason "…"` (or `POST /runs/:id/resume` `{ raise, by, rationale }` with the token): the amounts are added to the limits (`budget.raised`) and the same agents continue. Resumed without a raise, the run converges to the gate |
| A run is paused `approval` (`budget.onExhausted: approval`) | A budget-extension approval request (kind `budget`) proposes an amount; the run waits durably and `hypertest resume` refuses to bypass it | `hypertest approve <approvalId> --by <name> --reason "…"`: the budget is extended by that amount and the run resumes; `hypertest reject …` (or no decision within 24 h): the run converges to the gate |
| A work item waits for an action approval (`approval:<id>`) | Its tool call needs approval; nothing ran | `hypertest approvals` shows the call (tool, arguments, target); `hypertest approve\|reject <approvalId> --by <name> --reason "…"`. Approved, the agent issues the same call again and it runs once |
| Agents are paused for model unavailability (`work.paused`, pauseReason `model_unavailable`) | No route can serve them now (open circuits, rate limits or timeouts after retries); they resume by themselves at the half-open time / Retry-After / backoff, also after a restart. A route that may never serve the role (security, capability, missing credential) fails closed with the exact reason instead | Wait, or `hypertest resume <runId>` (`POST /runs/:id/resume`, with the API token) to let them retry now. `hypertest status <runId>` shows each agent's pause |
| A provider changed its price | With `models.priceGuard.maxIncreasePct` set, an observed price beyond it opens the route's circuit (`model.circuit_opened`, reason `price_change`); other eligible routes serve | `hypertest model prices set <routeId> --input <usd> --output <usd>`; clear or correct it later (`model prices clear`), which closes the circuit at the next turn boundary |
| A run's agents should use another model route | – | `hypertest model switch <runId> <role or agentId> <routeId> --by <name> --reason "…"` (or `POST /runs/:id/model-switch` with the token): applied at the next safe turn boundary after the permission re-check, or refused (`model.switch_refused`) |
| A live run is pinned to another runtime manifest | It is not resumed; the control plane refuses to drive it | Finish it with its own runtime, migrate it (`hypertest runtime migrate`, section 5.3) or `hypertest cancel <runId> --reason "…"` |
| `hypertest run` fails with `runtime release: … new runs are created only under the active release …` (`precondition_failed`) | This runtime is not the active release (or an unselected canary, a rolled-back release, or no release is active while `runtime.requireActiveRelease` is set); no run was created | Run it where the active release is deployed, or release this runtime (section 5.2) |
| A runtime release misbehaves (canary or active) | – | `hypertest runtime rollback [<manifestId>] --by <name> --reason "…"` (section 5.3); then re-run the suites against the active release |
| A run is paused `quarantined` | Its release was rolled back; the run is never driven or resumed on it | `hypertest runtime migrate <runId> --to <active manifest> --by <name> --reason "…"`, then `hypertest resume` on that runtime; or `hypertest cancel` |
| A run is paused `migrating` and no migration is running | The migrating process died between checkpoint and re-pin; resume is refused | `hypertest runtime migrate <runId> --abort --by <name> --reason "…"`: the run continues on the runtime it is pinned to |
| A gate criterion should not block this run | – | `hypertest waive <runId> <criterionId> --by <name> --reason "…" [--expires <time>]`: applied at the next gate evaluation, recorded in the decision; C1 evidence integrity can never be waived |

## 4. Evidence verification

```bash
hypertest evidence verify <runId>          # exit 0 when everything verifies, 1 with the problems listed
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/runs/<runId>/evidence/verify
```

The check covers:

- every record's hash chain;
- every artifact's SHA-256 against its bytes;
- the Merkle root and its Ed25519 seal;
- the verdict itself: the `QualityDecision` must be signed by a trusted key over its content and bound to the sealed
  root.

Trusted keys are all `<dataDir>/keys/*.pub.pem`, so rotated keys still verify old seals. Keep old public keys when you
rotate `signing.keyFile`. `hypertest report <runId>` shows the root, the seal and the signer. Limits: the app signs
with a local key (the evidence package's `Signer` interface is the KMS/HSM port, but no KMS signer is wired). Records
carry no `traceId`, and WORM storage needs S3 Object Lock.

## 5. Upgrades, runtime releases and manifest pinning

Every run is pinned to the `RuntimeManifest` of the runtime that started it (invariant I11). The manifest id is a
content hash of:

- the Hypertest version, a source digest (every file under `packages/*/src`), the git commit of the installation (only
  when it is the top level of a git checkout) and the image digest from `HYPERTEST_IMAGE_DIGEST` (set it in container
  builds, as `sha256:<64 hex>`; a malformed value fails start-up);
- the agent engines with their adapter packages and the default engine, the provider adapters and the model catalog
  (routes);
- the schema versions (the last migration of each store);
- the policy bundle (built-in rules, OPA module digest) and the role catalog revision;
- the tool catalog revision (tools with their timeouts and side-effect bindings, side-effect adapter capabilities) and
  the BUGate protocol.

Oracles, budgets and gate settings are run inputs, not part of the manifest. `GET /health`, `hypertest worker` and
`hypertest runtime show current` print the current manifest; `hypertest status <runId>` prints the run's. Changing
code, routes, roles, policy or the protocol is an upgrade and yields a new manifest.

### 5.1 Unmanaged and managed installations

Until a first release is activated, an installation is **unmanaged**: any runtime except a rolled-back one may start
runs, and an upgrade is a redeployment (section 5.4). Once a release is **active**, new runs start only under the active
release, or under the canary when its selection picks the run. `hypertest run` on any other runtime fails
(`precondition_failed`, exit 1) and creates no run. Set `runtime: { requireActiveRelease: true }` to refuse new runs
while no release is active.

Releases live in the store, so every installation on the same PostgreSQL store (or data directory) sees the same
registry. A `<manifestId>` argument is a full id, a unique prefix or `current` (the runtime of the installation that
runs the command). Every decision takes `--by <name>` (a human) or `--by ci:<pipeline>` and a `--reason` where asked;
it is recorded in the append-only release history and refused inside the agent sandbox.

### 5.2 Releasing a new runtime

Deploy the new code or configuration next to the active one on the same store (with PGlite, one process at a time owns
the data directory), then from the new installation:

| Step | Command | Notes |
|---|---|---|
| 1. Register | `hypertest runtime register --by <name> [--allow-migration <schema>:<from>=><to> …]` | The manifest becomes a `candidate`. `--allow-migration` names the schema changes that runs of older releases may take when they are migrated onto this one; it is fixed at registration. To register another installation's manifest, export it there with `hypertest runtime show current --json > manifest.json`, then run `register --manifest manifest.json`. |
| 2. Engine contract | `hypertest runtime record-suite current --kind engine_contract --run --by ci:<pipeline>` executes the AgentEngine contract suites of the engines this runtime pins (bound: executed here). A CI attestation instead: `--kind engine_contract --suite agent-engine-contract --passed --report <tap-file> --total <n> --by ci:<pipeline>` | The report's sha256 is recorded with the attestation (`--passed` without `--report` is refused). Record a failure with `--failed --failures <n>`. A pass claimed over failed cases or over zero cases is refused. |
| 3. Compatibility | `hypertest eval run <suite> --arms deployment --out compat.json`, then `hypertest runtime record-suite current --kind compatibility --from-eval compat.json --by ci:<pipeline>` | The `deployment` arm evaluates this very configuration file, so its trials run under this manifest. A passing result is accepted only when EVERY trial ran under the manifest it certifies (an eval file of another runtime, one whose trials name no manifest, or the partial result of a cancelled `eval run`, is refused); its digest is recorded. |
| 4. Shadow | `hypertest runtime promote current --by <name> --reason "…"` | candidate → shadow: needs the latest `engine_contract` and `compatibility` results, both bound passes. A shadow release creates no ordinary run; it only mirrors production runs (next step). |
| 5. Production replay | On the shadow installation: `hypertest runtime shadow [<runId> …] --by ci:<pipeline>`, then `hypertest runtime record-suite current --kind production_replay --from-shadow --by ci:<pipeline>` | `shadow` re-runs finished runs of the active release (the given ones, else those `runtime.shadow: {percentage, labels}` selects; a run of another release is refused — the reference is production's decision) on this release with every external effect DRY-RUN — recorded `not_applied: dry_run`, never dispatched — and compares outcome, verdict, violated/unknown criteria and human review with the production decision. The production replay passes with at least `runtime.shadow.minRuns` (default 1) mirrored runs and NO divergence; the summary is re-counted from the recorded comparisons. |
| 6. Canary | `hypertest runtime promote current --by <name> --reason "…" --canary-percent 10 [--canary-label key=value …]` | shadow → canary: needs the production replay too. Entering canary needs a selection: a share of new run ids and/or labels (`hypertest run --label key=value`). There is at most one canary. |
| 7. Release gate | `hypertest eval run core --arms deployment [--trials 5] --out core.json`, then `hypertest runtime record-suite current --kind release_gate --from-eval core.json --baseline packages/eval/baselines/core-scripted-multi-llm.json [--baseline-arm scripted-multi-llm --candidate-arm deployment] [--max-critical-false-release r] [--bridge <bridge.json>] --by ci:<pipeline>` | The eval release gate of the CORE suite (any other suite id is refused, and so is a result named core that is not the built-in core suite at its current revision and content) against the committed baseline, with every candidate trial run under this manifest. A candidate gated against itself (same file, or a baseline that ran under this release) is refused. The `Release eval` workflow (`.github/workflows/release-eval.yml`, manual dispatch) runs this step for a deployment configuration with its live routes. |
| 8. Activate | `hypertest runtime promote current --by <name> --reason "…"` | canary → active: needs the release gate too. The active pointer moves; the previous active release becomes `retiring` (its live runs continue on it) and is retired once no live run is pinned to it (`runtime list` and `promote` retire drained releases). |

Each promotion re-checks the LATEST result of every kind its stage needs; a later failing result of an earlier kind
blocks every later step. Results recorded before the stage gates (`replay`) count for nothing.

`hypertest runtime list` shows every release with its state, the active pointer, the canary share and its live runs;
`hypertest runtime show <manifestId>` shows a manifest and its recorded suite results. With Temporal, keep the workers
of every release that still has live runs: each manifest polls its own task queue.

### 5.3 Rolling back and migrating runs

`hypertest runtime rollback [<manifestId>] --by <name> --reason "…"` rolls back the given release; without an id it
stops the canary, or else rolls the active release back to the previous active one (which must still be registered and
not rolled back). The rolled-back release is retired for good and is never promoted again. Its live runs are
**quarantined**: paused with `pauseReason: quarantined`, recorded as `run.quarantined`, noted in the report, and
refused by `resume`. Runs of every other release continue on their pinned manifests without any migration. The command
prints the quarantined runs and asks you to re-run the compatibility and replay suites against the active release
(`record-suite`). Then deploy the active release's code and configuration where the rolled-back one ran.

A quarantined run, or any live run that should move to another release, is migrated explicitly:

```bash
hypertest runtime migrate <runId> --to <manifestId>|current --by <name> --reason "…" [--checkpoint-timeout-ms n]
hypertest resume <runId>    # on the target runtime: takes the migrated run over (the migration itself never drives it)
```

The migration checkpoints the run (in-flight turns give their claims back; default wait 90 s), takes a canonical
snapshot and reconciles its operations (refused while an operation is unsettled or a work item is waiting). It then
checks compatibility: the target is active or canary, the schemas are equal or covered by an allowed migration, the
engines the run used are pinned, and the protocol is the same. One transaction records a RuntimeEpoch and
`run.migrated`, re-pins the run and resumes it. A refused migration leaves the run as it was. A work item waiting only on a
model pause (`model:<agent>`, the provider was unavailable) holds no turn and no effect: it migrates, and its pause
carries over to the new epoch (`carriedModelPauses`); a wait on an operation, a child or an approval refuses the
migration until it settles. Alternatively cancel the run with `hypertest cancel <runId> --reason "…"`.

`resume` on the target verifies the take-over: it waits until the target's durable loop really drives the run
(`run.migration_driven`). With Temporal the run's previous workflow may still be open on the SOURCE manifest's task
queue (its `startRun` would be a silent no-op): it is woken so its next tick ends at the pin refusal, and when no worker
of the source runtime is left, the target briefly serves that queue with a handover worker that refuses exactly this
run. If the take-over does not happen within 30 s, `resume` fails (`unavailable`) with the remedy (e.g. `temporal
workflow terminate --workflow-id run-<runId>`) — it never reports a run as resumed that nobody drives. `hypertest resume`
without a run id and `hypertest serve` (which resume every incomplete run of the runtime) take migrated runs over the same
way; a migrated run whose take-over did not happen is left out of the resumed runs and a warning names the remedy.

If the migrating process dies between the checkpoint and the re-pin, the run stays paused `migrating` and cannot be
resumed. `hypertest runtime migrate <runId> --abort --by <name> --reason "…"` releases the checkpoint
(`run.migration_released`), and the run continues on the runtime it is still pinned to (a run of a rolled-back release
is quarantined instead).

Limits: an `engine_contract` attestation (`--passed --report`) is vouched for by whoever records it (its report digest
is kept); every other kind is bound to evidence the registry checks (trial manifests, shadow comparisons, the gate's
digests). Migration and its take-over are exercised with the local durable runtime and against a live Temporal server
(source worker still running; source runtime gone).

### 5.4 Unmanaged upgrades and database migrations

Without an active release:

1. Let live runs finish, or cancel them. With Temporal you can instead keep the old workers running: they keep
   polling their own queue until their runs are done.
2. Deploy the new code and configuration. Migrations run at startup; they are idempotent and recorded in
   `ht_migrations`.
3. `hypertest resume` (or `serve`) resumes only runs pinned to the new manifest. Runs pinned elsewhere are logged and
   left alone.

Rolling back means redeploying the old code and configuration; the same content gives the same manifest id, so the
old runtime can drive its runs again. In both modes database migrations are forward-only (there are no
down-migrations) and must stay compatible with the release that is still running (expand, then contract): try a
rollback against a copy of the database first.

### 5.5 Evaluating a runtime (`hypertest eval`)

| Need | Command |
|---|---|
| A tier | `eval run --tier pr-smoke` (fast subset ×1, every change) · `--tier release-core` (core ×5) · `--tier deep` (everything ×5) · `--tier failure-recovery` (chaos ×10, child-process SIGKILLs); `--trials`, `--mode` or an explicit suite override the tier |
| This deployment's configuration | `--arms deployment` (the whole configuration file; trials run under its manifest, on the task's fixtures only: the deployment's own `environments` and `tools.httpAllowlist` targets — not part of the manifest — are left out) · `--arms config` (its models and role policies only) |
| Controlled causal arms (fixed model, harness varies) | `--arms h0-single-agent,h1-subagents,…,h6-full` (eval trial instances only: a deployment configuration that switches a subsystem off is refused) |
| Product baselines | `--arms engine-pi,engine-dsh` (same model, other agent engine) · external agents: `--arm-file arms.json --arms claude-code` with `{"arms":[{"armId":"claude-code","external":{"command":"claude","args":["-p","{goal}","--report","{report}"],"envPassthrough":["ANTHROPIC_API_KEY"]}}]}` (graded on the reported outcome only; its claims count as no evidence) |
| Provider classes | `--arms three-provider-classes` (anthropic, openai-compatible and pi-ai adapters over the scripted wire transport; in-process; opt-in by name — without `--arms` a run uses the plain model arms, scripted multi/single and live when configured, that can run in the mode) |
| Private / public layers | `--suite-dir <dir>` (`*.suite.json` / `*.suite.mjs`: your historical bugs and release rules; versioned by content; a private suite may not reuse a built-in suite id) · `eval run sanity --dataset swe.jsonl --repos <local mirrors>` (SWE-bench-style; never downloads) |
| Learning track | Trials are COLD by default (no long-term memory crosses trials; a shared memory backend is refused). `--track learning --experience items.json` seeds only approved/published experience |
| Independent judge | `--judge scripted` (the calibrated CI judge) or `--judge config [--judge-route r]` (your configuration's routes); `--judge-packets <dir>` keeps what it saw; `eval calibrate [--set file]` measures agreement and kappa (exit 1 when uncalibrated: its results never count); `eval calibrate label --set file --packet p --label pass|fail|unknown --by <name>` adds a human label (refused inside a Hypertest sandbox) |
| Cancellation | Ctrl-C (exit 130) or `--timeout <ms>` (exit 1): the running trial is cancelled, the partial result is still written to `--out`, marked `cancelled` — it never gates anything |
| Release gate | `eval gate --baseline b.json --candidate c.json [--max-critical-false-release r] [--bridge bridge.json]`: critical false release not worse AND its rate within the product SLO (default 0), defect recall not significantly lower and no defect the baseline always found lost, security violations 0, duplicate effects 0, evidence completeness 100 %, comparable results |
| A grader changed | `eval bridge core --grader <id>@<old revision> --out bridge.json` grades the same trials with the retained old revision; `eval gate --bridge bridge.json` accepts the change only without a discontinuity — otherwise re-baseline |

Suite revisions are pinned to their content (`packages/eval/suites.lock.json`: tasks, brains, fixtures): a change under
an old revision fails the test suite; bump the revision and re-baseline. Re-baselining the committed core baseline is
documented in `packages/eval/baselines/README.md`.

## 6. Observability

- Logs are JSON lines on stderr. Set the level with `observability.logLevel`, `--log-level` or `HYPERTEST_LOG_LEVEL`.
- `hypertest events <runId> [--follow] [--types a,b]` and `GET /runs/:id/events` (SSE) stream the L0 events: model
  routes, tool calls, permits, operations, admissions and gate evaluations, with correlation and causation ids.
- There is no OpenTelemetry export and events carry no `traceId`.

## 6a. Model governance

- **Prices.** The catalog price is the route's `costPerMillionInputUsd` / `costPerMillionOutputUsd` (a route without
  both has an unknown cost and is never used by a run or work item with a USD budget). Observed prices live in
  `models.pricesFile` (default `<dataDir>/state/model-prices.json`): `hypertest model prices set|clear|list`. With
  `models.priceGuard.maxIncreasePct`, an observed price that far above the catalog price opens the route's circuit.
- **Eval scores.** `hypertest eval run <suite> --out result.json`, then `hypertest eval apply-scores result.json --out
  scores.json`, then set `models.scoresFile: scores.json`: the next start routes with the scores, and the
  RuntimeManifest records them (`modelScores`: digest, routes, provenance), so a scores change is a new manifest.
- **Budget near its end.** Before a turn, the working context is condensed to what the remaining run/work budget can
  pay for (`context.budget_condensed`), the call's output reserve shrinks to what remains (not below 1024 tokens), and
  under budget pressure the agent switches to a cheaper eligible route (`cost` epoch). Reservations use the token
  estimate calibrated against what the provider reported (`model.invoked` records `estimatedInputTokens` next to
  `usage.inputTokens`).

## 7. Supply-chain checks

CI runs these on every push and pull request (technology-selection §许可证策略):

| Check | Command | CI |
|---|---|---|
| License policy | `npm run license:check` (`--json`, `--omit dev`, `--allow ID,…`) | blocking |
| SBOM | `npm run sbom` writes a CycloneDX document to `.hypertest-sbom.json` (`--out <file>`, `--omit dev`) | uploaded as the `sbom` artifact |
| Vulnerabilities | `npm audit --omit=dev --audit-level=high` | informational (advisories change without a code change) |
| Script tests | `npm run test:scripts` | blocking |
| Eval release gate | `npm run eval:gate` (the core suites against `packages/eval/baselines/core-scripted-multi-llm.json`; report in `.hypertest-eval/`) | blocking |

- **License policy.** Every installed package's `license` (an SPDX expression) must be satisfiable from the allowlist:
  MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, Python-2.0 and CC-BY-4.0.
  Unknown licenses (missing, unparseable, `UNLICENSED`, "SEE LICENSE IN …") and copyleft or other licenses fail unless
  `scripts/license-exceptions.json` has a reviewed exception. An exception names the package, the exact license
  expression it was reviewed for (and optionally the version) and a rationale, so a later relicensing is reviewed
  again. Ambiguous spellings such as "BSD" or "Public Domain" are never mapped onto an allowed license, and stale
  exceptions are reported as warnings. Exit codes: 0 ok, 1 violation, 2 usage or unreadable input. The current lockfile
  (400 packages) passes with one exception (`unionfs`, which declares no license field and ships the Unlicense).
- **SBOM.** Taken from `npm sbom` (npm ≥ 10.1); otherwise built from `package-lock.json` as CycloneDX 1.5 with purl,
  version, license, the lockfile's SHA-512 integrity and the resolved URL of every package. The source is recorded in
  `metadata.properties` (`hypertest:sbom:source`). The lockfile is the dependency provenance record either way.
- **Audit.** At the time of writing `npm audit --omit=dev` reports one moderate advisory (`ajv`, ReDoS with the `$data`
  option). The CI step does not block on it.
- **Not covered yet:** fork patch tracking and package signature/provenance attestation (`npm audit signatures`).
- The generated `.hypertest-sbom.json` and `.hypertest-eval/` are build outputs; do not commit them.
