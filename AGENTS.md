# HyperTest agent instructions

## Product boundary

HyperTest is a general-purpose test-development agent. The core must not assume a specific SUT, language, test framework, coverage format, CI platform, SCM platform, or domain.

## Non-negotiable constraints

- Fork count remains zero.
- `@earendil-works/pi-agent-core` is the only SDK-level agent runtime dependency.
- Only `src/runtime/pi/**` may import the pi SDK.
- All SUT, test-framework, code-intelligence, coverage, sandbox, CI, SCM, and knowledge integrations use process/artifact contracts.
- Models propose actions; deterministic code and BUGate authorize them.
- BUGate denial or unavailability must block workspace mutation and change publication.
- Generated changes are patches applied in an isolated workspace before publication.
- Domain failures are successful adapter calls with a failed outcome; they are not adapter transport errors.

## Change discipline

Every production change must include tests for its failure semantics. New adapters must not require changes under the core state machine or common schemas. Avoid dynamic plugin discovery; use explicit manifests and executable paths.
