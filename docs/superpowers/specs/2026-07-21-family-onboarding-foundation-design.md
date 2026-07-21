# Family Onboarding Foundation 设计

- 日期：2026-07-21
- 状态：已确认，可实施
- 分支：`feat/family-onboarding-foundation`
- 对应权威架构：`docs/architecture/01-identity-and-binding.md`

## 1. 目标

本阶段把 Gateway Foundation 的可靠技术内核与正式 Family / Person 领域连接起来，并提供一个非技术用户可以独立完成的本机浏览器验收闭环。

用户只需运行一条命令并在浏览器完成：

```text
创建家庭
→ 创建首位管理员 Person
→ 绑定当前物理设备
→ 自动建立管理入口与个人入口
→ 在双入口门户中分别进入
→ 验证家庭管家与个人助理路由不同
→ 新增其他家庭成员
→ 重启后数据仍存在
```

本阶段不开发 Chat、Work、手机号认领、正式账号密码或真实 Hermes Provider。

## 2. 已确认产品决策

### 2.1 家庭规模

第一版只支持一个 Family，但 Family 内可创建多个 Person。

### 2.2 首次建家输入

首次初始化只填写：

- 家庭名称；
- 管理员姓名；
- 当前设备名称。

系统自动生成不可变 `family_ref`、`person_ref` 和 `device_ref`。不要求手机号、账号或密码。

### 2.3 同一个人同时具备两类入口

首位创建者只创建一个 Person，同时具有：

```text
FamilyMembership: owner
├── Admin Entry
│   ├── audience: family_admin
│   ├── scope: Family
│   └── 默认 Agent: family manager
└── Personal Entry
    ├── audience: personal
    ├── scope: Person
    └── 默认 Agent: personal assistant
```

不得为管理身份和个人身份复制两个 Person。

### 2.4 同一物理设备、两个独立入口会话

两套入口共享同一个 `device_ref` 和 `person_ref`，但必须具有不同的：

- `entry_binding_ref`；
- `entry_session_ref`；
- Session Token；
- audience；
- 权限范围；
- 默认 Agent；
- 浏览器页面状态。

### 2.5 双入口门户

初始化完成后显示两个一级入口卡片：

- 家庭管理：家庭成员、设备、权限和家庭级事务，默认连接家庭管家；
- 个人空间：个人 Chat、Work 和记忆的后续入口，当前阶段只显示身份和个人助理路由。

页面顶部始终显示当前入口类型，避免用户混淆。

## 3. 领域对象

### 3.1 Family

```text
families
- family_ref
- display_name
- status
- created_at
- updated_at
```

### 3.2 Person 与 FamilyMembership

```text
persons
- person_ref
- display_name
- status
- created_at
- updated_at

family_memberships
- family_ref
- person_ref
- family_role
- status
- joined_at
- updated_at
```

第一版角色：`owner`、`adult`、`child`、`elder`。

### 3.3 ManagedDevice 与 DeviceBinding

Foundation 已存在用于旧消息闭环的 `devices` 表。本阶段不把该验证表直接扩展为正式 Device，而新增明确的正式领域表：

```text
managed_devices
- device_ref
- display_name
- terminal_type
- platform
- status
- credential_hash
- created_at
- updated_at
- revoked_at

device_bindings
- device_binding_ref
- device_ref
- owner_scope
- family_ref
- person_ref
- status
- bound_at
- revoked_at
```

首位管理员的当前设备绑定 Person；同一设备可承载两个入口会话。

### 3.4 Agent Assignment

家庭级和个人级 Agent 必须分开建模：

```text
family_manager_assignments
- assignment_ref
- family_ref
- agent_ref
- provider_profile_ref
- status
- effective_from
- effective_to

assistant_assignments
- assignment_ref
- person_ref
- agent_ref
- provider_profile_ref
- status
- effective_from
- effective_to
```

家庭管理入口读取 `FamilyManagerAssignment`；个人入口读取 `AssistantAssignment`。

### 3.5 EntryBinding 与 EntrySession

```text
entry_bindings
- entry_binding_ref
- device_ref
- family_ref
- person_ref
- audience
- status
- bound_at
- last_used_at

entry_sessions
- entry_session_ref
- entry_binding_ref
- token_hash
- status
- created_at
- expires_at
- revoked_at
```

`audience` 第一版只允许：

```text
family_admin
personal
```

Session Token 只在创建时返回一次，数据库只保存 SHA-256 Hash。

## 4. 初始化与认证流程

### 4.1 初始化状态

```http
GET /api/v1/onboarding/status
```

只返回：

```json
{ "initialized": false }
```

不得泄露家庭、成员、设备或 Token 信息。

### 4.2 创建家庭

```http
POST /api/v1/onboarding/family
Authorization: Bearer <development bootstrap token>
X-Device-Ref: device:test
```

请求：

```json
{
  "familyName": "我的家庭",
  "ownerName": "张三",
  "deviceName": "Linux 电脑"
}
```

同一数据库只允许成功一次。事务内创建 Family、Person、Membership、ManagedDevice、DeviceBinding、两类 Assignment、两个 EntryBinding 和两个 EntrySession。

响应包含两个只返回一次的 Session Token，验收台存入 `sessionStorage`。

### 4.3 入口认证

后续入口请求使用：

```http
Authorization: Bearer <entry session token>
X-Entry-Session-Ref: entry-session:...
```

Gateway 从 Session → EntryBinding → Device / Person / Family → Assignment 构建服务端上下文。客户端不能通过请求正文指定 `person_ref` 或 Agent。

### 4.4 入口上下文

```http
GET /api/v1/portal/context
```

管理入口返回 Family、Person、Device、Membership 与家庭管家；个人入口返回 Person、Device 与个人助理。

### 4.5 管理成员

```http
GET /api/v1/admin/members
POST /api/v1/admin/members
```

只允许 `family_admin` Session。新增成员只填写姓名和角色；系统为其创建 Person、Membership 和个人助理 Assignment。新成员暂为待认领状态，不自动让当前管理员设备进入该成员私人空间。

个人入口访问管理 API 必须返回 `403 ENTRY_AUDIENCE_FORBIDDEN`。

## 5. 浏览器验收台

Development 模式根页面改为“家庭 AI 初始化与入口验收台”。

### 5.1 未初始化

显示三项表单和“创建家庭”按钮。成功后自动进入双入口门户。

### 5.2 已初始化且浏览器持有 Session

显示两个入口卡片。点击后显示：

- 当前 audience；
- Family / Person；
- Device；
- 默认 Agent；
- 权限说明。

管理入口额外显示成员列表和新增成员表单。

### 5.3 已初始化但浏览器丢失 Session

页面明确提示：本阶段没有账号恢复流程；执行 `./scripts/dev-reset.sh` 后重新体验。不得绕过认证重新返回 Token。

## 6. Foundation Hardening

### 6.1 依赖锁和 Node 版本

- 提交新仓库生成的 `package-lock.json`；
- 根 `@types/node` 调整为 Node 22 主版本；
- Dockerfile 和 CI 只允许 `npm ci`；
- 缺少锁文件时质量门禁直接失败。

### 6.2 运行组合根

`buildGatewayApp` 不得在 production 中自动运行 Development Bootstrap 或默认创建 Fake Provider。

当前尚无正式 Provider Registry 和生产认证，因此 `GATEWAY_MODE=production` 必须拒绝启动，并给出稳定配置错误。Development / Test 继续显式使用 Fake Provider 和 bootstrap。

### 6.3 Public Error

所有公开错误统一返回：

```json
{
  "code": "ENTRY_SESSION_INVALID",
  "category": "permission",
  "message": "入口会话无效或已失效。",
  "retryable": false
}
```

错误正文不得包含 SQL、堆栈、Token、绝对路径或 Provider stderr。

## 7. 数据迁移

新增编号 Migration V2。现有 Migration V1 和 Foundation 数据保持可读，不删除、不改写用户运行数据。

Migration V2 必须：

- 可重复打开数据库；
- 在一次事务中创建全部新表和索引；
- 更新 `schema_migrations` 到版本 2；
- 通过 `foreign_key_check`；
- 不自动创建任何 Family 或 Person。

因此“空库”指正式 Family / Person 领域为空；Development Bootstrap 仍只服务旧 Foundation 消息验收和一次性初始化授权。

## 8. 小白验收标准

运行：

```bash
./scripts/verify-foundation.sh
```

浏览器完成：

1. 输入家庭名称、管理员姓名和设备名称；
2. 创建成功后看到家庭管理和个人空间两张卡片；
3. 家庭管理显示家庭管家 Agent；
4. 个人空间显示个人助理 Agent；
5. 两个入口显示同一个 Person 和同一个 Device，但 Session Ref 不同；
6. 在家庭管理中新增一位成员；
7. 个人入口看不到成员管理功能，调用管理 API 返回 403；
8. 刷新页面后两套入口仍可用；
9. 重启 Gateway 后家庭、成员和入口 Session 仍可恢复；
10. 执行 reset 后重新回到首次建家页面。

## 9. 明确不做

- Chat / Work；
- 手机号验证码；
- 正式账号、密码、Cookie Session；
- 多家庭切换；
- 新成员自动登录或管理员代入其私人空间；
- 真实 Hermes / Codex / OpenClaw 调用；
- 公网、局域网或 TLS；
- 复杂权限矩阵；
- Session 刷新和账号恢复。
