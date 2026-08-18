# HyperTest operations

## Development verification

```bash
npm ci
npm run ci
npm run test:examples
```

`npm run test:examples` executes both permanent portability scenarios in
isolated temporary workspaces. A scenario is accepted only when the final state
is `verified` and the persisted summary agrees.

The default test suite also runs a local loopback OpenAI-compatible HTTP/SSE
server. It uses no credential, public Provider, or paid model. The optional
`npm run test:model:live` command is outside default CI and skips without all
required variables; see [model-runtime.md](model-runtime.md).

## Artifact layout

```text
.testagent/runs/<run-id>/
  events.ndjson
  artifacts/
    raw-sut-contract.*
    sut-contract.json
    test-plan.json
    model-usage.json
    generated.patch
    validation-report.json
    test-run.json
    coverage-map.json
    diagnosis-*.json
    gate-*.json
    run-ledger.json
    run-summary.json
```

Every artifact carries a schema, media type, SHA-256, and optional source
revision. Writes use a temporary file plus an atomic hard-link publication and
do not overwrite an existing path.

`model-usage.json` stores per-call and aggregate Provider/model identity,
endpoint fingerprint, request ID, input/output/cached tokens when available,
latency, retry count, stop reason, and `usageUnavailable`. It never stores an
API key, Authorization header, complete Provider request, endpoint URL, or
complete model response.

## Protected actions

A production profile should use `gate.mode: process`. HyperTest sends
`hypertest.gate-request/v1` as JSON on stdin and requires
`hypertest.gate-decision/v1` on stdout. A valid allow receipt must bind the
exact canonical request and every current evidence hash.

Static gates exist only for deterministic development and conformance.
`static-allow` must not be used as a production quality authority. The model
runtime has no BUGate tool and cannot decide or bypass a verdict.

## Credentials

Model credentials are supplied only through `HYPERTEST_MODEL_API_KEY`. The
profile can contain the Provider selector, exact model ID, base URL, timeout,
retry limit, and output-token cap, but it rejects an embedded API key.

GitLab adapters read credentials from profile process environment or standard
CI variables. Secrets are never persisted in artifacts. OCI execution should
use digest-pinned images, a non-root user, bounded CPU/memory/PIDs, disabled
networking by default, and a read-only root filesystem.
