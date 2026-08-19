# HyperTest architecture

## Authority model

HyperTest deliberately has three non-overlapping authorities:

| Concern | Authority |
|---|---|
| Next computational step, retry, timeout and budget | HyperTest deterministic core |
| Model/tool-loop mechanics | `AgentRuntime`; Pi is the only SDK implementation |
| Quality policy and permission to mutate/publish | BUGate PDP/PEP |

A model, adapter, CI platform, or hub cannot override a BUGate denial. The
model cannot call BUGate or advance the state machine. BUGate unavailability
permits read-only analysis but fails closed for applying a governed patch or
publishing a change.

## Topology

```mermaid
flowchart TB
  Entry[CLI / CI] --> Core

  subgraph Control[Quality control plane]
    PDP[BUGate PDP]
    PEP[BUGate PEP]
    PDP --> PEP
  end

  subgraph CoreBox[HyperTest Core]
    Core[Deterministic state machine]
    Runtime[AgentRuntime facade]
    Store[Versioned artifact store]
    Policy[Deterministic diagnosis and repair policy]
    Core --> Runtime
    Core <--> Store
    Core --> Policy
  end

  Runtime --> Pi[pi-agent-core]
  Pi --> PlannerTools[Fixed read-only planner tools]
  PlannerTools --> Contract[In-memory SutContract]

  Core --> Gate[BUGate process bridge]
  Gate --> PEP
  Core --> Sut[SUT adapter]
  Core --> Test[Test-framework adapter]
  Core --> Code[Code-intelligence adapter]
  Core --> CI[CI adapter]
  Core --> SCM[Change-publisher adapter]
  Test --> Sandbox[Local / OCI sandbox]
  Test --> Coverage[Native coverage adapter]

  Sut --> Target[HTTP / CLI / other SUT]
  Test --> Runner[Test runner]
  Code --> LSP[LSP server]
  CI --> Platform[CI platform]
  SCM --> Host[SCM host]
```

The current model slice is planner-only. Its tool allowlist is
`contract.list_operations` and `contract.get_operation`; both read only the
current in-memory contract. Adapters, the host filesystem, shell, network,
BUGate, repair, and publication are not model tools.

## Core pipeline

```text
raw interface definition
  -> sut-contract.v1
  -> deterministic plan + optional validated model augmentation
  -> test-plan.v1
  -> BUGate enter-implementation decision
  -> framework-owned patch
  -> validation and BUGate apply-patch decision
  -> isolated test-run.v1 + coverage-map.v1
  -> deterministic diagnosis.v1
  -> optional safety-checked repair loop
  -> verification
  -> BUGate publish-change decision
  -> optional idempotent draft MR/PR
```

The model augmentation cannot bypass deterministic planning, semantic checks,
or artifact generation. Runtime events, validation, retry, usage, budget, and
tool security are specified in [model-runtime.md](model-runtime.md).

## Portability boundary

The common core has no pytest, Go, HTTP, OpenAPI, JUnit, LCOV, GitLab, or GitHub
domain types. Adapters receive JSON requests and return versioned JSON/file
artifacts with explicit status, timeout, retry, and domain-failure semantics.

Coverage is normalized to source regions with a capabilities object. Missing
branch, condition, function, or per-test information remains unknown; it is
never coerced to zero. LSP results likewise carry capabilities and completeness
because language servers do not provide identical semantics.

## Failure model

An assertion failure is a successfully completed adapter call whose `TestRun`
outcome failed. It is not a transport failure. Adapter failures are separately
classified as unsupported, transient, permanent, cancelled, or timed out.

Model runtime failures are also separate from adapter and test failures. They
are classified as cancellation/deadline, Provider transport/protocol/rate
limit, model parse/schema, tool input/execution/loop, output limit, or budget
exhaustion.

Only `TEST_DEFECT`, `FIXTURE_DEFECT`, selected generated-code `BUILD` failures,
and `ADAPTER_CONFIG` diagnoses may enter automatic repair. SUT defects,
contract drift, environment failures, flaky behavior, and unknown causes
require evidence or human review rather than weakened tests.
