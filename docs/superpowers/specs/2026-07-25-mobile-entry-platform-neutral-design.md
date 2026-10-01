# Mobile Entry Platform-Neutral Design

- 日期：2026-07-25
- 状态：已批准
- 分支：`feat/mobile-entry-platform-neutral`
- 基线：当前 `main`

## 1. 目标

解除 Mobile Entry v1 对 iOS 的硬编码，使 iOS 与 HarmonyOS 使用同一套配对、Device、Entry Session 和 Portal Context 语义，同时保持现有 iOS 请求完全兼容。

```text
Mobile Entry v1
├── terminalType = mobile
└── platform = ios | harmonyos
```

本设计不创建 HarmonyOS 专用 Gateway，不复制身份、Chat、Work 或同步对象。

## 2. 当前问题

公共 Contract 当前固定：

```ts
terminalType: z.literal("mobile")
platform: z.literal("ios")
```

Gateway claim 又固定写入：

```sql
terminal_type = 'mobile'
platform = 'ios'
```

结果是合法的 HarmonyOS 客户端会被 Contract 拒绝；即使绕过 Contract，也会被错误记录为 iOS。

## 3. 稳定决策

采用二维设备描述：

```text
terminalType = 设备形态
platform     = 操作系统 / 运行平台
```

第一版移动设备：

| terminalType | platform |
|---|---|
| `mobile` | `ios` |
| `mobile` | `harmonyos` |

不新增 `terminalType = harmony`，避免把操作系统和终端形态混为一谈。

## 4. 兼容策略

- `MOBILE_ENTRY_PROTOCOL_VERSION` 继续为 `1`；
- 现有 iOS fixture、Swift 模型和请求不变；
- 仅扩展服务端允许的 `platform` 枚举；
- Gateway 继续通过严格 Contract 校验后才读取设备描述；
- 未知平台仍然拒绝；
- 未知字段仍然拒绝；
- `terminalType` 继续固定为 `mobile`；
- 平台值只描述设备能力，不参与 Person、Family 或权限归属判断。

这是向后兼容的服务端接收范围扩展，不改变现有字段的含义。

## 5. Gateway 持久化

成功 claim 时，Gateway 必须保存已经通过 Contract 校验的：

```ts
input.device.terminalType
input.device.platform
```

不得继续硬编码 `mobile / ios`。

其余事务边界保持不变：

```text
验证 pairing
→ 验证目标 Person 与 AssistantAssignment
→ 创建 ManagedDevice
→ 创建 person-scoped DeviceBinding
→ 创建 personal EntryBinding
→ 创建 Entry Session
→ 消耗 pairing code
```

## 6. 安全边界

- 客户端仍不能声明可信 `personRef`、`familyRef`、Agent 或 owner scope；
- Gateway 只从已认证/已绑定的 pairing 记录解析目标 Person；
- 平台字段不能提升权限；
- HarmonyOS claim 使用与 iOS 相同的随机 installationId 和 32-byte Device Credential；
- Device Credential、Session Token 和 pairing code 仍只按现有安全规则处理；
- 不记录真实设备标识或硬件指纹。

## 7. 测试

### Contracts

- canonical iOS fixture 继续通过；
- canonical HarmonyOS claim fixture 通过；
- `android`、未知平台、未知字段拒绝；
- `terminalType != mobile` 拒绝。

### Gateway

通过正式 HTTP route claim 一个 HarmonyOS 设备，然后查询 SQLite，必须得到：

```text
terminal_type = mobile
platform = harmonyos
```

同时证明：

- claim 返回 201；
- Device / Entry 创建语义不变；
- iOS 路径现有测试继续通过；
- 全仓库测试、类型检查、构建和 Secret Scan 通过。

## 8. 分支隔离

本分支只修改：

```text
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/pairing-claim-harmonyos-request.json
packages/contracts/test/mobileEntryPlatform.test.ts
apps/gateway/src/mobilePairing.ts
apps/gateway/test/mobileHarmonyPairing.test.ts
docs/superpowers/**/*mobile-entry-platform-neutral*
```

明确不修改：

```text
clients/ios/**
clients/harmonyos/**
apps/gateway/member-public/**
.github/workflows/ios-ci.yml
```

因此它是 PR #14、#25、#26 的独立前置能力，不向任何客户端分支写入提交。

## 9. 完成定义

- HarmonyOS fixture 被公共 Contract 接受；
- iOS fixture保持不变并继续通过；
- Gateway 保存真实 `harmonyos` 平台；
- 未知平台仍被拒绝；
- Repository CI、Secret Scan 和相关测试全部通过；
- PR 保持 Draft，未经用户授权不合并。
