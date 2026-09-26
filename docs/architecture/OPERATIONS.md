# Operating Hypertest

English | [简体中文](OPERATIONS.zh-CN.md)

How to deploy, secure, recover and upgrade Hypertest. The configuration reference is the
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
endpoint), PowerContext memory (implemented; not run against a live service).

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
  activities (section 5).
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

## 2. Security

| Control | Default | Guidance |
|---|---|---|
| Agent command sandbox | `sandbox: { kind: local, network: loopback }` | On Linux with unprivileged user namespaces and python3, each command runs in its own user, network, PID and mount namespaces. It reaches only its own loopback plus the relayed endpoints of registered environments and `tools.httpAllowlist`; keys, the store, artifacts and other workspaces are hidden; argv may not name paths outside the workspace. Hosts without namespaces refuse these profiles. **Residual:** commands run as the same OS user and can read the rest of the host file system. |
| Untrusted models or code | – | Use `sandbox: { kind: oci, image: <image with your toolchain>, network: none, cpuLimit, memoryMb }` (docker, `--cap-drop ALL`, no new privileges). `network: open` removes egress control for the local sandbox; use it only on hosts where that is acceptable. |
| Secrets | none in the file | `*Env` fields name environment variables; inline keys, tokens, passwords and credential headers are configuration errors. Sandboxed commands get only `sandbox.envAllowlist` (default PATH, HOME, LANG, LC_ALL, TMPDIR). `doctor` prints variable names, never values. |
| Data directory | `.hypertest/` (0700) | Holds the database, artifacts, `keys/` (0600) and workspaces. Keep it out of git (`init` adds it to `.gitignore`). |
| REST API | `127.0.0.1`, no token | Always set a token of at least 16 characters in `HYPERTEST_API_TOKEN` (or name another variable with `--token-env`). A non-loopback `--host` requires a token. Human decisions over the API always require it, because agents can reach loopback services. Put TLS in front for remote use. |
| Human decisions | CLI or API | `approve`, `oracle establish`, `oracle decide`, `waive` and `experience review` need `--by <name>` (plus `--reason` where the command asks for it) and are recorded as `human:<name>`. A requester never decides its own request. All of them are refused when `HYPERTEST_SANDBOX` is set, which both sandboxes set in every command. |
| Permits | built-in rules | Reads and records are allowed; writes and execution only inside the workspace. External effects are allowed on `local`/`sandbox` environments and need approval on `staging`. Destructive effects need approval on `staging`, at high risk on `sandbox` and at critical risk anywhere. Anything above read on `production` is denied, and agents can never decide approvals or oracle changes. Add `policy.rules` or OPA to tighten. |
| Environments | none | Register black-box targets in `environments:` with an `environmentClass`. Control-plane tokens come from `control.tokenEnv`, never the file. |

With PGlite a paused run holds the store lock, so a human cannot approve from a second process. Stop the foreground
command (Ctrl-C; the run stays resumable), run `hypertest approve …`, then `hypertest resume`, or use `serve` and the API.

## 3. Recovery runbook

| Situation | What Hypertest does | What you do |
|---|---|---|
| The CLI process crashed or was interrupted (exit 130) | The run stays in the store; open operations stay in the ledger | `hypertest resume` (or restart `hypertest serve`, which resumes at start unless `--no-resume`) |
| A Temporal worker died | Activities heartbeat; another worker of the deployment retries them within about a minute | Restart workers with the same code and configuration |
| Restart with side effects in flight | `verified` operations return their recorded result; `dispatching`, `acknowledged` and `outcome_unknown` ones are observed and reconciled before any re-dispatch; external load jobs are re-attached by operation id; expired leases get new fencing tokens; leaked budget reservations are released | Nothing. The report's "Recovery log" lists what was reconciled and re-run |
| `precondition_failed` naming a lock holder (PGlite) | A lock left by a dead process on this host is taken over automatically | If the holder is on another host and gone, delete `<dataDir>/db.lock` |
| An operation ended in `manual_review` | It is never retried automatically: its outcome cannot be known or it must not be repeated | `hypertest events <runId> --types operation.manual_review,operation.late_receipt`; check the target system using the operation id (it is the idempotency key and the job label); clean up by hand; start a new run. The ledger entry stays as the audit record |
| An oracle change that flips a recorded failure was approved | Decisions that relied on the old revision are flagged; history is not rewritten | `hypertest status <runId>` shows the reassessment flag; start a new run, which pins the new revision |
| A pinned oracle was superseded during a run | Gate criterion C0 is `unknown`, so the verdict is `inconclusive` | Start a new run |
| The run budget ran out | The run goes to the gate with the evidence it has (never a silent downgrade); gaps make it `inconclusive` | Raise `budget` in the configuration (or in `POST /runs`) and start a new run |
| A live run is pinned to another runtime manifest | It is not resumed; the control plane refuses to drive it | Finish it with its own runtime (section 5) or `hypertest cancel <runId> --reason "…"` |
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

## 5. Upgrading and manifest pinning

Every run is pinned to the `RuntimeManifest` of the runtime that started it (invariant I11). The manifest id is a
content hash of:

- the Hypertest version and a source digest (every file under `packages/*/src`);
- the agent engines, provider adapters and model catalog (routes);
- the schema versions;
- the policy bundle (built-in rules, OPA module digest, role catalog);
- the tool catalog and the BUGate protocol.

Oracles, budgets and gate settings are run inputs, not part of the manifest. `GET /health` and `hypertest worker`
print the current manifest; `hypertest status <runId>` prints the run's.

Changing code, routes, roles, policy or the protocol is an upgrade:

1. Let live runs finish, or cancel them. With Temporal you can instead keep the old workers running: they keep
   polling their own queue until their runs are done.
2. Deploy the new code and configuration. Migrations run at startup; they are idempotent and recorded in
   `ht_migrations`.
3. `hypertest resume` (or `serve`) resumes only runs pinned to the new manifest. Runs pinned elsewhere are logged and
   left alone.

Rolling back means redeploying the old code and configuration; the same content gives the same manifest id, so the
old runtime can drive its runs again. Migrations are forward-only (there are no down-migrations): try a rollback
against a copy of the database first. Release states, an active-runtime pointer and migration of in-flight runs to a
new runtime are not implemented ([CONFORMANCE.md](CONFORMANCE.md), runtime manifest and release).

## 6. Observability

- Logs are JSON lines on stderr. Set the level with `observability.logLevel`, `--log-level` or `HYPERTEST_LOG_LEVEL`.
- `hypertest events <runId> [--follow] [--types a,b]` and `GET /runs/:id/events` (SSE) stream the L0 events: model
  routes, tool calls, permits, operations, admissions and gate evaluations, with correlation and causation ids.
- There is no OpenTelemetry export and events carry no `traceId`.
