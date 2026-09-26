# 设计符合度

[English](CONFORMANCE.md) | 简体中文

代码对设计来源的符合程度：[技术选型](../design/technology-selection.zh-CN.md)、[架构改进](../design/architecture-improvements.zh-CN.md) 以及[实施蓝图](BLUEPRINT.md)中的不变量。每条需求一行。状态描述的是**当前**（加固之后）的代码，已对照 `src/` 与测试核实（类型检查、边界检查以及在 PGlite 和 PostgreSQL 上的完整测试套件均通过）。H4、conformance-7 等编号指该次加固中的问题编号，可在各包 README 与测试中找到。

## 汇总

| 状态 | 含义 | 行数 | 审计时 |
|---|---|---|---|
| 已实现 | 已按规格完成；备注列出已知限制 | 108 | 87 |
| 部分实现 | 可用，但部分需求尚未满足 | 48 | 67 |
| 缺失 | 未实现 | 5 | 7 |
| 延后 | 有意延后，或已实现但未在真实基础设施上验证 | 3 | 3 |
| **合计** | | **164** | 164 |

按领域：

| 领域 | 已实现 | 部分实现 | 缺失 | 延后 |
|---|---|---|---|---|
| [产品定义与原则](#产品定义与原则) | 3 | 0 | 0 | 0 |
| [Agent 运行时、引擎与子 Agent](#agent-运行时引擎与子-agent) | 6 | 2 | 0 | 1 |
| [多模型路由与模型切换](#多模型路由与模型切换) | 12 | 0 | 1 | 0 |
| [规划、调度与协作](#规划调度与协作) | 12 | 2 | 0 | 0 |
| [上下文引擎、新鲜度与学习](#上下文引擎新鲜度与学习) | 8 | 6 | 1 | 0 |
| [持久执行与恢复](#持久执行与恢复) | 7 | 0 | 0 | 0 |
| [证据](#证据) | 7 | 3 | 0 | 2 |
| [Oracle、实验、测试资产与 QualityGate](#oracle实验测试资产与-qualitygate) | 15 | 7 | 0 | 0 |
| [工具、沙箱与权限](#工具沙箱与权限) | 8 | 6 | 0 | 0 |
| [副作用、租约与预算](#副作用租约与预算) | 15 | 4 | 0 | 0 |
| [运行时清单与发布](#运行时清单与发布) | 1 | 4 | 2 | 0 |
| [评测平台与 PoC 验收](#评测平台与-poc-验收) | 13 | 12 | 0 | 0 |
| [审计、供应链与风险](#审计供应链与风险) | 1 | 2 | 1 | 0 |

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
| 角色目录包含异构评审者、压缩器、视觉/GUI 与本地/私有 Agent | 技术选型 §Multi-LLM Router | 部分实现 | `packages/agents/src/roles/*.ts` | 12 个角色（含 condenser）；没有视觉/GUI 或本地/私有角色。加固（H10）：评审者独立于全部六个产出证据的角色（EVIDENCE_PRODUCER_ROLES）。 |
| 子 Agent 运行时：spawn/resume/message/interrupt/collect、可续跑、后台、嵌套委派、深度/数量上限 | 技术选型 §Subagent Runtime | 部分实现 | `packages/runtime/src/subagents.ts`<br>`packages/control/src/domain-tools/work.ts` (delegate)<br>`packages/control/src/worker.ts` | Worker 始终以 continuable:false/background:false 创建子 Agent；delegate 为前台调用（父 Agent 等待）。 |
| SpawnRequest 契约（workItemId、角色、模型/工具策略、权限配置、contextSnapshotId、outputSchema、maxDepth、预算） | 技术选型 §Subagent Runtime | 已实现 | `packages/runtime/src/contracts.ts`<br>`packages/control/src/worker.ts` (SpawnRequest) | – |
| P0 修订 1：自有 ABI + Runtime Adapter + 外科式 fork；DSH 作为首个适配器 | 架构改进 §执行摘要 P0 | 延后 | `packages/runtime` (native)<br>`packages/runtime-pi`<br>no runtime-dsh package | ABI 与两个引擎（native、Pi）已完成；DSH 适配器明确为后续工作（ADR-0008）。 |
| AgentEngine ABI（createSession、runTurn、spawnChild、resumeChild、interrupt、inspect、dispose）+ EngineCapabilities | 架构改进 §核心接口 | 已实现 | `packages/runtime/src/contracts.ts` | – |
| Fork 决策门（默认 pin + 适配器；只有不可消除的缺口才做外科式 fork） | 架构改进 §Fork 决策门 | 已实现 | `packages/runtime-pi/src/version.ts` (exact pi-agent-core pin, fail closed) | – |
| 清单：领域代码不依赖 DSH 内部类型 | 架构改进 §工程交付评估清单 | 已实现 | `scripts/check-boundaries.mjs` | – |

## 多模型路由与模型切换

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 原生多模型：ModelPolicy 是 WorkItem/AgentSpec 的一等属性 | 技术选型 §原则 | 已实现 | `packages/domain/src/agent.ts` (ModelPolicy)<br>`packages/domain/src/plan.ts`<br>`packages/control/src/worker.ts` (tightenModelPolicy) | – |
| ModelRequest/ModelRoute 契约（角色、任务类型、能力、结构化输出、风险、隐私、token/延迟/成本预算、禁用供应商、contextSnapshotId、fallbackChain、capabilityProfileRevision） | 技术选型 §Multi-LLM Router | 已实现 | `packages/model/src/contracts.ts` (RouteRequest, RouteDecision)<br>`packages/domain/src/agent.ts` (ModelPolicy) | – |
| 路由顺序：安全 → 能力 → 角色 → 质量 → 延迟 → 成本，绝不成本优先 | 技术选型 §Multi-LLM Router; BLUEPRINT I3 | 已实现 | `packages/model/src/router.ts` (ROUTING_STAGES) | – |
| 回退需重新授权（安全 + 能力），失败即关闭 | 技术选型 §Multi-LLM Router | 已实现 | `packages/model/src/router.ts` (invoke re-validation, fallback) | – |
| 风险缓解：针对限流/价格变化的模型熔断器 | 技术选型 §关键风险 | 缺失 | `packages/model/src/router.ts` | 只有单次调用的重试与回退。 |
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
| WorkItem 模式（capabilityRequirements、模型/工具策略、inputRefs、expectedOutput、evidenceRequirements、dependsOn、预算、优先级、状态） | 技术选型 §Dynamic Scheduler | 部分实现 | `packages/domain/src/plan.ts` | capabilityRequirements 会被存储但从不强制执行（H9 只对环境类别做了交集）。 |
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
| L0 事件存储：PostgreSQL 仅追加的不可变历史 | 技术选型 §Context Engine | **已实现** （原为 部分实现） | `packages/collab/src/event-store.ts`<br>`packages/collab/src/migrations.ts` (collab/005-append-only) | 加固（conformance-15）：数据库触发器拒绝对 ht_events 与各规格修订表的 UPDATE/DELETE/TRUNCATE；ht_decisions 只允许单向设置重新评估标记。 |
| L1 提示词组装（角色、目标、工作项、BUGate、技能、工具、记忆、检索、证据引用） | 技术选型 §Context Engine | 已实现 | `packages/context/src/assembler.ts`<br>`packages/control/src/context-provider.ts` | 没有技能段（没有技能注册表）。 |
| L2 工作上下文：基于事件视图的 HARD/SOFT 压缩；优先卸载到 artifact | 技术选型 §Context Engine | 部分实现 | `packages/context/src/working.ts`<br>`packages/control/src/context-provider.ts`<br>`packages/tools/src/whitebox/runtime.ts` (offload) | 只有硬压力会触发压缩；软延迟未被使用。 |
| L3 混合检索：FTS/ripgrep + 符号图（tree-sitter/LSP/SCIP）+ 向量（pgvector） | 技术选型 §Context Engine | 部分实现 | `packages/context/src/retrieval/*.ts`<br>`packages/app/src/compose.ts` | 应用只接入了 Symbol + Exact；VectorIndex 未接入；符号提取基于正则。 |
| L4 持久上下文：PowerContext 作为独立服务（派生记忆，而非事实） | 技术选型 §Context Engine; 架构改进 选型 | 已实现 | `packages/context/src/powercontext.ts`<br>`packages/app/src/compose.ts` (memory.kind powercontext) | 未对真实服务测试（没有可用端点）。 |
| L5 溯源：结论 → 证据 → 工具运行 → 环境 → 提交 | 技术选型 §Context Engine | 已实现 | `packages/context/src/provenance.ts`<br>`packages/control/src/report.ts` | 提交指基线提交；对于有改动的工作树，test.run 证据会额外记录 workspaceDelta（树摘要与变更文件）（conformance-2）。 |
| 学习：候选经验 → 评审/评测 → 批准 → 候选技能 → 验证 → 发布；幻觉不进入记忆 | 技术选型 §Learning | 部分实现 | `packages/context/src/experience.ts`<br>`packages/control/src/convergence.ts` (proposeExperience)<br>`packages/cli/src/commands` (experience) | 加固（conformance-13，部分）：提供人工评审入口 `hypertest experience list\|review`（创建者不能评审自己的候选）。没有技能注册表。 |
| P0 修订 2：ContextSnapshot 作为一致性契约，包含 ReadSet、环境代际与新鲜度策略 | 架构改进 §执行摘要 P0 | 部分实现 | `packages/context/src/freshness.ts`<br>`packages/context/src/snapshots.ts`<br>`packages/control/src/context-provider.ts` (observedReadSet) | 加固（conformance-3）：ReadSet 固定所有已注册环境以及每个输入 finding 的谱系头。文件、指标时间窗等其他观察不会被记录。 |
| ContextSnapshot 字段（eventSeq、blackboardRevision、planRevision、runtimeManifestId、modelEpochId、systemModel/oracle/experiment/policy 修订、环境代际 + 构建摘要、evidenceRootHash、readSet、createdAt） | 架构改进 §ContextSnapshot | 已实现 | `packages/domain/src/context.ts`<br>`packages/context/src/snapshots.ts` | 结构完整；ReadSet 内容有限（见 P0 修订 2）。 |
| FreshnessGuard 在副作用前复核构建摘要、环境代际、oracle 升级、已撤回的 finding、租约持有者与指标时间窗 | 架构改进 §ContextSnapshot | 部分实现 | `packages/context/src/freshness.ts` (ALWAYS_CHECKED_TYPES)<br>`packages/context/src/resolvers.ts` | 加固（conformance-3）：环境（全部已注册）、构建、oracle、实验、租约与 finding 始终会被检查。指标时间窗未被观察。 |
| 清单：ContextSnapshot 不可变 | 架构改进 §工程交付评估清单 | 已实现 | `packages/context/src/snapshots.ts` (content-hashed id)<br>`packages/context/src/freshness.ts` (re-hash check) | – |
| 清单：变更类操作检查 ReadSet（100%） | 架构改进 §工程交付评估清单 | 部分实现 | `packages/tools/src/whitebox/runtime.ts` (step 6)<br>`packages/context/src/freshness.ts` | 每次变更类调用都会运行守卫；ReadSet 只包含环境与输入 finding（conformance-3）。 |
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
| GateSpec/GateDecision（pass/fail/conditional/needs_review、违反的规则、评审决定、策略修订） | 技术选型 §BUGate | 部分实现 | `packages/domain/src/testing.ts` (GateSpec, QualityDecision)<br>`packages/policy/src/gate.ts` | 加固（conformance-9，部分）：每个决定都对 gateSpecDigest 与 gateOverrides 签名。放宽门禁的覆盖项不需要记录授权人；needs_review 以 requiresHumanReview 表示。 |
| BUGate 在四个时点生效：行动前、行动后、状态转换前、最终验收前 | 技术选型 §BUGate | 部分实现 | `packages/policy/src/contracts.ts` (phases)<br>`packages/tools/src/whitebox/runtime.ts` | PolicyEngine 只在 before_action 时评估；状态转换与验收由确定性代码治理，而非运维策略/OPA。 |
| 评审者无法绕过确定性门禁（覆盖率、关键测试失败、证据缺失、未解决的 P0/P1、环境无效） | 技术选型 §BUGate | 部分实现 | `packages/policy/src/gate.ts` (C2–C8)<br>`packages/control/src/util.ts` (gateSpecProblems) | 加固（H3）：覆盖项会被校验，C2/C7 在阈值未知时失败即关闭。仍没有专门的环境有效性准则（环境类 finding 只会让 C2 变为 unknown）。 |
| P0 修订 3：在证据与门禁之间治理 Oracle / 实验有效性 / TestArtifact | 架构改进 §执行摘要 P0 | 部分实现 | `packages/policy/src/{oracle-governance,gate,classifier}.ts`<br>`packages/control/src/domain-tools/specs.ts` | 加固（conformance-1/2/10）：oracle 成为必需（C0），生成的测试绑定其内容摘要与代码。实验隔离仍未强制执行（conformance-6）。 |
| SystemModel 带版本（组件、接口、依赖、状态机、不变量、风险标签、来源）；从不作为 oracle | 架构改进 §SystemModel | 已实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` (system_model.record) | – |
| OracleSpec 含 authorities、judgePolicy、changePolicy（selfApprove 为 false）、approvedBy | 架构改进 §OracleSpec | 已实现 | `packages/domain/src/testing.ts`<br>`packages/policy/src/oracle-governance.ts` | – |
| Oracle 强度分层；P0/P1 门禁绝不只依赖 LLM | 架构改进 §OracleSpec; BLUEPRINT I7 | 已实现 | `packages/domain/src/testing.ts` (ORACLE_STRENGTH)<br>`packages/policy/src/gate.ts` (C0, C3) | – |
| Agent 可以提议但绝不能批准会翻转已记录失败的 OracleRevision；需独立/人工批准 | 架构改进 §OracleSpec; BLUEPRINT I8 | **已实现** （原为 部分实现） | `packages/policy/src/oracle-governance.ts` (assertMayDecide)<br>`packages/policy/src/gate.ts` (evaluateOracleCheck)<br>`packages/app/src/governance.ts` | 加固（H8）：翻转检测使用门禁自身的 evaluateOracleCheck 评估所有检查类型。 |
| Oracle 变更 → 新修订 → 新实验；基于旧修订的决定标记为 needs_reassessment；不改写历史 | 架构改进 §Oracle 与实验流程 / 回滚 | 部分实现 | `packages/policy/src/oracle-governance.ts`<br>`packages/collab/src/decisions.ts`<br>`packages/policy/src/gate.ts` (currentOracleRevisions) | 加固（conformance-4）：运行中其固定的 oracle 修订被取代时，C0 为 unknown（inconclusive）。不会自动创建新实验。 |
| ExperimentSpec（对象、环境代际、fixture、负载、故障计划、种子、隔离 + claim、预算、证据要求、停止条件、污染规则） | 架构改进 §ExperimentSpec | 部分实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` | Fixture、种子、停止条件与污染规则始终为空（conformance-6）。 |
| TestArtifact 契约与生命周期（生成 → 静态 → 已知正确通过 → 已知错误/变异失败 → oracle 评审 → 合格） | 架构改进 §TestArtifact | **已实现** （原为 部分实现） | `packages/domain/src/testing.ts`<br>`packages/control/src/domain-tools/specs.ts` (register/validate)<br>`packages/policy/src/gate.ts` | 加固（conformance-2/10）：验证会将 artifact 摘要与记录的 workspaceDelta 比对，并要求已知正确与已知错误运行基于不同代码。 |
| QualityDecision（含 inconclusive 的结论、修订、evidenceRootHash、准则、风险、例外、评审决定、清单、签名、supersedes） | 架构改进 §QualityDecision | 已实现 | `packages/domain/src/testing.ts`<br>`packages/control/src/convergence.ts` (signed)<br>`packages/cli/src/commands` (waive) | 加固（conformance-11）：例外来自人工批准的 gate_exception（`hypertest waive`）；C1 永不可豁免。 |
| 自愈表：定位器/环境自动；fixture/测试缺陷/超时有条件；断言/阈值/删除测试需批准或禁止；产品代码按权限 | 架构改进 §Test Judge 与自愈治理 | 已实现 | `packages/policy/src/classifier.ts`<br>`packages/control/src/dispatcher.ts` (govern, drift quarantine)<br>`packages/tools/src/whitebox/worktree-state.ts` | 加固（security-1、H1）：漂移检测将工作树字节与基线树比对哈希（index 标志、replace 引用、过滤器与 Agent 写入的 .gitignore 都无法隐藏变更）。残留风险见隔离层级一行。 |
| 清单：构建/组件/接口带版本且可追溯（SystemModel） | 架构改进 §工程交付评估清单 | 已实现 | `packages/collab/src/specs.ts`<br>`packages/control/src/domain-tools/specs.ts` | – |
| 清单：OracleSpec 独立于 Agent 叙述 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/oracle-governance.ts`<br>`packages/app/src/compose.ts` (oracles config)<br>`packages/cli/src/commands` (oracle establish) | 加固（conformance-1）：由人通过 `oracles:` 配置段或 `hypertest oracle establish` 建立 oracle；Agent 无法建立。 |
| 清单：执行者无法自我批准 oracle 变更（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/policy/src/oracle-governance.ts` (assertMayDecide)<br>`packages/policy/src/engine.ts` (agent tool deny)<br>`packages/cli/src/commands/decide.ts` | 加固（H1、H8）：设置了 HYPERTEST_SANDBOX 时 CLI 拒绝人工决定，两种沙箱都会设置该变量且调用方无法移除；翻转检测覆盖所有检查类型。 |
| 清单：断言/阈值不能被自动放宽（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/classifier.ts`<br>`packages/control/src/dispatcher.ts`<br>`packages/tools/src/whitebox/worktree-state.ts`<br>`packages/app/src/governance.ts` | 加固（security-1、H1、H8）：防篡改的漂移检测、参数限制与沙箱 jail；放宽指标阈值会被识别为翻转。本地沙箱的主机残留暴露见隔离层级一行。 |
| 清单：关键生成测试有敏感度检查 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/control/src/domain-tools/specs.ts` (test_artifact.validate)<br>`packages/policy/src/gate.ts` | 加固（conformance-2/10）：变更测试文件的证据只有通过已验证、摘要匹配、且已知正确与已知错误运行基于不同代码的 TestArtifact 才被计入。 |
| 清单：实验记录构建/环境/数据/负载/故障 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/control/src/domain-tools/specs.ts` | Fixture 与种子为空；证据不携带 experimentId。 |
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
| ActionCapability；子能力 = 父 ∩ 角色 ∩ WorkItem ∩ 环境策略；绝不放大 | 架构改进 §安全与权限边界; BLUEPRINT I2 | 部分实现 | `packages/policy/src/capabilities.ts`<br>`packages/control/src/worker.ts` | 加固（H9）：环境类别会与已注册环境取交集。WorkItem 的 capabilityRequirements 不参与交集。 |
| 清单：子权限只会收缩（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/capabilities.ts` (attenuateCapability)<br>`packages/runtime/src/subagents.ts`<br>`packages/control/src/worker.ts` | 加固（H9）：根能力与衰减后的能力只携带已注册环境的类别。WorkItem 要求仍未参与交集（见 ActionCapability）。 |
| 清单：LLM 从不接收长期静态凭据 | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/whitebox/sandbox.ts` (scrubbed env)<br>`packages/tools/src/whitebox/runtime.ts` (redactSecrets)<br>`packages/app/src/environments.ts` | 没有密钥代理或临时凭据。 |
| 清单：沙箱出站有策略 | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/tools/src/whitebox/netns.ts`<br>`packages/tools/src/whitebox/sandbox.ts` (OCI --network none)<br>`packages/tools/src/blackbox/common.ts` (tool-level egress) | 加固（security-2）：本地命令只能访问自身 loopback 以及被中继的 SUT 端点；无法隔离的主机会拒绝执行（失败即关闭）。`sandbox.network: open` 是显式的退出选项。 |
| 清单：关键 allow/deny 决定可重放（100%） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/policy/src/decision-log.ts` (request + permit + revision)<br>`packages/app/src/compose.ts` (opaPolicyRevision) | 加固（conformance-12）：OPA 修订号是所服务决策包模块的摘要，因此策略变更会改变修订号与清单。 |
| 清单：零未授权破坏性操作 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/metrics.ts` (policyViolations)<br>`packages/policy/src/engine.ts`<br>`packages/tools/src/whitebox/argv-guard.ts` | 加固（security-H1a、H1）：参数限制与 jail 堵住了审计发现的逃逸。运行时自行计算路径的程序仍能以同一 uid 写入隐藏路径之外的位置；不受信任的模型需要 OCI 沙箱。 |

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
| ResourceClaim 模式（read_shared/write_exclusive/fault_exclusive）、层级键、实验前原子准入 | 架构改进 §并发实验隔离 | 部分实现 | `packages/operation/src/admission.ts`<br>`packages/control/src/scheduler.ts` (work-item claims) | 工作项已有准入（以 admission.* 事件审计，durability-2），但未与实验或工具绑定（conformance-6）。 |
| BudgetEnvelope 作为租约：对 Agent、模型、工具、算力、QPS、artifact 字节执行 预留 → 执行 → 结算 | 架构改进 §Budget 也是资源租约 | 部分实现 | `packages/operation/src/budget.ts`<br>`packages/runtime/src/invoker.ts`<br>`packages/control/src/dispatcher.ts` | 加固（H5、conformance-5 部分）：工具计费按调用幂等；超过 maxExternalQps 的 load.start 会被拒绝。算力分钟、artifact 字节以及并发任务之间的 QPS 未计费。 |
| 预算耗尽 → PAUSED_BUDGET / CONDITIONAL_STOP / NEEDS_APPROVAL，绝不静默降级 | 架构改进 §Budget | 已实现 | `packages/control/src/worker.ts` (onBudgetExhausted pause)<br>`packages/control/src/convergence.ts` (exhaustion) | – |
| 清单：每个破坏性工具都有 operationId（100%） | 架构改进 §工程交付评估清单; BLUEPRINT I4 | **已实现** （原为 部分实现） | `packages/tools/src/blackbox/env-tools.ts` (bound)<br>`packages/tools/src/whitebox/record-effects.ts` (http/browser/mcp) | 加固（conformance-7）：没有自有适配器的工具通过以调用 id 为键的仅记录适配器执行；缺少这些适配器的网关会拒绝此类工具。 |
| 清单：支持的目标会收到幂等键（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/blackbox/http.ts` (Idempotency-Key)<br>`packages/tools/src/blackbox/env-adapters.ts`<br>`packages/tools/src/blackbox/load.ts` | – |
| 清单：超时 ⇒ outcome_unknown | 架构改进 §工程交付评估清单 | 已实现 | `packages/operation/src/gateway.ts`<br>`packages/tools/src/whitebox/runtime.ts` (runSideEffect) | – |
| 清单：可查询的外部任务会重新挂接（100%） | 架构改进 §工程交付评估清单 | 已实现 | `packages/tools/src/blackbox/load.ts` (observe by operation id)<br>`packages/eval/src/poc-graders.ts` (loadJobReattached) | – |
| 清单：写租约携带单调递增的 fencing token | 架构改进 §工程交付评估清单 | 已实现 | `packages/operation/src/leases.ts` | – |
| 清单：过期 worker 无法成功写入（0 次成功） | 架构改进 §工程交付评估清单 | **已实现** （原为 部分实现） | `packages/control/src/domain-tools/index.ts` (claimFenced)<br>`packages/control/src/dispatcher.ts`<br>`packages/tools/src/whitebox/runtime.ts` | 加固（H4）：非只读领域工具在其事务内复核认领（lease_lost）；副作用租约按认领持有，因此同一 Agent 的过期 worker 会被拒绝。 |
| 清单：每个写入/故障实验都声明 ResourceClaim（100%） | 架构改进 §工程交付评估清单 | 部分实现 | `packages/control/src/domain-tools/specs.ts` | 实验未与已准入的 claim 绑定（conformance-6，需要设计决策）。 |
| 清单：Agent/模型/工具/算力统一的 BudgetEnvelope | 架构改进 §工程交付评估清单 | 部分实现 | `packages/domain/src/run.ts`<br>`packages/control/src/control-plane.ts` | 算力分钟与 artifact 字节已声明但未计费（conformance-5）。 |
| 清单：预算耗尽时不静默回退到低质量模型 | 架构改进 §工程交付评估清单 | 已实现 | `packages/runtime/src/invoker.ts` (budget_exhausted boundary)<br>`packages/control/src/worker.ts` | – |

## 运行时清单与发布

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| RuntimeManifest 物料清单（hypertest 版本 + gitSha、引擎、供应商适配器、模式、策略包、工具目录） | 架构改进 §Runtime Manifest | 部分实现 | `packages/runtime/src/manifest.ts`<br>`packages/app/src/compose.ts` (buildRuntimeManifest) | 加固（conformance-8）：新增 hypertest.sourceDigest（对 packages/*/src 计算的 sha256）。没有 gitSha、镜像摘要或默认引擎条目。 |
| 运行时发布状态 candidate → shadow → canary → active → retiring → retired | 架构改进 §Runtime Manifest | 缺失 | `packages/domain/src/context.ts` (type only) | 没有注册表或 active 指针。 |
| 运行时回滚：停止候选版本、切换 active 指针、旧运行继续、隔离候选运行、回放套件 | 架构改进 §回滚与恢复 | 部分实现 | `packages/app/src/compose.ts` (resumeIncomplete skips foreign manifests)<br>`packages/control/src/util.ts` (assertRunPinned) | 旧运行是安全的（已固定，其他运行时会拒绝驱动）。没有 active 指针或隔离机制。 |
| 长时间运行的显式迁移（检查点 → 对账 → 兼容性 → 新 RuntimeEpoch） | 架构改进 §回滚与恢复 | 缺失 | – | 外来运行只能取消，或由其所属运行时恢复。 |
| 清单：每个 TestRun 固定到一个 RuntimeManifest | 架构改进 §工程交付评估清单; BLUEPRINT I11 | **已实现** （原为 部分实现） | `packages/collab/src/runs.ts`<br>`packages/app/src/compose.ts` (pinnedControlPlane)<br>`packages/control/src/util.ts` (assertRunPinned) | 加固（H2、conformance-8）：控制平面自身拒绝驱动固定到其他清单的运行中任务；回合会拒绝清单未固定的引擎版本；清单包含源码摘要。 |
| 清单：上游升级需要兼容性套件 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/runtime/src/contract-suite.ts`<br>`packages/runtime-pi/src/version.ts` | 只覆盖了 Pi。 |
| 清单：运行时回滚不迁移旧运行 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/app/src/compose.ts` (resumeIncomplete) | 没有发布指针。 |

## 评测平台与 PoC 验收

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 运行时所有权验收：同一目标可经至少 3 类供应商运行；运行中切换模型保持权威状态；所有模型/工具调用可审计 | 技术选型 §实施路线 Runtime ownership | 部分实现 | `packages/model/src/{openai,anthropic,pi-ai,scripted}.ts`<br>`packages/eval` (live arm opt-in) | CI 用脚本化供应商证明；未设置 HYPERTEST_EVAL_LIVE 时跳过真实模型分组。 |
| 动态多 Agent 验收：Lead 创建分析者，再并行创建设计者、执行、重规划；不硬编码 Agent 数量 | 技术选型 §实施路线 | 已实现 | `packages/eval/src/suites/poc-a.ts`<br>`packages/eval/src/poc-graders.ts` (pocAWorkflow) | 使用脚本化大脑。 |
| 去中心化验收：finding.created 无需 Lead 即可唤醒 RCA 与 TestDesigner；重复投递不产生重复效果 | 技术选型 §实施路线; PoC B | 已实现 | `packages/eval/src/suites/poc-b.ts`<br>`packages/agents/src/roles/{rca,test-designer}.ts` subscriptions | – |
| 持久性验收：kill/重启后保留计划修订、子 Agent 身份与证据；无破坏性重放；恢复等待状态与工作上下文 | 技术选型 §实施路线; PoC C | 已实现 | `packages/eval/src/suites/poc-c.ts` (child-process SIGKILL)<br>`packages/control/src/control-plane.ts` (recover) | – |
| 证据驱动验收：绝不根据 Agent 文本给出 Pass；只依据证据清单 + GateDecision | 技术选型 §实施路线 | **已实现** （原为 部分实现） | `packages/policy/src/gate.ts` (C0, C1 eligibility) | 加固（conformance-1/2）：没有生效的 oracle 就不会 pass；只有当每个变更的测试文件都被摘要相同且已验证的 TestArtifact 覆盖时，生成测试的证据才被计入。 |
| PoC A：检出植入缺陷，≥2 个 PlanRevision，并行子 Agent，≥3 个角色使用不同路由策略 | 技术选型 §PoC A | 已实现 | `packages/eval/src/suites/poc-a.ts`<br>`packages/eval/src/poc-graders.ts` | – |
| PoC A：子 Agent 不获得无关的父级轨迹；缺陷声明引用执行证据；评审者不依赖执行者叙述；存在植入缺陷时不给 Pass；路由/工具/门禁审计可重建 | 技术选型 §PoC A | 已实现 | `packages/eval/src/poc-graders.ts` (contextIsolation, independentReview, auditReconstruction)<br>`packages/control/src/worker.ts` (taskMessage) | 加固（H7）：C6 现已满足：门禁前会请求针对运行的评审，评审者会响应。 |
| PoC B：Finding/Hypothesis/TestCase 分别建模；单一租约持有者；因果链；收敛；结论可追溯到 HTTP 证据 | 技术选型 §PoC B | 已实现 | `packages/eval/src/poc-graders.ts` (causalChain, singleLeaseOwner, reportTracesToEvidence) | – |
| PoC C：长输出不进入消息，指标引用原始证据，RCA/指标/执行者并行，按角色的模型策略，数据不足绝不 Pass，恢复审计 | 技术选型 §PoC C | 已实现 | `packages/eval/src/suites/poc-c.ts`<br>`packages/eval/src/poc-graders.ts` (offloadBounded, insufficientDataNotPassed, recoveryAudit) | K8s pod 重启与 NATS 重复投递在本地演练（进程监督器、进程内总线）；真实 K8s 路径延后。 |
| P0 修订 5：长期评测平台，区分模型/harness/多 Agent/oracle/恢复等因素 | 架构改进 §执行摘要 P0 | 部分实现 | `packages/eval/src/*` | 没有 LLM 评审器，试验不记录模型路由，评分器无版本，缺少若干核心套件（conformance-16）。 |
| 混沌套件（外部成功后 kill、ACK 后 kill、过期租约、NATS 重复、重试保持 opId、重启重新挂接、超时 → unknown、不可查询目标、竞争故障实验、预算耗尽） | 架构改进 §验收标准 (副作用) | 部分实现 | `packages/operation/test`<br>`packages/eval/src/suites/poc-c.ts` (recovery-chaos) | 竞争故障实验只在工作项准入层面覆盖。 |
| EvalTask/EvalTrial 数据模型（套件修订、fixture、镜像摘要、隐藏缺陷、允许的工具、oracle、安全约束、预算；harness、清单、模型路由、种子、指标、证据根） | 架构改进 §Eval 数据模型 | 部分实现 | `packages/eval/src/contracts.ts` | 缺少 allowedTools、safetyConstraints、environmentImageDigest、harness 与 modelRoutes。 |
| Hypertest 核心评测套件（缺陷发现、测试生成、Oracle 鲁棒性、API/UI 黑盒、性能、容错、恢复、上下文新鲜度、模型切换、安全、证据、多 Agent） | 架构改进 §评测套件 | 部分实现 | `packages/eval/src/suites/*.ts` | 已有 PoC A/B/C、oracle-robustness 与 recovery-chaos；缺少测试生成、上下文新鲜度、模型切换与安全套件。 |
| 受控因果对照组 H0 … H6 与前沿产品基准（Claude Code、Codex、OpenHands、DSH、Pi） | 架构改进 §对比实验 | 部分实现 | `packages/eval/src/arms.ts` (scripted-multi-llm vs scripted-single, live arm) | 前沿产品基准延后。 |
| 多次试验 pass@k / pass^k；配对 McNemar 与 bootstrap 统计 | 架构改进 §Trial 设计 / 发布 Gate | 已实现 | `packages/eval/src/stats.ts` | – |
| 核心指标（关键误放行、召回、误报、复现、oracle 敏感度、证据完整性、恢复、重复效果、孤儿操作、策略违规、过期操作、单缺陷成本、TTFE、人工干预） | 架构改进 §核心指标 | 部分实现 | `packages/eval/src/metrics.ts` | 没有独立复现、单个确认缺陷成本或人工干预指标。 |
| 结果评分器优先；独立 LLM 评审器最后使用，带 unknown 路径与人工校准 | 架构改进 §Outcome Grader 优先 / LLM Judge | 部分实现 | `packages/eval/src/graders.ts`<br>`packages/eval/src/poc-graders.ts` | 未实现 LLM 评审器。 |
| 评测套件/评分器版本化；评分器变更时使用桥接数据集 | 架构改进 §Eval 回滚与恢复 | 部分实现 | `packages/eval/src/suites/common.ts` (POC_SUITE_REVISION) | 评分器没有版本。 |
| 清单：每次运行时发布都运行核心评测 | 架构改进 §工程交付评估清单 | 部分实现 | `.github/workflows/ci.yml`<br>`packages/eval/test` (PoC e2e with scripted brains) | CI 在每次推送时运行 PoC e2e 测试（conformance-14 修复了失效的任务）；没有发布门禁。 |
| 清单：每次试验使用全新环境 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/harness.ts` (fresh workdir/DB per trial) | – |
| 清单：每次试验固定模型/运行时/环境/oracle 修订 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/harness.ts` | 记录了清单；试验上未记录模型路由。 |
| 清单：受控对比使用配对任务 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/suite.ts`<br>`packages/eval/src/stats.ts` | – |
| 清单：关键误放行在产品 SLO 之内 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/eval/src/metrics.ts` (criticalFalseRelease) | 指标已存在；阈值属于产品决策。 |
| 清单：零重复破坏性效果 | 架构改进 §工程交付评估清单 | 已实现 | `packages/eval/src/graders.ts` (noDuplicateSideEffects)<br>`packages/operation/src/gateway.ts` | 加固（conformance-7）：外部 http 效果同样进入台账；重放返回已记录的结果。 |
| 评测 harness 可取消（SuiteOptions signal） | BLUEPRINT §5 eval | **已实现** （原为 缺失） | `packages/eval/src/contracts.ts` (SuiteOptions.signal, TrialOptions.signal) | 加固（H11）：中止的套件不再启动新试验；进行中的试验会取消其运行或杀死子进程。`hypertest eval run` 尚未传递该信号：中断时以 130 退出，进行中的试验在后台完成。 |

## 审计、供应链与风险

| 需求 | 来源 | 状态 | 代码位置 | 备注 |
|---|---|---|---|---|
| 供应链：SBOM、许可证扫描、依赖来源、漏洞扫描、fork 补丁追踪 | 技术选型 §许可证策略 | 缺失 | `.github/workflows/ci.yml` | 只有 lockfile。 |
| 审计关联（traceId、runId、planRevision、workItemId、agentId、modelEpochId、snapshotId、operationId、evidenceId、decisionId、policyDecisionId）；OpenTelemetry 关联层 | 架构改进 §审计关联 | 部分实现 | `packages/domain/src/events.ts` (correlation/causation)<br>`packages/evidence/src/ledger.ts` (traceId field) | traceId 从未设置；没有 OpenTelemetry（延后）。 |
| 清单：traceId 贯穿 Agent → 工具 → 操作 → 证据 | 架构改进 §工程交付评估清单 | 部分实现 | `packages/domain/src/events.ts` (correlationId/causationId) | traceId 未使用；OpenTelemetry 延后。 |
| BLUEPRINT I10：模型路由、工具调用、许可、门禁评估与状态转换都发出带 run/work/agent/correlation/causation 的 L0 事件 | BLUEPRINT §1.2 I10 | 已实现 | `packages/policy/src/decision-log.ts` (policy.decided)<br>`packages/tools/src/whitebox/runtime.ts` (tool.*)<br>`packages/model/src/router.ts`<br>`packages/control/src/convergence.ts` (gate.*) | 加固（durability-10）：已付费模型调用的审计写入失败时会重试并标记 auditPending，绝不重新发送。 |

## 维护本文档

当某个变更弥补或引入缺口时，请在同一次变更中同时更新两种语言版本中的对应行，并保持汇总数字一致。只有有测试证明时需求才可标为`已实现`；无法实际验证的基础设施（真实 S3、Kubernetes、docker）保持`延后`，或在备注中注明。
