# Gateway Chat / Work HTTP Routes 设计

- 日期：2026-07-23
- 状态：已批准
- 目标分支：`feat/gateway-chat-work-http-routes`
- 基线：`main` at `12452bd59973884ddbe4b933fd6a45cbfbf5a53d`
- 权威依据：
  - `docs/architecture/02-chat-work-domain.md`
  - `docs/architecture/03-single-gateway-concurrency.md`
  - `docs/architecture/04-multi-terminal-strategy.md`
  - `packages/contracts/src/chatWork.ts`
  - 已合并 PR #16 的 `ChatWorkDomainRepository`

## 1. 目标

在不接入 Provider、不增加 SSE、不开发 Web 或 iOS UI 的前提下，把已经落地的 Chat / Work Contracts v1 与 Gateway SQLite 领域仓储连接成第一套正式 HTTP API。

本阶段完成后，受认证的个人入口可以：

```text
取得唯一 Home Chat
列出和创建 Work
读取 Thread 消息
持久化 Person 文本消息
把 Chat 引用转换成 Work
读取 Work 最新进度快照
```

所有 Person、Device、Agent 与消息来源均由 Gateway 的 Entry Session 上下文解析，客户端不能通过 body 或 URL 声明可信身份。

## 2. 方案比较

### 方案 A：路由层最小垂直切片（采用）

```text
Contracts
→ Entry Session Authentication
→ ChatWorkRoutes
→ ChatWorkDomainRepository
→ SQLite
```

优点：

- 直接验证已经合并的协议与领域仓储；
- 只新增一层 HTTP 映射；
- 不引入 Provider、异步队列、Web 或移动端耦合；
- PR 文件边界小，最不容易影响 PR #14。

限制：

- POST Message 只完成消息持久化，不产生 Assistant 回复；
- 实时事件、Operation 状态和 Provider 连续性仍不可用。

### 方案 B：HTTP 路由与 Provider 回复同时实现（不采用）

优点是能一次形成完整 Chat 回复体验；缺点是会同时修改路由、Provider Session、执行 Lane、消息事务和错误状态，审查面过大，也会阻碍后续 SSE 设计。

### 方案 C：先做 Member Web 并使用临时 Mock API（不采用）

优点是较快看到页面；缺点是 Web 会先定义一套临时语义，之后再回头对齐 Gateway，容易形成重复模型和不可追溯的兼容负担。

## 3. 与 PR #14 的隔离边界

PR #14 当前只修改：

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

本 PR 只允许修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/chatWorkRoutes.ts
apps/gateway/test/chatWorkRoutes.test.ts
apps/gateway/test/chatWorkRoutesSecurity.test.ts
docs/superpowers/specs/2026-07-23-gateway-chat-work-http-routes-design.md
docs/superpowers/plans/2026-07-23-gateway-chat-work-http-routes.md
```

明确不修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
apps/gateway/src/database.ts
apps/gateway/src/chatWorkDomain.ts
apps/gateway/src/entrySessionAuth.ts
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/public/**
```

本分支直接从 PR #16 合并后的 `main` 创建，不叠加在 PR #14 分支上。

## 4. HTTP API

### 4.1 Home Chat

```http
GET /api/v1/chat?timezone=America%2FLos_Angeles
```

行为：

1. 使用 Entry Session 认证，要求 `audience = personal`；
2. 如果当前 Person 已有活动 Home Chat，直接返回；
3. 如果尚无 Home Chat，要求合法 IANA 时区；
4. Gateway 根据服务端当前时间和该时区计算 `localDate`；
5. 调用 `ensureHomeChat` 创建 HomeChatStream 与初始 DailyEpisode；
6. 使用 `homeChatStreamResponseSchema` 校验响应。

时区规则：

- `timezone` 只在首次创建 Home Chat 时必需；
- 已存在 Home Chat 时可以省略；
- 提供了时区时仍必须合法，不能静默忽略错误值；
- Gateway 不信任客户端提交的 `localDate`，由服务端根据时区计算；
- 时区变化和 DailyEpisode 切换属于后续归档阶段，本 PR 不修改已经创建的 Episode。

### 4.2 Work 列表

```http
GET /api/v1/work-conversations
```

返回：

```text
workConversationListResponseSchema
```

只返回当前 Entry Session 解析出的 Person 所拥有的 Work。

### 4.3 创建 Work

```http
POST /api/v1/work-conversations
Content-Type: application/json
```

请求：

```text
createWorkConversationRequestSchema
```

成功：`201 Created`

响应：

```text
createWorkConversationResponseSchema
```

请求 body 只能包含：

```text
protocolVersion
title
goal
```

### 4.4 Thread 消息分页

```http
GET /api/v1/threads/:threadRef/messages?beforeSequence=100&limit=50
```

规则：

- `threadRef` 必须符合 `interactionThreadRefSchema`；
- `beforeSequence` 为可选正整数；
- `limit` 为 1–200，默认 50；
- 未知 query 字段被拒绝；
- Repository 负责 Person 所有权检查；
- 返回消息按 `threadSequence` 升序；
- 使用 `threadMessageListResponseSchema` 校验响应。

### 4.5 持久化 Person 文本消息

```http
POST /api/v1/threads/:threadRef/messages
Content-Type: application/json
```

请求：

```text
sendThreadMessageRequestSchema
```

成功：`201 Created`

Gateway 构造持久化事实：

```text
actor.type        = person
actor.personRef   = authenticated context.person.personRef
origin.deviceRef  = authenticated context.device.deviceRef
origin.connectionRef = null
origin.entryAudience = personal
```

本阶段没有 Connection Registry，因此客户端不能通过 header 或 body 提交 `connectionRef`。后续 SSE / Connection 层建立后，再由受信任的服务端连接上下文注入。

POST 只持久化用户消息，不调用 Provider，也不伪造 Assistant 回复。

相同 `clientMessageId` 与相同逻辑内容重试时返回第一次持久化的消息，HTTP 状态继续使用 `201`，响应 body 保持严格 Contracts v1 结构，不添加 `replayed` 私有字段。

### 4.6 Chat 转 Work

```http
POST /api/v1/chat/work-conversions
Content-Type: application/json
```

请求：

```text
createWorkFromChatRequestSchema
```

成功：`201 Created`

响应：

```text
createWorkFromChatResponseSchema
```

Repository 继续负责：

- Home Chat 所有权；
- DailyEpisode 引用一致性；
- 所有来源消息属于同一个 Home Chat；
- 转换过程原子提交；
- 不复制完整 Chat 消息正文。

### 4.7 Work 进度读取

```http
GET /api/v1/work-conversations/:workConversationRef/progress
```

规则：

- `workConversationRef` 必须符合 `workConversationRefSchema`；
- 只读取当前 Person 的 Work；
- 存在快照时返回 `workProgressSnapshotResponseSchema`；
- 尚无快照或 Work 不属于当前 Person 时统一返回 `404 WORK_PROGRESS_NOT_FOUND`，避免泄露其他 Person 的 Work 是否存在。

本 PR 不增加公开的进度写入路由。进度快照由后续可信执行组件写入。

## 5. 认证和授权

所有新路由均调用：

```ts
requireEntryRequest(request, entryAuthenticator, "personal")
```

因此：

- 缺少或错误的 Entry Session 返回 `401 ENTRY_SESSION_INVALID`；
- 过期 Session 返回 `401 ENTRY_SESSION_EXPIRED`；
- 被撤销设备返回 `403 DEVICE_REVOKED`；
- `family_admin` Session 返回 `403 ENTRY_AUDIENCE_FORBIDDEN`；
- Device Credential 不能替代 Entry Session；
- Person、Family、Device 和 AssistantAssignment 不从请求 body 获取。

## 6. 请求与响应校验

路由直接使用已合并的 `@family-ai/contracts`：

```text
CHAT_WORK_PROTOCOL_VERSION
homeChatStreamResponseSchema
workConversationListResponseSchema
createWorkConversationRequestSchema
createWorkConversationResponseSchema
interactionThreadRefSchema
threadMessageListResponseSchema
sendThreadMessageRequestSchema
sendThreadMessageResponseSchema
createWorkFromChatRequestSchema
createWorkFromChatResponseSchema
workConversationRefSchema
workProgressSnapshotResponseSchema
```

原则：

- body 使用 `.safeParse()`；
- path 和 query 使用路由本地严格 Zod schema；
- 服务端响应在发送前使用 Contracts schema `.parse()`；
- 未知字段、错误版本和可信身份字段被拒绝；
- 消息原始文本不被路由层 trim 或改写。

## 7. 错误协议

Chat / Work 路由使用现有通用 `PublicError`：

```json
{
  "code": "REQUEST_INVALID",
  "category": "validation",
  "message": "请求内容不正确。",
  "retryable": false
}
```

本 PR 不修改 `mobileErrorRoute()`，也不把 Chat / Work 错误伪装成 Mobile Pairing 错误。未来 iOS Chat / Work 接入时，移动端应同时支持 Mobile Entry 错误 envelope 与通用 Chat / Work `PublicError`。

路由层新增的错误：

```text
REQUEST_INVALID
WORK_PROGRESS_NOT_FOUND
```

Repository 已有错误保持不变：

```text
PERSON_NOT_FOUND
THREAD_NOT_FOUND
WORK_NOT_FOUND
CHAT_SOURCE_INVALID
THREAD_MESSAGE_INVALID
THREAD_MESSAGE_CONFLICT
```

## 8. 组件结构

### `apps/gateway/src/chatWorkRoutes.ts`

职责：

- 认证个人 Entry Session；
- 解析 body、path、query；
- 计算首次 Home Chat 的本地日期；
- 从认证上下文构造 Person actor 与 Device origin；
- 调用 `ChatWorkDomainRepository`；
- 使用 Contracts schema 校验响应。

该文件不直接执行 SQL，不调用 Provider，不处理 SSE。

### `apps/gateway/src/app.ts`

只做组合根变更：

```text
创建 ChatWorkDomainRepository
注册 registerChatWorkRoutes
```

新增可选测试时钟：

```ts
now?: () => Date
```

缺省时仍使用真实系统时间。该时钟传给 EntrySessionAuthenticator、ChatWorkDomainRepository 和 ChatWorkRoutes，以保证认证、持久化时间与本地日期测试一致。

## 9. 数据流

### 读取 Chat

```text
HTTP GET
→ Entry Session Auth
→ resolve Person / Device
→ getHomeChat
→ missing: validate timezone + derive localDate
→ ensureHomeChat
→ Contracts response validation
→ HTTP 200
```

### 发送消息

```text
HTTP POST
→ Entry Session Auth
→ strict request schema
→ resolve Person actor + Device origin
→ appendThreadMessage transaction
→ Contracts response validation
→ HTTP 201
```

### Chat 转 Work

```text
HTTP POST
→ Entry Session Auth
→ strict conversion schema
→ validate all source refs
→ atomic Work + conversion + ordered refs
→ Contracts response validation
→ HTTP 201
```

## 10. 测试设计

### `chatWorkRoutes.test.ts`

覆盖：

1. 有效 personal Entry Session 首次取得 Home Chat；
2. IANA 时区和跨 UTC 日期边界的 localDate 计算；
3. 重复 GET 返回同一个 Home Chat；
4. Work 创建与列表；
5. Person 消息写入和原始文本保持；
6. 消息逻辑重放与冲突；
7. 分页顺序和 cursor；
8. Chat 转 Work；
9. 通过 Repository 写入进度后由 HTTP 读取；
10. SQLite 重启后 HTTP 仍可读取已有数据。

### `chatWorkRoutesSecurity.test.ts`

覆盖：

1. 缺少 Entry Session；
2. 错误和过期 Entry Session；
3. 被撤销设备；
4. family_admin audience；
5. body 伪造 `personRef`、`agentRef`、`deviceRef`、`origin`、`actor`；
6. 错误协议版本和未知字段；
7. 非法 Thread / Work ref；
8. 跨 Person Thread、Work 和进度访问；
9. 客户端不能提交 `connectionRef`；
10. 错误使用通用 PublicError，且不泄露 Token、Credential 或内部 SQL。

所有测试使用真实临时 SQLite，不 Mock Repository。

## 11. 验收命令

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

最终还必须：

- 检查 CI 与 Secret Scan；
- 列出 PR 全部变更路径；
- 与开放 PR #14 的路径做集合比较；
- 确认 PR #14 保持 Open、Draft、head 不变且 GitHub 仍报告 mergeable；
- 未获得上述证据前不合并。

## 12. 后续顺序

本 PR 合并后再依次推进：

```text
Provider Context Session 与 Assistant 回复
→ Outbox / SSE / Sync Cursor
→ Member Web Chat / Work
→ iOS Chat / Work 接入
```

每一阶段继续使用独立 PR，不把 Web、iOS、Provider 和同步系统混入本路由 PR。