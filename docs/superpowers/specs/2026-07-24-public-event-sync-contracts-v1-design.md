# Public Event / Sync Contracts v1 设计

- 日期：2026-07-24
- 状态：已实现，等待 PR 评审
- 目标分支：`feat/contracts-event-sync-v1`
- 基线：`main` @ `58f2ccae76902b77790cecb05483a062259b7083`
- 前置：PR #15–#22 已合并

## 1. 目标

把 Gateway 已稳定运行的领域事件、显式补拉、累计 ACK 与 SSE 数据形状，提升为所有终端共同消费的版本化公共协议：

```text
Gateway 内部 DomainEvent
→ Public SyncEvent v1
→ REST catch-up
→ SSE domain-event
→ Web / iOS / HarmonyOS / DIY
```

本阶段解决：

- `deviceSyncRoutes.ts` 仍自行定义 Query 与 ACK Schema；
- REST 补拉响应没有公共响应 Schema；
- REST 与 SSE 没有共享的公共事件校验入口；
- 正式 Member Web 缺少稳定的 Event / Sync DTO；
- 新事件需要兼顾已知事件的严格类型安全与旧客户端的前向兼容。

## 2. 核心决策

采用：

```text
严格已知事件
+ 受控未知事件
```

规则：

```text
已知 eventType
→ 必须匹配固定 aggregateType、Payload 和跨字段不变量

未知 eventType
→ 作为 Opaque Sync Event 接收
→ 客户端可记录序号并安全忽略业务内容
→ 不阻断后续事件同步
```

已知事件不能在 Payload 错误时退化为 Opaque Event。下面的对象必须失败：

```json
{
  "eventType": "thread.message.created",
  "aggregateType": "thread_message",
  "payload": {
    "workConversationRef": "work:wrong-payload"
  }
}
```

实现上，Opaque Event 的 `eventType` Schema 必须显式排除所有已知类型。

## 3. 方案比较

### 3.1 完全通用 Envelope（不采用）

```ts
{
  eventType: string;
  payload: Record<string, unknown>;
}
```

扩展自由，但已知事件字段漂移只能在各客户端业务代码中零散发现。

### 3.2 封闭严格联合（不采用）

类型安全最强，但未来 Gateway 新增事件时，旧客户端会拒绝整个补拉响应或 SSE 帧。

### 3.3 严格已知事件 + 受控未知事件（采用）

当前事件有严格 Schema；未来事件可被旧客户端作为 Opaque Event 接收和忽略。

## 4. 范围

### 4.1 包含

- 独立 `SYNC_PROTOCOL_VERSION = 1`；
- 公共事件 Envelope；
- 当前七种正式已知事件；
- Opaque Future Event；
- JSON-only Opaque Payload；
- GET 补拉 Query 与 Response；
- POST ACK Request 与 Response；
- SSE 事件名称与 Data Schema；
- REST 与 SSE 共用 `syncEventSchema`；
- Canonical Fixtures；
- Contracts 与 Gateway 集成测试；
- Gateway 使用公共 Schema 校验入站与出站数据；
- 设计、实施计划与验证证据。

### 4.2 不包含

- 正式 Member Web；
- IndexedDB 或浏览器设备身份；
- iOS Chat / Work 代码；
- Push Notification；
- Outbox 外部 Publisher；
- 新增或修改领域事件 Payload；
- 数据库、Event Trigger 或 Device Sync Cursor 事务修改；
- SSE 心跳、重连、共享 Hub 或背压修改；
- Mobile Entry v1 修改；
- 浏览器“小白一键验收台”修改；
- 事件清理、压缩或多 Gateway 协调。

## 5. 协议模块与版本

新增：

```text
packages/contracts/src/sync.ts
```

根入口增加：

```ts
export * from "./sync.js";
```

独立版本：

```ts
export const SYNC_PROTOCOL_VERSION = 1 as const;
```

不借用：

```text
CHAT_WORK_PROTOCOL_VERSION
MOBILE_ENTRY_PROTOCOL_VERSION
PROTOCOL_VERSION
```

当前 wire value 仍为数字 `1`。

## 6. 公共基础 Schema

为避免与现有根导出重名，Sync 模块使用带前缀名称：

```ts
syncEventRefSchema
syncPersonRefSchema
syncDeviceRefSchema
syncThreadRefSchema
syncMessageRefSchema
syncGenericRefSchema
syncEventTypeSchema
syncAggregateTypeSchema
syncEventSequenceSchema
syncCursorSchema
syncTimestampSchema
syncClientMessageIdSchema
syncPublicErrorCodeSchema
syncPublicErrorCategorySchema
```

### 6.1 Ref

固定 Ref 继续使用仓库统一形式：

```text
<prefix>:<lowercase payload>
```

固定示例：

```text
event:...
person:...
device:...
thread:...
message:...
home-chat:...
daily-episode:...
work:...
chat-work-conversion:...
```

`syncGenericRefSchema` 用于未来未知 aggregate：

```regex
^[a-z][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._:-]{1,126}$
```

### 6.2 Event Type 与 Aggregate Type

```ts
syncEventTypeSchema
```

规则：

```regex
^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$
```

长度：3–128。

```ts
syncAggregateTypeSchema
```

规则：

```regex
^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$
```

长度：1–64。

### 6.3 序号与 Cursor

```ts
syncEventSequenceSchema
→ 正的 Number Safe Integer

syncCursorSchema
→ 非负 Number Safe Integer
```

### 6.4 时间、消息幂等标识与错误

```ts
syncTimestampSchema
→ z.string().datetime({ offset: true })

syncClientMessageIdSchema
→ string，长度 8–128，不允许空白字符

syncPublicErrorCodeSchema
→ /^[A-Z][A-Z0-9_]{2,63}$/

syncPublicErrorCategorySchema
→ validation | permission | availability | timeout | conflict | internal
```

Work 状态复用 `workConversationStatusSchema`。

## 7. 公共事件 Envelope

所有公开事件共有：

```ts
interface SyncEventEnvelope {
  eventRef: string;
  personRef: string;
  eventSequence: number;
  eventType: string;
  aggregateType: string;
  aggregateRef: string;
  threadRef: string | null;
  payload: object;
  occurredAt: string;
  createdAt: string;
}
```

顶层 Schema 必须 `.strict()`。

当前公开事件不包含：

```text
Entry Session Token
Device Credential
Authorization Header
Provider External Session
用户消息正文
Assistant 回复正文
原始异常堆栈
数据库 rowid
Outbox lease 信息
```

## 8. Opaque JSON Payload

Opaque Event 的 Payload 只允许 JSON 值：

```ts
type SyncJsonValue =
  | null
  | boolean
  | finite number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };
```

拒绝：

```text
undefined
NaN / Infinity
BigInt
Date
函数
Symbol
循环引用
非 plain object 实例
```

已知事件使用各自 `.strict()` 的固定对象 Schema。

## 9. 已知事件类型

```ts
export const KNOWN_SYNC_EVENT_TYPES = [
  "chat.home.created",
  "work.created",
  "thread.message.created",
  "chat.work.created",
  "work.progress.updated",
  "thread.provider_turn.failed",
  "thread.provider_turn.succeeded"
] as const;
```

## 10. 已知事件定义

### 10.1 `chat.home.created`

```text
aggregateRef == payload.homeChatStreamRef
threadRef == payload.threadRef
```

### 10.2 `work.created`

```text
aggregateRef == payload.workConversationRef
threadRef == payload.threadRef
```

### 10.3 `thread.message.created`

```text
aggregateRef == payload.messageRef
threadRef == payload.threadRef
threadSequence > 0
clientMessageId 长度 8–128 且无空白
```

### 10.4 `chat.work.created`

```text
aggregateRef == payload.conversionRef
sourceMessageRefs 长度 1–100
sourceMessageRefs 唯一并保持顺序
```

### 10.5 `work.progress.updated`

```text
aggregateRef == payload.workConversationRef
occurredAt == payload.updatedAt
```

### 10.6 `thread.provider_turn.failed`

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
attemptCount > 0
error 只包含 code / category / retryable
```

SQLite JSON 内部的 `retryable` 可能表现为 `0/1`。公共 Schema 在 REST / SSE 边界接受内部 `0 | 1 | boolean`，并规范化为真正的 `false/true`。不修改 Event Trigger 或内部 DomainEvent。

### 10.7 `thread.provider_turn.succeeded`

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
assistantMessageRef != userMessageRef
```

## 11. Opaque Future Event

未知 `eventType` 必须通过公共标识规则，并且不属于 `KNOWN_SYNC_EVENT_TYPES`。

```text
未来 eventType + 合法 JSON Payload
→ Opaque Event 通过

已知 eventType + 错误 Payload
→ Known Event 失败
→ Opaque Event 也失败
```

客户端可以记录序号、忽略业务内容、继续后续事件并在可靠落盘后累计 ACK。

## 12. GET 补拉 Query

HTTP 输入：

```ts
{
  afterSequence?: string;
  limit?: string;
}
```

Schema 输出：

```ts
{
  afterSequence?: number;
  limit: number;
}
```

规则：

- `.strict()`；
- 未知参数和数组拒绝；
- `afterSequence` 为非负安全整数十进制字符串；
- `limit` 为 1–200；
- 默认 `limit = 100`；
- 不接受符号、指数、小数、空白或十六进制；
- 为保持当前 Gateway 兼容，前导零接受并规范化。

## 13. GET 补拉 Response

```ts
{
  protocolVersion: 1;
  sync: {
    deviceRef: DeviceRef;
    personRef: PersonRef;
    acknowledgedSequence: number;
    requestedAfterSequence: number;
    latestSequence: number;
  };
  events: SyncEvent[];
  nextAfterSequence: number | null;
}
```

不变量：

```text
acknowledgedSequence <= latestSequence
所有 event.personRef == sync.personRef
所有 event.eventSequence > requestedAfterSequence
所有 event.eventSequence <= latestSequence
events 严格递增
空页 nextAfterSequence == null
非空 nextAfterSequence == 最后一条序号
```

实现中，Gateway 在读取事件页后重新读取 `latestSequence`，避免读页期间新增事件导致过期快照和瞬时 500。

## 14. ACK Request / Response

Request：

```ts
{
  protocolVersion: 1;
  eventSequence: number;
  eventRef: string;
}
```

拒绝客户端提交可信身份和服务端状态字段。

Response 不变量：

```text
acknowledgedSequence >= previousSequence
advanced true  → acknowledgedSequence > previousSequence
advanced false → acknowledgedSequence == previousSequence
```

## 15. SSE 公共协议

```ts
SYNC_SSE_EVENT_NAME = "domain-event"
syncSseDataSchema = syncEventSchema
```

业务帧：

```text
id: <eventSequence>
event: domain-event
data: <SyncEvent JSON>
```

`formatDomainEventFrame()` 在序列化前执行 `syncSseDataSchema.parse(event)`。

Hub 必须先完成公共 Schema 校验，再入队并推进 `scheduledCursor`。校验失败不得推进 Cursor，否则同序号修复事件会被永久跳过。

注释帧不属于业务协议：

```text
: connected
: heartbeat <timestamp>
```

## 16. Gateway 接入

### 16.1 Device Sync Routes

改用：

```text
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
SYNC_PROTOCOL_VERSION
```

删除 Gateway 内重复 Schema 与解析器。

### 16.2 SSE

改用：

```text
SYNC_SSE_EVENT_NAME
syncSseDataSchema
```

### 16.3 内部事件模型

`DomainEventStore` 继续使用内部 `DomainEvent` / `DomainEventPage`。公共协议只在 REST Response 和 SSE Data 边界执行。

## 17. Canonical Fixtures

```text
chat-home-created.json
work-created.json
thread-message-created.json
chat-work-created.json
work-progress-updated.json
provider-turn-failed.json
provider-turn-succeeded.json
opaque-future-event.json
sync-events-response.json
sync-ack-request.json
sync-ack-response.json
```

Fixtures 只使用合成引用。

## 18. 测试策略

Contracts 覆盖：

- 七种 Known Fixtures；
- Known / Opaque 防降级；
- 跨字段不变量；
- JSON-only Opaque；
- Query 规范化；
- 补拉 Person、顺序、分页；
- ACK 状态；
- SQLite 布尔值规范化；
- 隐私扫描；
- Mobile Entry 与 Chat / Work 回归。

Gateway 覆盖：

- REST 入站和出站公共 Schema；
- 跨 Person 假事件拒绝；
- 读页期间新增事件的 `latestSequence` 刷新；
- SSE event name / id / data；
- 错误 Known Event 序列化拒绝；
- 校验失败不推进 Subscriber Cursor；
- 七种实际 Gateway 事件；
- REST 与 SSE 同形；
- 隐私回归。

## 19. 文件边界

允许修改：

```text
packages/contracts/src/sync.ts
packages/contracts/src/index.ts
packages/contracts/test/sync.test.ts
packages/contracts/fixtures/sync/**
apps/gateway/src/deviceSyncRoutes.ts
apps/gateway/src/eventStream.ts
apps/gateway/test/syncContracts.test.ts
apps/gateway/test/syncKnownEvents.test.ts
apps/gateway/test/eventStream.test.ts
apps/gateway/test/eventStreamResilience.test.ts
docs/superpowers/**
```

明确不修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
apps/gateway/src/deviceSync.ts
apps/gateway/src/domainEventCore.ts
apps/gateway/src/domainEvents.ts
apps/gateway/public/**
```

## 20. 成功标准

```text
所有正式事件拥有公共严格 Schema
错误 Known Event 不能退化为 Opaque
Future Event 不阻断旧客户端
REST 与 SSE 使用同一 SyncEvent Schema
补拉与 ACK 不再由 Gateway 重复定义
补拉响应拥有跨字段一致性和并发安全
SSE 校验失败不推进 Cursor
当前 Gateway 正常行为保持兼容
Mobile Entry v1 保持冻结
PR #14 changed-path 交集为 0
```

## 21. 后续顺序

```text
正式 Member Web 壳与 Personal Entry
→ Chat 页面与消息查询
→ Work 列表与详情
→ IndexedDB + Device Sync Cursor + SSE 闭环
→ Push Notification
→ iOS 接入统一 Chat / Work 与 Sync Contracts
```
