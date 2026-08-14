# HyperTest

HyperTest is a general-purpose, cross-language AI test development agent governed by [BUGate](https://github.com/ZhangLiangchen/BUGate).

The project targets three capabilities, in priority order:

1. test analysis and executable test-case generation;
2. evidence-based failure diagnosis and controlled self-repair;
3. white-box-oriented exploratory testing using source code, interface contracts, and coverage data.

HyperTest is deliberately independent of any single system under test, programming language, test framework, CI platform, or domain. Those concerns enter through versioned process/artifact adapters; the core owns only deterministic workflow, shared intermediate representations, diagnosis/repair policy, and BUGate enforcement.

## Status

Pre-alpha. Repository initialization is in progress.

## Architectural baseline

- **Quality authority:** BUGate PDP/PEP and Wave governance
- **Execution semantics:** a small deterministic HyperTest core
- **Agent runtime:** `pi-agent-core` as the only SDK-level upstream dependency
- **Isolation:** replaceable OCI sandbox providers
- **Code intelligence:** LSP first, optional batch indexes later
- **Coverage:** native collectors normalized to a capability-aware region model
- **Integrations:** SUT, test framework, CI, SCM, and knowledge adapters

See the initialization pull request and `docs/` for the implementation baseline.
