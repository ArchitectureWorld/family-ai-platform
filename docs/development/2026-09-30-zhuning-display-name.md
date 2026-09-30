# 家庭管家显示名称更新为朱宁

- 分支：`codex/zhuning-display-names`。
- 开发基线：PR #40 已合入 `main`（`104aa33`），包含现网 `27ef236` 的持续管理员登录能力；本候选已重基线到该提交。
- 范围：Broker 对外目录、Gateway broker/direct runtime catalog、Admin 目录白名单、工作台标题及无障碍名称统一使用“朱宁”。
- 身份边界：继续使用 `agent:hermes-jarvis`；Provider Profile、Hermes Home、`sessionScope=jarvis`、外部 Session、授权与历史消息均不改动。

## 名称同步

Gateway 的 `buildProviderRuntime()` 使用本地配置目录；它不导入 Broker 返回的显示名。启动时 `buildGatewayApp()` 调用 `reconcileRuntimeCatalog()`，按原 `agent_ref` 更新 `agents.display_name`。因此 Broker 与 Gateway 必须分别更新对应运行物；只重启 Broker 不会修改 Family 中保存的名称。

现有管理员 API 提供目录查询与成员挂载、解绑、默认 Agent 设置，没有改名接口。本次复用既有启动对账，不新增接口或数据库迁移。正常发布新版 Gateway 后，原 Agent 的显示名按既有逻辑变为朱宁，不创建第二个 Agent。回退旧 Gateway 会在启动时恢复旧显示名，身份与会话仍保持原值。

## 首轮验证（重基线前，保留失败记录）

- `npm ci`：通过，143 packages。
- 聚焦基线：Gateway 四文件 61 项通过。
- RED：Gateway 四文件 14 失败 / 47 通过；Broker 两文件 3 失败 / 43 通过，失败均由旧名称与新预期不一致触发。
- GREEN：上述六文件 107 项通过，0 失败，0 跳过；测试同时保留稳定 Agent/Profile 标识与工作台隔离断言。
- 完整 `npm run check`：FAIL，退出码 1。四个 workspace 共 117 个测试文件（115 通过、2 失败），1,585 项（1,580 通过、5 失败、0 跳过）。Contracts 88、Provider SDK 57、Broker 59 项全过；Gateway 99 个文件、1,376 通过、5 失败。
- 五项失败全部是测试超时：`databaseRecovery.test.ts` 的 forced GC、caller proof descriptors、unclaimed lease 三项，以及 `chatWorkRoutes.test.ts` 的消息持久化/重放/分页用例触及 5 秒；恢复测试的 markerless root cleanup 用例触及 30 秒。对应源码与测试均未被本分支修改。
- 同一代码和原时限定向复跑这五项：5 通过、0 失败，354 项因名称过滤未执行；耗时 16.48 秒。超时未稳定复现，未修改恢复实现或扩大时限；原全量门禁仍记为 FAIL，不能以定向复跑代替完整通过。
- 独立 `npm run typecheck && npm run build`：PASS，四个 workspace 类型检查和 Gateway/Broker 构建通过。
- 独立 `npm run test:scripts`：PASS，24 项 TAP 测试通过，0 失败、0 跳过；部署、镜像契约与公共仓库静态检查通过。
- 独立 built runtime 检查：11 通过、0 失败、1 跳过。跳过项是 rootful sealed-image 恢复矩阵，因为本轮未提供 `GATEWAY_WAL_TEST_IMAGE`；实际 built CLI 的临时数据库恢复验收通过。
- 不可变 Docker 镜像、隔离 dev-up/acceptance、真实浏览器：SKIP。经协调先封存本分支；正式 source 与 main 尚未对齐，旧 main 镜像不能直接发布，待最终基线确定后重跑全部运行门禁。
- 真实 Provider 与正式服务：本分支未执行，不发起计费调用。

## 发布门禁依赖补丁

最终基线的 `production-audit` 命中新披露的请求解析依赖问题。锁文件仅将 `fast-uri` 的 `3.1.6 → 3.1.8`、`4.1.3 → 4.1.5` 和 `fastify` 的 `5.12.0 → 5.12.1` 更新到补丁版；包声明、版本范围及 audit 阈值不变。重新 `npm ci` 后生产依赖审计为 0 漏洞，完整运行门禁仍须基于包含补丁的最终提交执行。

## 归并与最终发布门禁

2026-09-30 经用户授权，PR #40 已合入 main，原正式 source `27ef236` 已纳入唯一权威基线。新候选保留管理员根会话、独立浏览器会话、V2 单次激活与 operator recovery，不以旧 main 回退现网。PR #40 exact head 的七项远端检查全部通过，独立合并前复核无阻断。

最终候选须重新执行 `npm ci`、完整 `npm run check`、唯一 wrapper 镜像构建、同镜像隔离启动/自动验收与浏览器两轮、刷新、容器重启后第三轮。源码矩阵按 Dockerfile 已有分层使用私有 tmpfs 临时目录；sealed-image 恢复矩阵继续使用真实 Docker volume，不改测试时限、不跳过失败用例。最终结果记录在 PR 验收说明，不能以首轮聚焦通过替代。

部署按现有受控流程保留精确镜像、配置和停写备份，先对无网络真实数据副本演练，再切换 Gateway 与同源 Broker。显示名由启动对账更新，不直接编辑正式数据库，不重签现有 operator 或浏览器令牌。现有登录、会话、路由及历史正文应保持一致，失败恢复旧运行物。

本任务不包含主工作区四个未提交文件。端口、Provider 模型、唤醒词不属于网页显示名范围；家庭音箱正式名称为朱宁，生产唤醒词继续使用管家。历史文档和消息中的旧称呼保留当时记录。
