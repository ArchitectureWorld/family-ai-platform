# Public Event / Sync Contracts v1 设计

- 日期：2026-07-24
- 状态：待书面审阅
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

当前 wire value 仍为数字 `1`，因此不会改变已部署 JSON 值。

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

这些规则覆盖当前：

```text
thread.provider_turn.failed
thread_message
provider_turn
```

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

Work 状态直接复用 `workConversationStatusSchema`，避免 Sync 与 Chat / Work 对状态集合产生两套定义。

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

已知事件不使用通用 Payload，而使用各自 `.strict()` 的固定对象 Schema。

公共 Schema 可以结构性保证已知事件没有秘密字段，但无法判断 Opaque 字符串的语义。Gateway 事件生产端仍负责数据最小化；集成测试扫描当前正式事件，确认不含 Token、Credential、Authorization 或 External Session 字段。

## 9. 已知事件类型

导出：

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

knownSyncEventTypeSchema
KnownSyncEventType
```

## 10. 已知事件定义

所有 Payload 都必须 `.strict()`。

### 10.1 `chat.home.created`

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

不变量：

```text
aggregateRef == payload.homeChatStreamRef
threadRef == payload.threadRef
```

### 10.2 `work.created`

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

不变量：

```text
aggregateRef == payload.workConversationRef
threadRef == payload.threadRef
```

### 10.3 `thread.message.created`

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
    clientMessageId: SyncClientMessageId;
  };
}
```

不变量：

```text
aggregateRef == payload.messageRef
threadRef == payload.threadRef
```

事件不携带正文。`clientMessageId` 用于把客户端乐观消息与 Gateway 持久化消息对齐。

### 10.4 `chat.work.created`

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

不变量：

```text
aggregateRef == payload.conversionRef
sourceMessageRefs 长度 1–100
sourceMessageRefs 唯一并保持转换顺序
```

`threadRef` 表示目标 Work Thread。事件不复制消息正文。

### 10.5 `work.progress.updated`

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

不变量：

```text
aggregateRef == payload.workConversationRef
occurredAt == payload.updatedAt
```

不要求 `createdAt == updatedAt`，保留未来写入延迟的表达空间。

### 10.6 `thread.provider_turn.failed`

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
      category: PublicErrorCategory;
      retryable: boolean;
    };
  };
}
```

不变量：

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
```

错误 Payload 不包含 message、stack、原始 Provider 响应或 External Session。

### 10.7 `thread.provider_turn.succeeded`

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

不变量：

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
assistantMessageRef != userMessageRef
```

## 11. Opaque Future Event

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

`eventType` 必须通过 `syncEventTypeSchema`，并且不属于 `KNOWN_SYNC_EVENT_TYPES`。

因此：

```text
未来 eventType + 合法 JSON Payload
→ Opaque Event 通过

已知 eventType + 错误 Payload
→ Known Event 失败
→ Opaque Event 也失败
```

客户端处理未知事件时：

- 按 `eventSequence` 幂等记录；
- 不根据未知 Payload 修改已知领域状态；
- 可以忽略业务内容；
- 不能中断后续事件；
- 可靠落盘后仍可累计 ACK。

## 12. 事件组合 Schema

导出：

```ts
knownSyncEventSchema
opaqueSyncEventSchema
syncEventSchema

KnownSyncEvent
OpaqueSyncEvent
SyncEvent
```

组合：

```ts
knownSyncEventSchema = z.discriminatedUnion("eventType", [
  chatHomeCreatedEventSchema,
  workCreatedEventSchema,
  threadMessageCreatedEventSchema,
  chatWorkCreatedEventSchema,
  workProgressUpdatedEventSchema,
  providerTurnFailedEventSchema,
  providerTurnSucceededEventSchema
]);

opaqueSyncEventSchema = strictEnvelope.extend({
  eventType: futureEventTypeSchema
});

syncEventSchema = z.union([
  knownSyncEventSchema,
  opaqueSyncEventSchema
]);
```

`futureEventTypeSchema` 排除七种已知类型，这是防止降级绕过的关键门禁。

## 13. GET 补拉 Query

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

Schema 输出：

```ts
{
  afterSequence?: number;
  limit: number;
}
```

规则：

- `.strict()`；
- 未知参数和数组形式拒绝；
- `afterSequence` 是非负安全整数的十进制数字字符串；
- `limit` 是 1–200 的十进制数字字符串；
- `limit` 缺失时输出 100；
- 不接受符号、指数、小数、空白或十六进制；
- 为保持当前 Gateway wire 兼容，前导零继续接受并规范化为数字。

示例：

```text
"0"    → 0
"001"  → 1
"200"  → 200
```

拒绝：

```text
-1
1.5
1e3
 1
9007199254740992
```

## 14. GET 补拉 Response

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
  events: SyncEvent[]; // max 200
  nextAfterSequence: positive safe integer | null;
}
```

不变量：

```text
acknowledgedSequence <= latestSequence
所有 event.personRef == sync.personRef
所有 event.eventSequence > requestedAfterSequence
所有 event.eventSequence <= latestSequence
events 按 eventSequence 严格递增
```

分页不变量：

```text
events 为空
→ nextAfterSequence == null

nextAfterSequence 非空
→ events 非空
→ nextAfterSequence == 本页最后事件序号
```

允许显式查询位置高于 `latestSequence`，此时返回空数组和 `null`；GET 不推进持久 Cursor。

## 15. 累计 ACK Request / Response

### 15.1 Request

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

Body `.strict()`，拒绝：

```text
deviceRef
personRef
entryBindingRef
entrySessionRef
acknowledgedSequence
updatedAt
其他未知字段
```

### 15.2 Response

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

不变量：

```text
acknowledgedSequence >= previousSequence

advanced == true
→ acknowledgedSequence > previousSequence

advanced == false
→ acknowledgedSequence == previousSequence
```

## 16. SSE 公共协议

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

不变量：

```text
SSE id == data.eventSequence
```

`formatDomainEventFrame()` 在序列化前先执行 `syncSseDataSchema.parse(event)`。

以下注释帧不建立 JSON Schema：

```text
: connected
: heartbeat <timestamp>
```

它们不承载业务事实，也不推进 Device Sync Cursor。

## 17. Gateway 接入

### 17.1 Device Sync Routes

`apps/gateway/src/deviceSyncRoutes.ts` 改用：

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
本地 syncEventsQuerySchema
本地 syncAckSchema
本地 eventRefSchema
safeInteger()
```

路由继续负责认证、可信 Device / Person 解析、Repository 调用和错误映射。

### 17.2 SSE

`apps/gateway/src/eventStream.ts` 改用：

```ts
SYNC_SSE_EVENT_NAME
syncSseDataSchema
```

流程：

```text
内部 DomainEvent
→ syncSseDataSchema.parse
→ JSON.stringify
→ SSE Frame
```

SSE Cursor、心跳、共享 Hub、背压和关闭顺序保持不变。

### 17.3 内部事件模型

`DomainEventStore` 继续使用内部 `DomainEvent` / `DomainEventPage`。公共协议只在 REST Response 和 SSE Data 边界执行，避免把 SQLite Repository 类型直接变成公共权威。

## 18. Canonical Fixtures

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

Fixtures 只使用合成引用，不包含真实 Token、Credential、Host 或用户内容。

## 19. 测试策略

### 19.1 Contracts

新增：

```text
packages/contracts/test/sync.test.ts
```

覆盖：

1. 七种已知事件 Fixtures 全部通过；
2. 已知事件的 `eventType`、`aggregateType` 和 Payload 固定；
3. aggregateRef / threadRef 跨字段不一致时失败；
4. `chat.work.created` 来源引用必须非空且唯一；
5. Known Event 错误 Payload 不能退化为 Opaque；
6. Future Event 作为 Opaque 通过；
7. Opaque 顶层未知字段与非 JSON Payload 失败；
8. Query 合法值、非法值、数组、默认 limit 和前导零兼容；
9. 补拉响应 Person、序号与分页不变量；
10. ACK `advanced` 与序号关系一致；
11. 请求拒绝可信身份字段；
12. Fixtures 不含 Token、Credential、Authorization 或 External Session；
13. 现有 Mobile Entry 和 Chat / Work Contracts 测试继续通过。

### 19.2 Gateway

覆盖：

1. GET 响应通过 `syncEventsResponseSchema`；
2. POST ACK 请求与响应使用公共 Schema；
3. Gateway Query 行为与共享 Transform 一致；
4. 客户端 Device / Person 字段仍被拒绝；
5. SSE event name 等于 `SYNC_SSE_EVENT_NAME`；
6. SSE data 通过 `syncSseDataSchema`；
7. SSE id 等于事件序号；
8. REST 与 SSE 对同一事件产生相同 JSON；
9. 当前七种 Gateway 事件全部通过 Known Schema；
10. Device Sync Cursor、SSE、Outbox、Chat / Work 与 Mobile 回归不变。

## 20. 兼容性与版本演进

### 20.1 新事件

新增 `eventType` 时：

- Gateway 可以先生产 Opaque-compatible Event；
- v1 旧客户端继续同步并忽略；
- 新 Contracts 版本可将其提升为 Known Event；
- 事件序列和 ACK 协议不必升级。

### 20.2 已知事件变更

以下属于破坏性变更：

```text
删除字段
改变字段类型
改变 aggregateType
改变 aggregateRef / threadRef 语义
改变必填结构
```

必须新增 `eventType` 或升级 `SYNC_PROTOCOL_VERSION`，不能静默修改。

Known Payload 使用 `.strict()`；即使只增加可选字段，旧 v1 客户端也会拒绝。因此扩展已知事件时优先新增事件类型。

## 21. 安全与隐私

- 公共请求永远不接受可信 Device、Person、EntryBinding、EntrySession、Agent 或 Provider Profile；
- Gateway 仍从认证上下文解析 Device 与 Person；
- Response Schema 的 Person 一致性校验不能替代服务端授权查询；
- Known Payload 只包含引用、序号、状态、时间和错误分类；
- Opaque Event 是兼容机制，不是绕过数据治理的机制；
- 新 Opaque Event 进入公开流前仍需设计 Review、数据最小化、Fixture、集成测试和 Secret Scan。

## 22. 文件边界

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
同主题 Gateway syncContracts*.test.ts
docs/superpowers/specs/2026-07-24-public-event-sync-contracts-v1-design.md
docs/superpowers/plans/2026-07-24-public-event-sync-contracts-v1.md
docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md
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

不修改数据库、事件生产触发器或 Cursor 事务。

## 23. PR #14 隔离

PR #14 只修改：

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

本阶段与其 changed paths 交集保持为零。

PR #14 的 iOS CI 路径过滤包含 `packages/contracts/**`。本 PR 合并后，GitHub 可能重新计算 PR #14 merged tree 或重新触发 iOS 检查。因此完成前必须复核：

- PR #14 仍为 Open；
- PR #14 仍为 Draft；
- Head 保持 `e075f114e3f3fcdb728f6bff75797d415c4a5315`；
- GitHub 重新计算后仍可合并；
- 若 iOS CI 重新运行，必须成功；
- Mobile Entry v1 Fixtures 与导出保持不变。

## 24. TDD 顺序

```text
Contracts Fixtures 与失败测试
→ Known Event Schemas
→ Opaque Event 与防降级门禁
→ Query / Response / ACK Schemas
→ Gateway REST 接入
→ Gateway SSE 接入
→ 七种事件集成验证
→ 隐私与兼容性审查
→ 全仓门禁
```

每个行为阶段先提交可观察 RED，再提交最小 GREEN 实现。

## 25. 全仓门禁

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

## 26. 成功标准

```text
所有当前正式事件拥有公共严格 Schema
错误 Known Event 不能退化为 Opaque
Future Event 不阻断旧客户端同步
REST 与 SSE 使用同一 SyncEvent Schema
GET Query 和 ACK 不再由 Gateway 重复定义
补拉响应拥有跨字段一致性检查
SSE id、event name 与 data 一致
当前 Gateway wire 行为不发生破坏性变化
Mobile Entry v1 保持冻结
PR #14 的 iOS 与 workflow 路径保持零交集
```

## 27. 后续顺序

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
