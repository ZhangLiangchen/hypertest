# HyperTest agent instructions

## Product boundary

HyperTest is a general-purpose test-development agent. The core must not assume a specific SUT, language, test framework, code-intelligence server, coverage format, CI platform, SCM platform, or domain.

## Non-negotiable constraints

- Fork count remains zero.
- `@earendil-works/pi-agent-core` is the only SDK-level agent-runtime dependency.
- Only `src/runtime/pi/**` may import the pi SDK.
- SUT, test-framework, code-intelligence, coverage, sandbox, CI, SCM, and knowledge integrations use process/artifact contracts.
- Models propose actions; HyperTest deterministic code owns capabilities, budgets, repair safety, and publication policy.
- In the current v0.2 compatibility path, BUGate denial, invalid receipts, or unavailability still block governed workspace mutation and change publication. Preserve these checks until a tested migration implements ADR-0006; BUGate 2.0 assessment is not tool authorization.
- Generated changes are patches executed in an isolated workspace before publication.
- Domain failures are successful adapter calls with failed outcomes; they are not adapter transport errors.
- Unknown coverage or LSP capability remains unknown and must not be represented as zero or complete.
- CI and SCM remain separate adapters.

## Repair safety

Never make a failing test green by adding skip/xfail/ignore, deleting or weakening an oracle, swallowing an exception, or accepting defective SUT behavior. Automatic repair is limited to explicitly safe categories, profile-approved paths, and two rounds before human review.

## Change discipline

Before architecture, agent-runtime, or BUGate integration changes, read
[ADR-0007](docs/adr/0007-pi-first-test-agent.md),
[the Pi-based development guide](docs/pi-agent-development-guide.zh-CN.md), and
[ADR-0006](docs/adr/0006-bugate-protocol-binding.md).
Build HyperTest by extending Pi through supported APIs; keep upstream fork count
at zero. Evaluate full SDK reuse before rebuilding generic harness features, but
do not switch the approved SDK or loosen import/tool boundaries without a
follow-up decision and compatibility evidence.

LangGraph and a separate WorkflowRuntime are conditional options, not required
next steps. The former HT-0–HT-5 sequence in the governance/runtime guide is
historical; the active next work is HT-P0 followed by HT-P1. Target capabilities
in these documents must not be described as already shipped.

Every production change must include failure-path tests. New adapters must not require changes to the deterministic state machine or common schemas. Avoid dynamic plugin discovery; use explicit manifests and executable paths. Run `npm run ci` and `npm run test:examples` before publication.
