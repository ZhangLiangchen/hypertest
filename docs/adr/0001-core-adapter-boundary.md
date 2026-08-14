# ADR-0001: Core and adapter boundary

- Status: Accepted
- Date: 2026-08-14

## Context

HyperTest must operate across materially different SUTs, languages, test frameworks, and delivery platforms while being maintained by one person. Embedding the first Python, HTTP, pytest, or GitLab implementation in the core would make later portability a rewrite rather than an adapter addition.

## Decision

The core owns only deterministic orchestration and versioned intermediate representations. Ecosystem-specific behavior runs behind process/artifact adapters. Large values cross seams as hashed `ArtifactRef` objects.

CI and SCM are separate adapters even when one vendor provides both. Coverage reports preserve their native capability and granularity rather than being coerced into a false common percentage.

## Consequences

- Adding Go/go test/CLI must require zero common-core changes.
- Adapters have explicit timeout, retry, domain-failure, and transport-failure semantics.
- Some integrations require more initial contract work, but upstream replacement remains local.
