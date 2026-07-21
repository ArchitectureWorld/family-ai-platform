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
→ 重启后继续第三轮
```

暂不包含真实 Hermes/Codex、正式 Member/Admin Web、浏览器正式 Session、设备配对、附件、局域网、公网、TLS、移动端和公共语音终端。

## 一条命令完成自动部署与验收

### 环境要求

- Linux 或 NAS；
- Docker Engine；
- Docker Compose V2，即支持 `docker compose`；
- `curl`。

宿主机**不需要预装 Node.js 或 npm**。依赖锁、测试、类型检查和构建都在固定版本的 Node 22.16.0 Docker 环境中完成。

在仓库根目录执行：

```bash
./scripts/verify-foundation.sh
```

该命令会依次完成：

1. 首次使用 `node:22.16.0-bookworm-slim` 生成新仓库自己的 `package-lock.json`；
2. 在 Docker 构建阶段执行 `npm ci`、全部测试、静态安全检查、TypeScript 检查和构建；
3. 构建最小非 root Gateway 运行镜像；
4. 生成 Git 忽略的随机开发 Token 和空数据库；
5. 仅在 `127.0.0.1:8790` 启动 Gateway；
6. 自动完成健康、认证、两轮消息、幂等、跨 Agent 拒绝和重启恢复；
7. 验证重启后继续收到 `Fake Provider 第 3 轮回复。`；
8. 生成脱敏 Markdown 验收报告；
9. 保持 Gateway 运行，并输出浏览器体验地址。

自动流程成功后只需打开脚本输出的本机 URL，完成页面体验验收。

## 分步骤运行

### 1. 只启动 Gateway

```bash
./scripts/dev-up.sh
```

脚本会自动：

1. 检查 Docker 与 Compose；
2. 创建权限为 `700` 的 `.runtime/`；
3. 生成权限为 `600` 的随机开发设备 Token；
4. 构建并启动 Gateway；
5. 等待健康检查；
6. 输出并尽量自动打开验收页面。

端口只发布在：

```text
http://127.0.0.1:8790
```

### 2. 浏览器体验验收

打开启动脚本输出的 URL，依次完成：

1. 点击“读取当前身份”，确认显示测试成员、测试设备和固定个人助理；
2. 点击“创建体验会话”；
3. 发送第一轮消息，应显示 `Fake Provider 第 1 轮回复。`；
4. 点击“填入第二轮示例”并发送，应显示 `Fake Provider 第 2 轮回复。`；
5. 刷新页面，历史仍应显示四条消息；
6. 执行 `docker compose --env-file .runtime/config/compose.env restart gateway`；
7. 等待数秒后点击“刷新当前历史”，历史仍应恢复；
8. 再发送一条消息，应显示 `Fake Provider 第 3 轮回复。`；
9. 日志中不应出现 SQL、堆栈、Token、本机路径或 Provider 内部错误。

该页面只是 development 模式验收台，不是正式 Member Web，也不包含管理员功能。

### 3. 只运行自动体验验收

Gateway 已启动时执行：

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
- 重启后历史恢复；
- 重启后继续第三轮；
- 六条消息最终历史。

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
- Token、环境文件、日志和 SQLite 只存在于 `.runtime/`；
- 数据库只保存 Token 的 SHA-256 Hash；
- conversation 同时绑定 member 和 Agent；
- 会话访问、历史、发送和幂等重放全部校验 member 与 Agent；
- 授权先于幂等缓存查询；
- 相同幂等 Key 的不同请求返回 `409 IDEMPOTENCY_CONFLICT`；
- Provider Session 不跨 Agent 或 Provider Profile 复用；
- 开发验收页面使用 CSP、`no-store`、`no-referrer` 和防嵌入响应头；
- 自动测试只使用 Fake Provider。

## 开发者本机质量门禁

一键验收不要求宿主机 Node.js。专业开发人员在本机已有 Node.js 22 时，也可以直接执行：

```bash
npm ci
npm run check
```

首次还没有锁文件时，不得复制旧仓库锁文件；应执行 `./scripts/verify-foundation.sh`，由固定 Node 22.16.0 容器生成新锁文件。

未取得 Docker 构建、自动验收和浏览器体验的真实证据前，Foundation PR 必须保持 Draft。

## 设计、实施与验收文档

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-family-ai-platform-foundation.md`
- `docs/superpowers/plans/2026-07-21-gateway-one-click-acceptance.md`
- `docs/acceptance/2026-07-21-gateway-foundation.md`
- `docs/development/2026-07-21-gateway-foundation-verification.md`
- `docs/development/roadmap.md`

## 旧仓库

历史实现、旧 Control Center 和 Gateway Stage 4–6 原型保存在：

```text
ArchitectureWorld/family-ai-platform-legacy
```

旧仓库只作为只读代码与测试参考，不再接受新功能开发，也不作为新平台的数据来源。
