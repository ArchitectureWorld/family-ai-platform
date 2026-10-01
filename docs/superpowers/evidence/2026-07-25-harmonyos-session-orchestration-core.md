# HarmonyOS Session Orchestration Core TDD Evidence

- 日期：2026-07-25
- 分支：`feat/harmonyos-mobile-entry-foundation`
- PR：#26
- 范围：Transport-independent GatewayClient、CredentialStore Port、SessionManager

## 1. 目标

在 DevEco / Network Kit / Asset Store Kit 之前，先证明以下业务行为可以脱离系统 API 稳定运行：

```text
严格 Gateway 请求与响应
→ Session 恢复
→ 缺失/过期 Session 续期
→ Portal Session 失效后续期一次
→ 并发续期合并
→ 离线保留授权
→ Device revoke 清除授权
→ Device-authenticated logout / unbind
```

## 2. GatewayClient RED

先提交：

```text
clients/harmonyos/core/test/gatewayClient.test.ts
```

测试预先要求不存在的：

```text
GatewayTransport
MobileGatewayClient
GatewayTransportError
GatewayClientError
```

覆盖：

- Portal 使用 Entry Session；
- renew、logout、unbind 使用 Device Credential；
- Header 不混用；
- HTTPS Origin 在 Transport 前校验；
- 严格成功响应；
- 稳定 server code；
- malformed success / error；
- timeout / unreachable / unknown transport error。

HarmonyOS Core CI #4 按预期失败，生产模块尚不存在。

## 3. GatewayClient GREEN 与第一次根因修复

实现：

```text
clients/harmonyos/core/src/gatewayClient.ts
```

第一次完整 typecheck 暴露：

```text
TS2308
DeviceAuthorization 被 requests.ts 与 gatewayClient.ts 重复导出
```

根因是新模块重新声明了已经存在的共享认证类型，而 `index.ts` 同时导出两个定义。

最小修复：

```text
删除 gatewayClient.ts 的重复接口
直接复用 requests.ts 的 DeviceAuthorization
```

没有修改运行行为。

## 4. SessionManager RED

增加：

```text
clients/harmonyos/core/src/credentialStore.ts
clients/harmonyos/core/test/sessionManager.test.ts
```

`MobileCredentialStore` 只定义安全存储 Port，不提供明文生产实现。

Session 测试预先要求不存在的 `sessionManager.ts`，覆盖：

- 无 Device 返回 `needsPairing`；
- 有效 Session 直接恢复；
- 缺失和过期 Session 续期；
- `ENTRY_SESSION_INVALID` 后 renew 一次再读 Portal；
- 并发 `validSession()` 只调用一次 Gateway；
- unreachable 返回 offline 且不清授权；
- `DEVICE_REVOKED` 清 Device + Session；
- logout 不依赖现存 Session，使用 Device Credential 且只清 Session；
- unbind 成功或服务器已撤销时清全部授权；
- unbind 网络失败时保留授权。

HarmonyOS Core CI #11 按预期失败，`sessionManager.ts` 尚不存在。

## 5. SessionManager GREEN 与第二次根因修复

实现：

```text
clients/harmonyos/core/src/sessionManager.ts
```

第一次运行没有进入业务断言，而被 Node 22 strip-only runtime 拒绝：

```text
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
TypeScript parameter property is not supported in strip-only mode
```

受影响语法：

```ts
constructor(readonly kind: ...)
constructor(private readonly transport: ...)
constructor(private readonly gateway: ...)
```

根因是 typecheck 支持该 TypeScript 语法，但项目的零转译测试路径使用：

```bash
node --experimental-strip-types
```

该运行器不会转换参数属性。

最小修复：

```ts
private readonly field: Type;

constructor(field: Type) {
  this.field = field;
}
```

`gatewayClient.ts` 与 `sessionManager.ts` 均统一到显式字段语法。业务逻辑未改变，核心与未来 ArkTS 的语法差异也更小。

## 6. 最终行为

### GatewayClient

```text
GatewayProfile
→ validate HTTPS Origin
→ endpoint-specific request builder
→ injected GatewayTransport
→ strict success parser / Mobile error parser
```

认证矩阵：

```text
Portal Context  = Entry Session
renew            = Device Credential
logout           = Device Credential
unbind           = Device Credential
```

### SessionManager

```text
restore()
validSession()
logout()
unbind()
```

并发续期通过一个共享 Promise 合并：

```text
N 个同时续期请求
→ 1 个 Gateway renew
→ 1 次原子 Session 替换
→ 所有调用者获得同一结果
```

## 7. 代码验证证据

代码与临时诊断文件清理后的 head：

```text
9a43a8fd0c3f832f7891ab428f55565c9c0f9d50
```

Actions：

```text
Repository CI #489: success
HarmonyOS Core CI #17: success
Secret Scan #375: success
```

一次性诊断 workflow 已删除，不在最终 PR 文件集合中。

## 8. 安全与范围复核

未引入：

- 真实 Network Kit 请求；
- 明文 CredentialStore 生产实现；
- Token / Device Credential 日志；
- 真实 Gateway hostname；
- iOS 修改；
- Gateway / Contract 修改；
- Member Web 修改。

本阶段不宣称：

- DevEco 编译通过；
- HAP 已生成；
- Asset Store / Network Kit 已接入；
- HarmonyOS 真机已完成配对；
- PR #26 或 PR #27 已获准合并。
