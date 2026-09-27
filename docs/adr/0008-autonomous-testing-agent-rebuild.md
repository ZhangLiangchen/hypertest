# ADR-0008: Rebuild Hypertest as an evidence-driven autonomous testing agent

- Status: Accepted
- Date: 2026-09-25
- Supersedes: ADR-0001…ADR-0007 (archived under `docs/archive/v0.2/adr/`)
- Sources: [technology selection](../design/technology-selection.zh-CN.md),
  [architecture improvements](../design/architecture-improvements.zh-CN.md)
- Implementation blueprint: [BLUEPRINT.md](../architecture/BLUEPRINT.md)

## Context

v0.2 was a deterministic test-development pipeline with a bounded, read-only
Pi planner. The target product is different in kind: an **autonomous testing
agent** that receives a testing *goal* and itself decides decomposition,
risks, white-box vs black-box strategy, subagent topology, per-role models,
tools, replanning and when evidence suffices — while truth, side effects and
quality decisions stay governed outside the model.

## Decision

1. **Hypertest owns its runtime ABI** (`@hypertest/runtime` `AgentEngine`):
   agent lifecycle, sessions, turns, subagents, model epochs, context, tools,
   permissions, evidence and gate semantics are Hypertest types. Engines are
   adapters: the native engine is the reference; `pi-agent-core` is adapted
   (pin + adapter, no fork); DeepSeek Harness is adapted behind the same ABI
   (`@hypertest/runtime-dsh`: pin + adapter; surgical fork only for
   irreducible gaps — the fork decision gate found none).
2. **Native multi-LLM**: `ModelPolicy` is a first-class attribute of every
   role/work item; routing is security → capability → role → quality →
   latency → cost; fallback is fail-closed and re-validated; switches happen
   only at safe turn boundaries (new `ModelEpoch`).
3. **Dynamic, bounded-decentralized collaboration**: the Lead proposes typed
   `PlanRevision`s (never code); the scheduler validates and admits; the
   Blackboard + event bus (outbox → in-process or NATS JetStream, inbox dedupe)
   lets roles react to findings without the Lead in the path; claims/leases
   with fencing tokens and budgets bound it; the scheduler keeps convergence
   authority.
4. **Durable by design**: all domain truth in PostgreSQL (PGlite embedded for
   local/dev); Temporal (or the local durable runtime) owns only lifecycle;
   every external side effect goes through the Operation Ledger with
   reconciliation, `outcome_unknown` and fencing.
5. **Testing domain contracts are core**: SystemModel, OracleSpec,
   ExperimentSpec, TestArtifact, QualityDecision; agents may propose oracle
   changes but never self-approve; the deterministic QualityGate alone
   produces verdicts (`pass|fail|conditional|inconclusive`).
6. **Evidence is truth**: content-addressed artifacts, hash-chained evidence
   ledger, Merkle root sealed with Ed25519; reports cite evidence.
7. **BUGate is consumed as a protocol**: `ProtocolBinding` +
   `PreparedProtocolContext` (BUGate v2 schema) injected into every agent;
   runtime authorization is Hypertest's policy plane (built-in rules + OPA).

## Consequences

- The v0.2 code is removed (history keeps it); portable algorithms (coverage
  parsers, runner parsing) are re-implemented in `@hypertest/tools`.
- The previous "fork count zero / only pi-agent-core" constraint is replaced
  by: no forks by default; engines are adapters behind the ABI; third-party
  SDKs are confined to their adapter package (enforced by
  `scripts/check-boundaries.mjs`).
- LangGraph is not used; Temporal is optional (local durable runtime for
  single-process deployments).
