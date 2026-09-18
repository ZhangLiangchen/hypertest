# ADR-0006: BUGate Protocol binding and runtime consumption

- Status: Accepted
- Date: 2026-09-18
- Supersedes: the BUGate authorization/PDP/PEP portions of [ADR-0005](0005-durable-workflow-runtime-and-bugate-boundary.md)
- Preserves from ADR-0005: runtime replaceability when a separate runtime is used, thin-graph/fat-agent as a conditional integration constraint, and the separation between agent reasoning and durable execution
- Runtime selection clarification: [ADR-0007](0007-pi-first-test-agent.md) makes a separate workflow runtime optional and prioritizes Pi-based test-agent development; the ProtocolBinding contract below is unchanged
- Companion: [BUGate 2.0 Protocol Guide](https://github.com/ZhangLiangchen/BUGate/blob/main/docs/qa-methodology/BUGATE_2_0_PROTOCOL_GUIDE.zh-CN.md)

## Context

BUGate 2.0 is no longer defined as a workflow engine, authorization kernel, or
tool-enforcement layer. Its target role is a SUT/model/harness/runtime-neutral
**executable testing methodology protocol**.

HyperTest is the autonomous test-development system that consumes that
protocol. This means HyperTest must not depend on an agent remembering a large
BUGate prompt or skill across a long conversation. Protocol adherence must be
bound to the run as external runtime state and rehydrated into every relevant
agent invocation.

HyperTest is not yet mature enough to implement this integration completely.
This ADR therefore defines the target contract and preserves it as an
architectural requirement for later implementation.

## Decision

HyperTest introduces **ProtocolBinding** as a first-class run/work-package
contract.

A ProtocolBinding pins:

- protocol id and exact version;
- immutable protocol bundle digest;
- SUT profile id/version/digest when present;
- active or allowed BUGate methods;
- a stable binding id.

Example:

```json
{
  "bindingId": "PB-001",
  "protocol": {
    "id": "bugate",
    "version": "2.0.0",
    "sha256": "..."
  },
  "profile": {
    "id": "hyperchain",
    "version": "1.0.0",
    "sha256": "..."
  },
  "methods": [
    "business_understanding",
    "testability",
    "test_design"
  ]
}
```

The binding belongs to HyperTest runtime state. BUGate publishes protocol
bundles and assessment semantics; BUGate does not manage HyperTest sessions,
workers, retries, checkpoints, or process identity.

## Context hydration

HyperTest must never rely on the conversation transcript as the durable home of
BUGate semantics.

Before every relevant agent invocation, HyperTest resolves the pinned
ProtocolBinding, verifies its exact digest, selects the active MethodSpec plus
profile extensions, compiles an agent-facing **Protocol Context Capsule**, and
injects that capsule into the model context.

Hydration is mandatory at:

1. agent creation;
2. WorkPackage assignment;
3. subagent spawn;
4. context compaction/summary recovery;
5. checkpoint resume;
6. model or worker switch.

A child WorkPackage inherits the parent ProtocolBinding unless the task
explicitly declares another compatible binding.

The capsule should be compact and task-scoped. It normally contains:

- protocol id/version/binding id;
- active MethodSpec objective;
- quality dimensions that must be considered;
- required Artifact and Evidence contracts;
- relevant SUT profile extensions;
- unresolved findings from the previous BUGate Assessment.

The complete protocol bundle is not copied into every prompt.

## Agent-output contract

HyperTest agents consume the Protocol Context Capsule and produce:

```text
Artifact + Evidence + Claim
```

HyperTest then submits the Claim to BUGate for assessment:

```text
Artifact + Evidence + Claim
        |
        v
BUGate Assessment
        |
        v
AssessmentResult
```

BUGate stops at AssessmentResult.

HyperTest decides what happens next:

```text
continue | rework | retry | escalate | stop
```

This preserves the boundary:

```text
BUGate defines GOOD.
HyperTest binds GOOD to the task.
Agent decides HOW.
Runtime keeps GOOD in context.
BUGate assesses the result.
```

## No enforcement authority in BUGate

The BUGate 2.0 interaction is not:

```text
BUGate allow/deny -> tool permission
```

It is:

```text
BUGate AssessmentResult -> HyperTest policy/runtime decision
```

Whether an incomplete assessment prevents implementation, schedules rework, or
requests human review belongs to HyperTest.

Protected side-effect capabilities, if HyperTest chooses to implement them,
remain HyperTest/runtime responsibilities and must not be represented as BUGate
Protocol semantics.

## Checkpoint and resume

Workflow checkpoints persist the ProtocolBinding reference and digest, not a
mutable copy of the protocol text.

On resume:

```text
checkpoint
  -> ProtocolBinding
  -> resolve exact protocol/profile bundle
  -> verify digests
  -> compile fresh capsule
  -> resume agent
```

If the exact bound bundle is unavailable or the digest differs, the run fails
with a protocol-integrity error. It must not silently switch to a newer BUGate
version.

This gives existing runs package-lock-like reproducibility while allowing new
runs to opt into newer BUGate versions.

## Subagent inheritance

Planner, worker, and reviewer agents do not pass BUGate semantics to one another
through prose handoffs.

Every spawned agent receives the binding independently from HyperTest.

A WorkPackage without a resolvable ProtocolBinding is invalid when the parent
task is protocol-governed.

## Pi boundary

Pi remains a generic Agent Harness. BUGate is not hard-coded into Pi.

HyperTest owns a thin adapter around Pi that performs:

```text
resolve binding
-> compile/hydrate protocol capsule
-> invoke Pi agent
-> collect Artifact/Evidence/Claim
-> submit BUGate Assessment
```

This keeps Pi replaceable and BUGate runtime-neutral.

## LangGraph boundary

LangGraph, when used, stores only coarse durable workflow state and
ProtocolBinding references.

It does not encode BUGate Methods as reasoning nodes and does not store the
complete BUGate protocol in graph checkpoints.

A LangGraph node may route on AssessmentResult, but that routing is HyperTest
workflow policy rather than BUGate semantics.

## Current implementation status

This ADR is a target architecture, not a claim of current capability.

The current HyperTest codebase still reflects earlier BUGate gate/PDP
integration in several places. Those paths are transitional and should not be
expanded.

Implementation should wait until BUGate 2.0 publishes a stable machine-readable
Protocol Bundle, MethodSpec/Artifact/Evidence/Claim/Assessment schemas, and
version/digest conventions.

Until then HyperTest development should preserve the integration seam without
inventing a second private BUGate protocol.

## Consequences

- BUGate remains methodology-focused and runtime-neutral.
- HyperTest, not BUGate, owns protocol persistence across long-running work.
- Context compaction cannot erase the protocol because it is rehydrated from
  external run state.
- Planner/worker/reviewer model changes cannot drop the protocol because each
  invocation resolves the binding independently.
- Existing runs remain reproducible against an exact BUGate version.
- HyperTest may change workflow runtimes without changing BUGate semantics.
- BUGate assessment remains independent of the agent that produced the Claim.

## Rejected alternatives

- **Load BUGate once as a long system prompt.** Long-running context compaction
  can weaken or erase it.
- **Trust Skill auto-discovery on every agent.** Discovery is useful UX but not
  a durable runtime contract.
- **Embed the whole BUGate protocol in every checkpoint.** This creates a
  second mutable source of truth.
- **Hard-code BUGate into Pi.** This couples a generic Agent Harness to one test
  methodology.
- **Model every BUGate method as a LangGraph node.** That turns methodology back
  into workflow orchestration.
