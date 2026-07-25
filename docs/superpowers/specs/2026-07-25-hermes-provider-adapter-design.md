# Hermes Provider Adapter 设计

- 日期：2026-07-25
- 分支：`feat/hermes-provider-adapter`
- 目标 PR：#26
- 基线：`main` @ `d3e4d2302bf9f0329b3205a07282adb9aaf46ec3`

## 1. 目标

让 Family AI Gateway 通过正式 `ProviderAdapter` 边界调用一个或多个 Hermes Profile，同时保留现有 Person、Assignment、Thread、幂等、Provider Turn、SQLite 与同步链路。

```text
Member Web / Mobile
→ Family AI Gateway
→ ProviderAdapterRouter
   ├── provider-profile:fake-local → FakeProviderAdapter（仅 test/development）
   └── provider-profile:hermes-*   → HermesProviderAdapter
→ Hermes Profile API Server
```

本 PR 只建设通用 Adapter 与运行时组合，不改变任何 Family Manager 或 Personal Assistant Assignment。Jarvis / 于途绑定在后续独立 PR 完成。

## 2. 核心边界

### Gateway 继续拥有

- Person、Family、Device、Entry 与权限；
- Home Chat、Work、Thread Message 与顺序；
- Provider Conversation、Turn、幂等与失败重试；
- SSE、Device Sync、IndexedDB 投影协议；
- Provider Profile 与 Agent Assignment。

### Hermes 只负责

- 使用 Profile 自己的 SOUL、记忆、技能与工具；
- 执行单次 Agent Turn；
- 返回最终用户可见文本；
- 使用指定 Hermes Session 延续同一 Thread 的内部上下文。

Web、iOS 与其他客户端不得直接持有 Hermes API Key，也不得绕过 Gateway 调用 Hermes。

## 3. Hermes API 选择

第一版使用 Hermes OpenAI-compatible API Server：

```http
POST /v1/chat/completions
GET  /v1/models
```

调用固定为非流式：

```json
{
  "model": "<profile model name>",
  "messages": [
    { "role": "user", "content": "<current ThreadMessage text>" }
  ],
  "stream": false
}
```

请求头：

```text
Authorization: Bearer <API_SERVER_KEY>
Content-Type: application/json
Idempotency-Key: <Gateway Provider Turn idempotencyKey>
X-Hermes-Session-Id: <stable external session ref>
X-Hermes-Session-Key: <profile memory scope>
```

`X-Hermes-Session-Id` 用于同一 Chat / Work 的 Hermes Session 延续；`X-Hermes-Session-Key` 用于同一受控 Agent Profile 的长期记忆范围。

## 4. Session 映射

Family AI 已为每个 Thread 保存稳定 `providerConversationRef`。Hermes Adapter 根据以下事实确定稳定 Session：

```text
providerProfileRef
+ providerConversationRef
→ SHA-256
→ external-session:hermes-<digest>
```

规则：

- 第一次调用即确定 Session Ref；
- 同一次逻辑消息重试使用相同 Session Ref 和 Idempotency-Key；
- Gateway 重启后从 `thread_provider_contexts.external_session_ref` 恢复；
- Chat 与每个 Work 使用不同 Session；
- Assignment / Provider Profile 切换时，现有 Repository 会清除旧 External Session；
- Adapter 不信任 Hermes 返回的任意 Session 标识，不把上游私有路径或凭据写入 SQLite。

## 5. Provider 配置文件

Gateway 从 Git 忽略的运行时 JSON 读取 Hermes Profile：

```text
.runtime/config/providers.json
```

正式 Schema：

```json
{
  "version": 1,
  "profiles": [
    {
      "kind": "hermes",
      "providerProfileRef": "provider-profile:hermes-example",
      "baseUrl": "http://host.docker.internal:8650",
      "apiKey": "runtime-secret",
      "model": "example",
      "sessionKey": "family-ai:hermes:example"
    }
  ]
}
```

约束：

- `version` 必须为 `1`；
- Profile Ref 必须唯一；
- `baseUrl` 只允许 `http:` 或 `https:`；
- URL 不允许 username、password、query 或 fragment；
- `apiKey` 不得为空，且不会写入日志、数据库、HTTP 响应或 Git；
- `model` 与 `sessionKey` 必须为非空、无控制字符的短字符串；
- production 必须提供至少一个真实 Profile；
- production 绝不注册 Fake Provider；
- development 未提供文件时继续使用 Fake Provider；
- development 提供文件时使用 Router，同时保留 Fake Provider 供未迁移成员使用。

## 6. Adapter 类

### `HermesProviderAdapter`

构造：

```ts
new HermesProviderAdapter({
  profiles: HermesProviderProfileConfig[],
  fetchImpl?,
  clock?
})
```

职责：

- 按 `providerProfileRef` 选择 Hermes Profile；
- 建立稳定 Hermes Session；
- 发送 Bearer、Session、Memory Scope 与 Idempotency 请求头；
- 使用 `request.timeoutMs` 创建 AbortSignal；
- 解析 OpenAI Chat Completion；
- 转换为 `ProviderInvocationResult`；
- 不抛出可预期上游错误，而是返回正式 failed / timed_out 结果；
- 只在编程错误时抛出异常。

### `ProviderAdapterRouter`

构造：

```ts
new ProviderAdapterRouter([
  { providerProfileRefs: ["provider-profile:fake-local"], adapter: fake },
  { providerProfileRefs: ["provider-profile:hermes-a"], adapter: hermes }
])
```

职责：

- 一个 Provider Profile 只能属于一个 Route；
- 未注册 Profile 返回 `PROVIDER_PROFILE_UNAVAILABLE`；
- `health()` 合并各 Adapter 的状态与 Profile 列表；
- 不允许静默回退到另一个 Profile。

## 7. 响应映射

Hermes 成功响应要求：

```text
HTTP 2xx
object = chat.completion（可选校验）
choices[0].message.content = 非空字符串
```

转换为：

```ts
{
  protocolVersion: "1.0",
  invocationRef,
  correlationRef,
  status: "succeeded",
  completedAt,
  output: [{ type: "text", text }],
  externalSessionRef
}
```

不执行正文 `trim` 改写；只使用 `trim()` 判断是否为空。

## 8. 错误映射

| 上游情况 | Provider 状态 | Code | Category | Retryable |
|---|---|---|---|---|
| Abort / 超时 | `timed_out` | `HERMES_TIMEOUT` | `timeout` | true |
| DNS、连接、网络异常 | `failed` | `HERMES_UNAVAILABLE` | `availability` | true |
| HTTP 401 / 403 | `failed` | `HERMES_AUTH_FAILED` | `permission` | false |
| HTTP 408 / 429 | `failed` | `HERMES_BUSY` | `availability` | true |
| HTTP 5xx | `failed` | `HERMES_UNAVAILABLE` | `availability` | true |
| 其他 HTTP 4xx | `failed` | `HERMES_REQUEST_REJECTED` | `validation` | false |
| 非 JSON / 缺少文本 | `failed` | `HERMES_RESPONSE_INVALID` | `internal` | true |
| 未注册 Profile | `failed` | `PROVIDER_PROFILE_UNAVAILABLE` | `availability` | true |

错误消息不得包含 API Key、完整上游响应、路径、工具输出或异常堆栈。

## 9. Health

`HermesProviderAdapter.health()` 对每个 Profile 调用：

```http
GET /v1/models
Authorization: Bearer <API_SERVER_KEY>
```

状态：

- 所有 Profile 可访问且广告模型匹配：`online`；
- 部分 Profile 失败：`degraded`；
- 全部 Profile 失败：`offline`。

返回的 `providerProfiles` 始终是本 Adapter 注册的 Profile Ref，不暴露 URL、Model 或 Key。

## 10. Gateway 运行时组合

新增：

```text
apps/gateway/src/providerRuntime.ts
```

入口流程：

```text
loadGatewayConfig()
→ loadRuntimeProviderAdapter()
→ buildGatewayApp({ providerAdapter })
```

`GATEWAY_PROVIDER_CONFIG_PATH` 指向容器内配置文件。production 只有在真实配置可读、合法且至少包含一个 Hermes Profile 时才允许启动。

## 11. Docker / Linux 主机网络

Gateway 保持现有 bridge 网络和 `127.0.0.1:8790` 发布方式。Compose 增加：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
volumes:
  - ./.runtime/config:/app/.runtime/config:ro
```

Hermes Profile API Server 应绑定 Docker Host Gateway 对应的主机接口，而不是公开暴露到浏览器。API Key 始终必需。

## 12. 安全边界

禁止：

- 把 API Key 写入仓库、SQLite、日志或错误消息；
- Web 直接调用 Hermes；
- Hermes 响应覆盖 Gateway 的 Person / Agent / Assignment；
- Provider Profile 不匹配时回退到别的 Agent；
- production 自动启用 Fake Provider；
- 把 Hermes 原始异常或完整响应正文传给用户。

## 13. 本 PR 范围

允许修改：

```text
packages/provider-adapter-sdk/src/**
packages/provider-adapter-sdk/test/**
apps/gateway/src/config.ts
apps/gateway/src/index.ts
apps/gateway/src/providerRuntime.ts
apps/gateway/test/config.test.ts
apps/gateway/test/providerRuntime.test.ts
compose.yaml
scripts/dev-up.sh
docs/superpowers/**
docs/development/**
```

明确不修改：

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/familyDomain.ts
```

## 14. 验证标准

1. Hermes 请求携带正确 Bearer、Session、Session Key 与 Idempotency-Key；
2. 不同 Thread 生成不同 Hermes Session；
3. 相同 Provider Conversation 重试生成相同 Session；
4. 成功响应准确映射；
5. 401、429、5xx、超时、网络错误和非法响应准确映射；
6. Router 不跨 Profile 回退；
7. Health 不泄露配置；
8. development 无配置继续 Fake；
9. development 有配置同时支持 Fake 与 Hermes；
10. production 无配置拒绝启动；
11. production 有合法 Hermes 配置可启动；
12. Docker 配置可以从容器访问宿主机 Hermes；
13. Secret Scan、Repository CI、typecheck 与 build 全部通过；
14. 与 PR #14 的 changed-path 交集为零。
