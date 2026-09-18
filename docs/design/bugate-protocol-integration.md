# BUGate Protocol integration in HyperTest

> Target design. HyperTest does not yet implement this end to end.
>
> Normative architectural decision: [ADR-0006](../adr/0006-bugate-protocol-binding.md).

## Purpose

HyperTest is the execution system that consumes BUGate's executable testing
methodology. BUGate tells an autonomous test-development agent what good work
looks like; HyperTest makes that methodology durable across planners, workers,
subagents, retries, context compaction, and workflow resume.

The fundamental rule is:

```text
Protocol must not live only in agent memory.
Protocol lives in HyperTest runtime state.
```

## Integration lifecycle

```text
TaskSpec
  |
  +-- ProtocolBinding (BUGate version/profile/digest)
  |
  v
WorkPackage
  |
  +-- inherited ProtocolBinding
  |
  v
Protocol Context Compiler
  |
  +-- active MethodSpec
  +-- Artifact contract
  +-- Evidence contract
  +-- profile extensions
  +-- previous Assessment findings
  |
  v
Protocol Context Capsule
  |
  v
Pi Agent / model
  |
  +-- Artifact
  +-- Evidence
  +-- Claim
  |
  v
BUGate Assessment
  |
  v
AssessmentResult
  |
  v
HyperTest runtime policy
  |
  +-- continue
  +-- rework
  +-- retry
  +-- escalate
  +-- stop
```

## ProtocolBinding

A future HyperTest task should carry a binding similar to:

```ts
type ProtocolBinding = {
  bindingId: string;

  protocol: {
    id: "bugate";
    version: string;
    digest: string;
  };

  profile?: {
    id: string;
    version: string;
    digest: string;
  };

  methods: string[];
};
```

The binding should appear in:

- TaskSpec;
- WorkPackage;
- AgentRun;
- checkpoint metadata;
- final run manifest.

A binding is immutable for the lifetime of a run.

## Protocol Context Capsule

The model should not receive the complete BUGate repository.

HyperTest compiles a short context capsule for the current work:

```text
BUGate Protocol: 2.0.0
Binding: PB-001
Active Method: testability

Objective:
For every business proposition, define a sufficient verification strategy.

Must account for:
- proposition coverage
- oracle binding
- evidence strategy
- test-layer choice
- environment/resource constraints
- side effects

Required output:
bugate.testability/v2

Profile extensions:
- consensus_safety
- consensus_liveness
- epoch_transition

Open assessment findings:
- P-018 lacks runtime evidence
```

The capsule is regenerated rather than remembered.

## Hydration points

Protocol hydration is required whenever a model may otherwise have lost or
never received the methodology:

| Event | Required behavior |
|---|---|
| Agent created | resolve and inject current capsule |
| WorkPackage assigned | select active MethodSpec and rehydrate |
| Subagent spawned | inherit binding and hydrate independently |
| Context compacted | inject a new capsule after compaction |
| Checkpoint resumed | resolve exact pinned bundle and hydrate |
| Model switched | hydrate the new model independently |
| Assessment returns findings | include relevant unresolved findings in next capsule |

## Failure semantics

HyperTest should fail explicitly when:

- bound protocol version is unavailable;
- bundle digest does not match;
- profile digest does not match;
- active MethodSpec does not exist;
- a required child WorkPackage loses its binding;
- BUGate returns an invalid AssessmentResult.

HyperTest must never silently replace a pinned protocol with the newest version.

## Assessment loop

BUGate does not retry the Agent.

The loop belongs to HyperTest:

```text
Agent works
   |
   v
Agent self-checks against capsule
   |
   v
Claim
   |
   v
BUGate independent assessment
   |
   +-- satisfactory ------> HyperTest continues
   |
   +-- findings ----------> HyperTest decides rework/escalation
```

A useful implementation pattern is a cheap inner loop and independent outer
loop:

1. **inner loop:** Agent self-conformance before submitting a Claim;
2. **outer loop:** BUGate Assessment over immutable Artifact/Evidence refs.

## Initial implementation order

Do not implement this until BUGate 2.0 publishes stable schemas.

When ready:

1. add ProtocolBinding schema to HyperTest;
2. add protocol registry/resolver abstraction;
3. add BUGate Protocol Context Compiler adapter;
4. extend Pi invocation with context hydration;
5. make WorkPackage/subagent binding inheritance mandatory;
6. persist binding references in checkpoints;
7. add Claim submission and AssessmentResult parsing;
8. add context-compaction and resume conformance tests;
9. only then add workflow routing based on AssessmentResult.

## Conformance tests

The eventual integration must prove:

- a 50+ turn run never loses the active MethodSpec;
- context compaction rehydrates the same binding;
- a new subagent receives the binding without relying on parent prose;
- switching models preserves the exact method/profile;
- checkpoint/resume preserves the exact protocol digest;
- a protocol upgrade does not mutate an in-flight run;
- a missing bound version fails instead of falling forward;
- BUGate findings can trigger rework without BUGate itself scheduling it.
