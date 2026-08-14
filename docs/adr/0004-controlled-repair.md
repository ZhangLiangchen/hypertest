# ADR-0004: Controlled repair instead of test weakening

- Status: Accepted
- Date: 2026-08-14

## Context

An autonomous repair loop can make a pipeline green by deleting assertions, adding skips, swallowing exceptions, or accepting defective SUT behavior. That is worse than leaving a test failed.

## Decision

Classify the failure before repair. Only explicitly safe categories enter a maximum two-round loop. Validate every repair patch against path policies, changed-file/line budgets, forbidden skip/ignore patterns, exception swallowing, and assertion deletion before requesting a BUGate apply receipt.

SUT defects, contract drift, environment failures, flaky behavior, and unknown causes stop with evidence or `needs_human`.

## Consequences

Repair success is subordinate to oracle integrity. A green run without a valid evidence chain and gate receipt is not an accepted HyperTest result.
