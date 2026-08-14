# ADR-0002: One SDK-level agent runtime

- Status: Accepted
- Date: 2026-08-14

## Context

Codex, OpenCode, pi, OpenHands, MetaGPT, and Hermes overlap at multiple agent-runtime and orchestration layers. Combining them would exceed the single-maintainer integration budget and create competing state, tool, memory, and policy authorities.

## Decision

Use `@earendil-works/pi-agent-core` as the sole SDK-level runtime dependency. Hide it behind the HyperTest-owned `AgentRuntime` interface, and confine imports to `src/runtime/pi/**`.

Codex and OpenCode remain possible future process-level replacements. OpenHands may later implement a sandbox provider, but not a second embedded agent SDK. MetaGPT and Hermes do not enter the steady-state topology.

## Consequences

A pi breaking change affects one provider directory. The core, BUGate bridge, adapter contracts, and artifacts remain stable. The fake runtime keeps core tests independent from model providers.
