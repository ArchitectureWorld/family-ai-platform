# Gateway Chat / Work Outbox Events 设计

- 日期：2026-07-23
- 状态：已实现
- 目标分支：`feat/gateway-chat-work-outbox-events`
- 基线：`main` @ `97adaa08bb0b015e7a9b8ade3a43e55aab282238`
- 前置：PR #15、#16、#17、#18 已合并

## 1. 目标

为正式 Chat / Work 领域增加可靠的持久化事件日志和 Transactional Outbox，使后续 SSE、设备同步游标和断线补拉可以基于同一份权威事件源建设。

本阶段完成：

```text
领域写操作
→ SQLite 同一事务触发事件捕获
→ 分配 Person Event Sequence
→ 写入 domain_events
→ 写入 outbox_events
→ 领域事务统一提交或回滚
```

本阶段不向客户端公开事件，不增加 SSE 路由，也不修改 Chat / Work 公共 Contracts。

## 2. 与 PR #14 的隔离边界

本 PR 从合并 PR #18 后的最新 `main` 独立创建，不叠加在 iOS 分支上。

修改范围：

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEvents.ts
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

## 3. 最终方案

### 3.1 独立事件 schema ledger

Gateway 核心数据库当前保持 schema version 5。事件子系统使用独立 ledger：

```text
domain_event_schema_migrations
version = 1
```

原因：

- 事件模块可以独立安装和升级；
- 不改变现有 `database.ts` 的核心迁移边界；
- Gateway 启动时会立即创建 `DomainEventStore`，因此正式运行路径始终安装事件 schema；
- 安装操作幂等，Gateway 重启不会重复执行或覆盖状态。

这不是临时建表脚本，而是带独立版本记录的模块化 schema migration。

### 3.2 SQLite 事务触发器

最终采用 SQLite Trigger 捕获正式领域写入，而不是在每个 Repository 手工调用事件函数。

采用原因：

- 事件和领域数据天然处于同一事务；
- Repository 新增或调整内部实现时不容易漏发事件；
- Chat → Work、Assistant 成功提交等跨表事务回滚时，事件和 Outbox 自动回滚；
- 不需要修改已稳定的 Chat / Work 和 Provider Repository。

`DomainEventStore.append()` 仍保留，用于未来非表触发型系统事件。

## 4. 数据模型

### 4.1 `person_event_sequences`

```text
person_ref       PK / FK persons
last_sequence    >= 0
updated_at
```

每个 Person 拥有独立、严格递增的事件序列。不同家庭成员互不共享 cursor。

### 4.2 `domain_events`

```text
event_ref        PK，event:...
person_ref       事件所有者
event_sequence   Person 内严格递增
event_type       稳定内部事件名
aggregate_type   聚合类别
aggregate_ref    聚合引用
thread_ref       可为空
payload_json     安全结构化元数据
occurred_at      业务发生时间
created_at       Gateway 持久化时间
```

约束：

- `(person_ref, event_sequence)` 唯一；
- 事件按 `event_sequence ASC` 读取；
- payload 不保存消息正文；
- payload 不保存 Token、Credential、Authorization 或 Provider External Session；
- 事件只提供引用和客户端判断状态变化所需的最小元数据。

### 4.3 `outbox_events`

```text
event_ref        PK / FK domain_events
status           pending | claimed | published
attempt_count    >= 0
available_at
claimed_by
claimed_until
published_at
last_error_json
updated_at
```

状态约束：

- `pending` 没有 claim 和 published 字段；
- `claimed` 必须有 worker 和 lease 截止时间；
- `published` 必须有 published 时间并清除 claim；
- 每次 claim 增加 attempt；
- claim 过期后可以被其他 worker 回收；
- 投递失败回到 pending，并设置下一次 `available_at`。

## 5. `DomainEventStore`

文件：`apps/gateway/src/domainEvents.ts`。

提供：

```ts
append(input): DomainEvent
listPersonEvents(input): DomainEventPage
claimOutboxBatch(input): OutboxDelivery[]
markPublished(input): void
markFailed(input): void
```

### `append()`

用于未来显式系统事件：

1. 验证 Person；
2. 可选验证 Thread 属于 Person；
3. 原子分配 sequence；
4. 写 domain event；
5. 写 pending outbox；
6. 同一事务返回事件。

### `listPersonEvents()`

- 显式要求 `personRef`；
- 使用 `afterSequence`；
- 返回升序事件；
- 单页最多 200 条；
- 不跨 Person 返回。

### `claimOutboxBatch()`

在一个短事务内：

1. 回收过期 claim；
2. 选择到期的 pending 事件；
3. 按 `available_at + person + sequence` 排序；
4. 写 worker lease；
5. 增加 attempt；
6. 返回领域事件和投递信息。

本阶段不包含实际网络发布 Worker。

## 6. 自动事件类型

### `chat.home.created`

由首个 `DailyEpisode` 插入触发：

```json
{
  "homeChatStreamRef": "home-chat:...",
  "dailyEpisodeRef": "daily-episode:...",
  "threadRef": "thread:..."
}
```

### `work.created`

由 `WorkConversation` 插入触发：

```json
{
  "workConversationRef": "work:...",
  "threadRef": "thread:...",
  "status": "active"
}
```

### `thread.message.created`

Person 和 Assistant 消息都会触发：

```json
{
  "messageRef": "message:...",
  "threadRef": "thread:...",
  "threadSequence": 1,
  "actorType": "person",
  "clientMessageId": "..."
}
```

不包含正文。

### `chat.work.created`

由转换记录插入触发：

```json
{
  "conversionRef": "chat-work-conversion:...",
  "homeChatStreamRef": "home-chat:...",
  "workConversationRef": "work:...",
  "sourceMessageRefs": []
}
```

第一版事件只承担“转换发生”通知。来源消息的权威有序引用仍在 `chat_work_conversion_messages`，后续 SSE 消费者根据 conversion ref 查询完整状态，避免在触发器中复制领域数据。

### `work.progress.updated`

Work Progress 首次写入或更新时触发：

```json
{
  "workConversationRef": "work:...",
  "status": "active",
  "updatedAt": "2026-07-23T00:00:00.000Z"
}
```

### `thread.provider_turn.failed`

Provider Turn 进入 failed 时触发：

```json
{
  "userMessageRef": "message:...",
  "threadRef": "thread:...",
  "attemptCount": 1,
  "error": {
    "code": "PROVIDER_UNAVAILABLE",
    "category": "availability",
    "retryable": 1
  }
}
```

SQLite JSON 使用 `0/1` 表示布尔值；后续公共 Event Contract 可在边界层标准化为 boolean。

### `thread.provider_turn.succeeded`

Provider Turn 成功时触发：

```json
{
  "userMessageRef": "message:...",
  "assistantMessageRef": "message:...",
  "threadRef": "thread:...",
  "attemptCount": 1
}
```

同一事务中，Assistant 插入会先产生 `thread.message.created`。

## 7. 原子性和幂等

- Home Chat 与 `chat.home.created` 同事务；
- Work 与 `work.created` 同事务；
- Person / Assistant 消息与 `thread.message.created` 同事务；
- Chat → Work 产生 `work.created` 和 `chat.work.created`，全部随转换事务提交；
- Work Progress 与 `work.progress.updated` 同事务；
- Provider failed 状态与失败事件同事务；
- Assistant、External Session、Turn succeeded、消息事件和成功事件同事务；
- 相同 Person 消息重放不会再次 INSERT，因此不会重复事件；
- 已成功 Turn 重放不会再次 INSERT Assistant 或 UPDATE 为 succeeded，因此不会重复事件；
- 领域事务回滚时触发器写入的事件与 Outbox 自动回滚。

## 8. Gateway 启动顺序

`buildGatewayApp()` 在打开核心数据库并确定时钟后立即创建：

```ts
new DomainEventStore(db, now)
```

然后才执行 Development Bootstrap 和构造各领域 Repository。事件表和触发器在任何正式 Chat / Work 写入前已经就绪。

## 9. 测试与验收

自动测试覆盖：

1. 事件 schema ledger 幂等安装；
2. 表、索引和外键完整；
3. Person 序列独立递增；
4. 事件 + pending Outbox 原子写入；
5. 事件分页与 Person 隔离；
6. claim、attempt、lease、publish、failed 回退；
7. 过期 lease 回收；
8. Gateway 重启恢复；
9. Home Chat、Work、消息、转换、进度事件；
10. Assistant 与 Provider success/failure 事件；
11. 消息和 Turn 幂等不重复发事件；
12. 无效 Chat → Work 不留下部分领域数据或事件；
13. payload 不包含消息正文和 External Session；
14. 所有现有 Gateway / Mobile Entry / Contracts 测试不回归；
15. PR #14 文件路径交集为零。

验收命令：

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

## 10. 后续顺序

本 PR 合并后：

```text
SSE 订阅与心跳
→ Device Sync Cursor / 断线补拉
→ 正式 Member Web
```

在 PR #14 真机验收完成前，后续 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
