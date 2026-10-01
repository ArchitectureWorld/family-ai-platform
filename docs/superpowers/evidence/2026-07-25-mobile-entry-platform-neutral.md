# Mobile Entry Platform-Neutral TDD Evidence

- 日期：2026-07-25
- 分支：`feat/mobile-entry-platform-neutral`
- PR：#27
- 基线：`main @ d7e4530b2bce9d99fa44696d5754b7112a2a42f5`

## 1. 目标

证明 Mobile Entry v1 可以在不破坏现有 iOS 行为的前提下，正式接受并保存 HarmonyOS 手机设备：

```text
terminalType = mobile
platform = ios | harmonyos
```

## 2. RED 测试

先增加：

```text
packages/contracts/fixtures/mobile-entry/pairing-claim-harmonyos-request.json
packages/contracts/test/mobileEntryPlatform.test.ts
apps/gateway/test/mobileHarmonyPairing.test.ts
```

Contract 测试要求：

- HarmonyOS claim fixture 在 `protocolVersion = 1` 下通过；
- `android`、`windows`、`unknown` 平台被拒绝；
- `terminalType = harmony` 被拒绝；
- 未知设备字段被拒绝。

Gateway 测试通过正式 HTTP 路径：

```text
onboarding family
→ family_admin 生成 pairing
→ HarmonyOS claim
→ 查询 managed_devices
```

要求最终保存：

```text
terminal_type = mobile
platform = harmonyos
system_version = HarmonyOS 7
app_version = 0.1.0
device_model = HarmonyOS Phone
```

GitHub Actions 证据：

```text
Repository CI #437: failure（预期 RED）
Secret Scan #323: success
```

失败发生在旧实现仍固定 `platform = ios`、Gateway 仍固定写入 `mobile / ios` 的状态。

## 3. 最小生产修改

只修改两个既有生产文件。

### 3.1 Contract

```diff
- platform: z.literal("ios")
+ platform: z.enum(["ios", "harmonyos"])
```

以下内容保持不变：

- `MOBILE_ENTRY_PROTOCOL_VERSION = 1`；
- `terminalType = mobile`；
- strict object；
- 现有 iOS fixture 和字段；
- Credential、Session 和 Pairing 规则。

### 3.2 Gateway

```diff
- VALUES(?, ?, 'mobile', 'ios', 'active', ...)
+ VALUES(?, ?, ?, ?, 'active', ...)
```

新增绑定：

```ts
input.device.terminalType
input.device.platform
```

Gateway 只保存已经通过公共 Contract 校验的设备描述；Person、Family、owner scope 和权限仍由服务端 pairing 记录解析。

## 4. 调试记录

第一次临时聚焦验证中：

- 精确生产替换成功；
- Contract 测试运行；
- Gateway 测试失败；
- 自动提交和临时工作流清理被阻断。

调查发现失败来自临时测试流程漏掉仓库既有前置：Gateway 测试前必须先构建 Contracts / Provider Adapter SDK。根仓库标准流程本身就是：

```text
build:adapter-sdk
→ workspace tests
```

在临时流程中补上：

```bash
npm run build:adapter-sdk
```

之后重新运行完全相同的生产补丁与测试。

## 5. GREEN 证据

Temporary Mobile Platform Apply #2：

```text
Apply exact platform-neutral patch: success
Install locked dependencies: success
Contract tests: success
Build shared packages: success
Gateway tests: success
Remove temporary workflows and push implementation: success
```

成功提交：

```text
bc55772864635f7416219e832b57806aabbdd25f
feat(contracts): admit HarmonyOS mobile devices
```

两个临时 workflow 在同一提交中删除，没有进入最终 PR 文件集合。

## 6. 最终文件边界

生产与测试改动限定为：

```text
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/pairing-claim-harmonyos-request.json
packages/contracts/test/mobileEntryPlatform.test.ts
apps/gateway/src/mobilePairing.ts
apps/gateway/test/mobileHarmonyPairing.test.ts
```

另有本设计、实施计划和本证据文档。

明确未修改：

```text
clients/ios/**
clients/harmonyos/**
apps/gateway/member-public/**
.github/workflows/ios-ci.yml
```

因此不向 PR #14、PR #25 或 PR #26 写入提交。

## 7. 结论边界

本证据证明：

- 公共 Mobile Entry v1 接受 iOS 与 HarmonyOS；
- 未知平台仍被拒绝；
- Gateway 保存真实平台而不再伪装为 iOS；
- 身份、绑定和权限语义未改变；
- 聚焦 Contract / Gateway 行为已经 GREEN。

本证据不宣称：

- HarmonyOS DevEco Stage 工程已经构建；
- HAP 已生成；
- HarmonyOS 真机已完成配对；
- PR 已获准合并。
