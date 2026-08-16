# 禁用不安全 Hermes argv 路径开发记录

## 范围与来源

本次 B1a 从 `origin/main` 提交
`5169efbed90858d7228c96a9d32acca403600a69` 建立独立分支
`codex/disable-unsafe-hermes-argv`。主工作树原有未提交修改保持不动。

本任务只修改 Family AI 仓库中的 Provider 私密输入边界，不部署、停止或重启
正式 `127.0.0.1:8790`，不修改 Hermes Home/Profile/模型或任何凭据。没有端口
变化，因此不更新 `service-ports.*`；已先读取 `agent-architecture.md`，但代码
尚未部署成正式运行架构，因此不把新行为写入外部架构台账。

## 能力结论

2026-08-16 重新核对当前本机 Hermes 与官方仓库：`hermes chat` 只有
`-q/--query`，没有受支持的 stdin/FD 单次 query 契约。本机 help hash、代码
提交和官方 parser 证据见
`docs/superpowers/specs/2026-08-13-provider-private-input-boundary-design.md`。

因此 H0 未满足，B1b 继续阻断；B1a 已删除可达的 Hermes prompt-in-argv
实现。`disabled`、缺省以及预留的 `query-stdin-v1` 均离线、返回脱敏
`PROVIDER_UNAVAILABLE` 且零 spawn。Codex 继续使用 stdin。

## RED → GREEN

基线 `npm run check`：contracts `75/75`、Provider SDK `39/39`、Gateway
`805/805`，合计 `919/919`；类型检查、静态检查与构建均通过。

初始 RED：

- Provider SDK：新零 spawn 用例 `3 failed / 15 passed`；旧实现 health 仍为
  online 并执行 `chat -q <prompt>`。
- Gateway：4 个目标文件合计 `5 failed / 53 passed`；配置无私密输入模式、
  Agent 仍显示在线、Preview 未显式关闭。
- Chat/Work 的首个假 RED 被追溯到 `.mjs` 测试夹具误用 CommonJS
  `require`。改用 ESM import 后，旧实现明确产生 marker，证明真实 spawn；
  同时返回 `PROVIDER_RESPONSE_INVALID` 而非目标错误。

聚焦 GREEN：

- Provider SDK Hermes + Codex：`2 files / 11 tests` 全部通过；
- Gateway config/status/message/Preview：`4 files / 58 tests` 全部通过；
- Hermes 缺省、`disabled`、`query-stdin-v1` 均零 spawn；
- Gateway 保留 Hermes catalog 但 health offline；
- Codex 仍从 stdin 收到 prompt，argv 不含 prompt 或 `-q`。

## 实现边界

- SDK Hermes Adapter 不再导入进程 runner 或 prompt builder，不存在可达 spawn；
- Gateway 严格解析
  `FAMILY_AI_HERMES_PRIVATE_INPUT_MODE=disabled|query-stdin-v1`，未知值在启动
  配置阶段 fail-closed；
- Preview 生成与自校验均要求精确值 `disabled`；
- Chat/Work 继续使用既有公开错误映射，不新增 Provider 私密诊断；
- 不实现 B1b 的虚构参数或 fallback。

## 最终门禁

- `npm run check`：contracts `75/75`、Provider SDK `27/27`、Gateway
  `808/808`，合计 `910/910`，零失败、零跳过；静态检查、类型检查和构建通过。
- Provider SDK 测试数减少来自删除所有会执行旧 Hermes argv 成功/解析路径的
  测试，并替换为三态零 spawn 状态矩阵；Gateway 增加 3 条回归。
- `git diff --check`：通过。
- Docker/隔离验收、正式服务只读证明和 CI/PR 结果仍待执行；未执行项不得从
  本地全量测试推断为通过。
