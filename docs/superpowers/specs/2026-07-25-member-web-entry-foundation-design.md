# Member Web Entry Foundation 设计

- 日期：2026-07-25
- 状态：已批准，待实现
- 分支：`feat/web-entry-foundation`
- 基线：`main` @ `80107e10764bc0160bd977f3d8b8b8219b03c175`
- 目标 PR：#24

## 1. 目标

建立正式 Member Web 的浏览器设备与个人入口基础。用户通过真实配对、真实 Device / EntryBinding / EntrySession、真实 Cookie 认证进入产品工作台；“一键验收”只负责生成一次性真实配对链接，随后完整走正常产品入口，不再建设或扩展专用验收台。

```text
管理员生成一次性 Person 配对材料
→ 浏览器打开 /member/?pairingRef=...&code=...
→ Member Web 调用正式 Web Pairing Claim
→ Gateway 创建真实 Web Device / DeviceBinding / EntryBinding / EntrySession
→ Gateway 设置 HttpOnly Cookie
→ 用户进入正常产品工作台
```

## 2. 产品与验收原则

- 正式入口统一为 `/member/`。
- 根路径 `/` 在所有模式下重定向到 `/member/`，不再把开发验收台作为默认产品界面。
- 现有 development-only 验收资产不继续增加业务功能；本 PR 将其路由停用，但保留源文件，避免无关删除扩大变更面。
- 一键验收脚本只生成真实配对材料和产品深链接，不创建“为了验收而存在”的页面状态。
- 配对完成后 URL 中的一次性材料立即清除。
- 验收证据只写入 Git 文档，不在聊天中逐项展开。

## 3. 身份模型

浏览器设备使用现有平台对象：

```text
managed_devices
  terminal_type = web
  platform = browser

device_bindings
  owner_scope = person

entry_bindings
  audience = personal

entry_sessions
  status = active
```

浏览器安装标识保存在 `localStorage`，不是凭据，只用于同一浏览器安装的幂等识别。真正的设备凭据和 Entry Session Token 只存在于 HttpOnly Cookie 与 Gateway Hash 存储中。

## 4. 公共协议

新增 `packages/contracts/src/webEntry.ts`，独立版本：

```ts
WEB_ENTRY_PROTOCOL_VERSION = 1
```

### 4.1 Claim Request

```ts
{
  protocolVersion: 1;
  pairingRef?: string;
  code: string;
  installationId: string; // UUID
  device: {
    displayName: string;
    browser: string;
    operatingSystem: string;
    appVersion: string;
  };
}
```

客户端不能提交 Device Credential、Entry Session Token、Person、Family 或 Assignment。

### 4.2 Public Response

Claim、Context 与 Renew 只返回：

```ts
{
  protocolVersion: 1;
  context: PersonalPortalContext;
}
```

原始 Device Credential 与 Entry Session Token 不进入 JSON。

### 4.3 Operation Response

```ts
{
  protocolVersion: 1;
  status: "logged_out" | "revoked";
}
```

## 5. Cookie 模型

Cookie：

```text
family_ai_web_device_ref
family_ai_web_device_credential
family_ai_web_entry_session_ref
family_ai_web_entry_token
```

属性：

```text
HttpOnly
SameSite=Strict
Path=/
Secure=true（production）
Secure=false（test/development，本机 HTTP）
```

不设置 Domain。Session Cookie 与 Device Cookie 分离：

- logout：撤销并清除 Entry Session Cookie，保留 Device Cookie；
- renew：使用 Device Cookie 创建新 Entry Session；
- revoke device：撤销 Device、Binding、Session，并清除全部 Cookie。

## 6. Web Pairing Repository

新增 `WebEntryRepository`，复用现有 `mobile_pairing_codes` 作为 Person 一次性配对材料。表名是历史命名，wire 语义仍是 Person 设备配对。

Claim 必须：

1. 验证 code / pairingRef、状态、过期时间和失败次数；
2. 验证目标 Family、Person、Membership 与 AssistantAssignment 仍有效；
3. 对安装标识执行幂等匹配；
4. 由 Gateway 生成 32-byte Base64URL Device Credential；
5. 创建或恢复 `web/browser` Device；
6. 创建个人 DeviceBinding 和 Personal EntryBinding；
7. 撤销旧活动 Session，签发新 Session；
8. 将 pairing 标记为 consumed；
9. 返回 Cookie 材料与 Personal Portal Context；
10. 全部在 SQLite 事务内完成。

重复 claim 只有在 installationId 与 Cookie 中的设备身份一致时才能恢复；其他设备必须得到 `PAIRING_CONSUMED`。

## 7. 正式 HTTP 接口

```http
POST   /api/v1/web-entry/pairing/claim
GET    /api/v1/web-entry/context
POST   /api/v1/web-entry/session/renew
POST   /api/v1/web-entry/logout
DELETE /api/v1/web-entry/device
```

- Claim 不依赖已有 Cookie；成功后设置全部 Cookie。
- Context 依赖 Entry Session Cookie。
- Renew 依赖 Device Cookie。
- Logout 依赖 Entry Session Cookie，清除 Session Cookie。
- Device revoke 依赖 Device Cookie，清除全部 Cookie。

## 8. Cookie 到现有 API 的认证适配

新增 `registerWebEntryCookieBridge()`，只在缺少 Authorization Header 时读取 HttpOnly Cookie，并为下列正式个人 API 注入现有 Header 形式：

```text
/api/v1/portal/context
/api/v1/chat
/api/v1/work-conversations
/api/v1/threads/**
/api/v1/events/stream
/api/v1/sync/**
```

既有 iOS Bearer Header 认证优先，行为不变。

### 8.1 CSRF 防护

Cookie 认证的非 GET/HEAD/OPTIONS 请求必须同时满足：

```text
X-Family-AI-Web-Request: 1
Sec-Fetch-Site 缺失或 same-origin
Origin 缺失，或与当前 Host + Protocol 完全一致
```

不满足时返回：

```text
WEB_REQUEST_FORBIDDEN
HTTP 403
```

Claim 不使用认证 Cookie，但仍要求 JSON 且受 SameSite Cookie 模型约束；它只消费一次性短期 pairing code。

## 9. 正式静态入口

本 PR 新增最小产品入口静态壳：

```text
/member/
/member/assets/entry.js
/member/assets/member.css
```

它只承担：

- 检测 Context；
- 输入或自动消费 pairingRef + code；
- 显示当前 Person / Family / Device；
- 显示“工作台将在下一阶段载入”的正常产品骨架；
- logout、继续使用此设备、revoke device；
- 清除 URL pairing 参数。

它不是验收控制台，也不展示调试日志、内部 Ref 列表或验收步骤。

## 10. 一键体验入口

现有 `verify-foundation.sh` / acceptance 脚本在完成真实家庭初始化后：

1. 使用真实 Admin Entry Session 调用现有管理员配对 API；
2. 生成：

```text
http://127.0.0.1:8790/member/?pairingRef=<ref>&code=<code>
```

3. 输出该产品 URL；
4. 浏览器通过正式 Claim API 建立真实 Web Device 和 Cookie Session；
5. 后续所有 Chat / Work 行为与普通用户完全一致。

不再输出“初始化与入口验收台”作为主入口。

## 11. 错误与隐私

- JSON 响应不得包含 Device Credential、Entry Session Token、Cookie 值或 Hash。
- 日志与测试快照不得输出 pairing code、Cookie 或 Authorization。
- 其他 Person、其他 Family 或已消费 pairing 的差异不得泄露目标详情。
- production Cookie 必须 Secure。
- 浏览器脚本不能通过 `document.cookie` 读取认证 Cookie。
- Context、renew、logout、revoke 均沿用 PublicError，不切换到 Mobile Error Envelope。

## 12. 测试

至少覆盖：

1. Web Entry Contracts 严格校验；
2. Claim 创建 `web/browser` Device；
3. Claim JSON 不含凭据，Set-Cookie 为 HttpOnly / SameSite=Strict；
4. production Cookie 包含 Secure；
5. pairing 过期、错误、耗尽、已消费；
6. 同 installation 幂等恢复，其他 installation 拒绝；
7. Context Cookie 认证；
8. Cookie Bridge 可访问 Chat / Work / Sync / SSE；
9. Authorization Header 优先，不被 Cookie 覆盖；
10. Cookie 写请求缺少防护 Header 时 403；
11. logout 保留 Device、清除 Session；
12. renew 创建新 Session；
13. revoke 后所有访问失效；
14. Cookie 和 JSON 隐私扫描；
15. 根路径重定向 `/member/`；
16. development 验收台路由不再注册；
17. PR #14 changed-path 交集为零。

## 13. 范围

允许修改：

```text
packages/contracts/src/webEntry.ts
packages/contracts/src/index.ts
packages/contracts/test/webEntry.test.ts
packages/contracts/fixtures/web-entry/**
apps/gateway/src/webEntry.ts
apps/gateway/src/webEntryRoutes.ts
apps/gateway/src/webEntryCookies.ts
apps/gateway/src/memberWeb.ts
apps/gateway/src/app.ts
apps/gateway/member-public/**
apps/gateway/test/webEntry*.test.ts
apps/gateway/test/memberWeb*.test.ts
scripts/acceptance*.sh
scripts/verify-foundation.sh
docs/superpowers/**
```

明确不修改：

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
```

## 14. 后续 PR #25

PR #25 在 PR #24 合并后从最新 `main` 建立，完成真实 Chat / Work 工作台、SSE、显式补拉、IndexedDB 和累计 ACK。