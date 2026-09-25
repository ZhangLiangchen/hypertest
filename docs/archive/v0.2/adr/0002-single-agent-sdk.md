# ADR-0002: One SDK-level agent runtime

- Status: Accepted
- Date: 2026-08-14

Follow-up: [ADR-0007](0007-pi-first-test-agent.md) requires an evaluation of Pi
capability reuse, including the full Coding Agent SDK. It does not yet replace
the package decision below. Any package switch requires a separate recorded
decision, boundary-check updates, and compatibility evidence; a second agent
loop must not be introduced around the same session.

## Context

Codex, OpenCode, pi, OpenHands, MetaGPT, and Hermes overlap across agent-runtime and orchestration layers. Combining them would exceed the single-maintainer integration budget and create competing state, tool, memory, and policy authorities.

## Decision

Use `@earendil-works/pi-agent-core` as the sole SDK-level agent runtime. Its
official `@earendil-works/pi-ai` LLM transport and nominal stream types may be
used inside the same boundary; they do not add another agent loop or policy
authority. Hide both behind HyperTest's `AgentRuntime` interface and confine
all Pi package imports to `src/runtime/pi/**`.

Codex and OpenCode remain possible future process-level replacements. OpenHands may later implement a sandbox provider, but not a second embedded agent SDK. MetaGPT and Hermes do not enter the steady-state topology.

## Consequences

A pi breaking change affects one provider directory. The core, BUGate bridge, adapter contracts, and artifacts remain stable. Fake and scripted runtimes keep core tests independent from model providers.
