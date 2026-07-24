# Gateway Chat / Work SSE 实时事件流设计

- 日期：2026-07-24
- 状态：已实现
- 目标分支：`feat/gateway-chat-work-sse`
- 基线：`main` @ `4bba487ce675f3b338c343185514915a25a6bb2d`
- 前置：PR #15、#16、#17、#18、#19 已合并

## 1. 目标

为正式 Chat / Work 领域提供基于 Server-Sent Events 的实时事件订阅，使浏览器和后续终端能够：

```text
建立 Personal Entry 长连接
→ 从指定 Person Event Sequence 补发历史事件
→ 按 Person 严格升序接收后续事件
→ 通过 Last-Event-ID 恢复连接
→ 通过心跳保持连接并重新校验入口授权
```

SSE 的权威数据源是 PR #19 已建立的 `domain_events`。本阶段不把内存广播视为权威，也不将某个 SSE 客户端收到事件等同于 Outbox 已完成全局投递。

## 2. 与 PR #14 的隔离边界

本 PR 从合并 PR #19 后的最新 `main` 独立创建，不叠加在 iOS 分支上。

允许修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/eventStream.ts
apps/gateway/test/eventStream.test.ts
apps/gateway/test/eventStreamRoutes.test.ts
apps/gateway/test/eventStreamLive.test.ts
apps/gateway/test/eventStreamResilience.test.ts
apps/gateway/test/eventStreamPersonIsolation.test.ts
docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md
docs/superpowers/plans/2026-07-24-gateway-chat-work-sse.md
docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md
```

明确不修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
apps/gateway/public/**
```

PR #14 继续保持独立 Draft，只进行真机验收。

## 3. 范围

### 3.1 包含

- 一个正式 Personal Entry SSE 路由；
- `afterSequence` 和 `Last-Event-ID` 恢复；
- 首次历史补发；
- 新领域事件的实时推送；
- Person 级共享轮询 Hub；
- 严格升序和单连接去重；
- 心跳；
- 长连接授权复核；
- 慢连接背压隔离；
- 客户端断开和 Gateway 关闭清理；
- Chat、Work、Person 消息、Assistant 消息与 Provider 状态的端到端测试。

### 3.2 不包含

- 持久化 Device Sync Cursor；
- Push Notification；
- Outbox 外部发布 Worker；
- 将 Outbox 标记为 `published`；
- 公共 `packages/contracts` Event Schema；
- HTTP 202、Operation 或后台 Provider Turn；
- 正式 Member Web；
- iOS Chat / Work 接入；
- 浏览器一键验收台修改；
- 多 Gateway 实例间的实时协调。

## 4. 方案选择

### 4.1 方案 A：共享 Person Event Hub（采用）

一个 Gateway 进程维护一个 `PersonEventStreamHub`。Hub 只为当前存在订阅的 Person 查询 `domain_events`，并把结果分发给该 Person 的多个连接。

优点：

- SQLite 事件日志仍是权威来源；
- 一个 Person 多连接时，稳定阶段每轮只进行一组 Person 查询；
- Gateway 重启后可以从客户端 Cursor 恢复；
- 不需要修改现有 Chat / Work Repository；
- 容易扩展到后续 Device Sync Cursor。

### 4.2 方案 B：每条连接独立轮询数据库（不采用）

实现最简单，但每增加一个页面、标签页或设备，就增加独立轮询器和重复查询。多端同时在线时成本线性增长。

### 4.3 方案 C：纯内存发布订阅（不采用）

延迟最低，但进程重启、暂时断线或未来多实例部署时可能漏事件，无法兑现 PR #19 建立持久化事件源的目的。

## 5. HTTP 接口

```http
GET /api/v1/events/stream?afterSequence=123
```

认证沿用 Personal Entry Session：

```http
Authorization: Bearer <entry-session-token>
X-Entry-Session-Ref: entry-session:...
```

只允许 `personal` audience。家庭管理入口不能订阅个人 Chat / Work 事件。

### 5.1 Cursor 输入

支持两种输入：

```http
GET /api/v1/events/stream?afterSequence=123
Last-Event-ID: 123
```

规则：

- 两者都缺失时从 `0` 开始；
- `afterSequence` 必须是大于等于 `0` 的安全整数；
- `Last-Event-ID` 必须是纯十进制、可安全表示且大于等于 `0`；
- 两者同时存在时必须完全相等；
- 不一致或格式错误返回 `REQUEST_INVALID`，HTTP 400；
- 未知查询参数返回 HTTP 400；
- Cursor 是排他的，服务端只发送 `eventSequence > cursor` 的事件。

### 5.2 SSE 响应头

连接成功后返回：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

服务端在进入流模式前完成认证和 Cursor 校验。认证失败仍使用现有 Chat / Work `PublicError` HTTP 响应，不先发送 SSE 头。

## 6. SSE 帧

### 6.1 连接建立

```text
retry: 3000
: connected

```

`retry` 建议客户端断线后三秒重连。连接注释不携带 `id`，不会推进 Cursor。

### 6.2 领域事件

```text
id: 124
event: domain-event
data: {"eventRef":"event:...","personRef":"person:...","eventSequence":124,"eventType":"thread.message.created","aggregateType":"thread_message","aggregateRef":"message:...","threadRef":"thread:...","payload":{},"occurredAt":"...","createdAt":"..."}

```

规则：

- `id` 等于十进制 `eventSequence`；
- `event` 固定为 `domain-event`；
- `data` 是单行 JSON；
- JSON 内容使用当前持久化 `DomainEvent` 结构；
- 不在 SSE 层增加消息正文、Assistant 输出、Token、Credential 或 External Session；
- 当前 Event Payload 内 SQLite JSON 的 `0/1` 表示保持原样，跨终端公共 Event Contract 留给后续独立 PR 标准化。

### 6.3 心跳

```text
: heartbeat 2026-07-24T12:00:00.000Z

```

心跳是 SSE 注释帧，不含 `id` 和 `data`，不会推进客户端 Cursor。

## 7. `PersonEventStreamHub`

新文件：`apps/gateway/src/eventStream.ts`。

核心职责：

```text
register(connection)
unregister(connection)
pumpPerson(personRef)
heartbeatAll()
close()
```

Hub 依赖：

- `DomainEventStore`：按 Person 和 Cursor 读取持久化事件；
- `EntrySessionAuthenticator`：定期复核连接凭据；
- 时钟；
- 定时器配置。

Hub 不创建领域事件、不修改 Outbox、不处理 Chat / Work 命令。

## 8. 共享查询与无缝补发

### 8.1 稳定阶段

Hub 维护：

```text
Map<PersonRef, PersonChannel>
PersonChannel
  └── Set<Subscriber>
```

每 `500 ms`：

1. 获取当前有订阅者的 Person；
2. 为每个 Person 启动或合并到一个串行 `pumpPerson()`；
3. 取该 Person 所有订阅者的最小 `scheduledCursor`；
4. 从 `DomainEventStore.listPersonEvents()` 分页读取；
5. 对每个事件，只加入 `scheduledCursor < eventSequence` 的订阅者写队列；
6. 更新订阅者的内存 `scheduledCursor`；
7. 直到当前没有更多事件。

因此一个 Person 的稳态查询由 Hub 共享，不按连接重复轮询。

### 8.2 新连接加入时的竞态

注册顺序：

```text
认证
→ 建立 Subscriber(cursor)
→ 加入 PersonChannel
→ 调度 pumpPerson(personRef)
→ 写 connected 帧
```

`pumpPerson()` 对同一 Person 串行。新连接在既有 Pump 执行期间加入时，会在当前 Pump 之后自动再运行一次，重新根据所有订阅者的最小 Cursor 查询。

由此避免以下窗口：

```text
先查历史
→ 此时产生新事件
→ 再注册实时订阅
→ 漏掉窗口内事件
```

事件只从持久化日志查询，允许安全重复查询；每条连接通过 `scheduledCursor` 防止单次连接内重复排队。

### 8.3 交付语义

SSE 提供至少一次恢复语义：

- 服务端可能已经写入 Socket，但客户端在处理前断线；
- 客户端只应在成功处理事件后更新自己的 Cursor；
- 重连时同一事件可能再次出现；
- 客户端必须按 `eventSequence` 幂等处理；
- 服务端保证同一连接内事件顺序严格递增。

## 9. 背压和慢连接隔离

每个 Subscriber 拥有独立串行 FIFO 写队列，不允许一个慢客户端阻塞其他 Person 或其他连接。

规则：

- `response.write()` 返回 `false` 时等待 `drain`；
- 写操作始终在该 Subscriber 自己的写循环中串行；
- `scheduledCursor` 在事件进入队列时推进，防止下一轮 Pump 重复排队；
- 若待写队列超过 `256` 帧或估算超过 `1 MiB`，关闭该连接；
- 队列计数只包含真实尚未完成的帧；
- 写失败、Socket 错误或客户端断开都会注销 Subscriber；
- 连接关闭后客户端使用最后成功处理的 `Last-Event-ID` 重连并补拉。

队列上限是进程保护边界，不代表事件丢失，因为事件仍保存在 `domain_events`。

## 10. 心跳与授权复核

全局心跳间隔：`15 s`。

每次心跳前，Hub 使用连接建立时保存的：

```text
entrySessionRef
token
expectedAudience = personal
```

重新调用 `EntrySessionAuthenticator.authenticate()`。

结果：

- `authenticated` 且 audience 仍为 personal：发送心跳；
- Session 过期：关闭连接；
- Device 被撤销：关闭连接；
- EntryBinding / Session 无效：关闭连接；
- audience 不再符合：关闭连接；
- 单 Subscriber 授权复核抛出异常：只关闭该连接，其他连接继续本轮心跳。

流已经建立后不再发送新的 HTTP 错误 Envelope。客户端下一次重连会收到现有明确的 401 或 403 `PublicError`。

凭据只保留在当前进程 Subscriber 内存中：

- 不写入日志；
- 不进入事件；
- 不进入 Outbox；
- 不进入错误正文；
- Subscriber 注销时释放引用。

## 11. Fastify 集成

`registerEventStreamRoutes()` 注册：

```http
GET /api/v1/events/stream
```

路由流程：

1. 使用现有 `requireEntryRequest(..., "personal")` 做初始认证；
2. 严格解析 Cursor；
3. 设置 SSE 响应头；
4. `reply.hijack()`；
5. 将原始响应交给 Hub 注册；
6. 监听 `request.raw.aborted`、response `close` 和 response `error`；
7. 任何一个信号只执行一次清理。

没有监听普通 `request.raw.close`，因为 Node 的 IncomingMessage `close` 也可能表示请求读取完成，不能据此提前关闭仍在工作的 SSE 响应。

`buildGatewayApp()`：

```text
open database
→ create DomainEventStore
→ create PersonEventStreamHub
→ register existing routes
→ register SSE route
```

Gateway 关闭时：

```text
await eventStreamHub.close()
→ db.close()
```

Hub 先停止轮询和心跳，再关闭所有连接，最后数据库关闭，避免定时器访问已关闭的 SQLite。

## 12. Outbox 边界

SSE 直接读取 `domain_events`，不 claim `outbox_events`，也不调用 `markPublished()`。

原因：

- 一个事件可能需要投递给多个浏览器、多个移动端、Push Worker 和未来服务；
- 一个 SSE 连接收到事件不代表其他目标已经收到；
- Outbox 的 `published` 应表示未来外部发布器完成其明确职责，而不是任意客户端消费成功；
- SSE 断线恢复由 `domain_events + cursor` 解决。

## 13. 错误处理

连接建立前：

| 情况 | HTTP | 错误 |
|---|---:|---|
| 缺失或无效 Entry Session | 401 | `ENTRY_SESSION_INVALID` |
| Entry Session 过期 | 401 | `ENTRY_SESSION_EXPIRED` |
| Device 撤销 | 403 | `DEVICE_REVOKED` |
| 非 personal audience | 403 | `ENTRY_AUDIENCE_FORBIDDEN` |
| Cursor 格式错误或冲突 | 400 | `REQUEST_INVALID` |

连接建立后：

- 授权失效：关闭连接；
- 数据库读取失败：仅该 Person Pump 失败，其他 Person 继续；后续轮询重新尝试；
- 单 Subscriber 写失败：只关闭该连接；
- 单 Subscriber 授权异常：只关闭该连接；
- Gateway 关闭：停止接受新 Subscriber，关闭现有连接。

## 14. 测试策略

### 14.1 Hub 单元测试

覆盖：

1. 多事件严格升序；
2. exclusive cursor；
3. 同 Person 多连接共享 Pump；
4. 不同 Person 隔离；
5. 相同事件不在单连接内重复排队；
6. 跨页补发；
7. 不同 Person Pump 故障隔离；
8. 背压等待 `drain`；
9. 队列超限只关闭慢连接；
10. 心跳不推进 Cursor；
11. Session 失效后关闭；
12. 心跳授权异常隔离；
13. `close()` 清理计时器和 Subscriber。

### 14.2 路由集成测试

使用真实 Fastify 监听随机本地端口和流式客户端，覆盖：

1. 缺少认证返回 401，且未升级为 SSE；
2. family_admin 返回 403；
3. Device Credential 不能替代 Personal Entry；
4. 正确 SSE 响应头；
5. `afterSequence` 历史补发；
6. `Last-Event-ID` 补发；
7. 两种 Cursor 冲突返回 400；
8. 未知查询参数返回 400；
9. 新 Person 消息和 Assistant 消息实时到达；
10. Provider 成功事件实时到达；
11. 事件 `id` 与 `eventSequence` 相同；
12. 心跳没有 `id`；
13. 两个 Person 的并行事件流完全隔离；
14. SSE 消费不完成 Outbox；
15. Gateway 关闭不会留下悬挂长连接或计时器。

### 14.3 回归与隔离

必须通过：

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

并复核：

- PR #14 Head 不变；
- PR #14 仍为 Open / Draft；
- 两个 PR changed-path 交集为零；
- 现有 Mobile Entry、Chat / Work、Provider 和 Outbox 测试不回归。

## 15. 成功标准

本阶段完成时必须满足：

```text
已认证 Personal Entry 可以从任意有效 Cursor 连接
历史事件按 Person Event Sequence 升序补发
连接存续期间新事件在轮询窗口内实时到达
断开后可用 Last-Event-ID 无缺口恢复
心跳保持连接但不改变 Cursor
授权失效会终止现有连接
慢连接不阻塞其他连接
单 Person 或单 Subscriber 故障不影响健康连接
SSE 不泄露消息正文或凭据
SSE 不错误完成 Outbox
PR #14 文件边界保持完全隔离
```

## 16. 后续顺序

本 PR 合并后：

```text
Device Sync Cursor 与显式补拉 API
→ 正式 Member Web Chat / Work
→ Push 唤醒
→ iOS Chat / Work 接入
```

在 PR #14 真机验收完成前，后续 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
