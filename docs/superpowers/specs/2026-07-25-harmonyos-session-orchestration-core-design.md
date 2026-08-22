# HarmonyOS Session Orchestration Core Design

- 日期：2026-07-25
- 状态：已批准，接续 HarmonyOS Mobile Entry Foundation
- 分支：`feat/harmonyos-mobile-entry-foundation`
- PR：#26

## 1. 目标

在接入 DevEco、Network Kit 和 Asset Store Kit 之前，先冻结可独立验证的移动入口会话编排：

```text
GatewayTransport Port
→ MobileGatewayClient
→ SessionManager
→ CredentialStore Port
→ AppCoordinator / ArkUI（后续）
```

该核心负责 Gateway 请求语义、严格响应解析、Session 恢复与续期、离线和撤销判定、logout 与 unbind 生命周期；HarmonyOS 系统适配只负责实际网络和安全存储。

## 2. 方案选择

### 方案 A：核心直接调用 Fetch / HTTP

不采用。HarmonyOS 正式实现需要 Network Kit，直接依赖浏览器或 Node Fetch 会把平台实现泄漏到业务层。

### 方案 B：Transport Port + 纯核心 Client（采用）

```ts
interface GatewayTransport {
  send(input: {
    baseURL: string;
    request: GatewayRequest;
  }): Promise<GatewayTransportResponse>;
}
```

核心组装方法、路径和认证 Header，Transport 只执行请求并返回 HTTP 状态和已解析 JSON 值。测试使用内存 Transport；H0B 再提供 Network Kit Adapter。

### 方案 C：只声明接口，不实现核心 Client

不采用。它无法提前验证 Header 隔离、错误映射、严格解码和 logout 认证语义。

## 3. 文件边界

```text
clients/harmonyos/core/src/
├── gatewayClient.ts
├── credentialStore.ts
└── sessionManager.ts

clients/harmonyos/core/test/
├── gatewayClient.test.ts
└── sessionManager.test.ts
```

### 3.1 `gatewayClient.ts`

职责：

- 校验 Gateway HTTPS Origin；
- 根据 `MOBILE_ENDPOINTS` 使用唯一认证方式；
- Portal 使用 Entry Session；
- renew、logout、unbind 使用 Device Credential；
- Entry 与 Device Header 永不混合；
- 2xx 响应通过既有严格 parser；
- 非 2xx 响应只通过稳定 Mobile Gateway Error code 映射；
- Transport timeout / unreachable 与 malformed response 分开处理。

不负责：

- 保存凭据；
- 判断何时 renew；
- UI 状态；
- 日志记录原始凭据。

### 3.2 `credentialStore.ts`

只定义窄 Port：

```ts
interface MobileCredentialStore {
  gatewayProfile(): Promise<GatewayProfile | null>;
  deviceAuthorization(): Promise<DeviceAuthorization | null>;
  session(): Promise<EntrySessionCredential | null>;
  replaceSessionAtomically(session: EntrySessionCredential): Promise<void>;
  clearSession(): Promise<void>;
  clearDeviceAndSession(): Promise<void>;
}
```

Asset Store 与 Preferences 的真实实现留给 H0B。核心测试使用内存实现，但生产目录不提供不安全的明文持久化实现。

### 3.3 `sessionManager.ts`

职责：

```text
restore
validSession
logout
unbind
serialized renew
```

## 4. 恢复状态机

```text
无 Gateway 或 Device
→ needsPairing

有有效 Session
→ fetch Portal Context
→ authenticated

无 Session / Session 已过期
→ Device renew
→ 原子替换 Session
→ fetch Portal Context

Portal 返回 ENTRY_SESSION_EXPIRED / ENTRY_SESSION_INVALID
→ Device renew 一次
→ 再 fetch 一次

Transport timeout / unreachable
→ offline
→ 不清除任何授权

DEVICE_REVOKED
→ clearDeviceAndSession
→ revoked

Malformed response / unsupported state
→ 抛出配置或协议错误
```

## 5. 并发续期

一个进程内同时发生多个续期需求时，只允许一个真实 renew 请求：

```ts
private renewalTask: Promise<EntrySessionCredential> | null
```

后续调用复用同一个 Promise。成功或失败后必须释放该引用，允许下一次独立续期。

## 6. logout 与 unbind

### logout

Gateway 的当前正式语义是 Device Credential：

```text
POST /api/v1/mobile/session/logout
Authorization: Device <deviceCredential>
X-Device-Ref: <deviceRef>
```

成功后：

```text
clearSession
保留 Gateway + Device Credential + installationId
```

`DEVICE_REVOKED` 表示设备已到达更强的终止状态，客户端清除 Device + Session。

### unbind

```text
DELETE /api/v1/mobile/device
Device Credential
```

成功或服务器已经返回 `DEVICE_REVOKED` 时：

```text
clearDeviceAndSession
```

timeout / unreachable 时不能本地假装已经解绑。

## 7. 错误模型

```ts
type GatewayClientErrorKind =
  | "timeout"
  | "unreachable"
  | "invalid_response"
  | "insecure_gateway"
  | "server";
```

`server` 携带 `MobileGatewayErrorCode`，状态决策从不检查本地化 message。

Transport 只允许抛出：

```text
timeout
unreachable
```

其他 Transport 异常映射为 `invalid_response`，避免把底层异常细节传到 UI 或日志。

## 8. 测试要求

### GatewayClient

- Portal 的 Entry Header；
- renew / logout / unbind 的 Device Header；
- Public 与两类认证 Header 不混用；
- 方法和路径准确；
- 2xx 严格解析；
- 稳定 server code 映射；
- malformed success / error 返回 `invalid_response`；
- timeout / unreachable 保持独立；
- 不安全 Gateway 在 Transport 之前失败。

### SessionManager

- 无 Device 返回 `needsPairing`；
- 有效 Session 直接恢复；
- 过期或缺失 Session 续期；
- Portal Session 失效时只续期一次；
- 并发续期合并为一个请求；
- 离线不清凭据；
- Device revoke 清全部授权；
- logout 只清 Session；
- logout 使用 Device Credential，不依赖现存 Session；
- unbind 成功或已撤销时清全部授权；
- unbind 网络失败时保留授权。

## 9. 范围限制

本阶段不包含：

- Network Kit Adapter；
- Asset Store Adapter；
- PairingManager；
- ArkUI 页面；
- HAP 构建；
- Chat / Work / Sync 客户端；
- 修改 iOS；
- 合并 PR #27。

## 10. 完成定义

- 新核心模块全部有先失败后通过的测试；
- strict TypeScript typecheck 通过；
- HarmonyOS Core CI、Repository CI、Secret Scan 通过；
- PR #26 继续保持 Draft；
- 与 PR #14、#25、#27 文件交集为零。
