# Family AI Platform

面向家庭成员、个人助理 Agent 和受控设备的统一 AI 接入平台。

## 产品定位

本仓库只开发一个产品：**Family AI Platform**。平台唯一的服务端业务权威是 **Family AI Gateway**。

```text
Web / iOS / HarmonyOS / DIY / Admin
                    │
                    ▼
            Family AI Gateway
    身份 / 设备 / Chat / Work / 消息
    Agent 路由 / Provider / 同步 / 权限
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

Control Center 不再作为独立业务后台演进，而是收敛为 Admin Entry。管理员入口与普通入口共用 Gateway 核心，但具有不同权限和前端体验。

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

## 当前 Gateway Foundation 闭环

```text
测试成员 / 设备
→ Gateway 身份认证
→ 固定成员—Agent 绑定
→ 独立 Conversation
→ Fake Provider 多轮响应
→ 幂等重放与冲突
→ SQLite 历史持久化
→ 容器重启恢复
```

Foundation 已提供可靠的消息、认证、Provider、事务和部署技术内核，但其 `member / device / conversation` 仍是第一阶段验证模型。

正式 Web、iOS、HarmonyOS 或 DIY 开发前，必须先建立：

```text
Family / Person
→ Identity / EntryBinding
→ Device / DeviceBinding
→ AssistantAssignment
→ HomeChatStream / DailyEpisode
→ WorkConversation
→ Event / Sync / Lane
```

## 一条命令完成 Foundation 自动部署与验收

### 环境要求

- Linux 或 NAS；
- Docker Engine；
- Docker Compose V2；
- `curl`。

宿主机不需要预装 Node.js 或 npm。

```bash
./scripts/verify-foundation.sh
```

该命令会：

1. 准备新仓库自己的依赖锁；
2. 在固定 Node 22 Docker 环境中运行测试、静态检查、类型检查和构建；
3. 构建非 root Gateway 镜像；
4. 生成 Git 忽略的开发 Token 和空数据库；
5. 仅在 `127.0.0.1:8790` 启动 Gateway；
6. 验证认证、消息、幂等、隔离和重启恢复；
7. 输出浏览器验收台地址。

### 分步骤运行

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

运行数据、Token、日志和 SQLite 只保存在 Git 忽略的 `.runtime/`。

## 网络和安全边界

- Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库只保存 Token Hash；
- Conversation 同时校验成员和 Agent；
- 授权先于幂等缓存查询；
- 同一幂等 Key 的不同请求返回冲突；
- Provider Session 不跨 Agent 或 Provider Profile 复用；
- 验收台只在 development 模式提供；
- 自动测试只使用 Fake Provider。

## 开发规则

- `main` 是唯一权威代码基线；
- 每个任务从最新 `main` 建立独立分支；
- 每个 PR 直接指向 `main`；
- 行为变更必须先增加失败测试；
- 不提交数据库、密钥、Token、日志和正式附件；
- 新开发先确认与 `docs/architecture/` 一致；
- 未取得测试、类型检查、构建和目标环境证据前，不宣称完成。

## Foundation 设计与验收资料

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-gateway-one-click-acceptance.md`
- `docs/acceptance/2026-07-21-gateway-foundation.md`
- `docs/development/2026-07-21-gateway-foundation-verification.md`
- `docs/development/2026-07-21-gateway-foundation-target-host-acceptance.md`
