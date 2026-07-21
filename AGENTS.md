# AGENTS.md

本文件适用于 `ArchitectureWorld/family-ai-platform` 的全部开发工作。

## 开发前必须读取

1. 本文件；
2. `README.md`；
3. `docs/superpowers/specs/2026-07-21-family-ai-platform-foundation-design.md`；
4. 当前任务对应的实施计划；
5. 与目标应用或 package 直接相关的 README。

## 产品边界

本仓库只有一个产品：Family AI Platform。

- `apps/gateway` 是唯一业务后端和数据权威；
- `apps/member-web` 是普通成员入口；
- `apps/admin-web` 是管理员入口；
- Admin Entry 不得建立第二套用户、Agent、会话或配置数据库；
- Gateway 负责确定性身份、权限、设备、路由、会话、消息、Provider 调用和审计；
- 个人助理 Agent 负责自然语言理解、任务判断和多 Agent 协作；
- ME-Who、ME-Brain、长期记忆和项目知识不由本仓库权威持有。

## 旧平台边界

- 新平台数据库从空库开始；
- 不迁移旧平台的用户、角色、Agent 配置、会话、消息、附件、设备、Session、Token 或运行配置；
- `family-ai-platform-legacy` 只作为只读代码、测试场景和交互参考；
- 旧代码只能经过独立 Review 后选择性复用；
- 禁止整体合并旧 Gateway 分支；
- 禁止建立旧数据库兼容层或历史 Schema 兼容约束。

## Git 规则

- `main` 是唯一权威开发基线；
- 一个任务对应一个独立分支和一个直接指向 `main` 的 PR；
- 禁止堆叠 PR；
- 禁止创建 `sync/*`、`backup/*`、`temp/*`、`copy/*`；
- 禁止 force push、改写 `main` 历史或在未批准时删除远程分支；
- 合并后删除任务分支。

## 安全不变量

以下规则不得被实现细节绕过：

1. conversation 必须同时绑定 member 和 agent；
2. 任何会话读取、消息发送、历史读取和幂等重放都必须校验当前 member 与 agent；
3. Provider external session 不得跨 Agent/Profile 复用；
4. 幂等授权先于缓存命中，幂等键必须包含会话和请求内容约束；
5. pairing claim token 只能完成一次，不得用于 Session 轮换；
6. 服务启动和 seed 不得恢复已撤销设备、覆盖正式路由或重置令牌；
7. Provider 子进程只能获得显式 allowlist 环境变量；
8. 普通成员无法调用 `/api/admin/*`；
9. 管理员身份不自动获得其他成员私人消息正文读取权；
10. 数据库 Schema 变化必须版本化、可验证、可回滚；
11. 附件文件与数据库状态必须具有补偿或可恢复机制；
12. 密钥、Token、Cookie、Provider stderr 和本机私有路径不得进入公共 API、审计或 Git。

## 工程边界

目标结构：

```text
apps/
  gateway/
  member-web/
  admin-web/
packages/
  contracts/
  provider-adapter-sdk/
docs/
```

- 当前任务只创建实际需要的目录，不建立空壳应用；
- 每个文件只承担一个清晰职责；
- Route 只做协议解析和响应映射；
- Service 承担业务规则；
- Repository 只负责持久化；
- 公共 contracts 不得包含数据库表结构、秘密或绝对路径；
- 不为目录美观进行无验收价值的大规模重构。

## 质量门禁

所有行为修改遵循：

```text
失败测试 → 最小实现 → 测试通过 → 重构 → 完整验证 → 提交
```

每个 PR 至少执行：

```bash
npm ci
npm test
npm run typecheck
npm run build
```

最终报告必须给出测试数量、通过/失败/跳过数量、类型检查结果、构建结果和未覆盖项。

## 当前阶段限制

第一阶段仅实现本机最小安全闭环，默认绑定 `127.0.0.1`。

暂不开发：

- 公网入口；
- 公网 TLS 和反向代理；
- OAuth/SSO；
- 异地远程管理；
- 旧平台业务数据迁移；
- iOS/HarmonyOS 正式客户端；
- 公共语音终端；
- 多 Agent 语义编排；
- 真实 Provider 计费调用作为自动测试。
