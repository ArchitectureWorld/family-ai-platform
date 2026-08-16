# 禁用不安全 Hermes argv 路径开发记录

## 范围与来源

本次 B1a 从 `origin/main` 提交
`5169efbed90858d7228c96a9d32acca403600a69` 建立独立分支
`codex/disable-unsafe-hermes-argv`；实现与运行验证提交为
`48f136872c6c7d259eb8226ffe126f1e8a0b4fad`。主工作树原有未提交修改保持不动。

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

## 完整门禁

| 门禁 | 状态 | 命令/证据或 SKIP 原因 |
|---|---|---|
| 聚焦 RED | PASS | SDK `3 failed / 15 passed`，Gateway `5 failed / 53 passed`；修正 ESM fixture 后旧实现明确写入 spawn marker，并返回旧错误，失败来自目标缺陷 |
| 聚焦 GREEN 与领域回归 | PASS | Provider SDK Hermes + Codex `2 files / 11 tests`；Gateway config/status/message/Preview `4 files / 58 tests`，全部通过 |
| `npm ci` / `npm run check` | PASS | `npm ci` 成功；最终 check 为 contracts `75/75`、SDK `27/27`、Gateway `808/808`，合计 `910/910`，宿主零失败零跳过；静态检查、类型检查、构建通过 |
| 不可变镜像构建 / Docker smoke | PASS | `docker compose build` 通过；精确 source `48f136872c6c7d259eb8226ffe126f1e8a0b4fad`，image `sha256:f139295dc99ad48044b586ea6b3ca808cad7bd4be0f0feb306da5d5942675b51`，archive SHA-256 `2183502c604336a1c76832664321746167a3aa35dbe9528e38a94c1ecff3852d`；容器内 Gateway `807 passed / 1 skipped`，该 Preview-host 用例在宿主通过；production prune `0 vulnerabilities` |
| 隔离 dev-up / acceptance | PASS | runtime `/tmp/family-ai-b1a-runtime.bIN8Fd`，project `family-ai-b1a-48f1368`，随机 loopback `32803`；基础 acceptance 与容器附件重启/SHA 验收通过，报告 `/tmp/family-ai-b1a-runtime.bIN8Fd/reports/gateway-foundation-20260816-102916.md`；正式 `8790` before/after health hash 均为 `169e9de22c2ac0692d38b07ecfd8800519e99140c49bb935cb3cadb47f252f1b`，容器 `b4c2f7876e6d` 与 listener 不变 |
| 任务专属容器 / 浏览器 | PASS | Hermes 三态真实 dummy executable 均零 spawn；`agent-browser 0.27.0` 在同一精确 image 的独立 runtime 完成配对、两轮消息、刷新恢复、容器重启后从 `32804` 重新解析到 `32805` 并继续第三轮；page 有内容、无 error overlay，截图 `/tmp/family-ai-b1a-browser-after-restart.png` |
| 正式服务 / 真实 Provider | SKIP | 未获正式部署或真实 Provider 调用授权；只读证明旧正式 `8790` 未变化。H0 不满足，未调用真实 Hermes/Codex，也未修改或重启 Hermes |
| 文档与运维台账 | PASS | 新增边界设计与本记录，更新 Gateway README、执行包和总计划；已读 `agent-architecture.md`，但未部署正式架构，故不更新；没有端口或持久服务变化，故不更新 `service-ports.*` |

Provider SDK 测试数减少来自删除所有会执行旧 Hermes argv 成功/解析路径的测试，
并替换为三态零 spawn 状态矩阵；Gateway 增加 3 条回归。`git diff --check`
通过。两个隔离 Compose project 验收后已精确 `down`，runtime、报告和截图保留。

## 回滚与未覆盖项

回滚不得恢复 `-q <prompt>`，只能继续 `disabled`。本次没有验证真实 Hermes
stdin/FD one-shot、真实 Provider 计费调用或正式 `8790` 部署；这些属于 B1b/H0
和 F1 的独立授权范围。CI/PR 结果将在推送后补充，不能由本地门禁代替。
