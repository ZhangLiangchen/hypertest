# HyperTest 治理接缝与持久化执行改造指导

> **历史方案，停止按本文顺序安排新开发。** BUGate 授权/PDP/PEP 定位已由
> [ADR-0006](adr/0006-bugate-protocol-binding.md) 替代；必须先接入 LangGraph 的路线和
> HT-0～HT-5 排期已由 [ADR-0007](adr/0007-pi-first-test-agent.md) 及
> [Pi 开发指南](pi-agent-development-guide.zh-CN.md) 替代。正文保留决策历史和可复用的
> 故障场景，不表示新开发指令。当前 v0.2 gate 兼容行为仍须保持，直至单独迁移验收。

- 计划修订号：`2026-09-18.1`；与 BUGate 指南配套。
- 状态：已替代的 ADR-0005 历史实施路线；下列工作包、目录和契约不代表已交付功能。
- 核对基线：[`74b30c7`](https://github.com/ZhangLiangchen/hypertest/commit/74b30c747cdaf1084ad8095364f14b8292550c3f)。
- 架构依据：[ADR-0005](adr/0005-durable-workflow-runtime-and-bugate-boundary.md)、[architecture.md](architecture.md)。
- 配套：[BUGate 改造指南](https://github.com/ZhangLiangchen/BUGate/blob/main/docs/qa-methodology/BUGATE_GOVERNANCE_REFACTOR_GUIDE.zh-CN.md)。

## 1. 方向：先可靠恢复和治理接缝，再扩大自治

HyperTest 从“确定性 Orchestrator + Pi planner + BUGate bridge”演进为“自主测试系统”：
Agent 决定任务策略，确定性 Core 定义合法转换、预算和安全规则，WorkflowRuntime
负责执行持久化，BUGate 决定质量与授权，PEP 执行受保护动作。

当前首选 **LangGraph JavaScript/TypeScript**，与现有 TypeScript Core 同进程集成；
不为引入 Graph 把整个项目改成 Python，也不替换 Pi Agent Harness。
LangGraph 是可替换实现，不是新的质量权威。

实施次序：固化基线 → 抽 WorkflowRuntime/operations → 完成 BUGate/PEP 接缝 →
接入持久化 Graph → 故障恢复验收 → 扩大自治。运行时只读 PoC 可以与 PEP 开发并行，
但在接缝验收之前不能开放生产写入，也不能声称已具备强制治理闭环。

本文不会修改现有修复红线、SUT 无关约束或 Pi SDK 边界。保留上游零 fork 原则和
现有禁止 process `fork()` 的边界检查；这两条不能误读成逻辑子任务数量必须为零。
首批不引入动态多 Agent 调度。后续若采用子 Agent，需另行定义角色隔离、预算与
生命周期，不能仅凭 ADR 中“未来可创建子任务”就声称已具备该能力。

## 2. 当前实现与差距（源码核对）

| 当前模块 | 当前事实 | 改造点 |
|---|---|---|
| [`src/orchestrator.ts`](../src/orchestrator.ts) | `run()` 从 `createRunLedger` 开始；负责 plan/gate/run/repair/publish，并落事件与产物 | 拆出可调用 operations；保留 legacy runner 为对照；不是给现有函数套一个 Graph 节点就完成 durable execution |
| [`src/state-machine.ts`](../src/state-machine.ts) | 合法转换和 ledger 校验；`needs_human` 目前是 terminal state | 保留为规范/oracle；新增可恢复等待状态必须显式版本化，不能恢复旧 terminal ledger 后直接写新事件 |
| [`src/gate.ts`](../src/gate.ts) | v1 验证 request ID/hash、allow、可选 expiry、receipt ID、evidence hash 集合 | 稳定 request/operation 身份、typed obligations、authority 来源、消费和结果协议是后续增强；不能把现有接口称为完整 broker |
| [`src/artifact-store.ts`](../src/artifact-store.ts) | 写入 no-replace、读取 hash 校验；已有良好不可变基础 | 恢复时查已有 operation 输出；同路径同 hash 可显式复用，异 hash 冲突；不能盲目重写 `test-plan.json` |
| [`src/runtime.ts`](../src/runtime.ts)、`src/runtime/pi/**` | AgentRuntime 抽象及 Pi 实现，当前模型主要参与 planner | 保持 Harness 边界；节点内会话恢复另定契约，不假定 Graph 自动恢复 Pi 会话 |
| `src/adapter-protocol.ts`、test/sandbox/SCM adapters | 进程/产物契约；现有 SCM 调用传 idempotency key | 把幂等性落实到各 adapter 的效果与查询能力；不是仅传一个字符串就证明 exactly-once |
| [`package.json`](../package.json) | 当前无 LangGraph dependency | 引入时锁定测试过的版本/lockfile，扩充边界检查，不提前宣称已接入 |

`architecture.md` 的 WorkflowRuntime、brokered PEP 图是演进目标；不能据此推断当前源码
已有这些目录或隔离能力。旧 `assets/architecture.svg` 是既有实现示意，目标图/实际图
在交付相应工作包时一并校准。

## 3. 模块改动清单

先抽取行为相同的小单元，后更换执行驱动。以下路径为建议布局，尚未创建的必须在 PR
中显式标注为新增；保留原 export 和 CLI 兼容入口。

| 模块/拟议路径 | 工作内容 | 不得混入 |
|---|---|---|
| `src/workflow/runtime.ts` | HyperTest 自有 `start/resume/inspect/cancel` 概念契约、capability 声明；不支持的能力显式拒绝 | LangGraph 类型、BUGate 内部状态 |
| `src/workflow/legacy/` | 调用抽取后 operations 的旧执行路径，用于对照/回退；不伪装为可 durable resume | 第二套长期 checkpoint/调度系统 |
| `src/workflow/operations/` | 有明确输入、输出、operation ID、effect 分类的 plan/render/execute/diagnose/repair/publish 单元 | 独立修改授权事实 |
| `src/workflow/langgraph/` | Graph 编译、routing、checkpointer 适配、interrupt/resume 映射 | 质量策略判断、绕过 PEP 的副作用 |
| `src/state-machine.ts` | 合法领域转换、ledger conformance；新状态以新版本表达 | 框架存储类型或调度 API |
| `src/gate.ts` + 拟议 `src/enforcement/` | BUGate process client、PEP、operation journal/outbox、结果核对 | Agent 可自由伪造的 allow、未知 obligation 忽略逻辑 |
| `src/artifact-store.ts` | 稳定产物引用、操作输出索引、幂等恢复、来源 hash 校验 | 可覆盖的已验收 Evidence |
| `src/runtime/pi/**` | 自治模型循环和后续显式 Agent session 恢复适配 | LangGraph import、SCM 管理凭证、治理规则副本 |
| `scripts/check-boundaries.mjs`、schema/tests | 扩充依赖边界、契约及故障恢复验证 | 通过放宽检查掩盖类型泄漏 |

LangGraph imports 只在 `src/workflow/langgraph/**`；Pi SDK imports 继续只在
`src/runtime/pi/**`。两者都不进入公共 domain/gate/adapter schema。
短期不要求抽成外部 npm 包，不引入动态 plugin discovery。

## 4. 跨仓治理契约与 PEP

治理 contract 的语义、schema 和 golden vectors 由 BUGate BG-1 持有；本仓只做版本化
映射和相同 fixture 的消费者测试。详见 [BUGate 指南 §5](https://github.com/ZhangLiangchen/BUGate/blob/main/docs/qa-methodology/BUGATE_GOVERNANCE_REFACTOR_GUIDE.zh-CN.md)。

### 4.1 先建立真实的接缝

1. 保留 `QualityGate.decide` 与 gate v1 的 legacy 适配，不让新字段悄悄改变旧 hash。
2. 增强模式协商 action-grant、reserve、outcome/reconcile 能力；未知版本 fail closed。
3. `requestId`/`operationId` 在派发前持久化；重放同一动作复用身份。新的动作、patch、
   source 或 Evidence 变化，先显式创建新请求，不偷用旧授权。
4. 把原始 request 与 decision 一并保存，以便独立重算 request hash；不能只留 verdict。
5. 在具体副作用前验证 hash、scope、版本、时效/撤销、obligations、相关 role anchor；
   履行未知 obligation 失败即阻断。Issuer label 不等于可信 issuer 身份。
6. 生命周期 Receipt 是历史证据；一次性 grant 只对应具体 effect。PEP 向 BUGate
   原子占用该 grant，随后执行和回报；Grant 真源不复制进本仓 checkpoint。

### 4.2 保护实际副作用，而不只保护 Graph edge

PEP 应覆盖 patch apply、SCM publication，以及 profile 授权范围内的环境创建/删除、
issue 写入、会改变 SUT 的测试动作。先盘点真实 effect，并逐项版本化 action/capability；
不得因为当前 gate v1 只有三个 action 就把其他写入当成无保护的只读工具。

Agent 可以读允许的 repo/contract、产出候选 patch 和运行在获准 sandbox 中；但不能拿到
受保护宿主目录写入权限、治理库写权限或 SCM 发布凭证。仅包一层 TypeScript 函数不构成
隔离：需要 scoped tools、只读挂载/独立 sandbox、最小化环境变量和受控 adapter launcher。
若保留任意宿主 shell，必须如实降级为本地可审计模式。

初期实现可在同一受控本地进程内工作，但必须声明保障等级；跨进程/恶意 worker 防护
通过独立隔离测试后才能宣称。不要为追求强保障在第一阶段引入完整 IAM 平台。

### 4.3 授权消费与外部效果不是同一笔原子事务

PEP 先写 operation intent，向权威 grant store 占用授权，再派发带稳定幂等键的动作。
保存目标 operation/result ID 与 outcome；必要时通过 outbox 重试回报。BUGate CAS 与
SCM/文件系统不是分布式原子提交，不能宣称仅靠 nonce 就实现 exactly-once。

- 未 dispatch：恢复同一 operation，并重验 preconditions/lease。
- 已 dispatch 但响应丢失：按 adapter 的幂等或查询契约核对结果，不重新创建一条 PR。
- Outcome 已存但 Graph 未 checkpoint：读取已有结果继续，不重做动作。
- 无法确认效果：进入 `reconciliation_required` 并暂停/交人工，不能把超时当成“没执行”。
- Lease/fencing 必须阻止旧 worker 继续写；lease 过期不是“旧动作没发生”的证明。
- 取消任务后，已发生的外部效果也必须核对；补偿操作需要独立授权。

## 5. WorkflowRuntime 的最小恢复契约

### 5.1 身份、存储和状态所有者

| 持久化对象 | 至少绑定 | 所有者 |
|---|---|---|
| Run identity | repository/profile namespace、run ID、workflow version、source revision、input hashes、配置/adapter versions | HyperTest |
| Workflow checkpoint | thread/checkpoint ID、当前步骤、operation/artifact refs、预算/修复次数、等待/取消状态 | WorkflowRuntime |
| Domain ledger | 已接受的领域事件和顺序、schema version、合法转换 | HyperTest Core；由 checkpoint 关联的事件前缀派生/验证，不做另一套调度器 |
| Agent progress | 有版本的会话/工具调用记录、输出引用、usage、阶段内恢复点 | AgentRuntime + operation store；不要求记录模型私有思维链 |
| Governance evidence | role receipt refs、grant/consumption/outcome 的权威记录 | BUGate |
| Effect intent/outbox | operation ID、attempt、派发/查询目标 ID、待回报结果、fencing token | PEP；只管执行/投递，不是授权真源 |

Run ID 映射到稳定且有 namespace 的 thread ID，避免不同仓库/租户冲突。
重启不能用相同 run ID 再创建空 ledger；也不能重置预算、deadline 或已消费修复次数。
审批等待是否暂停预算时钟需在新 workflow version 中明确；默认不得借 resume 延长总
deadline。未知 usage 保守记录并停止超预算动作，不归零。

产物沿用不可变 store。恢复时先验证引用及 hash，再复用已完成 operation 的输出；同一
operation 出现不同输出 hash 视为冲突。对 repair attempt 使用独立输出身份；避免多个
attempt 争写固定名字。Checkpoint 只含可序列化数据/引用，不存 process handle 或秘密。

### 5.2 持久化后端与运行所有权

先做**单主机、单 active owner/run** 的最小可恢复实现，使用经过版本锁定和测试的
持久化 checkpointer；内存 saver 只用于单元测试。SQLite 可用于本地 PoC，PostgreSQL
是共享多 worker 模式的后续候选；最终选择记录在 HT-3 的依赖与运维决策中。
Checkpointer 和跨 thread store 是不同概念；配置 checkpointer 不等于获得集群调度、
分布式锁或资源 fencing。[LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

Graph state 与领域事件不要形成两个可各自前进的状态机。为每个领域事件分配稳定 ID，
设计 checkpoint 与事件前缀的提交/重放顺序；崩溃后检测缺口并核对 operation outcome。
不能为了让 ledger 看起来合法，虚构一次先前未发生的 effect。

### 5.3 大节点也要有可恢复边界

Thin Graph, Fat Agent 指主图不编排每一次思考，不等于把几百轮 Agent/tool 调用包进
不透明且不可恢复的单个节点。长阶段应保存 operation 结果、有限会话状态/工具轨迹，
或者按有系统语义的子阶段设恢复点。没有 Agent session 恢复能力时，明确声明恢复粒度
为阶段重跑；对读取/生成结果可复用证据，对副作用必须走 PEP 去重/核对。

LangGraph interrupt 恢复时，中断节点会从头重新执行；中断前的代码必须可安全重放。
因此审批前的逻辑不得隐含非幂等副作用。[LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

必须分类配置 retry，不能给全部节点套默认重试；业务断言失败不是 transport failure，
BUGate deny、未知结果和审批等待也不是瞬态错误。[LangGraph Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)

### 5.4 Human-in-the-loop 与恢复兼容

当前 `needs_human` 为 terminal；HT-1 定义新状态/ledger version 时选择显式
`suspended` + reason（拟议），并为旧结果保留 reader，禁止把旧 terminal 自动复活。

Resume input 必须包含可验证的决定/事件引用，并绑定 exact request、action、Evidence
及 source；`Command({resume: true})` 或布尔 `approved` 不能代替人类身份验证和
BUGate 重新判断。过期、重复、错误 run、Evidence 变化的批准要拒绝；Agent 不能自批。

仅相同且兼容的 workflow/schema/adapter/config 版本允许直接 resume。升级需要显式
migrator 或由旧 worker drain；不能任意把旧 checkpoint 用新 Graph 运行。不同 run 的
尝试可新建身份，但不能隐瞒旧 run 的未决外部效果。

## 6. Thin Graph 的具体映射

首个 LangGraph 版本先保持既有领域路径和效果，证明等价后再合并节点。节点数不是
质量指标；ADR 的七阶段是概念分组，不是必须严格串行的七节点算法。

| 宏观边界 | 现有逻辑映射 | 必须保留的分支/守卫 |
|---|---|---|
| Intake/evidence/analysis/plan | intake、acquire_evidence、analyze、plan | 缺证据/预算耗尽停止；Agent 不能把 unknown 改成 fact |
| Design admission + candidate patch | pre_code_gate、render、validate_patch | BUGate 拒绝/人工等待；validation 后仍需具体 apply authorization |
| Execute | execute、test/sandbox adapter | 成功走 verify；失败走 diagnose；重放不得无条件重复改变 SUT 的测试 |
| Diagnose + repair admission | diagnose、repair_gate | SUT defect/环境/不确定原因停止；安全类型且预算允许才可修复 |
| Remediate | repair | 精确 patch 授权后再执行；回到 execute；最多两轮，不弱化 oracle |
| Verify + publish admission | verify、publish_gate | 不发布模式到 verified；publish 需当前 Evidence/receipt |
| Publish | publish、SCM adapter | 幂等核对 publication outcome 后才 completed |

测试通过不应经过无意义的 diagnose/repair；无发布需求不触发 SCM。调用 BUGate 原语，
不把 `sdtd_orchestrator.py --auto` 当黑盒内嵌在一个 Node 里。无需把每次读 PRD、读代码、
反思或工具选择都固定成 Graph edge。

## 7. HyperTest 工作包与跨仓依赖

下列 ID 是计划工作包，不是既有 PR 编号；完成需要提交与验收证据。

| ID | 改动范围 | 前置依赖 | 验收与回退 |
|---|---|---|---|
| HT-0 | 为现有 happy/deny/repair/failure 路径建立领域 trace 与 effect 清单；记录异构 conformance | 当前代码 | 去除时间/随机 ID 后有确定性对照 fixture；不改行为 |
| HT-1 | 抽 operations、WorkflowRuntime 接口和 legacy driver；定义 run/operation/ledger v2、恢复语义、产物复用 | HT-0；与 BG-1 对齐 | 旧 CLI 和领域结果等价；未知版本拒绝；legacy 不谎报 durable resume；本阶段不加 LangGraph |
| HT-2 | BUGate contract client + PEP + intent/outbox/reconciliation；保持 static fixture 模式独立 | HT-1、BG-1；完整 action 验收需 BG-3 | 直接写入/发布旁路负测、并发占用、过期/漂移、丢响应通过；关新准入仍可核对旧动作 |
| HT-3 | 在 `workflow/langgraph/**` 接入锁版本依赖和持久化 checkpointer，映射旧领域路径 | HT-1 可做只读 PoC；正式写入依赖 HT-2 | 进程终止后重启恢复、interrupt/resume、领域 trace 等价、预算不重置；启动时显式选 runtime |
| HT-4 | 联合 BUGate 验收完整链路；单主机 rollout、observability、版本升级/回退 | HT-2、HT-3、BG-4 | 同一 run 不双执行、效果可核对、异构场景通过；旧 run drain 后才切换默认 |
| HT-5 | 增大节点内自主分析/设计/诊断能力，逐步替换固定认知步骤 | HT-4；独立安全/效果评测 | 门控、角色、预算不松动；自治未改善或回归可按 phase 关闭；不顺带放开 subagent |

联合顺序：BG-0/HT-0 → BG-1/HT-1 → BG-2、BG-3 与 HT-2 → HT-3、BG-4 →
HT-4 → BG-5；HT-5 在可靠闭环后推进。允许只读 PoC 并行，不允许双 runtime 在同一
workspace/run 上执行副作用。所谓 shadow comparison 仅限保存的输入、纯决策或隔离 fixture。

## 8. 必须补齐的故障测试

| 场景 | 预期 |
|---|---|
| 完成 operation 后、checkpoint 前 kill worker | 从已保存输出/outcome 恢复，不重做受保护副作用 |
| Reservation 前、后、dispatch 后分别崩溃 | 对应恢复原请求/原 operation/查询外部结果，不能换 nonce 洗掉记录 |
| SCM 已成功但响应丢失 | 查询或幂等恢复同一 change ID；不是创建第二条 MR/PR |
| Adapter 不支持结果核对且外部结果未知 | `reconciliation_required`，无自动重发 |
| 两 worker 恢复同一 run | 一个 owner；旧 lease/fence holder 无权继续变更 |
| Checkpoint/产物/Policy/source 版本不匹配或缺失 | 可解释的阻断/迁移要求，不创建新空 ledger |
| 授权过期、wrong scope、unknown obligation、authority 不可信 | 在 PEP 处阻断；Graph 已到节点不构成放行 |
| 人工批准重复、伪造、绑定旧 Evidence/错误 run | 拒绝；合法审批也必须重新经过 BUGate |
| 修复后恢复/网络重试 | 两轮上限、usage、deadline 不归零；不添加 skip/xfail 或弱化断言 |
| 渲染器/Agent 试图直接写受保护路径或调用 SCM | 在声明的隔离等级内实际拒绝；不是只测一个函数被调用 |
| 取消时外部动作已经发生 | 核对记录其结果；若需要补偿，单独授权 |

在现有 `tests/state-machine.test.ts`、`orchestrator.test.ts`、`gate.test.ts`、
`artifact-store.test.ts`、`model-budget.test.ts` 的基础上增加 workflow/PEP 故障测试。
不得用只跑成功路径替代失败注入。

本仓发布前继续运行现有命令（以 `package.json` 和 CI 为准）：

```bash
npm ci --ignore-scripts
npm run ci
npm run test:examples
```

Python/pytest/HTTP 与 Go/go test/CLI 均须通过，公共 Core/schema 不因 SUT 切换而修改。
Live-model 测试仍显式 opt-in；不把真实凭证/真实 SCM 写入作为普通 CI 前置条件。
记录恢复耗时、重复效果数、未决动作数、token/调用预算和 PEP p95，而不只看 PASS 数。

## 9. 切换、回滚与不做清单

- 初期 legacy 为对照，新 Graph 显式 opt-in；每个 run 只绑定一个 runtime owner。
- 开启正式动作前通过 HT-2；通过 HT-4 后才能切换默认，不能凭 PoC 宣布 production-ready。
- 出现漂移/重复效果/不可核对结果时停新准入，保留 checkpoint、intent、receipt 和日志；
  让兼容 worker drain 或人工 reconcile。不能删库“重试一次”。
- 配置回滚只影响新 run；已有 checkpoint 必须由兼容版本处理。不要把新 Graph 的
  active run 直接转交不能理解该状态的 legacy runner。
- 不重写 BUGate、不把 BUGate Policy 散落进 routing、不以 checkpoint 替代 Receipt。
- 不把 LangGraph 当现成集群调度器；多主机部署、托管身份和高保障签名在单机闭环之后。
- 不同时更换模型、Harness、Workflow Runtime、公共 schema 和所有 adapter。
- 不为追求七个大节点把不可恢复的长过程藏起来；也不把每一轮思考画成 node。

**紧接着做 HT-0 与 HT-1，并与 BUGate BG-1 对齐。** 第一批交付应让现有执行单元
可测试、身份稳定、状态可解释，随后才引入增强 PEP 和 LangGraph。

每个 PR 附：工作包 ID、baseline/target SHA、schema/capability 版本、效果与权限变更、
正反测试结果、迁移/回退方案、跨仓依赖、未决风险。若新结论要改变 ADR 或冻结协议，
先单独修订，不能借“实现细节”绕过评审。
