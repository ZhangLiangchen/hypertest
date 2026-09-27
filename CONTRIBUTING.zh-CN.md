# 参与 Hypertest 开发

[English](CONTRIBUTING.md) | 简体中文

## 前置条件

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 22.18（CI：22.19.0） | 全部；TypeScript 直接运行，没有构建步骤 |
| npm | ≥ 10 | workspaces |
| git | ≥ 2.24 | fixture 仓库、worktree |
| 支持非特权用户命名空间的 Linux、util-linux `unshare`、python3 | – | 测试中执行命令所用的本地沙箱。Ubuntu 24.04 上需执行：`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` |
| pytest、Go | 较新版本即可 | pytest 与 `go test -json` 运行器测试（缺失时跳过） |
| PostgreSQL 16 服务端二进制、curl | – | 可选：`npm run infra:up`（PostgreSQL、NATS、Temporal、OPA） |

## 修改之前

1. 阅读[实施蓝图](docs/architecture/BLUEPRINT.md)：不变量 I1–I12、包依赖 DAG 与关键流程。
2. 阅读目标包的 `src/contracts.ts`（有约束力的 ABI）与 `README.md`。
3. 阅读 [AGENTS.md](AGENTS.md)：Agent 与人都必须遵守的规则。
4. 在 [CONFORMANCE.zh-CN.md](docs/architecture/CONFORMANCE.zh-CN.md) 中查看所涉及领域的当前状态。

## 工作流程

1. **契约优先。** 先修改 `src/contracts.ts`，再写实现。契约变更必须是增量且向后兼容的，并记录在包 README 的
   “Contract changes” 中。
2. **在 DAG 内实现。** 包只能导入 `scripts/check-boundaries.mjs` 允许的包，第三方 SDK 只能留在其适配器包中
   （`@temporalio/*` 在 durable，`@nats-io/*` 在 collab，`pg` 与 PGlite 在 store，依此类推）。领域代码绝不导入
   引擎（Pi/DSH）、Temporal 或 NATS 的类型。
3. **测试失败路径。** 每个生产变更都要测试出错时的行为。新的保证需要一个在旧代码上会失败的测试。
4. **运行检查**（见下文）：在 PGlite 上运行；涉及 SQL 的变更还要在 PostgreSQL 上运行。
5. **在同一变更中更新文档。** 更新包 README（行为与契约变更）。需求状态变化时更新
   [CONFORMANCE.md](docs/architecture/CONFORMANCE.md) 中对应的行。面向框架使用者的文档是双语的：修改 `README.md`、
   `CONTRIBUTING.md` 或 `docs/architecture/` 中有 `*.zh-CN.md` 镜像的文档时，同时更新镜像，并保留顶部的语言切换链接。

## 命令

| 命令 | 作用 |
|---|---|
| `npm ci` | 严格按 lockfile 安装 |
| `npm run check` | 类型检查（`tsc --noEmit`）与包边界检查 |
| `npm test` | 单元、集成与 e2e 测试（`scripts/run-tests.mjs`） |
| `npm run test:unit` / `test:integration` / `test:e2e` | 只运行一类；追加 `-- --package <name>` 只运行一个包 |
| `node scripts/run-tests.mjs --package <name>` | 一个包的全部测试 |
| `HYPERTEST_TEST_DB=postgres npm test` | 所有存储都使用全新的 PostgreSQL schema（需要 `HYPERTEST_TEST_PG_URL`） |
| `npm run infra:fetch` / `infra:up` / `infra:status` / `infra:down` | 本地 PostgreSQL、NATS JetStream、Temporal 开发服务器与 OPA；`up` 会写入 `.infra/env`，测试运行器会自动加载 |
| `npm run eval:gate` | 使用脚本化多模型分组运行核心评测套件，并与 `packages/eval/baselines/core-scripted-multi-llm.json` 比较（报告位于 `.hypertest-eval/`） |
| `npm run license:check` / `npm run sbom` / `npm run test:scripts` | 基于 lockfile 的许可证策略、CycloneDX SBOM（`.hypertest-sbom.json`）、这些脚本的测试 |

CI（`.github/workflows/ci.yml`）在 PostgreSQL 16 服务容器上运行 `npm run check`、`npm test` 与 `npm run eval:gate`；
第二个任务用 `HYPERTEST_TEST_DB=postgres` 运行整个套件；供应链任务运行脚本测试、许可证策略与 SBOM，并运行仅供参考的
`npm audit`。

- 新依赖必须通过 `npm run license:check`。允许列表之外的许可证需要在 `scripts/license-exceptions.json` 中有已评审的
  条目，写明包名、确切的许可证表达式与理由。
- 修改评测评分器需要新的修订号并重新固定 `packages/eval/graders.lock.json`（否则 `test/grader-versions.test.ts`
  会失败）；新的套件、评分器或评测 harness 修订需要重新生成基线（见 eval README 的 “Versioned graders”）。

## 测试

- 使用 `node:test` 与 `node:assert/strict`，位于 `packages/<pkg>/test/`。文件分为 `*.test.ts`（单元：封闭、无网络）、
  `*.int.test.ts`（集成：本地基础设施）与 `*.e2e.test.ts`（使用脚本化模型的完整运行）。
- 缺少所需基础设施的测试会**带明确原因跳过**，绝不静默通过。
- 测试中的模型是 `ScriptedProvider` 大脑或本地模拟服务器。注入 `Clock` 与 `IdGenerator` 以获得确定性结果。
- 绝不让断言迁就错误的行为，也绝不为了变绿而跳过或删除失败的测试。PASS、FAIL、XFAIL、SKIP 与伪绿是不同的信号。

## 代码规则

- 只使用可擦除的 TypeScript（Node 会剥离类型）：不用 `enum`、`namespace`、参数属性或装饰器。类型用 `import type`；
  相对导入以 `.ts` 结尾。
- 故障抛出 `HypertestError`（code、message、retryable）。正常的否定结果作为结果返回：失败的测试是一次成功的工具
  调用，其结果为失败。
- 持久化通过 `SqlDatabase` 端口。迁移命名为 `<pkg>/<nnn>-<name>`，表以 `ht_` 开头，且必须能在 PGlite 与
  PostgreSQL 16 上运行。仅追加的表保持仅追加。
- 库代码中不使用 `console.log`；使用 `Logger` 端口。
- 模型提议，确定性代码处置：每次工具调用都经过 能力 → 许可 → 新鲜度（变更类）→ Operation Ledger（副作用）→ 证据。
  外部副作用只能通过带稳定 operation id 的副作用网关。事件消费者按事件 id 去重。
- 只有 QualityGate 产出结论，证据缺失即 `inconclusive`。不要增加任何能让 Agent 放宽 oracle、断言或阈值的路径。

## Pull Request

- 保持变更聚焦；不要把无关的上游升级合并在一起。
- 引擎升级（`@earendil-works/pi-agent-core` 是精确固定的版本）必须通过引擎契约套件
  （`packages/runtime/src/contract-suite.ts`）。
- 新的工具或副作用适配器需要说明其效果、风险等级、资源、幂等性与对账行为，并测试超时、未知结果与重复投递。
- 新配置绝不接受内联密钥：使用 `*Env` 字段。
