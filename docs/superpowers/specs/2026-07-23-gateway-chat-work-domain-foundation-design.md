# Gateway Chat / Work 领域底座设计

- 日期：2026-07-23
- 状态：已批准，按既定 Chat / Work 路线继续实施
- 目标分支：`feat/gateway-chat-work-domain-foundation`
- 基线：`main` 合并 PR #15 后的 `3de270aa26d3fdef4c51c0edf9e2c0b84a1b65d9`
- 权威依据：`docs/architecture/02-chat-work-domain.md`、`docs/architecture/03-single-gateway-concurrency.md`、`packages/contracts/src/chatWork.ts`

## 1. 目标

在不修改 iOS、Mobile Entry v1、浏览器一键验收台和现有 Foundation Conversation 行为的前提下，为正式 Chat / Work 产品模型建立可持久化、可测试的 Gateway 领域底座。

本 PR 完成：

```text
SQLite Migration V4
+ ChatWorkDomainRepository
+ HomeChatStream / DailyEpisode
+ WorkConversation
+ ThreadMessage 顺序与逻辑去重
+ Chat → Work 转换记录
+ Work Progress Snapshot
+ 重启恢复与隔离测试
```

本 PR 不开放正式 HTTP 路由。后续路由 PR 将只消费本领域仓储和已经合并的 Contracts v1。

## 2. 与 PR #14 的隔离边界

PR #14 当前只修改：

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

本 PR 允许修改：

```text
apps/gateway/src/database.ts
apps/gateway/src/chatWorkDomain.ts
apps/gateway/test/database.test.ts
apps/gateway/test/chatWorkDomain.test.ts
docs/superpowers/specs/2026-07-23-gateway-chat-work-domain-foundation-design.md
docs/superpowers/plans/2026-07-23-gateway-chat-work-domain-foundation.md
```

本 PR 明确禁止修改：

```text
clients/ios/**
.github/workflows/ios-ci.yml
.github/workflows/**
packages/contracts/**
apps/gateway/src/app.ts
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
apps/gateway/public/**
```

因此 PR #14 可以继续进行真机验收；本 PR 不改变其代码、协议、构建配置或验收文档。

## 3. 方案选择

### 方案 A：迁移、仓储、HTTP、Provider 和 Web 一次完成

优点是端到端功能出现较快；缺点是 PR 跨越数据库、认证、消息执行、路由和终端，审查困难，回归面大，也不利于保持 PR #14 稳定。

### 方案 B：迁移与领域仓储先行（采用）

先建立正式数据模型和纯 Gateway 领域 API，用 SQLite 集成测试冻结所有权、顺序、隔离和转换规则。后续 HTTP、SSE、Provider 和 Web 分别建立独立 PR。

优点：

- 文件集合与 PR #14 完全分离；
- 不改变现有外部行为；
- 数据约束和领域语义可在进入路由前被验证；
- 后续 Web 与 iOS 只接入同一 Gateway API，不会反向定义模型。

### 方案 C：只创建空表

改动最小，但不能证明模型可用，也无法冻结事务、序列和隔离规则。该方案过于碎片化，不采用。

## 4. 数据库 Migration V4

### 4.1 `interaction_threads`

```text
thread_ref PK
person_ref FK -> persons
thread_kind: home_chat | work
last_sequence >= 0
created_at
last_active_at
```

职责：提供 Chat / Work 共用的消息序列、所有权和活动时间。每个 Thread 只能属于一个 Person。

### 4.2 `home_chat_streams`

```text
home_chat_stream_ref PK
thread_ref UNIQUE FK -> interaction_threads
person_ref FK -> persons
status: active | suspended
```

使用部分唯一索引保证每个 Person 最多一个 `active` HomeChatStream。

`currentEpisodeRef` 不在表内冗余保存；Repository 从唯一开放 DailyEpisode 派生 Contracts read model，避免 HomeChat 与 DailyEpisode 形成循环外键和引用漂移。

### 4.3 `daily_episodes`

```text
daily_episode_ref PK
home_chat_stream_ref FK
thread_ref FK
local_date
timezone
started_at
ended_at nullable
boundary_reason
archive_status
archive_version
last_message_sequence
```

约束：

- 每个 HomeChatStream 最多一个 `open` DailyEpisode；
- `open` 时 `ended_at IS NULL`；
- `archived` 时 `ended_at IS NOT NULL` 且 `archive_version >= 1`；
- 本 PR 只创建初始 Episode，不实现跨日归档任务。

### 4.4 `work_conversations`

```text
work_conversation_ref PK
thread_ref UNIQUE FK
person_ref FK
title
goal
summary
status
archived_at nullable
```

约束：

- `archived` 必须有 `archived_at`；
- 非 `archived` 必须没有 `archived_at`；
- Work 不要求 Project。

### 4.5 `thread_messages`

消息字段采用显式列而不是不透明 JSON：

```text
message_ref PK
thread_ref FK
thread_sequence
client_message_id
actor_type
actor_person_ref nullable
actor_assignment_ref nullable
actor_agent_ref nullable
actor_provider_profile_ref nullable
actor_system_ref nullable
origin_device_ref nullable
origin_connection_ref nullable
entry_audience
content_type = text
content_text
content_language nullable
occurred_at
created_at
```

数据库和 Repository 共同保证：

- `UNIQUE(thread_ref, thread_sequence)`；
- `UNIQUE(thread_ref, client_message_id)`；
- Person 消息必须有 Person 和 Device 来源；
- Assistant 必须有 Assignment、Agent 和 Provider Profile；
- Agent 必须有 Agent 和 Provider Profile；
- System 必须有 `system` audience；
- 原始文本不做 trim 或重写。

### 4.6 Chat → Work

```text
chat_work_conversions
chat_work_conversion_messages
```

转换主表保存来源 Chat、可选 Episode、目标 Work、决策和待解决问题；关联表按 `source_order` 保存消息引用。

规则：

- 消息引用非空且唯一；
- 所有来源消息必须属于指定 HomeChat Thread 和当前 Person；
- 不复制消息正文；
- Work 与转换记录在同一事务创建。

### 4.7 Work Progress Snapshot

```text
work_progress_snapshots
```

每个 Work 保存一个最新结构化快照：阶段摘要、未完成任务、风险、待确认项、截止时间和更新时间。它用于后续 Work → Chat 查询，不注入完整 Work 历史。

## 5. `ChatWorkDomainRepository`

Repository 接收 `GatewayDatabase` 和可注入时钟，输出与 Contracts v1 对齐的领域对象。

### 5.1 Home Chat

```ts
ensureHomeChat({ personRef, timezone, localDate? })
getHomeChat(personRef)
```

`ensureHomeChat` 在一个短事务内创建 Thread、HomeChatStream 和初始开放 DailyEpisode。重复调用返回同一个 Chat，不创建第二个活动流。

### 5.2 Work

```ts
createWorkConversation({ personRef, title, goal })
getWorkConversation(personRef, workConversationRef)
listWorkConversations(personRef)
```

不同 Person 的查询严格隔离。列表按 `last_active_at DESC` 返回。

### 5.3 Message

```ts
appendThreadMessage({ personRef, threadRef, clientMessageId, actor, origin, content, occurredAt })
listThreadMessages({ personRef, threadRef, beforeSequence?, limit? })
```

写入事务：

1. 校验 Thread 属于当前 Person；
2. 查询相同 `clientMessageId`；
3. 内容完全相同则返回已存在消息；
4. 内容不同则抛出 `THREAD_MESSAGE_CONFLICT`；
5. 原子递增 `interaction_threads.last_sequence`；
6. 插入消息；
7. 更新 `last_active_at`；
8. Home Chat 消息同步更新开放 Episode 的 `last_message_sequence`。

Provider 调用不进入该事务。

### 5.4 Chat → Work

```ts
createWorkFromChat({ personRef, title, goal, source, decisions, openQuestions })
getChatWorkConversion(personRef, conversionRef)
```

创建 Work、转换记录和消息引用必须原子提交。任一来源引用非法时，不能留下半成品 Work。

### 5.5 Work Progress

```ts
saveWorkProgressSnapshot({ personRef, snapshot })
getWorkProgressSnapshot(personRef, workConversationRef)
```

保存前验证 Work 所有权；使用 upsert 只维护最新快照。

## 6. 错误边界

Repository 使用 `GatewayDomainError` 暴露稳定内部错误：

```text
PERSON_NOT_FOUND
THREAD_NOT_FOUND
WORK_NOT_FOUND
THREAD_MESSAGE_CONFLICT
CHAT_SOURCE_INVALID
```

本 PR 不映射新的 HTTP 状态；后续路由 PR 决定公开错误协议。

## 7. 并发与事务

- 继续使用单 Gateway、SQLite WAL 和短事务；
- `thread_sequence` 在数据库事务内分配；
- 不按 Person 建全局锁；
- 不在事务内调用 Provider；
- 不新增分布式锁、队列或微服务；
- Outbox、SSE 和 Sync Cursor 留给下一独立阶段。

## 8. 测试

### Migration 测试

- V4 只应用一次；
- V1–V3 表继续存在；
- V4 表、关键列和唯一索引存在；
- `foreign_key_check` 为空；
- 重启后 migration ledger 为 `[1, 2, 3, 4]`。

### Repository 测试

- 每个 Person 只有一个活动 Home Chat；
- 初始 DailyEpisode 与 Chat 引用一致；
- 两个 Person 的 Chat 和 Work 不可互读；
- 多个 Work 独立存在并按活动时间排序；
- 同一 Thread 消息序列严格递增；
- 文本空格被原样保留；
- 相同 `clientMessageId` 同内容幂等返回；
- 相同 `clientMessageId` 不同内容产生冲突；
- 分页结果保持升序且提供 `nextBeforeSequence`；
- Chat → Work 只接受来源 Chat 中的消息；
- 非法转换事务不留下 Work；
- Progress Snapshot 可 upsert 和读取；
- 数据库关闭并重开后 Chat、Work、消息、转换和快照仍可恢复。

## 9. 验收命令

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

CI 和 Secret Scan 全部通过后，再比较本 PR 与 PR #14 的文件集合，交集必须为零。

## 10. 后续顺序

```text
本 PR：Migration V4 + ChatWorkDomainRepository
→ Gateway Chat / Work HTTP 路由
→ Outbox / SSE / Sync Cursor
→ Member Web Chat 垂直闭环
→ Member Web Work 垂直闭环
→ iOS 接入同一协议
```
