## 13. 执行与权限模型

### 13.1 Typed Tools

模型不可直接获得通用 shell。只暴露：

```text
read_artifact
query_code
import_sut_contract
probe_sut
propose_test_plan
render_test_patch
validate_patch
run_tests
propose_diagnosis
propose_repair_patch
request_gate_decision
publish_change
```

需要 shell 的 adapter 自己在 sandbox 中使用声明好的命令模板，并记录：

- argv；
- cwd；
- env allowlist；
- image digest；
- resource limits；
- network policy；
- timeout；
- exit code；
- stdout/stderr artifact。

### 13.2 写入路径

```text
模型产生候选
  → render patch
  → schema/静态校验
  → BUGate pre-apply decision
  → sandbox 副本应用
  → 执行与验证
  → BUGate publish decision
  → SCM adapter 提交 draft MR
```

任何阶段都不允许模型直接修改受治理宿主工作区。

### 13.3 幂等

以下动作必须使用 `idempotencyKey`：

- acquire SUT lease；
- submit CI run；
- publish check；
- publish draft MR；
- 添加 MR comment；
- BUGate transition 请求。

非幂等 SUT 写操作不得盲目重试。

---

## 14. 自我诊断与自我修复

### 14.1 诊断证据优先级

1. runner/build 的结构化事件；
2. 测试 stdout/stderr；
3. SUT observation；
4. patch diff；
5. 接口定义；
6. LSP diagnostics、definitions 和 references；
7. 覆盖率变化；
8. 历史失败与缺陷；
9. 模型推断。

模型结论必须引用 artifact，不能只给自然语言判断。

### 14.2 自动修复允许矩阵

| 类别 | 自动修复 | 说明 |
|---|---|---|
| TEST_DEFECT | 允许 | 语法、错误 API 使用、等待逻辑、解析错误等 |
| FIXTURE_DEFECT | 允许 | 测试数据、seed、清理和隔离问题 |
| ADAPTER_CONFIG | 允许 | 命令、selector、路径和解析配置 |
| BUILD | 条件允许 | 仅生成测试代码导致的 build/import 问题 |
| FLAKY | 默认不直接改断言 | 可增加确定性同步、隔离或采样证据 |
| CONTRACT_DRIFT | 不自动“修绿” | 生成 contract change report，通常需人工 |
| SUT_DEFECT | 禁止改测试规避 | 输出缺陷报告和复现证据 |
| ENVIRONMENT | 不修改测试语义 | 调整环境前需 profile/人工授权 |
| UNKNOWN | 禁止 | 进入 needs-human |

### 14.3 修复不变量

自动修复必须同时满足：

- 最多 2 轮；
- 只能修改 profile 允许的测试/fixture/adapter 配置路径；
- 禁止新增 skip/xfail/ignore；
- 禁止删除核心 oracle；
- 禁止把精确比较改为宽泛比较；
- 禁止吞异常；
- 禁止把非预期 SUT 返回加入“可接受值”；
- 测试意图 hash 不变，或变化经 BUGate 批准；
- mutation/oracle falsification 指标不得下降；
- 原有回归测试不得新增失败；
- coverage 不得以未知能力伪装为提升。

### 14.4 收敛条件

以下任一条件触发停止：

- 通过全部目标测试和回归；
- 达到两轮修复上限；
- 连续两轮相同根因；
- patch 变化小于阈值但失败不变；
- BUGate deny/needs-human；
- 预算耗尽；
- source revision 漂移；
- 检测到测试弱化；
- diagnosis confidence 低于阈值。

---

## 15. 白盒探索设计

### 15.1 代码理解工作流

```text
SourceSnapshot
  → LSP initialize/capability negotiation
  → symbols/definitions/references/diagnostics
  → 与 SutContract operation 关联
  → 与已有 TestInventory 关联
  → 与 CoverageMap 关联
  → 生成 exploration candidates
```

### 15.2 探索候选评分

建议使用确定性评分，而非让模型自由排序：

```text
score =
  risk_weight
  × change_proximity
  × uncovered_weight
  × oracle_gap
  × state_transition_weight
  × historical_defect_weight
  × confidence
```

每个因子都应有可引用证据。模型负责解释和生成候选，不负责修改权重或最终门槛。

### 15.3 LSP 的边界

LSP 是“查询层”，不是统一语义图。以下结果必须允许 `partial/unknown`：

- call hierarchy；
- cross-language references；
- generated code；
- dynamic dispatch；
- reflection；
- macro expansion；
- runtime routing。

如果探索依赖的 capability 不存在，应降级为：

- 文本和编译器证据；
- operation/文件级覆盖；
- 源码 diff 邻近；
- 人工标记的风险区域。

### 15.4 覆盖率的边界

系统不得直接比较异质指标：

```text
Python branch coverage 82%
vs.
Go block coverage 82%
```

二者不能视为同一维度。跨语言聚合只能使用共同支持的、明确定义的度量，例如：

- operation coverage；
- test-plan risk coverage；
- file/region touched；
- oracle coverage；
- state transition coverage。

---

## 16. 候选上游取舍

### 16.1 保留

| 组件 | 使用方式 |
|---|---|
| BUGate | 唯一 PDP/PEP 和治理 DAG |
| `pi-agent-core` | 唯一 SDK 级 agent runtime |
| Docker/Podman | 进程级沙箱 provider |
| LSP servers | JSON-RPC 代码查询 |
| 原生测试 runner | CLI |
| 原生 coverage | 文件产物 |
| GitLab API/CLI | CI 和 SCM 两个 adapter |

### 16.2 出局

| 组件 | 出局理由 |
|---|---|
| openai/codex | 与 pi 同层重叠；完整 runtime 面更大；保留为未来进程级备选规格 |
| OpenCode | 与 pi 同层重叠；引入 server/session/LSP 管理等第二套运行时 |
| OpenHands | 实际沙箱能力伴随第二 agent/server SDK；不具备不可替代测试原语 |
| MetaGPT | SOP/角色编排与 BUGate DAG + Core 状态机重叠，且假定软件公司流程 |
| Hermes Agent | 会引入第二 hub、记忆、技能、调度和工具权威，形成双中心 |
| pi 完整 coding CLI | 仅使用 core SDK；不把其裸工具和 UI 变成产品依赖 |

### 16.3 重叠裁决

- Codex/OpenCode/pi：重叠成立，保留 pi；
- MetaGPT SOP/BUGate DAG：重叠成立，保留 BUGate；
- Hermes hub/BUGate：概念不完全相同，但运行中会争夺工具、记忆和调度权，砍 Hermes。

---

## 17. 推荐仓库结构

```text
hypertest/
├── src/
│   ├── runtime/
│   │   └── pi/
│   ├── adapters/
│   │   ├── sut/
│   │   ├── test/
│   │   ├── code/
│   │   ├── coverage/
│   │   ├── sandbox/
│   │   ├── ci/
│   │   └── scm/
│   ├── artifact-store.ts
│   ├── contracts.ts
│   ├── diagnosis.ts
│   ├── gate.ts
│   ├── orchestrator.ts
│   ├── planner.ts
│   ├── repair.ts
│   └── state-machine.ts
├── schemas/
├── profiles/
├── tests/
├── examples/
│   ├── python-http/
│   └── go-cli/
└── docs/
    ├── adr/
    └── design/
```

约束：

- 核心不得 import adapter 的具体生态类型；
- adapter 由 profile/manifest 选择；
- 不使用中央 `switch(language)`；
- 新 adapter 通过 conformance harness 注册，而不是修改 Core；
- 只有 `src/runtime/pi/**` 可以 import pi；
- schema 版本升级必须有 migration 和 golden fixture。

---

## 18. Profile 草案

```yaml
schema: hypertest.profile/v1
name: example-python-api

runtime:
  provider: pi
  model: deepseek-v4-pro
  budgets:
    maxTurns: 20
    maxToolCalls: 60
    maxRepairRounds: 2
    wallClockMs: 1800000
    tokenBudget: 100000

sut:
  contractSource: specs/openapi.json
  sourceKind: openapi

adapters:
  sut:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, sut-http-openapi]
  test:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, test-pytest]
  code:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, code-lsp]
  coverage:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, coverage-json]
  sandbox:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, sandbox-oci]
  ci:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, ci-gitlab]
  scm:
    command: node
    args: [dist/src/adapter-cli.js, --adapter, scm-gitlab]

gate:
  mode: process
  process:
    command: .bugate/bin/hypertest-gate

workspace:
  allowedWriteGlobs: [tests/**, fixtures/**]
  forbiddenGlobs: [src/**, .git/**]
```

Go/CLI 场景只替换 profile 和相应 adapters，不修改 Core。

---

## 19. CI 集成

### 19.1 通用 GitLab CI 入口

```yaml
hypertest:
  image: registry.example/hypertest@sha256:...
  variables:
    HYPERTEST_PROFILE: profiles/current.json
  script:
    - hypertest run --profile "$HYPERTEST_PROFILE"
  artifacts:
    when: always
    paths:
      - .testagent/runs/
```

语言或测试框架切换时：

- `.gitlab-ci.yml` 不变；
- 只替换 `HYPERTEST_PROFILE`；
- GitLab adapter 不感知 pytest/go test；
- TestFrameworkAdapter 不感知 GitLab。

### 19.2 Pipeline 角色

建议拆分为：

```text
contract-check
adapter-conformance
hypertest-plan
hypertest-execute
hypertest-diagnose
hypertest-repair
hypertest-propose
```

早期里程碑可以只启用前几个 job，后续逐步增加，无需重构现有 CI。

### 19.3 MR 策略

- 只创建 draft MR；
- 不自动 merge；
- branch 名使用 run id；
- description 引用 test plan、diagnosis、coverage 和 BUGate receipt；
- 重复 run 使用 idempotency key 更新同一 MR；
- base SHA 漂移时停止并请求重新分析，不静默 rebase。

---
