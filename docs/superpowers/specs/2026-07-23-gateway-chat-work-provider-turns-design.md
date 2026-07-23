# Gateway Chat / Work Provider Turns 设计

- 日期：2026-07-23
- 状态：已批准
- 目标分支：`feat/gateway-chat-work-provider-turns`
- 基线：`main` @ `fb83074576793d7d4bf17cc3e31ed8c447a83d8e`
- 前置：PR #15、#16、#17 已合并

## 1. 目标

让正式 `InteractionThread` 在收到 Person 消息后调用已配置的 Provider，延续每个 Thread 自己的 Provider Context Session，并把 Assistant 回复可靠地写回同一个 Thread。

本阶段完成最小可用的同步垂直闭环：

```text
Person Message 持久化
→ 同 Thread Lane 排队
→ 解析当前 AssistantAssignment
→ 读取或建立 Thread Provider Context
→ 调用 ProviderAdapter
→ Assistant Message + External Session + Turn 状态原子提交
→ 现有消息查询接口可读取回复
```

HTTP 消息响应继续遵守 Chat / Work Contracts v1，只返回已接收的 Person `message`。Assistant 回复通过同一个 Thread 的消息列表读取；本阶段不修改公共 Contracts。

## 2. 与 PR #14 的隔离边界

本 PR 从合并 PR #17 后的最新 `main` 独立创建，不叠加在 iOS 分支上。

允许修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/database.ts
apps/gateway/src/chatWorkRoutes.ts
apps/gateway/src/chatWorkProvider.ts
apps/gateway/src/chatWorkMessageService.ts
apps/gateway/test/database.test.ts
apps/gateway/test/chatWorkProvider.test.ts
apps/gateway/test/chatWorkProviderRoutes.test.ts
docs/superpowers/specs/2026-07-23-gateway-chat-work-provider-turns-design.md
docs/superpowers/plans/2026-07-23-gateway-chat-work-provider-turns.md
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

## 3. 本阶段范围

### 包含

- SQLite Migration V5；
- 每个正式 Thread 的 Provider Context；
- `provider_conversation_ref` 到正式 Thread 的稳定映射；
- `external_session_ref` 的持久化和续接；
- 每条 Person 消息对应一个可恢复 Provider Turn；
- 同一个 Thread 内 Provider 调用有序；
- 不同 Thread 的 Provider 调用可以并行；
- Provider 成功后写入 Assistant `ThreadMessage`；
- Provider 失败后保留 Person 消息并记录失败状态；
- 相同 Person 消息重试不重复调用已成功的 Turn；
- Gateway 重启后继续使用已保存的 External Session；
- Chat 与不同 Work 各自拥有独立 Provider Context；
- Fake Provider 集成测试、失败重试测试、并发 Lane 测试和重启恢复测试。

### 不包含

- Outbox、SSE、Push 或 Sync Cursor；
- HTTP 202 异步 accepted 协议；
- 后台 Turn 恢复 Worker；
- Operation / Execution；
- 附件、多模态或多段 Assistant 消息；
- Daily Summary、Active Context Capsule；
- Member Web；
- iOS Chat / Work 接入；
- 浏览器一键验收台修改；
- Hermes/Codex 生产适配器配置。

## 4. 方案选择

### 方案 A：在消息 POST 内同步调用 Provider（采用）

优点：不修改 Contracts；能够形成可测试的端到端闭环；Provider 失败可直接返回结构化错误。缺点：HTTP 请求会等待 Provider，第二条同 Thread 消息的完成时间可能受前一轮影响。

### 方案 B：先返回 202，再通过 Outbox/SSE 回传

长期方向更理想，但需要新增 accepted/operation/event 协议和后台调度，跨越多个独立子系统，不适合本 PR。

### 方案 C：单独暴露“生成 Assistant 回复”接口

实现简单，但会把 Provider 编排责任泄露给客户端，破坏 Gateway 作为业务权威的边界，因此不采用。

## 5. 数据模型：Migration V5

### 5.1 `thread_provider_contexts`

每个 `InteractionThread` 一行：

```text
thread_ref                  PK / FK interaction_threads
person_ref                  Thread 所有者
provider_conversation_ref   稳定的 conversation:... 映射，满足 Provider v1 请求协议
assignment_ref              当前 AssistantAssignment
agent_ref                   当前 Agent
provider_profile_ref        当前 Provider Profile
external_session_ref        Provider 返回的可续接 Session，可为空
created_at
updated_at
```

稳定规则：

- Thread 所有权不由 Provider Context 决定；
- `provider_conversation_ref` 在 Thread 生命周期内稳定；
- 当前 Assignment、Agent 或 Provider Profile 发生变化时，更新 Context 并清空 `external_session_ref`；
- 更换 Provider 不创建新 Chat 或 Work。

### 5.2 `thread_provider_turns`

每条 Person 消息最多一行：

```text
user_message_ref            PK / FK thread_messages
thread_ref                  所属 Thread
invocation_ref              Provider 调用编号
correlation_ref             Provider 关联编号
idempotency_key             稳定 Provider 幂等键
assignment_ref
agent_ref
provider_profile_ref
status                      pending | succeeded | failed
attempt_count
assistant_message_ref       成功后指向 Assistant 消息
error_json                  失败时保存公开错误
requested_at
completed_at
```

约束：

- `succeeded` 必须有 `assistant_message_ref` 和 `completed_at`，且没有 `error_json`；
- `failed` 必须有 `error_json` 和 `completed_at`，且没有 Assistant 消息；
- `pending` 不得有 Assistant 消息、错误或完成时间；
- 相同 `user_message_ref` 永远不会产生两个成功 Turn。

## 6. 组件边界

### 6.1 `ChatWorkProviderRepository`

新文件 `apps/gateway/src/chatWorkProvider.ts`，只负责：

- 解析 Thread 所有权和当前 AssistantAssignment；
- 建立或刷新 Thread Provider Context；
- 准备、恢复或读取 Provider Turn；
- 失败状态写入；
- Assistant 消息、External Session 和成功 Turn 的原子提交。

它不调用 Provider，也不处理 HTTP。

### 6.2 `ChatWorkMessageService`

新文件 `apps/gateway/src/chatWorkMessageService.ts`，负责：

- 先通过现有 `ChatWorkDomainRepository.appendThreadMessage()` 保存 Person 消息；
- 以 `threadRef` 为 Lane key 排队；
- 在 Lane 内准备 Turn 并检查成功重放；
- 构造严格的 `ProviderInvocationRequest`；
- 调用并校验 `ProviderAdapter` 结果；
- 调用 Repository 提交 Assistant 回复或记录失败；
- 把 Provider 错误映射为 `GatewayDomainError`。

### 6.3 `chatWorkRoutes.ts`

消息 POST 改为调用 `ChatWorkMessageService`。返回 envelope 仍为：

```json
{
  "protocolVersion": 1,
  "message": { "...": "Person ThreadMessage" }
}
```

不把 Assistant 消息塞入未定义字段。客户端随后通过消息查询接口读取 Assistant 消息。

## 7. Provider 请求映射

正式 Thread 不能直接填入现有 Provider v1 的 `conversationRef`，因为 Provider 协议要求 `conversation:...`。Gateway 为每个 Thread 创建稳定的 `provider_conversation_ref`。

Provider 请求字段：

```text
protocolVersion      PROTOCOL_VERSION = "1.0"
invocationRef        Turn 中持久化的 invocation:...
correlationRef       Turn 中持久化的 correlation:...
idempotencyKey       基于 Thread、Person 消息和 Assignment 的稳定值
requestedAt          Turn 首次建立时间；重试保持不变
providerProfileRef   当前 Context
 targetAgentRef       当前 Context
conversationRef      provider_conversation_ref
externalSessionRef   Context 已存在时携带
content              当前 Person 消息正文
 timeoutMs            30000
```

第一版只消费 Provider 输出中的第一段文本，符合现有文本 ThreadMessage 范围；多段输出留给后续附件/多内容协议。

## 8. 顺序、并发与事务

- Person 消息先在短 SQLite 事务内保存；
- 随后进入 `thread:<thread_ref>` Lane；
- 同一个 Thread 的 Provider 调用严格串行；
- 不同 Chat / Work Thread 使用不同 Lane，可并行调用；
- Provider 网络调用绝不位于 SQLite 事务内；
- Provider 成功后，Assistant sequence 分配、Assistant 消息、External Session 和 Turn 成功状态在一个短事务内提交。

本阶段仍是同步 HTTP；“用户消息立即返回、Assistant 异步回流”由后续 Outbox/SSE PR 实现。

## 9. 幂等、失败和恢复

### 成功重放

相同 `clientMessageId` 和相同逻辑 Person 消息再次提交时：

- 现有 Domain Repository 返回原 Person 消息；
- 如果对应 Provider Turn 已成功，不再次调用 Provider；
- 不创建第二条 Assistant 消息。

### Provider 失败

- Person 消息保留；
- Turn 标记为 `failed`，保存结构化错误；
- HTTP 返回 502，超时返回 504；
- retryable 信息沿用 Provider 错误；
- 客户端重试同一消息时，Turn 回到 `pending` 并再次调用 Provider，不重复 Person 消息。

### Gateway 重启

- `pending` 或 `failed` Turn 在同一消息被重试时可恢复；
- 已成功 Turn 不重复调用；
- 后续新消息读取保存的 `external_session_ref`，延续 Provider 上下文。

本 PR 不主动扫描和恢复无人重试的 pending Turn。

## 10. Assistant 消息来源

Assistant 消息由 Gateway 构造：

```text
actor.type                 assistant
actor.assignmentRef        Turn Context
actor.agentRef             Turn Context
actor.providerProfileRef   Turn Context
origin.deviceRef           null
origin.connectionRef       null
origin.entryAudience       personal
clientMessageId            assistant:<user_message_ref>
occurredAt                 Provider completedAt
```

客户端无权提交这些字段。

## 11. 错误规则

- 无活动 AssistantAssignment：`ASSISTANT_ASSIGNMENT_UNAVAILABLE`，503，availability，retryable；
- Provider 返回 failed/cancelled：使用 Provider PublicError，502；
- Provider timed_out：504；
- Provider 返回不符合协议、没有文本输出或成功时缺少 External Session：`PROVIDER_RESPONSE_INVALID`，502，internal，retryable；
- 既有 Entry Session、Person、Thread 和 PublicError 边界保持不变。

## 12. 测试与验收

自动测试至少覆盖：

1. Migration V5 只执行一次且外键完整；
2. 首条 Chat 消息产生 Person + Assistant 两条有序消息；
3. 第二轮请求携带第一轮 External Session；
4. Chat 和两个 Work 的 Provider Context 相互独立；
5. 同一 Person 消息成功重试不增加 Provider 调用或消息；
6. Provider 第一次失败、第二次成功时 Person 消息不重复；
7. 同一 Thread 的 Provider 调用串行；
8. 不同 Thread 的 Provider 调用可以并行；
9. Gateway 重启后下一轮继续旧 External Session；
10. Assistant 消息记录真实 Assignment、Agent 和 Provider Profile；
11. Provider 无效结果返回通用 PublicError；
12. 所有现有 Gateway、Mobile Entry 和 Contracts 测试不回归；
13. PR #14 与本 PR 文件路径交集为零。

验收命令：

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

## 13. 后续顺序

本 PR 合并后，下一条独立 PR 再建设：

```text
Outbox + domain_events
→ SSE 订阅
→ Device Sync Cursor / 断线补拉
→ 正式 Member Web
```

在 PR #14 真机验收完成前，后续 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
