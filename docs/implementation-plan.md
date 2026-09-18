# HyperTest 设计与开发路线

- 项目：HyperTest。
- 状态：当前开发指引；目标能力不等于已实现能力。
- 更新日期：2026-09-18。
- 范围：跨语言、跨测试框架、跨被测系统形态、跨 CI/SCM 平台。

## 当前开发入口

**基于 Pi 构建专业测试开发 Agent，先完成测试任务闭环，再根据实际需求决定是否引入流程运行时。**

先读 [ADR-0007：Pi 开发路线与条件式编排](adr/0007-pi-first-test-agent.md)，
再按 [基于 Pi 的测试 Agent 开发指南](pi-agent-development-guide.zh-CN.md) 推进。
BUGate 2.0 接入以 [ADR-0006](adr/0006-bugate-protocol-binding.md) 和
[协议集成设计](design/bugate-protocol-integration.md) 为准。

## 开发顺序

| 工作包 | 目标 | 启动条件 |
|---|---|---|
| HT-P0 | 盘点 Pi 能力，评估 core 与完整 Coding Agent SDK 的复用深度 | 现在开始；先提交评估与选型证据 |
| HT-P1 | 通过受控工具和现有 adapters 完成一个测试任务闭环 | HT-P0；保持现有 gate 和异构基线 |
| HT-P2 | 实现 BUGate 协议绑定、持续补注、产物/证据/Claim 评估 | 正式协议 bundle/schema 稳定；准备工作可并行 |
| HT-P3 | 验证任务实际需要的会话与操作恢复能力 | HT-P1；新协议恢复另依赖 HT-P2 |
| HT-P4（条件项） | 评估 LangGraph 或其他独立流程运行时 | 已证明现有 Pi 集成和任务生命周期存在具体缺口 |

副作用身份、预算和恢复边界在开放对应能力前设计；HT-P3 负责补齐并验证恢复实现。
不需要等待 LangGraph 或全部 BUGate 2.0 实现完成，才开始 Pi 能力评估。
具体改动范围、验收与回退要求见开发指南。

## 核心决策

- Pi 是通用 Agent 底座；通过受支持的 SDK/扩展接口二次开发，保持上游零 fork。
- 当前生产 SDK 仍为 `pi-agent-core`，`pi-ai` 为其传输配套；Pi imports 留在 `src/runtime/pi/**`。
- 完整 SDK 是评估候选，采用前须修订 ADR-0002、依赖与边界检查并提供迁移证据。
- HyperTest 负责测试任务、工作区、工具能力、预算、产物与证据，以及修复和发布策略。
- BUGate 2.0 是无状态测试方法协议与评估方；HyperTest 持有 ProtocolBinding 并持续补注。
- LangGraph 不再是已选定的下一步依赖；引入独立运行时需要实际需求、PoC 和单独决策。
- 会话保存不等于外部动作恢复；保持稳定身份、预算连续性与未知效果核对，明确未支持的能力。
- 现有确定性路径、安全修复限制、公共 schemas 和 process/artifact adapters 继续作为兼容基线。
- Python/pytest/HTTP 与 Go/go test/CLI 继续是永久异构 conformance 场景；换场景不修改公共 Core/schema。

当前目标架构见 [architecture.md](architecture.md) 与 [架构图](assets/architecture.svg)。
当前模型实现能力见 [model-runtime.md](model-runtime.md)，不要根据目标文档推断已交付能力。

## 原始设计与历史决策

下列四篇保留 2026-08-14 原始方案，提供领域契约和历史背景。有关 BUGate 授权、SDK
选择和开发顺序的冲突内容，以 ADR-0006、ADR-0007 和本页入口为准；当前代码中的
v1 gate 兼容行为在单独迁移前继续执行。

1. [目标、约束与技术选型](design/01-goals-and-technology-selection.md)
2. [系统架构、边界与接缝契约](design/02-system-architecture-and-contracts.md)
3. [执行、诊断修复与集成设计](design/03-execution-repair-and-integrations.md)
4. [交付、风险、测试与运维](design/04-delivery-risks-and-operations.md)

[ADR-0005](adr/0005-durable-workflow-runtime-and-bugate-boundary.md) 与
[旧治理/运行时指南](governance-runtime-refactor-guide.md) 的强制 LangGraph 路线和
HT-0～HT-5 排期已停止作为新开发依据，保留有价值的故障恢复分析供具体实现参考。
