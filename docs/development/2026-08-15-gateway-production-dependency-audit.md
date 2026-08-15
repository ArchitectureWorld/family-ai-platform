# A3 Gateway 生产依赖安全升级开发记录

日期：2026-08-15

分支：`codex/gateway-production-dependency-audit`

基线：`main@8d3c02706a8615d8f927eff184cedb718c7ff306`（A2 / PR #32 已合入）

## 官方取证与 RED

执行时重新查询 npm registry、GitHub Advisory 和 Fastify 官方 release：

- Fastify stable 为 5.12.0，仍是 5.x；官方 release：<https://github.com/fastify/fastify/releases/tag/v5.12.0>。
- `GHSA-c96f-x56v-gq3h`：`find-my-way <=9.6.0` 为 High，首个修复版 9.7.0。
- `GHSA-7p8r-x3mc-p8w7`：`fast-uri` 3.x 首个修复版 3.1.5，4.x 首个修复版 4.1.2。
- baseline `npm audit --omit=dev --json` 为 2 High、0 Critical，报告位于 Git 忽略的 `.runtime/audit/`，是当前 owner 的 regular `0600` 文件。

升级前依赖树为 Fastify 5.10.0、find-my-way 9.6.0、fast-uri 3.1.4/4.1.1。

## 最小升级

- Gateway 的 Fastify 下限从 `^5.10.0` 提到 `^5.12.0`，未跨 major。
- 只刷新 lockfile 中已确认漏洞链的 find-my-way 与 fast-uri；没有把传递依赖新增为直接依赖，没有运行 `npm audit fix --force`，没有升级无关开发依赖。
- 最终生产树为 Fastify 5.12.0、find-my-way 9.8.0、fast-uri 3.1.5/4.1.2。

## Fastify shutdown 兼容性

完整回归稳定暴露 `eventStreamLive.test.ts` 的既有 shutdown 约束：活跃 SSE 存在时 `app.close()` 超过 2.5 秒。

Fastify 官方 PR #6889 修复了 5.10 的强制关闭回归：默认 `forceCloseConnections='idle'` 不再强杀 in-flight request。官方 5.12 文档同时明确：阻止 `server.close()` 完成的 SSE/WebSocket 必须在 `preClose` 主动终止；`onClose` 只在请求排空后运行。

- 官方修复：<https://github.com/fastify/fastify/pull/6889>
- 官方 Hooks 文档：<https://github.com/fastify/fastify/blob/v5.12.0/docs/Reference/Hooks.md#preclose>

根因是本仓库把 `eventStreamHub.close()` 放在 `onClose`，形成“等待 SSE 结束后才关闭 SSE”的等待环。最小修复把 SSE hub 关闭移到 `preClose`，数据库仍在安全的 `onClose` 关闭。原失败用例未放宽超时，修复后连续 3 次、每次 2/2 通过。

## 提交前证据

| 门禁 | 结果 |
|---|---|
| `npm ci` | 锁文件可复现 |
| production audit | 0 High、0 Critical；0600 报告 |
| 全依赖 audit | 1 High（开发链 nanoid）、1 Moderate（开发链 postcss），不在 production audit 范围 |
| 依赖树 | Fastify 5.12.0；find-my-way 9.8.0；fast-uri 3.1.5/4.1.2 |
| SSE shutdown 聚焦 | RED 可重复；修复后连续 3 次 2/2 通过 |
| `npm run check` | 94 文件、918 项通过；static/typecheck/build 通过 |

以上是提交前工作树证据。Docker build、A2 附件 smoke、隔离 dev-up/acceptance 和真实浏览器旅程必须在最终提交 SHA 上复验后，PR 才能转 Ready。

## 数据、端口和 Hermes 边界

- 没有 Schema、runtime、正式服务或持久端口变化，不更新 `/home/youran/data/service-ports.{md,json}`。
- 没有 Hermes Provider 架构、Profile 或真实调用变化，不更新 `/home/youran/data/agent-architecture.md`。
- 正式 `127.0.0.1:8790` 不部署、不重启；所有运行门禁继续使用 A2 的独立 runtime、唯一 project、随机 loopback 端口和不可变 image ID。

## 回滚

同时恢复 `apps/gateway/package.json`、`package-lock.json` 与 `apps/gateway/src/app.ts` 到 A3 前版本；不得只回滚 manifest 或 lockfile 其中之一。回滚会重新引入已确认的 production High，不能作为发布候选。

## 未覆盖项

- A4 的 CI audit/构建/容器发布阻断门禁；
- A5 的数据库、附件、镜像与配置整体备份恢复；
- A6 的全仓文档事实校正；
- 开发依赖 nanoid/postcss 漏洞的独立治理。
