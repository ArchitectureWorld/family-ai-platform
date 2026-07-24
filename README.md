# Family AI Platform

面向家庭成员、家庭管家、个人助理 Agent 和受控设备的统一 AI 接入平台。

## 产品定位

本仓库只开发一个产品：**Family AI Platform**。平台唯一的服务端业务权威是 **Family AI Gateway**。

```text
Web / iOS / HarmonyOS / DIY / Admin
                    │
                    ▼
            Family AI Gateway
    Family / Person / Entry / Device
    Chat / Work / 消息 / Agent 路由 / 权限
                    │
              gateway.sqlite
                    │
          Provider Adapter SDK
        Hermes / Codex / OpenClaw
```

- `apps/gateway`：唯一业务后端与数据权威；
- `packages/contracts`：版本化公共协议；
- `packages/provider-adapter-sdk`：Hermes、Codex 等 Provider 的受控调用边界；
- 正式 Member Web、Admin Web、iOS、HarmonyOS 和 DIY 入口在后续阶段建设。

Control Center 不再作为独立业务后台演进，而是收敛为 Admin Entry。管理员入口与个人入口共用 Gateway 和 Person，但拥有不同的 Session audience、权限、默认 Agent 和页面体验。

## 权威架构入口

后续开发必须先阅读：

- [`docs/architecture/README.md`](docs/architecture/README.md)
- [`docs/architecture/00-family-ai-platform-stable-architecture.md`](docs/architecture/00-family-ai-platform-stable-architecture.md)
- [`docs/architecture/01-identity-and-binding.md`](docs/architecture/01-identity-and-binding.md)
- [`docs/architecture/02-chat-work-domain.md`](docs/architecture/02-chat-work-domain.md)
- [`docs/architecture/03-single-gateway-concurrency.md`](docs/architecture/03-single-gateway-concurrency.md)
- [`docs/architecture/04-multi-terminal-strategy.md`](docs/architecture/04-multi-terminal-strategy.md)

阶段性深度 Review：

- [`docs/reviews/2026-07-21-family-ai-platform-deep-review.md`](docs/reviews/2026-07-21-family-ai-platform-deep-review.md)

原始架构讨论文档保存在：

- [`docs/archive/architecture-2026-07-21/`](docs/archive/architecture-2026-07-21/)

发生冲突时，以 `docs/architecture/` 为准。

## 稳定部署原则

```text
1 个逻辑 Gateway
1 个物理 Gateway 实例 / 容器
1 个主要数据库
N 个 Person
N 个终端
N 个 Chat / Work
N 个 Provider / Agent
```

单 Gateway 不等于全局串行：

- 不同 Person 并行；
- Chat 与 Work 并行；
- 不同 Work Conversation 并行；
- Work 内独立 Execution 并行；
- 文件处理、Provider 调用和终端输出并行；
- 仅同一个连续上下文 Lane 内有序。

第一版继续采用单 Gateway、单 SQLite、模块化单体，不引入微服务、集群和分布式锁。

## 旧平台处理原则

新平台数据库从空库开始，不迁移旧平台的用户、角色、Agent 配置、会话、消息、附件、设备、Session、Token 或运行配置。

Foundation 从 0 开发，不复制旧 Gateway 业务实现、不整体合并旧分支、不复制旧数据库 Schema，也不建立旧平台兼容层。旧仓库只作为只读设计和测试参考：

```text
ArchitectureWorld/family-ai-platform-legacy
```

## 当前开发阶段

Family / Person、双入口和正式 Chat / Work 实时后端已经进入 `main`。当前完整链路为：

```text
Personal Entry Session
→ HomeChatStream / WorkConversation
→ Person ThreadMessage
→ 同 Thread Provider Lane
→ Assistant ThreadMessage
→ domain_events + outbox_events
→ SSE 实时通知与 Last-Event-ID 恢复
```

已经完成：

- Family、Person、Device、EntryBinding 和双 Entry Session；
- Chat / Work Contracts v1；
- Home Chat、DailyEpisode、WorkConversation 和 ThreadMessage 持久化；
- Personal Entry Session 认证的 Chat / Work HTTP API；
- Provider Context Session、Assistant 回复、失败重试和重启恢复；
- Person 级领域事件与 Transactional Outbox；
- `GET /api/v1/events/stream` SSE 实时推送；
- `afterSequence` 与 `Last-Event-ID` 断线补发；
- 心跳授权复核、慢连接背压、Person 隔离和 Gateway 关闭清理。

当前开发顺序：

```text
Device Sync Cursor
→ 显式缺失事件补拉 API
→ 正式 Member Web Chat / Work
→ Push 唤醒
→ iOS 接入统一 Chat / Work 与同步协议
```

iOS Mobile Entry Foundation 仍在 PR #14 中保持 Draft，等待真实 Mac、iPhone 与部署 Gateway 的真机验收。浏览器验收台仍只承担初始化、配对和“小白一键验收”，不会作为正式 Member Web 继续堆叠业务功能。

详细阶段记录：

- [`docs/development/2026-07-24-chat-work-realtime-foundation.md`](docs/development/2026-07-24-chat-work-realtime-foundation.md)

## 一条命令完成自动测试与小白验收

### 环境要求

- Linux 或 NAS；
- Docker Engine；
- Docker Compose V2；
- `curl`。

宿主机不需要预装 Node.js 或 npm。仓库必须已经提交自己的 `package-lock.json`，Docker 和 CI 只使用 `npm ci`。

```bash
./scripts/verify-foundation.sh
```

该命令会：

1. 检查已提交的依赖锁；
2. 在固定 Node 22.16.0 Docker 环境运行全部测试、静态检查、类型检查和构建；
3. 验证原有消息、幂等、隔离和重启恢复；
4. 自动验证一次性建家、双入口、Agent 路由、成员管理和权限隔离；
5. 清空自动验收数据；
6. 再启动一套空白 Gateway；
7. 输出浏览器“小白测试”地址和逐步操作说明。

浏览器页面标题：

```text
家庭 AI 初始化与入口验收台
```

详细操作见：

- [`docs/acceptance/2026-07-21-family-onboarding-foundation.md`](docs/acceptance/2026-07-21-family-onboarding-foundation.md)

### 分步骤运行

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
bash ./scripts/acceptance-onboarding.sh
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

运行数据库和本机开发凭证只保存在 Git 忽略的 `.runtime/`。自动验收报告保存在 Git 忽略的 `docs/acceptance/runtime/`。

## 网络和安全边界

- Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库只保存设备凭证和 Entry Session Token 的 Hash；
- 原始 Entry Session Token 只在创建时返回一次；
- 客户端不能声明可被信任的 Person 或 Agent；
- Admin 与 Personal Session 的 audience 强制隔离；
- 新成员不会继承当前管理员设备的私人入口；
- Conversation 同时校验成员和 Agent；
- 授权先于幂等缓存查询；
- Provider Session 不跨 Agent 或 Provider Profile 复用；
- SSE 不发送消息正文、Token、Credential 或 Provider External Session；
- SSE 消费不会把 Transactional Outbox 错误标记为已发布；
- 验收台只在 development 模式提供；
- production 不运行测试 bootstrap，也不默认创建 Fake Provider；
- 自动测试只使用 Fake Provider。

## 开发规则

- `main` 是唯一权威代码基线；
- 每个任务从最新 `main` 建立独立分支；
- 每个 PR 直接指向 `main`；
- 行为变更必须先增加失败测试；
- 不提交数据库、密钥、Token、日志和正式附件；
- 新开发先确认与 `docs/architecture/` 一致；
- 未取得测试、类型检查、构建、Docker 和目标环境证据前，不宣称完成。

## 设计与验收资料

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/specs/2026-07-21-family-onboarding-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-family-onboarding-foundation.md`
- `docs/acceptance/2026-07-21-gateway-foundation.md`
- `docs/acceptance/2026-07-21-family-onboarding-foundation.md`
- `docs/development/2026-07-21-gateway-foundation-verification.md`
- `docs/development/2026-07-21-gateway-foundation-target-host-acceptance.md`
- `docs/development/2026-07-24-chat-work-realtime-foundation.md`
- `docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md`
- `docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md`
