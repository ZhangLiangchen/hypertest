# 设计符合度

[English](CONFORMANCE.md) | 简体中文

代码对设计来源的符合程度：[技术选型](../design/technology-selection.zh-CN.md)、[架构改进](../design/architecture-improvements.zh-CN.md) 以及[实施蓝图](BLUEPRINT.md)中的不变量。每条需求一行。状态描述的是**当前**的代码，即加固与第二轮完善工作（上下文引擎、治理、实验与预算、运行时发布与角色、评测平台与供应链、DSH 适配器）之后的代码；每一处状态变化都已对照 `src/` 与测试核实（类型检查、边界检查以及在 PGlite 和 PostgreSQL 上的完整测试套件）。H4、conformance-7 等编号指加固中的问题编号，可在各包 README 与测试中找到。

## 汇总

| 状态 | 含义 | 行数 | 第二轮之前 | 审计时 |
|---|---|---|---|---|
| 已实现 | 已按规格完成；备注列出已知限制 | 132 | 108 | 87 |
| 部分实现 | 可用，但部分需求尚未满足 | 29 | 48 | 67 |
| 缺失 | 未实现 | 1 | 5 | 7 |
| 延后 | 有意延后，或已实现但未在真实基础设施上验证 | 2 | 3 | 3 |
| **合计** | | **164** | 164 | 164 |

按领域：

| 领域 | 已实现 | 部分实现 | 缺失 | 延后 |
|---|---|---|---|---|
| [产品定义与原则](#产品定义与原则) | 3 | 0 | 0 | 0 |
| [Agent 运行时、引擎与子 Agent](#agent-运行时引擎与子-agent) | 8 | 1 | 0 | 0 |
| [多模型路由与模型切换](#多模型路由与模型切换) | 13 | 0 | 0 | 0 |
| [规划、调度与协作](#规划调度与协作) | 13 | 1 | 0 | 0 |
| [上下文引擎、新鲜度与学习](#上下文引擎新鲜度与学习) | 12 | 2 | 1 | 0 |
| [持久执行与恢复](#持久执行与恢复) | 7 | 0 | 0 | 0 |
| [证据](#证据) | 7 | 3 | 0 | 2 |
| [Oracle、实验、测试资产与 QualityGate](#oracle实验测试资产与-qualitygate) | 18 | 4 | 0 | 0 |
| [工具、沙箱与权限](#工具沙箱与权限) | 9 | 5 | 0 | 0 |
| [副作用、租约与预算](#副作用租约与预算) | 19 | 0 | 0 | 0 |
| [运行时清单与发布](#运行时清单与发布) | 7 | 0 | 0 | 0 |
| [评测平台与 PoC 验收](#评测平台与-poc-验收) | 15 | 10 | 0 | 0 |
| [审计、供应链与风险](#审计供应链与风险) | 1 | 3 | 0 | 0 |

## 加固后发生变化的状态

修复经核实后，有 21 行的状态发生变化：

| 需求 | 之前 | 现在 |
|---|---|---|
| Pass/Fail/Conditional 来自证据 + BUGate 规则 + 评审 + 未决风险，绝不来自 Lead 的判断 | 部分实现 | 已实现 |
| L0 事件存储：PostgreSQL 仅追加的不可变历史 | 部分实现 | 已实现 |
| 证据驱动验收：绝不根据 Agent 文本给出 Pass；只依据证据清单 + GateDecision | 部分实现 | 已实现 |
| P0 修订 4：Operation Ledger、fencing、reconcile、outcome_unknown 状态机 | 部分实现 | 已实现 |
| Agent 可以提议但绝不能批准会翻转已记录失败的 OracleRevision；需独立/人工批准 | 部分实现 | 已实现 |
| TestArtifact 契约与生命周期（生成 → 静态 → 已知正确通过 → 已知错误/变异失败 → oracle 评审 → 合格） | 部分实现 | 已实现 |
| 清单：每个 TestRun 固定到一个 RuntimeManifest | 部分实现 | 已实现 |
| 清单：环境代际进入快照 | 部分实现 | 已实现 |
| 清单：每个破坏性工具都有 operationId（100%） | 部分实现 | 已实现 |
| 清单：过期 worker 无法成功写入（0 次成功） | 部分实现 | 已实现 |
| 清单：OracleSpec 独立于 Agent 叙述 | 部分实现 | 已实现 |
| 清单：断言/阈值不能被自动放宽（100%） | 部分实现 | 已实现 |
| 清单：关键生成测试有敏感度检查 | 部分实现 | 已实现 |
| 清单：证据不足绝不产生 Pass | 部分实现 | 已实现 |
| 清单：子权限只会收缩（100%） | 部分实现 | 已实现 |
| 清单：沙箱出站有策略 | 部分实现 | 已实现 |
| 清单：关键 allow/deny 决定可重放（100%） | 部分实现 | 已实现 |
| BLUEPRINT I12：调度器强制执行并发/深度/Agent/token/成本/工具调用/墙钟预算，并保持收敛权 | 部分实现 | 已实现 |
| 本地持久运行时：崩溃安全、可恢复、负载下租约正确 | 部分实现 | 已实现 |
| 门禁准则配置在使用前经过校验 | 缺失 | 已实现 |
| 评测 harness 可取消（SuiteOptions signal） | 缺失 | 已实现 |

## 第二轮完善工作后发生变化的状态

有 25 行的状态发生变化。每一处变化都已对照代码与测试核实；当某个工作单元的自述超出代码实际时，该行保持较低状态，并在备注中说明缺少什么。

| 需求 | 之前 | 现在 |
|---|---|---|
| 子 Agent 运行时：spawn/resume/message/interrupt/collect、可续跑、后台、嵌套委派、深度/数量上限 | 部分实现 | 已实现 |
| P0 修订 1：自有 ABI + Runtime Adapter + 外科式 fork；DSH 作为首个适配器 | 延后 | 已实现 |
| 风险缓解：针对限流/价格变化的模型熔断器 | 缺失 | 已实现 |
| WorkItem 模式（capabilityRequirements、模型/工具策略、inputRefs、expectedOutput、evidenceRequirements、dependsOn、预算、优先级、状态） | 部分实现 | 已实现 |
| L2 工作上下文：基于事件视图的 HARD/SOFT 压缩；优先卸载到 artifact | 部分实现 | 已实现 |
| P0 修订 2：ContextSnapshot 作为一致性契约，包含 ReadSet、环境代际与新鲜度策略 | 部分实现 | 已实现 |
| FreshnessGuard 在副作用前复核构建摘要、环境代际、oracle 升级、已撤回的 finding、租约持有者与指标时间窗 | 部分实现 | 已实现 |
| 清单：变更类操作检查 ReadSet（100%） | 部分实现 | 已实现 |
| GateSpec/GateDecision（pass/fail/conditional/needs_review、违反的规则、评审决定、策略修订） | 部分实现 | 已实现 |
| BUGate 在四个时点生效：行动前、行动后、状态转换前、最终验收前 | 部分实现 | 已实现 |
| 清单：实验记录构建/环境/数据/负载/故障 | 部分实现 | 已实现 |
| ActionCapability；子能力 = 父 ∩ 角色 ∩ WorkItem ∩ 环境策略；绝不放大 | 部分实现 | 已实现 |
| ResourceClaim 模式（read_shared/write_exclusive/fault_exclusive）、层级键、实验前原子准入 | 部分实现 | 已实现 |
| BudgetEnvelope 作为租约：对 Agent、模型、工具、算力、QPS、artifact 字节执行 预留 → 执行 → 结算 | 部分实现 | 已实现 |
| 清单：每个写入/故障实验都声明 ResourceClaim（100%） | 部分实现 | 已实现 |
| 清单：Agent/模型/工具/算力统一的 BudgetEnvelope | 部分实现 | 已实现 |
| RuntimeManifest 物料清单（hypertest 版本 + gitSha、引擎、供应商适配器、模式、策略包、工具目录） | 部分实现 | 已实现 |
| 运行时发布状态 candidate → shadow → canary → active → retiring → retired | 缺失 | 已实现 |
| 运行时回滚：停止候选版本、切换 active 指针、旧运行继续、隔离候选运行、回放套件 | 部分实现 | 已实现 |
| 长时间运行的显式迁移（检查点 → 对账 → 兼容性 → 新 RuntimeEpoch） | 缺失 | 已实现 |
| 清单：上游升级需要兼容性套件 | 部分实现 | 已实现 |
| 清单：运行时回滚不迁移旧运行 | 部分实现 | 已实现 |
| 结果评分器优先；独立 LLM 评审器最后使用，带 unknown 路径与人工校准 | 部分实现 | 已实现 |
| 评测套件/评分器版本化；评分器变更时使用桥接数据集 | 部分实现 | 已实现 |
| 供应链：SBOM、许可证扫描、依赖来源、漏洞扫描、fork 补丁追踪 | 缺失 | 部分实现 |

已改进但仍为部分实现，原因如下：

| 需求 | 仍为部分实现的原因 |
|---|---|
| 角色目录包含……视觉/GUI 与本地/私有 Agent | `local_private` 角色的证据可被托管模型上的 Agent 通过 `evidence.get` 读取（只有其提示词在防范受限值）。 |
| L3 混合检索 | 符号来自正则表达式（没有 tree-sitter/LSP/SCIP）；唯一的嵌入器是特征哈希（没有语义模型）。 |
| ExperimentSpec | 不接受也不执行按实验的 `budget`。 |
| 清单：每个运行时发布都跑核心评测 | CI 在每次 push 时运行核心评测门禁，但 `runtime promote` 接受任何通过的回放套件，部署清单也不会被评测。 |
| P0 修订 3、混沌套件、P0 修订 5、EvalTask/EvalTrial、核心套件、核心指标、每次试验固定的修订、严重误放行、零未授权破坏性操作 | 见各行：备注说明了仍缺少的内容。 |

## 产品定义与原则

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 输入是测试目标而非预先编排的工作流；由 Hypertest 自行决定分解、风险、策略与拓扑 | 技术选型 §目标产品定义 | 已实现 | `packages/control/src/control-plane.ts` (startRun leadObjective, initial_plan item)<br>`packages/control/src/domain-tools/plan.ts` | Lead 提出类型化的 Plan IR。 |
| Pass/Fail/Conditional 来自证据 + BUGate 规则 + 评审 + 未决风险，绝不来自 Lead 的判断 | 技术选型 §目标产品定义 | **已实现** （原为 部分实现） | `packages/policy/src/gate.ts` (C0–C9)<br>`packages/control/src/convergence.ts` | 加固（conformance-1）：新增门禁准则 C0 oracle_in_force；没有已批准的确定性 P0/P1 oracle 的运行最多为 inconclusive。 |
| 证据即事实；LLM 从不是权威状态的持有者 | 技术选型 §原则 | 已实现 | `packages/evidence/src/ledger.ts`<br>`packages/collab`<br>`packages/control/src/domain-tools/common.ts` (checkEvidence) | – |

## Agent 运行时、引擎与子 Agent

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 运行时所有权：Agent、会话、上下文、任务、子 Agent、模型路由、权限、证据与门禁语义都归 Hypertest 所有 | 技术选型 §原则 | 已实现 | `packages/runtime/src/contracts.ts`<br>`scripts/check-boundaries.mjs` | – |
| 内核：Agent 的创建/恢复/中断/销毁、会话、激活、收件箱、取消传播 | 技术选型 §Agent Runtime Kernel | 已实现 | `packages/runtime/src/subagents.ts`<br>`packages/runtime/src/sessions.ts`<br>`packages/runtime/src/native-engine.ts` | 收件箱通过 ht_agent_inbox/enqueueInput 实现。 |
| 角色目录包含异构评审者、压缩器、视觉/GUI 与本地/私有 Agent | 技术选型 §Multi-LLM Router | 部分实现 | `packages/agents/src/roles/*.ts` (`vision-gui.ts`, `local-private.ts`)<br>`packages/app/src/releases.ts` (condenserPrivacyFloor)<br>`packages/app/src/diagnose.ts` (route coverage)<br>`packages/app/test/specialist-roles.e2e.test.ts` | 14 个角色。`vision_gui` 需要 vision 能力，使用 `browser.*` 并以截图作为证据（DOM/API 优先，computer use 仅作回退）。`local_private` 只运行在 restricted 路由上（privacyClass restricted、fallback fail_closed、禁用出站工具、压缩器隐私下限）；真实运行证明了路由行为（specialist-roles.e2e）。加固（H10）：评审者独立于所有产出证据的角色（EVIDENCE_PRODUCER_ROLES，现为八个）。仍为部分实现：`local_private` Agent 的工具记录的证据以 `internal` 级别存储，而 `evidence.get` 会向本运行的任何 Agent 返回预览，因此受限数据可能到达托管模型；目前只有角色提示词在防范这一点。 |
| 子 Agent 运行时：spawn/resume/message/interrupt/collect、可续跑、后台、嵌套委派、深度/数量上限 | 技术选型 §Subagent Runtime | **已实现**（原为部分实现） | `packages/runtime/src/subagents.ts`<br>`packages/control/src/domain-tools/work.ts` (delegate, delegate.status/collect/message/release)<br>`packages/control/src/delegation.ts`<br>`packages/control/src/worker.ts`<br>`packages/control/test/subagents.test.ts` | `delegate` 支持 `background`（父 Agent 继续工作；`delegate.status` / `delegate.collect` 与收件箱通知只携带子 Agent 的摘要）与 `continuable`（子 Agent 在每个任务后等待 `delegate.message`；`delegate.release` 或父 Agent 结束时完成）。worker 已死亡的后台子 Agent 会以新的 fencing token、作为同一个 Agent 被接管。深度与数量上限不变（maxDepth、MAX_AGENTS_PER_RUN）。 |
| SpawnRequest 契约（workItemId、角色、模型/工具策略、权限配置、contextSnapshotId、outputSchema、maxDepth、预算） | 技术选型 §Subagent Runtime | 已实现 | `packages/runtime/src/contracts.ts`<br>`packages/control/src/worker.ts` (SpawnRequest) | – |
| P0 修订 1：自有 ABI + Runtime Adapter + 外科式 fork；DSH 作为首个适配器 | 架构改进 §执行摘要 P0 | **已实现**（原为延后） | `packages/runtime` (native)<br>`packages/runtime-pi`<br>`packages/runtime-dsh/src/dsh-engine.ts` (DshEngine)<br>`packages/runtime-dsh/README.md` (fork decision gate record)<br>`packages/app/src/compose.ts` (`engines.default: dsh`) | 三个引擎均通过共享契约测试套件。DSH（0.1.0-rc.6 版本列车 + cordis 4.0.4 + 该列车以版本范围加载的 `@deepseek-ai` 库，精确钉定且覆盖整条列车的依赖闭包，版本漂移即拒绝运行）通过其公开接缝（LlmAdapter 路由、Agent 作用域工具、`agent/pre-step`、`tools/post-execute`）以 pin + adapter 方式适配，无需 fork。DSH 仅在被配置为默认引擎时注册并被 manifest 钉定（实验性）。 |
| AgentEngine ABI（createSession、runTurn、spawnChild、resumeChild、interrupt、inspect、dispose）+ EngineCapabilities | 架构改进 §核心接口 | 已实现 | `packages/runtime/src/contracts.ts` | – |
| Fork 决策门（默认 pin + 适配器；只有不可消除的缺口才做外科式 fork） | 架构改进 §Fork 决策门 | 已实现 | `packages/runtime-pi/src/version.ts` (exact pi-agent-core pin, fail closed)<br>`packages/runtime-dsh/src/version.ts` (exact DSH train pins, fail closed)<br>`packages/runtime-dsh/README.md` (gate evaluation: pin + adapter, revisit conditions) | – |
| 清单：领域代码不依赖 DSH 内部类型 | 架构改进 §工程交付评估清单 | 已实现 | `scripts/check-boundaries.mjs`<br>`packages/runtime-dsh/test/public-api.test.ts` (no DSH type in exported signatures) | – |

## 多模型路由与模型切换

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 原生多模型：ModelPolicy 是 WorkItem/AgentSpec 的一等属性 | 技术选型 §原则 | 已实现 | `packages/domain/src/agent.ts` (ModelPolicy)<br>`packages/domain/src/plan.ts`<br>`packages/control/src/worker.ts` (tightenModelPolicy) | – |
| ModelRequest/ModelRoute 契约（角色、任务类型、能力、结构化输出、风险、隐私、token/延迟/成本预算、禁用供应商、contextSnapshotId、fallbackChain、capabilityProfileRevision） | 技术选型 §Multi-LLM Router | 已实现 | `packages/model/src/contracts.ts` (RouteRequest, RouteDecision)<br>`packages/domain/src/agent.ts` (ModelPolicy) | – |
| 路由顺序：安全 → 能力 → 角色 → 质量 → 延迟 → 成本，绝不成本优先 | 技术选型 §Multi-LLM Router; BLUEPRINT I3 | 已实现 | `packages/model/src/router.ts` (ROUTING_STAGES) | 熔断器在质量之后加入 `availability` 阶段（安全 → 能力 → 角色 → 质量 → 可用性 → 延迟 → 成本）；它只会移除候选路由（属性测试）。 |
| 回退需重新授权（安全 + 能力），失败即关闭 | 技术选型 §Multi-LLM Router | 已实现 | `packages/model/src/router.ts` (invoke re-validation, fallback) | – |
| 风险缓解：针对限流/价格变化的模型熔断器 | 技术选型 §关键风险 | **已实现**（原为缺失） | `packages/model/src/circuit.ts`<br>`packages/model/src/router.ts` (availability stage)<br>`packages/model/test/circuit-breaker.test.ts` | 按路由的熔断器：连续可用性失败或限流风暴后打开，绝不重试已打开的熔断，只允许一次半开探测（取消或无结论错误时总会释放），冷却时间退避；L0 上记录 `model.circuit_opened` / `model.circuit_closed`；回退保持失败即关闭。价格护栏会为有成本上限的策略打开目录价格超过上限的路由。限制：熔断状态按进程保存；app 使用默认值组合路由器（价格上限不可配置，因此价格变化由成本预算约束）；所有路由都打开时，工作项以 `model_unavailable` 失败，而不是等到半开时间。 |
| ModelCapabilityProfile（工具调用、并行工具、结构化/推理模式、图像、computer use、上下文窗口、续接类别、隐私） | 架构改进 §Model Switch Contract | 已实现 | `packages/model/src/contracts.ts` (ModelCapabilityProfile)<br>`packages/model/src/catalog.ts` | 未建模 nativeSubagents。 |
| ModelEpoch（上一纪元、路由、配置修订、快照、切换原因、startedAt） | 架构改进 §Model Switch Contract | 已实现 | `packages/domain/src/context.ts`<br>`packages/runtime/src/epochs.ts` | – |
| 切换顺序：响应完成 → 工具结算 → 无待定结构化输出 → 快照固定 → 权限复核 → 新纪元 | 架构改进 §Model Switch Contract; BLUEPRINT I3 | 已实现 | `packages/runtime/src/invoker.ts` (pending fallback applied at the next turn)<br>`packages/model/src/router.ts` (invoke re-validation) | – |
| 失败即关闭的回退流水线，结果为 ALLOW/PAUSE | 架构改进 §Model Switch Contract | 已实现 | `packages/model/src/router.ts`<br>`packages/domain/src/agent.ts` (fallback: fail_closed) | – |
| 清单：每条路由都有 CapabilityProfile（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/model/src/catalog.ts`<br>`packages/app/src/config.ts` (completeRoute) | – |
| 清单：只在安全回合边界切换模型（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/runtime/src/invoker.ts`<br>`packages/runtime/src/epochs.ts` | – |
| 清单：不兼容的供应商/模型绝不复用不透明续接状态 | 架构改进 §工程交付评估清单 | 已实现 | `packages/domain/src/messages.ts` (projectForRoute)<br>`packages/runtime/src/invoker.ts` | – |
| 清单：回退时复核安全/能力（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/model/src/router.ts` | – |

## 规划、调度与协作

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 动态工作流：持续修订 PlanRevision，没有静态 DAG | 技术选型 §原则 | 已实现 | `packages/domain/src/plan.ts`<br>`packages/control/src/convergence.ts` (maybeReplan)<br>`packages/control/src/domain-tools/plan.ts` | – |
| 分层加去中心化：Lead/Scheduler 加 Blackboard/事件协作 | 技术选型 §原则 | 已实现 | `packages/control/src/scheduler.ts`<br>`packages/control/src/reactors.ts`<br>`packages/collab/src/blackboard.ts` | – |
| LLM 提出拓扑 → 类型化 Plan IR → 策略校验 → 调度器准入（不生成代码） | 技术选型 §Dynamic Scheduler | 已实现 | `packages/control/src/plan-validator.ts`<br>`packages/control/src/scheduler.ts` | – |
| WorkItem 模式（capabilityRequirements、模型/工具策略、inputRefs、expectedOutput、evidenceRequirements、dependsOn、预算、优先级、状态） | 技术选型 §Dynamic Scheduler | **已实现**（原为部分实现） | `packages/domain/src/plan.ts`<br>`packages/control/src/plan-validator.ts`<br>`packages/control/src/capability-grant.ts` (requirementProblems)<br>`packages/control/src/domain-tools/plan.ts` | 计划与 `delegate` 都携带 `capabilityRequirements`；计划校验器拒绝格式错误的需求，worker 会把它们并入 Agent 能力的交集（见 ActionCapability 行）。domain 的 PLANNED_WORK_ITEM_SCHEMA 尚未列出该字段；control 在本地扩展了该 schema。 |
| Blackboard：结构化、带版本的记录（WorkItem、Finding、Hypothesis、CoverageGap、Strategy、Review、Decision、Claim、EvidenceRef） | 技术选型 §Blackboard | 已实现 | `packages/domain/src/blackboard.ts`<br>`packages/collab/src/blackboard.ts` | – |
| DomainEvent 契约（eventId、聚合、correlation/causation、actor、run、schemaVersion） | 技术选型 §Blackboard | 已实现 | `packages/domain/src/events.ts` | 事件上没有 traceId 字段。 |
| 典型事件目录均会发出（work.*、finding.*、hypothesis.*、coverage.gap_detected、evidence.attached、test.failed/recovered、review.requested/completed、gate.*） | 技术选型 §Blackboard | 部分实现 | `packages/domain/src/events.ts`<br>`packages/control/src/convergence.ts` (requestRunReview)<br>emitters across control/collab | 加固（H7）：门禁前现在会为运行发出 review.requested。test.recovered 仍从未发出。 |
| PostgreSQL 事务性 outbox → NATS JetStream → 订阅者 → claim/lease；总线从不是事实来源 | 技术选型 §Blackboard; 架构改进 §职责边界 | 已实现 | `packages/collab/src/outbox-relay.ts`<br>`packages/collab/src/nats-bus.ts`<br>`packages/collab/src/inbox.ts`<br>`packages/control/src/reactors.ts` | 加固（durability-11）：relay 会在 sentRetentionMs（默认 1 小时）后清理已发送的 outbox 行。 |
| 重复投递绝不会重复破坏性副作用或工作 | 技术选型 §Blackboard; BLUEPRINT I5 | 已实现 | `packages/control/src/reactors.ts` (inbox + fingerprint)<br>`packages/operation/src/gateway.ts` (single-flight, findByToolInvocation) | 加固（conformance-7）：外部 http/browser/mcp 效果现在同样经过 Operation Ledger。 |
| 风险缓解：Agent 爆炸上限（深度/数量/并发/token/成本）与活锁防护（TTL、因果深度、单规则上限） | 技术选型 §关键风险; BLUEPRINT I12 | 已实现 | `packages/control/src/scheduler.ts`<br>`packages/control/src/reactors.ts` (maxPerRun, maxCausalDepth)<br>`packages/control/src/convergence.ts`<br>`packages/app/src/compose.ts` (MAX_AGENTS_PER_RUN) | – |
| 清单：Finding/Hypothesis/WorkItem 结构化存储 | 架构改进 §工程交付评估清单 | 已实现 | `packages/collab/src/blackboard.ts` | – |
| 清单：NATS 按至少一次投递处理 | 架构改进 §工程交付评估清单 | 已实现 | `packages/collab/src/nats-bus.ts` (explicit acks)<br>`packages/collab/src/inprocess-bus.ts` (duplicate injection) | – |
| 清单：领域事件有 eventId 并经收件箱去重 | 架构改进 §工程交付评估清单 | 已实现 | `packages/collab/src/inbox.ts`<br>`packages/control/src/reactors.ts` | – |
| BLUEPRINT I12：调度器强制执行并发/深度/Agent/token/成本/工具调用/墙钟预算，并保持收敛权 | BLUEPRINT §1.2 I12 | **已实现** （原为 部分实现） | `packages/control/src/scheduler.ts` (maxDispatch)<br>`packages/control/src/convergence.ts`<br>`packages/durable/src/local.ts` | 加固（H6、H13）：每次 tick 最多派发空闲回合槽位数；暂停的运行归还认领且不消耗重试次数。 |

## 上下文引擎、新鲜度与学习

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| L0 事件存储：PostgreSQL 仅追加的不可变历史 | 技术选型 §Context Engine | **已实现** （原为 部分实现） | `packages/collab/src/event-store.ts`<br>`packages/collab/src/migrations.ts` (collab/005-append-only, collab/006-outbox-immutable) | 加固（conformance-15）：数据库触发器拒绝对 ht_events 与各规格修订表执行 UPDATE/DELETE/TRUNCATE；ht_decisions 只允许单向的重新评估标记。第二轮：ht_outbox 的行必须以未发送状态插入，只允许单向设置 `sent_at`（比较整行）；只能清理已发送的行；禁止 TRUNCATE（在 PGlite 与 PostgreSQL 上做了篡改测试）。 |
| L1 提示词组装（角色、目标、工作项、BUGate、技能、工具、记忆、检索、证据引用） | 技术选型 §Context Engine | 已实现 | `packages/context/src/assembler.ts`<br>`packages/control/src/context-provider.ts` | 没有技能段（没有技能注册表）。 |
| L2 工作上下文：基于事件视图的 HARD/SOFT 压缩；优先卸载到 artifact | 技术选型 §Context Engine | **已实现**（原为部分实现） | `packages/context/src/working.ts` (softCondensationDue)<br>`packages/control/src/context-provider.ts`<br>`packages/tools/src/whitebox/runtime.ts` (offload)<br>`packages/control/test/context-readset.test.ts` | HARD 压力总会压缩（LLM 压缩器，失败时用确定性摘要器）。SOFT 压力只通过 LLM 压缩器压缩，前提是距上次截断已过 keepRecentTurns + 2 个回合，并有 60 秒期限；失败时推迟（回合照常继续），并让该会话退避 keepRecentTurns + 2 个回合，在 L0 上记录为 `context.condensation_deferred`。`context.compacted` 带有压缩级别。长对话记录不会导致栈溢出。 |
| L3 混合检索：FTS/ripgrep + 符号图（tree-sitter/LSP/SCIP）+ 向量（pgvector） | 技术选型 §Context Engine | 部分实现 | `packages/context/src/retrieval/*.ts` (exact, symbols, workspace-vector, hybrid)<br>`packages/app/src/compose.ts` (cachedRetrievers, pgVectorProbe) | app 按工作区根目录把精确搜索（ripgrep）、符号图（定义、使用、写入者、调用者、导入边）与向量检索融合（RRF）。向量语料按根目录与提交懒构建（LRU 8 个），存储在 pgvector 中（只检测一次），否则保存在内存中。仍为部分实现：符号来自正则表达式，而不是 tree-sitter/LSP/SCIP；唯一的嵌入器是特征哈希 `HashEmbedder`（没有语义嵌入模型或供应商路由）。 |
| L4 持久上下文：PowerContext 作为独立服务（派生记忆，而非事实） | 技术选型 §Context Engine; 架构改进 选型 | 已实现 | `packages/context/src/powercontext.ts`<br>`packages/app/src/compose.ts` (memory.kind powercontext) | 未对真实服务测试（没有可用端点）。 |
| L5 溯源：结论 → 证据 → 工具运行 → 环境 → 提交 | 技术选型 §Context Engine | 已实现 | `packages/context/src/provenance.ts`<br>`packages/control/src/report.ts`<br>`packages/app/src/compose.ts` (services.provenance) | 提交指基线提交；对于有改动的工作树，test.run 证据还会记录 workspaceDelta（树摘要与变更文件）（conformance-2）。第二轮：PoC A 的缺陷 finding 可以无缺口地追溯（测试结果 → executor 的 test.run，stdout → RCA 的 shell.exec，被创建的 Agent，候选提交），在 PGlite 与 PostgreSQL 上均验证。 |
| 学习：候选经验 → 评审/评测 → 批准 → 候选技能 → 验证 → 发布；幻觉不进入记忆 | 技术选型 §Learning | 部分实现 | `packages/context/src/experience.ts`<br>`packages/control/src/convergence.ts` (proposeExperience)<br>`packages/cli/src/commands` (experience) | 加固（conformance-13，部分）：提供人工评审入口 `hypertest experience list\|review`（创建者不能评审自己的候选）。没有技能注册表。 |
| P0 修订 2：ContextSnapshot 作为一致性契约，包含 ReadSet、环境代际与新鲜度策略 | 架构改进 §执行摘要 P0 | **已实现**（原为部分实现） | `packages/context/src/observations.ts` (observationsOf, observeToolRuntime)<br>`packages/context/src/freshness.ts`<br>`packages/context/src/snapshots.ts`<br>`packages/control/src/context-provider.ts` (observedReadSet)<br>`packages/context/src/migrations.ts` (context/003-observations) | ReadSet 固定所有已注册环境、输入 finding 与存活租约，以及 Agent 通过工具调用观察到的一切：读取的文件（`fs.read`；`git.show` 仅当显示内容就是当前文件时）、自身的写入、读取或发布的黑板记录，以及每个目标的一个指标窗口。无法记录观察的读取结果会被扣留（工具结果变为 failed/unavailable）。观察记录只能追加（拒绝 UPDATE、DELETE 与 TRUNCATE）。已知限制：`shell.exec`/`test.run` 的写入不被观察（失败即关闭：需要重新读取）；`fs.apply_patch` 通过调用后重新计算哈希来记录自身写入。 |
| ContextSnapshot 字段（eventSeq、blackboardRevision、planRevision、runtimeManifestId、modelEpochId、systemModel/oracle/experiment/policy 修订、环境代际 + 构建摘要、evidenceRootHash、readSet、createdAt） | 架构改进 §ContextSnapshot | 已实现 | `packages/domain/src/context.ts`<br>`packages/context/src/snapshots.ts` | 结构完整，ReadSet 内容也不再受限（见 P0 修订 2）。 |
| FreshnessGuard 在副作用前复核构建摘要、环境代际、oracle 升级、已撤回的 finding、租约持有者与指标时间窗 | 架构改进 §ContextSnapshot | **已实现**（原为部分实现） | `packages/context/src/freshness.ts` (ALWAYS_CHECKED_TYPES)<br>`packages/context/src/resolvers.ts` (workspaceFileResolver)<br>`packages/context/src/observations.ts` (metric_window) | 环境、构建、oracle、实验、租约与 finding 总会被检查；文件与指标窗口在操作涉及它们时被检查。每个目标一个指标窗口（`<env/<id>\|url/<host>>/metrics`），任何对该目标的新查询或抓取都会刷新它，超过窗口即过期。`env.*` 的自身写入观察只在该操作产生的代际上记录。活性限制：Agent 观察过的 finding 被取代或环境被重新部署后，在它重新观察该资源之前，其所有变更类操作都会被拒绝。 |
| 清单：ContextSnapshot 不可变 | 架构改进 §工程交付评估清单 | 已实现 | `packages/context/src/snapshots.ts` (content-hashed id)<br>`packages/context/src/freshness.ts` (re-hash check) | – |
| 清单：变更类操作检查 ReadSet（100%） | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/tools/src/whitebox/runtime.ts` (step 6)<br>`packages/context/src/freshness.ts`<br>`packages/control/test/context-readset.test.ts` | 守卫在每次变更类调用时针对完整的观察 ReadSet 运行。已通过调度器端到端验证：另一个 Agent 修改后的写入为 `stale_context`；无关修改不会阻塞；对已提交版本执行 `git.show` 不会让写入变为新鲜。 |
| 清单：环境代际进入快照 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/control/src/context-provider.ts` (environmentReadSet)<br>`packages/tools/src/whitebox/sql-environments.ts` | 加固（conformance-3、H12）：固定所有已注册环境；PostgreSQL 部署中各 worker 共享环境代际（SQL 环境注册表）。 |
| 清单：候选技能未通过评测绝不进入活动注册表（100%） | 架构改进 §工程交付评估清单 | 缺失 | – | 没有技能注册表（conformance-13）。 |
| BLUEPRINT I9：大型工具输出卸载；消息中只有有界摘要 | BLUEPRINT §1.2 I9 | 已实现 | `packages/tools/src/whitebox/runtime.ts` (offload) | – |

## 持久执行与恢复

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| Temporal：确定性工作流；LLM/工具/数据库在 activity 中执行；定时器、信号、重试 | 技术选型 §Durable Execution | 已实现 | `packages/durable/src/temporal/workflows.ts`<br>`packages/durable/src/temporal/activities.ts` | 加固：按部署划分的 worker 身份（durability-4），默认 24 小时的回合超时并带心跳（durability-5），按清单划分的任务队列（durability-6）。 |
| 权威表（Temporal 生命周期、事件存储、Blackboard、证据、对象存储、PowerContext、NATS、决策存储） | 技术选型 §Durable Execution | 已实现 | `docs/architecture/BLUEPRINT.md` §1.1 mirrored in code | – |
| Blackboard / Scheduler / Temporal / Operation Ledger 的职责没有合并成一个状态机 | 架构改进 §职责边界 | 已实现 | `packages/collab,` packages/control, packages/durable, packages/operation | – |
| 恢复手册（verified 返回缓存、dispatching → 对账、重新挂接外部任务、过期 fence 停止、补偿作为独立操作） | 架构改进 §回滚与恢复步骤 | 已实现 | `packages/control/src/control-plane.ts` (recover)<br>`packages/operation/src/gateway.ts` | 加固（durability-1）：recover() 会释放从失效 worker 接管的认领所持有的未结预算预留。 |
| 清单：LLM/API/副作用在 Temporal activity 中运行 | 架构改进 §工程交付评估清单 | 已实现 | `packages/durable/src/temporal/workflows.ts`<br>`packages/durable/src/temporal/activities.ts` | – |
| 清单：Temporal 与 Blackboard 之间没有重复的业务事实 | 架构改进 §工程交付评估清单 | 已实现 | `packages/durable/src/temporal/workflows.ts` (state is only in-flight children) | – |
| 本地持久运行时：崩溃安全、可恢复、负载下租约正确 | BLUEPRINT §5 durable | **已实现** （原为 部分实现） | `packages/durable/src/local.ts`<br>`packages/control/src/control-plane.ts` (renewClaim) | 加固（H6、H13、durability-7/8/9）：等待槽位的认领会保持存活；等待有截止时间；取消会清扫并发认领；认领的首个回合带有期望的回合号。 |

## 证据

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| EvidenceRecord 契约（类型、run/work/agent/tool id、artifactRef、sha256、大小、mime、环境、父记录、分级、保留、溯源） | 技术选型 §Evidence Store | 已实现 | `packages/domain/src/evidence.ts`<br>`packages/evidence/src/ledger.ts` | – |
| 内容寻址的 artifact / 哈希清单 | 技术选型 §Evidence Store | 已实现 | `packages/evidence/src/artifacts/fs.ts`<br>`packages/evidence/src/artifacts/s3.ts` | – |
| 报告声明 = 声明 + 证据引用 + 查询，可由门禁验证 | 技术选型 §Evidence Store | 已实现 | `packages/evidence/src/claims.ts`<br>`packages/control/src/domain-tools/evidence.ts` (evidence.claim)<br>`packages/policy/src/gate.ts` (C9) | – |
| 证据信封：metadataHash、previousRecordHash、recordHash 链、生产者（worker、镜像摘要、清单）、traceId、签名 | 架构改进 §Evidence 的不可篡改性 | 部分实现 | `packages/evidence/src/ledger.ts`<br>`packages/domain/src/evidence.ts` | 哈希链完整；逐条签名由签名封存（seal）替代；imageDigest 与 traceId 从不填充。 |
| 周期性 Merkle 根由 KMS/HSM 签名；决定/报告绑定到该根 | 架构改进 §Evidence 的不可篡改性 | 已实现 | `packages/evidence/src/hash.ts`<br>`packages/evidence/src/signer.ts` (KMS port)<br>`packages/control/src/convergence.ts` (seal at gate) | 在门禁时封存而非周期性封存；默认签名者为本地 Ed25519 密钥。 |
| WORM 对象存储（S3 Object Lock COMPLIANCE） | 架构改进 §Evidence 的不可篡改性 | 延后 | `packages/evidence/src/artifacts/s3.ts` | 已通过 artifacts.objectLockDays 实现；真实 S3 测试被跳过（无端点）；默认 fs 存储不是 WORM。 |
| 角色分离：Agent 不能删除；worker 只追加；证据服务；独立签名者身份；报告者只读 | 架构改进 §Evidence 的不可篡改性 | 部分实现 | `packages/evidence/src/migrations.ts` (append-only triggers)<br>`packages/app/src/keys.ts` | 加固（H1）：本地沙箱 jail 对 Agent 命令隐藏密钥目录。签名者仍在 Hypertest 进程内运行；没有独立的签名服务。 |
| 清单：关键声明全部引用证据（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/policy/src/gate.ts` (C9)<br>`packages/control/src/domain-tools/evidence.ts` (resolveClaim) | – |
| 清单：artifact SHA-256（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/evidence/src/artifacts/*.ts`<br>`packages/evidence/src/ledger.ts` | – |
| 清单：元数据哈希链 / Merkle 根 | 架构改进 §工程交付评估清单; BLUEPRINT I6 | 已实现 | `packages/evidence/src/ledger.ts`<br>`packages/evidence/src/hash.ts` | – |
| 清单：生产结论证据使用 WORM 或等效存储 | 架构改进 §工程交付评估清单 | 延后 | `packages/evidence/src/artifacts/s3.ts` | 可选的 objectLockDays；真实测试被跳过。 |
| 清单：签名者与 Agent 权限隔离 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/app/src/keys.ts`<br>`packages/evidence/src/signer.ts` | jail 会对沙箱命令隐藏密钥（H1），但签名者与 Hypertest 共享进程和 OS 用户。 |

## Oracle、实验、测试资产与 QualityGate

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| GateSpec/GateDecision（pass/fail/conditional/needs_review、违反的规则、评审决定、策略修订） | 技术选型 §BUGate | **已实现**（原为部分实现） | `packages/domain/src/testing.ts` (GateSpec, QualityDecision)<br>`packages/policy/src/gate.ts`<br>`packages/control/src/util.ts` (authorizedGateWeakenings, gateReference)<br>`packages/control/src/convergence.ts`<br>`packages/control/test/gate-authority.test.ts` | 每个决定都签入 gateSpecDigest 与 gateOverrides（conformance-9）。放宽门禁的运行需要带理由的人或系统授权（`gateOverrideBy`、`gateOverrideRationale`），与门禁一起记录并写入 L0（`gate.override_authorized`）。在门禁处，没有授权记录、授权人是 Agent，或放宽程度超出授权范围的门禁行都会扣留结论；报告采用相同判断。needs_review 以 requiresHumanReview 表示。REST API 尚未传递授权字段（失败即安全）。 |
| BUGate 在四个时点生效：行动前、行动后、状态转换前、最终验收前 | 技术选型 §BUGate | **已实现**（原为部分实现） | `packages/policy/src/contracts.ts` (PolicyPhase)<br>`packages/control/src/phases.ts`<br>`packages/control/src/dispatcher.ts` (after_action)<br>`packages/control/src/worker.ts` (finishTask)<br>`packages/control/test/phases.test.ts` | ToolRuntime 评估 before_action；控制面评估 after_action（写入了工具未声明类型证据的调用会被标记，`policy.flagged`；未声明任何类型的工具只能写入 `tool-output`）、before_transition（工作项完成、计划接受、运行进入门禁）与 before_acceptance（门禁输入摘要 + 结论）。每个决定都会记录（可重放）。同一回合中在 `complete_work` 之后被标记的调用会让工作项在状态转换时失败。运维规则可以针对每个阶段。限制：阶段许可为 `approval_required` 时按拒绝处理。 |
| 评审者无法绕过确定性门禁（覆盖率、关键测试失败、证据缺失、未解决的 P0/P1、环境无效） | 技术选型 §BUGate | 部分实现 | `packages/policy/src/gate.ts` (C2–C8)<br>`packages/control/src/util.ts` (gateSpecProblems) | 加固（H3）：覆盖项会被校验，C2/C7 在阈值未知时失败即关闭。仍没有专门的环境有效性准则（环境类 finding 只会让 C2 变为 unknown）。 |
| P0 修订 3：在证据与门禁之间治理 Oracle / 实验有效性 / TestArtifact | 架构改进 §执行摘要 P0 | 部分实现 | `packages/policy/src/{oracle-governance,gate,classifier}.ts`<br>`packages/control/src/domain-tools/specs.ts`<br>`packages/control/src/isolation.ts` | 加固（conformance-1/2/10）：oracle 为必需（C0），生成的测试绑定到其内容摘要与代码。第二轮：实验隔离已强制执行（见 ResourceClaim 行），证据与操作都带有 experimentId。QualityGate 尚未据此判断实验效度。 |
| SystemModel 带版本（组件、接口、依赖、状态机、不变量、风险标签、来源）；从不作为 oracle | 架构改进 §SystemModel | 已实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` (system_model.record) | – |
| OracleSpec 含 authorities、judgePolicy、changePolicy（selfApprove 为 false）、approvedBy | 架构改进 §OracleSpec | 已实现 | `packages/domain/src/testing.ts`<br>`packages/policy/src/oracle-governance.ts` | – |
| Oracle 强度分层；P0/P1 门禁绝不只依赖 LLM | 架构改进 §OracleSpec; BLUEPRINT I7 | 已实现 | `packages/domain/src/testing.ts` (ORACLE_STRENGTH)<br>`packages/policy/src/gate.ts` (C0, C3) | – |
| Agent 可以提议但绝不能批准会翻转已记录失败的 OracleRevision；需独立/人工批准 | 架构改进 §OracleSpec; BLUEPRINT I8 | **已实现** （原为 部分实现） | `packages/policy/src/oracle-governance.ts` (assertMayDecide)<br>`packages/policy/src/gate.ts` (evaluateOracleCheck)<br>`packages/app/src/governance.ts` | 加固（H8）：翻转检测使用门禁自身的 evaluateOracleCheck 评估所有检查类型。 |
| Oracle 变更 → 新修订 → 新实验；基于旧修订的决定标记为 needs_reassessment；不改写历史 | 架构改进 §Oracle 与实验流程 / 回滚 | 部分实现 | `packages/policy/src/oracle-governance.ts`<br>`packages/collab/src/decisions.ts`<br>`packages/policy/src/gate.ts` (currentOracleRevisions) | 加固（conformance-4）：运行中其固定的 oracle 修订被取代时，C0 为 unknown（inconclusive）。不会自动创建新实验。 |
| ExperimentSpec（对象、环境代际、fixture、负载、故障计划、种子、隔离 + claim、预算、证据要求、停止条件、污染规则） | 架构改进 §ExperimentSpec | 部分实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` (experiment.define)<br>`packages/control/src/isolation.ts` | 会记录 fixture、种子（缺省时生成，重试时保持稳定）、停止条件、污染规则、环境代际、构建摘要与 topologyRef；隔离 claim 会被原子准入，污染规则会被强制执行。仍为部分实现：不接受也不执行按实验的 `budget`（适用运行与工作项预算）。 |
| TestArtifact 契约与生命周期（生成 → 静态 → 已知正确通过 → 已知错误/变异失败 → oracle 评审 → 合格） | 架构改进 §TestArtifact | **已实现** （原为 部分实现） | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` (register/validate)<br>`packages/policy/src/gate.ts` | 加固（conformance-2/10）：验证会将 artifact 摘要与记录的 workspaceDelta 比对，并要求已知正确与已知错误运行基于不同代码。 |
| QualityDecision（含 inconclusive 的结论、修订、evidenceRootHash、准则、风险、例外、评审决定、清单、签名、supersedes） | 架构改进 §QualityDecision | 已实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/convergence.ts` (signed)<br>`packages/cli/src/commands` (waive) | 加固（conformance-11）：例外来自人工批准的 gate_exception（`hypertest waive`）；C1 永不可豁免。 |
| 自愈表：定位器/环境自动；fixture/测试缺陷/超时有条件；断言/阈值/删除测试需批准或禁止；产品代码按权限 | 架构改进 §Test Judge 与自愈治理 | 已实现 | `packages/policy/src/classifier.ts`<br>`packages/control/src/dispatcher.ts` (govern, drift quarantine)<br>`packages/tools/src/whitebox/worktree-state.ts` | 加固（security-1、H1）：漂移检测将工作树字节与基线树比对哈希（index 标志、replace 引用、过滤器与 Agent 写入的 .gitignore 都无法隐藏变更）。残留风险见隔离层级一行。 |
| 清单：构建/组件/接口带版本且可追溯（SystemModel） | 架构改进 §工程交付评估清单 | 已实现 | `packages/collab/src/specs.ts`<br>`packages/control/src/domain-tools/specs.ts` | – |
| 清单：OracleSpec 独立于 Agent 叙述 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/oracle-governance.ts`<br>`packages/app/src/compose.ts` (oracles config)<br>`packages/cli/src/commands` (oracle establish) | 加固（conformance-1）：由人通过 `oracles:` 配置段或 `hypertest oracle establish` 建立 oracle；Agent 无法建立。 |
| 清单：执行者无法自我批准 oracle 变更（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/policy/src/oracle-governance.ts` (assertMayDecide)<br>`packages/policy/src/engine.ts` (agent tool deny)<br>`packages/cli/src/commands/decide.ts` | 加固（H1、H8）：设置了 HYPERTEST_SANDBOX 时 CLI 拒绝人工决定，两种沙箱都会设置该变量且调用方无法移除；翻转检测覆盖所有检查类型。 |
| 清单：断言/阈值不能被自动放宽（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/classifier.ts`<br>`packages/control/src/dispatcher.ts`<br>`packages/tools/src/whitebox/worktree-state.ts`<br>`packages/app/src/governance.ts` | 加固（security-1、H1、H8）：防篡改的漂移检测、参数限制与沙箱 jail；放宽指标阈值会被识别为翻转。本地沙箱的主机残留暴露见隔离层级一行。 |
| 清单：关键生成测试有敏感度检查 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/control/src/domain-tools/specs.ts` (test_artifact.validate)<br>`packages/policy/src/gate.ts` | 加固（conformance-2/10）：变更测试文件的证据只有通过已验证、摘要匹配、且已知正确与已知错误运行基于不同代码的 TestArtifact 才被计入。 |
| 清单：实验记录构建/环境/数据/负载/故障 | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/control/src/domain-tools/specs.ts`<br>`packages/tools/src/whitebox/runtime.ts` (provenance.experimentId)<br>`packages/operation/src/migrations.ts` (operation/006, ht_operations.experiment_id) | 构建摘要、环境代际、fixture、负载、故障计划与种子都记录在 ExperimentSpec 中。证据带有 `provenance.experimentId`（位于哈希链元数据内），操作带有 `experiment_id`；为多个实验运行的工作项会用其 claim 覆盖该调用的实验来标记写入/故障调用。 |
| 清单：只有门禁服务产出正式结论 | 架构改进 §工程交付评估清单 | 已实现 | `packages/control/src/convergence.ts` (gateRun is the only decisions.save caller) | – |
| 清单：证据不足绝不产生 Pass | 架构改进 §工程交付评估清单; BLUEPRINT I7 | **已实现** （原为 部分实现） | `packages/policy/src/gate.ts` (C0, C1, C2, C7)<br>`packages/control/src/util.ts` (gateSpecProblems) | 加固（conformance-1、H3）：C0 要求有生效的 oracle；格式错误的门禁覆盖项会被拒绝，未知阈值失败即关闭。 |
| 门禁准则配置在使用前经过校验 | BLUEPRINT §4.1 / §5 policy | **已实现** （原为 缺失） | `packages/control/src/control-plane.ts` (startRun)<br>`packages/control/src/util.ts` (gateSpecProblems)<br>`packages/app/src/config.ts` | 加固（H3）：配置与运行覆盖项都会被校验；严重级别只允许 P0–P3。 |

## 工具、沙箱与权限

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 每次工具调用都经过统一的 PolicyInterceptor | 技术选型 §Agent Runtime Kernel | 已实现 | `packages/tools/src/whitebox/runtime.ts` (steps 3-6)<br>`packages/control/src/dispatcher.ts` | – |
| ActionPermit allow/deny/approval_required，带路径/主机/命令/凭据/时长约束 | 技术选型 §BUGate | 已实现 | `packages/policy/src/engine.ts`<br>`packages/tools/src/whitebox/runtime.ts` | – |
| 工具运行时传输：原生、MCP、CLI、HTTP/gRPC、ACP Agent、远程 worker、浏览器、computer use | 技术选型 §Tool Runtime | 部分实现 | `packages/tools/src/whitebox/*`<br>`packages/tools/src/blackbox/{http,mcp,browser}.ts` | 没有 ACP、远程 worker、gRPC 或 computer use 适配器。 |
| ToolExecutionRequest/Result（权限令牌、环境、幂等键、超时、artifact/证据引用） | 技术选型 §Tool Runtime | 已实现 | `packages/tools/src/contracts.ts`<br>`packages/tools/src/whitebox/runtime.ts` | invocationId 即幂等键。加固（H4）：请求携带工作认领（claim）和按认领划分的 leaseOwner。 |
| 白盒能力：git、fs、shell、tree-sitter/LSP、覆盖率、变异、测试框架、构建工具、静态分析、数据库内省 | 技术选型 §Tool Runtime | 部分实现 | `packages/tools/src/whitebox/tools/*.ts`<br>`packages/tools/src/whitebox/coverage.ts`<br>`packages/tools/src/whitebox/mutation.ts`<br>`packages/tools/src/whitebox/runners/*.ts` | 没有 LSP/tree-sitter、静态分析或数据库内省。 |
| 黑盒能力：HTTP、Playwright、压测生成器、Kubernetes、Prometheus、OTel、日志、故障注入、网络检查 | 技术选型 §Tool Runtime | 部分实现 | `packages/tools/src/blackbox/{http,browser,load,prometheus,metrics,env-adapters}.ts` | kubectl/docker 适配器已存在，但真实运行延后（验证主机没有 docker 守护进程）；没有 OTel/日志/网络工具。 |
| 隔离层级：只读快照 / 独立 worktree 或容器 / 带网络策略的独立沙箱 | 技术选型 §Tool Runtime | 部分实现 | `packages/tools/src/whitebox/workspaces.ts`<br>`packages/tools/src/whitebox/sandbox.ts`<br>`packages/tools/src/whitebox/netns.ts`<br>`packages/tools/src/whitebox/argv-guard.ts` | 加固（security-2、H1、security-H1a）：本地沙箱在 user/network/PID/mount 命名空间中运行所有非 open 网络配置（隐藏密钥、存储与其他工作区；仅中继 SUT），并限制 Agent 命令参数；在不支持非特权用户命名空间的主机上拒绝这些配置。残留风险：同一 OS uid，主机其余文件系统可见。OCI 失败即关闭，但此处未实际运行（无 docker 守护进程）；gVisor/Firecracker 延后。 |
| 风险缓解：通过信任标签 + 类型化结果 + 策略边界防御工具提示词注入 | 技术选型 §关键风险 | 已实现 | `packages/control/src/context-provider.ts` ('data, not instructions' sections)<br>`packages/tools/src/whitebox/runtime.ts` | – |
| ActionCapability；子能力 = 父 ∩ 角色 ∩ WorkItem ∩ 环境策略；绝不放大 | 架构改进 §安全与权限边界; BLUEPRINT I2 | **已实现**（原为部分实现） | `packages/policy/src/capabilities.ts`<br>`packages/control/src/capability-grant.ts` (workItemConstraint, unmetRequirements)<br>`packages/control/src/worker.ts`<br>`packages/control/test/capability-grant.test.ts` | WorkItem 的 `capabilityRequirements` 参与交集；其他操作数无法授予的需求会在任务消息中准确报告（`capability.requirements_unmet`）。没有环境类别且可能触及环境的需求会保留其他操作数允许的全部类别；仅作用于工作区或运行的需求绝不会放宽类别。属性测试：结果绝不比任何操作数更宽。 |
| 清单：子权限只会收缩（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/capabilities.ts` (attenuateCapability)<br>`packages/runtime/src/subagents.ts`<br>`packages/control/src/worker.ts`<br>`packages/control/src/capability-grant.ts` | 加固（H9）：根能力与衰减后的能力只携带已注册环境的环境类别。第二轮：WorkItem 需求参与交集（见 ActionCapability 行）。 |
| 清单：LLM 从不接收长期静态凭据 | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/whitebox/sandbox.ts` (scrubbed env)<br>`packages/tools/src/whitebox/runtime.ts` (redactSecrets)<br>`packages/app/src/environments.ts` | 没有密钥代理或临时凭据。 |
| 清单：沙箱出站有策略 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/tools/src/whitebox/netns.ts`<br>`packages/tools/src/whitebox/sandbox.ts` (OCI --network none)<br>`packages/tools/src/blackbox/common.ts` (tool-level egress) | 加固（security-2）：本地命令只能访问自身 loopback 以及被中继的 SUT 端点；无法隔离的主机会拒绝执行（失败即关闭）。`sandbox.network: open` 是显式的退出选项。 |
| 清单：关键 allow/deny 决定可重放（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/decision-log.ts` (request + permit + revision)<br>`packages/app/src/compose.ts` (opaPolicyRevision) | 加固（conformance-12）：OPA 修订号是所服务决策包模块的摘要，因此策略变更会改变修订号与清单。 |
| 清单：零未授权破坏性操作 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/metrics.ts` (policyViolations, securityViolations)<br>`packages/eval/src/suites/core.ts` (security-injection)<br>`packages/policy/src/engine.ts`<br>`packages/tools/src/whitebox/argv-guard.ts` | 加固（security-H1a、H1）：argv 限制与 jail 封堵了审计发现的逃逸。第二轮：security-injection 核心套件与评测门禁要求 securityViolations = 0，并从包括基础设施错误在内的每个候选试验中读取。在运行时计算路径的程序仍能以同一 uid 写入隐藏路径之外的位置；不受信任的模型需要 OCI 沙箱。 |

## 副作用、租约与预算

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| P0 修订 4：Operation Ledger、fencing、reconcile、outcome_unknown 状态机 | 架构改进 §执行摘要 P0 | **已实现** （原为 部分实现） | `packages/operation/src/{ledger,gateway,leases}.ts`<br>`packages/tools/src/whitebox/record-effects.ts`<br>`packages/control/src/domain-tools/index.ts` (claimFenced) | 加固（H4、conformance-7）：工作认领的 fence 传递到工具与领域工具的写入；外部 http/browser/mcp 效果进入台账。 |
| Operation Ledger 记录与状态机（prepared … manual_review/failed），operationId 稳定 | 架构改进 §Operation Ledger | 已实现 | `packages/domain/src/operation.ts`<br>`packages/operation/src/ledger.ts` | – |
| idempotencyKey = operationId 传给目标；K8s/压测任务以 operation id 打标签 | 架构改进 §Operation Ledger | 已实现 | `packages/tools/src/blackbox/{env-adapters,load}.ts`<br>`packages/operation/src/gateway.ts` | – |
| 单调递增的 fencing token；目标或网关只接受当前 token | 架构改进 §Fencing | 已实现 | `packages/operation/src/leases.ts` (checkFence, highest_accepted) | 加固（H4）：副作用租约的持有者按认领划分（`<workerId>:<workItemId>:<fencingToken>`）；操作结算后释放租约（durability-3）。 |
| outcome_unknown 处理与重试开关（verified → 缓存；prepared/not_applied → 派发；dispatching/acknowledged/unknown → 对账） | 架构改进 §Outcome Unknown | 已实现 | `packages/operation/src/gateway.ts` | – |
| SideEffectAdapter 协议（prepare/dispatch/observe/verify/compensate）+ 能力（原生幂等、查询、fencing、补偿、对账类别） | 架构改进 §Adapter 需要实现的协议 | 已实现 | `packages/operation/src/contracts.ts` | – |
| 不可对账的高风险操作绝不自动重试 → 人工复核 | 架构改进 §Adapter 需要实现的协议 | 已实现 | `packages/operation/src/gateway.ts` | – |
| ResourceClaim 模式（read_shared/write_exclusive/fault_exclusive）、层级键、实验前原子准入 | 架构改进 §并发实验隔离 | **已实现**（原为部分实现） | `packages/operation/src/admission.ts`<br>`packages/control/src/domain-tools/specs.ts` (experiment.define)<br>`packages/control/src/isolation.ts` (experimentResourceProblem, resourceAliases)<br>`packages/control/src/dispatcher.ts`<br>`packages/control/test/isolation-budget.test.ts` | `experiment.define` 以原子方式准入实验的 claim（持有者为实验），否则不创建任何内容。为实验运行的工作项的写入/故障调用必须在其 claim 内、以正确模式执行（`experiment_claims_missing`）；任何工作项对其他实验所持资源的写入/故障调用都会被拒绝（`experiment_resource_conflict`）；已注册环境的 URL 视同该环境。只要存在存活的所有者就会续租 claim，并在实验的压测作业可能运行期间保留。限制：限时故障可能在 claim 释放后仍然生效；调用时检查读取的是存活 claim（没有按调用的临时 claim）。 |
| BudgetEnvelope 作为租约：对 Agent、模型、工具、算力、QPS、artifact 字节执行 预留 → 执行 → 结算 | 架构改进 §Budget 也是资源租约 | **已实现**（原为部分实现） | `packages/operation/src/budget.ts`<br>`packages/runtime/src/invoker.ts`<br>`packages/control/src/dispatcher.ts` (reserveQps, compute and artifact charges)<br>`packages/control/src/isolation.ts` (settleExternalQps)<br>`packages/control/src/control-plane.ts` (run limits) | 模型调用按次预留并结算；工具调用幂等计费（H5）；工具调用的算力毫秒数与 artifact 字节数计入工作项与运行；`load.start` 在作业运行期间按 maxExternalQps 预留其 QPS（预留已释放的重放调用会重新预留；作业启动后抛错的调用保留该速率）。artifact 预算用尽后拒绝写入/故障调用。限制：工具调用之外的 artifact 写入（压缩、报告）不计费；算力耗尽后，启动沙箱进程的读取类工具会被计费但不会被拒绝。 |
| 预算耗尽 → PAUSED_BUDGET / CONDITIONAL_STOP / NEEDS_APPROVAL，绝不静默降级 | 架构改进 §Budget | 已实现 | `packages/control/src/worker.ts` (onBudgetExhausted pause)<br>`packages/control/src/convergence.ts` (exhaustion) | – |
| 清单：每个破坏性工具都有 operationId（100%） | 架构改进 §工程交付评估清单; BLUEPRINT I4 | **已实现** （原为 部分实现） | `packages/tools/src/blackbox/env-tools.ts` (bound)<br>`packages/tools/src/whitebox/record-effects.ts` (http/browser/mcp) | 加固（conformance-7）：没有自有适配器的工具通过以调用 id 为键的仅记录适配器执行；缺少这些适配器的网关会拒绝此类工具。 |
| 清单：支持的目标会收到幂等键（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/blackbox/http.ts` (Idempotency-Key)<br>`packages/tools/src/blackbox/env-adapters.ts`<br>`packages/tools/src/blackbox/load.ts` | – |
| 清单：超时 ⇒ outcome_unknown | 架构改进 §工程交付评估清单 | 已实现 | `packages/operation/src/gateway.ts`<br>`packages/tools/src/whitebox/runtime.ts` (runSideEffect) | – |
| 清单：可查询的外部任务会重新挂接（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/blackbox/load.ts` (observe by operation id)<br>`packages/eval/src/poc-graders.ts` (loadJobReattached) | – |
| 清单：写租约携带单调递增的 fencing token | 架构改进 §工程交付评估清单 | 已实现 | `packages/operation/src/leases.ts` | – |
| 清单：过期 worker 无法成功写入（0 次成功） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/control/src/domain-tools/index.ts` (claimFenced)<br>`packages/control/src/dispatcher.ts`<br>`packages/tools/src/whitebox/runtime.ts` | 加固（H4）：非只读领域工具在其事务内复核认领（lease_lost）；副作用租约按认领持有，因此同一 Agent 的过期 worker 会被拒绝。 |
| 清单：每个写入/故障实验都声明 ResourceClaim（100%） | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/control/src/domain-tools/specs.ts`<br>`packages/control/src/isolation.ts`<br>`packages/control/src/dispatcher.ts` | 每个实验都带着 claim 被准入（默认 `env/<environmentId>`：有故障计划时为 fault_exclusive，有负载时为 write_exclusive，否则为 read_shared），每次写入/故障调用都会按调用检查覆盖其环境/URL 资源的 claim。 |
| 清单：Agent/模型/工具/算力统一的 BudgetEnvelope | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/domain/src/run.ts`<br>`packages/control/src/control-plane.ts`<br>`packages/control/src/convergence.ts` (exhaustion)<br>`packages/control/src/dispatcher.ts` | computeMs、artifactBytes 与 externalQps 与 token、成本、工具调用、工作项一样是运行范围的限制；收敛监视器报告每个维度的耗尽情况，并遵循暂停策略。 |
| 清单：预算耗尽时不静默回退到低质量模型 | 架构改进 §工程交付评估清单 | 已实现 | `packages/runtime/src/invoker.ts` (budget_exhausted boundary)<br>`packages/control/src/worker.ts` | – |

## 运行时清单与发布

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| RuntimeManifest 物料清单（hypertest 版本 + gitSha、引擎、供应商适配器、模式、策略包、工具目录） | 架构改进 §Runtime Manifest | **已实现**（原为部分实现） | `packages/runtime/src/manifest.ts` (toolCatalogRevision)<br>`packages/app/src/compose.ts` (buildRuntimeManifest)<br>`packages/app/src/releases.ts` (hypertestGitSha, imageDigestFrom) | 固定内容：版本、sourceDigest、gitSha（仅当安装目录是 checkout 的顶层时取 `git rev-parse HEAD`）、imageDigest（`HYPERTEST_IMAGE_DIGEST`；格式错误时组合失败）、引擎及其适配器包（含 `@hypertest/runtime-pi` / `-dsh`）、defaultEngine、供应商适配器、schema、策略包、角色目录修订，以及覆盖超时、副作用绑定与适配器能力的工具目录修订。 |
| 运行时发布状态 candidate → shadow → canary → active → retiring → retired | 架构改进 §Runtime Manifest | **已实现**（原为缺失） | `packages/runtime/src/releases.ts` (createRuntimeReleaseRegistry)<br>`packages/runtime/src/migrations.ts` (runtime/005-releases)<br>`packages/app/src/releases.ts`<br>`packages/cli/src/commands/runtime.ts` | `ht_runtime_releases` 带有 active 指针，且最多一个 canary（按百分比分桶和/或标签选择）。`promote` 每次只前进一步，并且只在最新的 `engine_contract` 与 `replay` 结果都通过时才允许；激活后，上一个发布在排空后退役。历史、套件结果与纪元只能追加（触发器）；`lock(tx)` 让依赖状态的调用方串行化。新运行只在 active 发布或选中它的 canary 下准入；从未激活过发布的安装处于非受管状态，除非设置 `runtime.requireActiveRelease: true`。 |
| 运行时回滚：停止候选版本、切换 active 指针、旧运行继续、隔离候选运行、回放套件 | 架构改进 §回滚与恢复 | **已实现**（原为部分实现） | `packages/runtime/src/releases.ts` (rollback)<br>`packages/app/src/releases.ts` (quarantine, beforeDrive, releaseGovernedControlPlane)<br>`packages/app/src/compose.ts` (resumeIncomplete)<br>`packages/app/test/releases.e2e.test.ts` | `rollback` 停止 canary，或把 active 指针移回上一个发布；被回滚的发布永久退役。旧运行继续使用其固定的清单。被回滚发布上的存活运行会被隔离（暂停、`run.quarantined`、报告说明、拒绝恢复），隔离来自回滚本身的清扫、创建者的复查、每次驱动前的复查（`recover`、`resumeIncomplete`、运维恢复）以及运维恢复之后的复查。重新运行回放套件是运维/CI 步骤：回滚输出会提示，并用 `record-suite` 记录。 |
| 长时间运行的显式迁移（检查点 → 对账 → 兼容性 → 新 RuntimeEpoch） | 架构改进 §回滚与恢复 | **已实现**（原为缺失） | `packages/app/src/releases.ts` (migrate, releaseCheckpoint)<br>`packages/runtime/src/releases.ts` (runtimeCompatibility, recordEpoch)<br>`packages/cli/src/commands/runtime.ts` (migrate, migrate --abort) | `hypertest runtime migrate <runId> --to <manifest>`：在运行锁下建立检查点（进行中的回合交还 claim）、规范快照、对账（任何操作未结算时拒绝）、在最终事务内持有注册表锁并重新检查兼容性，然后在同一事务中写入 RuntimeEpoch + `run.migrated` + 重新固定 + 恢复（运行离开检查点时为 `conflict`）。被放弃的检查点用 `--abort` 释放（`run.migration_released`）。已在本地持久运行时上验证；未在真实 Temporal 服务上运行。 |
| 清单：每个 TestRun 固定到一个 RuntimeManifest | 架构改进 §工程交付评估清单; BLUEPRINT I11 | **已实现** （原为 部分实现） | `packages/collab/src/runs.ts`<br>`packages/app/src/compose.ts` (pinnedControlPlane)<br>`packages/control/src/util.ts` (assertRunPinned)<br>`packages/app/src/releases.ts` (migrate) | 加固（H2、conformance-8）：控制面本身拒绝驱动固定到其他清单的存活运行，回合拒绝使用清单未固定的引擎版本，且清单包含源码摘要。第二轮：运行只能通过显式迁移改变其固定清单，并记录为 RuntimeEpoch。 |
| 清单：上游升级需要兼容性套件 | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/runtime/src/contract-suite.ts`<br>`packages/runtime-pi/src/version.ts`<br>`packages/runtime-dsh/src/version.ts`<br>`packages/runtime/src/releases.ts` (promotionReadiness) | Pi 与 DSH 都被精确钉定，版本漂移即拒绝运行，因此上游升级是一次代码变更并产生新清单；新清单在基于已记录且通过的 `engine_contract` 与 `replay` 结果晋级之前不会创建运行。说明：结果由 CI 或人工证明（`--passed`，或绑定到 SuiteResult 摘要的 `--from-eval`）；从未激活过发布的安装不受此门禁约束，除非设置 `runtime.requireActiveRelease: true`。 |
| 清单：运行时回滚不迁移旧运行 | 架构改进 §工程交付评估清单 | **已实现**（原为部分实现） | `packages/runtime/src/releases.ts` (active pointer)<br>`packages/app/src/releases.ts` (quarantine)<br>`packages/app/src/compose.ts` (resumeIncomplete) | 回滚把 active 指针移回，并且只隔离被回滚发布的运行；其他发布的运行无需任何迁移，继续使用其固定的清单。 |

## 评测平台与 PoC 验收

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 运行时所有权验收：同一目标可经至少 3 类供应商运行；运行中切换模型保持权威状态；所有模型/工具调用可审计 | 技术选型 §实施路线 Runtime ownership | 部分实现 | `packages/model/src/{openai,anthropic,pi-ai,scripted}.ts`<br>`packages/eval/src/suites/core.ts` (model-switch)<br>`packages/eval` (live arm opt-in) | CI 使用脚本化供应商证明这一点（model-switch 核心套件检查运行中切换模型后规范状态保持一致）；没有 HYPERTEST_EVAL_LIVE 时跳过真实模型分组。 |
| 动态多 Agent 验收：Lead 创建分析者，再并行创建设计者、执行、重规划；不硬编码 Agent 数量 | 技术选型 §实施路线 | 已实现 | `packages/eval/src/suites/poc-a.ts`<br>`packages/eval/src/poc-graders.ts` (pocAWorkflow) | 使用脚本化大脑。 |
| 去中心化验收：finding.created 无需 Lead 即可唤醒 RCA 与 TestDesigner；重复投递不产生重复效果 | 技术选型 §实施路线; PoC B | 已实现 | `packages/eval/src/suites/poc-b.ts`<br>`packages/agents/src/roles/{rca,test-designer}.ts` subscriptions | – |
| 持久性验收：kill/重启后保留计划修订、子 Agent 身份与证据；无破坏性重放；恢复等待状态与工作上下文 | 技术选型 §实施路线; PoC C | 已实现 | `packages/eval/src/suites/poc-c.ts` (child-process SIGKILL)<br>`packages/control/src/control-plane.ts` (recover) | – |
| 证据驱动验收：绝不根据 Agent 文本给出 Pass；只依据证据清单 + GateDecision | 技术选型 §实施路线 | **已实现** （原为 部分实现） | `packages/policy/src/gate.ts` (C0, C1 eligibility) | 加固（conformance-1/2）：没有生效的 oracle 就不会 pass；只有当每个变更的测试文件都被摘要相同且已验证的 TestArtifact 覆盖时，生成测试的证据才被计入。 |
| PoC A：检出植入缺陷，≥2 个 PlanRevision，并行子 Agent，≥3 个角色使用不同路由策略 | 技术选型 §PoC A | 已实现 | `packages/eval/src/suites/poc-a.ts`<br>`packages/eval/src/poc-graders.ts` | – |
| PoC A：子 Agent 不获得无关的父级轨迹；缺陷声明引用执行证据；评审者不依赖执行者叙述；存在植入缺陷时不给 Pass；路由/工具/门禁审计可重建 | 技术选型 §PoC A | 已实现 | `packages/eval/src/poc-graders.ts` (contextIsolation, independentReview, auditReconstruction)<br>`packages/control/src/worker.ts` (taskMessage) | 加固（H7）：C6 现已满足：门禁前会请求针对运行的评审，评审者会响应。 |
| PoC B：Finding/Hypothesis/TestCase 分别建模；单一租约持有者；因果链；收敛；结论可追溯到 HTTP 证据 | 技术选型 §PoC B | 已实现 | `packages/eval/src/poc-graders.ts` (causalChain, singleLeaseOwner, reportTracesToEvidence) | – |
| PoC C：长输出不进入消息，指标引用原始证据，RCA/指标/执行者并行，按角色的模型策略，数据不足绝不 Pass，恢复审计 | 技术选型 §PoC C | 已实现 | `packages/eval/src/suites/poc-c.ts`<br>`packages/eval/src/poc-graders.ts` (offloadBounded, insufficientDataNotPassed, recoveryAudit) | K8s pod 重启与 NATS 重复投递在本地演练（进程监督器、进程内总线）；真实 K8s 路径延后。 |
| P0 修订 5：长期评测平台，区分模型/harness/多 Agent/oracle/恢复等因素 | 架构改进 §执行摘要 P0 | 部分实现 | `packages/eval/src/*` | 已改进：独立 LLM 评审器、每次试验记录的模型路由、带桥接比较的版本化评分器、发布门禁与四个新的核心套件。仍缺少 API/UI、Performance、Evidence 与 MultiAgent 套件，H0–H6 分组也只部分实现。 |
| 混沌套件（外部成功后 kill、ACK 后 kill、过期租约、NATS 重复、重试保持 opId、重启重新挂接、超时 → unknown、不可查询目标、竞争故障实验、预算耗尽） | 架构改进 §验收标准 (副作用) | 部分实现 | `packages/operation/test`<br>`packages/eval/src/suites/poc-c.ts` (recovery-chaos)<br>`packages/control/test/isolation-budget.test.ts` | 竞争的故障实验与预算耗尽由 control 测试覆盖（顺序与并发准入、压测作业比其所有者存活更久、跨运行污染、QPS 与 artifact 预算）；评测的混沌套件尚无此类用例。 |
| EvalTask/EvalTrial 数据模型（套件修订、fixture、镜像摘要、隐藏缺陷、允许的工具、oracle、安全约束、预算；harness、清单、模型路由、种子、指标、证据根） | 架构改进 §Eval 数据模型 | 部分实现 | `packages/eval/src/contracts.ts`<br>`packages/eval/src/trial-records.ts` | 试验现在记录套件 id 与修订、按角色的模型路由、评分器与 oracle 修订、试验键，以及评测 harness 的修订与模式。仍缺少 allowedTools、safetyConstraints 与 environmentImageDigest。EvalTrial.harness 指评测 harness；Agent harness 由 armId 与 runtimeManifestId 体现。 |
| Hypertest 核心评测套件（缺陷发现、测试生成、Oracle 鲁棒性、API/UI 黑盒、性能、容错、恢复、上下文新鲜度、模型切换、安全、证据、多 Agent） | 架构改进 §评测套件 | 部分实现 | `packages/eval/src/suites/*.ts` (`core.ts`: test-generation, context-freshness, model-switch, security-injection)<br>`packages/eval/src/core-graders.ts` | PoC A/B/C、oracle-robustness、recovery-chaos 以及核心套件 TestGeneration、ContextFreshness、ModelSwitch 与 Security（security-injection）都是真实的端到端运行。仍缺少 API/UI、Performance、Evidence 与 MultiAgent。 |
| 受控因果对照组 H0 … H6 与前沿产品基准（Claude Code、Codex、OpenHands、DSH、Pi） | 架构改进 §对比实验 | 部分实现 | `packages/eval/src/arms.ts` (scripted-multi-llm vs scripted-single, live arm) | 前沿产品基准延后。 |
| 多次试验 pass@k / pass^k；配对 McNemar 与 bootstrap 统计 | 架构改进 §Trial 设计 / 发布 Gate | 已实现 | `packages/eval/src/stats.ts` | – |
| 核心指标（关键误放行、召回、误报、复现、oracle 敏感度、证据完整性、恢复、重复效果、孤儿操作、策略违规、过期操作、单缺陷成本、TTFE、人工干预） | 架构改进 §核心指标 | 部分实现 | `packages/eval/src/metrics.ts` | 新增 staleMutations、securityViolations 与 mutationScore；即使评分器失败也会记录结果指标。仍没有独立复现、每个已确认缺陷的成本或人工干预指标。 |
| 结果评分器优先；独立 LLM 评审器最后使用，带 unknown 路径与人工校准 | 架构改进 §Outcome Grader 优先 / LLM Judge | **已实现**（原为部分实现） | `packages/eval/src/judge.ts`<br>`packages/eval/src/harness.ts` (grader order, decideTrialResult)<br>`packages/eval/calibration/verdict-consistency.json`<br>`packages/eval/test/judge.test.ts` | 评审器最后运行，读取原始证据包，通过自己的路由器并禁止所有试验用过的供应商（失败即关闭）。未引用证据的 pass/fail 变为 `unknown`，被计入的 unknown 使试验成为 infra_error。基于带标签证据包的校准会报告一致率与 Cohen's kappa；只有在应答路由与评分细则修订上完成校准时评审结果才计入。CI 使用脚本化评审器（`--judge scripted`）。遗留：已提交的 14 个标签与实现一同编写，仍需人工 QA 负责人确认。 |
| 评测套件/评分器版本化；评分器变更时使用桥接数据集 | 架构改进 §Eval 回滚与恢复 | **已实现**（原为部分实现） | `packages/eval/src/versioning.ts`<br>`packages/eval/src/grader-revisions.ts`<br>`packages/eval/graders.lock.json`<br>`packages/eval/test/grader-versions.test.ts` | 每个评分器都有修订号；锁文件为每个评分器的源码（以及评审器的提示词、应答 schema 与证据包预算）生成指纹，因此修改评分器必须重新定版。试验带有可比性键；评分器修订变化后，需要先做桥接比较（新旧修订在同一试验数据上运行）才能延续趋势。遗留：评分器模块的模块私有辅助函数未计入指纹。 |
| 清单：每次运行时发布都运行核心评测 | 架构改进 §工程交付评估清单 | 部分实现 | `.github/workflows/ci.yml` (`npm run eval:gate`)<br>`packages/eval/src/release-gate.ts`<br>`packages/eval/baselines/core-scripted-multi-llm.json`<br>`packages/runtime/src/releases.ts` (promotionReadiness) | CI 在每次 push 与 pull request 上运行核心套件（`eval run core` 必须所有试验通过，然后 `eval gate` 与已提交的基线比较：严重误放行不恶化、召回不显著下降、安全违规 = 0、重复副作用 = 0、证据完整度 100%）。仍为部分实现：`runtime promote` 需要一个通过的 `replay` 结果，但不特别要求核心套件（任何套件 id 都算），CI 也不会对部署特定的清单（真实模型路由）运行核心评测。 |
| 清单：每次试验使用全新环境 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/harness.ts` (fresh workdir/DB per trial) | – |
| 清单：每次试验固定模型/运行时/环境/oracle 修订 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/harness.ts`<br>`packages/eval/src/trial-records.ts` | 每次试验记录：按角色的模型路由、运行时清单、oracle、套件与评分器修订，以及评测 harness 的修订与模式。尚未记录环境镜像摘要。 |
| 清单：受控对比使用配对任务 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/suite.ts`<br>`packages/eval/src/stats.ts` | – |
| 清单：关键误放行在产品 SLO 之内 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/metrics.ts` (criticalFalseRelease)<br>`packages/eval/src/release-gate.ts` | 评测门禁会让严重误放行变差的候选失败（包括未配对与基础设施错误的候选试验）。绝对阈值属于产品决策。 |
| 清单：零重复破坏性效果 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/graders.ts` (noDuplicateSideEffects)<br>`packages/operation/src/gateway.ts` | 加固（conformance-7）：外部 http 效果同样进入台账；重放返回已记录的结果。 |
| 评测 harness 可取消（SuiteOptions signal） | BLUEPRINT §5 eval | **已实现** （原为 缺失） | `packages/eval/src/contracts.ts` (SuiteOptions.signal, TrialOptions.signal) | 加固（H11）：中止的套件不再启动新试验；进行中的试验会取消其运行或杀死子进程。`hypertest eval run` 尚未传递该信号：中断时以 130 退出，进行中的试验在后台完成。 |

## 审计、供应链与风险

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 供应链：SBOM、许可证扫描、依赖来源、漏洞扫描、fork 补丁追踪 | 技术选型 §许可证策略 | **部分实现**（原为缺失） | `scripts/sbom.mjs`<br>`scripts/license-check.mjs`<br>`scripts/license-exceptions.json`<br>`scripts/test/*.test.mjs`<br>`.github/workflows/ci.yml` (supply-chain job) | CycloneDX SBOM（`npm run sbom`；来自 `npm sbom`，否则根据 lockfile 生成并带完整性哈希与解析 URL）、基于 lockfile 的许可证策略及固定到确切许可证的已评审例外（`npm run license:check`，在 CI 中阻断），以及仅供参考的 `npm audit`。仍缺少 fork 补丁跟踪与包签名/来源证明。 |
| 审计关联（traceId、runId、planRevision、workItemId、agentId、modelEpochId、snapshotId、operationId、evidenceId、decisionId、policyDecisionId）；OpenTelemetry 关联层 | 架构改进 §审计关联 | 部分实现 | `packages/domain/src/events.ts` (correlation/causation)<br>`packages/evidence/src/ledger.ts` (traceId field) | traceId 从未设置；没有 OpenTelemetry（延后）。 |
| 清单：traceId 贯穿 Agent → 工具 → 操作 → 证据 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/domain/src/events.ts` (correlationId/causationId) | traceId 未使用；OpenTelemetry 延后。 |
| BLUEPRINT I10：模型路由、工具调用、许可、门禁评估与状态转换都发出带 run/work/agent/correlation/causation 的 L0 事件 | BLUEPRINT §1.2 I10 | 已实现 | `packages/policy/src/decision-log.ts` (policy.decided)<br>`packages/tools/src/whitebox/runtime.ts` (tool.*)<br>`packages/model/src/router.ts`<br>`packages/control/src/convergence.ts` (gate.*) | 加固（durability-10）：已付费模型调用的审计写入失败时会重试并标记 auditPending，绝不重新发送。 |

## 维护本文档

当某个变更弥补或引入缺口时，请在同一次变更中同时更新两种语言版本中的对应行，并保持汇总数字一致。只有有测试证明时需求才可标为`已实现`；无法实际验证的基础设施（真实 S3、Kubernetes、docker）保持`延后`，或在备注中注明。
