# Jarvis / 于途 Hermes 绑定与一键配置设计

- 日期：2026-07-25
- 分支：`feat/hermes-jarvis-yutu-bindings`
- 依赖：PR #28 `feat(provider): connect Gateway to Hermes profiles`
- 目标：把家庭管理入口绑定到 Hermes `jarvis`，把当前家庭 Owner 的个人助理绑定到 Hermes `zzh`（产品显示名“于途”），其他成员保持现状。

## 1. 最终映射

| Family AI 范围 | Agent | Provider Profile | Hermes Profile / Model | 端口 | 产品显示名 |
|---|---|---|---|---:|---|
| `family_admin` | `agent:jarvis` | `provider-profile:hermes-jarvis` | `jarvis` | 8650 | Jarvis |
| 当前 Family Owner 的 `personal` | `agent:yutu` | `provider-profile:hermes-zzh` | `zzh` | 8651 | 于途 |
| 其他家庭成员的 `personal` | 保持当前 Assignment | 保持当前 Profile | 不变 | — | 不变 |

本阶段不把所有成员统一切换到 `zzh`，也不把家庭管理对话混入 Owner 的 Home Chat。

## 2. 领域原则

### Gateway 是 Assignment 权威

Hermes Profile 名称、端口和运行状态不能直接决定某个 Person 使用哪个 Agent。正式路由仍由以下数据库事实决定：

```text
Entry audience
→ active family_manager_assignments / assistant_assignments
→ agent_ref + provider_profile_ref
→ ProviderAdapterRouter
```

### 历史 Assignment 保留

切换时不原地覆盖旧 Assignment：

```text
旧 active Assignment
→ status = ended
→ effective_to = 切换时间

新 Assignment
→ 新 assignment_ref
→ status = active
→ effective_from = 切换时间
```

这样可以追踪历史，也让现有 `ChatWorkProviderRepository` 检测 Assignment 变化并清除旧 Provider Session。

### 现有 Chat / Work 不重建

下一条消息时：

```text
原 Chat / Work Thread 保留
→ resolveContext 发现 Assignment / Profile 改变
→ 清除旧 external_session_ref
→ Hermes Adapter 创建新的稳定 Session
```

消息、Work、Device Sync Cursor 和本地 Web 投影都不重置。

## 3. 固定 Preset

新增唯一允许的运行时 Preset：

```text
hermes-jarvis-yutu-v1
```

环境变量：

```text
GATEWAY_AGENT_ASSIGNMENT_PRESET=hermes-jarvis-yutu-v1
```

不允许从环境变量自由传入 Agent Ref、Provider Profile Ref 或 Person Ref，避免运行配置绕过受审查的绑定规则。

## 4. Agent Defaults

新增 `apps/gateway/src/agentAssignments.ts`，定义：

```ts
export type AgentAssignmentPreset = "hermes-jarvis-yutu-v1";

export interface AgentTarget {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  providerKind: "fake" | "hermes" | "codex";
  providerDisplayName: string;
}

export interface FamilyAgentDefaults {
  familyManager: AgentTarget;
  ownerAssistant: AgentTarget;
  memberAssistant: AgentTarget;
}
```

固定常量：

```text
DEVELOPMENT_AGENT_DEFAULTS
HERMES_JARVIS_YUTU_DEFAULTS
```

`memberAssistant` 在 Hermes Preset 下仍为：

```text
agent:personal-assistant
provider-profile:fake-local
```

因此以后创建的新非 Owner 家庭成员不会意外继承 Owner 的 `zzh`。

## 5. Assignment Repository

`AgentAssignmentRepository.applyPreset()` 在一个 SQLite 事务内：

1. 注册并验证目标 Provider Profiles；
2. 注册并验证目标 Agents；
3. 遍历所有 active Family，迁移 active Family Manager Assignment；
4. 遍历所有 active Owner Membership，迁移 active Personal Assistant Assignment；
5. 不触碰 adult / child / elder 的 Personal Assignment；
6. 重复执行时不新增重复 Assignment；
7. 若目标 `provider_profile_ref` 已存在但 `provider_kind` 不是 `hermes`，拒绝启动；
8. 若目标 `agent_ref` 已存在但显示名不同，更新到受控显示名；
9. 返回不含 Person 名称和凭据的计数摘要。

返回：

```ts
{
  preset: "hermes-jarvis-yutu-v1",
  familyManagersMigrated: number,
  ownersMigrated: number,
  familyManagersAlreadyCurrent: number,
  ownersAlreadyCurrent: number
}
```

## 6. Family 初始化与新增成员

`FamilyDomainRepository` 接收 `FamilyAgentDefaults`：

```ts
new FamilyDomainRepository(db, { defaults })
```

### 新建家庭

Preset 生效时，第一次初始化立即创建：

```text
Family Manager → Jarvis
Owner Assistant → 于途 / zzh
```

同时注册默认普通成员的 Fake Personal Assistant，保证后续 `createMember()` 有合法外键目标。

### 新增成员

始终使用 `defaults.memberAssistant`。在本 Preset 中它仍是 Fake Personal Assistant。

## 7. Gateway 启动顺序

```text
loadGatewayConfig
→ loadRuntimeProviderAdapter
→ open SQLite
→ runDevelopmentBootstrap（非 production）
→ apply Agent Assignment Preset（如配置）
→ construct FamilyDomainRepository(defaults)
→ register routes
```

Preset 必须在 `FamilyDomainRepository` 开始对外提供认证上下文前完成。

## 8. 宿主机 Hermes 一键配置

新增：

```text
scripts/configure-hermes.py
scripts/configure-hermes.sh
```

默认处理两个 Hermes Profile：

```text
jarvis
zzh
```

### Profile 安全规则

- Profile 目录不存在时调用 `hermes profile create <name>`；
- 绝不覆盖现有 `config.yaml`、`SOUL.md`、memory、skills、sessions；
- 只幂等更新每个 Profile 的 `.env` 中以下键：

```text
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8650 / 8651
API_SERVER_MODEL_NAME=jarvis / zzh
API_SERVER_KEY=<保留已有；缺失时生成 32 字节随机 hex>
```

- 保留 `.env` 的其他行、注释和未知配置；
- `.env` 原子写入，权限 `0600`；
- API Key 不打印到终端。

### Gateway Runtime JSON

脚本从两个 Profile 的 `.env` 读取 Key，原子写入：

```text
.runtime/config/providers.json
```

并设置权限 `0600`。文件结构：

```json
{
  "version": 1,
  "profiles": [
    {
      "kind": "hermes",
      "providerProfileRef": "provider-profile:hermes-jarvis",
      "baseUrl": "http://host.docker.internal:8650",
      "apiKey": "<jarvis key>",
      "model": "jarvis",
      "sessionKey": "family-ai:hermes:jarvis"
    },
    {
      "kind": "hermes",
      "providerProfileRef": "provider-profile:hermes-zzh",
      "baseUrl": "http://host.docker.internal:8651",
      "apiKey": "<zzh key>",
      "model": "zzh",
      "sessionKey": "family-ai:hermes:zzh"
    }
  ]
}
```

同时写入无秘密标记文件：

```text
.runtime/config/hermes-jarvis-yutu.enabled
```

`dev-up.sh` 只有在 Provider JSON 与该标记同时存在时才添加：

```text
GATEWAY_AGENT_ASSIGNMENT_PRESET=hermes-jarvis-yutu-v1
```

## 9. Hermes Gateway 启动

脚本参数：

```text
--configure-only   只写配置，不启动服务
--no-health-check  启动后不等待模型健康（仅故障排查）
```

默认流程：

1. 配置 Profile；
2. 对每个 Profile 执行受超时保护的 `hermes -p <profile> gateway restart`；
3. 若 restart 失败，尝试 `gateway install --force` 后 `gateway start`；
4. 每个子进程有固定超时，防止 CLI 进入前台导致脚本永久挂起；
5. 通过 `127.0.0.1:<port>/v1/models` + Bearer Key 检查模型名；
6. 成功后运行 `scripts/dev-up.sh`；
7. 不自动创建测试 Family，不绕开正常 `/member/` 产品入口。

若系统服务安装失败，脚本必须清楚报告失败与对应 profile，不得声称已经接通。

## 10. 正常产品验证

完成配置后，验证的是正常产品状态：

```text
Admin Entry Context.agent.displayName == Jarvis
Owner Personal Entry Context.agent.displayName == 于途
Owner Member Web 发送 Chat 消息
→ provider_profile = hermes-zzh
→ Hermes zzh 返回
→ Assistant 消息落库并通过 SSE 显示
```

当前尚无 Family Admin Chat 域，所以本阶段只验证 Admin Entry Context 绑定 Jarvis，不虚构一个管理 Chat。

## 11. 安全边界

- API Key 仅存在于 Hermes Profile `.env` 和 `.runtime/config/providers.json`；
- Key 不进入 Git、SQLite、日志、终端、浏览器或测试 Fixture；
- 脚本日志只输出 Profile 名、端口、状态，不输出 Header 或 JSON；
- 标记文件不包含密钥；
- Preset 不允许指定任意 Person；
- 只迁移 active Owner；
- 其他成员保持不变；
- 重复运行不产生 Assignment 堆积；
- PR #14 文件边界保持零交集。

## 12. 本 PR 范围

允许修改：

```text
apps/gateway/src/agentAssignments.ts
apps/gateway/src/app.ts
apps/gateway/src/config.ts
apps/gateway/src/familyDomain.ts
apps/gateway/src/index.ts
apps/gateway/test/**
scripts/configure-hermes.py
scripts/configure-hermes.sh
scripts/dev-up.sh
docs/superpowers/**
docs/development/**
README.md
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

## 13. 验证标准

1. 既有 Family Manager 原 Assignment 正常结束，Jarvis 成为唯一 active Assignment；
2. 既有 Owner 原 Assistant Assignment 正常结束，于途成为唯一 active Assignment；
3. 其他成员 Assignment 不变；
4. 重复应用 Preset 幂等；
5. 新建家庭直接使用 Jarvis / 于途；
6. 新增非 Owner 成员仍使用 Fake Personal Assistant；
7. 既有 Chat 下一轮切换到 Hermes zzh 并重置旧 Provider Session；
8. Admin Context 显示 Jarvis，Owner Personal Context 显示于途；
9. 配置脚本保留 Profile 现有文件与非目标 `.env` 行；
10. 既有 API Key 保留，缺失 Key 安全生成；
11. Provider JSON 与 `.env` 权限为 `0600`；
12. 输出和日志不包含 Key；
13. 健康检查同时验证 `jarvis` 与 `zzh`；
14. `dev-up.sh` 只在完整配置存在时启用 Preset；
15. CI、Secret Scan、typecheck 与 build 全部通过；
16. 与 PR #14 changed-path 交集为零。
