# Provider 私密输入边界设计

## 目标

Family AI Gateway 不得把成员消息、附件元数据或本机私有路径序列化进
Provider 子进程的 argv 或环境变量。B1a 先移除仓库中已知可达的 Hermes
`chat -q <prompt>` 路径；B1b 只有在 Hermes 提供受支持、可验证的 stdin/FD
单次输入契约后才允许重新启用 Hermes 调用。

## 威胁边界

argv 不是私密输入通道。运行中进程的命令行可被同一主机上的进程检查、进程
管理器采集或写入诊断记录。旧 Hermes Adapter 把完整 prompt 放在 `-q` 后，
因此消息正文以及拼入 prompt 的附件文件名和绝对路径都可能越过 Gateway 的
公开错误脱敏边界。

环境变量、临时文件路径参数和 shell 拼接具有同类问题，不能作为 stdin 缺失
时的回退通道。修复必须发生在 SDK Adapter 边界，不能只依赖 Gateway 调用方
“记得关闭”。

## 2026-08-16 能力核对

- 本机 Hermes 入口解析到
  `/home/youran/.hermes/.upgrade-staging/hermes-agent-v2026.8.3`；代码提交为
  `71a332a37e7783b787d88aae967df6751877b594`，工作树干净，版本描述为
  `v2026.8.3-22-g71a332a37`。
- `hermes chat --help` 的 SHA-256 为
  `809684b2ee9577af2fbb23f2dd722e437cfd53c6d78e89e2348d0edb70fd6b2a`；
  单次 query 只有 `-q/--query`，没有 stdin、FD 或 query-stdin 参数。
- 官方 Hermes 仓库的 CLI parser 与 CLI 文档也只登记 `-q/--query`。本次没有
  猜测或拼接一个尚不存在的 Hermes 参数。
- `codex exec --help` 的 SHA-256 为
  `9f86f0115238ddde2514587e5f95b0ab0aa6b89495e5912878d49ad26038aa19`；
  prompt 省略或使用 `-` 时由 stdin 读取。现有 Codex Adapter 已使用该通道。

结论：H0 当前不满足，B1b 被外部能力 Gate 阻断；B1a 不受此阻断，必须先
fail-closed。

## B1a 状态机

| 配置来源 | 值 | Gateway 启动 | Hermes health | Hermes invoke | 子进程 |
|---|---|---:|---|---|---:|
| 未配置 | 缺省 | 允许，规范化为 `disabled` | `offline` | `PROVIDER_UNAVAILABLE` | 0 |
| 显式配置 | `disabled` | 允许 | `offline` | `PROVIDER_UNAVAILABLE` | 0 |
| 显式配置 | `query-stdin-v1` | 允许，仅保留能力标签 | `offline` | `PROVIDER_UNAVAILABLE` | 0 |
| 显式配置 | 其他值 | 拒绝，固定配置错误 | 不适用 | 不适用 | 0 |

`HermesCliProviderOptions.privateInputMode` 同样只接受
`disabled | query-stdin-v1`。SDK 在 B1a 中不包含任何 spawn 分支，因此直接
构造 Adapter 也无法恢复 `-q`。`query-stdin-v1` 不是功能开关，只是给 B1b
预留的版本化能力名称。

Gateway 仍注册 Jarvis 与个人 Hermes Agent/Profile catalog，使管理员可以看见
预期绑定及其明确离线状态；消息调用返回固定、脱敏、可重试的
`PROVIDER_UNAVAILABLE`。Preview 必须显式写
`FAMILY_AI_HERMES_PRIVATE_INPUT_MODE=disabled`，不能依赖缺省值。

Codex Adapter 不受 Hermes 状态影响，继续把 prompt 只写入 stdin。Gateway
回归测试同时证明 Hermes 零 spawn 与 Codex stdin 调用仍可成功。

## B1b 启用门槛

B1b 必须是从包含 B1a 的最新 `main` 创建的独立 direct-main PR，并同时满足：

1. 当前 Hermes 官方 release/commit 明确定义一次性 stdin 或 FD 输入契约；
2. 本机 `--help`、官方 parser/文档和最小无隐私 one-shot 三者一致；
3. 自动测试从 spawn 边界和 `/proc/<pid>/cmdline`、`environ` 证明唯一敏感标记
   不在 argv/env，且 stdin 精确收到一次完整 UTF-8 输入；
4. timeout、abort、EPIPE、输入上限和子进程提前退出均关闭输入与进程组；
5. 不保留 `-q`、环境变量、临时文件路径或 shell fallback；
6. 正式运行架构实际部署后，才更新外部 `agent-architecture.md` 台账。

任一门槛不满足时，回滚结果只能是继续 `disabled`；不得恢复 argv prompt。

## 非目标

- 不修改 Hermes Home、Profile、模型、凭据、Session 或服务；
- 不重启 Hermes、个人助理或正式 `127.0.0.1:8790`；
- 不在自动测试中调用真实 Hermes/Codex；
- 不把 B1a 代码合入描述成正式 Gateway 已部署。
