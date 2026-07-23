# Gateway Chat / Work Outbox Events 设计

- 日期：2026-07-23
- 状态：已实现
- 目标分支：`feat/gateway-chat-work-outbox-events`
- 基线：`main` @ `97adaa08bb0b015e7a9b8ade3a43e55aab282238`
- 前置：PR #15、#16、#17、#18 已合并

## 1. 目标

为正式 Chat / Work 领域增加可靠的持久化事件日志和 Transactional Outbox，使后续 SSE、设备同步游标和断线补拉可以基于同一份权威事件源建设。

最终闭环：

```text
领域写操作
→ SQLite 同一事务捕获事件
→ 分配 Person Event Sequence
→ 写入 domain_events
→ 写入 outbox_events
→ 领域事务统一提交或回滚
```

本阶段不向客户端公开事件，不增加 SSE 路由，也不修改公共 Contracts。

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
docs/superpowers/evidence/2026-07-23-gateway-chat-work-outbox-events.md
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

## 3. 最终架构

### 3.1 独立事件 Schema Ledger

Gateway 核心数据库保持 schema version 5。事件子系统使用独立模块版本：

```text
domain_event_schema_migrations
version = 1
```

这样事件模块可以独立安装和升级，不改变已经稳定的核心迁移边界。Gateway 启动时立即创建 `DomainEventStore`，因此正式运行路径在任何 Chat / Work 写入之前完成事件 schema 和触发器安装。

### 3.2 SQLite Transaction Trigger

正式领域事件由 SQLite Trigger 捕获，而不是在每个 Repository 中手工调用。

采用原因：

- 事件和领域数据天然处于同一事务；
- Repository 内部实现变化时不容易漏发事件；
- Chat → Work、Assistant 成功提交等跨表事务回滚时，事件和 Outbox 自动回滚；
- 不需要侵入已稳定的 Chat / Work 和 Provider Repository。

`DomainEventStore.append()` 仍保留，用于未来不对应表变化的显式系统事件。

## 4. 数据模型

### 4.1 `person_event_sequences`

```text
person_ref       PK / FK persons
last_sequence    >= 0
updated_at
```

每个 Person 拥有独立、严格递增的事件序列。不同成员不共享同步 Cursor。

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
- Payload 不保存消息正文；
- Payload 不保存 Token、Credential、Authorization 或 Provider External Session；
- 事件只包含客户端重建变化所需的引用和最小元数据。

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

状态规则：

- `pending` 没有 Claim 和 Published 字段；
- `claimed` 必须有 Worker 与 Lease 截止时间；
- `published` 必须有发布时间并清除 Claim；
- 每次 Claim 增加 Attempt；
- 过期 Claim 可被其他 Worker 回收；
- 只有持有匹配且**尚未过期** Lease 的 Worker 才能执行 `markPublished()` 或 `markFailed()`；
- 投递失败回到 Pending，并设置新的 `available_at`。

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
3. 原子分配 Sequence；
4. 写 Domain Event；
5. 写 Pending Outbox；
6. 同一事务返回事件。

### `listPersonEvents()`

- 显式要求 `personRef`；
- 使用独占式 `afterSequence`；
- 按 Sequence 升序返回；
- 单页最多 200 条；
- 不跨 Person 返回。

### `claimOutboxBatch()`

在一个短事务内：

1. 回收过期 Claim；
2. 选择到期的 Pending 事件；
3. 按 `available_at + Person + Sequence` 排序；
4. 写 Worker Lease；
5. 增加 Attempt；
6. 返回事件和投递信息。

本阶段不包含实际网络发布 Worker。

## 6. 自动事件类型

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

Person 和 Assistant 消息都会产生：

```json
{
  "messageRef": "message:...",
  "threadRef": "thread:...",
  "threadSequence": 1,
  "actorType": "person",
  "clientMessageId": "..."
}
```

不包含消息正文。

### `chat.work.created`

```json
{
  "conversionRef": "chat-work-conversion:...",
  "homeChatStreamRef": "home-chat:...",
  "workConversationRef": "work:...",
  "sourceMessageRefs": ["message:..."]
}
```

实现分两步、但仍处于同一个 Chat → Work 事务：

1. 插入 Conversion 时创建事件和空数组；
2. 每插入一条有序 `chat_work_conversion_messages` 引用，第二个触发器按插入顺序追加到事件数组。

因此其他终端收到事件后可以完整还原哪些 Chat 消息被转成 Work，同时不会复制消息正文。

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
    "retryable": 1
  }
}
```

SQLite JSON 使用 `0/1` 表示布尔值；后续公共 Event Contract 可在边界层标准化为 Boolean。

### `thread.provider_turn.succeeded`

```json
{
  "userMessageRef": "message:...",
  "assistantMessageRef": "message:...",
  "threadRef": "thread:...",
  "attemptCount": 1
}
```

同一事务中，Assistant 插入会先产生 `thread.message.created`。

## 7. 原子性与幂等

- Home Chat 与 `chat.home.created` 同事务；
- Work 与 `work.created` 同事务；
- Person / Assistant 消息与 `thread.message.created` 同事务；
- Chat → Work 的 Work、Conversion、来源引用和两个事件全部同事务；
- Work Progress 与 `work.progress.updated` 同事务；
- Provider Failed 状态与失败事件同事务；
- Assistant、External Session、Turn Succeeded、消息事件和成功事件同事务；
- 相同 Person 消息重放不会再次 Insert，因此不重复事件；
- 已成功 Turn 重放不会再次 Insert Assistant 或更新为 Succeeded，因此不重复事件；
- 任一领域事务回滚时，触发器写入的 Event 与 Outbox 自动回滚。

## 8. Gateway 启动顺序

`buildGatewayApp()` 打开核心数据库并确定时钟后立即执行：

```ts
new DomainEventStore(db, now)
```

之后才进行 Development Bootstrap 和领域 Repository 构造。事件表与触发器在正式 Chat / Work 写入前已经就绪。

## 9. 测试与验收

自动测试覆盖：

1. 事件 Schema Ledger 幂等安装；
2. 表、索引和外键完整；
3. Person Sequence 独立递增；
4. Event + Pending Outbox 原子写入；
5. 事件分页与 Person 隔离；
6. Claim、Attempt、Lease、Publish、Failed 回退；
7. 过期 Lease 回收和过期 Worker 禁止完成状态；
8. Gateway 重启恢复；
9. Home Chat、Work、消息、转换、进度事件；
10. Chat → Work 有序来源消息引用；
11. Assistant 与 Provider Success / Failure 事件；
12. 消息和 Turn 幂等不重复发事件；
13. 无效 Chat → Work 不留下部分领域数据或事件；
14. Payload 不包含消息正文和 External Session；
15. 所有现有 Gateway、Mobile Entry 和 Contracts 测试不回归；
16. PR #14 文件路径交集为零。

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
