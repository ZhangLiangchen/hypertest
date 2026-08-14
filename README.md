# HyperTest

HyperTest is a general-purpose, cross-language AI test development agent governed by [BUGate](https://github.com/ZhangLiangchen/BUGate).

It targets three capabilities, in priority order:

1. test analysis and executable test-case generation;
2. evidence-based failure diagnosis and controlled self-repair;
3. white-box-oriented exploratory testing using source code, interface contracts, and coverage data.

HyperTest is deliberately independent of any single system under test, programming language, test framework, CI platform, SCM platform, or domain. Those concerns enter through versioned process/artifact adapters; the core owns only deterministic workflow, shared intermediate representations, diagnosis/repair policy, and BUGate enforcement.

## Status

Pre-alpha. The initialization baseline contains contracts, a deterministic run state machine, an atomic file artifact store, a fake model runtime, architecture decisions, and CI boundary checks.

## Architecture

```text
BUGate             = quality policy and enforcement authority
HyperTest Core     = execution state and product-semantics authority
pi-agent-core      = the only SDK-level agent loop
OCI/LSP/runners/CI = replaceable process-level capability providers
Adapters/artifacts = portability boundary
```

See [`docs/architecture.md`](docs/architecture.md) and [`docs/adr/`](docs/adr/) for the accepted baseline.

## Development

Requirements: Node.js 22.19.0 or newer.

```bash
npm install
npm run ci
```

## First conformance targets

| Scenario | SUT | Language | Test framework |
|---|---|---|---|
| A | HTTP API service | Python | pytest |
| B | CLI tool | Go | go test |

The second scenario is considered successful only if it requires zero changes to the common core and common schemas.
