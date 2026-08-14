# HyperTest 完整设计与实施方案

> 项目：HyperTest  
> 状态：实施基线  
> 基准日期：2026-08-14  
> 范围：跨语言、跨测试框架、跨被测系统形态、跨 CI/SCM 平台

本文档是完整设计方案的目录。为便于评审和后续维护，原始方案按稳定主题拆分为四个 Markdown 文件，内容连续且不删减。

## 方案正文

1. [目标、约束与技术选型](design/01-goals-and-technology-selection.md)
2. [系统架构、边界与接缝契约](design/02-system-architecture-and-contracts.md)
3. [执行、诊断修复与集成设计](design/03-execution-repair-and-integrations.md)
4. [交付、风险、测试与运维](design/04-delivery-risks-and-operations.md)

## 核心决策

- BUGate 是唯一质量策略与受保护动作授权权威。
- HyperTest Core 是唯一执行状态、预算、诊断与修复语义权威。
- `pi-agent-core` 是唯一 SDK 级 agent runtime；其类型不得泄漏出 `src/runtime/pi/**`。
- SUT、测试框架、LSP、覆盖率、沙箱、CI、SCM 与知识源全部通过进程/产物级 adapter 接入。
- Python/pytest/HTTP 与 Go/go test/CLI 是永久异构 conformance 场景；切换场景时公共 Core 与公共 schema 的改动面积必须为 0。

系统架构图见 [architecture.md](architecture.md) 与 [assets/architecture.svg](assets/architecture.svg)。
