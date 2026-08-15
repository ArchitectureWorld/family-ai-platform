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
- `apps/member-web` 是后续正式普通成员入口；
- `apps/admin-web` 是后续管理员入口；
- Admin Entry 不得建立第二套用户、Agent、会话或配置数据库；
- Gateway 负责确定性身份、权限、设备、路由、会话、消息、Provider 调用和审计；
- 个人助理 Agent 负责自然语言理解、任务判断和多 Agent 协作；
- ME-Who、ME-Brain、长期记忆和项目知识不由本仓库权威持有。

## 旧平台边界

- 新平台数据库从空库开始；
- 不迁移旧平台的用户、角色、Agent 配置、会话、消息、附件、设备、Session、Token 或运行配置；
- Foundation 的业务实现从 0 开发；
- 禁止复制旧 Gateway 或旧 Control Center 的业务实现；
- `family-ai-platform-legacy` 只允许用于理解历史问题和测试场景；
- 禁止整体合并旧分支；
- 禁止复制旧数据库 Schema、锁文件或建立兼容层。

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
4. 幂等授权先于缓存命中，范围必须包含 device、conversation、agent、key 和规范化请求 Hash；
5. pairing claim token 只能完成一次，不得用于 Session 轮换；
6. 服务启动和 bootstrap 不得恢复已撤销设备、覆盖正式路由或重置令牌；
7. Provider 子进程只能获得显式 allowlist 环境变量；
8. 普通成员无法调用 `/api/admin/*`；
9. 管理员身份不自动获得其他成员私人消息正文读取权；
10. 数据库 Schema 变化必须版本化、可验证、可回滚；
11. 附件文件与数据库状态必须具有补偿或可恢复机制；
12. 密钥、Token、Cookie、Provider stderr 和本机私有路径不得进入公共 API、审计或 Git；
13. 第一阶段端口只能发布到 `127.0.0.1`；
14. 开发验收台不得包含正式管理员能力。

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
scripts/
docs/
```

- 当前任务只创建实际需要的目录，不建立空壳应用；
- Route 只做协议解析和响应映射；
- Service 承担业务规则和事务流程；
- Repository 只负责持久化；
- 公共 contracts 不得包含数据库表结构、秘密或绝对路径；
- 不为目录美观进行无验收价值的大规模重构。

## 质量门禁

所有行为修改遵循：

```text
失败测试 → 最小实现 → 测试通过 → 重构 → 完整验证 → 提交
```

Foundation PR 转为 Ready 前必须取得以下最新证据：

```bash
npm ci
npm run check
docker compose build
./scripts/dev-up.sh
./scripts/acceptance.sh
```

并人工完成浏览器两轮消息、刷新恢复、容器重启恢复和重启后继续第三轮。

最终报告必须给出：

- 测试数量和通过/失败/跳过数量；
- 类型检查和构建结果；
- Docker 构建结果；
- 一键启动结果；
- 自动验收报告位置；
- 浏览器体验结果；
- 未覆盖项。

## 当前整改阶段授权

第一阶段仍是本机最小安全闭环，正式默认发布地址仍为 `127.0.0.1:8790`。当前整改的权威实施计划是
`docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md`；这份授权只解除旧阶段清单与仓库现状之间的矛盾，不放宽产品边界、安全不变量或正式发布审批。

### 允许加固的既有能力

- 本整改计划只允许加固仓库已经存在的 Session、设备配对、附件、Provider Adapter、浏览器客户端和发布工具，不授权建立新的产品线或业务权威；
- A2–A6 只修复发布基线，B/C/D 只加固已经存在的身份、Provider、持久恢复和客户端续作能力，E0–E4 只定义运行门禁、候选证据或进行无行为拆分；
- 每个 Task 仍必须逐项满足计划依赖、单独设计批准、测试门禁和用户审批；总计划存在不等于下游 Task 已获执行或发布授权；
- A2 可为 `dev-up.sh` 和 `acceptance.sh` 实现隔离门禁所需的 `FAMILY_AI_RUNTIME_ROOT=<absolute-dir>`、`COMPOSE_PROJECT_NAME=<safe-unique>`、`FAMILY_AI_HOST_PORT=0`、`FAMILY_AI_IMAGE_REF=<immutable-id>`；A4 起还必须提供 `FAMILY_AI_IMAGE_MANIFEST=<gateway-image-manifest.json>`。运行级门禁必须使用同一份隔离 manifest，并证明正式 8790 的 runtime 和监听身份未变化。

### 仍然禁止的新增范围

不得借整改任务新增产品能力，包括：

- 公网入口、公网 TLS/反向代理、OAuth/SSO 或异地远程管理；
- 第二套业务后端或数据权威，以及旧平台业务数据迁移或兼容层；
- 新建独立的正式 Member/Admin Web 应用或第二套入口体系；
- 新增 iOS/HarmonyOS 正式客户端能力、公共语音终端或多 Agent 语义编排；
- 新增未经独立设计批准的真实 Provider 产品能力，或把真实 Provider 计费调用放进自动测试；
- 任何绕过单 Gateway、单主要数据库、现有授权校验或数据恢复边界的实现。

### 正式运行与发布 Gate

- 任何正式 runtime、正式端口或 Provider 架构变化只能由 F1 按 R1（短停、备份与副本演练）、R2（maintenance 与 worker-disabled 可逆切换）、R3（限定 subject/budget 的真实 Provider 验收与开放写入）逐段取得用户批准后执行；此前不得部署、重启或改写正式 `127.0.0.1:8790`；
- B4 固定为 disabled-verified；第一阶段不得开放 LAN Preview，未来若要开放必须另立治理任务，并明确审查因此需要变化的安全不变量；
- A4 合入前，Ready 前五项门禁保持为 `npm ci`、`npm run check`、`docker compose build`、隔离 `dev-up.sh`、隔离 `acceptance.sh`；其中隔离运行能力由 A2 实现，A2 合入前不得用尚不存在的参数冒充门禁通过；
- A4 合入后，`bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-dir>` 是唯一可交付构建入口；隔离 `dev-up.sh` 必须同时消费产物的 image ID 与 `gateway-image-manifest.json`。裸 `docker compose build` 只允许生成标记为 `local-unverified`、且不得被隔离验收、E1、E2 或 F1 消费的 Dockerfile smoke；
- 文档/静态门禁任务必须明确报告 Docker build、dev-up、acceptance、浏览器和真实 Provider 为 `SKIP` 及原因，不能把未执行写成 PASS。
