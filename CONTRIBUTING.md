# Contributing to Hypertest

English | [简体中文](CONTRIBUTING.zh-CN.md)

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | ≥ 22.18 (CI: 22.19.0) | everything; TypeScript runs directly, there is no build step |
| npm | ≥ 10 | workspaces |
| git | ≥ 2.24 | fixture repositories, worktrees |
| Linux with unprivileged user namespaces, util-linux `unshare`, python3 | – | the local sandbox that tests run commands in. On Ubuntu 24.04: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` |
| pytest, Go | any recent | the pytest and `go test -json` runner tests (skipped when absent) |
| PostgreSQL 16 server binaries, curl | – | optional: `npm run infra:up` (PostgreSQL, NATS, Temporal, OPA) |

## Before you change anything

1. Read the [blueprint](docs/architecture/BLUEPRINT.md): invariants I1–I12, the package DAG, the flows.
2. Read the package's `src/contracts.ts` (its binding ABI) and `README.md`.
3. Read [AGENTS.md](AGENTS.md): the non-negotiable rules for agents and humans alike.
4. Check [CONFORMANCE.md](docs/architecture/CONFORMANCE.md) for the current status of the area you touch.

## Workflow

1. **Contract first.** Change `src/contracts.ts` before the implementation. Contract changes are additive and backward
   compatible, and are recorded under "Contract changes" in the package README.
2. **Implement inside the DAG.** A package may import only the packages `scripts/check-boundaries.mjs` allows, and
   third-party SDKs stay in their adapter package (`@temporalio/*` in durable, `@nats-io/*` in collab, `pg` and
   PGlite in store, and so on). Domain code never imports engine (Pi/DSH), Temporal or NATS types.
3. **Test the failure path.** Every production change includes tests of what happens when things go wrong. A new
   guarantee needs a test that fails on the old code.
4. **Run the checks** (below) on PGlite and, for anything touching SQL, on PostgreSQL.
5. **Update the documentation in the same change.** Update the package README (behaviour and contract changes). Update
   the [CONFORMANCE.md](docs/architecture/CONFORMANCE.md) row when a requirement's status changes. The framework-facing
   documents are bilingual: when you edit `README.md`, `CONTRIBUTING.md` or a document in `docs/architecture/` that has
   a `*.zh-CN.md` mirror, update the mirror too and keep the language links at the top.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | install exactly the lockfile |
| `npm run check` | typecheck (`tsc --noEmit`) and package boundaries |
| `npm test` | unit, integration and e2e tests (`scripts/run-tests.mjs`) |
| `npm run test:unit` / `test:integration` / `test:e2e` | one kind; append `-- --package <name>` for one package |
| `node scripts/run-tests.mjs --package <name>` | every test of one package |
| `HYPERTEST_TEST_DB=postgres npm test` | every store on a fresh PostgreSQL schema (needs `HYPERTEST_TEST_PG_URL`) |
| `npm run infra:fetch` / `infra:up` / `infra:status` / `infra:down` | local PostgreSQL, NATS JetStream, Temporal dev server and OPA; `up` writes `.infra/env`, which the test runner loads |

CI (`.github/workflows/ci.yml`) runs `npm run check` and `npm test` with a PostgreSQL 16 service, and a second job
runs the whole suite with `HYPERTEST_TEST_DB=postgres`.

## Tests

- `node:test` and `node:assert/strict`, in `packages/<pkg>/test/`. Files are `*.test.ts` (unit: hermetic, no
  network), `*.int.test.ts` (integration: local infrastructure) and `*.e2e.test.ts` (whole runs with scripted models).
- A test that needs absent infrastructure **skips with an explicit reason**; it never passes silently.
- Models in tests are `ScriptedProvider` brains or local mock servers. Inject `Clock` and `IdGenerator` for
  deterministic results.
- Never adapt an assertion to wrong behaviour, and never skip or delete a failing test to get green. PASS, FAIL, XFAIL,
  SKIP and a fake-green run are different signals.

## Code rules

- Erasable TypeScript only (Node strips types): no `enum`, `namespace`, parameter properties or decorators. Use
  `import type` for types; relative imports end in `.ts`.
- Faults throw `HypertestError` (code, message, retryable). Legitimate negative results are returned as outcomes: a
  failing test is a successful tool call with a failed outcome.
- Persistence goes through the `SqlDatabase` port. Migrations are `<pkg>/<nnn>-<name>` with `ht_` tables and must run on
  PGlite and PostgreSQL 16. Append-only tables stay append-only.
- No `console.log` in library code; use the `Logger` port.
- Models propose and deterministic code disposes: every tool call passes capability → permit → freshness (mutating) →
  Operation Ledger (side effects) → evidence. External side effects go only through the side-effect gateway with a
  stable operation id. Event consumers dedupe by event id.
- Only the QualityGate produces verdicts, and missing evidence is `inconclusive`. Do not add a path that lets an agent
  weaken an oracle, assertion or threshold.

## Pull requests

- Keep changes focused; do not combine unrelated upstream upgrades.
- Engine upgrades (`@earendil-works/pi-agent-core` is pinned exactly) must pass the engine contract suite
  (`packages/runtime/src/contract-suite.ts`).
- A new tool or side-effect adapter documents its effect, risk class, resources, idempotency and reconciliation
  behaviour, and has tests for timeouts, unknown outcomes and duplicate delivery.
- New configuration never accepts inline secrets: use a `*Env` field.
