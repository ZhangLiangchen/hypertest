# HyperTest operations

## Development verification

```bash
npm install
npm run check
npm test
npm run test:examples
```

`npm run test:examples` executes both permanent portability scenarios in isolated temporary workspaces. A scenario is accepted only when the final state is `verified` and the persisted summary agrees.

## Artifact layout

```text
.testagent/runs/<run-id>/
  events.ndjson
  artifacts/
    raw-sut-contract.*
    sut-contract.json
    test-plan.json
    generated.patch
    validation-report.json
    test-run.json
    coverage-map.json
    diagnosis-*.json
    gate-*.json
    run-ledger.json
    run-summary.json
```

Every artifact carries a schema, media type, SHA-256, and optional source revision. Writes use a temporary file plus an atomic hard-link publication and do not overwrite an existing path.

## Protected actions

A production profile should use `gate.mode: process`. HyperTest sends `hypertest.gate-request/v1` as JSON on stdin and requires `hypertest.gate-decision/v1` on stdout. A valid allow receipt must bind the exact canonical request and every current evidence hash.

Static gates exist only for deterministic development and conformance. `static-allow` must not be used as a production quality authority.

## Credentials

GitLab adapters read credentials from profile process environment or standard CI variables. Secrets are never persisted in artifacts. OCI execution should use digest-pinned images, a non-root user, bounded CPU/memory/PIDs, disabled networking by default, and a read-only root filesystem.
