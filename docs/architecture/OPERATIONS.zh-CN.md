# Hypertest 运维

[English](OPERATIONS.md) | 简体中文

如何部署、加固、恢复与升级 Hypertest。配置参考见 [app README](../../packages/app/README.md)；所有命令见
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
  `<taskQueue>@<清单的前 16 位十六进制>`，因此清单不同的 worker 永远不会收到该运行的 activity（见第 5 节）。
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
| 人工决定 | CLI 或 API | `approve`、`oracle establish`、`oracle decide`、`waive` 与 `experience review` 需要 `--by <name>`（命令要求时还需 `--reason`），并记录为 `human:<name>`。请求者永远不能决定自己的请求。设置了 `HYPERTEST_SANDBOX` 时这些命令全部被拒绝，而两种沙箱都会在每条命令中设置它。 |
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
| 运行中的任务固定在另一个运行时清单上 | 不会被恢复；控制平面拒绝驱动它 | 用其所属运行时完成它（见第 5 节），或执行 `hypertest cancel <runId> --reason "…"` |
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

## 5. 升级与清单固定

每个运行都固定到启动它的运行时的 `RuntimeManifest`（不变量 I11）。清单 id 是以下内容的哈希：

- Hypertest 版本与源码摘要（`packages/*/src` 下的每个文件）；
- Agent 引擎、供应商适配器与模型目录（路由）；
- 模式版本；
- 策略包（内置规则、OPA 模块摘要、角色目录）；
- 工具目录与 BUGate 协议。

Oracle、预算与门禁设置属于运行输入，不在清单中。`GET /health` 与 `hypertest worker` 会打印当前清单；
`hypertest status <runId>` 会打印该运行的清单。

修改代码、路由、角色、策略或协议都属于升级：

1. 让运行中的任务完成，或取消它们。使用 Temporal 时也可以让旧 worker 继续运行：它们会继续轮询自己的队列，直到其
   运行结束。
2. 部署新的代码与配置。迁移在启动时执行；迁移是幂等的，并记录在 `ht_migrations` 中。
3. `hypertest resume`（或 `serve`）只恢复固定到新清单的运行。固定在其他清单上的运行会记录日志并保持不动。

回滚即重新部署旧的代码与配置；相同内容得到相同的清单 id，因此旧运行时可以再次驱动它的运行。迁移只能向前（没有
回退迁移）：请先在数据库副本上演练回滚。发布状态、活动运行时指针以及把运行中的任务迁移到新运行时都尚未实现
（见 [CONFORMANCE.zh-CN.md](CONFORMANCE.zh-CN.md) 的“运行时清单与发布”）。

## 6. 可观测性

- 日志以 JSON 行输出到 stderr。用 `observability.logLevel`、`--log-level` 或 `HYPERTEST_LOG_LEVEL` 设置级别。
- `hypertest events <runId> [--follow] [--types a,b]` 与 `GET /runs/:id/events`（SSE）输出 L0 事件：模型路由、工具
  调用、许可、操作、准入与门禁评估，带 correlation 与 causation id。
- 没有 OpenTelemetry 导出，事件不携带 `traceId`。
