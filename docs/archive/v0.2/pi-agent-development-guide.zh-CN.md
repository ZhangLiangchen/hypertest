# HyperTest 基于 Pi 的测试 Agent 开发指南

- 状态：已接受的开发方向；工作包均为待实施目标。
- 日期：2026-09-18。
- 决策依据：[ADR-0007](adr/0007-pi-first-test-agent.md)。
- BUGate 接入依据：[ADR-0006](adr/0006-bugate-protocol-binding.md)。
- 源码核对基线：[`ff340add`](https://github.com/ZhangLiangchen/hypertest/commit/ff340add47b8f96377431823a305a021fa0851ac)。

## 1. 开发方向

**HyperTest 是基于 Pi 构建的专业测试开发 Agent。接下来优先复用 Pi 的能力，完成真实测试任务闭环；LangGraph 由实际恢复与协调需求决定是否引入。**

这里的“二次开发”指通过 SDK、工具和扩展机制实现测试领域能力，保持上游零 fork。
HyperTest 保有自己的任务、CLI、产物与 adapter 契约，既可以嵌入通用 Agent 能力，
也可以提供专业工具；不要求继承 Pi 的 UI、默认目录或全部默认工具。

Pi 没有使用 LangGraph，不妨碍外部框架调用它。但“可以组合”不足以证明“应该组合”。
我们此前把抽取 WorkflowRuntime、接入 LangGraph 放在扩大自治之前，顺序过早。
本指南替代旧 [治理与运行时改造指南](governance-runtime-refactor-guide.md) 的 HT-0～HT-5
开发顺序，保留其中仍适用的副作用核对、预算连续性和故障恢复要求。

## 2. 当前事实与待实现目标

| 项目 | 当前源码事实 | 下一步判断 |
|---|---|---|
| Pi 接入 | `pi-agent-core` + `pi-ai` 0.84.1，集中在 `src/runtime/pi/**` | 先比较继续使用 core 与复用完整 SDK 的维护成本和控制能力 |
| 模型工具 | planner 只读访问内存中的 SutContract | 按测试任务逐项开放有边界的能力，不能直接开放默认 shell/write/edit |
| 测试执行 | 已有确定性 plan/render/execute/diagnose/repair/publish 路径 | 保留为基线，把适合 Agent 使用的领域操作暴露为受控工具 |
| LangGraph | 未安装、未接入 | 不作为下一阶段前置工作 |
| BUGate | 仍有 v1 gate/receipt 集成；ADR-0006 是 2.0 目标契约 | 维护当前失败关闭行为，待正式协议稳定后迁移 |
| 恢复 | run ledger 与产物记录不等于完整 durable resume | 明确实际支持的恢复粒度，再补齐具体场景 |

本次决策没有切换 SDK、增加工具权限、修改 schema 或交付上述目标能力。
PRD、源码理解、完整自主诊断等也不能因为目标图中存在，就标记为当前已实现。

## 3. Pi 的复用深度如何选择

| 方案 | 适合的条件 | 必须承担或验证的成本 |
|---|---|---|
| 继续使用 `pi-agent-core` | 现有受限工具循环足够，需要精确控制调用与事件 | 自己承担未由 core 提供的会话生命周期、压缩和恢复集成；避免重复造通用 harness |
| 采用 Pi Coding Agent SDK | 其会话、上下文和扩展设施能直接满足产品需要 | 验证工具可裁剪、工作区隔离、事件映射、预算及协议补注；不能接受不受控的默认行为 |

优先复用成熟、适配需求的上游能力，不以“包越底层越好”或“完整 SDK 必然更好”作为标准。
“使用完整 SDK”也不等于必须使用完整 CLI/TUI。

首个评估至少覆盖：

1. 自定义工具能否作为明确 allowlist 注入，是否存在越过 facade 的默认工具。
2. 会话开始、结束、取消、超时与事件终态，能否适配现有 AgentRuntime 契约。
3. 长上下文压缩后，能否重新注入任务约束和所绑定的 BUGate 协议上下文。
4. usage、重试与缓存 token 是否可准确归集；无法观测的部分如何显式表示。
5. session 与 workspace 能否隔离；持久化内容是否可控，是否包含凭证或无关数据。
6. 同一任务的会话恢复、产物恢复与外部动作核对分别由谁承担。

记录实际测试的版本、失败样例、适配改动量和回退方式。ADR-0002 当前仍只批准
`pi-agent-core` 为 Agent SDK；完整 SDK 评估通过后，先以独立决策修订依赖约束、
边界检查和迁移计划，再切换生产实现。本指南不允许提前放宽检查或同时运行两套 loop。

## 4. 职责与状态归属

| 部分 | 负责 | 接口边界 |
|---|---|---|
| Pi | 模型交互、Agent 循环、工具调度及所选版本支持的会话能力 | HyperTest 的 AgentRuntime；Pi 类型留在 `src/runtime/pi/**` |
| HyperTest | 任务、工作区、预算、工具能力、产物、证据、修复与发布策略 | 自有领域契约；继续复用 process/artifact adapters |
| BUGate 2.0 | 测试方法、Artifact/Evidence/Claim 要求与 AssessmentResult | 无状态、与 SUT/模型/harness/runtime 解耦的协议 |
| 后续可选运行时 | 有明确需求的任务协调、等待与恢复 | 独立选型后再建立边界，不接管 Pi 内部推理循环 |

同一任务只拥有一个 Agent 会话管理者。HyperTest 的 run 记录保存任务身份、source
revision、配置版本、session 引用、预算、修复次数和产物引用；Agent 会话保存其所需的
对话与工具交互。两者用稳定身份关联，不能分别推进同一套任务真源。

证据来自实际 adapter/tool 执行及可追溯来源。模型的结论是待验证的 Claim，不能把
“测试通过”的自然语言描述当作 runner 结果。长期记忆或 Context Runtime 提供辅助上下文，
不能覆盖当前源码、协议绑定或真实执行证据；它也不自动成为工作流调度器。

任务状态和操作记录由 HyperTest 持有，可先沿用工作区内版本化文件与不可变产物。
BUGate 不管理 HyperTest 的 host-state、会话、worker、重试或 checkpoint。文件落盘
本身不证明任意阶段可恢复，更不证明外部效果恰好执行一次。

## 5. 先做出的测试任务闭环

首个闭环从已有契约输入和两个 conformance 场景出发，逐步扩展到 PRD、代码仓库、
测试环境与已有测试。输入能力尚不支持时明确报告，不能假装已经理解完整业务。

1. HyperTest 固定任务、source revision、允许访问的 workspace、预算和完成标准。
2. 根据当前任务注入测试上下文与适用的协议要求。
3. Pi Agent 选择分析策略、查询工具与下一步动作，产出结构化测试意图和候选修改。
4. HyperTest 校验产物，通过现有框架/沙箱 adapter 实现并执行测试，保存真实证据。
5. 对失败形成可验证诊断；仅对允许的安全类别进行受控修复，随后重新执行验证。
6. 生成绑定输入、产物和证据的报告。需要发布时走独立的 HyperTest 发布策略与 SCM adapter。

这是任务的验收闭环，不是固定的六节点图。证据足够时不强制继续探索；测试成功不强制
进入诊断/修复；失败为 SUT 缺陷时可以形成缺陷报告并停止，不以“全部变绿”为目标。
正常结束、证据不足、预算耗尽、需要人工和真实缺陷都应有明确结果。

现有 orchestrator 保留为对照与兼容入口。按需抽取可测试的领域操作，不先重写整个
状态机或通用调度框架。扩大 Agent 自主性时，确定性验证、预算、deadline、两轮修复
上限及不得弱化 oracle 的约束继续由代码执行。

## 6. BUGate 如何持续生效

按 ADR-0006，目标接入是：绑定精确协议版本与 digest，按任务编译上下文，收集
Artifact/Evidence/Claim，提交 BUGate Assessment，由 HyperTest 决定继续、返工、升级或停止。
BUGate 的评估结果不直接构成工具权限。

协议要求不能只作为开头的一大段 prompt。HyperTest 在创建 Agent、分配工作包、
上下文压缩后、恢复会话和切换模型/worker 时，根据外部 ProtocolBinding 重新补注。
未来若支持子 Agent，也必须独立继承绑定；当前不据此新增多 Agent 调度。

找不到精确协议包、digest 不一致或声明的 required assessment 未完成时，明确阻断相应
协议流程，不能静默升级版本或把缺失结果当作通过。评估之后哪些动作允许继续，由
HyperTest 的确定性策略规定。

BUGate 2.0 尚未提供稳定的机器可读 bundle/schema 时，先保持接缝与兼容测试，继续执行
当前 v1 gate 的失败关闭行为；不要另造私有协议，也不要阻塞与协议无关的 Pi 能力评估。
目标协议接入和旧 gate 退出必须在独立迁移中一起验收。

## 7. 何时才评估 LangGraph

满足下列某个实际场景，并证明现有 Pi 集成与简单任务生命周期不足时，再做选型：

- 任务需要跨进程重启后恢复长期的人工决定或外部事件等待。
- 多个工作包需要独立持久化、并行执行与汇合，单会话无法清楚表达它们的生命周期。
- 局部失败要求恢复已完成操作、处理重复投递和未决外部效果，手写通用机制开始成为维护负担。

“任务有多个步骤”“需要日志”“有重试”或“Pi 本身没有用 LangGraph”都不是引入理由。
出现需求也不自动选定 LangGraph；记录失败场景、现有设施与候选运行时的对比和维护成本，
先用 PoC 验证恢复、预算连续性及效果核对，再独立决策。

若最终采用图，节点对应有意义的任务或外部效果边界，不复制 Agent 的每次思考和工具选择。
把一个 Pi 调用包装成节点，不会自动得到每次内部工具调用的恢复能力。

即使暂不引入框架，也要真实声明恢复粒度：会话继续、阶段重跑、操作恢复是不同能力。
副作用派发前记录稳定 operation 身份和意图，完成后保存结果；响应丢失先查询或核对。
未知效果不能当作“没有执行”；无法核对时暂停并交人工，不能靠换 run ID 掩盖旧动作。
不存在可靠恢复能力时，显式拒绝 resume，比重启后悄悄重复修改更符合产品契约。

## 8. 接下来按这些工作包推进

这些是新计划 ID，不是已交付能力或 PR 编号；不继续执行旧 HT-0～HT-5 排期。

| ID | 工作内容 | 前置条件 | 验收产物 |
|---|---|---|---|
| HT-P0 | 盘点 Pi/core 已承担与缺失的能力；用同一受限任务比较 core 与完整 SDK | 当前代码与锁定版本 | SDK 能力矩阵、失败样例、复用/保留决定、预算与权限对照；依赖变更另行决策 |
| HT-P1 | 基于选择的 Pi 接入方式完成一个测试任务闭环；把现有领域操作接为受控工具 | HT-P0；维持当前 gate 兼容 | 两个异构场景的真实执行证据；成功、缺陷、证据不足和安全停止结果；不依赖 LangGraph |
| HT-P2 | 对接正式 BUGate 2.0 binding、补注与评估契约，迁移旧 gate 语义 | 稳定协议 bundle/schema/version/digest；HT-P1 的任务边界 | 精确版本绑定、压缩后补注、缺包/错 hash/评估失败负测；业务动作权限由 HyperTest 负责 |
| HT-P3 | 补齐闭环实际需要的会话与操作恢复，按声明粒度做故障注入 | HT-P1；涉及新协议的恢复依赖 HT-P2 | 中断后不丢预算和修复计数、不盲目重发效果；明确支持范围与未解决需求 |
| HT-P4（条件项） | 对无法由现有集成合理满足的协调需求评估 LangGraph 等候选 | HT-P3 提供具体缺口 | 单独 ADR、恢复 PoC、维护成本、迁移/回退方案；没有缺口就不启动 |

HT-P2 的协议准备可与 HT-P1 并行。HT-P3 的身份和副作用设计必须在开放相应写入能力前考虑，
不能等到恢复测试时才补；该工作包负责完成并验证实现。**下一批先做 HT-P0，再做 HT-P1。**

## 9. 开发与验收约束

- 同时维持 Python/pytest/HTTP 与 Go/go test/CLI；换场景不修改公共 Core/schema。
- 保留版本化产物、真实工具结果、source revision、输入输出 hash 和失败分类。
- 模型只能调用已授予的工具；引入 SDK 不自动扩大宿主写入、网络或 SCM 凭证范围。
- 取消、超时、Provider 错误、无效输出和工具失败都要走可验证的终态。
- 修复不能跳过测试、弱化断言、吞异常或接受错误 SUT 行为；保持最多两轮的当前限制。
- 只记录需要的输入、工具事件、产物、用量和诊断依据，不依赖模型私有思维链作为恢复记录。
- 对比基线记录任务完成质量、缺陷分类准确性、证据完整性、调用/token 成本和耗时；先固定
  场景与可接受标准，再评估新增能力，不以接入框架数量或单纯 PASS 数量作为进展。
- 每个生产变更提供相关失败路径测试、实际支持能力、迁移与回退说明；不同时重写
  harness、领域 schema、所有 adapters 和流程运行时。

提交前遵循仓库现有验证要求：

```bash
npm ci --ignore-scripts
npm run ci
npm run test:examples
```

Live-model 测试维持显式 opt-in。默认验证不需要付费模型、真实 SCM 发布或生产环境权限。

## 10. 文档优先级与参考

- 产品开发方向与顺序：[ADR-0007](adr/0007-pi-first-test-agent.md) 与本指南。
- BUGate 2.0 边界：[ADR-0006](adr/0006-bugate-protocol-binding.md) 与 [协议集成设计](design/bugate-protocol-integration.md)。
- 当前生产 SDK/import 约束：[ADR-0002](adr/0002-single-agent-sdk.md)、AGENTS.md 和边界检查。
- 当前模型能力：[model-runtime.md](model-runtime.md)；当前代码与测试不能由目标文档代替。
- ADR-0005、旧治理指南及四篇原始方案保留历史依据；冲突的框架选型和 BUGate 授权定位不再指导新开发。

官方参考：[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、
[LangGraph 定位](https://docs.langchain.com/oss/javascript/langgraph/overview)、
[LangGraph 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)。
“基于 Pi 开发、按需编排”是本项目结合已有代码和目标作出的工程选择，不是上游的强制要求。
