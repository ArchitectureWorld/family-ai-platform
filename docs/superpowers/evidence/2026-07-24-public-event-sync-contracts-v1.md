# Public Event / Sync Contracts v1 Verification Evidence

- 日期：2026-07-24
- 分支：`feat/contracts-event-sync-v1`
- PR：#23 `feat(contracts): establish Event Sync protocol v1`
- 基线：`main` @ `58f2ccae76902b77790cecb05483a062259b7083`
- 设计：`docs/superpowers/specs/2026-07-24-public-event-sync-contracts-v1-design.md`
- 计划：`docs/superpowers/plans/2026-07-24-public-event-sync-contracts-v1.md`
- 实现审查 Head：`c267f369bd2a2f664fa7dbe4cf87aed75dbe83d6`

## 1. 阶段结论

本阶段将 Gateway 已运行的事件、显式补拉、累计 ACK 与 SSE 数据形状提升为所有终端可共同消费的版本化协议：

```text
Gateway internal DomainEvent
→ Public SyncEvent v1
→ GET /api/v1/sync/events
→ POST /api/v1/sync/ack
→ SSE domain-event
→ Web / iOS / HarmonyOS / DIY
```

公共协议独立版本：

```ts
SYNC_PROTOCOL_VERSION = 1
SYNC_SSE_EVENT_NAME = "domain-event"
```

## 2. 兼容模型

采用：

```text
严格 Known Event
+ 受控 Opaque Future Event
```

### Known Event

当前七种正式事件必须匹配固定的：

```text
eventType
aggregateType
aggregateRef
threadRef
Payload
跨字段不变量
```

正式类型：

```text
chat.home.created
work.created
thread.message.created
chat.work.created
work.progress.updated
thread.provider_turn.failed
thread.provider_turn.succeeded
```

错误的 Known Event 不能退化为 Opaque Event。测试使用错误的 `thread.message.created` Payload，同时确认：

```text
knownSyncEventSchema → fail
opaqueSyncEventSchema → fail
syncEventSchema → fail
```

### Opaque Future Event

未知未来事件只要满足严格 Envelope、合法 Event / Aggregate 标识和 JSON-only Payload，就可以被 v1 客户端接收、记录序号并安全忽略业务内容。

Opaque Payload 拒绝：

```text
undefined
NaN / Infinity
BigInt
Date
function
Symbol
循环引用
非 plain object
```

## 3. 公共协议表面

新增：

```text
packages/contracts/src/sync.ts
```

根入口导出：

```ts
export * from "./sync.js";
```

主要公共 Schema：

```text
knownSyncEventSchema
opaqueSyncEventSchema
syncEventSchema
syncSseDataSchema
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
```

并导出对应的 TypeScript 类型。

## 4. Canonical Fixtures

新增合成 Fixtures：

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

Fixtures 不包含真实用户数据、Host、Token、Credential、Authorization 或 Provider Session。

## 5. Known Event 不变量

### `chat.home.created`

```text
aggregateRef == payload.homeChatStreamRef
threadRef == payload.threadRef
```

### `work.created`

```text
aggregateRef == payload.workConversationRef
threadRef == payload.threadRef
```

### `thread.message.created`

```text
aggregateRef == payload.messageRef
threadRef == payload.threadRef
threadSequence > 0
clientMessageId 非空白且长度 8–128
```

### `chat.work.created`

```text
aggregateRef == payload.conversionRef
sourceMessageRefs 长度 1–100
sourceMessageRefs 唯一且保持顺序
```

### `work.progress.updated`

```text
aggregateRef == payload.workConversationRef
occurredAt == payload.updatedAt
```

### `thread.provider_turn.failed`

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
attemptCount > 0
error 只包含 code / category / retryable
```

### `thread.provider_turn.succeeded`

```text
aggregateRef == payload.userMessageRef
threadRef == payload.threadRef
assistantMessageRef != userMessageRef
```

## 6. SQLite 布尔值规范化

实际 Gateway 失败事件由 SQLite JSON Trigger 生成，内部读取时 `retryable` 表现为：

```text
0 / 1
```

公共协议要求：

```text
false / true
```

因此 Known Event Schema 只在公共 REST / SSE 边界接受内部 `0 | 1 | boolean`，并规范化为真正的布尔值：

```text
0 → false
1 → true
```

没有修改：

```text
domain_events
Event Trigger
Outbox
Device Sync Cursor
内部 DomainEvent 类型
```

七种实际 Gateway 事件集成测试确认，失败事件公开输出为 `retryable: true`。

## 7. GET 补拉协议

共享 Query Schema 输入：

```ts
{
  afterSequence?: string;
  limit?: string;
}
```

输出规范化为：

```ts
{
  afterSequence?: number;
  limit: number;
}
```

保持当前 Gateway 兼容：

```text
"0"   → 0
"001" → 1
"020" → 20
```

拒绝：

```text
负数
小数
指数形式
前后空白
超过 Number.MAX_SAFE_INTEGER
limit < 1
limit > 200
数组参数
未知参数
```

Response Schema 强制：

```text
acknowledgedSequence <= latestSequence
所有事件属于 sync.personRef
所有事件序号 > requestedAfterSequence
所有事件序号 <= latestSequence
事件严格升序
空页时 nextAfterSequence == null
非空 nextAfterSequence == 本页最后事件序号
```

## 8. 累计 ACK 协议

Request 只接受：

```text
protocolVersion
eventSequence
eventRef
```

严格拒绝客户端提交：

```text
deviceRef
personRef
entryBindingRef
entrySessionRef
acknowledgedSequence
updatedAt
其他未知字段
```

Response Schema 强制：

```text
acknowledgedSequence >= previousSequence
advanced == true  → acknowledgedSequence > previousSequence
advanced == false → acknowledgedSequence == previousSequence
```

## 9. Gateway REST 接入

`apps/gateway/src/deviceSyncRoutes.ts` 已删除本地重复定义：

```text
decimalSchema
本地 Query Schema
本地 ACK Schema
本地 Event Ref Schema
safeInteger()
```

改为使用：

```text
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
SYNC_PROTOCOL_VERSION
```

出站响应也通过公共 Schema。专门的失败测试让 Event Store 返回其他 Person 的事件；未接入共享 Response Schema 时路由返回 200，接入后在出站边界被拒绝。

## 10. Gateway SSE 接入

`formatDomainEventFrame()` 现在执行：

```text
internal DomainEvent
→ syncSseDataSchema.parse
→ JSON.stringify
→ SSE frame
```

业务帧固定：

```text
id: <eventSequence>
event: domain-event
data: <public SyncEvent>
```

测试确认：

```text
SSE id == data.eventSequence
SSE event == SYNC_SSE_EVENT_NAME
SSE data 通过 syncSseDataSchema
```

错误 Known Event 在写入 Socket 前被拒绝。

未修改：

```text
SSE Cursor
Last-Event-ID
心跳
Person Hub
轮询
队列
背压
关闭顺序
```

## 11. 旧 SSE 测试数据修正

公共 Schema 接入后，CI 暴露出旧测试夹具并不代表合法正式事件：

- `thread.message.created` 缺少 `threadRef`、`threadSequence`、`clientMessageId`；
- 205 条分页测试使用了超过 59 秒的非法 ISO 时间；
- `work.created` 缺少 `threadRef` 与 `status`；
- 大帧测试通过破坏 Known Payload 添加任意字段。

正确修复：

- 补齐 Known Event 必填字段；
- 使用真实可解析的 ISO 时间；
- 大帧测试改用合法 Opaque Future Event。

没有放宽公共 Schema，也没有削弱生产验证。

## 12. 七种实际 Gateway 事件

新增 `apps/gateway/test/syncKnownEvents.test.ts`，使用真实 Repository、Provider Turn、Chat→Work 和 Work Progress 流程生成全部七种事件：

```text
Home Chat 创建
→ Person 消息
→ Provider 失败
→ 同一消息重试成功
→ Assistant 消息
→ Provider 成功
→ Chat 转 Work
→ Work Progress 更新
```

验证：

```text
实际 eventType 集合 == KNOWN_SYNC_EVENT_TYPES
每条内部事件都能转成 KnownSyncEvent
同一事件的 REST DTO 与 SSE data 相同
失败事件公开 retryable 为 boolean
```

## 13. 隐私检查

Contracts Fixtures 和 Gateway 实际事件均扫描以下内容：

```text
Authorization
Entry Session Token
Device Credential
Provider External Session
Bearer Token
用户消息正文
Assistant 回复正文
```

扫描结果：未发现上述内容。

Known Payload 仅保留：

```text
引用
序号
状态
时间
错误分类
重试标记
```

## 14. Mobile Entry v1 冻结

本 PR 没有修改：

```text
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
```

全仓 CI 会继续运行既有 Mobile Entry fixture、严格验证和 Gateway Mobile 回归测试；实现审查 Head 全部通过。

## 15. TDD 与调试记录

| 阶段 | CI | 结果 | 证明内容 |
|---|---:|---|---|
| Spec 基线 | #344 | GREEN | PR #22 合并后的仓库基线正常 |
| Known / Opaque Schema 缺失 | #354 | RED | 公共事件导出尚不存在 |
| Known / Opaque 实现 | #356 | GREEN | 七种 Known、Opaque 和防降级通过 |
| 补拉与 ACK Schema 缺失 | #360 | RED | Query / Response / ACK 尚不存在 |
| 补拉与 ACK 实现 | #361 | GREEN | 规范化和跨字段不变量通过 |
| REST 出站未校验 | #362 | RED | 跨 Person 假事件被直接返回 |
| REST 共享 Schema | #363 | GREEN | 入站、出站均使用公共协议 |
| SSE 未校验 Known Event | #364 | RED | 错误 Known Event 仍被序列化 |
| 首次 SSE 接入 | #365 | RED | 旧测试夹具不满足正式协议 |
| SSE 测试夹具修正 | #367 | GREEN | 严格 Schema 与原 Hub 行为同时通过 |
| 七种实际事件兼容 | #368 | RED | SQLite `retryable` 为 0/1 |
| 公开布尔值规范化 | #369 | GREEN | 七种实际 REST / SSE 事件通过 |
| 隐私与规范化回归 | #370 | GREEN | Contracts / Gateway / 全仓门禁通过 |

## 16. 实现范围

生产代码：

```text
packages/contracts/src/sync.ts
packages/contracts/src/index.ts
apps/gateway/src/deviceSyncRoutes.ts
apps/gateway/src/eventStream.ts
```

测试与 Fixtures：

```text
packages/contracts/test/sync.test.ts
packages/contracts/fixtures/sync/**
apps/gateway/test/syncContracts.test.ts
apps/gateway/test/syncKnownEvents.test.ts
apps/gateway/test/eventStream.test.ts
apps/gateway/test/eventStreamResilience.test.ts
```

文档：

```text
docs/superpowers/specs/2026-07-24-public-event-sync-contracts-v1-design.md
docs/superpowers/plans/2026-07-24-public-event-sync-contracts-v1.md
docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md
```

## 17. PR #14 隔离

PR #23 没有修改：

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

PR #14 在实现审查时保持：

```text
Open
Draft
Mergeable
Head = e075f114e3f3fcdb728f6bff75797d415c4a5315
```

PR #23 与 PR #14 changed-path 集合交集为 0。

PR #14 当前 Head 原有检查仍成功：

```text
Repository CI #225
Secret Scan #111
iOS CI #16
```

本 PR 没有向 PR #14 分支写入、重基、关闭、合并或转换状态。

## 18. 实现审查门禁

实现审查 Head：

```text
c267f369bd2a2f664fa7dbe4cf87aed75dbe83d6
```

结果：

```text
Repository CI #370  success
Secret Scan #256    success
PR #23 mergeable    true
PR comments          none
Review Threads       none
PR #14 path overlap  0
```

本证据文件提交后，仍需对新的文档 Head 运行完整 Repository CI 与 Secret Scan；最终 Head 和最终检查编号记录在 PR 正文，避免证据文件形成自引用提交循环。

## 19. 延后范围

后续独立 PR：

```text
正式 Member Web 壳与 Personal Entry
Chat 页面与消息查询
Work 列表与详情
IndexedDB + Device Sync Cursor + SSE 闭环
Push Notification
iOS Chat / Work 与 Sync 接入
```
