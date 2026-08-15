# A2 Compose 附件持久化开发记录

日期：2026-08-15

分支：`codex/compose-attachment-persistence`

基线：`main@5d38293b77936964953619b68b6a31f67a068a87`（A1D / PR #31 已合入）

## 问题与 RED

默认 Compose 把 `.runtime/data` 挂到容器 `/app/.runtime/data`，但没有显式把附件根放进该持久化边界；一键脚本也不能在正式 `127.0.0.1:8790` 已运行时安全执行完整验收。

先扩展 `memberWebOneClick.test.ts` 和 `static-check.sh`，覆盖附件根、`0700` 权限、只读根、随机端口、完整隔离 Compose 和 fail-closed manifest。测试先因缺少实现失败，再做最小修复。

## 实现

- Compose 显式设置 `FAMILY_AI_ATTACHMENT_ROOT=/app/.runtime/data/attachments`，复用现有持久化 data mount，不新增卷、不关闭 `read_only`、不扩大默认端口。
- `dev-up.sh` 创建 `0700` 的 runtime/data/attachments。
- 隔离模式只接受绝对、非符号链接、未存在或空的 `0700` runtime，以及安全唯一 project、`FAMILY_AI_HOST_PORT=0` 和不可变 image ID。
- 隔离模式生成完整 Compose，强制 `--no-build`，只发布随机 `127.0.0.1` 端口，并在 `0600` manifest 中绑定 runtime device/inode、project、容器、网络、image ID、实际端口和正式 8790 identity。
- `acceptance.sh` 和附件验收只消费同一 manifest；容器重启后重新解析随机端口，任何 identity 漂移均 fail-closed。
- Dockerfile 补齐构建与静态门禁实际需要的仓库文档输入。

## 提交前证据

| 门禁 | 结果 |
|---|---|
| 聚焦测试 | 1 文件、25 项通过 |
| `npm ci` | 成功；审计仍有 1 Moderate、3 High，交由 A3 处理 |
| `npm run check` | 94 文件、918 项通过；static/typecheck/build 通过 |
| Docker build | 94 文件、917 项通过、1 项跳过；镜像构建成功；production audit 仍有 2 High，交由 A3 处理 |
| 隔离 dev-up + acceptance | 健康、认证、会话、两轮消息、历史、幂等、重启和第三轮全部通过 |
| 附件容器验收 | 两分片上传、下载、容器重启、SHA-256 与权限全部通过 |
| 真实浏览器 | pairing 后两轮消息、刷新恢复、容器重启换随机端口、历史恢复、第三轮消息通过；390×844 无横向溢出；无 page error/console error |
| 正式 8790 | 前后 identity 不变；未修改或重启正式服务 |
| 真实 Provider | SKIP；A2 只使用 Fake Provider，不授权真实计费调用 |

以上是提交前工作树证据。PR Ready 前必须在最终提交 SHA 上重建镜像并复跑适用门禁，不能把这组 image ID 当成最终发布 provenance。

## 数据、端口和 Hermes 边界

- 默认端口仍为 `127.0.0.1:8790`，没有持久服务或端口设置变化，因此不更新 `/home/youran/data/service-ports.{md,json}`。
- 本任务不改变 Hermes 架构、Provider Profile 或正式 Provider，因此只核对既有 `/home/youran/data/agent-architecture.md`，不更新它。
- `dev-down.sh` 保留 `.runtime/data`；`dev-reset.sh` 删除整个 `.runtime`，会同时删除 SQLite、附件和本机开发凭证。

## 回滚

停止并删除本任务创建且由 manifest 精确绑定的隔离 Compose project，恢复旧 Compose/env；正式 8790 不需要切换。默认 runtime 回滚时保留 `.runtime/data/attachments`，不得自动删除用户附件。

## 未覆盖项

- A3 的依赖漏洞清零；
- A4 的 CI 与不可变构建入口；
- A5 的数据库、附件、镜像和配置整体备份恢复；
- A6 的全仓文档事实校正。
