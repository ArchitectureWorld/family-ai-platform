# HarmonyOS Mobile Entry Foundation Design

- 状态：已批准，H0A 核心已实现
- 日期：2026-07-25
- 仓库：`ArchitectureWorld/family-ai-platform`
- 分支：`feat/harmonyos-mobile-entry-foundation`
- 基线：`main @ 80107e10764bc0160bd977f3d8b8b8219b03c175`

## 1. 目标

建立 Family AI Platform 的第二个原生个人入口，使 HarmonyOS 手机能够在不复制服务端状态、不伪装成 iOS、不干扰现有 Web / iOS 开发线的前提下，逐步接入同一个 Gateway、Person、Chat、Work 与多端同步体系。

第一阶段不是一次性实现完整鸿蒙生态，而是拆成两个可独立验证的里程碑：

```text
H0A Mobile Entry 可验证核心
→ H0B DevEco Stage 原生入口
→ H1 Text Chat / Work
→ H2 Event / Sync + Push
→ H3 服务卡片与多设备接续
```

当前分支首先交付 H0A，并为 H0B 固定边界。

## 2. 产品定位

HarmonyOS 与 iOS 同级：

```text
Web       = 完整工作台与管理入口
iOS       = 原生个人随身入口
HarmonyOS = 原生个人随身入口
DIY       = 场景化受限入口
```

所有终端共享：

```text
Family
Person
Device / EntryBinding
AssistantAssignment
HomeChatStream
WorkConversation
ThreadMessage
Domain Event
Device Sync Cursor
```

HarmonyOS 只实现不同的系统能力和交互方式，不成为新的业务权威。

## 3. 前置现状

当前 `main` 已具备：

- Family / Person / Device / Entry Session；
- Mobile Pairing Gateway；
- Chat / Work Contracts 与 HTTP API；
- Provider Turn 与 Assistant 回复；
- Domain Event、Transactional Outbox 与 SSE；
- Device Sync Cursor、显式补拉与累计 ACK；
- Event / Sync Contracts v1。

但 Mobile Entry v1 的设备描述仍固定为：

```text
terminalType = mobile
platform = ios
```

因此正式 HarmonyOS claim 之前必须由独立 PR 将公共平台描述扩展为：

```text
terminalType = mobile
platform = ios | harmonyos
```

并让 Gateway 将通过 Contract 校验的 `platform` 写入设备记录。HarmonyOS 客户端不得临时发送 `platform = ios` 绕过该前置条件。

## 4. 范围

### 4.1 H0A 本分支包含

- HarmonyOS 客户端目录与开发边界；
- Mobile Entry v1 TypeScript 类型镜像；
- 严格响应与错误解析；
- Gateway HTTPS Origin 校验；
- 手工配对码规范化；
- `familyai://pair#...` QR 解析；
- Public / Entry Session / Device Credential 请求隔离；
- 当前移动 API 认证矩阵；
- HarmonyOS 设备描述；
- logout / unbind 凭据生命周期；
- 启动、配对、恢复、离线、锁定、撤销状态机；
- Node 22 可执行测试、TypeScript 严格类型检查与验证脚本；
- H0B 原生工程实施计划。

### 4.2 H0A 不包含

- 修改 `packages/contracts/**`；
- 修改 Gateway；
- 修改 iOS 或 iOS CI；
- 修改 Member Web；
- 创建可发布 HAP；
- 真实 Network Kit 请求；
- Asset Store、Scan Kit、User Authentication 系统适配；
- Chat / Work 页面；
- Event / Sync 本地数据库；
- Push、服务卡片、手表和平板接续；
- AppGallery 发布。

### 4.3 H0B 包含

平台中立 Contract 合并后，H0B 将增加：

- DevEco Studio Stage 模型工程；
- ArkUI 原生页面；
- Network Kit GatewayClient；
- Asset Store CredentialStore；
- Scan Kit QR 输入与手工输入；
- User Authentication 应用锁；
- Portal Context 首页；
- Session restore / renew / logout / unbind；
- 离线与撤销状态；
- Previewer、模拟器、单元测试、UI 测试和真机验收。

## 5. 组件架构

```text
ArkUI Pages
    │
    ▼
AppCoordinator / State Machine
    │
    ├── PairingManager
    ├── SessionManager
    ├── CredentialStore Port
    ├── GatewayClient Port
    ├── LocalAuthentication Port
    └── CachedContext Port
             │
             ▼
HarmonyOS Adapters
    ├── Network Kit
    ├── Asset Store Kit
    ├── Scan Kit
    ├── User Authentication Kit
    └── ArkData / Preferences
```

边界规则：

- 页面不能直接组装 Authorization Header；
- 页面不能直接访问 Asset Store；
- GatewayClient 不决定凭据生命周期；
- CredentialStore 不发送网络请求；
- AppCoordinator 不解析原始 JSON；
- 状态机不依赖 HarmonyOS 系统 API；
- 客户端不能声明可信 Person、Agent 或 Device ownership。

## 6. H0A 核心模块

```text
clients/harmonyos/core/src/
├── types.ts
├── validation.ts
├── gatewayUrl.ts
├── pairing.ts
├── requests.ts
├── endpoints.ts
├── credentials.ts
├── device.ts
├── state.ts
└── index.ts
```

### 6.1 `types.ts`

保存 Mobile Entry v1 客户端类型和 HarmonyOS 设备描述，不引入系统 SDK。

### 6.2 `validation.ts`

严格校验：

- 必须存在 `protocolVersion: 1`；
- 拒绝未知字段；
- Ref 前缀与长度正确；
- Token 为 43 字符 Base64URL；
- Portal 必须是 `audience = personal`；
- 当前设备必须是 `mobile + harmonyos`；
- 错误状态只由稳定 code 驱动；
- logout / unbind 只接受 `logged_out | revoked`。

### 6.3 `gatewayUrl.ts`

只接受：

```text
https://host[:port]
```

拒绝：

- HTTP；
- 用户名和密码；
- 非根路径；
- Query；
- Fragment；
- 无效 URL。

### 6.4 `pairing.ts`

手工输入规则与 Mobile Entry Contract 一致：

```text
ABCD-EFGH
```

QR 使用：

```text
familyai://pair#v=1&gateway=...&pairingRef=...&code=...&expiresAt=...
```

Secret-bearing 值只从 Fragment 读取，不进入普通 HTTP URL 查询。

### 6.5 `requests.ts` 与 `endpoints.ts`

固定认证矩阵：

| Endpoint | Authentication |
|---|---|
| pairing preview / claim | public |
| portal context | Entry Session |
| session renew | Device Credential |
| session logout | Device Credential |
| device unbind | Device Credential |
| Chat / Work / Sync / SSE | Entry Session |

任何请求只允许一种认证模式，Entry 与 Device Header 永不混合。

### 6.6 `credentials.ts`

```text
logout
→ 删除 Entry Session
→ 保留 Gateway + Device Credential + installationId

unbind
→ 删除 Gateway + Device Credential + Entry Session
→ 保留 installationId
```

### 6.7 `state.ts`

```text
launching
needsPairing
pairing(input / preview / claiming)
restoringSession
authenticated
offline
locked
authorizationRevoked
fatalConfigurationError
```

离线不等于退出；设备撤销必须清除受保护状态；锁屏只能保护已有的 authenticated / offline 状态，不能凭空产生认证状态。

## 7. H0B 运行流程

### 7.1 首次配对

```text
Scan Kit / 手工输入
→ 本地严格解析
→ pairing preview（无认证）
→ 显示家庭、成员、Gateway Host
→ 用户确认
→ 生成 installationId + deviceCredential
→ pairing claim（无认证）
→ Gateway 创建设备、绑定与 Entry Session
→ Asset Store 原子保存
→ portal context（Entry Session）
→ authenticated
```

### 7.2 启动恢复

```text
读取 Gateway + Device + Session
→ 无 Device：needsPairing
→ 有有效 Session：读取 Portal Context
→ Session 缺失/过期：Device Credential renew
→ Device revoked：清除授权并进入 authorizationRevoked
→ Gateway 不可达：保留授权并进入 offline
```

### 7.3 logout

```text
Device Credential
→ POST /api/v1/mobile/session/logout
→ 仅清除 Session
→ Device 仍可 renew
```

### 7.4 unbind

```text
User Authentication 二次确认
→ Device Credential
→ DELETE /api/v1/mobile/device
→ 清除 Gateway、Device 与 Session
→ needsPairing
```

## 8. 安全边界

- 原始 Token、Device Credential、配对码和完整 QR 不写日志；
- Asset Store 只保存短敏感凭据；
- 普通 Preferences 不保存 Token；
- `installationId` 是随机安装身份，不是认证秘密；
- 不采集序列号、广告标识或硬件指纹；
- Gateway URL 必须 HTTPS；
- App 切后台立即显示隐私遮罩；
- 超过策略时间后使用系统认证解锁；
- Push 后续只作为唤醒，不携带消息正文；
- SSE 只作为实时加速，可靠性由 Catch-up + ACK 保证。

## 9. 错误处理

状态决策只依据稳定错误 code：

```text
PAIRING_INVALID / EXPIRED / CONSUMED
→ 返回配对输入

ENTRY_SESSION_EXPIRED / INVALID
→ 尝试 Device renew

DEVICE_REVOKED
→ 清除 Device + Session
→ authorizationRevoked

transport timeout / unavailable
→ offline

malformed response / unsupported version
→ fatalConfigurationError
```

不得根据中文或英文错误文案决定状态。

## 10. 测试策略

### H0A

- Node 22 `--experimental-strip-types`；
- TypeScript strict / noEmit；
- 每个规则均有真实行为测试；
- RED → GREEN 证据写入 `docs/superpowers/evidence/`。

### H0B

- ArkTS 单元测试：状态机、URL、QR、Credential lifecycle；
- GatewayClient Stub 测试：方法、路径、Header、错误映射；
- UI 测试：配对、恢复、离线、撤销、锁屏；
- Previewer 只做视觉检查；
- 模拟器验证生命周期；
- 真机验证 Scan Kit、Asset Store、系统认证和网络路径。

## 11. PR 隔离

本分支允许修改：

```text
clients/harmonyos/**
scripts/verify-harmonyos-core.sh
docs/superpowers/specs/*harmonyos*
docs/superpowers/plans/*harmonyos*
docs/superpowers/evidence/*harmonyos*
```

明确不修改：

```text
clients/ios/**
.github/workflows/ios-ci.yml
apps/gateway/**
apps/gateway/public/**
apps/gateway/member-public/**
packages/contracts/**
```

因此与 PR #14 和 PR #24 保持文件路径隔离。

## 12. 完成定义

### H0A 完成

- 纯逻辑核心进入独立分支；
- strict typecheck 通过；
- 全部核心测试通过；
- 认证矩阵明确；
- 平台误报被拒绝；
- 验证脚本和证据文档进入 Git；
- 未修改 iOS、Web、Gateway、Contracts。

### H0B 完成

- 平台中立 Mobile Entry Contract 已合并；
- DevEco Stage 工程可构建；
- 配对、恢复、续期、logout、unbind、离线、撤销和应用锁全部工作；
- 真机通过受控 HTTPS Gateway 完成闭环；
- 不包含真实凭据、个人 Tailnet 主机名或签名材料；
- PR 保持 Draft，直到真机证据齐全。
