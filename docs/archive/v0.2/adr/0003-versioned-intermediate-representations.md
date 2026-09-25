# ADR-0003: Versioned intermediate representations

- Status: Accepted
- Date: 2026-08-14

## Context

Directly generating pytest or Go source from an OpenAPI document would couple analysis, SUT shape, test framework, and execution output. It would also make failure evidence difficult to replay.

## Decision

Use explicit versioned artifacts for SUT contracts, test plans, patches, test runs, coverage maps, diagnoses, gate receipts, and run summaries. Native formats remain at adapter edges and are preserved as evidence.

Every artifact is immutable, content-hashed, source-revision aware, and independently serializable. Unknown capabilities remain unknown rather than being represented as zero.

## Consequences

Runs are replayable and auditable. Framework rendering and platform publication can change without invalidating the planning and diagnosis contracts. Schema-breaking changes require a new version and migration fixtures.
