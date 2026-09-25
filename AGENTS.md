# Hypertest agent instructions

Hypertest is an evidence-driven, multi-model, durable **autonomous testing
agent**. Agents inside it explore freely; truth, side effects and quality
decisions are governed outside the model.

## Read before changing anything

1. [docs/architecture/BLUEPRINT.md](docs/architecture/BLUEPRINT.md) — normative
   design, invariants I1–I12, package DAG, flows.
2. The package's `src/contracts.ts` — the binding ABI of that package.
3. [ADR-0008](docs/adr/0008-autonomous-testing-agent-rebuild.md) and the design
   sources in `docs/design/` for rationale.

## Non-negotiable rules

- Models propose; deterministic code disposes. Every tool call passes
  capability check → policy permit → freshness validation (mutating) →
  operation ledger (side effects) → evidence.
- Never let an agent weaken an oracle, assertion or threshold, or skip/delete
  a failing test to get green. Only the QualityGate produces verdicts; missing
  evidence yields `inconclusive`, never `pass`.
- A failing test is a successful tool call with a failed outcome; faults are
  `HypertestError`s. PASS, FAIL, XFAIL, SKIP and fake-green are distinct.
- External side effects only through the SideEffectGateway with a stable
  operation id; unknown outcomes are reconciled, never blindly retried.
- Event delivery is at-least-once: every consumer dedupes by event id.
- Keep packages inside the dependency DAG and third-party SDKs inside their
  adapter package (`npm run check:boundaries`). Domain code never imports
  engine (Pi/DSH), Temporal or NATS types.
- Erasable TypeScript only (Node runs `.ts` directly): no `enum`, `namespace`,
  parameter properties or decorators; relative imports end in `.ts`.
- Every production change includes failure-path tests; infra-dependent tests
  skip with an explicit reason when infra is absent.

## Verify

```bash
npm ci
npm run infra:fetch && npm run infra:up   # optional: PostgreSQL, NATS, Temporal, OPA
npm run check                             # typecheck + boundaries
npm test                                  # unit + integration + e2e
```
