# HyperTest agent instructions

## Product boundary

HyperTest is a general-purpose test-development agent. The core must not assume a specific SUT, language, test framework, code-intelligence server, coverage format, CI platform, SCM platform, or domain.

## Non-negotiable constraints

- Fork count remains zero.
- `@earendil-works/pi-agent-core` is the only SDK-level agent-runtime dependency.
- Only `src/runtime/pi/**` may import the pi SDK.
- SUT, test-framework, code-intelligence, coverage, sandbox, CI, SCM, and knowledge integrations use process/artifact contracts.
- Models propose actions; deterministic code and BUGate authorize them.
- BUGate denial, invalid receipts, or unavailability block governed workspace mutation and change publication.
- Generated changes are patches executed in an isolated workspace before publication.
- Domain failures are successful adapter calls with failed outcomes; they are not adapter transport errors.
- Unknown coverage or LSP capability remains unknown and must not be represented as zero or complete.
- CI and SCM remain separate adapters.

## Repair safety

Never make a failing test green by adding skip/xfail/ignore, deleting or weakening an oracle, swallowing an exception, or accepting defective SUT behavior. Automatic repair is limited to explicitly safe categories, profile-approved paths, and two rounds before human review.

## Change discipline

Every production change must include failure-path tests. New adapters must not require changes to the deterministic state machine or common schemas. Avoid dynamic plugin discovery; use explicit manifests and executable paths. Run `npm run ci` and `npm run test:examples` before publication.
