# 家庭管家显示名称更新为朱宁

- 分支：`codex/zhuning-display-names`。
- 开发基线：实时核对 `main` / `origin/main` 均为 `92651ad2d28c16f5489cb1506d71cad08d1f62e2`。
- 范围：Broker 对外目录、Gateway broker/direct runtime catalog、Admin 目录白名单、工作台标题及无障碍名称统一使用“朱宁”。
- 身份边界：继续使用 `agent:hermes-jarvis`；Provider Profile、Hermes Home、`sessionScope=jarvis`、外部 Session、授权与历史消息均不改动。

## 名称同步

Gateway 的 `buildProviderRuntime()` 使用本地配置目录；它不导入 Broker 返回的显示名。启动时 `buildGatewayApp()` 调用 `reconcileRuntimeCatalog()`，按原 `agent_ref` 更新 `agents.display_name`。因此 Broker 与 Gateway 必须分别更新对应运行物；只重启 Broker 不会修改 Family 中保存的名称。

现有管理员 API 提供目录查询与成员挂载、解绑、默认 Agent 设置，没有改名接口。本次复用既有启动对账，不新增接口或数据库迁移。正常发布新版 Gateway 后，原 Agent 的显示名按既有逻辑变为朱宁，不创建第二个 Agent。回退旧 Gateway 会在启动时恢复旧显示名，身份与会话仍保持原值。

## 验证

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

## 正式发布前置条件

2026-09-30 只读核对发现正式镜像 source 为 `27ef2367a17507396c43ca6f165862b16507bbef`，对应 `codex/admin-persistent-access`；它不是当前 `main` 的祖先。该分支包含管理员根会话、浏览器会话、单次激活与 operator recovery 共八个已部署提交。直接用本开发基线构建物替换现网会回退这些能力，因此本分支产物不能据此直接发布。必须先解决权威基线与正式 source 的差异，再对最终候选重跑规定门禁。

两份基线的 `apps/agent-broker` 与 `packages` 完全相同，已用限定路径的 `git diff --exit-code` 确认；Gateway 的基线差异不应误报为 Broker 源码差异。任何组件正式发布仍需各自的封存产物与运行验证，本分支没有执行发布。

本次不改主工作区的四个用户未提交文件；不改正式数据库、Compose、Broker systemd 单元、监听端口或模型配置。历史文档和消息中的旧称呼保留原记录。测试随机 loopback 端口不形成常驻服务配置。
