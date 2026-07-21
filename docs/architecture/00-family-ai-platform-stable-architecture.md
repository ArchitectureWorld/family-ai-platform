# Family AI Platform 稳定总架构

- 状态：稳定基线
- 日期：2026-07-21
- 适用仓库：`ArchitectureWorld/family-ai-platform`

## 1. 产品定义

`family-ai-platform` 是家庭成员、个人助理 Agent、家庭总管、执行 Agent Team 与多类终端之间的统一接入和状态管理平台。

平台唯一的服务端业务权威是：

```text
Family AI Gateway
```

Gateway 负责：

- Family / Person 与身份解析；
- 入口账号和设备绑定；
- 个人助理绑定与受控 Agent 路由；
- Chat / Work 对象与消息管理；
- 多终端同步；
- 权限、隐私和设备能力判断；
- Provider Adapter 调用；
- 任务、事件、通知和输出分发。

Hermes、Codex、OpenClaw Agent Team 等位于 Gateway 后方，不自行承担平台身份、会话和多终端状态权威。

## 2. 一个平台，一个 Gateway

第一版及可预见的家庭自部署阶段采用：

```text
1 个逻辑 Gateway
1 个物理 Gateway 实例 / 容器
1 个主要数据库
N 个终端连接
N 个 Person
N 个 Chat / Work
N 个 Agent / Provider
```

不按终端、成员、Agent 或 Provider 分裂 Gateway。

错误方式：

```text
Web Gateway
Mobile Gateway
DIY Gateway
Hermes Gateway
```

正确方式：

```text
Web ───────────┐
iOS ───────────┤
HarmonyOS ─────┼── Family AI Gateway ── Provider Adapters ── Hermes / Codex / OpenClaw
DIY ───────────┤
Admin Web ─────┘
```

第一版继续使用模块化单体，不引入微服务、Kubernetes、Redis 分布式锁或多副本部署。

## 3. 单 Gateway 不等于串行系统

Gateway 必须同时处理多个连接、输入、会话、任务、Provider 调用和终端输出。

并发原则：

```text
不同 Person：并行
同一 Person 的 Chat 与不同 Work：并行
不同 Work Conversation：并行
不同执行任务：并行
文件处理、通知和终端输出：并行
同一连续上下文线程的 Agent 回合：有序
```

稳定处理流程：

```text
并行接收输入
→ 服务端解析身份与权限
→ 消息 / 命令快速落库
→ 按最小一致性范围分配执行 Lane
→ 不同 Lane 并行调用 Agent / Provider
→ 同一 Lane 内有序提交上下文
→ 并行向终端推送状态和结果
```

局部串行键应对应需要连续上下文的对象，例如：

```text
chat:<home_stream_id>
work:<conversation_id>
execution:<execution_id>
```

不得对整个 Gateway 加全局串行锁。

## 4. 统一对象，而不是统一界面

所有终端共享同一套服务端对象：

```text
Family
└── Person
    ├── Identities
    ├── EntryBindings
    ├── Devices / DeviceBindings
    ├── AssistantAssignment
    ├── HomeChatStream
    ├── WorkConversations
    ├── PersonalMemory
    ├── Tasks
    └── Permissions
```

终端只负责差异化：

- 输入方式；
- 输出形式；
- 页面结构；
- 信息密度；
- 设备能力；
- 隐私级别；
- 交互深度。

终端不能各自维护独立身份、Chat、Conversation、记忆或任务状态。

## 5. 身份、连接、对话和记忆必须分离

稳定概念边界：

```text
Person
= 家庭成员的永久内部身份

Identity / EntryBinding
= 外部账号、手机号或凭证如何解析到 Person

Device / Connection
= 用户从哪个设备、入口或连接进入

Chat
= 一个人唯一的长期日常对话流

Work Conversation
= 一个明确事项的独立工作上下文

Memory
= 长期事实、偏好、认知和结构化知识

Provider Session
= Provider 侧短期连续性缓存，不是真相来源
```

手机号只用于首次认领、恢复和重新绑定，不作为永久内部主键。

客户端不得通过消息字段自行声明并决定 `person_id`。Gateway 必须依据已认证的入口凭证或设备凭证，通过 `EntryBinding` 在服务端解析 Person。

## 6. Chat / Work 双模式

### 6.1 Chat

```text
一个 Person
一个有效 HomeChatStream
所有个人终端共享
通过 DailyEpisode 分段归档
```

Chat 负责日常、临时、轻量和连续交流。用户不需要新建 Chat、选择 Session 或选择 Agent。

### 6.2 Work

```text
一个 Person
多个 Work Conversation
每个 Conversation 对应一个具体事项
跨端长期推进
```

Work 负责项目设计、科研、文件分析、开发任务、长期讨论和需要执行 Agent 的复杂事项。

### 6.3 相互转换

Chat 转 Work 时生成结构化转换包，不复制全部 Chat 历史：

- 标题；
- 目标；
- 相关消息片段；
- 已确认结论；
- 待解决问题；
- 相关文件。

Work 回流 Chat 时只同步：

- 当前状态；
- 阶段结论；
- 未完成任务；
- 风险；
- 待用户确认项。

## 7. 原始数据与 Provider 状态

平台数据库中的消息、事件、摘要和结构化上下文是真相来源。

```text
Platform Message / Context Store
= Source of Truth

Provider external_session_ref
= 可丢失、可重建的运行优化
```

真实 Provider Session 可能过期、截断、删除或因模型切换失效。平台必须能够依据原始消息、Context Summary 和 Active Context Capsule 重建 Provider 上下文。

## 8. 多终端策略

```text
Web
= 全功能个人工作台 + 家庭管理入口

iOS
= 第一优先个人随身入口，默认 Chat，轻量 Work，通知与现场采集

HarmonyOS
= 与 iOS 同级，第一版先保持产品一致，再逐步增强多设备接续

DIY Hardware
= 语音优先、场景化、能力受限的个人或家庭共享入口
```

DIY 设备通过统一 Gateway 接入，不直接连接 Hermes：

```text
DIY Device
→ Device / Entry Resolve
→ Chat or Work
→ Personal Assistant
→ Terminal Output Adapter
```

## 9. 当前 Gateway Foundation 的定位

已经合入 `main` 的 Gateway Foundation 提供：

- Node / TypeScript workspace 基线；
- `contracts`；
- `provider-adapter-sdk`；
- Fastify Gateway；
- SQLite migration；
- 设备 Token Hash 认证；
- Conversation / Message 基础能力；
- Provider Session 持久化；
- 授权、幂等、事务和重启恢复；
- Docker 本机安全边界和一键验收。

Foundation 是可保留的技术内核，但当前对象：

```text
members
devices
member_agent_bindings
conversations
```

属于第一阶段验证模型，不等同于正式的 Family / Person / Identity / EntryBinding / Chat / Work 领域模型。

## 10. 下一开发阶段的前置顺序

在开发正式 Web、iOS、HarmonyOS 或 DIY 业务前，先完成：

```text
Foundation Hardening
→ Family / Person / Identity / EntryBinding / Device / AssistantAssignment
→ HomeChatStream / DailyEpisode / WorkConversation
→ 并行输入输出与异步事件骨架
→ Web 参考入口与最小管理能力
→ iOS
→ HarmonyOS
→ DIY
```

下一阶段仍应坚持最小闭环，不同时展开所有子系统。

## 11. 第一版明确不做

- 多 Gateway 副本和高可用集群；
- 微服务拆分；
- Kafka 等消息基础设施；
- 高级声纹和自动多人识别；
- 完整知识图谱；
- 多 Agent 可视化编排；
- 完整离线 Agent；
- 公网正式部署与复杂组织级 RBAC。

## 12. 最终稳定结论

> Family AI Platform 采用单实例、模块化单体 Gateway。所有成员、终端、Chat、Work、任务和 Agent 都接入这一唯一业务权威。Gateway 对输入、读取、不同上下文、任务执行、Provider 调用和终端输出进行并发处理，仅在同一个需要连续上下文的 Chat Stream、Work Conversation 或执行资源内部保持有序。平台统一的是身份、状态和领域对象，终端差异化的是交互方式与输出能力。
