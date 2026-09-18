# ADR-0007: Build HyperTest on Pi; adopt workflow orchestration only when justified

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR-0005's mandatory separate workflow runtime, preferred LangGraph implementation, and workflow-first delivery sequence
- Preserves: ADR-0006's BUGate Protocol boundary; ADR-0002's current Pi dependency/import boundary; zero upstream forks; portability and repair constraints
- Implementation guide: [Pi-based test-agent development guide](../pi-agent-development-guide.zh-CN.md)

## Context

HyperTest is a professional test-development agent built on a general-purpose
agent foundation. Its product value is understanding test tasks, producing
meaningful tests and evidence, diagnosing failures, and completing bounded,
verifiable work across different engineering environments.

Pi can supply the agent loop without LangGraph. A complete Pi agent can also be
called from a workflow node: its internal implementation does not determine
whether an external runtime can coordinate it. Technical composability alone,
however, does not establish a need for another runtime.

ADR-0005 made extracting WorkflowRuntime and introducing LangGraph prerequisites
for expanding autonomy. That sequence was premature. It risks managing the same
agent turns, messages, retries, and progress in two competing systems before a
test-development use case has demonstrated the need.

The inspected baseline is commit
[`ff340add`](https://github.com/ZhangLiangchen/hypertest/commit/ff340add47b8f96377431823a305a021fa0851ac).
It uses `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.84.1.
It does not depend on the full Pi Coding Agent SDK or LangGraph. Its current
model tool loop is a bounded, read-only planner; the orchestrator also requests
constrained repair-patch proposals without model tools. Diagnosis and acceptance
remain deterministic. This pipeline provides a useful executable baseline;
neither full-agent autonomy nor durable workflow recovery is implied here.

## Decision

### 1. Develop a test agent by extending Pi

Use Pi as the single embedded agent foundation. HyperTest supplies test-domain
tools, task context, evidence/artifact handling, and deterministic product rules.
The model may select strategies and tools within those rules; it cannot change
budgets, grant itself capabilities, or declare unverified success.

Prefer supported SDK and extension interfaces. Do not fork upstream Pi, copy
its generic agent loop, or hard-code BUGate into Pi. HyperTest remains a
standalone product with its own CLI, adapters, contracts, and artifacts.

### 2. Decide how much of Pi to reuse before rebuilding its surrounding features

Evaluate the full Pi Coding Agent SDK against the existing agent-core adapter
for scoped tools, session lifecycle, context compaction, event/usage reporting,
cancellation, isolated workspaces, and versioned resume behavior.

The preference is to reuse suitable upstream capabilities. This is not approval
to switch dependencies immediately. ADR-0002 and the current boundary checks
remain binding: only `src/runtime/pi/**` imports Pi, and `pi-agent-core` remains
the approved agent SDK until a follow-up decision records the evaluated choice.
Any SDK change must include compatibility, security, migration, and rollback
evidence. Never import the full SDK merely to inherit unrestricted default tools.

One task has one agent-loop/session owner. If the full SDK is selected later,
HyperTest delegates the loop to it instead of running another core loop around
the same session. An SDK evaluation must compare the versions actually tested;
the latest upstream documentation is not proof that the pinned version provides
every described feature.

### 3. Keep product and methodology responsibilities explicit

| Responsibility | Owner |
|---|---|
| Model interaction, agent-loop mechanics, tool dispatch and supported session facilities | Pi through the HyperTest `AgentRuntime` adapter |
| Task/run identity, workspaces, capabilities, budgets, repair limits and external effects | HyperTest |
| Test-domain tools and SUT/framework/CI/SCM integration | HyperTest process/artifact adapters |
| Testing methodology and Artifact/Evidence/Claim assessment semantics | Stateless BUGate 2.0 Protocol |
| ProtocolBinding, context hydration, assessment submission and subsequent action | HyperTest, per ADR-0006 |
| Optional durable coordination across work packages | A separately justified runtime; no selected implementation in this ADR |

Pi conversation state, HyperTest run state, protocol bindings, and immutable
artifacts have different purposes. A transcript is not an evidence ledger, an
assessment is not a tool permission, and a checkpoint is not proof that an
external effect completed. Retrieved memory is supporting context; it does not
replace a pinned protocol, source revision, or execution evidence.

### 4. Make LangGraph conditional

Do not install LangGraph, create a generic WorkflowRuntime, or translate the
existing pipeline into graph nodes as a prerequisite for the next test-agent
slice. A small amount of explicit application control remains necessary; it
does not require a separate orchestration framework.

Reconsider a workflow runtime when a demonstrated requirement, such as durable
external-event waits, independently recoverable parallel work packages, or
cross-process recovery, exceeds the selected Pi integration and simple host
lifecycle. A follow-up ADR must record the failing scenario, alternatives,
maintenance cost, state ownership, and a recovery proof of concept before
choosing LangGraph or another implementation.

If adopted, the runtime coordinates meaningful task/effect boundaries. It does
not reproduce Pi's reasoning loop or turn every BUGate method into a graph node.
Keep the earlier thin-graph/fat-agent principle as a conditional integration
constraint, not a requirement to create a graph.

### 5. Retain recovery and safety requirements without promising unbuilt features

Session persistence does not automatically recover external commands, tests
that modify a SUT, or SCM publication. Wrapping a Pi call in a graph node would
not automatically make each internal tool call independently recoverable either.

Any implemented resume path must retain task/session identity, exact source and
protocol bindings, artifact references, consumed budgets and repair attempts.
Record stable effect identity and intent/outcome around actions that need safe
recovery. An unknown external outcome requires reconciliation or human review,
not blind replay. Declare whether recovery means continuing a session,
restarting a phase, or resuming an operation; unsupported recovery must fail
explicitly. Do not build a general distributed workflow engine to defer choosing
an existing one.

Keep the current orchestrator as a compatibility baseline. Extract domain
capabilities incrementally as agent use cases require; do not delete the state
machine, validators, adapters, or safe-repair rules merely to increase autonomy.
The v0.2 fail-closed BUGate gate path remains enforced until a separately tested
migration implements the ADR-0006 protocol contract and HyperTest-owned policy.

## Delivery order

1. Inventory existing Pi/core responsibilities and evaluate SDK reuse with a
   bounded task; document the package decision before changing dependencies.
2. Deliver one test-task loop through existing adapters and scoped capabilities,
   preserving deterministic validation and the cross-language baseline.
3. Implement BUGate 2.0 binding/hydration/assessment when its stable published
   contract is available. Preserve the seam meanwhile; do not invent a private
   protocol or bypass existing gates.
4. Verify the recovery granularity actually needed by the task, including
   failure paths, budget continuity, and uncertain external outcomes.
5. Evaluate separate orchestration only when those results establish a need.

Detailed work packages and acceptance criteria are in the development guide.
The former HT-0–HT-5 sequence is historical and is not the next-work backlog.

## Consequences

- Pi reuse and test-task quality become the next development priorities.
- LangGraph remains technically compatible but is no longer a selected or
  mandatory next dependency.
- HyperTest still owns deterministic task policy and external effects; greater
  autonomy does not mean unrestricted tools or model-issued permissions.
- BUGate stays independent of the harness and runtime.
- A smaller initial stack leaves recovery limitations explicit instead of
  claiming durable execution from session files or framework installation.

## References

- [Pi package boundaries](https://github.com/earendil-works/pi)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [LangGraph overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [ADR-0002](0002-single-agent-sdk.md) and [ADR-0006](0006-bugate-protocol-binding.md)

Official documentation was reviewed on 2026-09-18; the HyperTest package/lockfile
and follow-up evaluation evidence determine supported versions.
