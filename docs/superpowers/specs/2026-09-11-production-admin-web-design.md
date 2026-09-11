# Production Admin Web 设计

## 状态

待用户审核。目标是修复当前正式 Family 入口 `/admin/` 返回 404 的问题，
不把旧 development Preview 当成正式后台。

## 背景与现状

- 正式 Family 容器以 `GATEWAY_MODE=production` 运行在内部 `8790`，由 LAN
  TLS 入口 `8793` 反代。
- `registerAdminWeb()` 当前仅在 `development` 注册 `/admin/` 静态页面，
  因此正式入口 `https://admin-yr.tailf7be7d.ts.net:8793/admin/` 返回 404。
- `/api/v1/admin/*` 管理 API 已存在，并要求 `family_admin` Entry Session；
  当前有效管理员 Entry Session 仍可使用。
- 旧 `:9443/admin/` 属于 `/home/youran/Development/family-ai-platform`
  的 development Preview，不属于当前 V15 数据和正式 Broker 链路。

## 目标

1. 正式 `:8793/admin/` 能打开并提供成员、Agent、配对和系统工作台管理。
2. 保持 `GATEWAY_MODE=production`，不启用 Fake Provider、development
   Preview 自动入口或旧 `:9443` 链路。
3. 管理读写始终绑定当前 `family_admin` Entry Session 和 Family；普通成员、
   无会话和过期会话不能获得管理员能力。
4. 令牌不进入 URL、日志、HTML、前端构建产物或持久化的浏览器
   `localStorage`；浏览器只使用 `Secure; HttpOnly; SameSite=Strict` 会话 Cookie。
5. Canvas 的“管理 Agent”链接继续指向正式 `:8793/admin/`；已有管理员
   Cookie 直接进入，没有 Cookie 时使用一次性短码激活，不再指向旧 Preview。

## 非目标

- 本次不切换到用户名/密码、OAuth 或公网身份服务。
- 本次不把根域名 443 从 CodexPro MCP 改成 Family Web。
- 本次不扩大 LAN/Tailscale 监听范围，不新增宿主机端口。
- 本次不删除旧 Preview，直到正式 Admin Web 完成浏览器验收并确认旧入口
  不再需要；验收后才停止旧 Preview 进程和 `:9443` 监听。

## 推荐方案：生产静态 Admin Web + Cookie 绑定

### 1. 静态页面注册

`registerAdminWeb()` 在 `test` 仍关闭，在 `production` 和 `development` 都
注册静态页面及 `/admin/assets/*`。静态页面本身不返回任何凭据；所有管理
API 仍由已有 `requireEntryRequest(request, entryAuthenticator, "family_admin")`
保护。

### 2. 浏览器认证来源

管理员浏览器有两种合法状态：已经拥有 Family 签发的
`family_ai_web_entry_session_ref` 与 `family_ai_web_entry_token` Cookie，或在
Admin Web 的一次性激活表单中输入 operator 刚生成的短码。Cookie 不可被
JavaScript 读取。服务端扩展 Web Cookie bridge，使 `/api/v1/admin/*` 请求也
能把这两个 Cookie 转换为当前请求的 `Authorization` 与
`X-Entry-Session-Ref`，然后继续走现有 Entry Session 认证和
`family_admin` audience 检查。

所有带 Cookie 的非 GET 管理请求必须同时携带现有
`X-Family-AI-Web-Request: 1`、同源 `Sec-Fetch-Site` 和匹配 Origin；缺失或
跨源时返回 `WEB_REQUEST_FORBIDDEN`。显式 Bearer 只保留给测试/受控服务调用，
不由生产页面生成或回显。

### 3. 生产管理员一次性激活

新增受保护的 operator 脚本 `scripts/admin-production-activate.mjs`：

- 读取权限 0600 的管理员 Entry 文件，只校验其结构和当前有效性；
- 在同目录以权限 0600 原子写入带 salt 的短码 hash 和五分钟过期时间；
- stdout 只输出 `XXXXX-XXXXX expiresAt=<RFC3339>`，不输出 Entry token、URL 或
  文件内容；
- 每次生成会原子替换旧的未使用激活记录。

production Gateway 进程通过只读 bind mount 获得管理员 Entry 文件和激活记录，
路径由显式环境变量 `GATEWAY_PRODUCTION_ADMIN_ENTRY_PATH` 与
`GATEWAY_PRODUCTION_ADMIN_ACTIVATION_PATH` 配置；两者必须是 regular file、
权限 0600、非 symlink，并且只读挂载到 `/run/admin-bootstrap/`；静态 Web
资源和其他产品容器不挂载这两个文件。部署脚本
不把文件内容写入日志或台账。

新增 `POST /api/v1/admin/activate`，仅在 `GATEWAY_ADMIN_WEB_ENABLED=1` 的
production/development Admin Web 配置下注册。请求 body 严格为：

```json
{"code":"XXXXX-XXXXX"}
```

端点要求 HTTPS 同源 Origin、`Sec-Fetch-Site: same-origin`，验证短码 hash、
时间、管理员 Entry 文件和 `family_admin` audience，然后原子消费激活记录。
成功时只通过 `Set-Cookie` 写入 `Secure; HttpOnly; SameSite=Strict` 的两个
管理员 Web Session Cookie，响应 body 仅为 `{"activated":true}`；绝不返回
token。错误不会泄露哪一项校验失败，并返回安全错误码。production 不注册
`/api/v1/admin/access-mode`、`/api/v1/admin/preview-access`、
`/api/v1/admin/preview-entry` 或旧 Preview 激活端点。

### 4. Admin Web 前端启动

`admin.js` 启动时先调用 Cookie-backed `context()` 与 `members()`：

- 成功且 audience 为 `family_admin`：显示管理页面；
- 返回 `ENTRY_SESSION_EXPIRED`、`ENTRY_SESSION_INVALID` 或
  `ENTRY_AUDIENCE_FORBIDDEN`：显示重新进入管理员入口的提示；
- 没有管理员 Cookie：显示短码激活表单，激活成功后清空 code 输入并重新
  读取 context；
- 不再在 production 调用 `/api/v1/admin/access-mode`、
  `/api/v1/admin/preview-access` 或 `/api/v1/admin/preview-entry`。

development 的现有 Preview 自动入口保持原行为，只在显式 development 配置
下可用，避免生产回退到 protected Admin credential 文件。

### 5. 管理员会话与旧入口收口

部署后 operator 在本机执行激活脚本，把短码交给管理员；浏览器只提交短码，
不需要复制 token 或打开带 token 的 URL。个人入口不会自动升级为管理员。

正式 Admin Web 浏览器验收成功后：

- Canvas 管理链接在正式 `:8793/admin/` 返回页面并完成一次真实管理读取；
- 旧 `:9443` Preview 停止，端口不再监听；
- 任何文档、台账和测试不再把 `:9443` 当正式管理员入口；
- `:8793`、`:3001`、`:8766` 端口保持不变，更新
  `/home/youran/data/service-ports.md` 和 `.json`。

## 错误与安全边界

- 无管理员 Cookie：页面可加载静态壳，但管理数据请求必须 401/403。
- personal audience：始终返回 `ENTRY_AUDIENCE_FORBIDDEN`，绝不自动升级。
- 过期/撤销设备：返回已有安全错误并清除 Web Session Cookie。
- 管理 API 失败：前端显示安全错误，不显示 token、数据库路径或内部堆栈。
- `/admin/` 静态资源使用 `no-store`、CSP、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer` 和 `Permissions-Policy`。

## 验收标准

1. RED：production `/admin/` 当前 404 的回归测试，以及无 Cookie 管理 API
   401/403 测试。
2. GREEN：production `/admin/` 返回 200；Cookie-backed `family_admin`
   context/members 返回 200；personal audience 被拒绝。
3. Playwright/Chrome 在强制 LAN DNS (`192.168.110.84`) 下打开
   `:8793/admin/`，页面显示“家庭管理”、家庭摘要和成员列表，无 token 出现在
   URL、console 或 localStorage。
4. Canvas 点击“前往 Family AI 管理 Agent 分配”后到达同一正式 Admin Web；
   不出现 404，不访问 `:9443`。
5. 生产重启后 `/admin/`、管理 API、`:3001` Canvas 和 `:8766` ME 均保持健康；
   数据库 quick check 与 foreign-key check 通过。

## 方案取舍

- 直接把 `GATEWAY_MODE` 改成 `development`：拒绝，会启用不适合正式数据的
  Preview 自动入口和 Fake/开发语义。
- 把 Canvas 链接改到旧 `:9443`：拒绝，数据、版本和认证边界不一致。
- 在生产返回管理员 token 或把 token 放入 URL：拒绝，违反数据安全目标。
- 推荐的 Cookie bridge：复用现有身份和授权代码，新增面最小，生产页面不接触
  长期凭据，且能保持三个产品相同的 Family 身份体验。
