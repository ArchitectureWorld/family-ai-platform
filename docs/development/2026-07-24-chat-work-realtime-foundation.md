# Chat / Work 实时后端阶段开发记录

**日期：** 2026-07-24  
**主分支基线：** `c4af5feb5335324ee5bb0ddcfe5757e812910330`  
**覆盖 PR：** #15、#16、#17、#18、#19、#20  
**状态：** 已合并到 `main`

## 1. 阶段结论

正式 Chat / Work 后端已经完成从公共协议、持久化、HTTP API、Provider 回复、领域事件、Transactional Outbox 到 SSE 实时推送的完整基础链路：

```text
Personal Entry Session
→ HomeChatStream / WorkConversation
→ Person ThreadMessage
→ 同 Thread Provider Lane
→ Assistant ThreadMessage
→ domain_events + outbox_events
→ SSE 实时通知与断线恢复
```

浏览器验收台没有被扩展为正式 Member Web，仍只承担初始化、配对和“小白一键验收”。iOS PR #14 继续独立等待真实 Mac、iPhone 与部署 Gateway 的真机验收。

## 2. 已合并能力

### PR #15：Chat / Work Contracts v1

建立统一公共协议：

- `InteractionThread`；
- `HomeChatStream` 与 `DailyEpisode`；
- `WorkConversation`；
- `ThreadMessage`；
- Home Chat、Work、消息、Chat → Work 和进度请求/响应；
- 严格 Zod Schema、TypeScript 类型与规范 fixtures。

### PR #16：Gateway Chat / Work 领域底座

建立 SQLite 持久化与 Repository：

- 每个 Person 一个活动 Home Chat；
- 多个独立 Work；
- Thread 内严格递增消息序列；
- `clientMessageId` 幂等与冲突检测；
- Chat → Work 原子转换；
- Work 进度快照；
- 重启恢复与跨 Person 隔离。

### PR #17：正式 HTTP API

开放 Personal Entry Session 认证的接口：

```http
GET  /api/v1/chat
GET  /api/v1/work-conversations
POST /api/v1/work-conversations
GET  /api/v1/threads/:threadRef/messages
POST /api/v1/threads/:threadRef/messages
POST /api/v1/chat/work-conversions
GET  /api/v1/work-conversations/:workConversationRef/progress
```

客户端不能声明可信的 Person、Device、Actor、Origin、Agent 或 Provider Profile。

### PR #18：Provider Turn 与 Assistant 回复

建立完整 AI 回复闭环：

```text
Person 消息持久化
→ 同 Thread 有序执行
→ 解析 AssistantAssignment
→ 延续 Provider Context Session
→ Provider 调用
→ Assistant 消息、External Session 和 Turn 成功原子提交
```

支持失败重试、成功重放、Assignment 切换和 Gateway 重启后上下文延续。

### PR #19：领域事件与 Transactional Outbox

建立 Person 级严格递增事件序列：

```text
chat.home.created
work.created
thread.message.created
chat.work.created
work.progress.updated
thread.provider_turn.failed
thread.provider_turn.succeeded
```

领域数据、`domain_events` 和 `outbox_events` 在同一 SQLite 事务中提交或回滚。事件不保存消息正文、Token、Credential、Authorization 或 Provider External Session。

### PR #20：SSE 实时事件流

新增：

```http
GET /api/v1/events/stream?afterSequence=123
Last-Event-ID: 123
```

能力包括：

- 只允许 `personal` Entry Session；
- `afterSequence` 和 `Last-Event-ID` 排他 Cursor；
- Person 共享事件 Pump；
- 严格升序、分页补发和单连接去重；
- 15 秒心跳及 Session、Device、EntryBinding、Person、audience 复核；
- 每连接独立 FIFO 写队列；
- `drain` 背压处理；
- 256 帧或 1 MiB 队列保护；
- 客户端断开与 Gateway 关闭清理；
- SSE 消费不修改 Outbox 状态。

## 3. 当前端到端行为

一次正式 Chat 消息现在会经历：

```text
1. 客户端使用 Personal Entry Session 发送消息
2. Gateway 解析 Person 与 Device
3. Person 消息按 threadSequence 持久化
4. 同 Thread Provider Lane 串行执行
5. Provider 生成 Assistant 回复
6. Assistant 消息与 Provider Turn 状态持久化
7. 领域事件和 Outbox 原子生成
8. SSE 向当前 Person 的在线连接发送事件
9. 断线终端按 Event Cursor 补拉
```

不同 Person、Chat 和 Work 保持隔离；同一 Thread 内有序，不同 Thread 可以并行。

## 4. 验证记录

PR #20 合并前锁定 Head：

```text
6b2ae645a752da5c1398fc0683213d5cefbe5015
```

最终检查：

- Repository CI #317：成功；
- Secret Scan #203：成功；
- PR comments：无；
- unresolved review threads：无；
- GitHub mergeable：是；
- squash merge commit：`c4af5feb5335324ee5bb0ddcfe5757e812910330`。

详细 TDD、背压、授权、跨 Person 隔离、实时流和 Outbox 边界证据见：

- `docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md`；
- `docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md`；
- `docs/superpowers/plans/2026-07-24-gateway-chat-work-sse.md`。

## 5. PR #14 隔离状态

PR #14 当前保持：

```text
Open
Draft
Head = e075f114e3f3fcdb728f6bff75797d415c4a5315
```

PR #14 只修改：

```text
.github/workflows/ios-ci.yml
clients/ios/**
```

PR #15–#20 没有向 PR #14 分支写入提交，也没有修改其 iOS 文件。PR #20 合并后 GitHub 已重新计算 PR #14 为可合并。

## 6. 当前能力矩阵

| 能力 | 状态 |
|---|---|
| Family / Person / 双 Entry Session | 已完成 |
| iOS Mobile Entry Foundation | PR #14 Draft，等待真机验收 |
| Chat / Work 公共协议 | 已完成 |
| Chat / Work SQLite 领域模型 | 已完成 |
| Chat / Work HTTP API | 已完成 |
| Provider Context 与 Assistant 回复 | 已完成 |
| 领域事件与 Transactional Outbox | 已完成 |
| SSE 实时推送与 Last-Event-ID 恢复 | 已完成 |
| Device Sync Cursor | 下一阶段 |
| 显式事件补拉 API | 下一阶段 |
| 正式 Member Web | 尚未开发 |
| Push Notification | 尚未开发 |
| iOS Chat / Work UI | 尚未开发 |

## 7. 下一阶段顺序

```text
Device Sync Cursor
→ 显式缺失事件补拉 API
→ 正式 Member Web Chat / Work
→ Push 唤醒
→ iOS 接入统一 Chat / Work 与同步协议
```

在 PR #14 完成真机验收前，后续独立 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。