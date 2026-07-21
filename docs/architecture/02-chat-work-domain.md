# Chat / Work 领域稳定架构

## 1. 产品模型

个人入口采用两个独立一级对象：

```text
Chat
Work
```

它们不是两个 UI 标签而已，而是生命周期、上下文、归档和执行方式不同的领域对象。

## 2. Chat

Chat 的产品定义：

> 一个人，一个长期存在的个人助理主对话流；所有个人终端共享，并按连续时间段归档。

适用：

- 日常交流；
- 临时问题；
- 生活安排；
- 提醒与确认；
- 轻量事务；
- 尚未形成明确工作事项的讨论。

用户不需要：

- 新建 Chat；
- 选择 Session；
- 选择 Agent；
- 在不同终端维护不同 Chat。

### 2.1 HomeChatStream

```text
HomeChatStream
- home_stream_id
- person_id
- status
- created_at
- last_active_at
```

稳定规则：

- 每个有效 Person 原则上只有一个有效 HomeChatStream；
- HomeChatStream 归属于 Person，而不是某个具体 Provider；
- 更换个人助理实现、Agent 或 Provider 不创建新的 HomeChatStream；
- 每一条消息记录实际 Agent、Provider、设备和入口来源。

### 2.2 DailyEpisode

```text
DailyEpisode
- episode_id
- home_stream_id
- local_date
- timezone
- started_at_utc
- ended_at_utc
- boundary_reason
- archive_status
- archive_version
- last_message_sequence
```

DailyEpisode 是归档和上下文管理分段，不是用户需要操作的 Session。

边界综合考虑：

- Person 时区；
- 自然日；
- 当前是否仍在活跃对话；
- 最近静默时间；
- 次日首次发言；
- 系统重跑或人工纠错。

不能在 00:00 强制切断持续对话。

## 3. Chat 每日归档

原始消息完整保存。归档不是删除。

每次归档产生：

```text
Daily Summary
Decisions
Tasks
Preferences
Facts
Project Updates
Memory Candidates
Active Context Capsule
```

### 3.1 数据职责

- `Daily Summary`：当天讨论范围和总体结果；
- `Decisions`：已经确认的结论；
- `Tasks`：可执行待办及状态；
- `Preferences`：可能影响未来体验的偏好候选；
- `Facts`：具有来源的长期事实候选；
- `Project Updates`：与 Work / Project 相关的阶段变化；
- `Memory Candidates`：等待记忆治理流程处理的信息；
- `Active Context Capsule`：次日或下次继续对话所需的短期活动上下文。

结构化信息不能全部直接写入长期记忆。

### 3.2 次日上下文

默认加载：

```text
Person Profile
+ 最近 Active Context Capsule
+ 必要长期记忆
+ 当前日期相关信息
+ 最近消息
```

Provider 的外部 Session 可作为优化，但不能替代以上平台上下文。

### 3.3 归档幂等

归档任务必须具备：

- `archive_version`；
- 输入消息序列范围；
- 可重跑；
- 不重复创建 Decision / Task / Memory Candidate；
- 归档失败不修改原始消息；
- 人工纠错后可生成新版本并保留来源。

## 4. Work

Work 的产品定义：

> 一个人，多个独立 Work Conversation；每个 Conversation 对应一个具体事项，并可跨端长期推进。

适用：

- 项目与系统设计；
- 软件开发；
- 科研和论文；
- 文件分析；
- 长期方案讨论；
- 需要独立上下文的复杂事项；
- 需要 Hermes、Codex、OpenClaw 或其他执行能力的任务。

### 4.1 WorkConversation

```text
WorkConversation
- conversation_id
- person_id
- title
- goal
- summary
- status
- created_at
- last_active_at
- archived_at nullable
```

Conversation 内部可包含：

```text
Messages
Context Summary
Decisions
Tasks
Attachments
Execution Records
Confirmations
Related Project nullable
```

### 4.2 生命周期

```text
active
paused
waiting_confirmation
completed
archived
```

Work：

- 不按自然日结束；
- 可以持续数日、数周或更长；
- 支持跨端打开；
- 支持独立上下文压缩；
- 第一版不要求先创建 Project；
- 后续可以关联 Project 或 TaskGroup。

## 5. 共用技术父对象

Chat 与 Work 可以共享消息、事件、附件和 Provider 基础设施，但不能合并业务语义。

建议：

```text
InteractionThread
├── HomeChatStream
└── WorkConversation
```

`InteractionThread` 只提供：

- 统一消息序列；
- 事件序列；
- 参与者与可见范围；
- Provider Context Session；
- 同步游标；
- 局部执行 Lane。

Chat / Work 的生命周期和业务规则仍由各自模块负责。

## 6. Chat 转 Work

当日常讨论形成明确事项时，用户或个人助理可以提出“转为 Work”。最终创建必须经过用户确认或符合明确的自动化规则。

转换包：

```text
标题
目标
相关消息引用
已确认结论
待解决问题
相关附件
来源 Chat / Episode
```

规则：

- 不复制全部 Chat 历史；
- 使用引用和结构化摘要；
- 转换包保留来源消息引用；
- 创建后 Chat 与 Work 各自继续；
- 后续更新通过事件和摘要同步，不共享完整上下文。

## 7. Work 回流 Chat

Work 阶段变化可以向个人助理发布：

```text
状态
阶段结论
未完成任务
风险
待用户确认项
重要截止时间
```

不得把完整 Work 消息历史直接注入 Chat。

个人助理在 Chat 中回答 Work 进度时，应通过 Work 查询或结构化状态获取最新信息。

## 8. 消息与来源

每条消息至少记录：

```text
message_id
thread_id
thread_sequence
client_message_id
actor_type
actor_ref
origin_device_id
origin_connection_id
content_type
content
occurred_at
created_at
```

`actor_type` 可包括：

```text
person
assistant
agent
system
```

`content_type` 第一阶段逐步扩展：

```text
text
image
file
audio
event
confirmation
```

不能让客户端通过消息中的 `person_id` 决定消息归属。Person 由 Gateway 的认证上下文解析。

## 9. 并发和有序性

- 不同 HomeChatStream 并行；
- Chat 与 Work 并行；
- 不同 Work Conversation 并行；
- 同一线程的输入可并行接收和落库；
- 同一线程中依赖连续上下文的 Agent 回合默认有序；
- Work 内独立 Execution 可并行；
- 终端输出异步并行分发。

每个线程维护递增 `thread_sequence`，终端依据序号恢复顺序。

## 10. Provider Context Session

```text
ProviderContextSession
- context_session_id
- thread_id
- segment_number
- agent_ref
- provider_profile_ref
- external_session_ref nullable
- context_snapshot_ref
- status
- started_at
- ended_at nullable
```

原则：

- 外部 Session 可丢失；
- 平台可依据 Context Snapshot 重建；
- 更换 Provider 不改变 Chat / Work 所有权；
- Provider 输出必须作为平台消息和事件持久化后才视为完成。

## 11. 第一版范围

必须：

- HomeChatStream；
- DailyEpisode；
- WorkConversation；
- 文本消息；
- 跨端消息序列；
- Chat 转 Work；
- Work 状态回流 Chat；
- 原始消息保存；
- Daily Summary 与 Active Context Capsule 的最小版本。

暂缓：

- 自动复杂话题拆分；
- 完整 Project 系统；
- 高级知识图谱；
- 多 Agent 协作可视化；
- 自动长期记忆写入；
- 大规模全文历史检索优化。

## 12. 验收原则

- 所有个人终端进入同一个 HomeChatStream；
- DailyEpisode 切分不造成对话中断；
- 原始消息在归档后可追溯；
- 不同 Work Conversation 不串上下文；
- Chat 可以生成 Work，但不复制全部历史；
- Work 结论可以在 Chat 查询到；
- Provider Session 丢失后可以依据平台上下文继续；
- 同一线程回复顺序稳定，不同线程可并行执行。
