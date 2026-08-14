## 20. 可持续落地里程碑

| 里程碑 | 独立交付物 | CI 接入 | 退出标准 |
|---|---|---|---|
| M0 契约骨架 | schemas、adapter protocol、artifact store、FakeRuntime、两套 golden fixtures | `contract-check` | 两场景使用相同 Core；错误语义有测试 |
| M1 测试分析 | `sut-contract → test-plan`、只读 BUGate bridge | `hypertest-plan` | 无语言/框架/platform 类型进入 Core |
| M2 生成与执行 | pytest、go test adapters；sandbox；TestRun IR | `hypertest-execute` | 两场景均能生成、收集和运行 |
| M3 自我诊断 | diagnosis schema、证据链、根因分类 | `hypertest-diagnose` | seeded failures 可复核 |
| M4 受限自修复 | 两轮修复、oracle weakening detector、回归验证 | `hypertest-repair` | 无测试弱化，安全类别可闭环 |
| M5 白盒探索 | LSP broker、CoverageMap、探索候选评分 | `hypertest-explore` | capability 差异下仍正确降级 |
| M6 门禁与发布 | BUGate PEP、GitLab CI/SCM adapters、幂等 draft MR | `hypertest-propose` | deny/outage 不发布；重复 run 不重复建 MR |
| M7 Adapter Kit | manifest、conformance harness、模板和文档 | `adapter-conformance` | 新 adapter 不改 Core |

每个里程碑必须独立可用。M1 可以只产出分析报告，M2 可以只运行不修复，M3 可以诊断但不修改，避免“大爆炸式”交付。

---

## 21. 一周 PoC

### 21.1 PoC 目标

跑通：

```text
接口定义
  → 生成用例
  → GitLab CI/OCI 执行
  → 失败自诊断
  → 受控自动修复
  → BUGate 决策
  → 自动提 draft MR
```

### 21.2 PoC 范围

第一场景：

- Python；
- pytest；
- HTTP API；
- OpenAPI；
- coverage.py；
- GitLab CI/MR。

第七天必须切换验证：

- Go；
- go test；
- CLI；
- CLI contract；
- gopls；
- Go coverprofile。

刻意不做：

- 浏览器/UI；
- 多 agent；
- MetaGPT/Hermes；
- 自动修改 SUT；
- 自动 merge；
- SCIP；
- 长期记忆；
- 复杂知识库。

### 21.3 七天计划

| 日 | 交付 |
|---|---|
| Day 1 | 公共 schemas、adapter protocol、artifact store、FakeRuntime、BUGate bridge |
| Day 2 | OpenAPI importer、HTTP SutAdapter、pytest adapter、TestPlan 生成 |
| Day 3 | Docker sandbox、pytest collect/run、TestRun、coverage.py 归一化 |
| Day 4 | failure classifier、diagnosis、seeded failure fixtures |
| Day 5 | 最多两轮 repair、oracle weakening 检查、重跑、BUGate apply decision |
| Day 6 | GitLab CI adapter、GitLab SCM adapter、幂等 draft MR |
| Day 7 | Go/CLI/go test 切换；记录真实改动面积和指标 |

### 21.4 PoC 量化指标

这些是验收门槛，不是预先宣称的结果。

| 指标 | 定义 | 样本下限 | 门槛 |
|---|---|---:|---:|
| 生成用例可执行率 | runner 能收集并运行到测试逻辑的生成用例 / 生成总数；真实断言失败仍算可执行 | 每场景 ≥30 | Python、Go 各 ≥80% |
| 诊断 Top-1 准确率 | 根因类别正确，且文件/operation/stage 至少一个命中真值 | ≥20 个 seeded failures，至少 5 类 | ≥60% |
| 诊断 Top-3 准确率 | 前三个 hypothesis 包含真值 | 同上 | ≥80% |
| MR 人工返工率 | 需人工语义修改后才能接受的 MR / 自动创建 MR | ≥10 个 | ≤40% |
| 测试弱化事件 | skip/xfail、删 oracle、吞异常、无授权放宽比较 | 全部 | 0 |
| Core 改动面积 | Python/pytest/HTTP 切 Go/go test/CLI 时公共 Core 改动 | 1 次完整切换 | 0 行 |
| 公共 schema 改动 | 为 Go 增加专有字段 | 1 次完整切换 | 0 行 |

### 21.5 语言 + 测试框架切换改动预算

首次增加 Go/go test：

| 文件 | 允许新增行数 |
|---|---:|
| `src/adapters/test/go-test.ts` | ≤170 |
| adapter manifest/config | ≤25 |
| `src/adapters/coverage/go-cover.ts` | ≤90 |
| gopls profile config | ≤15 |
| `profiles/go-cli-go-test.example.json` | ≤45 |
| `examples/go-cli/command-contract.json` | ≤40 |
| Go adapter golden fixtures | ≤120 |
| 公共 Core | **0** |
| 公共 `schemas/**` | **0** |

预算：

- 生产 adapter/config/input：≤385 行；
- golden fixture：≤120 行；
- Core：0 行；
- 公共 schema：0 行。

若尚未提供通用 command SutAdapter，允许首次额外增加：

```text
src/adapters/sut/command.ts ≤140 行
```

两套 adapters 均存在后，日常项目切换应仅改：

- profile：约 35–45 行；
- SUT contract：约 25–40 行；
- 生产代码：0 行；
- `.gitlab-ci.yml`：0 行。

机器验收应证明公共 Core 和 schema 在场景切换中没有差异。若不为零，通用性验收失败。

---

## 22. 上游替换与降级路径

| 上游/能力 | 降级或替换 | 允许改动范围 | 不变部分 |
|---|---|---|---|
| pi 停更/breaking | 固定旧版；实现 Codex/OpenCode 进程 runtime 或最小自研兼容实现 | `src/runtime/<provider>/**` | Core、artifacts、adapters、BUGate |
| Docker 不可用 | Podman、Kubernetes Job、远程 sandbox | `src/adapters/sandbox/**` | sandbox contract |
| 某 LSP 不稳定 | compiler/lint/grep；后续 SCIP | 对应 code adapter config | SourceSnapshot/CodeQueryResult |
| coverage converter 失效 | 直接解析原生格式；临时关闭 coverage exploration | 对应 coverage adapter | 生成/执行/诊断 |
| BUGate breaking | 固定 release；bridge 做 schema 转换 | gate process bridge | Core 不接触 BUGate 内部类型 |
| BUGate 不可用 | 只读分析；禁止 apply/publish | 无 | fail-closed |
| GitLab 替换 | 新 CI adapter + 新 SCM adapter | `src/adapters/ci/**`、`src/adapters/scm/**` | Core、SUT、测试 |
| pytest/go test 变化 | 更新单个 adapter 和 golden fixtures | 对应 adapter | TestPlan/TestRun |

维护规则：

- 所有上游固定精确版本、镜像 digest 或 commit；
- 一次升级 MR 只升级一个上游；
- 每个 provider 都必须运行 conformance fixtures；
- 保留 FakeAgentRuntime，确保核心测试不依赖模型和 pi；
- adapter manifest 声明版本与 capability；
- schema breaking change 需要迁移器和回放测试；
- 上游停更不会触发核心重构。

---

## 23. Top 3 风险与缓解

### 风险一：单人维护 + AI 代写导致架构失控

**表现**

- AI 为局部便利引入第二 agent SDK；
- GitLab SDK 泄漏进 Core；
- pytest 类型进入公共 schema；
- 动态插件和隐式注册越来越多；
- 生成大量无人理解的抽象层；
- 上游升级被一次性混入多个变更。

**缓解**

- import boundary lint；
- dependency allowlist；
- 每个公共 schema 变更单独 MR；
- 新 runtime dependency 必须 ADR；
- adapter 必须通过 conformance；
- 单次 MR 限制生产代码 diff；
- 不使用反射式 plugin discovery；
- 配置采用显式 executable + manifest；
- 每次上游升级单独 MR；
- Core 关键模块强制手写设计注释和状态不变量测试；
- AI 生成代码必须伴随 failure-path 和 golden tests。

### 风险二：自修复通过削弱测试

**表现**

- 删除断言；
- 扩大 tolerance；
- 新增 skip/xfail；
- 吞异常；
- 把 SUT bug 写入预期值；
- 只跑修复后的单个测试，不跑回归。

**缓解**

- 先分类再修复；
- 安全类别 allowlist；
- oracle AST/diff 检查；
- assertion 数量与强度检查；
- mutation/falsification 指标非退化；
- 全量相关回归；
- BUGate publish gate；
- 任何弱化模式自动 `needs-human`；
- SUT_DEFECT 不允许修改测试规避。

### 风险三：跨语言抽象产生虚假一致性

**表现**

- Go block coverage 当 Python branch coverage；
- compile failure 当 testcase failure；
- LSP partial 当完整调用图；
- CLI exit code 被映射成 HTTP status；
- 不支持能力被填成空数组后误判“没有问题”。

**缓解**

- 每个 artifact 带 capability/completeness；
- unknown 不等于 zero；
- source revision/digest 校验；
- 两个异构 golden 场景从 M0 常驻；
- 共同指标只使用语义一致的维度；
- adapter conformance 包含 unsupported/partial/stale；
- 所有跨语言汇总指标必须给出 granularity。

---

## 24. 测试策略

### 24.1 Core 单元测试

- 状态转换；
- retry/timeout/取消；
- repair allow matrix；
- oracle weakening；
- idempotency；
- BUGate deny/outage；
- artifact hash；
- source drift；
- capability negotiation。

### 24.2 Contract 测试

- JSON Schema；
- forward-compatible optional fields；
- invalid request；
- malformed response；
- stale artifacts；
- unsupported；
- transient/permanent error；
- timeout/cancel。

### 24.3 Adapter conformance

每个 adapter 必须通过：

```text
describe
happy path
domain failure
unsupported capability
invalid request
transient error
permanent error
timeout
cancellation
idempotent retry
artifact hash mismatch
```

### 24.4 E2E

固定维护两套场景：

1. Python/pytest/HTTP；
2. Go/go test/CLI。

每次 Core 变更必须同时运行。不能把第二场景作为发布前的偶发验收。

### 24.5 故障注入

至少注入：

- 生成语法错误；
- import/build 失败；
- 错误 fixture；
- SUT 返回错误；
- contract 漂移；
- runner internal error；
- LSP crash；
- coverage stale；
- Docker timeout；
- GitLab 429/5xx；
- BUGate unavailable；
- base SHA 漂移；
- flaky timing。

---

## 25. 可观测性与审计

首期使用：

- `events.ndjson`；
- 结构化日志；
- artifact hashes；
- 模型 token/成本；
- tool call 计数；
- adapter latency；
- retry 计数；
- gate decisions；
- repair round；
- failure category；
- MR outcome。

关键指标：

```text
run_success_rate
plan_schema_valid_rate
generated_test_executable_rate
diagnosis_top1/top3_accuracy
repair_success_rate
test_weakening_incidents
gate_denial_rate
adapter_error_rate
p95_run_duration
tokens_per_accepted_case
cost_per_accepted_mr
human_rework_rate
core_change_area_for_new_adapter
```

首期不建设复杂 dashboard。CI artifact 中提供 run summary 和机器可读 JSON，后续再接观测平台。

---

## 26. 运维与升级

### 26.1 版本固定

- Node runtime 固定；
- pi 包固定精确版本；
- 容器镜像固定 digest；
- LSP server 固定版本；
- runner 和 coverage 工具由 adapter image 固定；
- BUGate 固定 release；
- adapter manifest 记录版本；
- model endpoint 与 checkpoint 记录在 run artifact。

### 26.2 升级流程

```text
read-only compatibility check
  → conformance tests
  → 两个 E2E 场景
  → replay 历史 run
  → 单独升级 MR
  → 人工确认
```

不得在同一个 MR 同时升级 pi、BUGate、Docker image 和测试框架。

### 26.3 回滚

- 上游版本通过 lockfile/digest 回滚；
- artifact schema 保留 migration；
- adapter 可并存两个版本；
- run 记录 provider/version；
- BUGate receipt 绑定版本；
- 发布失败不破坏已验证 artifacts；
- MR 创建使用幂等 key，回滚不会创建重复 MR。

---

## 27. 决策结论

最终稳态组件为：

```text
BUGate
  = 唯一政策与质量权威

HyperTest Core
  = 唯一执行状态、诊断与修复语义权威

pi-agent-core
  = 唯一 SDK 级 agent loop

OCI / LSP / native test runners / coverage / GitLab / Git
  = 可替换的进程级能力提供者

Adapters + versioned artifacts
  = 通用性的实际边界
```

架构成功的判据不是“接入了多少 agent 框架”，而是：

- 只有一个 SDK 接缝；
- 只有一个质量决策权威；
- 模型没有越权路径；
- 语言、框架、SUT 和平台假设都可在 adapter diff 中定位；
- 第二异构场景切换时 Core 为 0 行改动；
- 任一上游停更时只替换 provider，不重构系统；
- 每个里程碑都能独立接入 CI 并产生可审计价值。

这套方案优先保证单人可理解、可持续交付和可证伪的通用性，而不是追求组件数量或 agent 自主性的最大化。
