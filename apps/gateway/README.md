# Family AI Gateway Foundation

`apps/gateway` 是 Family AI Platform 的唯一业务后端和数据权威。当前 Foundation 仅实现本机开发闭环，使用 Fake Provider，不包含正式 Member/Admin Web、浏览器正式 Session、配对、附件或真实 Hermes/Codex。

## 运行边界

- 默认进程监听：`127.0.0.1:8790`；
- Docker 容器内部监听 `0.0.0.0:8790`，但 Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库：`.runtime/data/gateway.sqlite`；
- 开发 Token：`.runtime/config/device-token`；
- 数据库只保存 Token 的 SHA-256 Hash；
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

停止与重置：

```bash
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

Foundation PR 必须保持 Draft，直到 Linux/Docker 实机完成 npm、Docker、脚本和浏览器验收。
