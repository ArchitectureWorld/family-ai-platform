# Family AI Platform 深度 Review 整改设计

**状态：** 计划已编制；A1 已由 PR #30 合入 `main`；A1D 已完成本地实现与全量验证，合入前 A2+ 仍受授权 Gate 阻断

**日期：** 2026-08-13

**适用基线：** A1 合并提交 `29baa8f` 及其后续从最新 `main` 建立的独立任务分支

## 1. 目标

本设计把 2026-08-13 深度 Review 发现的问题转换为一组可独立开发、验证、回滚和合并的整改任务。整改完成前，项目继续采用单 Gateway、单 SQLite、模块化单体，不新增公网入口、微服务、分布式锁或新的终端产品。

整改要解决的不是“功能数量不足”，而是五类事实已经分叉：

1. 当前源码与完整测试结果不一致；
2. 当前源码与 Docker 可启动条件不一致；
3. Preview 能力与正式 `127.0.0.1:8790` 运行物不一致；
4. README、`AGENTS.md`、Gateway README 与实际代码不一致；
5. 正常路径已经可用，但崩溃、断网、重试和迁移失败路径尚未闭环。

## 2. 已确认基线

以下事实是本轮整改的输入，而不是待实现结论：

- `npm run check` 在 2026-08-13 的基线运行中为红：94 个测试文件中 85 个通过、9 个失败；912 个测试中 889 个通过、23 个失败、0 个跳过；
- 其中 21 个失败来自 Entry Session 认证链路读取两个不同时间源；另外 2 个失败是完整套件负载下的 5 秒超时；
- Compose 根文件系统为只读，但没有给默认附件目录提供可写持久化挂载；
- 正式 `8790` 当前由旧 Docker 镜像提供，数据库 Schema 为 v3；当前 Preview 数据库为 v9；
- 生产依赖审计存在 2 个 High 漏洞；
- Hermes CLI 把完整 prompt 放入进程 argv；
- development LAN Preview 的 auto-admin 是历史上明确接受的信任模型，但不能被描述成正式安全认证；
- Chat/Work 幂等范围、移动配对一次性语义、附件补偿、浏览器 outbox 恢复和 Provider pending Turn 恢复仍有缺口；
- 原工作区 `main` 含用户未提交的 `member-public/render.js`、`config.ts` 及对应测试改动，并比本地缓存 `origin/main` 领先两个已提交的显示名文档 commit；整改工作必须使用隔离 worktree，不得混入或覆盖原工作区，后续 Agent 还必须刷新远程证明领先 commit 的真实归属。

## 3. 交付模型

### 3.1 一个风险域一个 PR

每项整改必须：

- 从当时最新 `main` 建立独立 `codex/*` 或项目约定任务分支；
- 直接以 `main` 为 base，禁止堆叠 PR；
- 只修改该风险域所需文件；
- 使用失败测试证明问题，再做最小实现；
- 在同一 PR 内同步代码事实、开发文档和验收证据；
- 合并前报告未覆盖项；合并后才允许下游依赖任务开始。

### 3.2 三类环境必须分开描述

| 环境 | 含义 | 可以更新的事实 |
|---|---|---|
| 单元/集成测试 | 临时数据库、Fake Provider、无正式数据 | 只能证明测试行为 |
| 当前 loopback Preview `127.0.0.1:8791/8792` | development模式、可重建数据、仅本机验收 | 只能证明loopback Preview体验，不代表正式`8790` |
| 历史 LAN `9080/9443` | 第一阶段固定`disabled-only`，不得作为验收环境或证据来源 | 只能记录已禁用/现场只读事实；未来开放须经新的安全不变量治理任务 |
| 正式 `8790` | 保留数据、当前正式容器和回环监听 | 只有完成备份、迁移演练、部署和回滚验证后才能更新运维台账 |

任何文档不得用 Preview 截图、源码版本或测试 Schema 推断正式 `8790` 已升级。

### 3.3 可直接执行的计划包

- [整改实施总计划](../plans/2026-08-13-deep-review-remediation-program.md)：依赖图、阶段 Gate、任务状态；
- [发布工程与正式升级执行计划](../plans/2026-08-13-release-engineering-and-formal-rollout.md)：A4/A5/A6/E0/E1/E1F/E2/F1；
- [隐私、幂等与身份加固执行计划](../plans/2026-08-13-security-and-identity-hardening.md)：B1a/B1b/B2–B4；
- [持久恢复与客户端续作执行计划](../plans/2026-08-13-durable-recovery-and-client-resume.md)：C1/C2/D1/D2/E4。

总计划是顺序与状态权威，执行包是字段、RED、命令和回滚权威。两者冲突时先停止并同步修订，不能由开发 Agent 自行挑选。

## 4. 整改阶段

### 阶段 A：发布阻断

1. 统一 Entry Session 认证时钟；
2. 先让 `AGENTS.md` 与维护者批准的整改边界一致；保留安全不变量、正式发布 Gate 和新增产品禁区；
3. 修复 Compose 附件可写持久化；
4. 受控升级存在 High 漏洞的生产依赖；
5. 恢复 `npm run check`、Docker build 和隔离容器 smoke 的绿色基线；
6. 把 audit/build/container smoke 纳入 CI；
7. 在任何 V10+ migration 前建立 SQLite+附件+镜像+配置的整体备份与恢复演练；浏览器 IndexedDB 只前进不降级。是否必须携带只读 rollback recovery client 不由“版本号是否变化”猜测，而由当前 release capability receipt 的 `rollbackClientRequired` 决定：A5 基础能力为 false，C1 建立 guard 后改为 true，之后即使物理版本不变也仍为 true；
8. 校正 README 与当前运行事实。

阶段 A 完成前，不开始 Push、iOS、HarmonyOS 或新的产品功能。

### 阶段 B：隐私与安全不变量

1. 先在本仓默认禁用 Hermes argv prompt 路径；上游受支持能力未到位时保持离线/fail-closed；
2. 上游能力到位后，Hermes prompt 才改走 stdin/受控 FD，argv 不包含正文或本机路径；
3. 第一阶段安全不变量只允许 loopback 且开发验收台不得承载正式管理员能力，因此 B4 固定禁用 LAN Preview；同一 PR supersede 2026-07-29 的历史信任决定并完成验收。未来重新开放必须另立阶段并先批准修改安全不变量，本计划不预授权；
4. Chat/Work 幂等范围加入 device；
5. 移动配对 claim 只能完成一次，网络重放不得轮换 Session。

### 阶段 C：附件失败恢复

1. 附件数据库和文件系统使用可恢复 journal/outbox；
2. 完成、删除、过期和启动对账可重放；
3. 真实 UI 接通附件暂停、精确续传和单附件失败恢复，不再只有测试可调用的方法；
4. 这一阶段不自动重发状态未知的聊天消息。

### 阶段 D：持久化异步执行

1. 发送请求在消息和 Operation 落库后返回 `202 Accepted`；
2. Provider 执行由持久化 Operation/Lane worker 驱动；
3. Gateway 重启自动接管 pending Operation；
4. SSE/补拉协议公开安全的状态变化，不公开正文、Token、stderr 或本机路径；
5. queued Operation 可安全恢复；无外部查询/幂等能力的 CLI Provider 在调用后崩溃必须进入明确 `indeterminate`，不得伪称 exactly-once 或静默重调；
6. 浏览器 outbox 只有在本阶段完成后，才按原始 `threadRef + clientMessageId` 查询；Gateway 用认证上下文和已存 device/Agent/idempotency/hash 完成授权对账，再决定恢复，浏览器不伪造服务端 key/hash。
7. `none/queryable/idempotent_replay` 必须是 Provider Adapter SDK 的显式能力/API；现有 Hermes/Codex CLI 固定为 `none`，Fake Adapter 负责对三种能力做故障注入，不能只在数据库填一个字符串。

### 阶段 E：发布工程与可维护性

1. E0 建立可确定性渲染、可快照、最小挂载的正式 Compose/Provider **模板、renderer 和校验器**；E1F 在 E2 前实现并fixture验证全部正式发布控制脚本。E0/E1F 的合成证据都不是最终候选。E2 必须从包含 B4=`disabled-verified`、E1F 等全部发布阻断项的最终源码 SHA 构建 Gateway/guard/bundle/helper/controller，并用 E0 renderer 重新生成、hash 绑定 migration、validation、acceptance、active 与 rollback-recovery 五份最终 definition；候选定义与实际部署事实分开；
2. CI 纳入生产依赖审计、Docker build、隔离 Compose smoke 和浏览器 smoke；
3. 在候选冻结前校正 `AGENTS.md`、根 README、Gateway README 和架构状态，并把文档一致性检查器及其测试作为受跟踪脚本合入；E2 必须把这些脚本、Git mode 和 E3 merge commit 纳入输入锁，E2 之后只允许显式 allowlist 的 docs-only 证据追加；
4. 建立保留数据环境的 SQLite+附件一致性快照、不可变镜像、单系统调用目录交换和恢复演练；同时覆盖 V3→head 首次正式全链与 V9→head 丰富数据链；E2 必须在 B4、E1F 与 E3 已合入并验收后冻结最终候选，F1 不得临场重建或修改发布脚本；
5. 用特征测试保护后，渐进拆分大型前端状态机和应用装配；
6. 增加关键授权、幂等和附件补偿的覆盖率门槛与真实浏览器无障碍验收。

### 阶段 F：正式发布

只有 A1–A6、B1a–B4、C1–C2、D1–D2、E0–E3 与 E1F 的发布门禁满足后，才可单独发起正式 `8790` 发布任务；E4 是不阻断 F1 的后续无行为重构。Hermes 受支持私密输入能力 H0 未满足时，B1b、D1 及其所有下游直至 F1 都保持阻断，不能以 Codex-only 验收替代：

1. 只执行E1F已合入且被E2 tool manifest封口的命令；用只读formal preflight生成绑定owner/controller/runtime inode、当前运行物、候选镜像和三mode definition的`0600` fingerprint。现场若需修改脚本，旧候选立即失效并先重跑E2；
2. R1 经用户批准后只做短停整体备份、恢复旧服务和正式数据副本 v3→当前 Schema 演练；
3. R2 在新 fingerprint 获批后只做 final snapshot、原子目录交换和 validation/worker-disabled 可逆验证，不开放业务写入；
4. R3 在新 activate fingerprint、exact family/person/device/agent/profile 与预算/留存策略获批后，才切 acceptance-only 执行真实两轮、刷新、附件、重启和第三轮，成功后受控重建 active。
5. 第一次外部 Provider attempt commit 前失败，只有在证明零普通业务写入、零 Provider attempt 后才可恢复服务器快照；R3 已写入的专用验收 thread/message/operation 先封存为脱敏审计 delta，再允许被快照恢复替换。若浏览器 schema 已前进，previous Gateway 保持停止，由独立零业务挂载的 rollback guard 服务 sealed recovery client，保留草稿但不冒充旧 Gateway/完整前端。跨过边界后失败保持 candidate 维护态并走 forward recovery，禁止旧快照覆盖新写入/外部副作用。
6. R1、R2、R3 每个 Gate 一旦进入可跨任务等待的 durable 状态，都立即把真实 owner/PID/image/Schema/mode 同步到 `/home/youran/data/service-ports.md`、`service-ports.json`，并先读后更新 `agent-architecture.md`；不能等到最终 activation 才校正。R1 记录已恢复的 previous，R2 记录 candidate validation，R3 记录 active、guard 或 forward-maintenance 的真实结果。

### 4.1 Schema 与 release capability 分层

后续实现不得再用一个“每个 server Schema 一个 client 版本”的文件同时表达数据库和前端发布能力：

- `gateway-schema-capabilities.json` 只描述数据库版本及真实表能力：migration head、附件是否存在、journal 版本、mobile claim replay 版本、Provider Operation 版本；
- `gateway-release-capabilities.json` 描述当前源码交付能力：capabilitySetId、candidate Schema head、浏览器物理版本、database name scheme、`rollbackClientRequired`、bundle/guard format；C2/D2 即使不升 server Schema，也必须更新 capabilitySetId 和相应 fixture；
- validator 完全数据驱动地核对两份文件与 server migration/client cache source，并输出同一 `0600` receipt。receipt 是 candidate 源码/能力证明；旧 source DB 只需命中 schema registry 的受支持条目，绝不能被要求 `source schema == candidate head`；
- exact Git SHA 由不可变构建器从目标 commit 得出并绑定 receipt/source hash，不存入会造成自引用的 tracked registry。历史版本允许明确 `legacy-unknown-revision`，不得猜 `minimumImageRevision`；snapshot compatibility 由 manifest `formatVersion` 的明确兼容矩阵控制，不使用未消费的自然语言字段。

A4 即建立两份 registry、数据驱动 validator/receipt 和版本化 `release-build-inputs.json`；该清单从一开始固定互斥的 `runtime-build`、`quality-tool`、`docs-only` 三分类，运行输入与发布裁决工具都进入候选 tree hash，未分类文件和把脚本伪装成 docs-only 必须失败。A5 只把这些契约扩展进 retained snapshot/restore，不得形成 A4→A5→A4 前向依赖。source commit 与 expected commit 必须来自两个层次（builder 参数与 CI/E2 受信上下文），base image/platform/toolchain material也纳入 manifest；“exact Git SHA”只证明源码来源，不自动等于字节级可复现构建。

## 5. 文档同步契约

文档不是最后补写的总结，而是每个 PR 的完成条件。

### 5.1 每个行为 PR 必须更新

- 对应 `docs/superpowers/specs/` 设计：若行为或边界发生变化；
- 对应 `docs/superpowers/plans/` 计划：勾选已完成步骤，记录偏差和未覆盖项；
- `docs/development/YYYY-MM-DD-<topic>.md`：记录实现事实、测试数量、命令结果、回滚方法；
- 与目标应用直接相关的 README：当公开能力、运行方式或限制发生变化；
- 根 README：当产品状态、开发顺序、启动方式或已完成能力发生变化；
- `AGENTS.md`：当开发阶段、强制安全边界或质量门禁发生变化。

### 5.2 仅在触发条件成立时更新

| 触发条件 | 必须同步 |
|---|---|
| 新增、删除或改变监听端口/绑定地址/持久服务 | `/home/youran/data/service-ports.md` 与 `.json` 同步更新 |
| Hermes 架构、Provider 路由、Home/Profile 或正式运行方式变化 | 先读后更新 `/home/youran/data/agent-architecture.md` |
| 数据库 Schema 变化 | migration 设计、恢复步骤、Schema 版本说明和副本演练证据 |
| 正式 `8790` 部署变化 | 两个 service-ports 文件、agent-architecture、不可变镜像和回滚记录 |
| 只有测试或 Preview 变化 | 禁止把正式运维台账写成已部署 |

### 5.3 验收记录最少字段

每份开发验收记录必须包含：

- 分支、HEAD、工作树是否干净；
- 测试文件与测试用例的通过/失败/跳过数量；
- typecheck、build、static check、Docker build 结果；
- 启动、健康、监听和 Schema 证据；
- 真实浏览器覆盖与未覆盖路径；
- 数据和服务是否发生变化；
- 回滚入口及是否实际演练；
- 文档与运维台账的同步结果。

## 6. 第一项优化：Entry Session 单一认证时钟

### 6.1 问题

`EntrySessionAuthenticator` 使用注入的 `now` 判断 Session 是否过期，随后 `FamilyDomainRepository.authenticateEntrySession()` 又读取墙上时间并重复过滤 `expires_at`。测试时钟与真实日期相差较大时，同一 Session 会在第一层有效、第二层无效。

### 6.2 选择的设计

采用“每次认证只捕获一次时间，并显式传入 Repository”的设计：

```text
EntrySessionAuthenticator.authenticate()
  ├─ capturedNow = this.now()
  ├─ 使用 capturedNow 判断 expires_at
  └─ FamilyDomainRepository.authenticateEntrySession(..., capturedNow)
       ├─ 使用同一 capturedNow 做防御性 SQL 过滤
       └─ 使用同一 capturedNow 更新 last_used_at
```

不在本任务中给整个 `FamilyDomainRepository` 做大规模 Clock 重构，因为初始化、成员创建等其他时间写入并未参与本次认证矛盾；它们可在后续统一基础设施任务中独立处理。

### 6.3 兼容性

- 不改变公开 HTTP API、数据库 Schema、Token 格式或 Session 生命周期；
- 不修改端口、Compose、Provider 或正式服务；
- `FamilyDomainRepository.authenticateEntrySession` 只有一个生产调用点，可以安全改为强制传入 `Date`；
- 测试必须覆盖注入时钟明显早于墙上时间、刚好过期和已撤销设备三种边界。

## 7. 非目标

本整改计划不授权：

- 自动部署或重启正式 `8790`；
- 清空 `.runtime` 或 `.runtime-preview`；
- 修改用户当前 `main` 上未提交的显示名工作；
- 直接推送或改写 `main`、force push，或在没有对应任务授权与门禁证据时创建/合并 PR；
- 新增公网暴露、OAuth、微服务或新终端应用。

这些动作如需执行，必须由对应独立任务和用户授权覆盖。
