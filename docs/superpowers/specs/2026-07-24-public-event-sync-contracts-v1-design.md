# Public Event / Sync Contracts v1 设计

- 日期：2026-07-24
- 状态：待书面审阅
- 目标分支：`feat/contracts-event-sync-v1`
- 基线：`main` @ `58f2ccae76902b77790cecb05483a062259b7083`
- 前置：PR #15–#22 已合并

## 1. 目标

把 Gateway 已经稳定运行的领域事件、显式补拉、累计 ACK 与 SSE 数据形状，提升为所有终端共同消费的版本化公共协议：

```text
Gateway 内部 DomainEvent
→ Public SyncEvent v1
→ REST catch-up
→ SSE domain-event
→ Web / iOS / HarmonyOS / DIY
```

本阶段解决以下问题：

- Gateway 当前在 `deviceSyncRoutes.ts` 内自行定义 Query 和 ACK Schema；
- REST 补拉响应尚未通过公共响应 Schema；
- SSE 与 REST 虽然传递同一内部对象，但没有共享的公共校验入口；
- 正式 Member Web 尚无稳定的 Event / Sync DTO 可以依赖；
- 新增未来事件时，需要兼顾已知事件的严格类型安全与旧客户端的前向兼容。

## 2. 核心决策

采用：

```text
严格已知事件
+ 受控未知事件
```

含义：

```text
已知 eventType
→ 必须匹配该事件固定的 aggregateType、Payload 与跨字段不变量

未知 eventType
→ 作为 Opaque Sync Event 接收
→ 客户端可以记录事件序号并安全忽略业务内容
→ 不阻断后续已知事件同步
```

明确禁止已知事件在 Payload 错误时退化为 Opaque Event。以下事件必须校验失败：

```json
{
  "eventType": "thread.message.created",
  "aggregateType": "thread_message",
  "payload": {
    "workConversationRef": "work:wrong-payload"
  }
}
```

## 3. 方案比较

### 3.1 方案 A：完全通用 Envelope（不采用）

```ts
{
  eventType: string;
  payload: Record<string, unknown>;
}
```

优点是扩展自由；缺点是客户端无法在编译期和运行时可靠判断已知事件字段，字段拼错、Payload 漂移和 aggregate 不一致只能在业务代码中零散发现。

### 3.2 方案 B：封闭严格联合（不采用）

所有事件必须属于 v1 固定联合。类型安全最强，但未来 Gateway 新增事件时，旧客户端会拒绝整个补拉响应或 SSE 帧，破坏前向兼容。

### 3.3 方案 C：严格已知事件 + 受控未知事件（采用）

已知事件采用严格联合，未知事件采用 Opaque Envelope；Opaque Schema 明确排除全部已知 `eventType`，防止错误已知事件绕过校验。

## 4. 范围

### 4.1 包含

- 独立 `SYNC_PROTOCOL_VERSION = 1`；
- 公共事件 Envelope；
- 七种当前正式已知事件；
- Opaque Future Event；
- 受控 JSON Payload；
- GET 补拉 Query、Response；
- POST ACK Request、Response；
- SSE 业务事件名称与数据 Schema；
- REST 与 SSE 共用同一事件解析器；
- Canonical Fixtures；
- Contracts 单元测试；
- Gateway 使用公共 Schema 校验入站和出站数据；
- 与当前 Gateway 行为兼容的集成回归测试；
- 设计、实施计划与验证证据。

### 4.2 不包含

- 正式 Member Web 页面；
- IndexedDB 或浏览器设备身份；
- iOS Chat / Work 代码；
- Push Notification；
- Outbox 外部发布 Worker；
- 新增领域事件类型；
- 修改现有事件 Payload；
- 修改数据库或 Device Sync Cursor 事务；
- 修改 SSE 心跳、重连和背压机制；
- 修改 Mobile Entry v1；
- 修改浏览器“小白一键验收台”；
- 事件保留期、清理或压缩；
- 多 Gateway 实例协调。

## 5. 协议模块与版本

新增：

```text
packages/contracts/src/sync.ts
```

并在根入口增加：

```ts
export * from "./sync.js";
```

独立版本：

```ts
export const SYNC_PROTOCOL_VERSION = 1 as const;
```

不继续借用：

```ts
CHAT_WORK_PROTOCOL_VERSION
MOBILE_ENTRY_PROTOCOL_VERSION
PROTOCOL_VERSION
```

理由：

- Sync 协议可能新增事件兼容规则而不改变 Chat / Work 命令；
- Mobile Entry 可能单独升级配对或凭据字段；
- 独立常量可以明确 API 属于哪个协议族；
- 当前 wire value 仍为数字 `1`，不会改变已部署响应值。

## 6. 命名与基础 Schema

为避免与现有根导出的旧 Foundation Schema 冲突，公共 Sync 模块使用带前缀的名称：

```ts
syncEventRefSchema
syncPersonRefSchema
syncDeviceRefSchema
syncThreadRefSchema
syncMessageRefSchema
syncGenericRefSchema
syncEventSequenceSchema
syncCursorSchema
syncTimestampSchema
```

Ref 规则：

```text
<prefix>:<lowercase payload>
```

其中：

```ts
syncEventRefSchema   // event:...
syncPersonRefSchema  // person:...
syncDeviceRefSchema  // device:...
syncThreadRefSchema  // thread:...
syncMessageRefSchema // message:...
```

`syncGenericRefSchema` 用于未来未知 aggregate，仍要求具有稳定 prefix，而不是接受任意字符串。

数值规则：

```ts
syncEventSequenceSchema
→ 正的 Number Safe Integer

syncCursorSchema
→ 非负 Number Safe Integer
```

时间规则：

```ts
z.string().datetime({ offset: true })
```

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

顶层 Schema 必须 `.strict()`，拒绝未知字段。

公共事件不包含：

```text
Entry Session Token
Device Credential
Authorization Header
Provider External Session
用户消息正文
Assistant 回复正文
原始异常堆栈
数据库内部 rowid
Outbox lease 信息
```

## 8. 受控 JSON Payload

Opaque Event 的 Payload 只允许 JSON 值：

```ts
type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };
```

拒绝：

```text
undefined
BigInt
Date 实例
函数
Symbol
循环引用
非 JSON class instance
```

已知事件不使用通用 Payload，而使用各自严格 `.strict()` 的对象 Schema。

需要如实区分：公共 Schema 可以结构性保证当前已知事件不含秘密字段，但不能从任意 Opaque 字符串中判断语义上是否包含秘密。因此：

- Opaque Payload 只提供 JSON 结构约束；
- Gateway 事件生产端继续负责数据最小化和脱敏；
- 集成测试扫描当前所有正式事件，确认没有 Token、Credential、Authorization 或 External Session 字段。

## 9. 已知事件类型

固定导出：

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

并导出：

```ts
knownSyncEventTypeSchema
KnownSyncEventType
```

## 10. `chat.home.created`

```ts
{
  eventType: "chat.home.created";
  aggregateType: "home_chat";
  aggregateRef: HomeChatStreamRef;
  threadRef: ThreadRef;
  payload: {
    homeChatStreamRef: HomeChatStreamRef;
    dailyEpisodeRef: DailyEpisodeRef;
    threadRef: ThreadRef;
  };
}
```

跨字段不变量：

```text
aggregateRef == payload.homeChatStreamRef
threadRef == payload.threadRef
```

## 11. `work.created`

```ts
{
  eventType: "work.created";
  aggregateType: "work";
  aggregateRef: WorkConversationRef;
  threadRef: ThreadRef;
  payload: {
    workConversationRef: WorkConversationRef;
    threadRef: ThreadRef;
    status: WorkConversationStatus;
  };
}
```

跨字段不变量：

```text
aggregateRef == payload.workConversationRef
threadRef == payload.threadRef
```

## 12. `thread.message.created`

```ts
{
  eventType: "thread.message.created";
  aggregateType: "thread_message";
  aggregateRef: MessageRef;
  threadRef: ThreadRef;
  payload: {
    messageRef: MessageRef;
    threadRef: ThreadRef;
    threadSequence: positive safe integer;
    actorType: "person" | "assistant" | "agent" | "system";
    clientMessageId: string;
  };
}
```

`clientMessageId` 继续保留，供客户端把乐观消息与 Gateway 持久化消息对齐。

跨字段不变量：

```text
aggregateRef == payload.messageRef
threadRef == payload.threadRef
```

事件不携带消息正文；客户端收到事件后，通过 Thread Message API 读取具体内容。

## 13. `chat.work.created`

```ts
{
  eventType: "chat.work.created";
  aggregateType: "chat_work_conversion";
  aggregateRef: ChatWorkConversionRef;
  threadRef: ThreadRef;
  payload: {
    conversionRef: ChatWorkConversionRef;
    homeChatStreamRef: HomeChatStreamRef;
    workConversationRef: WorkConversationRef;
    sourceMessageRefs: MessageRef[];
  };
}
```

规则：

```text
aggregateRef == payload.conversionRef
sourceMessageRefs 长度 1–100
sourceMessageRefs 必须唯一且保持转换顺序
```

`threadRef` 表示目标 Work 的 Thread。Payload 不重复保存消息正文。

## 14. `work.progress.updated`

```ts
{
  eventType: "work.progress.updated";
  aggregateType: "work_progress";
  aggregateRef: WorkConversationRef;
  threadRef: ThreadRef;
  payload: {
    workConversationRef: WorkConversationRef;
    status: WorkConversationStatus;
    updatedAt: Timestamp;
  };
}
```

跨字段不变量：

```text
aggregateRef == payload.workConversationRef
occurredAt == payload.updatedAt
```

不要求 `createdAt == updatedAt`，以保留未来事件写入延迟的表达空间。

## 15. `thread.provider_turn.failed`

```ts
{
  eventType: "thread.provider_turn.failed";
  aggregateType: "provider_turn";
  aggregateRef: MessageRef;
  threadRef: ThreadRef;
  payload: {
    userMessageRef: MessageRef;
    threadRef: ThreadRef;
    attemptCount: positive safe integer;
    error: {
      code: PublicErrorCode;
      category:
        | "validation"
        | "permission"
        | "availability"
        | "timeout"
        | "conflict"
        | "internal";
      retryable: boolean;
    };
  };
}
```

跨字段不变量：

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
```

错误 Payload 不包含：

```text
message
stack
raw provider response
externalSessionRef
```

客户端通过 `code + category + retryable` 决定状态呈现和重试策略。

## 16. `thread.provider_turn.succeeded`

```ts
{
  eventType: "thread.provider_turn.succeeded";
  aggregateType: "provider_turn";
  aggregateRef: MessageRef;
  threadRef: ThreadRef;
  payload: {
    userMessageRef: MessageRef;
    assistantMessageRef: MessageRef;
    threadRef: ThreadRef;
    attemptCount: positive safe integer;
  };
}
```

跨字段不变量：

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
assistantMessageRef != userMessageRef
```

## 17. Opaque Future Event

导出：

```ts
opaqueSyncEventSchema
OpaqueSyncEvent
```

结构：

```ts
{
  eventRef: EventRef;
  personRef: PersonRef;
  eventSequence: positive safe integer;
  eventType: future event type;
  aggregateType: future aggregate type;
  aggregateRef: GenericRef;
  threadRef: ThreadRef | null;
  payload: SyncJsonObject;
  occurredAt: Timestamp;
  createdAt: Timestamp;
}
```

`eventType` 必须满足公共标识规则，并明确不属于 `KNOWN_SYNC_EVENT_TYPES`。

因此：

```text
未来 eventType + 合法 JSON Payload
→ Opaque Event 通过

已知 eventType + 错误 Payload
→ Known Event 失败
→ Opaque Event 同样失败
```

客户端对未知事件的最低要求：

- 按 `eventSequence` 幂等记录已观察位置；
- 不根据未知 Payload 修改已知领域状态；
- 可以忽略业务内容；
- 不能因此中断后续事件处理；
- 可靠落盘后仍可累计 ACK。

## 18. 事件组合 Schema

导出：

```ts
knownSyncEventSchema
opaqueSyncEventSchema
syncEventSchema

KnownSyncEvent
OpaqueSyncEvent
SyncEvent
```

实现边界：

```ts
knownSyncEventSchema = z.discriminatedUnion("eventType", [...]);

opaqueSyncEventSchema = strictEnvelope.extend({
  eventType: futureEventTypeSchema
});

syncEventSchema = z.union([
  knownSyncEventSchema,
  opaqueSyncEventSchema
]);
```

`futureEventTypeSchema` 必须通过 Refine 排除七种已知类型，这是防止错误已知事件降级的关键门禁。

## 19. GET 补拉 Query

导出：

```ts
syncEventsQuerySchema
SyncEventsQueryInput
SyncEventsQuery
```

HTTP 输入：

```ts
{
  afterSequence?: string;
  limit?: string;
}
```

Schema 输出规范化为：

```ts
{
  afterSequence?: number;
  limit: number;
}
```

规则：

- `.strict()`；
- 未知参数拒绝；
- 数组形式拒绝；
- `afterSequence` 必须为非负安全整数的十进制字符串；
- `limit` 必须为 1–200 的十进制整数字符串；
- `limit` 缺失时输出 100；
- 不接受符号、指数、小数、空白、前后填充或十六进制。

允许：

```text
0
1
200
9007199254740991
```

拒绝：

```text
-1
1.5
1e3
 1
01（避免多种等价 wire 表达）
9007199254740992
```

`afterSequence = "0"` 与 `limit = "1"` 是合法值。

## 20. GET 补拉响应

导出：

```ts
syncEventsResponseSchema
SyncEventsResponse
```

结构：

```ts
{
  protocolVersion: 1;
  sync: {
    deviceRef: DeviceRef;
    personRef: PersonRef;
    acknowledgedSequence: nonnegative safe integer;
    requestedAfterSequence: nonnegative safe integer;
    latestSequence: nonnegative safe integer;
  };
  events: SyncEvent[];
  nextAfterSequence: positive safe integer | null;
}
```

数组限制：

```text
events 最多 200 条
```

跨字段不变量：

```text
acknowledgedSequence <= latestSequence
每个 event.personRef == sync.personRef
每个 event.eventSequence > requestedAfterSequence
每个 event.eventSequence <= latestSequence
events 按 eventSequence 严格递增
```

分页不变量：

```text
events 为空
→ nextAfterSequence 必须为 null

nextAfterSequence 非空
→ events 必须非空
→ nextAfterSequence == 本页最后事件的 eventSequence
```

允许显式查询位置高于 `latestSequence`，此时：

```text
events = []
nextAfterSequence = null
```

因为 GET 是只读诊断和重放接口，不推进持久 Cursor。

## 21. 累计 ACK Request

导出：

```ts
syncAckRequestSchema
SyncAckRequest
```

结构：

```ts
{
  protocolVersion: 1;
  eventSequence: positive safe integer;
  eventRef: EventRef;
}
```

Body 必须 `.strict()`，拒绝客户端提交：

```text
deviceRef
personRef
entryBindingRef
entrySessionRef
acknowledgedSequence
updatedAt
其他未知字段
```

## 22. 累计 ACK Response

导出：

```ts
syncAckResponseSchema
SyncAckResponse
```

结构：

```ts
{
  protocolVersion: 1;
  sync: {
    deviceRef: DeviceRef;
    personRef: PersonRef;
    previousSequence: nonnegative safe integer;
    acknowledgedSequence: nonnegative safe integer;
    advanced: boolean;
    updatedAt: Timestamp;
  };
}
```

跨字段不变量：

```text
acknowledgedSequence >= previousSequence

advanced == true
→ acknowledgedSequence > previousSequence

advanced == false
→ acknowledgedSequence == previousSequence
```

## 23. SSE 公共协议

导出：

```ts
export const SYNC_SSE_EVENT_NAME = "domain-event" as const;
export const syncSseDataSchema = syncEventSchema;
export type SyncSseData = SyncEvent;
```

业务帧：

```text
id: <eventSequence>
event: domain-event
data: <SyncEvent JSON>
```

规则：

```text
SSE id == data.eventSequence
```

`formatDomainEventFrame()` 在序列化前必须先通过 `syncSseDataSchema`。

本协议不为以下注释帧建立 JSON Schema：

```text
: connected
: heartbeat <timestamp>
```

它们不承载业务事实，也不推进 Device Sync Cursor。

## 24. Gateway 接入

### 24.1 Device Sync Routes

`apps/gateway/src/deviceSyncRoutes.ts` 改为使用：

```ts
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
SYNC_PROTOCOL_VERSION
```

删除 Gateway 内重复的：

```text
decimalSchema
syncEventsQuerySchema
syncAckSchema
eventRefSchema
safeInteger()
```

路由继续负责：

- Personal Entry Session 认证；
- 从可信 Entry Context 解析 Device 与 Person；
- 调用 Repository；
- 将验证失败映射为现有 `REQUEST_INVALID`；
- 将不存在或跨 Person ACK 映射为 `SYNC_EVENT_NOT_FOUND`。

### 24.2 SSE

`apps/gateway/src/eventStream.ts` 改为使用：

```ts
SYNC_SSE_EVENT_NAME
syncSseDataSchema
```

`formatDomainEventFrame()`：

```text
内部 DomainEvent
→ syncSseDataSchema.parse
→ JSON.stringify
→ SSE Frame
```

SSE Cursor、心跳、共享 Hub、背压与关闭顺序保持不变。

### 24.3 DomainEventStore

数据库层继续使用内部：

```ts
DomainEvent
DomainEventPage
```

不把 SQLite Repository 类型直接当作公共协议权威。公共边界只发生在：

```text
REST Response
SSE Data
```

这样未来数据库内部字段可以演进，而公开 DTO 继续版本化。

## 25. Canonical Fixtures

新增：

```text
packages/contracts/fixtures/sync/
```

至少包含：

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

Fixtures 使用合成 Person、Device、Thread、Message 和 Work 引用，不包含真实 Token、Credential、Host 或用户内容。

## 26. Contracts 测试

新增：

```text
packages/contracts/test/sync.test.ts
```

必须覆盖：

1. 七种已知事件 Canonical Fixtures 全部通过；
2. 每种已知事件的 `eventType`、`aggregateType` 与 Payload 固定；
3. aggregateRef 与 Payload 主要 Ref 不一致时失败；
4. threadRef 与 Payload threadRef 不一致时失败；
5. 已知事件错误 Payload 不能退化为 Opaque；
6. 未来未知事件作为 Opaque 通过；
7. Opaque 顶层未知字段失败；
8. Opaque Payload 非 JSON 值失败；
9. Query 对合法、非法、数组和默认 limit 的处理正确；
10. 补拉响应 Person 隔离和顺序不变量；
11. `nextAfterSequence` 与最后事件一致；
12. ACK `advanced` 与序号关系一致；
13. 请求拒绝可信身份字段；
14. 序列化 Fixtures 不含 Token、Credential、Authorization、External Session；
15. 现有 Mobile Entry 和 Chat / Work Contracts 测试保持通过。

## 27. Gateway 集成测试

新增或扩展 Gateway 测试，覆盖：

1. `GET /api/v1/sync/events` 响应通过 `syncEventsResponseSchema`；
2. `POST /api/v1/sync/ack` 请求和响应使用公共 Schema；
3. Gateway Query 行为与共享 Query Transform 一致；
4. Device / Person 客户端字段仍被拒绝；
5. SSE `event` 名称等于 `SYNC_SSE_EVENT_NAME`；
6. SSE `data` 通过 `syncSseDataSchema`；
7. SSE `id` 等于事件序号；
8. REST 与 SSE 对同一事件产生相同 JSON 数据形状；
9. 当前七种 Gateway 事件全部通过公共 Known Schema；
10. 现有 Device Sync Cursor、SSE、Outbox、Chat / Work 和 Mobile 回归不变。

## 28. 兼容性与版本演进

### 28.1 新增未知事件

未来仅新增新的 `eventType` 时：

- Gateway 可以先生产 Opaque-compatible Event；
- v1 旧客户端继续同步并安全忽略；
- 新版 Contracts 再把该事件提升为 Known Event；
- 事件序列与 ACK 协议无需升级。

### 28.2 修改已知事件

以下变更属于破坏性变更：

```text
删除已知 Payload 字段
改变字段类型
改变 aggregateType
改变 aggregateRef 语义
改变 threadRef 语义
把必填字段改为不可兼容结构
```

必须：

```text
新增 eventType
或升级 SYNC_PROTOCOL_VERSION
```

不能静默改变现有 Known Event。

### 28.3 增加可选字段

Known Payload 使用 `.strict()`，因此即使增加可选字段，旧 v1 客户端也会拒绝该已知事件。为了保证前向兼容，新增字段优先选择：

```text
新 eventType
```

而不是修改既有事件形状。

## 29. 安全与隐私

### 29.1 身份来源

公共请求 Schema 永远不接受可信身份：

```text
Device
Person
EntryBinding
EntrySession
Agent
Provider Profile
```

Gateway 从认证上下文解析 Device 与 Person。

### 29.2 Person 隔离

`syncEventsResponseSchema` 强制所有事件属于响应 `sync.personRef`，但它不能替代服务端授权查询。Gateway 仍必须使用认证 Person 查询数据库。

### 29.3 事件最小化

Known Event Payload 只包含：

```text
引用
序号
状态
发生时间
错误分类
重试标记
```

不包含消息正文、Provider Session 或认证材料。

### 29.4 Opaque Event 风险

Opaque Event 是兼容机制，不是绕过数据治理的机制。Gateway 新事件进入公共流前仍需：

- 设计 Review；
- 数据最小化；
- Secret Scan；
- Fixture 与集成测试；
- 决定是否立即提升为 Known Event。

## 30. 文件边界

允许修改：

```text
packages/contracts/src/sync.ts
packages/contracts/src/index.ts
packages/contracts/test/sync.test.ts
packages/contracts/fixtures/sync/**
apps/gateway/src/deviceSyncRoutes.ts
apps/gateway/src/eventStream.ts
apps/gateway/test/deviceSyncRoutes.test.ts
apps/gateway/test/eventStream*.test.ts
同主题 Gateway contract integration tests
docs/superpowers/specs/2026-07-24-public-event-sync-contracts-v1-design.md
docs/superpowers/plans/2026-07-24-public-event-sync-contracts-v1.md
docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md
```

根据测试组织可以增加同主题 `syncContracts*.test.ts`，但生产范围不扩张。

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

不修改数据库、事件生产触发器或 Cursor 事务。

## 31. PR #14 隔离

PR #14 当前只修改：

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

本阶段不修改上述路径，changed-path 集合交集保持为零。

需要额外注意：PR #14 的 iOS CI 路径过滤包含 `packages/contracts/**`。本 PR 合并后，GitHub 可能重新计算 PR #14 的 merged tree 或重新触发 iOS 检查。因此完成前必须复核：

- PR #14 仍为 Open；
- PR #14 仍为 Draft；
- Head 保持 `e075f114e3f3fcdb728f6bff75797d415c4a5315`；
- GitHub 重新计算后仍可合并；
- 若 iOS CI 重新运行，必须成功；
- Mobile Entry v1 Fixtures 与导出保持不变。

## 32. TDD 顺序

```text
Contracts fixtures 与失败测试
→ Known Event Schemas
→ Opaque Event 与防降级门禁
→ Query / Response / ACK Schemas
→ Gateway REST 接入
→ Gateway SSE 接入
→ 当前七种事件集成验证
→ 隐私与兼容性审查
→ 全仓门禁
```

每个行为阶段先提交可观察 RED，再提交最小 GREEN 实现。

## 33. 全仓门禁

```bash
npm run test -w @family-ai/contracts
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

最终 Head 还要求：

- Repository CI 成功；
- Secret Scan 成功；
- PR 可合并；
- 无未解决 Review Thread；
- PR #14 changed-path 交集为零；
- PR #14 状态和 Head 不变。

## 34. 成功标准

```text
所有当前正式事件拥有公共严格 Schema
错误已知事件不能退化为 Opaque
未来未知事件不会阻断旧客户端同步
REST 与 SSE 使用同一 SyncEvent Schema
GET Query 和 ACK 不再由 Gateway 重复定义
补拉响应拥有跨字段一致性检查
SSE id、event name 与 data 一致
当前 Gateway wire value 不发生破坏性变化
Mobile Entry v1 保持冻结
PR #14 的 iOS 与 workflow 路径保持零交集
```

## 35. 后续顺序

本 PR 合并并同步开发记录后：

```text
正式 Member Web 壳与 Personal Entry
→ Chat 页面与消息查询
→ Work 列表与详情
→ IndexedDB + Device Sync Cursor + SSE 闭环
→ Push Notification
→ iOS 接入统一 Chat / Work 与 Sync Contracts
```

在 PR #14 真机验收完成前，后续独立 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
