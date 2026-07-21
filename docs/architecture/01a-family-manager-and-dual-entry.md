# 家庭管家与 Admin / Personal 双入口稳定架构

- 状态：稳定基线
- 日期：2026-07-21
- 上位规范：[`01-identity-and-binding.md`](./01-identity-and-binding.md)

## 1. 修正目标

`AssistantAssignment` 只解决 Person 的个人助理路由，不能同时承担家庭管理入口的 Agent 路由。

平台必须区分：

```text
家庭管理入口
→ Family 权限上下文
→ FamilyManagerAssignment
→ 家庭管家 Agent
```

```text
个人入口
→ Person 权限上下文
→ AssistantAssignment
→ 个人助理 Agent
```

家庭管家和个人助理不是同一个角色，也不能仅靠前端按钮临时切换。

## 2. 同一个人，不复制 Person

家庭创建者通常同时是家庭所有者和普通家庭成员。

正确模型：

```text
Family
└── Person: 创建者
    ├── FamilyMembership: owner
    ├── Admin Entry
    └── Personal Entry
```

错误模型：

```text
管理员 Person
个人成员 Person
```

管理身份和个人身份不能被错误建成两个 Person，否则会造成记忆、Chat、Work、设备和权限重复。

## 3. FamilyManagerAssignment

```text
FamilyManagerAssignment
- assignment_id
- family_id
- family_manager_role_ref
- agent_ref
- provider_profile_ref
- status
- effective_from
- effective_to nullable
```

规则：

- 归属于 Family，不归属于某个管理员 Person；
- 第一版一个 Family 同时只有一个 active Assignment；
- 具体 Agent 和 Provider 可以替换；
- 家庭级历史和公共事务不能因更换 Provider 而丢失；
- 家庭管理员只是获得调用该家庭管家的权限，不拥有家庭管家本身。

## 4. AssistantAssignment

```text
AssistantAssignment
- assignment_id
- person_id
- assistant_role_ref
- agent_ref
- provider_profile_ref
- status
- effective_from
- effective_to nullable
```

规则：

- 只归属于 Person；
- 管理员本人也拥有自己的 AssistantAssignment；
- 新增家庭成员时可以预创建个人助理 Assignment；
- 预创建 Assignment 不等于管理员可以进入该成员的私人空间。

## 5. 同一设备上的两套独立入口

一台物理设备可以同时承载 Admin 和 Personal 两类入口：

```text
同一 Device
同一 Person
├── Admin EntryBinding / EntrySession
│   ├── audience: family_admin
│   ├── scope: Family
│   └── FamilyManagerAssignment
└── Personal EntryBinding / EntrySession
    ├── audience: personal
    ├── scope: Person
    └── AssistantAssignment
```

必须独立的内容：

- EntryBinding；
- EntrySession；
- Session Token；
- audience；
- 权限范围；
- 默认 Agent；
- 页面状态；
- 后续消息与上下文空间。

可以共享的内容：

- Person；
- Device；
- FamilyMembership；
- 已认证设备信任信息。

## 6. EntrySession

```text
EntrySession
- entry_session_id
- entry_binding_id
- token_hash
- audience
- status
- created_at
- expires_at
- revoked_at nullable
```

Session Token 只在创建时返回一次，数据库只保存 Hash。

每次请求由 Gateway 执行：

```text
Session Credential
→ EntrySession
→ EntryBinding
→ Device / Person / Family
→ FamilyMembership
→ audience
→ FamilyManagerAssignment 或 AssistantAssignment
→ AuthorizationContext
```

客户端不得在请求正文中声明一个可被直接信任的 `person_id`、`family_id` 或 `agent_ref`。

## 7. audience 权限

第一版只定义两类：

```text
family_admin
personal
```

### family_admin

允许：

- 查看和管理本家庭成员；
- 管理家庭级设备和入口；
- 处理家庭公共事务；
- 调用家庭管家；
- 为成员预创建个人助理 Assignment。

默认不允许：

- 进入其他成员私人 Chat；
- 读取其他成员私人 Work；
- 读取其他成员个人长期记忆；
- 代替成员创建其私人入口 Session。

### personal

允许：

- 访问当前 Person 的个人空间；
- 调用当前 Person 的个人助理；
- 后续访问自己的 Chat、Work、记忆和任务。

默认不允许：

- 调用 Admin API；
- 管理家庭成员；
- 修改家庭级 Agent 路由；
- 读取其他 Person 的私人对象。

## 8. 首次建家

第一版首次建家只收集：

```text
家庭名称
创建者姓名
当前设备名称
```

事务内创建：

```text
Family
Person
FamilyMembership(owner)
Device
DeviceBinding(person)
FamilyManagerAssignment
AssistantAssignment
Admin EntryBinding + EntrySession
Personal EntryBinding + EntrySession
```

手机号、账号和密码不属于该最小闭环。

## 9. 新增成员

管理员新增成员时创建：

```text
Person
FamilyMembership
AssistantAssignment
```

不自动创建：

```text
当前管理员 Device 上的 Personal EntryBinding
当前管理员可使用的新成员 EntrySession
```

新成员必须在后续通过本人认领流程建立自己的 Identity、EntryBinding 和 DeviceBinding。

## 10. 验收原则

- 创建者在数据库中只有一个 Person；
- Admin 与 Personal 使用同一个 Person 和 Device；
- 两类 Session Ref 和 Token 不同；
- Admin 默认 Agent 是家庭管家；
- Personal 默认 Agent 是个人助理；
- Personal Session 调用 Admin API 返回权限错误；
- 新成员获得个人助理 Assignment，但管理员不会自动获得其私人入口；
- Gateway 重启后两套 Session 仍能从数据库恢复；
- 页面、日志和公共 API 不暴露原始 Session Token。
