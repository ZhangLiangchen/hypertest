# HyperTest 通用测试开发 Agent 实施方案

> 项目名称：HyperTest  
> 状态：实施基线  
> 适用范围：跨语言、跨测试框架、跨被测系统形态、跨 CI/SCM 平台  
> 首个验证场景：现有 QA 平台；仅作为验收样本，不构成核心设计约束  
> 基准日期：2026-08-14  
> 模型前提：本文按项目输入，将 DeepSeek-V4-Pro-0813 定位为高性价比 worker 层模型，不把它视为 frontier 模型替代品

---

## 1. 执行摘要

本项目建设一个**通用测试开发 Agent**，核心目标依次为：

1. 自动完成测试分析与测试用例生成；
2. 对失败用例进行自我诊断与受控自我修复；
3. 将探索性测试 AI 化，重点利用源码、接口定义和覆盖率数据进行白盒或灰盒探索。

最终推荐架构为：

> **自研 HyperTest Core + BUGate 质量控制平面 + `pi-agent-core` 唯一 SDK 运行时 + OCI 沙箱 + LSP/原生覆盖率工具 + 进程/产物级 adapters**

硬约束核算如下：

| 约束 | 方案结果 |
|---|---|
| 维护者 | 1 人 |
| fork 数 | 0 |
| SDK 级上游依赖 | 1 个：`earendil-works/pi` 的 `pi-agent-core` |
| 其他上游耦合 | CLI、JSON-RPC、HTTP、JSON/文件产物 |
| 首个 CI | GitLab CI adapter |
| CI 是否硬编码进核心 | 否 |
| 被测系统/语言/框架假设 | 全部下沉到 adapter/profile |
| 质量决策权 | BUGate PDP |
| 强制执行权 | BUGate PEP |
| Agent 执行状态权 | HyperTest Core |
| 模型角色 | 可替换 worker，不拥有工作流与门禁决策权 |

稳态拓扑中不引入 Codex、OpenCode、OpenHands、MetaGPT 或 Hermes 作为运行时依赖。Claude Code/Codex 仅作为本项目代码实现工具，不成为产品架构的一部分。

---

## 2. 背景与问题定义

### 2.1 项目机会

按项目输入，DeepSeek-V4-Pro-0813 已于 2026-08-12 GA，具有较低推理成本和较大上下文，但其综合能力仍落后于 frontier 模型，官方宣称的 agent 能力也尚缺乏充分第三方复现。

因此，本项目不采用“让模型自由完成一切”的设计，而采用：

- 模型负责分析、候选生成、假设提出和有限代码修改；
- 确定性代码负责状态推进、预算、重试、超时、产物校验和权限控制；
- BUGate 负责策略决策和关键动作授权；
- adapter 负责把不同 SUT、语言、测试框架和平台差异隔离在核心之外。

低成本模型使大规模测试分析、失败归因和受限修复首次具备经济可行性，但模型能力差距要求系统必须做到**可验证、可回放、可降级、可拒绝**。

### 2.2 已有资产

BUGate 是本方案必须复用的质量控制资产，承担：

- PDP：策略决策；
- PEP：关键动作强制执行；
- Wave 0–6 DAG：质量门禁流程；
- SUT-neutral profile：项目绑定与门禁配置；
- 证据链、写保护和审计。

BUGate 不承担：

- agent loop；
- 测试 runner；
- 沙箱；
- LSP/代码索引；
- 覆盖率采集；
- CI/SCM 平台操作；
- 失败修复算法。

### 2.3 项目定位

该系统不是某个 QA 平台的“AI 插件”，而是一个可嵌入不同工程生态的通用测试开发引擎。首个 QA 平台只能提供第一个验收场景，不能向核心泄漏以下假设：

- 被测对象一定是 Web/HTTP 服务；
- 接口定义一定是 OpenAPI；
- 测试框架一定是 pytest；
- 测试结果一定是 JUnit XML；
- 覆盖率一定具有 line/branch 两个维度；
- CI 和代码托管一定由 GitLab 同时提供；
- 源码与测试一定在同一仓库；
- 测试代码一定位于 `tests/**`；
- 测试失败一定应通过修改测试来“修到绿色”。

---

## 3. 目标、非目标与验收原则

### 3.1 核心目标

#### 目标一：测试分析与测试用例自动生成

系统应能够从以下一种或多种输入建立测试模型：

- 产品/业务需求；
- API/CLI/协议接口定义；
- 源码与符号关系；
- 现有测试与 fixture；
- 历史缺陷；
- 运行日志；
- 覆盖率；
- SUT 实际行为探测。

输出必须先形成框架无关的 `test-plan.v1`，再由测试框架 adapter 渲染为具体测试代码。

#### 目标二：失败用例自我诊断与自我修复

系统应把失败区分为：

- 测试实现缺陷；
- fixture/测试数据缺陷；
- adapter/profile 配置问题；
- SUT 缺陷；
- 接口契约漂移；
- 构建错误；
- 环境或依赖问题；
- flaky/非确定性；
- 未知。

只有安全类别允许自动修复。SUT 缺陷不得通过削弱断言、吞异常或跳过测试来伪装成成功。

#### 目标三：探索性测试 AI 化

探索性测试重点使用：

- LSP 提供的符号、定义、引用、诊断和可选调用层级；
- 原生覆盖率数据；
- 接口契约；
- 已有测试意图；
- 失败热点和历史缺陷；
- 风险启发式。

系统应优先发现：

- 未覆盖的高风险 operation；
- 未验证的边界与状态转换；
- 源码变化触达但测试未触达的区域；
- 已有测试只覆盖成功路径的分支；
- 断言与业务 oracle 不匹配的位置。

### 3.2 非目标

首期不建设：

- 自研容器或内核级沙箱；
- 自研语言解析器或统一 AST；
- 自研测试框架；
- 自研 CI 平台；
- 自动修改生产 SUT 源码；
- 自动合并 MR/PR；
- 多 agent 社会化角色系统；
- 长期自主学习或个人记忆型 agent；
- 为所有语言提供等价的深度数据流/污点分析；
- 私有化、内网、BAA 等非本项目约束。

### 3.3 通用性判定

一个能力只有在至少两个形态迥异的场景下通过，才可标记为通用：

| 场景 | 被测对象 | 语言 | 测试框架 | 交互形态 |
|---|---|---|---|---|
| A | HTTP API 服务 | Python | pytest | OpenAPI + HTTP |
| B | CLI 工具 | Go | go test | CLI schema + stdin/stdout/exit code |

通用性不是宣称，而是通过**改动面积**证明：

- 场景 A 切换到场景 B 时，`src/core/**` 改动必须为 0 行；
- 公共 schema 不得增加 Go 或 pytest 专用字段；
- `.gitlab-ci.yml` 不得因语言/框架切换而变化；
- 差异只能出现在 adapter、profile、示例 contract 和 conformance fixture 中。

### 3.4 第二场景最先崩掉的位置

如果首版直接实现为 `OpenAPI → pytest`，切换到 Go/CLI 时最先崩掉的是**接口定义导入**：CLI 不存在与 OpenAPI 等价的统一事实标准。

因此必须先引入：

```text
raw interface definition
  → SutAdapter.importContract()
  → sut-contract.v1
```

引入通用契约后，第二个最早出现的语义差异是覆盖率：Go 原生 coverprofile 更接近 block/statement 近似，不能伪装成与 Python branch coverage 等价。核心必须保留 granularity 和 capability 信息，而不是输出一个失真的“统一覆盖率百分比”。

---

## 4. 设计原则与硬约束

### 4.1 一级原则

1. **单一 SDK 原则**  
   仅 `src/runtime/pi/**` 可以依赖 `pi-agent-core`；其他模块不得引用其类型。

2. **无 fork 原则**  
   上游只能通过发布包、CLI、HTTP、JSON-RPC 或文件协议接入。

3. **显式接缝原则**  
   每条接缝必须定义输入、输出、失败语义、超时和重试归属。

4. **核心无场景假设原则**  
   核心不得出现 pytest、go test、OpenAPI、GitLab、LCOV 等具体生态类型。

5. **产物优先原则**  
   大对象、模型上下文和工具结果通过版本化 artifact 传递，而非内存对象隐式耦合。

6. **模型不拥有权限原则**  
   模型只能提出动作；Core、BUGate 和 adapter 决定动作是否可执行。

7. **失败关闭原则**  
   BUGate 不可用、决策 receipt 无效或来源漂移时，只允许只读分析，不允许应用 patch 或发布 MR。

8. **确定性外壳原则**  
   工作流、超时、预算、重试、幂等和终止条件由代码控制。

9. **能力协商原则**  
   adapter 必须声明 capabilities；`unsupported` 和 `partial` 是正常状态，不能伪装为完整支持。

10. **单人可理解原则**  
    优先选择文件、JSON Schema、小状态机和显式 manifest，避免动态插件发现、复杂服务网格和多框架嵌套。

### 4.2 架构守卫

CI 必须阻止以下情况：

```text
- Core 引入第二个 agent SDK
- Core 引入 GitLab/GitHub/Jenkins SDK
- Core 出现 pytest、go test、JUnit、LCOV 等专有类型
- adapter 直接修改宿主工作区
- 模型拥有未经过 typed tool facade 的裸 bash/write/edit
- 发布 MR 时缺少有效 BUGate gate-decision receipt
- 自动修复引入 skip/xfail、删除核心断言或吞异常
```

---

## 5. 能力原语与最低成本提供者

| 能力原语 | 提供者 | 耦合级别 | 不可替代理由 |
|---|---|---:|---|
| 可编程 agent loop | `pi-agent-core` | 唯一 SDK 级 | 复用 provider streaming、tool call、上下文、取消、事件流；自研成本高且无产品差异化 |
| 确定性工作流 | 自研 HyperTest Core | 内部 | 决定产品语义、预算、重试和终止；不能交给带假设的通用上游 |
| 隔离沙箱执行 | Docker/Podman 等 OCI provider | 进程级 | 不自研 namespace/cgroup/文件系统隔离 |
| 工作区事务与 patch | `git` CLI + scratch worktree | 进程/产物级 | 成熟、可回滚、可审计 |
| SUT 接入 | 自研 `SutAdapter` | 进程/产物级 | HTTP、CLI、库、消息、设备等没有统一运行接口 |
| 框架无关测试意图 | 自研 `test-plan.v1` | 产物级 | 防止模型直接把 pytest/Go 语义写进核心 |
| 测试生成与执行 | 原生 runner + `TestFrameworkAdapter` | 进程/产物级 | 不重写 pytest/go test/JUnit 等生态 |
| 跨语言代码理解 | LSP server + 轻量 broker | JSON-RPC/进程级 | 复用语言生态符号、引用、定义和诊断 |
| 可选批量代码索引 | SCIP indexer | 产物级、后置 | 适合 CI 缓存和大仓库；不是首版必需 |
| 覆盖率采集 | 各语言原生工具 | 进程/产物级 | 不自研插桩 |
| 覆盖率统一 IR | 自研 `coverage-map.v1` | 产物级 | 保留 region、granularity 和 capability 差异 |
| 失败诊断与修复策略 | 自研 Core + 模型 worker | 内部 | 是本产品核心能力 |
| 领域知识接入 | `KnowledgeAdapter` | 进程/产物级 | 核心只消费带来源的 EvidenceBundle |
| CI 操作 | `CiAdapter` | HTTP/CLI | GitLab 只是第一个实现 |
| MR/PR 发布 | `ChangePublisherAdapter` | HTTP/CLI | SCM 与 CI 必须解耦 |
| 门禁决策与强制 | BUGate PDP/PEP | CLI/JSON/文件 | 已有可复用资产，避免第二政策引擎 |
| 产物与审计 | 文件型 Artifact Store | 内部 | 对单人维护最易理解、回放与替换 |

---

## 6. 技术选型

### 6.1 Agent 运行时：`pi-agent-core`

**选择范围**

仅使用：

- agent loop；
- tool execution lifecycle；
- streaming events；
- context transform/compaction hook；
- cancellation；
- stop-after-turn；
- model/provider abstraction。

不使用：

- 完整 coding CLI/TUI；
- 原始 read/write/edit/bash 工具直接暴露；
- 其会话或目录约定作为产品契约；
- 其 UI 作为 HyperTest 管理面。

**隔离方式**

```text
src/runtime/agent-runtime.ts      # Core 自有接口
src/runtime/pi/pi-runtime.ts      # 唯一 pi 实现
```

Core 只认识：

```ts
interface AgentRuntime {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

如果 pi 停更或 breaking change，仅替换 `src/runtime/pi/**`，不修改状态机、adapters、artifact schemas 或 BUGate bridge。

### 6.2 模型层：可切换 worker

默认模型按项目输入使用 DeepSeek-V4-Pro。模型路由不写死单一 provider：

| 任务 | 默认模型策略 |
|---|---|
| 文档/契约摘要 | 低成本 worker |
| 测试意图生成 | DeepSeek-V4-Pro |
| 失败分类 | DeepSeek-V4-Pro + 结构化证据 |
| 修复 patch | DeepSeek-V4-Pro；高风险时升级更强模型或人工 |
| 最终门禁 | 不由模型决定，交给 BUGate |
| 低置信诊断 | 可路由至 Claude/GPT 等更强模型 |

模型输出必须通过 schema 校验；不能把自然语言“看起来成功”作为状态推进依据。

### 6.3 沙箱：OCI CLI provider

默认实现：

- Docker CLI；
- 可替换 Podman；
- 非 root 用户；
- 只读 root filesystem；
- 工作区临时副本或 scratch worktree；
- CPU、内存、PID、磁盘和 wall-clock 限制；
- 网络默认关闭，按 profile 放行；
- 镜像使用 digest 固定；
- 运行结束强制清理。

OpenHands 不作为沙箱依赖。若未来需要远程持久工作区，应把 OpenHands Agent Server、Kubernetes Job 或其他服务实现成 `SandboxProvider`，而不是引入第二 agent runtime。

### 6.4 代码理解：LSP 优先，SCIP 可选

LSP 作为语言无关查询协议，支持：

- workspace/document symbols；
- definition；
- references；
- diagnostics；
- hover；
- implementation；
- 可选 call hierarchy。

Core 不假设所有 server 支持相同能力。每个结果必须包含：

```text
capabilities[]
completeness: complete | partial | unknown
sourceRevision
fileDigest
```

LSP 不可用时降级到：

- compiler/typecheck/lint；
- ripgrep；
- 受限文件读取；
- 现有测试索引。

SCIP 在以下条件满足后再引入：

- 大仓库 LSP 启动成本明显影响 CI；
- 需要跨 run 缓存定义/引用；
- 两种以上语言 indexer 已有稳定实现；
- 引入 Protobuf 和 indexer 不会突破单人维护边界。

### 6.5 覆盖率：原生采集，统一 region IR

LCOV 和 Cobertura 作为边缘输入/输出格式，而不是核心 IR。

核心使用 `coverage-map.v1`：

```json
{
  "schema": "hypertest.coverage-map/v1",
  "sourceRevision": "git-sha",
  "files": [
    {
      "uri": "repo://pkg/foo.go",
      "sha256": "...",
      "regions": [
        {
          "start": {"line": 10, "column": 1},
          "end": {"line": 13, "column": 2},
          "kind": "block",
          "hits": 4,
          "testIds": []
        }
      ]
    }
  ],
  "capabilities": {
    "line": true,
    "block": true,
    "branch": false,
    "condition": false,
    "perTest": false
  }
}
```

规则：

- 原生格式尽量直接解析；
- Go coverprofile 保留 block range；
- coverage.py JSON 保留可用 branch 信息；
- 缺失能力写 `false/unknown`，不得补零；
- 报告必须绑定 source revision 和文件 digest；
- 过期覆盖率不得进入探索决策。

### 6.6 CI 与 SCM：两个 adapter

首个 CI 为 GitLab CI，但必须拆成：

- `GitLabCiAdapter`：pipeline、job、status、artifacts、check；
- `GitLabChangePublisherAdapter`：branch、commit、draft MR、comment。

原因：MR/PR 属于代码托管/SCM，不属于 CI。把两者合并会把 GitLab 产品形态污染为通用架构。

### 6.7 质量控制：BUGate

BUGate 是唯一政策权威：

- Core 请求决策；
- PDP 返回 allow/deny/needs-human 和 obligations；
- PEP 在关键动作执行前验证 receipt；
- adapter 和模型无权覆盖 deny。

至少设置两个强制点：

1. 将生成/修复 patch 应用到受治理工作区之前；
2. 创建或更新 MR/PR 之前。

BUGate 不可用时：

- 允许读取、分析、生成候选产物；
- 禁止应用宿主 patch；
- 禁止发布 MR/PR。

### 6.8 Artifact Store

首版采用工作区内文件型 artifact store：

```text
.testagent/
  runs/<run-id>/
    run-request.json
    run-state.json
    events.ndjson
    artifacts/
      sut-contract.json
      source-snapshot.json
      test-plan.json
      generated.patch
      test-run.json
      coverage-map.json
      diagnosis.json
      repair-proposal.json
      gate-decision.json
      change-proposal.json
    logs/
```

所有 artifact：

- 有 schema；
- 有 SHA-256；
- 原子写入；
- 不允许半写文件；
- 支持重放；
- 支持 CI 上传；
- 支持 BUGate 引用证据 hash。

首期不引入数据库、向量库或事件中间件。需要跨 run 查询时，再从不可变 artifacts 构建索引。

---
