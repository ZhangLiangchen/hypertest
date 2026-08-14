# Contributing to HyperTest

## Prerequisites

- Node.js 22.19.0 or newer
- npm 10 or newer
- Python 3 with pytest and coverage for the Python conformance scenario
- Go 1.23 or newer for the Go conformance scenario

## Local verification

```bash
npm install
npm run ci
npm run test:examples
```

## Pull-request rules

- Keep changes focused and include failure-path tests.
- Do not add a second embedded agent SDK.
- Do not put language, framework, CI, SCM, or SUT-specific types in the common core.
- New adapter capabilities require explicit contracts and conformance fixtures.
- Changes that mutate a governed workspace or publish a change must preserve BUGate fail-closed enforcement.
- Keep native coverage granularity and LSP completeness explicit.
- Do not combine unrelated upstream upgrades in one pull request.

## Adapter acceptance

A new adapter must document its operations, capabilities, timeout ownership, retry safety, domain-failure semantics, and external dependencies. It must pass the process protocol tests described in `docs/adapter-authoring.md` and demonstrate that no central language/framework switch was added.
