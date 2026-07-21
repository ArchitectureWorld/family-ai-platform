# Family AI Platform：1+N 多终端开发总规范

## 1. 文档定位

本文档是 `family-ai-platform` 多终端开发的统一规范，负责定义所有终端共同遵守的产品模型、身份模型、会话模型、终端协议、跨端连续性、权限边界和验收原则。

本阶段采用：

```text
1 + N
```

其中：

- `1`：统一多终端开发总规范；
- `N`：面向不同终端形态的独立实现方案。

当前 N 包括：

```text
Web
iOS
HarmonyOS
DIY Hardware
```

对应文档：

```text
00-multi-terminal-development-master.md
01-web-terminal-development.md
02-ios-terminal-development.md
03-harmonyos-terminal-development.md
04-diy-hardware-terminal-development.md
```

---

## 2. 总体原则

### 2.1 一个统一平台，不是多个独立客户端系统

所有终端共享同一套服务端对象：

```text
Family
└── Person
    ├── Identities
    ├── EntryBindings
    ├── AssistantAssignment
    ├── HomeChatStream
    ├── WorkConversations
    ├── PersonalMemory
    ├── Tasks
    └── Permissions
```

不同终端只能改变：

- 输入方式；
- 输出形式；
- 页面结构；
- 终端能力；
- 隐私级别；
- 交互深度。

不同终端不能各自维护独立的用户身份、Chat、Conversation、记忆或任务状态。

---

### 2.2 Chat 与 Work 是统一产品模型

所有具备完整界面的个人终端，原则上采用两个一级入口：

```text
Chat
Work
```

#### Chat

```text
一个 Person
一个长期 HomeChatStream
多端共享
按日归档
```

Chat 用于日常、临时、轻量和连续交流。

#### Work

```text
一个 Person
多个独立 Conversation
跨端共享
长期持续
```

Work 用于明确事项、项目工作、复杂讨论、文件处理和执行任务。

受限终端可以不显示完整 Chat / Work 页面，但其请求仍需映射到同一对象模型。

---

## 3. 统一身份与绑定

### 3.1 内部身份主键

平台内部使用不可变的：

```text
person_id
```

手机号只用于首次认领，不作为内部永久主键。

### 3.2 首次绑定

```text
预创建家庭成员
→ 手机号验证
→ 找到 Person
→ 用户确认
→ 绑定入口账号或设备
→ 分配个人助理
```

### 3.3 后续分流

```text
入口身份 / 设备凭证
→ EntryBinding
→ person_id
→ AssistantAssignment
→ 个人助理级 Agent
```

### 3.4 终端绑定类型

| 终端 | 默认绑定方式 |
|---|---|
| Web | 账号登录 + 浏览器会话 |
| iOS | App 账号 / Apple 登录 / 设备凭证 |
| HarmonyOS | App 账号 / 华为账号 / 设备凭证 |
| 个人 DIY | 设备预绑定 Person |
| 家庭共享 DIY | 设备绑定 Family，使用时识别 Person |

---

## 4. 统一对象模型

### 4.1 Connection

表示设备当前与平台建立的连接。

```text
Connection
- connection_id
- person_id
- device_id
- channel_type
- connected_at
- last_seen_at
```

Connection 不是 Conversation。

### 4.2 HomeChatStream

```text
HomeChatStream
- home_stream_id
- person_id
- assistant_id
- last_active_at
```

每个 Person 原则上只有一个有效 HomeChatStream。

### 4.3 DailyEpisode

```text
DailyEpisode
- episode_id
- home_stream_id
- date
- started_at
- ended_at
- archive_status
```

### 4.4 Conversation

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

### 4.5 Device

```text
Device
- device_id
- terminal_type
- owner_scope
- person_id
- family_id
- capability_profile
- trust_level
- status
```

---

## 5. 统一终端能力描述

每个终端必须向平台声明能力，而不是由平台通过终端名称硬编码判断。

示例：

```json
{
  "terminal_type": "mobile",
  "platform": "ios",
  "capabilities": {
    "screen": "full",
    "text_input": true,
    "voice_input": true,
    "voice_output": true,
    "camera": true,
    "file_upload": true,
    "touch": true,
    "push_notification": true,
    "background_execution": "limited"
  }
}
```

DIY 终端示例：

```json
{
  "terminal_type": "diy_voice",
  "capabilities": {
    "screen": "small",
    "text_input": false,
    "voice_input": true,
    "voice_output": true,
    "camera": false,
    "file_upload": false,
    "touch": true,
    "push_notification": false
  }
}
```

平台依据能力描述决定：

- 回复长度；
- 是否输出结构化卡片；
- 是否输出语音；
- 是否允许文件；
- 是否要求二次确认；
- 是否可以展示敏感信息。

---

## 6. 统一消息封装

### 6.1 Chat 消息

```json
{
  "mode": "chat",
  "identity": {
    "person_id": "person_001"
  },
  "entry": {
    "channel": "ios",
    "device_id": "device_001",
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

### 6.2 Work 消息

```json
{
  "mode": "work",
  "identity": {
    "person_id": "person_001"
  },
  "entry": {
    "channel": "web",
    "device_id": "device_web_001",
    "connection_id": "conn_002"
  },
  "work": {
    "conversation_id": "conv_001"
  },
  "content": {
    "type": "text",
    "text": "继续讨论多终端入口设计。"
  }
}
```

---

## 7. 跨端连续性

### 7.1 Chat

所有个人终端共享同一个 `home_stream_id`。

```text
iOS ───────┐
Web ───────┼── HomeChatStream
Harmony ───┘
```

### 7.2 Work

所有个人终端共享同一份 Conversation 列表。

```text
Web ───────┐
iOS ───────┼── Conversation
Harmony ───┘
```

### 7.3 状态恢复优先级

```text
用户明确指定对象
→ 当前设备最后打开对象
→ 用户最近活跃对象
→ 默认 Chat
```

### 7.4 多端同时在线

服务端应支持：

- 消息实时同步；
- 已读状态同步；
- 输入状态可选同步；
- Conversation 状态同步；
- 任务执行结果同步；
- 设备来源记录。

---

## 8. Chat 每日归档

每日归档包括：

```text
原始消息
Daily Summary
Decisions
Tasks
Preferences
Facts
Project Updates
Memory Candidates
Active Context Capsule
```

归档不是删除。

原始消息完整保留，模型运行时只加载：

```text
Profile
+ Active Context Capsule
+ 必要长期记忆
+ 最近消息
```

归档边界由以下因素共同决定：

- 用户时区；
- 自然日；
- 静默时间；
- 当前是否仍在连续对话。

---

## 9. Chat 与 Work 转换

### 9.1 Chat 转 Work

当日常讨论形成明确事项时，创建 Conversation。

转换包至少包含：

```text
标题
目标
相关消息片段
确认结论
待解决问题
相关文件
```

### 9.2 Work 回流 Chat

Work 只向个人助理同步：

```text
当前状态
阶段结论
未完成任务
风险
待用户确认项
```

不能把完整 Work 历史直接注入 Chat。

---

## 10. 输出适配

同一 Agent 结果需要经过终端输出适配层。

| 终端 | 输出策略 |
|---|---|
| Web | 完整文本、表格、文件、操作面板 |
| iOS | 小屏友好、卡片化、可快速操作 |
| HarmonyOS | 与 iOS 基本一致，逐步增强多设备接续 |
| DIY 语音 | 简短、口语化、必要时分轮播报 |
| DIY 小屏 | 状态、关键结果、确认按钮 |

---

## 11. 隐私与权限

### 11.1 个人终端

可信个人设备可默认访问：

- 个人 Chat；
- Work 列表；
- 私人提醒；
- 个人记忆相关结果。

### 11.2 家庭共享终端

共享终端默认不能直接恢复私人 Work。

需要：

```text
识别 Person
→ 判断权限
→ 必要时二次确认
```

身份不明确时，只允许：

- 家庭公共事务；
- 非敏感查询；
- 访客模式。

---

## 12. 异常与离线原则

所有终端统一处理：

- 网络断开；
- 消息发送失败；
- 重复发送；
- 多端冲突；
- Agent 暂不可用；
- 设备解绑；
- 身份失效；
- Conversation 已归档；
- 文件上传中断。

每条用户消息需要唯一 `client_message_id`，避免重试产生重复消息。

---

## 13. 第一版开发边界

### 必须完成

- 统一身份；
- EntryBinding；
- Chat / Work 对象模型；
- 终端能力描述；
- 多端同步；
- Web、iOS、HarmonyOS 的基础 Chat / Work；
- DIY 个人设备预绑定；
- Chat 每日归档；
- Work Conversation；
- 输出适配。

### 暂缓

- 高级声纹识别；
- 完整公共终端多用户体验；
- 自动项目图谱；
- 跨设备拖拽；
- 自动复杂话题拆分；
- 多 Agent 可视化编排；
- 完整离线 Agent。

---

## 14. 统一验收标准

### 身份

- 同一用户在不同终端解析到同一 `person_id`；
- 更换手机号不影响 Person、Chat、Work 和记忆；
- 解绑后设备不能继续访问私人数据。

### Chat

- 多端消息一致；
- 默认进入同一 HomeChatStream；
- 每日归档后仍可自然承接；
- 原始消息可追溯。

### Work

- Conversation 列表跨端一致；
- 同一个 Conversation 可跨端继续；
- Work 结果可以回流 Chat；
- 不同 Conversation 上下文不串线。

### 终端适配

- 不同终端收到适合自身能力的输出；
- 受限终端不暴露不适合显示的敏感信息；
- 所有端均可明确知道当前作用对象。

---

## 15. 稳定结论

```text
统一的是身份、状态、Chat、Conversation 和记忆
差异化的是交互方式、信息密度和终端职责
```

最终原则：

> `family-ai-platform` 采用 1+N 多终端架构。统一平台负责身份、Chat、Work、记忆、任务和 Agent 路由；各终端只负责以适合自身场景和能力的方式接入同一用户状态。
