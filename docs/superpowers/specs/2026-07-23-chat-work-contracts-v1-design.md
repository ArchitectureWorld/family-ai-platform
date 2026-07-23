# Chat / Work Contracts v1 设计

- 日期：2026-07-23
- 状态：已批准
- 目标分支：`feat/chat-work-contracts-v1`
- 权威依据：`docs/architecture/02-chat-work-domain.md`、`docs/architecture/04-multi-terminal-strategy.md`

## 1. 目标

冻结第一版 Chat / Work 公共 JSON 协议，为后续 Gateway 正式领域实现、Member Web 和 iOS 共用同一套对象与命令提供稳定边界。

本设计只建立协议，不实现 Gateway 路由、数据库 Schema、Web 页面或 iOS 功能。

## 2. 与现有工作的冲突边界

本工作从最新 `main` 独立创建分支，只修改：

```text
packages/contracts/src/chatWork.ts
packages/contracts/src/index.ts
packages/contracts/test/chatWork.test.ts
packages/contracts/fixtures/chat-work/**
docs/superpowers/specs/2026-07-23-chat-work-contracts-v1-design.md
docs/superpowers/plans/2026-07-23-chat-work-contracts-v1.md
```

明确不修改：

```text
clients/ios/**
apps/gateway/**
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
.github/workflows/**
```

因此当前 iOS PR 可以继续完成真机验收，本 PR 不依赖其分支，也不改变 Mobile Entry v1。

## 3. 第一版范围

### 包含

- `InteractionThread` 技术父对象；
- `HomeChatStream`；
- `DailyEpisode`；
- `WorkConversation`；
- 文本 `ThreadMessage`；
- Home Chat 查询响应；
- Work 创建与列表响应；
- Thread 消息发送与分页响应；
- Chat 转 Work 的结构化转换包；
- Work 阶段进度快照；
- 严格 Zod 校验、类型导出和规范 JSON fixtures。

### 暂不包含

- SSE、Outbox、Sync Cursor；
- 文件与附件协议；
- Operation / Execution；
- Confirmation 命令；
- Daily Summary 与 Active Context Capsule 的具体结构；
- Provider Session；
- Gateway 数据库和 HTTP 路由；
- Member Web 与 iOS UI。

这些内容分别进入后续独立 PR，避免首个协议 PR 跨越过多子系统。

## 4. 协议原则

1. 新协议版本常量为 `CHAT_WORK_PROTOCOL_VERSION = 1`。
2. 所有请求和响应 envelope 必须携带 `protocolVersion`。
3. 所有公开对象使用 `.strict()`，拒绝未知字段。
4. Chat 与 Work 共用消息和 Thread 基础结构，但保持不同生命周期与业务语义。
5. 客户端命令不能提交可信的 `personRef`、`agentRef`、`deviceRef` 或消息来源；Gateway 后续必须从 Entry Session、DeviceBinding 和请求路径解析。
6. 服务端响应记录实际 Person、Agent、设备、Connection 和入口 audience。
7. 原始消息不可因归档或摘要而删除；本协议只描述持久化后的消息事实。
8. Provider Session 不进入 Chat / Work 所有权模型。

## 5. 领域对象

### 5.1 InteractionThread

统一技术字段：

```text
threadRef
threadKind: home_chat | work
personRef
lastSequence
createdAt
lastActiveAt
```

`lastSequence` 从 `0` 开始，消息的 `threadSequence` 从 `1` 开始递增。

### 5.2 HomeChatStream

在 `InteractionThread` 基础上增加：

```text
homeChatStreamRef
status: active | suspended
currentEpisodeRef: DailyEpisode ref | null
```

稳定语义：一个有效 Person 原则上只有一个有效 HomeChatStream；更换 AssistantAssignment、Agent 或 Provider 不创建新 Chat。

### 5.3 DailyEpisode

字段：

```text
dailyEpisodeRef
homeChatStreamRef
threadRef
localDate
timezone
startedAt
endedAt
boundaryReason
archiveStatus
archiveVersion
lastMessageSequence
```

约束：

- `archiveStatus = open` 时 `endedAt` 必须为 `null`；
- `archiveStatus = archived` 时 `endedAt` 必须存在且 `archiveVersion >= 1`；
- Episode 是归档和上下文分段，不提供客户端创建命令。

### 5.4 WorkConversation

在 `InteractionThread` 基础上增加：

```text
workConversationRef
title
goal
summary
status: active | paused | waiting_confirmation | completed | archived
archivedAt
```

约束：

- `status = archived` 时 `archivedAt` 必须存在；
- 其他状态的 `archivedAt` 必须为 `null`；
- 第一版创建 Work 只要求标题和目标，不要求 Project。

### 5.5 ThreadMessage

字段：

```text
messageRef
threadRef
threadSequence
clientMessageId
actor
origin
content
occurredAt
createdAt
```

`actor` 是严格判别联合：

```text
person    -> personRef
assistant -> assignmentRef + agentRef
agent     -> agentRef
system    -> systemRef
```

`origin` 固定包含：

```text
deviceRef: string | null
connectionRef: string | null
entryAudience: personal | family_admin | system
```

约束：Person 消息必须有 `deviceRef`；System 消息必须使用 `entryAudience = system`。第一版 `content` 只支持文本。

## 6. 命令与响应

### 6.1 Home Chat

```text
homeChatStreamResponseSchema
```

返回 Chat 与当前 DailyEpisode。客户端没有“创建 Chat”命令。

### 6.2 Work

```text
workConversationListResponseSchema
createWorkConversationRequestSchema
createWorkConversationResponseSchema
```

创建请求只包含：

```text
protocolVersion
title
goal
```

### 6.3 消息

```text
threadMessageListResponseSchema
sendThreadMessageRequestSchema
sendThreadMessageResponseSchema
```

发送请求只包含：

```text
protocolVersion
clientMessageId
occurredAt
content
```

Thread 由 URL 路径指定，Person、Agent、Device 和 Origin 由 Gateway 认证上下文确定。

### 6.4 Chat 转 Work

```text
createWorkFromChatRequestSchema
chatWorkConversionSchema
createWorkFromChatResponseSchema
```

转换请求包含：

```text
title
goal
source.homeChatStreamRef
source.dailyEpisodeRef
source.messageRefs
decisions
openQuestions
```

`messageRefs` 必须非空且唯一。转换只保存消息引用和结构化信息，不复制完整 Chat 历史。

### 6.5 Work 回流信息

```text
workProgressSnapshotSchema
workProgressSnapshotResponseSchema
```

快照包含：

```text
status
phaseSummary
incompleteTasks
risks
pendingConfirmations
deadlines
updatedAt
```

它是 Chat 查询 Work 最新状态的结构化数据，不携带完整 Work 消息历史。

## 7. 公开导出

新增 `packages/contracts/src/chatWork.ts`，并从 `packages/contracts/src/index.ts` 通过：

```ts
export * from "./chatWork.js";
```

导出以下核心 Schema 和对应 Type：

```text
CHAT_WORK_PROTOCOL_VERSION
interactionThreadRefSchema
homeChatStreamRefSchema
dailyEpisodeRefSchema
workConversationRefSchema
chatWorkConversionRefSchema
threadMessageContentSchema
threadActorSchema
threadMessageOriginSchema
interactionThreadSchema
homeChatStreamSchema
dailyEpisodeSchema
workConversationStatusSchema
workConversationSchema
threadMessageSchema
homeChatStreamResponseSchema
workConversationListResponseSchema
createWorkConversationRequestSchema
createWorkConversationResponseSchema
threadMessageListResponseSchema
sendThreadMessageRequestSchema
sendThreadMessageResponseSchema
createWorkFromChatRequestSchema
chatWorkConversionSchema
createWorkFromChatResponseSchema
workProgressSnapshotSchema
workProgressSnapshotResponseSchema
```

现有 `PROTOCOL_VERSION`、Message Envelope、Provider Adapter 和 Mobile Entry 导出保持不变。

## 8. 后续 HTTP 映射

本 PR 不实现路由，但协议预留给后续 Gateway PR：

```text
GET  /api/v1/chat
GET  /api/v1/work-conversations
POST /api/v1/work-conversations
GET  /api/v1/threads/:threadRef/messages
POST /api/v1/threads/:threadRef/messages
POST /api/v1/chat/work-conversions
GET  /api/v1/work-conversations/:workConversationRef/progress
```

现有 Foundation `/api/v1/conversations` 暂时保持不变，不能直接改名或被视为正式 Chat / Work 模型。

## 9. 测试与 Fixtures

新增规范 fixtures：

```text
home-chat-response.json
work-list-response.json
thread-message-list-response.json
create-work-request.json
create-work-from-chat-request.json
work-progress-response.json
```

自动测试必须覆盖：

- 所有规范 fixture 成功解析；
- 错误协议版本被拒绝；
- 未知字段被拒绝；
- 客户端命令中的 `personRef`、`agentRef`、`deviceRef` 被拒绝；
- DailyEpisode 归档约束；
- Work archived 状态约束；
- Person/System 消息来源约束；
- Chat 转 Work 消息引用非空且唯一；
- 根包能够导入全部新增类型与 Schema；
- 现有 Contracts 和 Mobile Entry 测试不回归。

## 10. 验收命令

```bash
npm run test -w @family-ai/contracts
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
npm run check
```

全部通过后，比较本分支与最新 `main` 及开放 PR 的文件列表，确认没有修改 `clients/ios/**`、`apps/gateway/**`、Mobile Entry 文件或工作流，再创建 Draft PR。

## 11. 后续顺序

本协议 PR 合并后，下一条独立 PR 才实现 Gateway 的 `InteractionThread`、`HomeChatStream`、`DailyEpisode`、`WorkConversation` 和消息持久化。同步事件、Member Web 与 iOS Chat / Work 接入继续分开审查。