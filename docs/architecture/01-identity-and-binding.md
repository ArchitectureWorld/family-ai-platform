# Identity 与 Binding 稳定架构

## 1. 目标

本规范定义 Family、Person、外部身份、入口绑定、设备绑定和个人助理分配的边界。

核心目标是：无论用户从 Web、iOS、HarmonyOS、DIY 或后续其他入口进入，Gateway 都解析到同一个 `person_id`，并访问同一份 Chat、Work、记忆和任务状态。

## 2. 核心对象

### 2.1 Family

```text
Family
- family_id
- display_name
- status
- created_at
- updated_at
```

Family 是家庭级数据、共享终端、家庭总管和家庭公共事务的边界。

### 2.2 Person

```text
Person
- person_id
- family_id
- display_name
- status
- locale
- timezone
- created_at
- updated_at
```

`person_id` 是内部不可变身份主键。

手机号、Apple 账号、华为账号、微信 OpenID、浏览器账号和设备凭证都不能直接替代 Person。

### 2.3 FamilyMembership

```text
FamilyMembership
- family_id
- person_id
- family_role
- status
- joined_at
- updated_at
```

第一版角色保持简单：

```text
owner
adult
child
elder
```

其中 `child` 和 `elder` 首期只作为角色标识，不立即引入复杂专属策略。

### 2.4 Identity

```text
Identity
- identity_id
- identity_type
- identity_value_hash
- verified_at
- status
- created_at
- updated_at
```

Identity 表示外部可验证身份，例如：

- phone；
- apple_account；
- huawei_account；
- wechat_openid；
- local_account；
- device_credential。

敏感 `identity_value` 不应以可检索明文无条件存储。具体是否加密、Hash 或拆分保存由身份类型决定。

### 2.5 EntryBinding

```text
EntryBinding
- entry_binding_id
- identity_id
- person_id
- entry_type
- status
- bound_at
- last_used_at
```

EntryBinding 是“某个外部身份如何解析到 Person”的日常分流关系。

稳定链路：

```text
外部账号 / 浏览器 Session / 设备凭证
→ 验证 Credential
→ EntryBinding
→ person_id
→ 权限与 AssistantAssignment
```

### 2.6 Device

```text
Device
- device_id
- terminal_type
- platform
- owner_scope
- capability_profile
- trust_level
- status
- created_at
- updated_at
```

`owner_scope`：

```text
person
family
```

Device 是独立可管理实体，必须支持冻结、解绑、凭证轮换和远程失效。

### 2.7 DeviceBinding

```text
DeviceBinding
- device_binding_id
- device_id
- owner_scope
- person_id nullable
- family_id nullable
- status
- bound_at
- revoked_at
```

规则：

- 个人设备绑定 Person；
- 家庭共享设备绑定 Family；
- 家庭共享设备在每次访问私人内容前还必须解析当前 Person；
- `person_id` 与 `family_id` 的合法组合必须由数据库约束保证。

### 2.8 AssistantAssignment

```text
AssistantAssignment
- assistant_assignment_id
- person_id
- assistant_role_ref
- agent_ref
- provider_profile_ref
- status
- effective_from
- effective_to nullable
```

个人助理是一个长期角色，具体 Agent 与 Provider 可以替换。

因此 HomeChatStream 和 Work Conversation 归属于 Person，不应因更换 Provider 而重新创建。

## 3. 手机号职责

手机号只用于：

- 首次查找预创建 Person；
- 验证和认领；
- 找回或重新绑定；
- 必要的安全通知。

手机号不是：

- 数据库永久主键；
- 每次请求的分流参数；
- Chat / Work 的所有者 ID；
- Agent 的直接绑定键。

手机号更换不能影响 Person、Chat、Work 和记忆。

## 4. 首次认领流程

```text
管理员预创建 Person
→ 配置可认领手机号
→ 用户输入手机号
→ 验证码通过
→ Gateway 查找唯一候选 Person
→ 用户确认显示信息
→ 创建 / 激活 Identity
→ 创建 EntryBinding
→ 注册当前设备
→ 创建 DeviceBinding
→ 读取 AssistantAssignment
→ 进入 HomeChatStream
```

安全要求：

- 同一手机号出现多个可认领 Person 时禁止自动选择；
- 验证码限制次数、有效期和重放；
- 认领成功后旧验证码立即失效；
- 认领操作写入安全事件；
- 不在客户端暴露其他家庭成员候选信息。

## 5. 后续登录与分流

后续请求不再要求手机号：

```text
Credential / Browser Session / Device Token
→ Gateway Authentication
→ EntryBinding / DeviceBinding
→ Person
→ FamilyMembership
→ Permission Context
→ AssistantAssignment
→ Chat / Work
```

客户端消息可以包含：

- `device_id`；
- `connection_id`；
- `client_message_id`；
- 目标 Chat 或 Work 对象引用。

客户端不得声明一个可被服务端直接信任的 `person_id`。服务端解析结果是唯一权威。

## 6. 个人设备与家庭共享设备

### 6.1 个人设备

```text
device_id
→ DeviceBinding(person)
→ person_id
→ HomeChatStream / Work
```

可信个人设备可以在有效登录态下访问个人数据，但敏感操作仍可要求系统认证或二次确认。

### 6.2 家庭共享设备

```text
device_id
→ DeviceBinding(family)
→ family_id
→ 当前使用人识别 / 选择
→ person_id 或 public-family-context
```

身份未确认时，只允许：

- 家庭公共提醒；
- 家庭日程摘要；
- 晚餐等公共事务；
- 非敏感问答；
- 访客模式。

默认禁止：

- 私人 Work；
- 私人消息；
- 个人长期记忆；
- 敏感日程；
- 账号安全信息。

## 7. 生命周期

所有绑定对象至少支持：

```text
pending
active
revoked
suspended
```

需要覆盖：

- 更换手机；
- 手机号变化；
- 设备丢失；
- 设备转赠；
- 退出登录；
- 主动解绑；
- 家庭成员冻结；
- Person 合并或身份冲突人工处理。

第一版不自动合并 Person。任何合并必须是显式管理操作并保留审计记录。

## 8. 权限上下文

每次请求在进入 Chat / Work 前构建：

```text
AuthorizationContext
- family_id
- person_id nullable
- family_role nullable
- device_id
- device_owner_scope
- trust_level
- entry_type
- granted_capabilities
- authentication_strength
```

Gateway 依据该上下文判断：

- 可以访问哪些对象；
- 是否可以显示敏感信息；
- 是否允许文件、语音和执行动作；
- 是否需要二次确认；
- 输出应发送到哪些终端。

## 9. 第一版最小范围

必须：

- Family；
- Person；
- FamilyMembership；
- phone Identity；
- EntryBinding；
- Device；
- DeviceBinding；
- AssistantAssignment；
- 冻结与解绑；
- 个人设备和家庭共享设备边界。

暂缓：

- 自动声纹；
- 人脸识别；
- 账号自动合并；
- 复杂权限矩阵；
- 企业级组织结构；
- 多家庭切换体验。

## 10. 验收原则

- 同一用户从不同终端解析到同一 `person_id`；
- 更换手机号不改变 Person、Chat 和 Work；
- 客户端伪造 `person_id` 无效；
- 设备解绑后旧 Credential 立即失效；
- 家庭共享设备在身份不明确时无法读取私人 Work；
- 更换 Assistant Provider 不丢失 Chat / Work；
- 所有认领、解绑、冻结和恢复事件可追溯。
