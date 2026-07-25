# HarmonyOS Mobile Entry Core

该目录保存 HarmonyOS 客户端在接触系统 API 和页面之前必须稳定的规则。它是一个无网络、无文件系统、无 UI、无真实凭据的纯逻辑核心。

## 组件

| 文件 | 职责 |
|---|---|
| `types.ts` | Mobile Entry v1 与 HarmonyOS 设备类型 |
| `validation.ts` | 严格响应、错误和 Portal Context 校验 |
| `gatewayUrl.ts` | 只接受无凭据、无路径、无查询、无 Fragment 的 HTTPS Gateway Origin |
| `pairing.ts` | 手工配对码规范化与 `familyai://pair#...` QR 解析 |
| `requests.ts` | Public、Entry Session、Device Credential 三种请求头装配 |
| `endpoints.ts` | 当前移动 API 的方法、路径和唯一认证方式 |
| `credentials.ts` | logout 与 unbind 的删除范围 |
| `device.ts` | `mobile + harmonyos` 设备描述 |
| `state.ts` | 配对、恢复、离线、锁定、撤销等确定性状态机 |

## 不变量

1. 客户端从不提交可信 `personRef`。
2. Public pairing 请求不带 Authorization。
3. Portal、Chat、Work、Sync 使用 Entry Session。
4. renew、logout、unbind 使用 Device Credential。
5. Entry Session 与 Device Credential Header 不混用。
6. logout 只删除 Session；unbind 删除 Gateway、Device 与 Session，但保留安装身份。
7. 离线不等于登出，缓存身份可以继续显示为离线状态。
8. 被撤销设备不得保留受保护状态。
9. HarmonyOS 客户端拒绝把当前设备误报或误读为 iOS。
10. 未完成平台中立 Contract 前，不发送正式 HarmonyOS claim。

## ArkTS 边界

核心刻意只使用 TypeScript / ECMAScript 基础能力，便于在没有 HarmonyOS SDK 的环境中先运行测试。是否能原样进入 ArkTS 编译器必须由 H0B 的 DevEco 构建验证；任何为适配 ArkTS 语法所做的改写，都必须继续通过本目录同等行为测试。
