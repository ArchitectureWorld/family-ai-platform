# Public Event / Sync Contracts v1 Verification Evidence

- 日期：2026-07-24
- 分支：`feat/contracts-event-sync-v1`
- PR：#23 `feat(contracts): establish Event Sync protocol v1`
- 基线：`main` @ `58f2ccae76902b77790cecb05483a062259b7083`
- 设计：`docs/superpowers/specs/2026-07-24-public-event-sync-contracts-v1-design.md`
- 计划：`docs/superpowers/plans/2026-07-24-public-event-sync-contracts-v1.md`
- 最终生产代码审查 Head：`6827aaede66256a155d412545dc55771f11ac47a`

## 1. 阶段结论

本阶段将 Gateway 已运行的事件、显式补拉、累计 ACK 与 SSE 数据提升为所有终端共同消费的版本化协议：

```text
Gateway internal DomainEvent
→ Public SyncEvent v1
→ GET /api/v1/sync/events
→ POST /api/v1/sync/ack
→ SSE domain-event
→ Web / iOS / HarmonyOS / DIY
```

公共常量：

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

当前 Known Event：

```text
chat.home.created
work.created
thread.message.created
chat.work.created
work.progress.updated
thread.provider_turn.failed
thread.provider_turn.succeeded
```

Known Event 必须匹配固定 `eventType`、`aggregateType`、Payload 和跨字段不变量。错误 Known Event 同时被 Known、Opaque 和组合 Schema 拒绝，不能降级绕过。

未来未知事件可以作为 JSON-only Opaque Event 接收；旧客户端能够记录序号、忽略未知业务内容并继续同步。

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
packages/contracts/fixtures/sync/**
packages/contracts/test/sync.test.ts
```

根入口新增：

```ts
export * from "./sync.js";
```

主要 Schema：

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

## 4. Known Event 不变量

```text
chat.home.created
  aggregateRef == payload.homeChatStreamRef
  threadRef == payload.threadRef

work.created
  aggregateRef == payload.workConversationRef
  threadRef == payload.threadRef

thread.message.created
  aggregateRef == payload.messageRef
  threadRef == payload.threadRef
  threadSequence > 0
  clientMessageId 长度 8–128 且无空白

chat.work.created
  aggregateRef == payload.conversionRef
  sourceMessageRefs 长度 1–100 且唯一

work.progress.updated
  aggregateRef == payload.workConversationRef
  occurredAt == payload.updatedAt

thread.provider_turn.failed
  aggregateRef == payload.userMessageRef
  threadRef == payload.threadRef
  attemptCount > 0
  error 只含 code / category / retryable

thread.provider_turn.succeeded
  aggregateRef == payload.userMessageRef
  threadRef == payload.threadRef
  assistantMessageRef != userMessageRef
```

## 5. SQLite 布尔值公开规范化

SQLite JSON Trigger 生成的失败事件在内部读取时，`retryable` 为：

```text
0 / 1
```

公共协议输出要求：

```text
false / true
```

公共 Schema 在 REST / SSE 边界接受内部 `0 | 1 | boolean`，并规范化：

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

实际七种事件测试确认公开失败事件为 `retryable: true`。

## 6. GET 补拉协议

共享 Query Schema 输入：

```ts
{
  afterSequence?: string;
  limit?: string;
}
```

规范化输出：

```ts
{
  afterSequence?: number;
  limit: number;
}
```

保持现有兼容：

```text
"0"   → 0
"001" → 1
"020" → 20
```

拒绝负数、小数、指数形式、空白、超出安全整数、非法 limit、数组和未知参数。

Response 强制：

```text
acknowledgedSequence <= latestSequence
所有事件属于 sync.personRef
所有事件序号 > requestedAfterSequence
所有事件序号 <= latestSequence
事件严格升序
空页 nextAfterSequence == null
非空 nextAfterSequence == 本页最后事件序号
```

### 读页并发修复

完成前审查发现：原路由先读取 Cursor 状态中的 `latestSequence`，再查询事件页；若期间新增事件，本页可能包含大于旧 `latestSequence` 的事件，导致公共 Response Schema 产生瞬时 500。

失败测试 CI #372 复现：

```text
readCursor.latestSequence = 1
listPersonEvents returns sequence 2
getLatestPersonSequence = 2
```

修复后路由在读页完成后重新读取 Person 最新序号，再组装响应。CI #374 通过。

## 7. 累计 ACK 协议

Request 只接受：

```text
protocolVersion
eventSequence
eventRef
```

严格拒绝可信身份和服务端状态字段：

```text
deviceRef
personRef
entryBindingRef
entrySessionRef
acknowledgedSequence
updatedAt
其他未知字段
```

Response 强制：

```text
acknowledgedSequence >= previousSequence
advanced == true  → acknowledgedSequence > previousSequence
advanced == false → acknowledgedSequence == previousSequence
```

## 8. Gateway REST 接入

`apps/gateway/src/deviceSyncRoutes.ts` 已删除本地重复 Query / ACK Schema 和数字解析器，改用公共 Contracts。

入站与出站均校验：

```text
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
```

专门的 RED 测试让 Event Store 返回其他 Person 的事件：未接公共 Response Schema 时返回 200；接入后被出站边界拒绝。

## 9. Gateway SSE 接入

`formatDomainEventFrame()`：

```text
internal DomainEvent
→ syncSseDataSchema.parse
→ JSON.stringify
→ SSE frame
```

业务帧：

```text
id: <eventSequence>
event: domain-event
data: <public SyncEvent>
```

验证：

```text
SSE id == data.eventSequence
SSE event == SYNC_SSE_EVENT_NAME
SSE data 通过 syncSseDataSchema
```

### 校验失败时的 Cursor 修复

完成前审查发现：Hub 原先先推进 `scheduledCursor`，再格式化事件。若严格 Schema 拒绝坏事件，下一轮轮询会从已推进的位置开始，导致该事件被跳过。

失败测试 CI #372 复现：

```text
第一次轮询 afterSequence = 0
坏 Known Event 校验失败
替换为同序号合法事件
第二次轮询错误地从已推进 Cursor 开始
```

修复后：

```text
先格式化并完成公共 Schema 校验
→ 再入队
→ 入队成功且连接仍有效后推进 scheduledCursor
```

测试确认两次查询均从 `afterSequence = 0` 开始，合法同序号事件最终送达。CI #374 通过。

未改变正常 SSE Cursor、Last-Event-ID、心跳、Person Hub、轮询、背压与关闭语义。

## 10. 旧 SSE 测试夹具修正

严格公共协议接入后，旧合成测试数据暴露以下问题：

- `thread.message.created` 缺少 `threadRef`、`threadSequence`、`clientMessageId`；
- 205 条分页事件使用非法秒数构造时间戳；
- `work.created` 缺少 `threadRef` 和 `status`；
- 大帧测试通过破坏 Known Payload 添加任意字段。

修复仅针对测试数据：

- 补齐 Known Event；
- 使用合法 ISO 时间；
- 大帧测试改用合法 Opaque Event。

没有放宽公共 Schema。

## 11. 七种实际 Gateway 事件

`apps/gateway/test/syncKnownEvents.test.ts` 使用真实 Repository、Provider Turn、Chat→Work 和 Work Progress 流程生成全部七种事件：

```text
Home Chat
→ Person 消息
→ Provider 失败
→ 同一消息重试成功
→ Assistant 消息
→ Provider 成功
→ Chat 转 Work
→ Work Progress
```

验证：

```text
实际 eventType 集合 == KNOWN_SYNC_EVENT_TYPES
每条内部事件转成 KnownSyncEvent
同一事件 REST DTO == SSE data
失败事件公开 retryable 为 boolean
```

## 12. 隐私与 Mobile Entry 回归

Contracts Fixtures 和实际 Gateway 事件扫描：

```text
Authorization
Entry Session Token
Device Credential
Provider External Session
Bearer Token
用户正文
Assistant 回复正文
```

未发现上述内容。

本 PR 未修改：

```text
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
```

全仓门禁继续运行 Mobile Entry Fixtures、严格验证、Gateway Mobile 和 Chat / Work 回归测试。

## 13. TDD 与调试记录

| 阶段 | CI | 结果 | 证明内容 |
|---|---:|---|---|
| Spec 基线 | #344 | GREEN | PR #22 后仓库基线正常 |
| Known / Opaque 缺失 | #354 | RED | 公共事件导出不存在 |
| Known / Opaque 实现 | #356 | GREEN | 七种 Known、Opaque、防降级通过 |
| 补拉 / ACK 缺失 | #360 | RED | Query、Response、ACK 不存在 |
| 补拉 / ACK 实现 | #361 | GREEN | 规范化和不变量通过 |
| REST 出站未校验 | #362 | RED | 跨 Person 假事件被返回 |
| REST 公共 Schema | #363 | GREEN | 入站、出站共享协议 |
| SSE 未校验 | #364 | RED | 错误 Known Event 被序列化 |
| 首次 SSE 接入 | #365 | RED | 旧测试夹具不合法 |
| SSE 夹具修正 | #367 | GREEN | 严格 Schema 与 Hub 回归通过 |
| 七种实际事件 | #368 | RED | SQLite retryable 为 0/1 |
| 公开布尔规范化 | #369 | GREEN | 七种 REST / SSE 事件通过 |
| 隐私与合同回归 | #370 | GREEN | 全仓门禁通过 |
| 并发 / Cursor 审查 | #372 | RED | latestSequence 竞态与 SSE 先推进 Cursor |
| 并发 / Cursor 修复 | #374 | GREEN | 两项恢复边界均通过 |

## 14. 变更范围

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

## 15. PR #14 隔离

本 PR 没有修改：

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

审查时 PR #14：

```text
Open
Draft
Mergeable
Head = e075f114e3f3fcdb728f6bff75797d415c4a5315
```

PR #23 与 PR #14 changed-path 交集为 0。

PR #14 Head 原有检查仍成功：

```text
Repository CI #225
Secret Scan #111
iOS CI #16
```

## 16. 生产代码审查门禁

Head：

```text
6827aaede66256a155d412545dc55771f11ac47a
```

结果：

```text
Repository CI #374  success
Secret Scan #260    success
```

该证据文件提交后仍需对新文档 Head 执行一次完整 Repository CI 与 Secret Scan。最终 Head 和最终检查编号记录在 PR 正文，避免文档自引用循环。

## 17. 延后范围

```text
正式 Member Web 壳与 Personal Entry
Chat 页面与消息查询
Work 列表与详情
IndexedDB + Device Sync Cursor + SSE 闭环
Push Notification
iOS Chat / Work 与 Sync 接入
```
