# Family AI Platform 隐私、幂等与身份加固执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans one task at a time. All behavior changes use superpowers:test-driven-development and completion uses superpowers:verification-before-completion.

**Goal:** 保证私密 Provider 输入不暴露在进程 argv/env，不同设备不能共享消息幂等结果，移动配对码重放不会轮换 Session，并在第一阶段彻底禁用违反 loopback/管理员能力不变量的 LAN Preview。

**Architecture:** 继续以 Gateway 作为身份与授权权威。Provider prompt 只经受支持的 stdin/FD 契约传输。Chat/Work 先校验 device 再返回幂等结果。移动 claim 用设备凭据确定性派生第一次 Session Token，做有界网络重放，但 Session 轮换只允许正式 renew。当前阶段所有发布仍限 `127.0.0.1`，因此 LAN Preview 只允许 fail-closed 禁用；未来若要开放 LAN，必须另立阶段设计并由维护者先批准精确修改根安全不变量，本计划不预授权。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、Vitest、Node crypto、Bash、Hermes/Codex CLI。

---

## 0. 领取规则与人工 Gate

- [x] B1a 已读根 AGENTS.md、README、Gateway README、总计划和目标模块既有设计。
- [x] B1a 创建分支或修改文件前已实时刷新远端 main；基线为 `5169efb`。
- [x] B1a 使用独立 direct-main 分支；B1b、B2、B3、B4 未堆叠进本分支。
- [x] B1a 不等待 Hermes 上游，先把已知 argv 泄露路径默认禁用；B1b 仍受 Hermes 外部能力 Gate 阻断。
- [x] B1a 同分支更新本文、总计划和 docs/development 开发记录。
- [ ] B3 是 V10，必须在 A5 整体备份/恢复合入后开始，并先查询实时 Schema head。
- [ ] 每个 Task 的最终报告必须逐项填写总计划 0.2 的统一门禁矩阵：聚焦 RED、GREEN/领域回归、`npm ci`/`npm run check`、不可变 build/Docker、隔离 dev-up/acceptance、任务专属容器/浏览器、正式服务/真实 Provider、文档/台账。每项只能写 `PASS`、`FAIL` 或 `SKIP + 具体原因`，不得因某项不适用而删除该行。

## 1. Task B1：Hermes/Codex 私密输入不进入 argv/env

### Task B1a：立即禁用不安全 Hermes argv 路径

**建议分支：** codex/disable-unsafe-hermes-argv

**合入状态：** PR #37，合并提交
`cd742fb532359e2001783e4ae87e2fd3b970459f`。

**依赖：** A6 已合入；不依赖 Hermes 上游 stdin 能力。

**修改文件：**

- packages/provider-adapter-sdk/src/hermesCliProvider.ts
- packages/provider-adapter-sdk/test/hermesCliProvider.test.ts
- apps/gateway/src/config.ts
- apps/gateway/src/agentStatus.ts
- apps/gateway/test/config.test.ts
- apps/gateway/test/agentStatus.test.ts
- apps/gateway/test/chatWorkProvider.test.ts
- scripts/member-preview-up.sh
- apps/gateway/test/memberPreviewScripts.test.ts
- 新增 `docs/superpowers/specs/2026-08-13-provider-private-input-boundary-design.md`
- apps/gateway/README.md
- 本文、总计划和 `docs/development/2026-08-<实施日>-disable-unsafe-hermes-argv.md`

- [x] RED 证明当前 real mode 未配置私密输入能力时仍可走 `-q <prompt>` spawn；Preview 脚本也不能隐式启用该路径。
- [x] 增加 `FAMILY_AI_HERMES_PRIVATE_INPUT_MODE=disabled|query-stdin-v1`，默认 disabled、未知值 fail-closed。
- [x] SDK Hermes adapter 构造参数新增显式 privateInputMode；默认/disabled 的 invoke 直接返回安全错误且零 spawn，禁止其他调用方绕过 Gateway config 直接恢复 `-q`。
- [x] Gateway disabled 时保留 Hermes Agent/Profile catalog，但 health=offline，invoke 返回 `PROVIDER_UNAVAILABLE` 且零 spawn；所有脚本显式写 disabled，不能依赖默认值。
- [x] query-stdin-v1 在 B1b 合入前也必须 fail-closed 为“能力未注册”，禁止先拼一个上游不存在的参数。
- [x] Codex 现有 stdin 路径保持可用并补“不受 Hermes disable 影响”回归。

验证：

    npm exec --workspace @family-ai/provider-adapter-sdk -- vitest run test/hermesCliProvider.test.ts --maxWorkers=1 --no-file-parallelism
    npm exec --workspace @family-ai/gateway -- vitest run test/config.test.ts test/agentStatus.test.ts test/chatWorkProvider.test.ts test/memberPreviewScripts.test.ts --maxWorkers=1 --no-file-parallelism
    npm run check
    bash scripts/static-check.sh
    git diff --check

**完成判据：** H0 未满足期间仓库没有任何可达的 Hermes argv prompt 调用；Hermes 明确离线、Codex 不回归。回滚不得恢复 argv 路径，只能继续 disabled。

### Task B1b：在上游能力可用后启用私密输入

**建议分支：** codex/provider-private-input-channel

**依赖：** B1a；Hermes 当前运行时提供经测试、受支持、与 query argv 互斥的 stdin/FD 单次输入能力。

**修改文件：**

- packages/provider-adapter-sdk/src/processRunner.ts
- packages/provider-adapter-sdk/src/hermesCliProvider.ts
- packages/provider-adapter-sdk/src/codexCliProvider.ts（只加回归，除非现场发现泄露）
- packages/provider-adapter-sdk/test/processRunner.test.ts
- packages/provider-adapter-sdk/test/hermesCliProvider.test.ts
- packages/provider-adapter-sdk/test/codexCliProvider.test.ts
- 新增 packages/provider-adapter-sdk/test/processPrivacy.integration.test.ts
- apps/gateway/src/config.ts
- apps/gateway/test/config.test.ts
- scripts/member-preview-up.sh
- apps/gateway/test/memberPreviewScripts.test.ts
- `docs/superpowers/specs/2026-08-13-provider-private-input-boundary-design.md`
- Gateway README、本文、总计划和开发记录
- /home/youran/data/agent-architecture.md（只有正式运行架构实际变化后）

### B1.1 外部能力 Gate

2026-08-13 现场 Hermes v0.20.0 / 2026.8.3 的 hermes chat --help 只有 -q/--query，没有 stdin 单次 query 参数。实施时必须重新核对当前本机版本和官方文档：

- [ ] 若已有官方 stdin/FD 契约，记录精确 release/commit、帮助输出 hash、上游测试证据和最小 one-shot 证据；
- [x] 2026-08-16 复核仍没有受支持 stdin/FD 单次 query，已记录 H0 blocked 并停止 B1b；未跨仓修改 Hermes；
- [x] B1a 的 Hermes Adapter 继续 disabled/fail-closed，禁止回退到 argv、环境变量、临时文件路径或 shell；
- [x] 本仓任务未修改 Hermes home/profile/model，也未重启无关 personal assistants。

### B1.2 RED

使用唯一敏感标记和一个会等待 stdin 的 dummy executable：

- [ ] 捕获 executable、prefixArgs、args、allowedEnvironment，断言 prompt、附件正文、绝对路径、Token/Cookie 标记均不存在；
- [ ] 从 /proc/<pid>/cmdline 和 /proc/<pid>/environ 二次断言敏感标记不可见；
- [ ] dummy 子进程从 stdin 精确收到一次完整 UTF-8 prompt；
- [ ] 超上限、NUL、abort、timeout、EPIPE、子进程提前退出均关闭 stdin 和进程组，不泄露输入到错误对象；
- [ ] Codex 当前 stdin 路径加入同样回归；Hermes 当前 -q 路径应 RED。

先运行：

    npm exec --workspace @family-ai/provider-adapter-sdk -- vitest run test/processRunner.test.ts test/hermesCliProvider.test.ts test/codexCliProvider.test.ts test/processPrivacy.integration.test.ts --maxWorkers=1 --no-file-parallelism

### B1.3 最小实现

当前 processRunner 已有 stdin、默认 1 MiB/最大 16 MiB 检查、UTF-8 字节上限、NUL 拒绝、pipe、EPIPE 容忍和 abort/timeout 进程组清理。先加回归；只有测试证明现有实现有缺陷时才最小修补，禁止为了命名另造第二套通道。

- [ ] 保留 B1a 的 disabled/fail-closed 行为；不得改变默认值。
- [ ] 只有 query-stdin-v1 才允许 Hermes args 使用 chat --query-stdin；prompt 通过现有 stdin 传入并设置 maxStdinBytes=1,048,576。
- [ ] 模型、provider、profile、opaque resume session 可留 argv，prompt 不可留；禁止旧 -q fallback。
- [ ] Codex 已使用 stdin，只补同等隐私回归，不无故修改生产路径。
- [ ] Provider error/audit 只保留公开代码、exit 类别、timedOut/aborted 和字节计数，不保存 prompt、stdout/stderr 正文或路径。

验证命令：

    npm test --workspace @family-ai/provider-adapter-sdk
    npm run check
    bash scripts/static-check.sh
    git diff --check

再做一条本机无隐私标记 one-shot 和 /proc 检查；不把真实私人消息用作验收。

**文档/运行台账：** 先读 agent-architecture.md。代码合入但未部署时不把 argv→stdin 写成正式事实；正式 Gateway Provider 调用方式部署后才更新。没有端口变化时不改 service-ports。

**回滚：** 不能回滚到 argv 传 prompt；若新 Hermes 能力不可用，回滚结果必须是禁用 Hermes Adapter/fail-closed，Codex stdin 路径不受影响。

**完成判据：** 单元测试、/proc 与真实无隐私 one-shot 都证明 prompt 不在 argv/env；上游能力版本可追溯；不可用时明确阻断而非降级泄露。

## 2. Task B2：Chat/Work 幂等返回先校验 device

**建议分支：** codex/device-scoped-chat-idempotency

**依赖：** A6 已合入。该任务采用无 Schema 的冲突语义；若产品要求不同 device 可复用同一 clientMessageId，必须停止 B2 和全部后续 migration，另行批准复合唯一键并重新编号计划。

**修改文件：**

- apps/gateway/src/chatWorkDomain.ts
- apps/gateway/src/chatWorkMessageService.ts（只有需要传递上下文时）
- apps/gateway/test/chatWorkDomainSecurity.test.ts
- apps/gateway/test/chatWorkRoutesSecurity.test.ts
- apps/gateway/test/chatWorkProvider.test.ts
- apps/gateway/test/deviceSyncIsolation.test.ts
- 新增 `docs/superpowers/specs/2026-08-13-device-scoped-idempotency-design.md`、本文、总计划和开发记录

### B2.1 固定规则

现有唯一键 thread_ref + client_message_id 保持不变。对同一 thread/clientMessageId：

- 同 device + 同 person/agent/audience + 同规范化内容 hash：返回原 message/Provider turn；
- 同 device 但内容 hash 不同：THREAD_MESSAGE_CONFLICT，409；
- 不同 device，即使 person、正文、时间、附件完全相同：THREAD_MESSAGE_CONFLICT，409；
- 未授权 member/agent/thread 仍按既有 not-found/permission 边界返回，不能通过冲突响应探测记录；
- 授权与 device 比较都必须发生在任何缓存/Provider 结果返回之前。

### B2.2 RED

- [x] 建立同一 member 的 device A/B；A 发消息并得到 Provider 结果。
- [x] B 使用相同 clientMessageId、occurredAt、正文和附件重放，断言 409，响应不含 A 的 messageRef、assistantMessageRef 或正文，Provider 计数仍为 1。
- [x] B 使用相同 ID 但不同正文仍得到相同公开 409，避免内容 oracle。
- [x] A 的完全相同重放仍返回原 message/Provider 结果，计数为 1。
- [x] 错误 member、agent、audience 在 device conflict 前被授权边界拒绝。
- [x] 不改变现有 Person-level Device Sync 可见性：同一 Person 的设备 A/B 仍可看到该 Person 有权同步的同一 domain event，只有 cursor/ack 按设备隔离。B2 只禁止设备 B 通过消息 POST 的幂等缓存命中拿到 A 的成功响应；增加回归防止误做 origin-device 事件过滤。

先运行目标测试并确认 B 的同内容重放当前错误地返回原结果。

### B2.3 最小实现

- [x] appendThreadMessage 已先 requireThread；保留该次序。
- [x] findMessageByClientId 命中后，先比较 existing.origin.deviceRef 与 input.origin.deviceRef，再计算/比较现有 logical fingerprint。
- [x] actor=person 时 deviceRef 必填；system/provider 消息不走客户端幂等入口。
- [x] device mismatch 与 payload mismatch 使用同一 THREAD_MESSAGE_CONFLICT envelope，不回显任何已有记录字段。
- [x] 不改唯一索引、不新增 migration、不改变成功响应。

2026-08-16 验证状态：B2 已实现，待独立 PR。生产修改只在
`chatWorkDomain.ts` 中增加命中已有消息后的 device 比较；未修改
Service、Schema/migration 或 Device Sync。聚焦 RED 为 `3 failed / 22 passed`，
GREEN 为 `25/25`，邻近回归为 `21/21`，加强路由泄漏断言后的
route/provider 回归为 `11/11`。完整门禁、不可变镜像和浏览器证据见
[`B2 开发记录`](../../development/2026-08-16-device-scoped-chat-idempotency.md)。

验证命令：

    npm exec --workspace @family-ai/gateway -- vitest run test/chatWorkDomainSecurity.test.ts test/chatWorkRoutesSecurity.test.ts test/chatWorkProvider.test.ts test/deviceSyncIsolation.test.ts --maxWorkers=1 --no-file-parallelism
    npm run check
    bash scripts/static-check.sh
    git diff --check

**回滚：** 无数据变化；代码回滚会重新开放跨设备结果泄露，因此只用于定位，不能作为发布方案。

**完成判据：** 跨设备相同 key/hash 不返回缓存结果且不触发第二次 Provider；原设备幂等仍成立；无 Schema 变化。

## 3. Task B3：V10 移动 claim 有界重放原 Session

**建议分支：** codex/mobile-pairing-single-use-claim

**依赖：** A5、A6 已合入；实时 Schema head=V9。若不是 V9，停止并同步重编号。

**修改文件：**

- apps/gateway/src/database.ts
- apps/gateway/src/mobilePairing.ts
- 新增 apps/gateway/src/mobilePairingCrypto.ts
- packages/contracts/src/mobileEntry.ts（只有公开错误/响应约束变化时）
- apps/gateway/test/database.test.ts
- apps/gateway/test/mobilePairing.test.ts
- apps/gateway/test/mobileRoutes.test.ts
- apps/gateway/test/mobileWebPairing.test.ts
- 新增 apps/gateway/test/mobileClaimReplayMigration.test.ts
- scripts/gateway-schema-capabilities.json
- scripts/gateway-release-capabilities.json
- scripts/gateway-schema-capabilities.mjs（如bounded-replay-v1映射需扩展）
- scripts/test-runtime-backup-restore.sh（新增 V10 compatibility fixture；不改 A5 核心交换语义）
- scripts/test-runtime-candidate-stage.sh（新增V9→V10 fixture）
- 新增 `docs/superpowers/specs/2026-08-13-mobile-claim-replay-design.md`、Gateway README、本文、总计划和开发记录

### B3.1 保持真实状态，不发明新状态

mobile_pairing_codes.status 继续只允许 active、consumed、revoked、expired。V10 不增加 pending/approved/claimed。claim 的第一次 active→consumed 是唯一完成点；consumed 只允许返回第一次的同一个 Session，不调用 issuePersonalSession。

有界重放条件全部满足才返回原响应：

- 原 code/pairingRef 匹配；
- installationId 与 consumed_device_ref 对应设备完全匹配；
- deviceCredential constant-time 匹配；
- 当前时间不晚于 consumed_at + 120 秒；精确边界允许；
- mobile_replay_count 小于 3；
- mobile_claim_session_ref 仍 active、未过期且属于同一 personal binding/device/person/family；
- 用原 deviceCredential + pairingRef 重新派生的 token hash 与 entry_sessions.token_hash 相同。

任一失败都不创建、续期或撤销 Session。网络重放窗口结束后只能用正式 renew endpoint。这里的 renew 身份仍是现有 `X-Device-Ref + Authorization: Device <deviceCredential>`，不是 claim code、pairingRef 或 Entry Token；B3 不改变该公开契约。claim code/token 不能作为 renew 凭据。

### B3.2 V10 精确字段与 Token 派生

在 mobile_pairing_codes 保留现有列和 web_claim_session_ref/web_replay_count，只新增：

| 字段 | 约束 |
|---|---|
| mobile_claim_session_ref | 可空外键 entry_sessions；新 consumed claim 必填 |
| mobile_replay_count | 非负，默认 0 |

mobilePairingCrypto.ts 用 raw deviceCredential 确定性派生原 Entry Token：

    algorithm = HKDF-SHA256
    IKM = UTF-8(deviceCredential)
    salt = SHA-256(UTF-8(pairingRef))
    info = family-ai:mobile-entry:claim-session:v1
    output = 32 bytes, base64url 43 chars

数据库复用既有 `managed_devices.installation_ref` 与 `credential_hash`，并保存 `entry_sessions.token_hash`、`mobile_claim_session_ref` 与计数；V10 不在 pairing 表另存 installationId 副本，也不保存明文 token 或 deviceCredential。现有 deviceCredential schema 只校验 43 个 base64url 字符，B3 不顺带更改公共 credential contract。

历史 consumed 行的 mobile_claim_session_ref 为空，明确不可重放；历史 active 行可按新逻辑首次完成。status CHECK 不变。

### B3.3 migration RED

- [ ] V9 fixture 自动升级 V10，既有 active/consumed/revoked/expired 状态和 web replay 字段不变。
- [ ] legacy consumed 行 mobile_claim_session_ref 为空且返回 PAIRING_CONSUMED，不创建 Session。
- [ ] GatewayDatabaseOpenOptions.migrationLimit 更新为 6|7|8|9|10，ledger 恰为 1…10，重复打开不重复迁移。
- [ ] schema registry追加V10：attachments=present、attachmentJournal=none、mobileClaimReplay=bounded-replay-v1、providerOperations=legacy；release capabilities更新schemaHead=10、clientDatabaseVersion仍2、capabilitySetId=`mobile-claim-replay-v1`、rollbackClientRequired仍false。若validator不认识新enum/source映射，同PR修改及测试。用A5 V9→V10 candidate-stage/snapshot/restore fixture证明合法V10不被误判。
- [ ] V11/未知未来 Schema 被拒绝；任一回填/约束失败整体回滚。
- [ ] A5 的 V9 整体 snapshot 可在 migration 失败后逐字节恢复。

### B3.4 claim RED

- [ ] 第一次 claim 返回完整 device/entry；相同请求重放 1–3 次始终逐字段相同，第 4 次返回 PAIRING_CONSUMED。
- [ ] 每次重放后 active Session 总数仍为 1，entry_sessions 没有新增/撤销，mobile_replay_count 精确递增。
- [ ] 两个独立数据库连接/请求并发相同 claim，只有一次创建 Session；另一请求在取得 SQLite 写锁后重新读取 consumed 行并走同一重放响应。测试必须用 barrier 证明二者都已进入 claim 路径，不能只在同一同步调用栈串行调用。
- [ ] consumed_at + 120 秒精确边界成功，边界后 1 ms 失败。
- [ ] 错误 installation、credential、code、device revoked、binding revoked、Session revoked/expired、过窗、超 3 次均不轮换 Session且不增加计数。
- [ ] 正式 renew 会生成新 Session 并撤销旧 Session；之后旧 consumed claim 不得取回已撤销 token，也不得生成第三个 Session。
- [ ] 关闭并重开数据库后仍返回完全相同 token；错误响应、日志和审计不回显 token/hash。

### B3.5 最小实现和验证

- [ ] 拆清两种内部能力：`issueFirstClaimSession(entryBindingRef, explicitDerivedToken, now)` 只在 active→consumed 的同一事务使用 HKDF 明确 token，并按现有“同 binding 轮换”规则先撤销该设备/binding 的旧 active Session，再插入唯一新 Session；`issueRenewedPersonalSession(entryBindingRef, now)` 只供正式 renew，生成随机 token并执行同样轮换。consumed replay 两者都不得调用，因此重放永不再次撤销/轮换。
- [ ] 已配对设备拿到新 pairing code 再首次 claim 的 RED：该次首次完成允许有且仅有一次旧 Session→新派生 Session 轮换；随后 1–3 次 consumed replay 始终返回新 Session 且 active 数保持 1。若维护者选择禁止重新配对，必须在 B3 设计批准时改为 claim 前 fail-closed，并同步 mobile UX；不得无条件保留两个 active Session。
- [ ] 第一次 claim 使用显式 SQLite `BEGIN IMMEDIATE`（或等价 immediate transaction）先取得写锁，再重新读取 pairing 状态；事务内创建/复用 device 与 binding、派生 token、创建唯一 Session，最后以 status=active 的 CAS 把 pairing 置 consumed 并写 mobile_claim_session_ref；changes 必须为 1。禁止“先在 deferred transaction 插 Session、CAS 失败后再清理”的窗口。
- [ ] consumed 分支重新派生 token、验证 hash/绑定/窗口，再以 mobile_replay_count < 3 的条件 UPDATE 原子递增；不调用 issuePersonalSession。
- [ ] installation/credential/hash 比较继续使用 timingSafeEqual；connection 或网络重试不改变 Session。

验证命令：

    npm exec --workspace @family-ai/gateway -- vitest run test/database.test.ts test/mobilePairing.test.ts test/mobileRoutes.test.ts test/mobileWebPairing.test.ts test/mobileClaimReplayMigration.test.ts --maxWorkers=1 --no-file-parallelism
    bash scripts/test-runtime-candidate-stage.sh --fixture v9-v10
    bash scripts/acceptance-mobile-pairing.sh
    npm run check
    bash scripts/static-check.sh
    git diff --check

**回滚：** 先停止新二进制，用 A5 整体恢复 V9 SQLite、附件、配置和镜像。禁止旧二进制直接打开 V10；不提供 SQL downgrade。

**完成判据：** 合法丢包重放返回原 Session/token 且数据库永远只有一次完成；所有失败路径都不轮换；V9→V10 与整体恢复已演练。

## 4. Task B4：禁用 LAN Preview 管理捷径

**建议分支：** codex/disable-lan-preview-admin

**安全边界：** 根 AGENTS.md 当前要求第一阶段所有发布端口只能绑定 127.0.0.1，且开发验收台不得包含正式管理员能力。因此本 Task 只有 disabled-verified 一个合法结果；禁止通过 grant、Cookie、proxy marker 或 CIDR 把 9080/9443 重新开放到 LAN。未来若确需 LAN Admin，必须另立阶段设计、威胁模型和 direct-main 治理 PR，由维护者先批准精确修改对应安全不变量，本计划不预授权。

**依赖：** A6 已合入。无 Schema migration。代码 PR 本身不授权停止任何现场进程；若只读检查发现当前仓库确实拥有 LAN listener，必须另获用户对精确 manifest/进程的停止批准。

**修改文件：**

- apps/gateway/src/adminPreviewAccess.ts
- apps/gateway/src/config.ts
- apps/gateway/src/app.ts
- apps/gateway/admin-public/admin-api.js
- apps/gateway/admin-public/admin-entry.js
- apps/gateway/admin-public/admin.js
- apps/gateway/test/adminPreviewAccess.test.ts
- apps/gateway/test/adminWebModules.test.ts
- apps/gateway/test/memberPreviewScripts.test.ts
- apps/gateway/test/memberPreviewLan.test.ts
- scripts/member-preview-up.sh
- scripts/member-preview-lan-up.sh
- scripts/member-preview-lan-down.sh
- scripts/member-preview-admin.mjs
- scripts/member-preview-lan-lib.mjs
- scripts/static-check.sh
- docs/superpowers/specs/2026-07-29-admin-preview-reliability-and-repository-consolidation-design.md 与对应 plan 顶部 supersede 标记
- 新增 docs/superpowers/specs/2026-08-13-lan-preview-admin-security-boundary.md
- README、Gateway README、本文、总计划和开发记录
- 仅当现场端口状态实际变化时，同次更新 /home/youran/data/service-ports.md 与 service-ports.json

### B4.1 先写 RED

先在 fixture/mocked-process 模式补测试，再运行：

    npm exec --workspace @family-ai/gateway -- vitest run test/adminPreviewAccess.test.ts test/memberPreviewScripts.test.ts test/memberPreviewLan.test.ts --maxWorkers=1 --no-file-parallelism

预期 RED 必须来自当前 LAN up 仍会规划资源、Admin auto-access 仍可注册或静态门禁尚不能阻断这些入口；不得以文件不存在、语法错误或真的创建/停止现场 listener 充当 RED。

固定断言：

- [ ] member-preview-lan-up.sh 在任何 mkdir、证书、配置、Gateway/Nginx 进程或 listener 创建前，以稳定 LAN_PREVIEW_DISABLED 退出。
- [ ] Gateway 在 development/test/production 均不注册 LAN access-mode 或 /api/v1/admin/preview-access；历史 raw family_admin credential 路径不可达。
- [ ] 仓库不存在 preview-auto、LAN Admin grant/session、LAN CIDR allow 或 Admin Cookie bridge 的活跃配置入口。
- [ ] 9080/9443 被本项目或陌生进程占用时，up 都只报告 disabled/occupied，不 kill、不复用。
- [ ] 正式 127.0.0.1:8790 的 owner、PID、listener、health 在测试前后完全不变。
- [ ] loopback-only 8791/8792 Preview 是独立开发能力；LAN down 不得误停它，除非用户另行批准调用其专用 down 命令。

### B4.2 最小实现

- [ ] 把 member-preview-lan-up.sh 收敛成零副作用的 disabled 命令；保留 --help/机器可读状态，但所有启动分支在资源解析前 fail-closed。
- [ ] 从 LAN 路径删除 Admin auto-access 环境、credential handoff、Nginx LAN 配置生成和活跃 README 命令。
- [ ] Gateway 移除 LAN 专用 access-mode/preview-access 注册；不得新增替代 grant/session/Cookie 管理能力。
- [ ] member-preview-lan-down.sh 只清理其 manifest 能严格证明为本仓库-owned 的 9080/9443 历史资源；拒绝宽泛 PID、端口、目录、glob 或未解析变量。
- [ ] down 前先只读核对 canonical manifest、owner、PID/start time、cwd/config hash、listener；任一不匹配只报告 stale/foreign，不执行停止。
- [ ] 若用户明确批准清理精确现场资源，先保存脱敏 before 证据，再停止 owned Nginx/Gateway，确认 9080/9443 本项目 listener 消失；不碰陌生进程、其他项目、8790 或默认 8791/8792 loopback Preview。
- [ ] scripts/static-check.sh 阻断能创建 LAN listener 的脚本分支、preview-auto 字符串、自动 credential endpoint，以及 0.0.0.0/非loopback发布。
- [ ] 不创建空的 adminPreviewGrant/adminPreviewSession 模块或测试；未来 LAN Admin 必须走新的治理任务，不能把本节当待办。

### B4.3 GREEN、浏览器与生命周期验收

先复跑聚焦命令，再运行：

    npm run check
    bash scripts/static-check.sh
    git diff --check

fixture 生命周期测试至少覆盖：

- [ ] up 连续调用两次都为 LAN_PREVIEW_DISABLED，且临时目录、进程、端口、正式 8790 均零变化。
- [ ] down 面对 owned、stale、foreign、缺失 manifest 四种输入；只有用户批准且 identity 全匹配的 owned fixture会进入 stop，其他均零副作用。
- [ ] 在 identity 核对后、stop 前、stop 后、cleanup 前注入失败；重跑只清本轮或 manifest 精确拥有的资源。
- [ ] 路径为相对路径、home/仓库根、符号链接、权限过宽或 manifest 含私有正文时 fail-closed。
- [ ] 真实浏览器从 LAN URL 无法连接本项目 Preview；loopback Preview 的既有特征测试仍通过，且 Admin auto-access 不存在。
- [ ] 测试报告只含状态、公开错误码、端口和 identity hash，不含 Token、Cookie、消息正文或私有绝对路径。

### B4.4 文档、台账与回滚

- [ ] 新 LAN 边界 spec 明确第一阶段 disabled-verified；在 2026-07-29 旧 design/plan 顶部增加指向新 spec 的 superseded 头，保留历史内容但不得继续声称 active。
- [ ] README/Gateway README 删除 LAN Admin 启动说明，保留 loopback Preview 的精确边界；本文、总计划和开发记录同步状态、RED/GREEN、现场动作和未覆盖项。
- [ ] 只改代码而未改变现场状态时，两个 service-ports 文件不写成已停；开发记录明确“不触发台账更新”。
- [ ] 若经另行批准实际停止 9080/9443，本 Gate 内实时取证并同次更新 service-ports.md 与 service-ports.json，运行 jq empty；记录无本项目 listener及保留的loopback/正式服务，不记录 secret。
- [ ] 本 Task 不改变 Hermes/Provider 架构，因此不更新 agent-architecture；若现场发现实际架构事实另有漂移，只报告并另立授权任务。

**回滚：** 不允许恢复 preview-auto 或 LAN listener。代码回退只能回到仍然禁用 LAN 的上一安全版本；重新开放必须先完成独立阶段设计和安全不变量治理批准。生命周期脚本始终只能清理本轮或 manifest 严格证明 owned 的资源。

**完成判据：** B4 结果固定为 disabled-verified；本项目无法启动 9080/9443 LAN Preview，也不暴露自动管理员凭据入口；旧设计有清晰 supersede 链，loopback Preview和正式8790未被影响。
