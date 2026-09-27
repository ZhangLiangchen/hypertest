# Hypertest 运维

[English](OPERATIONS.md) | 简体中文

如何部署、加固、恢复、发布与升级 Hypertest。配置参考见 [app README](../../packages/app/README.md)；所有命令见
[CLI README](../../packages/cli/README.md)。除表中另有说明外，以下配置都已在开发主机上使用脚本化模型端到端运行过
（PostgreSQL 16、NATS JetStream、Temporal 开发服务器与 OPA，均由 `npm run infra:up` 启动）。

## 1. 部署配置

| 配置 | 存储 | 总线 | 持久运行时 | 进程 | 适用场景 | 已验证 |
|---|---|---|---|---|---|---|
| 本地 | PGlite（`<dataDir>/db`） | 进程内 | local | 每个数据目录一个进程（由锁文件强制） | 开发机、CI | 是 |
| 服务器 | PostgreSQL | 进程内或 NATS | local | 一个驱动进程（`hypertest serve`）加任意数量的 CLI 客户端 | 团队共享主机 | 是 |
| 分布式 | PostgreSQL | NATS JetStream | Temporal，`workerMode: external` | N 个 `hypertest worker` 进程加客户端（`run --detach`、`status`、`approve` 等） | 多主机、长时间运行 | 是（一个 worker） |

可选组件：OPA 策略（已验证）、带 Object Lock 的 S3 artifact 存储（已实现；未在真实端点上运行）、PowerContext 记忆
（已实现；未在真实服务上运行）。

### 本地

即 `hypertest init` 生成的配置。`hypertest run` 在 CLI 进程中驱动运行。崩溃或按下 Ctrl-C 之后，用 `hypertest resume`
继续。PGlite 只允许一个进程：运行进行期间，同一数据目录上的其他命令会被拒绝，并给出持锁者。

### 服务器

```yaml
store: { kind: postgres, urlEnv: HYPERTEST_PG_URL, schema: hypertest }
bus: { kind: nats, servers: "nats://127.0.0.1:4222" }     # 进程内总线会把所有消息保存在内存中
```

```bash
export HYPERTEST_PG_URL=postgres://hypertest@db.internal:5432/hypertest   # 这里 URL 中可以带密码：它来自环境变量
export HYPERTEST_API_TOKEN=$(openssl rand -hex 24)
hypertest serve --port 7420 --token-env HYPERTEST_API_TOKEN   # REST API；先恢复未完成的运行，再驱动新运行
hypertest status                                              # 其他进程可在同一存储上读取和决定
```

### 分布式

```yaml
store: { kind: postgres, urlEnv: HYPERTEST_PG_URL, schema: hypertest }
bus: { kind: nats, servers: "nats://nats.internal:4222", stream: HYPERTEST, subjectPrefix: ht }
durable: { kind: temporal, address: "temporal.internal:7233", namespace: default, taskQueue: hypertest, workerMode: external }
policy: { capabilitySecretEnv: HYPERTEST_CAPABILITY_SECRET }
signing: { keyFile: /etc/hypertest/evidence-ed25519.pem }
```

```bash
openssl genpkey -algorithm ed25519 -out /etc/hypertest/evidence-ed25519.pem && chmod 600 /etc/hypertest/evidence-ed25519.pem
export HYPERTEST_PG_URL=… HYPERTEST_CAPABILITY_SECRET=…      # 密钥至少 16 个字符，所有进程必须相同
hypertest doctor                                             # 探测 PostgreSQL、NATS、Temporal 与 OPA
hypertest worker                                             # 在每台 worker 主机上运行；会打印其清单与任务队列
hypertest run "Is this change releasable?" --repo . --commit HEAD --detach   # 可从任意客户端发起
hypertest status <runId>
```

多进程部署的规则：

- **所有地方使用相同的代码与配置。** 这样它们得到同一个 `RuntimeManifest`。Worker 轮询的任务队列为
  `<taskQueue>@<清单的前 16 位十六进制>`，因此清单不同的 worker 永远不会收到该运行的 activity（见第 5 节）。在 canary
  期间，或 retiring 状态的发布仍有存活运行时，两个清单会并行运行：请为每个清单都保留 worker。
- **共享密钥。** `policy.capabilitySecretEnv`（其他 worker 会校验能力令牌）与 `signing.keyFile`（其他进程会校验
  封存）。使用 PostgreSQL 存储却没有共享能力密钥时，`hypertest doctor` 会给出警告；它不检查签名密钥。
- **Worker 身份。** 同一部署的 Temporal worker 共享身份 `worker:temporal:<namespace>/<taskQueue>`，因此 activity
  转移到另一个 worker 时租约依然有效。
- **环境代际**（已注册环境的部署与重启次数）保存在 PostgreSQL 中，由所有 worker 共享。

### 使用 OPA 的策略

```yaml
policy: { opa: { url: "http://127.0.0.1:8181", path: hypertest/agents } }
```

```rego
package hypertest.agents

default allow := false

allow if {
  input.effect in {"read", "record", "execute"}
}

reasons contains "agents may read, record and execute" if allow
```

用 `curl -X PUT -H 'content-type: text/plain' --data-binary @agents.rego http://127.0.0.1:8181/v1/policies/agents` 加载。
Hypertest 会向 `/v1/data/<path>` 发送 `{ input: ActionRequest }`（`tool`、`effect`、`riskClass`、`resources`、
`environmentClass`、`role`、脱敏后的 `input` 等），并期望得到 `{ allow, approval_required?, reasons?, constraints? }`。
OPA 与内置规则组合使用，任一方拒绝即拒绝。OPA 不可达或返回格式错误都视为拒绝（`opa_unavailable`）。策略修订号包含该
包模块的摘要，因此策略变更就是新的运行时清单。

### S3 artifact

```yaml
artifacts: { kind: s3, region: eu-central-1, bucket: hypertest-evidence, prefix: prod/, objectLockDays: 365,
             accessKeyIdEnv: AWS_ACCESS_KEY_ID, secretAccessKeyEnv: AWS_SECRET_ACCESS_KEY }   # MinIO 需加 endpoint 与 forcePathStyle
```

设置 `objectLockDays` 后，每个 artifact 都以 `ObjectLockMode=COMPLIANCE` 写入（存储桶必须启用 Object Lock）。不设置时，
以及使用默认 `fs` 存储时，证据是可发现篡改的（哈希链、封存），但不是 WORM。

## 2. 安全

| 控制项 | 默认值 | 建议 |
|---|---|---|
| Agent 命令沙箱 | `sandbox: { kind: local, network: loopback }` | 在支持非特权用户命名空间且有 python3 的 Linux 上，每条命令都运行在独立的 user、network、PID 与 mount 命名空间中。它只能访问自身 loopback，以及被中继的已注册环境与 `tools.httpAllowlist` 端点；密钥、存储、artifact 与其他工作区都被隐藏；命令参数不能指向工作区之外的路径。不支持命名空间的主机会拒绝这些配置。**残留风险：** 命令以同一 OS 用户运行，能读取主机其余文件系统。 |
| 不受信任的模型或代码 | – | 使用 `sandbox: { kind: oci, image: <含工具链的镜像>, network: none, cpuLimit, memoryMb }`（docker，`--cap-drop ALL`，禁止提升权限）。`network: open` 会取消本地沙箱的出站控制，只在可以接受的主机上使用。 |
| 密钥与凭据 | 文件中没有 | `*Env` 字段指定环境变量名；内联的密钥、令牌、密码与凭据请求头都是配置错误。沙箱中的命令只获得 `sandbox.envAllowlist`（默认 PATH、HOME、LANG、LC_ALL、TMPDIR）。`doctor` 只打印变量名，从不打印值。 |
| 数据目录 | `.hypertest/`（0700） | 存放数据库、artifact、`keys/`（0600）与工作区。不要提交到 git（`init` 会把它加入 `.gitignore`）。 |
| REST API | `127.0.0.1`，无令牌 | 始终在 `HYPERTEST_API_TOKEN` 中设置至少 16 个字符的令牌（或用 `--token-env` 指定其他变量）。非 loopback 的 `--host` 必须有令牌。通过 API 做人工决定始终需要令牌，因为 Agent 能访问 loopback 服务。远程使用时请在前面加 TLS。 |
| 人工决定 | CLI 或 API | `approve`、`oracle establish`、`oracle decide`、`waive`、`experience review` 以及运行时发布决定（`runtime register`、`record-suite`、`promote`、`rollback`、`migrate`）需要 `--by <name>`（命令要求时还需 `--reason`），并记录为 `human:<name>`（由 CI 执行的发布步骤使用 `--by ci:<pipeline>`）。请求者永远不能决定自己的请求。设置了 `HYPERTEST_SANDBOX` 时这些命令全部被拒绝，而两种沙箱都会在每条命令中设置它，因此 Agent 永远无法晋级评判它自己的运行时。 |
| 许可 | 内置规则 | 允许读取与记录；写入与执行只允许在工作区内。外部效果在 `local`/`sandbox` 环境中允许，在 `staging` 需要批准。破坏性效果在 `staging` 需要批准，在 `sandbox` 上高风险时需要批准，任何环境中的关键风险都需要批准。`production` 上高于读取的操作一律拒绝，Agent 永远不能决定审批或 oracle 变更。可通过 `policy.rules` 或 OPA 收紧。 |
| 环境 | 无 | 在 `environments:` 中注册黑盒目标并设置 `environmentClass`。控制面令牌来自 `control.tokenEnv`，从不写入文件。 |

使用 PGlite 时，暂停的运行持有存储锁，人无法从第二个进程批准。请停止前台命令（Ctrl-C；运行仍可恢复），执行
`hypertest approve …`，再执行 `hypertest resume`；或者使用 `serve` 与 API。

## 3. 恢复手册

| 情况 | Hypertest 的行为 | 你需要做的 |
|---|---|---|
| CLI 进程崩溃或被中断（退出码 130） | 运行保留在存储中；未结操作保留在台账中 | `hypertest resume`（或重启 `hypertest serve`，除非使用 `--no-resume`，它启动时会恢复） |
| Temporal worker 退出 | Activity 会发送心跳；同一部署的其他 worker 约一分钟内重试 | 用相同的代码与配置重启 worker |
| 重启时有进行中的副作用 | `verified` 操作返回已记录的结果；`dispatching`、`acknowledged` 与 `outcome_unknown` 操作先观察并对账，再决定是否重新派发；外部压测任务按 operation id 重新挂接；过期租约获得新的 fencing token；泄漏的预算预留被释放 | 无需操作。报告中的 “Recovery log” 会列出对账与重跑的内容 |
| 出现指明持锁者的 `precondition_failed`（PGlite） | 本机已退出进程留下的锁会被自动接管 | 如果持锁者在另一台已下线的主机上，删除 `<dataDir>/db.lock` |
| 某个操作进入 `manual_review` | 永不自动重试：其结果无法确认，或该操作不可重复 | `hypertest events <runId> --types operation.manual_review,operation.late_receipt`；用 operation id（即幂等键与任务标签）检查目标系统；手工清理；发起新运行。台账条目作为审计记录保留 |
| 已批准一个会翻转已记录失败的 oracle 变更 | 依赖旧修订的决定被标记；历史不会被改写 | `hypertest status <runId>` 会显示重新评估标记；发起新运行，它会固定新修订 |
| 运行期间固定的 oracle 被取代 | 门禁准则 C0 为 `unknown`，结论为 `inconclusive` | 发起新运行 |
| 运行预算耗尽 | 运行带着已有证据进入门禁（绝不静默降级）；证据缺口使结论为 `inconclusive` | 在配置（或 `POST /runs`）中提高 `budget`，发起新运行 |
| 运行中的任务固定在另一个运行时清单上 | 不会被恢复；控制平面拒绝驱动它 | 用其所属运行时完成它、迁移它（`hypertest runtime migrate`，见 5.3 节），或执行 `hypertest cancel <runId> --reason "…"` |
| `hypertest run` 失败并报告 `runtime release: … new runs are created only under the active release …`（`precondition_failed`） | 本运行时不是 active 发布（或是未选中该运行的 canary、已回滚的发布，或在设置了 `runtime.requireActiveRelease` 时没有 active 发布）；没有创建运行 | 在部署了 active 发布的地方运行，或发布本运行时（见 5.2 节） |
| 某个运行时发布表现异常（canary 或 active） | – | `hypertest runtime rollback [<manifestId>] --by <name> --reason "…"`（见 5.3 节）；然后针对 active 发布重新运行套件 |
| 运行处于暂停状态 `quarantined` | 其发布已被回滚；该运行不会在其上被驱动或恢复 | `hypertest runtime migrate <runId> --to <active 清单> --by <name> --reason "…"`，然后在该运行时上执行 `hypertest resume`；或执行 `hypertest cancel` |
| 运行处于暂停状态 `migrating`，但没有迁移在进行 | 迁移进程在检查点与重新固定之间退出；恢复被拒绝 | `hypertest runtime migrate <runId> --abort --by <name> --reason "…"`：运行在其仍固定的运行时上继续 |
| 某个门禁准则不应阻塞本次运行 | – | `hypertest waive <runId> <criterionId> --by <name> --reason "…" [--expires <time>]`：在下一次门禁评估时生效并记录在决定中；C1 证据完整性永远不可豁免 |

## 4. 证据验证

```bash
hypertest evidence verify <runId>          # 全部通过时退出码 0；否则为 1 并列出问题
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/runs/<runId>/evidence/verify
```

检查内容：

- 每条记录的哈希链；
- 每个 artifact 的 SHA-256 与其字节是否一致；
- Merkle 根及其 Ed25519 封存；
- 结论本身：`QualityDecision` 必须由受信任的密钥对其内容签名，并绑定到已封存的根。

受信任的密钥是所有 `<dataDir>/keys/*.pub.pem`，因此轮换后的密钥仍能验证旧封存。轮换 `signing.keyFile` 时请保留旧公钥。
`hypertest report <runId>` 会显示根、封存与签名者。限制：应用使用本地密钥签名（evidence 包的 `Signer` 接口是
KMS/HSM 端口，但尚未接入 KMS 签名器）。记录不携带 `traceId`，WORM 存储需要 S3 Object Lock。

## 5. 升级、运行时发布与清单固定

每个运行都固定到启动它的运行时的 `RuntimeManifest`（不变量 I11）。清单 id 是以下内容的哈希：

- Hypertest 版本、源码摘要（`packages/*/src` 下的每个文件）、安装目录的 git 提交（仅当它是 git checkout 的顶层时）
  以及来自 `HYPERTEST_IMAGE_DIGEST` 的镜像摘要（在容器构建中设置，格式为 `sha256:<64 位十六进制>`；格式错误时启动失败）；
- Agent 引擎及其适配器包与默认引擎、供应商适配器与模型目录（路由）；
- 模式版本（每个存储的最后一个迁移）；
- 策略包（内置规则、OPA 模块摘要）与角色目录修订；
- 工具目录修订（工具及其超时与副作用绑定、副作用适配器能力）与 BUGate 协议。

Oracle、预算与门禁设置属于运行输入，不在清单中。`GET /health`、`hypertest worker` 与 `hypertest runtime show current`
会打印当前清单；`hypertest status <runId>` 会打印该运行的清单。修改代码、路由、角色、策略或协议都属于升级，并产生新清单。

### 5.1 非受管与受管安装

在第一个发布被激活之前，安装处于**非受管**状态：除已回滚的运行时外，任何运行时都可以启动运行，升级就是重新部署
（见 5.4 节）。一旦有发布处于 **active**，新运行只会在 active 发布下启动，或在 canary 的选择命中该运行时在 canary 下
启动。在其他任何运行时上执行 `hypertest run` 都会失败（`precondition_failed`，退出码 1），且不创建运行。设置
`runtime: { requireActiveRelease: true }` 可在没有 active 发布时拒绝新运行。

发布记录保存在存储中，因此使用同一个 PostgreSQL 存储（或数据目录）的所有安装看到的是同一个注册表。`<manifestId>`
参数可以是完整 id、唯一前缀或 `current`（执行命令的安装的运行时）。每个决定都需要 `--by <name>`（人）或
`--by ci:<pipeline>`，命令要求时还需 `--reason`；决定记录在只追加的发布历史中，并在 Agent 沙箱内被拒绝。

### 5.2 发布新的运行时

把新的代码或配置部署在 active 发布旁边，使用同一个存储（使用 PGlite 时，同一时间只有一个进程拥有数据目录），然后在新安装上执行：

| 步骤 | 命令 | 说明 |
|---|---|---|
| 1. 注册 | `hypertest runtime register --by <name> [--allow-migration <schema>:<from>=><to> …]` | 清单成为 `candidate`。`--allow-migration` 指定较早发布的运行在迁移到本发布时可以采用的 schema 变化；注册时即固定。要注册另一个安装的清单，先在那里用 `hypertest runtime show current --json > manifest.json` 导出，再执行 `register --manifest manifest.json`。 |
| 2. 引擎契约 | 运行所用引擎的 AgentEngine 契约套件（`node scripts/run-tests.mjs --package runtime`、`--package runtime-pi`、`--package runtime-dsh`），然后执行 `hypertest runtime record-suite current --kind engine_contract --suite agent-engine-contract --passed --total <n> --by ci:<pipeline>` | 失败用 `--failed --failures <n>` 记录。声称通过但有失败用例或零个用例的结果会被拒绝。 |
| 3. 回放 | `hypertest eval run core --arms scripted-multi-llm --out core.json`，然后执行 `hypertest runtime record-suite current --kind replay --from-eval core.json --by ci:<pipeline>` | `--from-eval` 从 SuiteResult 中读取套件 id、修订与结果（所有试验都必须通过），并把记录绑定到文件的 sha256。`--arms config` 评测配置中自己的模型（需要设置其密钥变量）。可先用 `hypertest eval gate --baseline <file> --candidate core.json` 与基线比较。 |
| 4. Shadow | `hypertest runtime promote current --by <name> --reason "…"` | candidate → shadow。每次晋级都要求该清单最新的 `engine_contract` 与 `replay` 结果为通过；之后记录的失败结果会阻止下一步。shadow 发布不会在存储中启动运行（评测试验使用各自的全新存储）。 |
| 5. Canary | `hypertest runtime promote current --by <name> --reason "…" --canary-percent 10 [--canary-label key=value …]` | shadow → canary。进入 canary 需要选择条件：新运行 id 的比例和/或标签（`hypertest run --label key=value`）。最多一个 canary。 |
| 6. 激活 | `hypertest runtime promote current --by <name> --reason "…"` | canary → active。active 指针移动；上一个 active 发布变为 `retiring`（其存活运行继续在其上运行），当没有存活运行固定在它上面时退役（`runtime list` 与 `promote` 会让已排空的发布退役）。 |

`hypertest runtime list` 显示每个发布的状态、active 指针、canary 比例及其存活运行；`hypertest runtime show <manifestId>`
显示一个清单及其已记录的套件结果。使用 Temporal 时，请保留仍有存活运行的每个发布的 worker：每个清单轮询自己的任务队列。

### 5.3 回滚与迁移运行

`hypertest runtime rollback [<manifestId>] --by <name> --reason "…"` 回滚指定的发布；不指定 id 时停止 canary，否则把
active 发布回滚到上一个 active 发布（该发布必须仍已注册且自身未被回滚）。被回滚的发布永久退役，不会再被晋级。其存活
运行会被**隔离**：以 `pauseReason: quarantined` 暂停，记录为 `run.quarantined`，在报告中注明，并被 `resume` 拒绝。
其他所有发布的运行无需任何迁移，继续使用其固定的清单。命令会打印被隔离的运行，并提示针对 active 发布重新运行兼容性
与回放套件（`record-suite`）。然后在被回滚发布运行的地方部署 active 发布的代码与配置。

被隔离的运行，或任何应迁移到另一个发布的存活运行，都需要显式迁移：

```bash
hypertest runtime migrate <runId> --to <manifestId>|current --by <name> --reason "…" [--checkpoint-timeout-ms n]
hypertest resume            # 在目标运行时上执行：迁移本身从不驱动运行
```

迁移会为运行建立检查点（进行中的回合交还 claim；默认等待 90 秒），生成规范快照并对账其操作（有未结算操作或有工作项
在等待时拒绝）。然后检查兼容性：目标为 active 或 canary，schema 相同或被允许的迁移覆盖，运行用过的引擎都已固定，
协议相同。一个事务中记录 RuntimeEpoch 与 `run.migrated`，重新固定运行并恢复它。被拒绝的迁移不会改变运行。也可以用
`hypertest cancel <runId> --reason "…"` 取消运行。

如果迁移进程在检查点与重新固定之间退出，运行会保持 `migrating` 暂停状态且无法恢复。
`hypertest runtime migrate <runId> --abort --by <name> --reason "…"` 会释放检查点（`run.migration_released`），运行在其
仍固定的运行时上继续（已回滚发布的运行则会被隔离）。

限制：套件结果由记录者证明，且 `promote` 接受任何通过的回放套件，因此请让发布流水线记录核心套件。迁移已在本地持久
运行时上验证，未在真实 Temporal 服务上验证（使用 Temporal 时，源工作流会在下一次 tick 时失败，目标运行时上的
`resume` 会在目标任务队列上启动该运行的工作流）。

### 5.4 非受管升级与数据库迁移

没有 active 发布时：

1. 让运行中的任务完成，或取消它们。使用 Temporal 时也可以让旧 worker 继续运行：它们会继续轮询自己的队列，直到其
   运行结束。
2. 部署新的代码与配置。迁移在启动时执行；迁移是幂等的，并记录在 `ht_migrations` 中。
3. `hypertest resume`（或 `serve`）只恢复固定到新清单的运行。固定在其他清单上的运行会记录日志并保持不动。

回滚即重新部署旧的代码与配置；相同内容得到相同的清单 id，因此旧运行时可以再次驱动它的运行。两种模式下数据库迁移都
只能向前（没有回退迁移），并且必须与仍在运行的发布兼容（先扩展，再收缩）：请先在数据库副本上演练回滚。

## 6. 可观测性

- 日志以 JSON 行输出到 stderr。用 `observability.logLevel`、`--log-level` 或 `HYPERTEST_LOG_LEVEL` 设置级别。
- `hypertest events <runId> [--follow] [--types a,b]` 与 `GET /runs/:id/events`（SSE）输出 L0 事件：模型路由、工具
  调用、许可、操作、准入与门禁评估，带 correlation 与 causation id。
- 没有 OpenTelemetry 导出，事件不携带 `traceId`。

## 7. 供应链检查

CI 在每次 push 与 pull request 时运行以下检查（技术选型 §许可证策略）：

| 检查 | 命令 | CI |
|---|---|---|
| 许可证策略 | `npm run license:check`（`--json`、`--omit dev`、`--allow ID,…`） | 阻断 |
| SBOM | `npm run sbom` 把 CycloneDX 文档写入 `.hypertest-sbom.json`（`--out <file>`、`--omit dev`） | 作为 `sbom` artifact 上传 |
| 漏洞 | `npm audit --omit=dev --audit-level=high` | 仅供参考（安全公告会在代码不变时变化） |
| 脚本测试 | `npm run test:scripts` | 阻断 |
| 评测发布门禁 | `npm run eval:gate`（核心套件与 `packages/eval/baselines/core-scripted-multi-llm.json` 比较；报告位于 `.hypertest-eval/`） | 阻断 |

- **许可证策略。** 每个已安装包的 `license`（SPDX 表达式）必须能由允许列表满足：MIT、ISC、BSD-2-Clause、
  BSD-3-Clause、Apache-2.0、0BSD、BlueOak-1.0.0、CC0-1.0、Unlicense、Python-2.0 与 CC-BY-4.0。未知许可证（缺失、
  无法解析、`UNLICENSED`、“SEE LICENSE IN …”）以及 copyleft 或其他许可证都会失败，除非 `scripts/license-exceptions.json`
  中有已评审的例外。例外需写明包名、评审时针对的确切许可证表达式（可选版本）与理由，因此之后的许可证变更会被重新评审。
  “BSD”或“Public Domain”这类含糊写法永远不会被映射为允许的许可证，过时的例外会以警告报告。退出码：0 通过，1 违规，
  2 用法错误或输入不可读。当前 lockfile（400 个包）在一个例外（`unionfs`，没有 license 字段，附带 Unlicense）下通过。
- **SBOM。** 优先取自 `npm sbom`（npm ≥ 10.1）；否则根据 `package-lock.json` 生成 CycloneDX 1.5，包含每个包的 purl、
  版本、许可证、lockfile 中的 SHA-512 完整性哈希与解析 URL。来源记录在 `metadata.properties`（`hypertest:sbom:source`）
  中。两种情况下 lockfile 都是依赖来源的记录。
- **审计。** 撰写本文时，`npm audit --omit=dev` 报告一个中等级别公告（`ajv`，使用 `$data` 选项时的 ReDoS）。CI 步骤不会
  因此阻断。
- **尚未覆盖：** fork 补丁跟踪与包签名/来源证明（`npm audit signatures`）。
- 生成的 `.hypertest-sbom.json` 与 `.hypertest-eval/` 是构建输出，请勿提交。
