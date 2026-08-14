# HyperTest

[![CI](https://github.com/ZhangLiangchen/hypertest/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhangLiangchen/hypertest/actions/workflows/ci.yml)

HyperTest is a general-purpose, cross-language AI test-development agent governed by [BUGate](https://github.com/ZhangLiangchen/BUGate). It keeps the system under test, programming language, test framework, code-intelligence tool, coverage format, CI provider, and SCM provider behind explicit process/artifact contracts.

## Goals

1. Generate framework-neutral test analysis and executable test cases.
2. Diagnose failed tests from structured evidence and perform only policy-approved repairs.
3. Drive white-box exploratory testing from source symbols, interface contracts, and capability-aware coverage.

## Architecture

```text
BUGate PDP/PEP    quality policy and protected-action authority
HyperTest Core    deterministic run state, budgets, artifacts, diagnosis and repair policy
pi-agent-core     only SDK-level agent-loop dependency
Adapters          replaceable process-level SUT, test, LSP, coverage, sandbox, CI and SCM providers
Artifacts         versioned, hashed portability and audit boundary
```

![HyperTest architecture](docs/assets/architecture.svg)

The complete design and implementation baseline is in [docs/implementation-plan.md](docs/implementation-plan.md). The concise component model is in [docs/architecture.md](docs/architecture.md).

## Current executable slice

The repository contains a complete v0.1 vertical slice:

- deterministic workflow from contract import through test planning, gate decisions, rendering, isolated execution, diagnosis, repair safety checks, verification, and optional draft-change publication;
- a `pi-agent-core` runtime provider hidden behind a HyperTest-owned interface, plus fake/scripted runtimes for deterministic tests;
- OpenAPI/HTTP and command/CLI SUT adapters;
- pytest/JUnit and `go test -json` framework adapters;
- coverage.py JSON, LCOV, Cobertura and Go coverprofile normalization;
- LSP JSON-RPC client, local and OCI sandbox providers;
- GitLab CI and GitLab draft-MR adapters without vendor SDKs;
- BUGate-compatible fail-closed process gate with evidence-bound receipts;
- two materially different conformance scenarios.

## Quick start

Requirements: Node.js 22.19+, Python 3 with pytest/coverage for the Python example, and Go 1.23+ for the Go example.

```bash
npm install
npm run ci
npm run test:examples
```

Run one scenario directly:

```bash
npm run build
node dist/src/cli.js run \
  --profile profiles/python-http-pytest.example.json \
  --workspace . \
  --mode execute
```

Switching to Go/CLI changes only the profile and adapter-owned fixtures:

```bash
node dist/src/cli.js run \
  --profile profiles/go-cli-go-test.example.json \
  --workspace . \
  --mode execute
```

## Portability invariant

A new language, framework, SUT shape, CI provider, or SCM provider must not require changes to the deterministic core or common schemas. The permanent conformance pair is:

| Scenario | SUT | Language | Framework | Interface |
|---|---|---|---|---|
| A | HTTP API service | Python | pytest | OpenAPI/HTTP |
| B | CLI tool | Go | go test | command contract/stdout/exit code |

CI enforces that ecosystem-specific terms and the pi SDK do not leak across the accepted boundaries.

## External activation

Live deployment requires operator-supplied infrastructure: a model endpoint and credentials, an installed BUGate process bridge and governed profile, GitLab project/token settings, and a Docker/Podman-compatible engine with digest-pinned test images. No secrets are stored in this repository, and static-allow gates are restricted to development and conformance.

## Project status

`0.1.0` is an engineering-complete reference implementation and integration baseline. All deterministic behavior, contracts, schemas, safety policy, coverage normalization, and the two permanent cross-language scenarios are exercised in CI; external provider operations become live when their endpoint, executable, credentials, and image configuration are supplied.
