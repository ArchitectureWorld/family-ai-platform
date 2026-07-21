# 单 Gateway 并发模型

## 1. 稳定结论

Family AI Platform 第一版采用：

```text
单逻辑 Gateway
单物理 Gateway 实例
单主要数据库
```

但 Gateway 必须并发承接：

- 多个终端连接；
- 多个家庭成员；
- 多个 Chat / Work；
- 多个文件和任务；
- 多个 Provider / Agent 调用；
- 多个终端输出。

单 Gateway 不等于全局串行。

## 2. 并发边界

```text
不同 Person：并行
同一 Person 的 Chat 与 Work：并行
不同 Work Conversation：并行
同一 Work 内独立 Execution：并行
文件上传、解析、通知：并行
向多个终端输出：并行
同一个连续上下文线程的 Agent 回合：有序
```

只在最小一致性范围内串行，不能锁住整个 Gateway，也不能按 Person 全局串行。

## 3. 处理流水线

```text
Ingress
并行接收所有终端输入
    ↓
Authentication / Entry Resolve
服务端解析 Person、Device、Family 和权限
    ↓
Message / Command Store
快速持久化并分配唯一序号
    ↓
Lane Scheduler
按上下文和资源划分执行 Lane
    ↓
Agent / Provider / Execution Pool
不同 Lane 并行执行
    ↓
Commit
同一 Lane 内按序提交上下文和结果
    ↓
Output Dispatcher
并行推送到 Web、移动端、DIY 和通知通道
```

## 4. 执行 Lane

建议稳定使用 `lane_key`：

```text
chat:<home_stream_id>
work:<conversation_id>
execution:<execution_id>
resource:<resource_id>
```

### 4.1 Chat Lane

同一个 HomeChatStream 的输入可以并行到达和落库，但依赖连续上下文的个人助理回合默认有序。

用户不需要等待 Agent 回复才能继续输入：

```text
消息接收
→ 立即返回 accepted + message_id + sequence
→ 后台排队执行 Agent 回合
→ SSE / Push / WebSocket 返回状态与回复
```

### 4.2 Work Lane

同一个 Work Conversation 的主协调消息有序，但其内部任务可 fan-out：

```text
Work Coordinator
├── 文献搜索 Execution
├── 文件解析 Execution
├── Codex Execution
└── OpenClaw Execution
```

独立 Execution 并行，汇总阶段再回到 Work Conversation Lane。

### 4.3 资源 Lane

对必须独占的资源单独串行，例如：

- 同一个日历事件的修改；
- 同一个文件的最终版本写入；
- 同一个家庭设备的危险控制动作；
- 同一个外部账号的不可并发操作。

该串行范围不得扩大到其他无关任务。

## 5. 输入并行与提交有序

同一 Chat 在手机和 Web 几乎同时输入时：

1. Gateway 并行验证两个请求；
2. 在短事务内分配 `thread_sequence`；
3. 两条输入按序进入同一 Chat Lane；
4. Agent 回合依据序列执行；
5. 输出携带序列并并行推送到所有在线终端；
6. 终端依据序列重排和补拉缺失事件。

不要把 Provider 调用放进数据库长事务。

## 6. 同步与异步接口

### 6.1 快速读取

以下接口同步返回：

- 身份和权限；
- Chat / Work 列表；
- 历史和状态；
- 设备信息；
- 已完成结果。

### 6.2 消息输入

正式接口建议先确认接收，再异步输出：

```http
POST /messages
→ HTTP 202
```

```json
{
  "accepted": true,
  "message_ref": "message:...",
  "thread_ref": "thread:...",
  "sequence": 103,
  "operation_ref": "operation:...",
  "status": "queued"
}
```

简单 Chat 后续可以提供流式响应，但持久化和事件状态仍由 Gateway 控制。

### 6.3 长任务

```text
queued
→ planning
→ running
→ waiting_confirmation
→ completed / failed / cancelled
```

Codex、OpenClaw、多文件处理和网络搜索不得占用一个长时间 HTTP 请求作为唯一状态载体。

## 7. 事件与输出

第一版采用轻量事件骨架：

```text
domain_events
outbox_events
device_sync_cursors
```

建议从 SQLite Outbox + SSE 开始：

```text
数据库事务写入业务结果 + Outbox
→ Output Dispatcher 读取 Outbox
→ SSE / Push / Device Channel
→ 终端更新 Cursor
```

不需要 Kafka 或独立消息队列。

事件至少覆盖：

- message.accepted；
- message.completed；
- operation.status_changed；
- work.updated；
- confirmation.required；
- device.revoked；
- notification.created。

## 8. 幂等和去重

区分两层：

### 8.1 传输幂等

```text
device_id + idempotency_key
```

防止同一个设备的 HTTP / 网络重试重复执行。

### 8.2 逻辑消息去重

```text
person_id + thread_id + client_message_id
```

防止跨端恢复、离线队列和设备切换产生同一逻辑消息的重复副本。

同一个幂等键用于不同请求内容必须拒绝。

## 9. SQLite 边界

家庭级第一版继续使用 SQLite WAL：

- 并行读取；
- 单写入者短事务；
- Provider 调用在事务外；
- 业务结果、消息、幂等记录和 Outbox 在短事务内一起提交；
- 通过 `busy_timeout` 处理短暂写竞争。

只有出现真实证据时才迁移 PostgreSQL，例如：

- 持续写锁成为瓶颈；
- 必须运行多个 Gateway 副本；
- 单机故障恢复无法满足要求；
- 数据规模和查询模型明显超出 SQLite。

## 10. 当前 Foundation 的适用性

当前 Foundation 的 `ConversationQueue` 以 `conversationRef` 为键，因此已经实现：

```text
不同 Conversation 并行
同一 Conversation 有序
```

在单实例 Gateway 阶段方向正确，可以保留。

后续需要做的是：

- 将锁键抽象为 `lane_key / thread_id`；
- Chat 和 Work 都接入统一 Lane Scheduler；
- Work 内独立 Execution 不被 Conversation 主 Lane 阻塞；
- 进程重启后，未完成 Operation 可从数据库恢复；
- 不为尚未存在的多实例场景提前引入分布式锁。

## 11. 过载和背压

即使家庭负载较小，也应有明确限制：

- 每个 Person 的活动 Chat / Work 并发上限；
- 每个 Provider Profile 的调用上限；
- 每个设备的请求速率；
- 文件大小和解析任务上限；
- Work Execution 队列上限；
- 危险动作不得自动批量并发。

超限返回结构化状态，而不是静默丢弃：

```text
queued
rate_limited
capacity_exceeded
provider_unavailable
```

## 12. 验收场景

第一版并发验收至少包括：

1. 两个 Person 同时对话，互不阻塞；
2. 同一 Person 的 Chat 与两个 Work 同时运行；
3. 同一 Chat 从两个终端同时发送，序列稳定；
4. 同一 Work 内两个独立 Execution 并行；
5. 一个 Provider 失败不阻塞其他 Provider；
6. 终端断线重连后按 Cursor 补齐事件；
7. 重复传输不重复创建逻辑消息；
8. Gateway 重启后已接收消息和 Operation 状态不丢失。

## 13. 最终原则

> Gateway 是单实例的统一业务权威，但不是单线程工作队列。系统对输入、读取、不同上下文、执行任务、Provider 调用和终端输出并发处理，只在同一个需要连续上下文或独占资源的最小 Lane 内保持有序。
