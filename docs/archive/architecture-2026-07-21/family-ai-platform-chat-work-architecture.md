# Family AI Platform：个人入口 Chat / Work 双模式架构

## 1. 文档目的

本文档用于稳定 `family-ai-platform` 中个人入口与个人助理级 Agent 的交互模式。

本阶段确认：

- 个人入口与个人助理级 Agent 绑定。
- 用户首次通过手机号完成身份认领。
- 后续由入口账号或设备凭证完成身份识别与分流。
- 个人入口划分为 **Chat** 与 **Work** 两个独立一级页面。
- Chat 用于日常、连续、多端共享的个人助理对话。
- Work 使用 Conversation 模型，用于具体事项和长期工作。
- 设备连接、Chat、Conversation、个人记忆分别建模，不再统一使用 Session 概念。

---

## 2. 核心产品定义

### 2.1 Chat

Chat 是用户与个人助理之间唯一的默认日常对话入口。

其产品定义为：

> 一个人，一个长期存在的个人助理主对话流，多端共享，按日归档与压缩。

Chat 适用于：

- 日常交流；
- 临时问题；
- 生活安排；
- 提醒与确认；
- 轻量事务；
- 尚未形成明确工作事项的讨论。

用户无需新建 Chat，也无需管理 Session。

---

### 2.2 Work

Work 是面向具体事项的工作页面，采用 Conversation 模型。

其产品定义为：

> 一个人，多个独立 Conversation；每个 Conversation 对应一个具体事项，并可跨端持续推进。

Work 适用于：

- 产品与系统设计；
- 项目开发；
- 科研与论文；
- 文件分析；
- 长期方案讨论；
- 需要独立上下文的复杂事项；
- 需要调用 OpenClaw、Codex 或其他执行能力的任务。

---

## 3. 页面信息架构

个人入口第一版采用两个一级页面：

```text
个人入口
├── Chat
└── Work
```

可选导航形式：

```text
Chat ｜ Work
```

如后续增加账号、设备、设置等能力，可扩展为：

```text
Chat ｜ Work ｜ 我的
```

个人入口默认打开 Chat 页面。

---

## 4. 身份绑定与 Agent 分流

### 4.1 手机号的职责

手机号仅用于：

- 首次查找后台预创建的家庭成员；
- 验证用户身份；
- 完成家庭成员认领；
- 找回或重新绑定。

手机号不作为系统内部永久主键，也不作为每次进入时的分流依据。

---

### 4.2 内部身份模型

系统内部使用不可变的 `person_id` 表示家庭成员。

```text
Person
- person_id
- family_id
- display_name
- family_role
- status
```

一个 Person 可以关联多个身份凭证：

```text
Identity
- identity_id
- person_id
- identity_type
- identity_value
- verified_at
- status
```

例如：

```text
person_001
├── phone
├── apple_account
├── wechat_openid
├── huawei_account
└── device_credential
```

---

### 4.3 首次绑定流程

```text
用户打开个人入口
    ↓
输入后台预留手机号
    ↓
验证码验证
    ↓
找到对应 Person
    ↓
用户确认身份
    ↓
绑定当前入口账号或设备凭证
    ↓
加载对应个人助理级 Agent
    ↓
进入 Chat 页面
```

---

### 4.4 后续分流流程

绑定完成后，日常使用不再依赖手机号：

```text
入口账号或设备凭证
    ↓
EntryBinding
    ↓
person_id
    ↓
AssistantAssignment
    ↓
个人助理级 Agent
```

---

## 5. Chat 页面设计

### 5.1 用户体验

用户从任何个人终端进入 Chat 页面时：

- 看到同一条持续对话流；
- 手机、电脑、鸿蒙等终端实时同步；
- 不需要选择 Agent；
- 不需要选择 Session；
- 不需要新建 Chat；
- 默认由对应个人助理级 Agent 承接。

用户感受到的是：

> 我一直在和自己的个人助理对话。

---

### 5.2 Chat 的后台模型

Chat 不采用无限增长的单一 Session，而采用：

```text
HomeChatStream
├── DailyEpisode：2026-07-20
├── DailyEpisode：2026-07-21
├── DailyEpisode：2026-07-22
└── ...
```

#### HomeChatStream

表示该用户长期存在的个人助理主对话流。

```text
HomeChatStream
- home_stream_id
- person_id
- assistant_id
- status
- created_at
- last_active_at
```

每个用户原则上只有一个有效的 HomeChatStream。

#### DailyEpisode

表示某一天或一个连续时间段内的原始对话分段。

```text
DailyEpisode
- episode_id
- home_stream_id
- date
- started_at
- ended_at
- archive_status
```

---

## 6. Chat 的每日归档与压缩

### 6.1 基本原则

Chat 每天归档一次，但不能简单删除历史消息，也不能只生成一段普通摘要。

每日归档需要形成以下内容：

```text
当天原始消息
├── Daily Summary
├── Decisions
├── Tasks
├── Preferences
├── Facts
├── Project Updates
├── Memory Candidates
└── Active Context Capsule
```

---

### 6.2 原始消息

原始消息完整保留，用于：

- 历史查看；
- 重新总结；
- 纠错；
- 审计来源；
- 找回压缩过程中遗漏的信息。

原始消息可以转入低频存储，但不得因压缩而被直接删除。

---

### 6.3 每日摘要

每日摘要记录：

- 当天讨论了什么；
- 形成了哪些结论；
- 哪些事情尚未完成；
- 哪些事项可能在次日继续。

---

### 6.4 结构化信息提取

每日归档时，系统需要识别并提取：

- 决策；
- 待办；
- 用户偏好；
- 长期事实；
- 项目进展；
- 记忆候选；
- 提醒事项。

不同信息应写入不同位置，不能全部混入个人长期记忆。

例如：

```json
{
  "type": "architecture_decision",
  "project_id": "family-ai-platform",
  "content": "个人入口采用 Chat / Work 两个独立一级页面",
  "status": "confirmed"
}
```

---

### 6.5 次日承接上下文

归档后生成 `Active Context Capsule`，供次日 Chat 使用。

建议包含：

- 最近主要话题；
- 尚未完成的事项；
- 近期关键决定；
- 等待用户确认的内容；
- 近期提醒；
- 与当前时间相关的上下文。

次日 Agent 加载：

```text
个人 Profile
+ 最近 Active Context Capsule
+ 必要的长期记忆
+ 今日最新消息
```

---

### 6.6 归档时间边界

“每天归档一次”不等于在 00:00 强制切断对话。

归档应综合考虑：

- 用户所在时区；
- 自然日；
- 当前是否仍在活跃对话；
- 最近静默时间；
- 次日首次发言时间。

例如用户从 23:50 连续讨论到 00:20，可以归入同一个连续 Episode，避免午夜生硬切断。

---

## 7. Work 页面设计

### 7.1 Conversation 模型

Work 页面采用标准 Conversation 模型：

```text
Work
├── Conversation A
├── Conversation B
├── Conversation C
└── ...
```

每个 Conversation 对应一个具体事项。

```text
Conversation
- conversation_id
- person_id
- assistant_id
- title
- summary
- status
- created_at
- last_active_at
```

---

### 7.2 Conversation 内部内容

```text
Conversation
├── Messages
├── Context Summary
├── Decisions
├── Tasks
├── Attachments
├── Execution Records
└── Related Project
```

第一版前端不需要展示全部结构化信息，但后台应为后续扩展保留数据位置。

---

### 7.3 Conversation 生命周期

Conversation：

- 不按自然日强制结束；
- 可以持续数天、数周或更长；
- 支持跨端打开；
- 支持暂停、归档和恢复；
- 支持独立上下文压缩；
- 后续可关联 Project，但第一版不强制要求先创建 Project。

---

## 8. Chat 与 Work 的关系

Chat 与 Work 是两个独立页面，但二者不能完全隔离。

---

### 8.1 Chat 转为 Work

当 Chat 中的内容逐渐形成明确事项时，可以创建 Work Conversation。

用户侧可以提供：

```text
转为 Work
```

创建 Conversation 时，不复制整个 Chat 历史，而生成一个结构化上下文包：

```text
Conversation 标题
讨论目标
相关消息片段
已确认结论
待解决问题
相关文件
```

示例：

```json
{
  "title": "个人入口 Chat / Work 双模式设计",
  "goal": "稳定 family-ai-platform 个人入口的交互与会话架构",
  "confirmed_decisions": [
    "手机号仅用于首次认领",
    "个人入口默认进入 Chat",
    "Chat 多端共享并每日归档",
    "Work 使用独立 Conversation"
  ],
  "open_questions": []
}
```

---

### 8.2 Work 结果同步回 Chat

Work Conversation 的阶段成果应同步给个人助理，但不能把完整 Conversation 塞回 Chat 上下文。

建议同步：

- Conversation 标题；
- 当前状态；
- 最新结论；
- 未完成任务；
- 风险；
- 等待用户确认的事项。

这样用户在 Chat 中询问：

> family-ai-platform 那件事现在到哪里了？

个人助理可以读取 Work 状态后回答。

---

## 9. 跨端连续性

### 9.1 设备连接不等于对话

每个设备或端口只建立自己的连接：

```text
Connection
- connection_id
- person_id
- channel_type
- device_id
- connected_at
```

Connection 只表示用户从哪里进入，不表示用户在讨论什么。

---

### 9.2 Chat 跨端

所有个人设备访问同一个：

```text
home_stream_id
```

示意：

```text
iPhone Connection ─────┐
Web Connection ────────┼── HomeChatStream
Harmony Connection ────┘
```

---

### 9.3 Work 跨端

所有个人设备共享同一份 Conversation 列表。

同一个 Conversation 可由多个设备打开：

```text
iPhone Connection ─────┐
Web Connection ────────┼── Conversation
Harmony Connection ────┘
```

设备侧只需记录：

```text
last_opened_page
last_opened_conversation_id
```

设备不决定 Conversation 的归属。

---

## 10. 统一消息协议

### 10.1 Chat 消息

```json
{
  "mode": "chat",
  "identity": {
    "person_id": "person_001"
  },
  "entry": {
    "channel": "ios",
    "device_id": "iphone_001",
    "connection_id": "conn_001"
  },
  "chat": {
    "home_stream_id": "home_001",
    "episode_id": "episode_20260721"
  },
  "content": {
    "type": "text",
    "text": "今天有什么安排？"
  }
}
```

---

### 10.2 Work 消息

```json
{
  "mode": "work",
  "identity": {
    "person_id": "person_001"
  },
  "entry": {
    "channel": "web",
    "device_id": "web_001",
    "connection_id": "conn_002"
  },
  "work": {
    "conversation_id": "conv_001"
  },
  "content": {
    "type": "text",
    "text": "继续讨论跨端会话架构。"
  }
}
```

---

## 11. family-ai-platform 中的对象关系

```text
Family
└── Person
    ├── Identities
    ├── EntryBindings
    ├── AssistantAssignment
    ├── HomeChatStream
    │   └── DailyEpisodes
    ├── WorkConversations
    ├── PersonalMemory
    └── GlobalTaskState
```

设备侧关系：

```text
Device Connection
      ↓
    Person
      ├── Chat 页面 → HomeChatStream
      └── Work 页面 → 指定 Conversation
```

---

## 12. 系统职责边界

| 系统 | 主要职责 |
|---|---|
| family-ai-platform | 入口接入、身份绑定、Person 解析、Chat / Work 管理、跨端同步、Agent 路由 |
| Hermes 个人助理 | 理解用户需求、承接日常对话、调用相关上下文、协调其它执行能力 |
| 家庭总管 | 处理家庭多人事务 |
| OpenClaw Agent Team | 专业执行、项目协作、复杂任务推进 |
| Codex | 自动化、代码开发、浏览器与计算机操作 |
| ME-Who | 个人画像与长期用户理解 |
| ME-Brain | 客观资料、项目资料和知识结构化 |

身份识别与会话管理属于 `family-ai-platform`，不应由 Hermes 自行实现。

---

## 13. 第一版最小实现范围

### 13.1 身份与绑定

- 管理员预创建家庭成员；
- 配置手机号；
- 配置对应个人助理；
- 手机号验证码认领；
- 建立入口账号或设备与 Person 的绑定；
- 后续自动分流至对应个人助理。

### 13.2 Chat

- 每个 Person 一个 HomeChatStream；
- 所有个人终端共享；
- 实时同步；
- 按日形成 DailyEpisode；
- 每日摘要与结构化提取；
- 次日上下文承接；
- 原始消息完整保留。

### 13.3 Work

- 独立 Work 页面；
- Conversation 列表；
- 新建、打开、归档 Conversation；
- Conversation 跨端同步；
- 独立上下文；
- Chat 转 Work；
- Work 阶段结果同步回 Chat。

### 13.4 第一版暂不强制实现

- 自动识别并强制拆分话题；
- 完整 Project 系统；
- 多 Agent 协作界面的显性展示；
- 复杂权限体系；
- 公共终端的声纹身份识别；
- 儿童和老人专属绑定流程；
- 高级知识图谱与长期记忆治理。

但数据结构和接口应为这些能力保留扩展空间。

---

## 14. 稳定结论

### 14.1 身份

```text
手机号负责首次认领
Person ID 负责内部身份
入口账号负责日常分流
个人助理负责统一承接
```

### 14.2 会话

```text
Connection 只是设备连接
Chat 负责日常连续
Conversation 负责具体工作
Memory 负责长期认知
```

### 14.3 产品结构

```text
Chat
= 一个人，一个长期日常对话流
= 多端共享
= 按日归档、压缩和结构化提取

Work
= 一个人，多个独立 Conversation
= 每个 Conversation 对应一个具体事项
= 多端同步
= 长期持续
```

### 14.4 最终架构原则

> `family-ai-platform` 的个人入口采用 Chat 与 Work 两个独立一级页面。Chat 是用户与个人助理之间唯一的默认日常对话流，由所有个人终端共享，并通过 DailyEpisode 按日归档、压缩和提取结构化信息。Work 页面采用 Conversation 模型，每个具体事项建立独立 Conversation，支持跨端同步和长期推进。Chat 中的复杂事项可以转为 Work Conversation，Work 的阶段成果则以结构化摘要同步回个人助理。
