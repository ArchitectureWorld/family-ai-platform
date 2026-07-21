# Family AI Platform

面向家庭成员、个人助理 Agent 和受控设备的统一 AI 接入平台。

## 产品定位

本仓库只开发一个产品：**Family AI Platform**。平台唯一的服务端业务权威是 **Family AI Gateway**。

```text
Member Web / iOS / HarmonyOS / 受控终端
                         │
Admin Web                │
        └────────────────┼──────────────┐
                         ▼              │
                 Family AI Gateway      │
          身份 / RBAC / 设备 / 会话 / 消息
          Agent 绑定 / Provider / 审计
                         │              │
                   gateway.sqlite       │
                         │              │
              Provider Adapter SDK ◄────┘
                    Hermes / Codex
```

- `apps/gateway`：唯一业务后端与数据权威；
- `apps/member-web`：后续正式普通成员入口；
- `apps/admin-web`：后续最高权限管理入口；
- `packages/contracts`：版本化公共协议；
- `packages/provider-adapter-sdk`：Hermes、Codex 等 Provider 的受控调用边界。

Control Center 不再作为独立业务后台演进，而是收敛为 Admin Entry。管理员入口与普通入口共用 Gateway 核心，但具有不同的 session audience、API 权限和前端体验。

## 旧平台处理原则

新平台数据库从空库开始，不迁移旧平台的用户、角色、Agent 配置、会话、消息、附件、设备、Session、Token 或运行配置。

Foundation 从 0 开发，不复制旧 Gateway 业务实现、不整体合并旧分支、不复制旧数据库 Schema，也不建立旧平台兼容层。旧仓库仅保留为只读设计和测试参考。

## 当前 Foundation 闭环

```text
测试成员/设备
→ Gateway 身份认证
→ 固定成员—Agent 绑定
→ 独立会话
→ Fake Provider 连续两轮响应
→ 安全幂等重放与冲突
→ SQLite 历史持久化
→ 服务重启后恢复历史
```

暂不包含真实 Hermes/Codex、正式 Member/Admin Web、浏览器正式 Session、设备配对、附件、局域网、公网、TLS、移动端和公共语音终端。

## 一键部署与体验

### 环境要求

- Linux 或 NAS；
- Docker Engine；
- Docker Compose V2，即支持 `docker compose`；
- `curl`。

### 1. 启动

在仓库根目录执行：

```bash
./scripts/dev-up.sh
```

脚本会自动：

1. 检查 Docker 与 Compose；
2. 创建 Git 忽略的 `.runtime/`；
3. 生成随机开发设备 Token；
4. 构建并启动 Gateway；
5. 等待健康检查；
6. 输出并尽量自动打开验收页面。

端口只发布在：

```text
http://127.0.0.1:8790
```

### 2. 浏览器体验验收

打开 `dev-up.sh` 输出的 URL，依次完成：

1. 点击“读取当前身份”，确认显示测试成员、测试设备和固定个人助理；
2. 点击“创建体验会话”；
3. 发送第一轮消息，应显示 `Fake Provider 第 1 轮回复`；
4. 点击“填入第二轮示例”并发送，应显示 `Fake Provider 第 2 轮回复`；
5. 刷新页面，历史仍应显示四条消息；
6. 执行 `docker compose --env-file .runtime/config/compose.env restart gateway`；
7. 等待数秒后点击“刷新当前历史”，历史仍应恢复；
8. 日志中不应出现 SQL、堆栈、Token、本机路径或 Provider 内部错误。

该页面只是 development 模式验收台，不是正式 Member Web，也不包含管理员功能。

### 3. 自动体验验收

```bash
./scripts/acceptance.sh
```

脚本覆盖：

- 健康检查；
- 设备认证；
- 会话创建；
- 两轮 Provider Session 连续性；
- 四条消息历史；
- 相同请求幂等重放；
- 相同 Key 不同请求冲突；
- 错误 Agent 目标拒绝；
- 容器重启；
- 重启后历史恢复。

成功后会在以下目录生成脱敏 Markdown 报告：

```text
docs/acceptance/runtime/
```

该目录不会进入 Git。

### 4. 停止与重置

停止服务但保留会话数据：

```bash
./scripts/dev-down.sh
```

删除一次性开发数据库和 Token，重新开始：

```bash
./scripts/dev-reset.sh
```

非交互环境必须显式执行：

```bash
./scripts/dev-reset.sh --yes
```

## 网络和安全边界

- Compose 只发布 `127.0.0.1:8790:8790`；
- Token、环境文件和 SQLite 只存在于 `.runtime/`；
- 数据库只保存 Token 的 SHA-256 Hash；
- conversation 同时绑定 member 和 Agent；
- 会话访问、历史、发送和幂等重放全部校验 member 与 Agent；
- 授权先于幂等缓存查询；
- 相同幂等 Key 的不同请求返回 `409 IDEMPOTENCY_CONFLICT`；
- Provider Session 不跨 Agent 或 Provider Profile 复用；
- 自动测试只使用 Fake Provider。

## 本地开发质量门禁

首次安装会生成全新的 `package-lock.json`，不得复制旧仓库锁文件：

```bash
npm install
npm run check
```

锁文件生成后，正式验证使用：

```bash
npm ci
npm run check
docker compose build
./scripts/dev-up.sh
./scripts/acceptance.sh
```

未取得上述命令和浏览器体验的真实证据前，Foundation PR 必须保持 Draft。

## 开发规则

- `main` 是唯一权威基线；
- 每个任务从最新 `main` 创建一个独立分支；
- 每个 PR 直接指向 `main`，禁止堆叠 PR；
- 行为变更必须先增加失败测试；
- 不提交数据库、密钥、令牌、日志和正式附件；
- 未获得测试、类型检查、构建、部署和体验证据前，不得宣称完成。

详细设计与计划：

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-family-ai-platform-foundation.md`
- `docs/superpowers/plans/2026-07-21-gateway-one-click-acceptance.md`
- `docs/development/roadmap.md`

## 旧仓库

历史实现、旧 Control Center 和 Gateway Stage 4–6 原型保存在：

```text
ArchitectureWorld/family-ai-platform-legacy
```

旧仓库只作为只读代码与测试参考，不再接受新功能开发，也不作为新平台的数据来源。
