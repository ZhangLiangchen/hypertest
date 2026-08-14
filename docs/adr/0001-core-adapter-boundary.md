# ADR-0001: Core and adapter boundary

- Status: Accepted
- Date: 2026-08-14

## Context

HyperTest must operate across materially different SUTs, languages, test frameworks, and delivery platforms while remaining understandable to one maintainer. Embedding the first Python, HTTP, pytest, or GitLab implementation in the core would turn later portability into a rewrite.

## Decision

The core owns deterministic orchestration, versioned intermediate representations, evidence provenance, diagnosis, repair policy, and protected-action enforcement. Ecosystem-specific behavior runs behind process/artifact adapters. Large values cross seams as hashed `ArtifactRef` objects.

CI and SCM are separate adapters even when one vendor provides both. Coverage reports preserve native capabilities and granularity instead of being coerced into a false common percentage.

## Consequences

- Adding Go/go test/CLI requires zero common-core changes.
- Adapters have explicit timeout, retry, domain-failure, and transport-failure semantics.
- A small amount of upfront contract work buys local upstream replacement and measurable portability.
