# Family AI Platform Foundation Design

**状态：** 已确认  
**日期：** 2026-07-21

## 1. 产品定义

Family AI Platform 是一个产品。Family AI Gateway 是唯一业务后端和数据权威；Member Web、Admin Web、iOS、HarmonyOS 和后续终端都是 Gateway 的客户端。Admin Entry 是最高权限入口，不是第二套后台。

```text
Member/Admin/Devices
        ↓
Family AI Gateway
        ↓
gateway.sqlite
        ↓
Provider Adapter SDK → Hermes / Codex
```

## 2. 旧平台边界

新平台数据库从空库开始，不迁移旧平台的用户、角色、Agent 配置、会话、消息、附件、设备、Session、Token、Provider 配置、运行配置和审计数据。

旧仓库 `ArchitectureWorld/family-ai-platform-legacy` 只作为只读代码、测试场景和交互参考。旧代码可以经过独立 Review 后选择性复用；禁止整体合并旧 Gateway 分支、复制旧 Control Center 后端、复制旧数据库 Schema 或建立旧数据兼容层。

## 3. 目标结构

```text
apps/
  gateway/
  member-web/
  admin-web/
packages/
  contracts/
  provider-adapter-sdk/
docs/
```

第一阶段只创建实际使用的 `apps/gateway`、`packages/contracts` 和 `packages/provider-adapter-sdk`。

## 4. 第一阶段闭环

```text
测试成员/设备
→ Gateway 认证
→ 固定成员—Agent 绑定
→ 创建会话
→ 两轮文本消息
→ Fake Provider
→ 持久化响应
→ 服务重启后恢复历史
```

技术基线：Node.js 22、TypeScript、npm workspaces、Fastify、Zod、better-sqlite3、Vitest。默认绑定 `127.0.0.1`，自动测试不得调用真实 Hermes 或 Codex。

## 5. 初始领域模型

- `members`：成员身份；
- `devices`：成员设备和 Token Hash；
- `agents`：Agent 身份；
- `member_agent_bindings`：成员与默认个人助理绑定；
- `conversations`：同时绑定 member 和 agent；
- `messages`：结构化消息；
- `provider_sessions`：会话、Agent、Provider Profile 与外部 Session 的绑定；
- `idempotency_records`：授权后的请求重放记录；
- `schema_migrations`：Schema 版本账本。

## 6. 分层

```text
HTTP Route
→ Application Service
→ Domain Policy
→ Repository / Provider Adapter
```

Route 只做协议解析和响应映射；Service 执行业务流程和事务；Domain Policy 表达权限、会话隔离和幂等规则；Repository 只做持久化。

## 7. 安全不变量

1. conversation 必须同时绑定 member 和 agent；
2. 会话读取、历史读取、消息发送和幂等重放都校验当前 member 与 agent；
3. Provider external session 不得跨 Agent/Profile 复用；
4. 授权发生在幂等缓存读取之前；
5. 幂等范围包含 device、conversation、agent、key 和规范化请求 Hash；
6. 相同 Key 不同请求返回冲突；
7. bootstrap 只创建缺失的开发数据，不覆盖业务状态；
8. Provider 子进程只接收显式环境变量 allowlist；
9. 公共响应不包含秘密、stderr、本机路径或内部数据库 ID；
10. Schema 变化使用递增 migration；
11. 默认只监听 `127.0.0.1`；
12. 自动测试只使用 Fake Provider。

## 8. 第一阶段 API

```text
GET  /health
GET  /api/v1/me
POST /api/v1/conversations
GET  /api/v1/conversations
GET  /api/v1/conversations/:conversationRef/messages
POST /api/v1/conversations/:conversationRef/messages
```

第一阶段采用测试设备 Bearer Token，数据库仅保存 SHA-256 Hash。

## 9. Provider 边界

```ts
export interface ProviderAdapter {
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  health(): Promise<AdapterHealth>;
}
```

第一阶段只实现 Fake Provider。真实 Hermes Adapter 后续独立实现，并补齐环境 allowlist、超时、输出上限、进程组终止、并发限制、取消和错误脱敏。

## 10. 测试要求

至少覆盖：认证失败、成员与 Agent 会话隔离、跨 Agent 拒绝、两轮 Provider Session 连续性、相同请求幂等重放、相同 Key 不同请求冲突、授权失败不能命中缓存、重启历史恢复、bootstrap 不覆盖状态、migration 重复打开和 Provider 错误脱敏。

## 11. 非本阶段范围

旧平台业务数据迁移、Admin RBAC、正式浏览器 Session、设备配对、附件、真实 Provider、Member/Admin Web、局域网、公网、TLS、iOS、HarmonyOS、公共语音终端、多 Agent 编排、ME-Who 和 ME-Brain。

## 12. 完成条件

`npm ci`、测试、类型检查和构建全部通过；两轮连续会话、重启恢复、跨 Agent 隔离和幂等冲突测试通过；默认监听 `127.0.0.1`；仓库不包含旧平台数据、数据库、Token 或正式绝对路径。
