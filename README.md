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
- `apps/gateway/member-public`：同源正式 Member Web 产品工作台；
- `packages/contracts`：版本化公共协议；
- `packages/provider-adapter-sdk`：Hermes、Codex 等 Provider 的受控调用边界；
- iOS、HarmonyOS 和 DIY 入口使用同一 Person、Chat、Work 和同步协议。

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

Family / Person、双入口、正式 Chat / Work 实时后端和 Member Web 产品工作台已经形成完整闭环：

```text
Web Device + HttpOnly Personal Entry
→ HomeChatStream / WorkConversation
→ Person ThreadMessage
→ 同 Thread Provider Lane
→ Assistant ThreadMessage
→ domain_events + outbox_events
→ IndexedDB 设备投影
→ 显式缺失事件补拉
→ 本地事务成功后累计 ACK
→ SSE 实时通知与断线恢复
```

已经完成：

- Family、Person、Device、EntryBinding 和双 Entry Session；
- Chat / Work Contracts v1；
- Home Chat、DailyEpisode、WorkConversation 和 ThreadMessage 持久化；
- Personal Entry Session 认证的 Chat / Work HTTP API；
- Provider Context Session、Assistant 回复、失败重试和重启恢复；
- Person 级领域事件与 Transactional Outbox；
- `GET /api/v1/events/stream` SSE 实时推送；
- Device Sync Cursor、显式缺失事件补拉和累计 ACK；
- 公共 Event / Sync Contracts v1；
- 真实 Web Device、HttpOnly Cookie Personal Entry 和远程撤销；
- Member Web Chat 消息时间线、分页、发送、失败重试和 Assistant 回复；
- Work 列表、创建、详情、独立对话和进度展示；
- ChatGPT 风格输入框、提交即清空、失败原消息重试和附件下载卡片；
- 单文件 200 MB、每条消息最多 10 个文件的 8 MiB 分块断点上传；
- 图片、PDF、Office、UTF-8 文本、Markdown 和常见源码附件；
- 每个 Agent 独立的 Chat、Work、草稿、附件托盘和发送队列；
- Chat 消息选择并转成 Work；
- IndexedDB 本地投影、离线草稿、SSE 重连和 BroadcastChannel 多标签页通知；
- 页面刷新与 Gateway 重启后的产品状态恢复。
- 仅 development 模式开放的 Admin Web 家庭、成员与配对管理预览；
- 同一局域网可访问的独立 HTTPS 体验入口（不改变 8790 正式服务）。

当前开发顺序：

```text
A2 Compose 附件持久化
→ A3 生产依赖安全升级
→ A4 CI 发布阻断门禁
→ A5 整体备份与恢复基础
→ A6 文档事实校正
```

A5 已提供 retained runtime 的 sealed snapshot、无网络 migration-only candidate staging、原子目录交换与 previous restore 原语；它们不会自行发布或重启正式 `8790`。正式升级仍需后续 F1 的逐 Gate 审批编排，操作边界见 [`docs/operations/release-and-rollback.md`](docs/operations/release-and-rollback.md)。

在上述发布基线整改完成前，不继续 Push Notification、iOS/HarmonyOS、语音或正式 Admin Web 等产品扩展。

iOS Mobile Entry Foundation 仍在 PR #14 中保持 Draft，等待真实 Mac、iPhone 与部署 Gateway 的真机验收。Member Web 和 iOS 共享服务端对象与协议，但保持独立交互实现。

详细阶段记录：

- [`docs/development/2026-07-24-chat-work-realtime-foundation.md`](docs/development/2026-07-24-chat-work-realtime-foundation.md)
- [`docs/development/2026-07-25-member-web-product-workbench.md`](docs/development/2026-07-25-member-web-product-workbench.md)

## 一条命令进入真实产品状态

### 环境要求

- Linux 或 NAS；
- Docker Engine；
- Docker Compose V2；
- `curl`。

宿主机不需要预装 Node.js 或 npm。仓库必须已经提交自己的 `package-lock.json`，Docker 和 CI 只使用 `npm ci`。

```bash
./scripts/verify-foundation.sh
```

该命令只适用于 disposable 开发 runtime，会调用 reset；不得指向需要保留的正式或副本数据。retained runtime 必须使用 `docs/operations/release-and-rollback.md` 中的 preflight、stop evidence、snapshot/candidate/restore 链路。

该命令会：

1. 检查已提交的依赖锁；
2. 在固定 Node 22.16.0 Docker 环境运行全部测试、静态检查、类型检查和构建；
3. 验证消息、幂等、权限、同步和重启恢复；
4. 建立并验证真实 Family、Person、Admin / Personal Entry 和浏览器配对材料；
5. 保留已经通过验证的真实 Family 状态并继续运行 Gateway；
6. 输出正常 `/member/` 产品工作台的一次性配对链接。

打开脚本输出的链接后，直接在正式产品工作台中体验：

```text
发送一条 Chat 消息并看到个人助理回复
→ 创建一个 Work
→ 在 Work 中继续对话
→ 从 Chat 选择消息转成 Work
→ 刷新页面确认本地投影恢复
→ 重启 Gateway 后确认补拉与 SSE 恢复
```

产品页面不提供专门的验证按钮、调试面板或测试业务状态。自动验证日志只保存在 Git 忽略的本机 runtime 目录。

### 局域网直接体验 Admin Web 与 Member Web

目标 Linux 上已安装 Node.js、OpenSSL 与 Nginx 时，可在受保护的开发工作树运行：

```bash
./scripts/member-preview-lan-up.sh
```

该命令只启动仓库自管的 Preview Gateway（`127.0.0.1:8791`）和隔离 Nginx
（`0.0.0.0:9080/9443`），不会改写 `/etc/nginx`、系统服务、Docker Compose 或
现有 `127.0.0.1:8790`。命令会输出不含凭据的 CA 下载地址、产品入口和证书指纹。

首次使用的设备需要：

1. 从输出的 `http://<LAN-IP>:9080/family-ai-preview-ca.crt` 下载本地 CA；
2. 核对命令输出的 SHA-256 指纹后，将 CA 设为该设备上的受信任根证书；
3. 管理员直接打开 `https://<LAN-IP>:9443/admin/` 进入家庭管理；仅当 Preview
   尚未创建家庭时，授权操作员才使用受保护的首次建家交接文件完成一次初始化；
4. 管理员添加真实家庭成员并生成五分钟有效的成员配对码或二维码；
5. 成员设备打开独立的 `https://<LAN-IP>:9443/member/`，扫码或输入配对码进入。

管理员入口凭据只保存在权限 0600 的 runtime 文件与当前浏览器 `sessionStorage`；
首次网页建家后会通过 development-only、管理员认证的端点原子保存恢复入口。
已初始化的 development Preview 会从该受保护入口直接恢复管理员会话。任何能访问
该局域网 Preview Admin URL 的设备都获得管理员权限；production 不注册此入口。
关闭成员配对弹窗会撤销仍有效且未使用的配对码。

Preview 附件保存在 Git 忽略的 `.runtime-preview/attachments`，目录权限为 `0700`、
文件权限为 `0600`，不会进入数据库 BLOB 或 Git。上传使用 8 MiB 分块，浏览器会
持久化附件草稿和已成功分块索引以便续传；未完成上传 24 小时后过期。限制为
单文件 200 MB、每条消息最多 10 个文件和 2 GiB、每个家庭 20 GiB。允许图片、
PDF、Office、UTF-8 文本、
Markdown 与常见源码；归档包、可执行文件及类型不一致的文件会被拒绝，服务端只把
验证后的只读附件交给所选 Agent，绝不执行附件。每个 Agent 的 Chat、Work、草稿、
附件托盘和发送队列互相隔离。

管理员与成员的直接 Preview 入口保持不变。这一版仍使用 development 直接管理员
入口和成员配对；正式邮箱/密码登录记录为后续迭代，不在本次变更中实现。

只停止局域网代理、保留 Gateway 数据与证书：

```bash
./scripts/member-preview-lan-down.sh
```

详细边界和验收步骤见
[`docs/development/2026-07-28-lan-admin-member-experience.md`](docs/development/2026-07-28-lan-admin-member-experience.md)。

### 分步骤运行

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
bash ./scripts/acceptance-onboarding.sh
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

SQLite 数据库位于 Git 忽略的 `.runtime/data/gateway.sqlite`，附件位于
`.runtime/data/attachments`；二者共享 Compose 的持久化 `data` 挂载。
`dev-down.sh` 只停止容器并保留数据，`dev-reset.sh` 会删除整个 `.runtime`，因此也会删除数据库、附件和本机开发凭证。
自动验证日志和报告保存在 Git 忽略的 `docs/acceptance/runtime/`。

需要避开正式 `127.0.0.1:8790` 时，必须先从精确提交生成三文件镜像产物。裸 `docker compose build` 只生成 `local-unverified` 开发镜像，不能作为验收或发布证据：

```bash
bash scripts/build-gateway-image.sh \
  --source-commit "$(git rev-parse HEAD)" \
  --expected-source-commit "$(git rev-parse HEAD)" \
  --output-dir <absolute-new-artifact-dir>

FAMILY_AI_RUNTIME_ROOT=<absolute-empty-dir> \
COMPOSE_PROJECT_NAME=<safe-unique> \
FAMILY_AI_HOST_PORT=0 \
FAMILY_AI_IMAGE_REF=<sha256:image-id> \
FAMILY_AI_IMAGE_MANIFEST=<absolute-new-artifact-dir>/gateway-image-manifest.json \
./scripts/dev-up.sh

FAMILY_AI_RUNTIME_ROOT=<same-dir> \
COMPOSE_PROJECT_NAME=<same> \
./scripts/acceptance.sh

FAMILY_AI_RUNTIME_ROOT=<same-dir> \
COMPOSE_PROJECT_NAME=<same> \
./scripts/acceptance-container-attachments.sh
```

隔离启动会写入权限为 `0600` 的 runtime manifest，后续验收只接受与其完全匹配的 source commit、Gateway image manifest hash、runtime、project、容器、网络、image ID 和随机端口，并在前后确认正式 `8790` identity 未改变。可交付构建、CI artifact 和回滚边界见 `docs/operations/release-and-rollback.md`。

## 网络和安全边界

- Compose 只发布 `127.0.0.1:8790:8790`；
- 数据库只保存设备凭证和 Entry Session Token 的 Hash；
- 浏览器 Device Credential 与 Entry Session Token 只存在于 `HttpOnly` Cookie；
- production Cookie 使用 `Secure`、`SameSite=Strict` 和 `Path=/`；
- Cookie 写请求要求同源元数据和 `X-Family-AI-Web-Request: 1`；
- 显式 Authorization Header 始终优先于 Cookie Bridge；
- IndexedDB 不保存 Credential、Token、Authorization 或 Provider External Session；
- IndexedDB 事件事务成功后才允许推进 Device Sync ACK；
- 原始 Entry Session Token 只在创建时返回一次；
- 客户端不能声明可被信任的 Person 或 Agent；
- Admin 与 Personal Session 的 audience 强制隔离；
- 新成员不会继承当前管理员设备的私人入口；
- Provider Session 不跨 Agent 或 Provider Profile 复用；
- SSE 不发送消息正文、Token、Credential 或 Provider External Session；
- SSE 消费不会把 Transactional Outbox 错误标记为已发布；
- Member Web 使用 `textContent` 渲染用户内容，不拼接用户输入 HTML；
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

## 设计与验证资料

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/specs/2026-07-21-family-onboarding-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-family-onboarding-foundation.md`
- `docs/development/2026-07-21-gateway-foundation-verification.md`
- `docs/development/2026-07-21-gateway-foundation-target-host-acceptance.md`
- `docs/development/2026-07-24-chat-work-realtime-foundation.md`
- `docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md`
- `docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md`
- `docs/superpowers/specs/2026-07-25-member-web-product-workbench-design.md`
- `docs/superpowers/plans/2026-07-25-member-web-product-workbench.md`
- `docs/superpowers/evidence/2026-07-25-member-web-product-workbench.md`
