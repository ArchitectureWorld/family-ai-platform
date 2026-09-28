# Family AI Gateway Foundation

`apps/gateway` 是 Family AI Platform 的唯一业务后端和数据权威。当前 `main` 源码包含 Browser Entry Session、移动/网页设备配对、Chat / Work、同步、附件、Member Web、development Preview Admin Web、显式启用的 production Admin Web，以及 Fake/Hermes/Codex Provider Adapter。源码存在、自动化通过、隔离 Preview 通过和正式 `8790` 已部署是四种不同事实；正式运行物仍是旧 Compose/V3/Fake-only 版本。

## 运行边界

- 默认进程监听：`127.0.0.1:8790`；
- Docker 容器内部监听 `0.0.0.0:8790`，但 Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库：`.runtime/data/gateway.sqlite`；
- 附件：`.runtime/data/attachments`，与数据库共享持久化 `data` 挂载；
- 开发 Token：`.runtime/config/device-token`；
- 数据库只保存 Token 的 SHA-256 Hash；
- 容器根文件系统保持只读，只有显式 runtime 数据目录和临时目录可写；
- 自动测试与 A2–A5 隔离验收只使用 Fake Provider；真实 Provider 调用未纳入自动化或本轮 Preview 证据。
- Hermes 私密输入默认并显式为 `disabled`：当前 Hermes CLI 只有不安全的
  `-q <prompt>` 单次调用，因此 Hermes Agent/Profile 仍保留在 catalog 中，
  但 health 为 offline、invoke 返回 `PROVIDER_UNAVAILABLE` 且不会 spawn。
  预留的 `query-stdin-v1` 在 B1b 合入前同样 fail-closed；Codex 继续只从
  stdin 接收 prompt。详见
  [`Provider 私密输入边界设计`](../../docs/superpowers/specs/2026-08-13-provider-private-input-boundary-design.md)。

## 分层

```text
Fastify Route
→ Entry Session / member + agent policy
→ Family / Chat Work / Sync / Attachment Service
→ Gateway Repository + Attachment Storage
→ gateway.sqlite + attachments/

ChatWork Provider Lane
→ Provider Router
→ Fake / Hermes / Codex Adapter
```

当前文件职责：

- `src/app.ts`：应用装配、路由注册和安全错误映射；
- `src/config.ts`：本机/容器配置、显式 Provider 环境 allowlist 与 runtime catalog；
- `src/database.ts`：V1–V9 migration、开发 bootstrap 和核心 Repository；
- `src/familyRoutes.ts`、`src/webEntry.ts`、`src/mobilePairing.ts`：家庭、Session 和设备配对边界；
- `src/chatWorkRoutes.ts`、`src/chatWorkProvider.ts`：Chat/Work 授权、消息与 Agent-scoped Provider Lane；
- `src/eventStream.ts`、`src/deviceSync.ts`：SSE、补拉和累计 ACK；
- `src/attachmentRoutes.ts`、`src/attachmentStorage.ts`：分块上传、授权下载与受控文件存储；
- `src/agentRoutes.ts`、`src/adminWorkspaceRoutes.ts`：成员 Agent 挂载与管理员独立工作区；
- `src/migrate.ts`：不启动 HTTP/Provider 的 migration-only 入口；
- `src/index.ts`：正式进程入口；
- `member-public/*`：同源 Member Web；`admin-public/*` 由 development Preview 或显式 production Admin Web 开关注册；`public/*` 是开发验收台。

## 数据模型

- Family / Person / Membership；
- Managed Device / Device Binding / Entry Binding / Entry Session；
- Agent / Provider Profile / Assignment；
- Chat Stream / Work / Thread / Thread Message / Provider Context 与 Turn；
- Domain Event / Outbox / Device Sync Cursor；
- Attachment Upload / Chunk / Blob / Message Attachment；
- 旧 Foundation conversation/message 表与版本化 `schema_migrations`。

## API

公开协议按职责分组：`/api/v1/web-entry/*`、`/api/v1/mobile/*`、`/api/v1/chat*`、`/api/v1/work-conversations*`、`/api/v1/attachments/*`、`/api/v1/events/*`、`/api/v1/sync/*`、`/api/v1/admin/*`，另保留 Foundation conversation API。除 `/health` 和静态入口外均先验证对应 audience 的 Entry Session/Device 权限；Cookie 写请求还要求同源元数据和 `X-Family-AI-Web-Request: 1`。Admin Session 不自动获得 Personal 正文权限。

## 管理员入口有效期

本分支候选的 `family_admin` 新会话使用现有 V15 Schema 的远未来兼容值，日常使用不因 30 天期限中断；个人入口期限保持原状。production Admin Web 的每次一次性短码激活都会创建独立的管理员浏览器会话，退出当前浏览器只撤销它自己。新激活码无时间期限，但使用一次、主动替换或十次错误尝试后失效。浏览器 Cookie 被清除时需重新激活；服务器仍会逐次校验 Session、Binding、Device、audience 与同源请求。

受保护 operator 根入口和旧已过期行不会被服务启动自动恢复。本机恢复命令与备份、失败处理见 [管理员入口重签与长期有效激活码](../../docs/operations/release-and-rollback.md#管理员入口重签与长期有效激活码)。本段描述候选源码行为，不能据此认定正式运行物已升级。

## 核心安全规则

1. conversation 同时绑定 member 和 Agent；
2. 会话读取、历史和发送都使用 `conversationRef + memberRef + agentRef`；
3. 固定路由要求来源是当前 device、目标是当前 Agent；
4. 授权先于幂等查询；
5. 幂等范围是 device + conversation + agent + key + canonical request hash；
6. 相同 Key 不同请求返回 `409 IDEMPOTENCY_CONFLICT`；
7. 同一会话的 Provider 调用在进程内串行；
8. Provider Session 绑定 conversation + agent + provider profile；
9. bootstrap 只插入缺失记录，不更新已有状态；
10. 错误响应不返回 SQL、堆栈、Token、路径或 Provider 内部信息。

Chat/Work 的 `threadRef + clientMessageId` 幂等返回还要求来源 device
完全一致；不同 active device 复用同一 key 时，无论 payload 是否相同都
返回同一个净化后的 `409 THREAD_MESSAGE_CONFLICT`，且不会读取已有
Provider 结果或再次调用 Provider。该限制不改变同一 Person 多设备的领域事件
可见性，Sync cursor/ACK 仍按 device 隔离。

## 本地验证

首次生成全新的锁文件：

```bash
npm install
npm run check
```

一键体验：

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
```

隔离验收（不接触正式 `127.0.0.1:8790`）必须消费 wrapper 的 image ID 与 manifest：

```bash
bash scripts/build-gateway-image.sh \
  --source-commit "$(git rev-parse HEAD)" \
  --expected-source-commit "$(git rev-parse HEAD)" \
  --output-dir <absolute-new-artifact-dir>

FAMILY_AI_RUNTIME_ROOT=<absolute-empty-dir> \
COMPOSE_PROJECT_NAME=<safe-unique> \
FAMILY_AI_HOST_PORT=0 \
FAMILY_AI_IMAGE_REF=<sha256:image-id> \
FAMILY_AI_IMAGE_MANIFEST=<absolute-new-artifact-dir>/gateway-image-manifest.json \
./scripts/dev-up.sh

FAMILY_AI_RUNTIME_ROOT=<same-dir> COMPOSE_PROJECT_NAME=<same> ./scripts/acceptance.sh
FAMILY_AI_RUNTIME_ROOT=<same-dir> COMPOSE_PROJECT_NAME=<same> ./scripts/acceptance-container-attachments.sh
```

隔离入口只消费 wrapper 生成的不可变 image ID 与三文件 artifact manifest，并以 `0600` runtime manifest 绑定 source commit、artifact hash、runtime、project、容器、网络和实际随机 loopback 端口；重启后会重新解析端口，任何 identity 不匹配都 fail-closed。`docker compose build` 的 `local-unverified` 镜像不得进入该路径。

停止与重置：

```bash
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

行为 PR 转为 Ready 前必须在 Linux/Docker 实机完成 npm、Docker、隔离脚本和真实浏览器验收。

## Migration-only 与 retained runtime

`node apps/gateway/dist/migrate.js --database <absolute-sqlite>` 是唯一 migration-only 进程入口：它只打开指定 SQLite、迁移到当前 head，并执行 `quick_check`/`foreign_key_check`；不会启动 HTTP、Provider、worker 或 release controller。生产候选只能由 `scripts/runtime-candidate-stage.sh` 在 `network=none`、worker-disabled 的 sealed definition 下调用该入口。

Gateway 不负责自行判断何时停止、交换或恢复正式 runtime。`scripts/runtime-backup-preflight.mjs`、phase-scoped stop evidence、sealed snapshot 和 `runtime-restore.sh` 由外层发布流程串联；`verify-foundation.sh` 仍是会重置仓库 `.runtime` 的 disposable 开发命令，不能用于 retained 数据。
