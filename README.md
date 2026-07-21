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
          Agent 绑定 / Provider / 审计 / 迁移
                         │              │
                   gateway.sqlite       │
                         │              │
              Provider Adapter SDK ◄────┘
                    Hermes / Codex
```

- `apps/gateway`：唯一业务后端与数据权威；
- `apps/member-web`：普通成员入口；
- `apps/admin-web`：最高权限管理入口；
- `packages/contracts`：版本化公共协议；
- `packages/provider-adapter-sdk`：Hermes、Codex 等 Provider 的受控调用边界；
- `tools/legacy-migration`：从 `family-ai-platform-legacy` 选择性迁移有效数据。

Control Center 不再作为独立业务后台演进，而是收敛为 Admin Entry。管理员入口与普通入口共用 Gateway 核心，但具有不同的 session audience、API 权限和前端体验。

## 当前阶段

当前只建立干净的工程基线和最小安全闭环：

```text
测试成员/设备
→ Gateway 身份认证
→ 固定成员—Agent 绑定
→ 独立会话
→ Provider Adapter
→ 假 Provider 连续两轮响应
→ 结构化历史恢复
```

暂不处理公网、TLS、OAuth/SSO、异地远程管理、完整移动端、公共语音终端和旧数据正式迁移。

## 网络边界

第一阶段默认只监听 `127.0.0.1`。局域网开放必须通过显式配置和独立验收；不得直接暴露公网。

## 开发规则

- `main` 是唯一权威基线；
- 每个任务从最新 `main` 创建一个独立分支；
- 每个 PR 直接指向 `main`，禁止堆叠 PR；
- 行为变更必须先增加失败测试；
- 不从旧仓库整体复制代码，只迁移经过审查的基础原语；
- 不提交数据库、密钥、令牌、日志和正式附件；
- 未获得测试、类型检查和构建证据前，不得宣称完成。

详细设计与计划：

- `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`
- `docs/superpowers/plans/2026-07-21-family-ai-platform-foundation.md`
- `docs/development/roadmap.md`

## 旧仓库

历史实现、旧 Control Center、Gateway Stage 4–6 原型和迁移来源保存在：

```text
ArchitectureWorld/family-ai-platform-legacy
```

旧仓库只作为只读参考，不再接受新功能开发。
