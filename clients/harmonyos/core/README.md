# HarmonyOS Mobile Entry Core

该目录保存 HarmonyOS 客户端在接触系统 API 和页面之前必须稳定的规则。它是一个无真实网络、无文件系统、无 UI、无真实凭据的纯逻辑核心。

## 组件

| 文件 | 职责 |
|---|---|
| `types.ts` | Mobile Entry v1 与 HarmonyOS 设备类型 |
| `validation.ts` | 严格响应、错误和 Portal Context 校验 |
| `gatewayUrl.ts` | 只接受无凭据、无路径、无查询、无 Fragment 的 HTTPS Gateway Origin |
| `pairing.ts` | 手工配对码规范化与 `familyai://pair#...` QR 解析 |
| `requests.ts` | Public、Entry Session、Device Credential 三种请求头装配 |
| `endpoints.ts` | 当前移动 API 的方法、路径和唯一认证方式 |
| `gatewayClient.ts` | 在可替换 Transport 上执行 Portal、renew、logout、unbind，并严格映射响应与错误 |
| `credentialStore.ts` | Asset Store / Preferences 后续实现必须满足的安全存储 Port |
| `credentials.ts` | logout 与 unbind 的删除范围 |
| `sessionManager.ts` | Session 恢复、单次续期重试、并发续期合并、离线、撤销、logout 与 unbind |
| `device.ts` | `mobile + harmonyos` 设备描述 |
| `state.ts` | 配对、恢复、离线、锁定、撤销等确定性状态机 |

## 不变量

1. 客户端从不提交可信 `personRef`。
2. Public pairing 请求不带 Authorization。
3. Portal、Chat、Work、Sync 使用 Entry Session。
4. renew、logout、unbind 使用 Device Credential。
5. Entry Session 与 Device Credential Header 不混用。
6. logout 不依赖现存 Entry Session，只删除 Session；unbind 删除 Gateway、Device 与 Session，但保留安装身份。
7. 同时发生多个续期需求时只允许一个真实 Gateway renew 请求。
8. 离线不等于登出，timeout / unreachable 不能清除授权。
9. 被撤销设备必须清除 Device 与 Session 授权。
10. HarmonyOS 客户端拒绝把当前设备误报或误读为 iOS。
11. PR #27 合并进入 `main` 前，不发送正式 HarmonyOS claim。

## Transport 与系统适配

核心只依赖：

```ts
interface GatewayTransport {
  send(input: {
    baseURL: string;
    request: GatewayRequest;
  }): Promise<GatewayTransportResponse>;
}
```

H0B 的 Network Kit Adapter 负责真实 HTTP；核心负责方法、路径、认证 Header、严格解码和稳定错误映射。Asset Store Adapter 同理只实现 `MobileCredentialStore`，不能重新定义 Session 生命周期。

## ArkTS / Node 语法边界

核心刻意只使用 TypeScript / ECMAScript 基础能力，便于在没有 HarmonyOS SDK 的环境中先运行测试。Node 22 的 strip-only runner 不支持 TypeScript 构造器参数属性，因此核心统一使用显式字段声明和构造器赋值。这也减少后续迁移到 ArkTS 时的语法差异。

是否能原样进入 ArkTS 编译器仍必须由 H0B 的 DevEco 构建验证；任何为适配 ArkTS 所做的改写，都必须继续通过本目录同等行为测试。

## 验证

```bash
npm ci
bash ./scripts/verify-harmonyos-core.sh
```

该命令执行 strict noEmit typecheck 和全部 HarmonyOS Core 行为测试。
