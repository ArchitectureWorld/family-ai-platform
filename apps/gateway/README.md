# Family AI Gateway Foundation

`apps/gateway` 是 Family AI Platform 的唯一业务后端和数据权威。当前本机产品闭环已经包含浏览器 Entry Session、设备配对、Chat / Work 与附件；自动验收仍使用 Fake Provider，正式 Provider、正式部署和正式 Member/Admin Web 继续受发布 Gate 约束。

## 运行边界

- 默认进程监听：`127.0.0.1:8790`；
- Docker 容器内部监听 `0.0.0.0:8790`，但 Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库：`.runtime/data/gateway.sqlite`；
- 附件：`.runtime/data/attachments`，与数据库共享持久化 `data` 挂载；
- 开发 Token：`.runtime/config/device-token`；
- 数据库只保存 Token 的 SHA-256 Hash；
- 容器根文件系统保持只读，只有显式 runtime 数据目录和临时目录可写；
- 自动测试和体验只使用 Fake Provider。

## 分层

```text
Fastify Route
→ Message / Conversation Service
→ member + agent policy
→ GatewayRepository
→ gateway.sqlite

MessageService
→ ProviderAdapter
→ FakeProviderAdapter
```

当前文件职责：

- `src/app.ts`：应用装配、公开路由和安全错误映射；
- `src/config.ts`：本机/容器配置校验；
- `src/database.ts`：初始 migration、开发 bootstrap 和 Repository；
- `src/service.ts`：会话授权、规范化幂等、串行发送和 Provider 调用；
- `src/developmentConsole.ts`：仅 development 模式提供验收台；
- `src/index.ts`：进程入口；
- `public/*`：开发验收页面，不是正式 Member Web。

## 数据模型

- `members`
- `devices`
- `agents`
- `provider_profiles`
- `member_agent_bindings`
- `conversations`
- `messages`
- `provider_sessions`
- `idempotency_records`
- `schema_migrations`

## API

```text
GET  /health
GET  /api/v1/me
POST /api/v1/conversations
GET  /api/v1/conversations
GET  /api/v1/conversations/:conversationRef/messages
POST /api/v1/conversations/:conversationRef/messages
```

除 `/health` 和 development 验收静态资源外，API 需要：

```http
Authorization: Bearer <development-token>
X-Device-Ref: device:test
```

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

隔离验收（不接触正式 `127.0.0.1:8790`）：

```bash
FAMILY_AI_RUNTIME_ROOT=<absolute-empty-dir> \
COMPOSE_PROJECT_NAME=<safe-unique> \
FAMILY_AI_HOST_PORT=0 \
FAMILY_AI_IMAGE_REF=<sha256:image-id> \
./scripts/dev-up.sh

FAMILY_AI_RUNTIME_ROOT=<same-dir> COMPOSE_PROJECT_NAME=<same> ./scripts/acceptance.sh
FAMILY_AI_RUNTIME_ROOT=<same-dir> COMPOSE_PROJECT_NAME=<same> ./scripts/acceptance-container-attachments.sh
```

隔离入口只消费调用方已构建的不可变 image ID，并以 `0600` manifest 绑定 runtime、project、容器、网络和实际随机 loopback 端口；重启后会重新解析端口，任何 identity 不匹配都 fail-closed。

停止与重置：

```bash
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

行为 PR 转为 Ready 前必须在 Linux/Docker 实机完成 npm、Docker、隔离脚本和真实浏览器验收。
