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

当前分支已经完成 **H0A：Mobile Entry 可验证核心与会话编排**：

- Mobile Entry v1 严格响应解析；
- HTTPS Gateway 地址校验；
- QR Fragment 与手工配对码解析；
- Entry Session / Device Credential 认证隔离；
- 当前移动端 API 的认证矩阵；
- 可替换 Network Kit 的 `GatewayTransport` Port；
- Portal、renew、logout、unbind 的 Transport-independent GatewayClient；
- timeout、unreachable、malformed response 与稳定 server code 的独立映射；
- `MobileCredentialStore` 安全存储 Port；
- Session 恢复、过期续期和 Portal Session 失效后的单次重试；
- 并发续期合并为一个真实 Gateway 请求；
- 离线保留授权、Device revoke 清除授权；
- logout 只清 Session，unbind 清 Device + Session；
- HarmonyOS 设备描述；
- 应用状态机；
- Node 22 下可重复运行的 strict 类型检查与单元测试。

下一批纯核心是 PairingManager；随后进入 **H0B：DevEco Stage 模型原生工程**，接入 Asset Store Kit、Network Kit、Scan Kit 和 User Authentication Kit。

## 平台中立前置

`main` 当前仍然只接受：

```text
terminalType = mobile
platform = ios
```

独立 Draft PR #27 已经完成并通过 CI：

```text
terminalType = mobile
platform = ios | harmonyos
```

Gateway 也会保存经过 Contract 验证的真实平台，不再硬编码 iOS。但 PR #27 尚未获得合并授权，因此 PR #26 不发送真实 HarmonyOS claim，也不会伪装成 iOS。

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

此脚本不依赖 DevEco Studio，用于先冻结跨端协议、安全边界、Gateway 请求语义、会话生命周期和状态机。原生 HAP 构建与真机验收将在安装匹配 HarmonyOS SDK 的环境中单独取证。
