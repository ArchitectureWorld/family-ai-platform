# HarmonyOS Mobile Entry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可验证、平台中立且不干扰 iOS / Member Web 的 HarmonyOS Mobile Entry Foundation。

**Architecture:** 先以无系统依赖的 TypeScript 核心冻结 Mobile Entry 解析、认证、凭据和状态机规则，再用 DevEco Stage 模型通过窄 Port 接入 Network Kit、Asset Store Kit、Scan Kit、User Authentication Kit 与 ArkUI。Gateway 继续作为唯一业务权威，HarmonyOS 不维护独立 Person、Chat、Work 或同步真相。

**Tech Stack:** HarmonyOS Stage Model、ArkTS、ArkUI、Network Kit、Asset Store Kit、Scan Kit、User Authentication Kit、ArkData/Preferences、Node.js 22、TypeScript 6、Node Test Runner。

## Global Constraints

- 分支：`feat/harmonyos-mobile-entry-foundation`，直接基于最新 `main`。
- 不修改 `clients/ios/**`、`.github/workflows/ios-ci.yml`、Member Web 或现有 PR 分支。
- H0A 不修改 `packages/contracts/**` 或 `apps/gateway/**`。
- HarmonyOS 设备必须声明 `terminalType = mobile`、`platform = harmonyos`，不得伪装为 iOS。
- 正式 claim 依赖独立平台中立 Contract / Gateway PR。
- Public、Entry Session、Device Credential 三种认证不能混用。
- logout 使用 Device Credential 并只清除 Session。
- unbind 使用 Device Credential，并在本机系统认证后清除 Device + Session。
- Gateway URL 只允许无 Credential、Path、Query、Fragment 的 HTTPS Origin。
- Token、Credential、配对码和完整 QR 不进入日志、截图、测试报告或 Git。
- 真实 HAP 构建、系统 Kit 与真机结论必须在 DevEco / HarmonyOS SDK 环境中取证。

---

### Task 1: Mobile Entry Pure Core（已完成）

**Files:**
- Create: `clients/harmonyos/core/src/types.ts`
- Create: `clients/harmonyos/core/src/validation.ts`
- Create: `clients/harmonyos/core/src/gatewayUrl.ts`
- Create: `clients/harmonyos/core/src/pairing.ts`
- Create: `clients/harmonyos/core/src/requests.ts`
- Create: `clients/harmonyos/core/src/endpoints.ts`
- Create: `clients/harmonyos/core/src/credentials.ts`
- Create: `clients/harmonyos/core/src/device.ts`
- Create: `clients/harmonyos/core/src/state.ts`
- Create: `clients/harmonyos/core/src/index.ts`
- Create: `clients/harmonyos/core/test/*.test.ts`
- Create: `clients/harmonyos/core/tsconfig.json`
- Create: `scripts/verify-harmonyos-core.sh`

**Interfaces:**
- Consumes: Mobile Entry v1 JSON wire shapes and existing Gateway endpoint semantics.
- Produces: strict parsers, request/header builders, endpoint matrix, credential lifecycle and deterministic `reduceAppState()`.

- [x] **Step 1: Write failing tests for missing core modules**

```bash
node --experimental-strip-types --test clients/harmonyos/core/test/*.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for missing production modules.

- [x] **Step 2: Implement minimal pure core**

Required exports include:

```ts
validateGatewayBaseUrl(value: string): string
normalizePairingCode(value: string): string
parsePairingQr(rawValue: string): PairingQrPayload
parsePersonalPortalContext(value: unknown): PersonalPortalContext
buildEntryRequest(...): GatewayRequest
buildDeviceRequest(...): GatewayRequest
reduceAppState(state: AppState, action: AppAction): AppState
```

- [x] **Step 3: Add endpoint authentication matrix**

```ts
sessionLogout: {
  method: 'POST',
  path: '/api/v1/mobile/session/logout',
  authentication: 'device'
}
```

- [x] **Step 4: Reject HarmonyOS-to-iOS platform misclassification**

Portal context is accepted only when:

```text
terminalType = mobile
platform = harmonyos
```

- [x] **Step 5: Run strict verification**

```bash
node_modules/.bin/tsc -p clients/harmonyos/core/tsconfig.json
NODE_NO_WARNINGS=1 node --experimental-strip-types --test clients/harmonyos/core/test/*.test.ts
```

Expected: typecheck exit 0; 21 tests, 0 failures.

- [ ] **Step 6: Commit H0A core**

```bash
git add clients/harmonyos/core clients/harmonyos/README.md scripts/verify-harmonyos-core.sh
git commit -m "feat(harmonyos): establish mobile entry core"
```

---

### Task 2: Platform-Neutral Mobile Entry Dependency（独立 PR）

**Files:**
- Modify in separate branch: `packages/contracts/src/mobileEntry.ts`
- Modify in separate branch: `packages/contracts/test/mobileEntry.test.ts`
- Add in separate branch: `packages/contracts/fixtures/mobile-entry/pairing-claim-harmonyos-request.json`
- Modify in separate branch: `apps/gateway/src/mobilePairing.ts`
- Modify in separate branch: Gateway mobile pairing tests.

**Interfaces:**
- Consumes: existing `mobileDeviceDescriptorSchema` and pairing claim flow.
- Produces: a public descriptor accepting `platform: "ios" | "harmonyos"`; Gateway persistence of the validated platform.

- [ ] **Step 1: Write Contract RED test**

```ts
expect(mobileDeviceDescriptorSchema.parse({
  displayName: '测试鸿蒙手机',
  terminalType: 'mobile',
  platform: 'harmonyos',
  systemVersion: 'HarmonyOS 7',
  appVersion: '0.1.0',
  model: 'HarmonyOS Phone'
}).platform).toBe('harmonyos');
```

- [ ] **Step 2: Verify Contract test fails because only `ios` is accepted**

```bash
npm run test -w @family-ai/contracts -- mobileEntry.test.ts
```

- [ ] **Step 3: Expand only the platform enum**

```ts
platform: z.enum(['ios', 'harmonyos'])
```

Do not change protocol version or existing iOS fixture behavior.

- [ ] **Step 4: Write Gateway RED test**

Claim a HarmonyOS device and assert:

```sql
SELECT terminal_type, platform FROM managed_devices
```

returns:

```text
mobile | harmonyos
```

- [ ] **Step 5: Persist validated descriptor values**

Gateway must use `input.device.terminalType` and `input.device.platform`; it must not hard-code `ios`.

- [ ] **Step 6: Run full repository gate and merge this dependency before H0B live claim**

```bash
npm run check
```

This task must remain in an independent Contracts / Gateway PR and must not be implemented on the HarmonyOS client branch.

---

### Task 3: DevEco Stage Project Skeleton

**Files:**
- Create: `clients/harmonyos/app/AppScope/app.json5`
- Create: `clients/harmonyos/app/build-profile.json5`
- Create: `clients/harmonyos/app/hvigorfile.ts`
- Create: `clients/harmonyos/app/oh-package.json5`
- Create: `clients/harmonyos/app/entry/build-profile.json5`
- Create: `clients/harmonyos/app/entry/hvigorfile.ts`
- Create: `clients/harmonyos/app/entry/oh-package.json5`
- Create: `clients/harmonyos/app/entry/src/main/module.json5`
- Create: `clients/harmonyos/app/entry/src/main/ets/entryability/EntryAbility.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/pages/Index.ets`
- Create: required resource JSON files.

**Interfaces:**
- Consumes: Stage model and H0A state names.
- Produces: one phone entry module and a launchable ArkUI shell without fake authentication.

- [ ] **Step 1: Generate an empty Stage model phone project in the supported DevEco Studio version**

Use package name with no personal information, for example:

```text
com.architectureworld.familyai.harmony
```

Do not commit signing files or developer identifiers.

- [ ] **Step 2: Replace generated business code with one state-driven shell**

`Index.ets` may display only real app states:

```text
正在启动
需要配对
正在恢复
已连接
离线
授权已撤销
配置错误
```

It must not fabricate Chat replies or fake a successful Gateway connection.

- [ ] **Step 3: Add project-level ignore checks**

Verify local signing, `.hap`, `.app`, SDK cache and runtime data are ignored.

- [ ] **Step 4: Run DevEco command-line build**

Use the generated project wrapper, for example:

```bash
cd clients/harmonyos/app
./hvigorw assembleHap --mode module -p module=entry@default -p product=default
```

Expected: exit 0. Record the actual command for the installed SDK version.

- [ ] **Step 5: Commit**

```bash
git add clients/harmonyos/app
git commit -m "feat(harmonyos): add Stage mobile entry shell"
```

---

### Task 4: Secure CredentialStore Adapter

**Files:**
- Create: `clients/harmonyos/app/entry/src/main/ets/core/security/CredentialStore.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/core/security/InstallationIdentity.ets`
- Create tests under the HarmonyOS test source set.

**Interfaces:**
- Consumes: H0A key names and lifecycle semantics.
- Produces:

```ts
interface CredentialStore {
  installationId(): Promise<string>;
  gatewayProfile(): Promise<GatewayProfile | null>;
  deviceAuthorization(): Promise<DeviceAuthorization | null>;
  session(): Promise<EntrySessionCredential | null>;
  saveClaim(...): Promise<void>;
  replaceSessionAtomically(...): Promise<void>;
  clearSession(): Promise<void>;
  clearDeviceAndSession(): Promise<void>;
}
```

- [ ] **Step 1: Write tests for complete / partial record detection**

A partial Session or Device record must return a configuration error, never a partially trusted credential.

- [ ] **Step 2: Write tests for logout and unbind deletion scope**

Expected: logout preserves installation + device; unbind preserves installation only.

- [ ] **Step 3: Implement Asset Store-backed secret storage**

Store `deviceCredential` and Entry Session token as short sensitive assets. Do not write them to Preferences.

- [ ] **Step 4: Add staged replacement and rollback**

New Session values must be completely written and verified before old values are removed.

- [ ] **Step 5: Run ArkTS unit tests and commit**

```bash
git commit -m "feat(harmonyos): secure mobile credentials"
```

---

### Task 5: Network Kit GatewayClient

**Files:**
- Create: `clients/harmonyos/app/entry/src/main/ets/core/network/GatewayClient.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/core/network/GatewayError.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/core/network/MobileEntryCoding.ets`
- Create tests using a deterministic transport stub.

**Interfaces:**
- Consumes: `MOBILE_ENDPOINTS`, strict response parsers and Credential types.
- Produces methods:

```ts
preview(...)
claim(...)
fetchPortalContext(...)
renew(...)
logout(...)
unbind(...)
```

- [ ] **Step 1: Write tests for exact method, path and authentication**

Explicitly prove logout uses Device Credential.

- [ ] **Step 2: Write tests for timeout, unreachable, malformed JSON and stable server codes**

UI state must use error code, not message.

- [ ] **Step 3: Implement HTTPS-only Network Kit transport**

Set bounded request and resource timeouts; do not log request bodies or headers.

- [ ] **Step 4: Reject unsupported protocol versions and unknown fields**

- [ ] **Step 5: Run tests and commit**

```bash
git commit -m "feat(harmonyos): connect Mobile Entry Gateway client"
```

---

### Task 6: Pairing Flow

**Files:**
- Create: `clients/harmonyos/app/entry/src/main/ets/features/pairing/PairingManager.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/features/pairing/PairingPage.ets`
- Create: `clients/harmonyos/app/entry/src/main/ets/features/pairing/PairingPreviewPage.ets`
- Create tests for parser and state transitions.

**Interfaces:**
- Consumes: GatewayClient, CredentialStore, Scan Kit, H0A QR/manual parser.
- Produces: preview-confirm-claim flow ending in authenticated Portal Context.

- [ ] **Step 1: Write tests for manual Gateway + code only**
- [ ] **Step 2: Write tests for QR scheme, host, version, unknown fields and unsafe Gateway**
- [ ] **Step 3: Implement Scan Kit adapter without retaining full QR payload**
- [ ] **Step 4: Implement preview before claim**
- [ ] **Step 5: Generate random installation identity and 32-byte Device Credential**
- [ ] **Step 6: Atomically save claim and fetch real Portal Context**
- [ ] **Step 7: Run UI and unit tests, then commit**

```bash
git commit -m "feat(harmonyos): implement personal device pairing"
```

---

### Task 7: Session, App Lock and Personal Home

**Files:**
- Create: `SessionManager.ets`
- Create: `AppCoordinator.ets`
- Create: `LocalAuthenticationClient.ets`
- Create: `PersonalHomePage.ets`
- Create: `SettingsPage.ets`
- Create tests for lifecycle and concurrency.

**Interfaces:**
- Consumes: GatewayClient, CredentialStore, cached Portal Context, User Authentication Kit.
- Produces: deterministic launch/restore/renew/offline/revoked/lock/logout/unbind behavior.

- [ ] **Step 1: Write tests for startup decision table**
- [ ] **Step 2: Serialize concurrent renew attempts**
- [ ] **Step 3: Preserve credentials on timeout/unreachable and display offline context**
- [ ] **Step 4: Clear authorization on Device revoke**
- [ ] **Step 5: Add immediate background privacy cover**
- [ ] **Step 6: Require system authentication after configured timeout and before unbind**
- [ ] **Step 7: Display only real Portal Context; no mock Chat content**
- [ ] **Step 8: Run tests and commit**

```bash
git commit -m "feat(harmonyos): restore and protect personal entry"
```

---

### Task 8: Verification and Physical Device Acceptance

**Files:**
- Create: `clients/harmonyos/Docs/physical-device-acceptance.md`
- Create: `scripts/verify-harmonyos.sh`
- Create: `docs/superpowers/evidence/2026-07-25-harmonyos-mobile-entry-foundation.md`

**Interfaces:**
- Consumes: complete H0B app and a deployed private HTTPS Gateway.
- Produces: repeatable automated report plus user-facing one-click product-entry acceptance steps.

- [ ] **Step 1: Run H0A core verification**

```bash
bash ./scripts/verify-harmonyos-core.sh
```

- [ ] **Step 2: Run DevEco build, ArkTS unit tests and UI tests**

Record exact toolchain versions and commands.

- [ ] **Step 3: Install on a real HarmonyOS phone**

Verify manual pairing, QR scanning, intended Person binding, process restart, Session renewal, system authentication, offline recovery, logout, unbind and remote revoke.

- [ ] **Step 4: Scan repository and reports for secrets**

Reject pairing codes, Token values, Device Credentials, Authorization headers, real hostnames and signing identifiers.

- [ ] **Step 5: Compare PR paths against active PRs**

Expected zero overlap with PR #14 and PR #24.

- [ ] **Step 6: Keep PR Draft until real-device evidence is complete**

Do not merge from automated build evidence alone.
