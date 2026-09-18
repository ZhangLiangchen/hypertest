# ADR-0005: Durable workflow runtime and BUGate authorization boundary

- Status: Partially superseded by ADR-0006 (durable runtime decision remains accepted; BUGate authorization/PDP/PEP model is superseded)
- Date: 2026-09-18
- Companion: [BUGate ADR-BUGATE-006](https://github.com/ZhangLiangchen/BUGate/blob/main/docs/qa-methodology/BUGATE_RUNTIME_BOUNDARY_ADR.md)
- Superseding BUGate integration decision: [ADR-0006](0006-bugate-protocol-binding.md)

Implementation sequencing, source-level scope and acceptance:
[HyperTest refactoring guide](../governance-runtime-refactor-guide.md).
The guide clarifies replay, human-approval and external-effect recovery requirements.

## Context

HyperTest's handwritten orchestrator and deterministic state machine currently
carry execution ordering, retry/repair loops, deadlines, event history, and
terminal-state handling. This is a useful executable specification, but the run
ledger is not yet a durable checkpoint/resume runtime for long-running,
interruptible, or distributed work.

At the same time, frontier agents increasingly perform their own local
planning, tool selection, reflection, and subtask decomposition. Encoding every
reasoning step as a graph node would constrain the agent and create a large,
fragile state machine. HyperTest needs durable execution semantics, not a graph
that imitates the model's chain of thought.

BUGate already supplies the independent quality-policy and authorization
boundary. Its governance receipt/evidence chain must remain distinct from
workflow checkpoints.

## Decision

HyperTest requires a replaceable **durable workflow runtime**. LangGraph is the
current preferred implementation, not an architectural invariant. It is placed
behind a HyperTest-owned `WorkflowRuntime` boundary so another runtime can
replace it without changing BUGate policy, adapters, artifacts, or agent
harness contracts.

The design principle is **thin graph, fat agent**:

- the graph contains coarse system transitions whose durability, retry,
  approval, concurrency, or side effects matter;
- Pi/agent nodes own strategy, local planning, tool use, reflection, and
  optional subtask creation;
- BUGate owns authorization state and trust decisions;
- deterministic HyperTest code owns legal transition semantics, budgets,
  safety invariants, and conformance checks.

The initial macro graph should stay close to:

```text
INIT -> ANALYZE -> EXECUTE -> DIAGNOSE -> REMEDIATE -> VERIFY -> PUBLISH
```

Gate nodes or interrupts are introduced only where a protected action,
human decision, irreversible side effect, or durable recovery boundary exists.
Tool-level reasoning steps do not become graph nodes merely because they are
observable.

## State and authority model

| State or concern | Authority |
|---|---|
| Agent strategy and tool-loop mechanics | `AgentRuntime`; Pi remains the only SDK-level agent harness |
| Legal workflow transitions, retry/budget rules, and conformance oracle | HyperTest deterministic domain core |
| Checkpoint/resume, scheduling, interrupt, parallel work, and generic execution recovery | `WorkflowRuntime`; initially LangGraph |
| Evidence, policy verdicts, authorization receipts, obligations, lineage, and promotion authority | BUGate PDP/audit kernel |
| Applying a protected patch or publishing a change | HyperTest's brokered BUGate PEP |
| Versioned plans, patches, runs, diagnoses, and reports | HyperTest artifact store |

`src/state-machine.ts` therefore does not disappear. It evolves from the sole
runtime implementation into the workflow specification and conformance oracle.
The runtime must not be able to traverse a path that the domain transition
specification rejects.

LangGraph checkpoints store execution state plus immutable artifact/receipt
references. They do not become the source of truth for BUGate authorization,
and they do not duplicate mutable receipt chains.

## BUGate interaction

LangGraph asks BUGate for decisions and routes on the returned verdict:

```text
BUGate allow       -> protected node may be attempted
BUGate deny        -> rejected terminal/result path
BUGate needs_human -> durable interrupt
```

The edge mapping belongs to HyperTest. The reason for the verdict, required
obligations, evidence binding, receipt lineage, and authority belong to BUGate.
A restored workflow must revalidate any expired or drifted authorization before
a side effect.

Every protected side effect uses a brokered PEP:

1. build a fresh `GateRequest` from current source/artifact hashes;
2. request and validate the BUGate decision;
3. compare-and-swap consume its scoped, one-use authorization immediately
   before the effect;
4. execute the exact patch/publication through the only component holding that
   capability; and
5. persist an outcome attestation binding the decision to the resulting
   revision and artifacts.

The agent is not given a parallel raw write or publish path. BUGate
unavailability, invalid/expired receipts, obligation failure, evidence drift,
or consumption conflict fails closed.

## `sdtd_orchestrator.py` migration

HyperTest will not depend on `sdtd_orchestrator.py --auto` as its steady-state
integration and BUGate will not rewrite that script with LangGraph.

The migration is:

1. BUGate exposes versioned, idempotent, machine-readable primitives for
   initialization, validation, generation, policy decisions, receipt
   verification, and outcome publication.
2. HyperTest workflow nodes call those primitives through the BUGate adapter.
3. HyperTest/LangGraph takes ownership of peer scheduling, long-running phase
   sequencing, retries, pause/resume, post-run flow, and remediation loops.
4. The old `--auto` path remains a deterministic standalone compatibility
   wrapper until parity, fault-injection, recovery, migration, and support-window
   exit criteria are met.

Self-healing authorization rules remain in BUGate; remediation-loop execution
belongs to HyperTest. Multiview/adversarial acceptance remains BUGate policy;
worker dispatch belongs to HyperTest.

## Implementation boundary

The intended code shape is:

```text
src/workflow/
  runtime.ts                 # HyperTest-owned interface
  specification.ts           # legal macro transitions / conformance
  nodes/                     # coarse autonomous or deterministic nodes
  langgraph/                 # the only LangGraph-specific implementation
src/runtime/pi/              # unchanged Pi agent-harness boundary
src/gate.ts                  # BUGate PDP request/decision contract
src/enforcement/             # brokered PEP and outcome attestations
```

LangGraph types must not leak into the domain core, gate contract, adapters, or
Pi harness. Pi remains the only SDK-level **agent-runtime** dependency;
LangGraph is a separate workflow-runtime implementation.

## Rollout

1. Define `WorkflowRuntime` and run/checkpoint identity contracts; keep the
   existing orchestrator as the reference implementation.
2. Add LangGraph behind the boundary and prove trace equivalence against the
   deterministic state-machine specification.
3. Add restart, duplicate-delivery, partial-node-failure, interrupt/resume,
   receipt-expiry, evidence-drift, and PEP-consumption tests.
4. Migrate one macro phase at a time with the old path available for rollback.
5. Retire handwritten runtime mechanics only after conformance and recovery
   evidence is complete; retain the transition specification as an oracle.

## Consequences

- HyperTest gains durable execution without reducing agent autonomy.
- BUGate remains SUT-neutral and runtime-agnostic.
- Execution checkpoint, authorization receipt, and artifact state have explicit
  owners and cannot silently substitute for one another.
- The workflow-runtime abstraction adds an integration seam and conformance
  suite, but avoids permanent framework lock-in.
- Strong enforcement requires the PEP, not merely a graph gate node: protected
  capabilities must be unavailable through any bypass path.

## Rejected alternatives

- **Model every reasoning/tool step as a LangGraph node.** Rejected as
  over-orchestration that constrains capable agents.
- **Rewrite BUGate with LangGraph.** Rejected because authorization state and
  execution state have different trust domains.
- **Use workflow checkpoints as receipts.** Rejected because checkpoints prove
  location/progress, not authorization provenance.
- **Keep extending the handwritten orchestrator indefinitely.** Rejected
  because HyperTest needs tested durable-execution semantics.
- **Remove `sdtd_orchestrator.py` immediately.** Rejected until the standalone
  compatibility path has a proven replacement and support exit.

