# Family AI Platform 深度 Review

- 日期：2026-07-21
- 范围：Gateway Foundation、Chat / Work 架构、1+N 多终端文档及稳定讨论结论
- 结论类型：阶段性 Review，不替代 `docs/architecture/` 的权威规范

## 1. 总体判断

项目已经形成两块有效资产：

1. **产品架构方向**：统一 Person、Chat / Work 双模型、EntryBinding、多终端共享对象；
2. **Gateway Foundation 技术内核**：协议、Provider Adapter、认证、幂等、事务、SQLite、重启恢复和 Docker 验收。

当前主要缺口是二者之间的正式领域底座：

```text
Family
Person
Identity
EntryBinding
Device / DeviceBinding
AssistantAssignment
HomeChatStream
DailyEpisode
WorkConversation
Event / Sync
```

因此下一阶段不应直接扩大终端开发，而应先把 Foundation 的最小测试对象升级为正式领域对象。

## 2. 保留项

以下内容可以继续作为平台技术内核：

- Node / TypeScript workspace；
- `packages/contracts`；
- `packages/provider-adapter-sdk`；
- Fastify Gateway；
- SQLite migration；
- Token Hash 与设备认证；
- member + Agent 会话隔离的安全思想；
- 授权先于幂等；
- 相同 Key 不同请求冲突；
- Provider 失败不缓存；
- 消息、Provider Session 和幂等记录事务写入；
- 服务重启后历史与 Provider Session 恢复；
- Docker 回环暴露、只读文件系统和非 root 运行；
- 一键自动验收和目标主机人工验收。

## 3. 当前模型与目标模型的差距

Foundation 当前近似：

```text
Device
→ Member
→ Default Agent
→ Conversation
→ Message
```

目标平台需要：

```text
Family
└── Person
    ├── Identity / EntryBinding
    ├── Device / DeviceBinding
    ├── AssistantAssignment
    ├── HomeChatStream / DailyEpisode
    └── WorkConversation
```

所以 `members`、`member_agent_bindings` 和当前 `conversations` 应视为 Foundation 验收模型，不直接作为正式产品模型扩展。

## 4. P0：开始新开发前处理

### 4.1 锁文件和运行版本一致性

当前工程规范要求提交新仓库自身生成的 `package-lock.json`。新的开发分支开始前应确认：

- `package-lock.json` 已进入 `main`；
- Dockerfile 和 CI 只使用 `npm ci`；
- Node 运行版本与 `@types/node` 主版本一致；
- 缺少锁文件时质量门禁直接失败。

### 4.2 Development / Test / Production 组合根分离

当前 Foundation 面向 development 验收。正式开发前应明确：

- production 不运行测试 bootstrap；
- production 不默认创建 Fake Provider；
- 未配置真实认证与 Provider Registry 时 production 拒绝启动；
- development-only 验收台不进入正式 Member Web。

### 4.3 公开错误协议对齐

`contracts` 中的 Public Error 与 Gateway 实际 HTTP 错误结构应统一，至少包含：

```text
code
category
message
retryable
```

客户端据此判断重试、重新认证、权限提示和 Provider 不可用状态。

## 5. P1：领域底座阶段处理

### 5.1 客户端不能决定 Person

原始消息示例包含 `person_id`，但正式实现中客户端只能提交设备、连接和目标对象引用。Gateway 必须从 Credential、EntryBinding 和 DeviceBinding 解析 Person。

### 5.2 Chat 不永久绑定 Provider

HomeChatStream 归属于 Person。AssistantAssignment 决定当前由哪个个人助理角色、Agent 和 Provider 承接。更换实现不能分裂 Chat 历史。

### 5.3 Provider Session 不是 Source of Truth

平台消息、事件、摘要和 Context Snapshot 是权威。外部 Provider Session 只用于短期连续性和性能优化，失效后必须可以重建。

### 5.4 Chat 与 Work 共用基础设施但保持业务分离

可以引入技术父对象 `InteractionThread`，共享消息序列、事件、附件和 Provider Context Session；但 HomeChatStream 与 WorkConversation 的生命周期、归档和产品语义保持独立。

### 5.5 多端同步需要事件骨架

正式多端开发前需要：

```text
domain_events
outbox_events
device_sync_cursors
```

第一版使用 SQLite Outbox + SSE 即可，不需要 Kafka 或微服务。

## 6. 单 Gateway 并发修正

早期 Review 曾指出进程内 Conversation Queue 无法覆盖多实例。经进一步确认，第一版明确只运行一个 Gateway 实例，因此该问题不是近期阻断项。

当前正确判断：

- 单 Gateway 是部署和业务权威；
- 不同 Conversation 已可并行；
- 同一 Conversation 的 Provider 回合有序；
- SQLite WAL 和短事务适合家庭级第一版；
- 后续将 `conversationRef` 串行键抽象为 `lane_key / thread_id`；
- Work 内独立 Execution 继续并行；
- 不为假设中的多副本提前引入分布式锁。

## 7. 正确开发顺序

### 阶段 0：Foundation Hardening

- 依赖锁与运行版本；
- 环境组合根；
- Public Error；
- Provider 运行时校验；
- 正式架构文档进入 `main`。

### 阶段 1：Identity & Family

```text
Family
Person
FamilyMembership
Identity
EntryBinding
Device
DeviceBinding
AssistantAssignment
```

### 阶段 2：Chat / Work

```text
InteractionThread
HomeChatStream
DailyEpisode
WorkConversation
Message Origin
Chat → Work
Work → Chat
```

### 阶段 3：Concurrency / Sync

```text
Thread Sequence
Lane Scheduler
Operation / Execution
Outbox
SSE
Sync Cursor
```

### 阶段 4：Reference Web

- Chat；
- Work；
- 家庭成员；
- 入口绑定；
- 设备；
- AssistantAssignment。

### 阶段 5 之后

```text
iOS
→ HarmonyOS
→ DIY 个人终端
→ 家庭共享终端
```

## 8. 风险排序

| 等级 | 风险 | 处理时点 |
|---|---|---|
| P0 | 把 Foundation Conversation 当作 Chat / Work 正式模型 | 新功能开发前 |
| P0 | production 仍落入测试 bootstrap / Fake Provider | 正式环境代码前 |
| P0 | 依赖锁与 Node 类型版本不稳定 | 下一代码 PR 前 |
| P1 | 客户端声明 Person | Identity API 设计时 |
| P1 | Provider Session 成为上下文权威 | 真实 Provider 接入前 |
| P1 | 缺少多端事件与同步游标 | 多终端开发前 |
| P1 | Chat 与 Work 混用一个生命周期 | Chat / Work 领域阶段 |
| P2 | 多 Gateway / 分布式锁 | 有真实扩容证据后 |
| P2 | 微服务拆分 | 模块化单体出现明确瓶颈后 |

## 9. 最终结论

> Gateway Foundation 已经形成可靠的单机消息与 Provider 技术内核，Chat / Work 和多终端文档也形成了正确的产品方向。下一阶段的关键不是增加更多页面，而是用正式的 Family、Person、Identity、EntryBinding、Device、AssistantAssignment、HomeChatStream 和 WorkConversation 把两者连接起来。平台继续采用单 Gateway、单数据库、模块化单体；输入、任务、Provider 和输出并行，只在同一上下文 Lane 内有序。
