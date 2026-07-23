# Gateway Chat / Work Outbox Events 设计

- 日期：2026-07-23
- 状态：已批准
- 目标分支：`feat/gateway-chat-work-outbox-events`
- 基线：`main` @ `97adaa08bb0b015e7a9b8ade3a43e55aab282238`
- 前置：PR #15、#16、#17、#18 已合并

## 1. 目标

为正式 Chat / Work 领域增加可靠的持久化事件日志和 Transactional Outbox，使后续 SSE、设备同步游标和断线补拉可以基于同一份权威事件源建设。

本阶段只建设持久化与调度底座：

```text
领域写操作
→ 同一 SQLite 事务分配 Person Event Sequence
→ 写入 domain_events
→ 写入 outbox_events
→ 事务提交
```

本阶段不向客户端公开事件，不增加 SSE 路由，也不修改 Chat / Work 公共 Contracts。

## 2. 与 PR #14 的隔离边界

本 PR 从合并 PR #18 后的最新 `main` 独立创建，不叠加在 iOS 分支上。

允许修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/database.ts
apps/gateway/src/domainEvents.ts
apps/gateway/src/chatWorkDomain.ts
apps/gateway/src/chatWorkProvider.ts
apps/gateway/test/database.test.ts
apps/gateway/test/domainEvents.test.ts
apps/gateway/test/chatWorkEvents.test.ts
docs/superpowers/specs/2026-07-23-gateway-chat-work-outbox-events-design.md
docs/superpowers/plans/2026-07-23-gateway-chat-work-outbox-events.md
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

## 3. 本阶段范围

### 包含

- SQLite Migration V6；
- 每个 Person 独立、严格递增的领域事件序列；
- 持久化 `domain_events`；
- 与领域事件一一对应的 `outbox_events`；
- Outbox claim lease、发布成功、失败退回和过期 claim 回收；
- Person 事件分页读取，为后续 Sync Cursor 提供内部能力；
- Chat、Work、消息、转换、进度和 Provider Turn 的关键事件；
- 所有事件与对应领域写入原子提交；
- 重启恢复、Person 隔离、事件幂等与 Outbox 状态测试。

### 不包含

- SSE、WebSocket、Push；
- 面向客户端的 Event Contracts；
- Device Sync Cursor；
- HTTP 事件查询接口；
- Outbox 后台常驻 Worker；
- HTTP 202 / Operation 生命周期；
- Member Web；
- iOS Chat / Work 接入；
- 浏览器一键验收台修改。

## 4. 方案选择

### 方案 A：应用层 Transactional Outbox（采用）

所有领域 Repository 在自己的 SQLite 事务中调用统一 `DomainEventStore`。该方案能够写入明确的聚合引用、线程引用、Person 序列和安全的结构化 payload，且后续可直接接入 SSE/同步服务。

### 方案 B：SQLite Trigger 自动产生日志（不采用）

原子性天然可靠，但触发器难以表达完整业务语义、事件类型和安全 payload，也难以测试 Assignment、转换和 Provider Turn 等跨表事务。

### 方案 C：写操作完成后再异步补事件（不采用）

实现简单，但进程崩溃时可能出现领域数据已提交而事件缺失，无法作为可靠同步源。

## 5. 数据模型：Migration V6

### 5.1 `person_event_sequences`

```text
person_ref       PK / FK persons
last_sequence    >= 0
updated_at
```

每次写事件时，在事务内执行原子递增并取得新的 `event_sequence`。不同 Person 的序列相互独立。

### 5.2 `domain_events`

```text
event_ref        PK，event:...
person_ref       事件所有者
event_sequence   Person 内严格递增
event_type       稳定的内部事件名
aggregate_type   home_chat | work | thread_message | chat_work_conversion | work_progress | provider_turn
aggregate_ref    聚合对象引用
thread_ref       可为空；与 Chat / Work Thread 相关时必须填写
payload_json     结构化安全 payload
occurred_at      业务发生时间
created_at       Gateway 持久化时间
```

约束：

- `(person_ref, event_sequence)` 唯一；
- `payload_json` 不保存 Token、Credential、Provider External Session 或完整消息正文；
- 事件只保存客户端重建状态所需的引用和元数据；
- 返回顺序始终按 `event_sequence ASC`。

### 5.3 `outbox_events`

```text
event_ref        PK / FK domain_events
status           pending | claimed | published
attempt_count    >= 0
available_at     可再次派发时间
claimed_by       claimed 时必填
claimed_until    claimed 时必填
published_at     published 时必填
last_error_json  最近一次失败的公开错误，可为空
updated_at
```

状态约束：

- `pending`：没有 claim 字段和 published 时间；
- `claimed`：必须有 `claimed_by`、`claimed_until`；
- `published`：必须有 `published_at`，没有 claim 字段；
- claim 时增加 `attempt_count`；
- claim 过期后可由下一个 worker 原子回收；
- mark failed 会回到 `pending`，保留 attempts，并设置新的 `available_at`。

## 6. `DomainEventStore` 组件边界

新文件：`apps/gateway/src/domainEvents.ts`。

提供：

```ts
append(input): DomainEvent
listPersonEvents(input): DomainEventPage
claimOutboxBatch(input): OutboxDelivery[]
markPublished(input): void
markFailed(input): void
```

`append()` 负责：

1. 验证 Person 存在；
2. 原子递增 Person 事件序列；
3. 写入 `domain_events`；
4. 写入对应 `outbox_events`；
5. 返回已持久化事件。

`claimOutboxBatch()` 负责：

1. 在短事务内回收 `claimed_until <= now` 的过期 claim；
2. 按 `available_at`、Person 和 sequence 选择 pending 事件；
3. 写入 worker lease 并增加 attempt；
4. 返回事件和投递状态。

本阶段不包含实际网络发布器。

## 7. 内部事件类型

### `chat.home.created`

```json
{
  "homeChatStreamRef": "home-chat:...",
  "dailyEpisodeRef": "daily-episode:...",
  "threadRef": "thread:..."
}
```

### `work.created`

```json
{
  "workConversationRef": "work:...",
  "threadRef": "thread:...",
  "status": "active"
}
```

### `thread.message.created`

```json
{
  "messageRef": "message:...",
  "threadRef": "thread:...",
  "threadSequence": 1,
  "actorType": "person",
  "clientMessageId": "..."
}
```

不包含正文。Person 和 Assistant 消息都产生此事件。

### `chat.work.created`

```json
{
  "conversionRef": "chat-work-conversion:...",
  "homeChatStreamRef": "home-chat:...",
  "workConversationRef": "work:...",
  "sourceMessageRefs": ["message:..."]
}
```

### `work.progress.updated`

```json
{
  "workConversationRef": "work:...",
  "status": "active",
  "updatedAt": "2026-07-23T00:00:00.000Z"
}
```

### `thread.provider_turn.failed`

```json
{
  "userMessageRef": "message:...",
  "threadRef": "thread:...",
  "attemptCount": 1,
  "error": {
    "code": "PROVIDER_UNAVAILABLE",
    "category": "availability",
    "retryable": true
  }
}
```

不保存错误详情中的敏感内部数据，仅保存公开错误元数据。

### `thread.provider_turn.succeeded`

```json
{
  "userMessageRef": "message:...",
  "assistantMessageRef": "message:...",
  "threadRef": "thread:...",
  "attemptCount": 1
}
```

Assistant 消息成功提交时，同一事务还会产生 `thread.message.created`。

## 8. 原子性与幂等规则

- Home Chat 创建和 `chat.home.created` 同一事务；
- Work 创建和 `work.created` 同一事务；
- Person 消息和 `thread.message.created` 同一事务；
- Chat → Work 会产生 `work.created` 与 `chat.work.created`，二者和转换事务一起提交；
- Work Progress 和 `work.progress.updated` 同一事务；
- Assistant 消息、Provider Turn succeeded、External Session、`thread.message.created` 和 `thread.provider_turn.succeeded` 同一事务；
- Provider 失败状态和 `thread.provider_turn.failed` 同一事务；
- 幂等消息重放不产生第二个 `thread.message.created`；
- 已成功 Provider Turn 重放不产生第二条 Assistant 消息或事件；
- 任何领域事务回滚时，对应 event 和 outbox row 同时回滚。

## 9. Repository 接入方式

`ChatWorkDomainRepository` 与 `ChatWorkProviderRepository` 构造函数新增可选 `DomainEventStore`。未显式注入时，使用同一数据库和时钟创建默认实例，以保持现有测试和调用兼容。

`buildGatewayApp()` 创建一个共享 `DomainEventStore` 并注入两个 Repository，为后续 SSE / Sync 服务复用同一事件存储实例做好准备。

## 10. 安全边界

- 不记录 Bearer Token、Device Credential、Entry Session Token；
- 不记录 Provider External Session；
- 不记录消息完整正文；
- `listPersonEvents()` 必须显式传 Person，不能跨 Person 返回；
- Outbox worker 只能通过 claim lease 修改已领取的 row；
- 发布失败保存的是受限公开错误结构，不保存原始异常堆栈。

## 11. 测试与验收

自动测试至少覆盖：

1. Migration V6 只执行一次且外键完整；
2. Person 事件序列独立且严格递增；
3. append 同时写 domain event 和 pending outbox；
4. 事件分页按 sequence 升序且 Person 隔离；
5. claim 增加 attempt 并建立 lease；
6. 过期 claim 可回收；
7. mark published 与 mark failed 状态约束；
8. Home Chat / Work / Person Message / Assistant Message 产生正确事件；
9. Chat → Work 同时产生 Work 和转换事件；
10. Work Progress 产生事件；
11. Provider failure/success 产生对应事件；
12. 成功消息重试不重复产生消息或事件；
13. 无效转换或失败成功提交回滚时不留下事件；
14. Gateway 重启后事件和 Outbox 状态可恢复；
15. 所有现有 Gateway、Mobile Entry 和 Contracts 测试不回归；
16. PR #14 与本 PR 文件路径交集为零。

验收命令：

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

## 12. 后续顺序

本 PR 合并后，下一条独立 PR 再建设：

```text
SSE 订阅与心跳
→ Device Sync Cursor / 断线补拉
→ 正式 Member Web
```

在 PR #14 真机验收完成前，后续 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
