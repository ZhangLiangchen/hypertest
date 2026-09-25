# Adapter authoring guide

Adapters are executable processes. They may be implemented in any language and communicate through request/response JSON files plus immutable artifact references.

## Required commands

```text
<adapter> describe --response <manifest.json>
<adapter> invoke --operation <name> --request <request.json> --response <response.json>
```

The built-in multiplexer exposes this contract through:

```bash
node dist/src/adapter-cli.js --adapter <name> describe --response manifest.json
node dist/src/adapter-cli.js --adapter <name> invoke \
  --operation <operation> --request request.json --response response.json
```

## Process semantics

| Exit | Meaning |
|---:|---|
| 0 | A valid response was written, including a domain-level test failure |
| 64 | Invalid request/schema |
| 69 | Unsupported operation/capability |
| 70 | Permanent adapter failure |
| 75 | Retry-safe transient failure |
| 124 | Hard timeout |
| 130 | Cancellation |

The response status repeats the semantic category. A retry is allowed only when `retry.safe` is true and the Core still has budget.

## Rules

- Large values cross the seam as `ArtifactRef`, not embedded text.
- Artifacts are verified by SHA-256 before use.
- Adapters do not mutate the host workspace. Generated code is returned as a patch and executed in a copied or OCI-mounted workspace.
- Capabilities must be explicit. `unsupported` and `partial` are normal results.
- CI and SCM remain separate even when one vendor provides both.
- An adapter must pass happy path, domain failure, unsupported, malformed request, transient/permanent failure, timeout, cancellation, idempotency, and hash-mismatch conformance tests.
