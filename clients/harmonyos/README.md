# Family AI HarmonyOS Client

HarmonyOS 是 Family AI Platform 的第二个原生个人入口，与 iOS 同级，但不复制 iOS 工程，也不维护独立的 Person、Chat、Work、事件或同步状态。

```text
HarmonyOS Client
→ Family AI Gateway
→ 同一个 Person
→ 同一个 HomeChatStream / WorkConversation
→ 同一套 Event / Sync Cursor
```

## 当前阶段

当前分支完成 **H0A：Mobile Entry 可验证核心**：

- Mobile Entry v1 严格响应解析；
- HTTPS Gateway 地址校验；
- QR Fragment 与手工配对码解析；
- Entry Session / Device Credential 认证隔离；
- logout、unbind 凭据生命周期；
- HarmonyOS 设备描述；
- 应用状态机；
- 当前移动端 API 的认证矩阵；
- Node 22 下可重复运行的 TypeScript 类型检查与单元测试。

下一阶段是 **H0B：DevEco Stage 模型原生工程**，接入 Asset Store Kit、Network Kit、Scan Kit 和 User Authentication Kit。

## 重要阻断边界

当前 `packages/contracts/src/mobileEntry.ts` 仍要求：

```text
terminalType = mobile
platform = ios
```

因此 HarmonyOS 客户端不得为了临时通过 Gateway 而伪装成 iOS。正式配对接入前，必须由独立 Contracts / Gateway PR 将公共平台枚举扩展为 `ios | harmonyos`，并让 Gateway 按客户端经过验证的描述保存平台。

## 目录

```text
clients/harmonyos/
├── README.md
└── core/
    ├── README.md
    ├── tsconfig.json
    ├── src/
    └── test/
```

## 验证

先在仓库根目录安装锁定依赖：

```bash
npm ci
```

然后运行：

```bash
bash ./scripts/verify-harmonyos-core.sh
```

此脚本不依赖 DevEco Studio，用于先冻结跨端协议、安全边界和状态机。原生 HAP 构建与真机验收将在安装 HarmonyOS SDK 的环境中单独取证。
