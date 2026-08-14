# Family AI Platform 持久恢复与客户端续作执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to execute one task at a time. Every behavior change must use superpowers:test-driven-development, and every completion claim must use superpowers:verification-before-completion.

**Goal:** 把附件、Provider 调用和浏览器待发送状态从“正常路径能用”提升为“进程、容器或页面在任意关键点中断后，系统仍能判断发生了什么，并安全续作或明确停在待人工处理状态”。

**Architecture:** Gateway 仍是唯一业务后端和数据权威。所有跨 SQLite 与文件系统、SQLite 与外部 Provider 的动作，先在 SQLite 写入可恢复意图，再执行副作用，最后提交公开结果。浏览器只保存恢复所需的最小 outbox，不保存 Session secret。CLI Provider 不具备外部查询或幂等能力时，不承诺 exactly-once，而是把不可判定窗口显式记为 indeterminate。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、Vitest、原生浏览器 JavaScript、IndexedDB、Docker Compose、Fake Provider 故障注入。

---

## 0. 领取规则与共享前置

- [ ] 先读根 AGENTS.md、README.md、apps/gateway/README.md、总计划 docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md 和目标任务引用的设计。
- [ ] 创建分支或修改文件前实时刷新远端 main，并证明本地领先提交已经进入远端 main；无法证明则停止。
- [ ] C1、C2、D1、D2、E4 分别建立直接指向 main 的独立 PR。顺序固定包含 `C1→C2→D1→D2`：C2 先建立 browser runner/IndexedDB V3，D1 再从该 main 升 V4；两者禁止并行改 cache/api/product/render。E4 另以E2已合入为前置，建议F1后执行。下游只能从已合入依赖的新 main 开始，禁止堆叠 PR。
- [ ] A2 的可写附件持久卷、A5 的整体备份恢复、B3 的 V10 必须先合入，C1 才能开始。
- [ ] 每次 migration 前查询当前 Schema head。本文以 B3=V10、C1=V11、D1=V12 为顺序；实际 head 不一致时先同步修改总计划和本文，再写 migration。
- [ ] C1 的 V11 migration 前必须在 A5 提供的副本上完成备份与恢复演练；D1 的 V12 同理。
- [ ] 每个任务同分支新增 docs/development/YYYY-MM-DD-<topic>.md，并同步本计划与总计划的状态、偏差、验证统计、回滚和未覆盖项。
- [ ] 本执行包不授权重启正式 127.0.0.1:8790，也不授权清空现有 .runtime。
- [ ] 每个 Task 的最终报告必须逐项填写总计划 0.2 的统一门禁矩阵：聚焦 RED、GREEN/领域回归、`npm ci`/`npm run check`、不可变 build/Docker、隔离 dev-up/acceptance、任务专属容器/浏览器、正式服务/真实 Provider、文档/台账。每项只能写 `PASS`、`FAIL` 或 `SKIP + 具体原因`，不得因某项不适用而删除该行。

## 1. Task C1：Attachment Service、V11 journal 与启动对账

**建议分支：** codex/attachment-recovery-v11

**依赖：** A2、A5、B3 已合入；远端 main 与 Schema head 已确认。

**修改文件：**

- packages/contracts/src/chatWork.ts（附件上传状态公开契约）
- packages/contracts/test/chatWork.test.ts
- apps/gateway/member-public/attachments.js（只做 clientUploadId 最小兼容；完整续传仍属 C2）
- apps/gateway/member-public/cache.js（只保存 create 重放所需记录）
- 新增 apps/gateway/member-public/cache-name.js（只含纯命名/反算 helper、prefix 与 legacy name 常量，无 IndexedDB API）
- apps/gateway/member-public/cache-identity.js（改为复用纯 helper，行为不变）
- 新增 apps/gateway/member-rollback-public/index.html
- 新增 apps/gateway/member-rollback-public/recovery.js
- 新增 apps/gateway/member-rollback-public/recovery.css
- 新增 scripts/build-member-rollback-recovery.mjs
- 新增 Dockerfile.rollback-recovery
- 新增 scripts/rollback-recovery-server.mjs
- 新增 scripts/build-rollback-recovery-image.sh
- 新增 scripts/test-rollback-recovery-image.sh
- 新增 compose.rollback-recovery.yaml
- apps/gateway/src/database.ts
- apps/gateway/src/attachmentRepository.ts
- apps/gateway/src/attachmentStorage.ts
- apps/gateway/src/attachmentRoutes.ts
- 新增 apps/gateway/src/attachmentService.ts
- 新增 apps/gateway/src/attachmentRecovery.ts
- 新增 scripts/attachment-integrity-repair-inspect.mjs
- 新增 scripts/attachment-integrity-repair.mjs
- 新增 scripts/test-attachment-integrity-repair.sh
- apps/gateway/src/app.ts
- apps/gateway/src/index.ts
- apps/gateway/test/database.test.ts
- apps/gateway/test/attachmentMigration.test.ts
- apps/gateway/test/attachmentRepository.test.ts
- apps/gateway/test/attachmentStorage.test.ts
- apps/gateway/test/attachmentRoutes.test.ts
- apps/gateway/test/memberCacheModel.test.ts
- apps/gateway/test/memberIdentityCache.test.ts
- 新增 apps/gateway/test/memberRollbackRecovery.test.ts
- 新增 apps/gateway/test/attachmentRecovery.test.ts
- scripts/gateway-schema-capabilities.json
- scripts/gateway-release-capabilities.json
- scripts/gateway-schema-capabilities.mjs（若journal enum/source映射需扩展）
- scripts/test-runtime-backup-restore.sh（新增 V11 compatibility fixture）
- scripts/test-runtime-candidate-stage.sh（新增 V10→V11 fixture）
- 新增 `docs/superpowers/specs/2026-08-13-attachment-recovery-journal-design.md`
- Gateway README、本计划、总计划和开发记录

### C1.1 先冻结公开行为

- [ ] 为 create、PUT chunk、complete、download、cancel、expiry cleanup 的成功响应与错误 envelope 增加特征测试。
- [ ] 为 GET /api/v1/attachments/uploads/:attachmentRef/status 增加契约、Route 与授权 RED；未授权和不存在必须使用同一 404 边界。
- [ ] 断言 member、agent、conversation、attachment 的既有授权范围不变。
- [ ] 断言 ready/attached 附件的文件名、媒体类型、字节数、SHA-256 和下载头不变。
- [ ] 只运行 attachmentRoutes.test.ts，确认特征测试在现状通过；这些测试用于约束重构，不作为 RED。

### C1.2 先写 V11 migration RED

从真实 V10 fixture 启动 Gateway，先写以下失败断言：

- [ ] 自动升级到 V11；Schema 版本正好为 11。
- [ ] 新表 attachment_storage_operations 存在，唯一键和状态约束生效。
- [ ] attachments 新增 nullable legacy-compatible 的 origin_device_ref/client_upload_id 和非空 updated_at；两项来源字段必须同时为空或同时非空，且非空时存在唯一索引。
- [ ] V10 数据逐字节保留，已有 ready/attached 附件仍可下载。
- [ ] V12 或未知未来 Schema 被拒绝，不能自动降级或覆盖。
- [ ] 在A5 schema registry追加V11：attachments=present、attachmentJournal=journal-v1、mobileClaimReplay=bounded-replay-v1、providerOperations=legacy；在release capabilities把schemaHead=11、clientDatabaseVersion=3、capabilitySetId更新并首次设置rollbackClientRequired=true、bundle/guard format。validator与A5 V10→V11 candidate-stage/snapshot/restore通过；如新enum/source映射尚不认识journal，同PR修改validator及聚焦fixture，不在A5另加私有hard-code。
- [ ] 迁移失败时事务回滚，V10 fixture 仍可由旧二进制打开。

建议命令：

    npm exec --workspace @family-ai/contracts -- vitest run test/chatWork.test.ts
    npm exec --workspace @family-ai/gateway -- vitest run test/database.test.ts test/attachmentMigration.test.ts --maxWorkers=1 --no-file-parallelism

预期 RED：Schema 仍停在 V10，或新表不存在；不能接受语法错误或 fixture 缺失。

### C1.3 固定 journal 模型

V11 新表 attachment_storage_operations 的最小字段如下，列名变更必须先更新本文并获审查：

| 字段 | 约束与用途 |
|---|---|
| operation_ref | UUID 主键 |
| attachment_ref | 外键，归属现有 attachment |
| kind | write_chunk、assemble_file、delete_keys、verify_blob 四选一；verify_blob 只记录已落成 blob 的完整性故障，不执行文件写入 |
| storage_key | 相对附件根的 opaque key；禁止绝对路径与 .. |
| chunk_index | INTEGER NOT NULL DEFAULT -1；write_chunk 时必须 >= 0，其余 kind 必须为 -1 |
| expected_size_bytes | 非负整数 |
| expected_sha256 | 小写 64 位十六进制 |
| state | pending、claimed、applied、failed_retryable、failed_terminal |
| attempt_count | 非负整数 |
| available_at | 下一次可处理时间 |
| claimed_by、claimed_until | lease；未领取时为空 |
| last_error_code | allowlist 代码；禁止 stderr、正文、Token、本机路径 |
| created_at、updated_at、applied_at | UTC ISO 时间 |
| resolved_at、resolution_code | 仅 integrity terminal 可由显式 repair 写入；resolution_code 为 VERIFIED_BYTES_RESTORED allowlist |

CHECK 约束固定为：kind=write_chunk 时 chunk_index >= 0；kind=assemble_file、delete_keys 或 verify_blob 时 chunk_index = -1。write/assemble/delete 的唯一性至少覆盖 attachment_ref + kind + storage_key + chunk_index，保证同一未完成意图重复提交只得到同一操作；禁止使用 NULL 表达“无分片”。`verify_blob` 另用 partial unique index：同一 attachment + storage_key 在 `resolved_at IS NULL` 时最多一个 incident；旧 incident resolve 后再次损坏必须创建新的 operation_ref/created_at，保留旧 incident不重开、不改写。migration RED 同时证明“未解决时复用同一 verify incident”和“resolve 后第二次损坏产生第二条审计 incident”。数据库只保存相对 key，AttachmentStorage 负责把 key 安全解析到已验证的 attachment root 内。

状态语义固定为：failed_retryable 仅用于可从已持久字节/意图重做的暂态 I/O，按 available_at 和有界 attempt_count 重试；达到上限或确定缺少恢复材料后转 failed_terminal。failed_terminal 永不自动重试。verify_blob terminal 由显式 repair 在恢复字节后重新核对 size+SHA，原子写 resolved_at + VERIFIED_BYTES_RESTORED；该 incident 保留审计历史。下载/健康只把 resolved_at IS NULL 的 integrity terminal 视为未解决。日后同一 blob 再损坏时创建下一条 incident；applied/已 resolved 历史永不反向改写。

V11 同时为 attachments 增加：

| 字段 | 约束与用途 |
|---|---|
| origin_device_ref | 新上传必填并引用 managed_devices；迁移旧行可为空 |
| client_upload_id | 8–128 字符 opaque ID；与 origin_device_ref 同空/同非空 |
| updated_at | UTC ISO、NOT NULL；迁移只按 attached_at、completed_at、created_at 依次回填，绝不把未来 expires_at 当成更新时间 |

唯一索引固定为 origin_device_ref + client_upload_id WHERE 两者非空。create、每次成功 recordChunk、complete、attach、cancel、expiry 和 recovery 状态修复都必须更新 updated_at；只读 status 不更新。迁移旧行保持两项来源字段为空，不反推错误设备。

V10 uploading fixture 必须把 expires_at 设在未来，并断言迁移后 updated_at=created_at 且 updated_at 不晚于 migration clock；ready/attached fixture 分别按 completed_at/attached_at 回填。

浏览器缓存版本也固定，不能让后续任务猜：当前基线 `DATABASE_VERSION=2`，store 为 `attachmentDrafts` 与 `outgoing`。C1 把版本升到 3，新增 `attachmentUploads`，`keyPath="uploadKey"`；`uploadKey=JSON.stringify([deviceRef, clientLocalUploadRef])`，两项都须是合法非空 opaque ref，另建非唯一 `threadRef` index。v2→v3 upgrade transaction 不删除/改名 `attachmentDrafts`、`outgoing` 或其他 store；升级中断由 IndexedDB 原子回滚，重开后可重试。memory cache 和 IndexedDB adapter 必须共享同一个 `uploadKeyFor()`，测试覆盖 delimiter 字符不会碰撞、升级中断、旧 store 内容逐字节保留。C1 的最小 create-replay 记录直接写该 store，C2 只扩充字段/行为、不再另造 store。

IndexedDB physical version只能前进。C1同PR建立独立只读恢复前端和sealed bundle，且从此release capability永远要求guard，即使后续物理版本不变。guard对HTML和所有assets发送deny-by-default响应头CSP：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'`，并加`X-Content-Type-Options: nosniff`与`Referrer-Policy: no-referrer`；不得只靠meta CSP。不注册Service Worker，不含fetch/XHR/WebSocket/EventSource/form。所有从IndexedDB读出的草稿/outbox/错误文本只用`textContent`/`createTextNode`渲染，禁止innerHTML、insertAdjacentHTML、动态style/src/href元素。现有database name仍由共享纯helper反算，opaque ref不可split。

恢复页先用 `indexedDB.databases()` 只读枚举，只考虑固定 prefix 的库；打开后从 `meta.context` 取 family/person/device 三元组，调用共享纯 helper 重新生成完整名字并与枚举名逐字节比较。它不展示/写出 refs，仅给每个本地身份一个本次页面内序号。不认识、重复、context 缺失/不一致或旧 unscoped `LEGACY_DATABASE_NAME` 一律隔离并只显示计数。

对每个候选库，用**不带 version 参数**的 `indexedDB.open(name)` 打开当前物理版本，`onupgradeneeded` 一律 abort。所有 transaction 固定 readonly，不调用 put/add/delete/clear/deleteDatabase。它只读取 allowlist store `drafts`、`attachmentDrafts`、`outgoing`、`attachmentUploads`，D1 后再加 `providerOutgoing`，在本地页面显示可复制草稿/恢复状态，不写报告、不自动 POST、不删除记录。浏览器不支持安全枚举时 fail-closed 显示说明，不创建新库；不得要求用户输入 family/person/device ref 去猜库名。

`build-member-rollback-recovery.mjs` 输出 sealed tar + 0600 manifest/旁置 hash，manifest 至少绑定 build Git SHA、assets hash、CSP hash、supportedClientDatabaseVersions=[2,3]、allowlisted stores、`networkMutations=false`、`databaseMutations=false` 和 guard 固定静态根 `/srv/recovery`。同一 C1 PR 建立专用 rollback guard image：最小静态 server 只注册 `/health`、`/member`/`/member/` 和 manifest allowlist 中的 `/member/<asset>`；health 明确返回 `service=family-ai-rollback-recovery`，所有 `/api/*`、`/admin/*`、其他路径和非 GET/HEAD 方法统一拒绝且不反代。镜像不 COPY Gateway/依赖，不挂 runtime/DB/附件/Provider，只能 non-root/read-only root 运行。build wrapper 复用 A4 的 exact Git SHA/OCI revision/config image ID/archive hash 语义。A5 只复制并封口 bundle+guard；E0 只负责把已存在的 guard 纳入正式 definition，F1 回滚时由 guard 服务，previous 业务 Gateway 保持停止。它只保证“previous server data/image restored offline + 浏览器草稿可读取且零自动副作用”，不冒充旧 Gateway 或完整交互前端。

C1的RED明确落在`memberCacheModel.test.ts`、`memberIdentityCache.test.ts`与`memberRollbackRecovery.test.ts`：覆盖V2→V3/abort/重开/opaque ref、previous VersionError、versionless readonly恢复。fixture额外写入`<img src=https://attacker.invalid/x>`、`<style>@import ...</style>`、`javascript:`链接与恶意错误文本，断言DOM只出现字面文本、无可执行节点；网络拦截器只允许初始同源`GET/HEAD /member`及sealed asset allowlist，任何外部URL、额外同源请求、API、readwrite transaction或onupgradeneeded立即失败。builder测试证明完整header CSP hash、无innerHTML/write helpers，并篡改asset/manifest/version range/static root时拒绝。

`test-rollback-recovery-image.sh` 用 mktemp/随机 loopback Compose 证明 guard 只有 bundle 一个 ro mount、无 backend network、无业务 env，`/health` 明确返回 rollback-recovery，assets CSP 正确，所有 API/Admin/mutation 均拒绝；容器 non-root/read-only/no-new-privileges/cap-drop-all，正式 8790 before/after identity 不变。测试篡改 guard archive/image ID/revision 或尝试加入 runtime mount时必须在启动前失败。

### C1.4 先写四个崩溃窗口 RED

新增 attachmentRecovery.test.ts，以可注入 failpoint 逐一模拟：

- [ ] chunk 临时文件已落盘，但 chunk DB 状态还未提交；
- [ ] assembled final file 已原子 rename，但 attachment 还未标 ready；
- [ ] attachment 已标 deleted 且 delete operation 已提交，但文件尚未 unlink；
- [ ] 数据库记录为 ready/attached，但 blob 缺失或 SHA-256 不符。

每个场景都必须先失败，并断言重启后唯一允许结果：

- 有 journal 且字节匹配：安全补交 DB 状态并把 operation 标为 applied；
- 有 journal 但字节缺失：可重做则进入 failed_retryable；不可重做或达到上限则进入 failed_terminal；
- deleted：重复删除文件后 applied，ENOENT 视为幂等成功；
- ready/attached blob 在原 operation 尚未 applied 前缺失：原 operation 按可恢复性进入 failed_retryable 或 failed_terminal；
- 已 applied 后才发现 ready/attached blob 缺失/hash 不符：不得篡改历史 operation；在同一事务创建/复用唯一 verify_blob + failed_terminal integrity operation，下载返回稳定的 ATTACHMENT_REPAIR_REQUIRED，HTTP 503；
- 没有 journal 的未知文件：移入 attachment root 内的 quarantine 子目录并记录无敏感信息的计数，不自动删除。

重复运行 recovery 两次必须没有额外业务变化。恢复结束运行 PRAGMA quick_check 和 foreign_key_check。

repair RED 必须证明：未恢复/错误 hash 不得 resolve；恢复精确字节后显式 repair 把唯一 verify_blob operation 标 resolved、degraded count 归零且下载恢复；重复 repair 幂等，不删除 operation 或改写原 error/timestamps。

### C1.5 最小接口与事务次序

新增 AttachmentService，Route 只做协议解析、身份授权入口和错误映射：

    interface AttachmentService {
      createUpload(input, actor): AttachmentUpload;
      getUploadStatus(input, actor): AttachmentUploadStatus;
      writeChunk(input, actor): AttachmentChunkResult;
      completeUpload(input, actor): AttachmentCompleteResult;
      openDownload(input, actor): AttachmentDownload;
      cancelUpload(input, actor): void;
    }

GET /api/v1/attachments/uploads/:attachmentRef/status 的公开响应固定为：

    {
      attachmentRef,
      state: "uploading" | "ready" | "attached" | "expired" | "deleted",
      chunkBytes,
      chunkCount,
      receivedChunkIndexes,
      sizeBytes,
      updatedAt
    }

receivedChunkIndexes 必须升序、去重，只来自已提交的 chunk 行；updatedAt 只来自 attachments.updated_at；响应不得包含 storage_key、路径、临时文件名或 expected hash。新 V11 上传必须同时匹配当前 personal Entry Session 的 device、family、owner person 与 attachmentRef；迁移旧行没有 origin_device_ref，只保留此前 owner-person 访问语义，不能用于 clientUploadId create replay。越权与不存在统一返回既有 not-found envelope。接口不伪造尚未建模的 thread/agent 归属；若 state 已为 attached/expired/deleted，只返回该终态且 receivedChunkIndexes=[]，不得让客户端继续写入。

create request 在 C1 新增 clientUploadId。Member Web 必须在发起 create 前生成并最小持久化它；服务端新建时返回 201 + replayed=false，同 device + clientUploadId + 完全相同的 fileName/mediaType/sizeBytes 重放时返回原 attachmentRef、200 + replayed=true，不再次预留配额；同 ID 不同指纹返回 409 ATTACHMENT_UPLOAD_CONFLICT。这样 create 的 201 丢失后可以安全重试。C1 的客户端改动只保证当前页面/刷新后能重放 create，不实现分片自动续传 UI；完整状态机留给 C2。

新增 AttachmentRecoveryService：

    interface AttachmentRecoveryService {
      reconcileStartup(options: { workerRef: string; now: Date }): RecoverySummary;
      recoverOne(operationRef: string): RecoveryResult;
      resolveIntegrityFault(operationRef: string, actor: LocalRepairActor): RepairResult;
    }

公开 HTTP 不新增一个会让普通管理员获得私人附件内容的 repair route。C1 固定提供“只读取证→用户批准 fingerprint→精确停服→repair”的本机 operator 流程。只读取证接口为：

    node scripts/attachment-integrity-repair-inspect.mjs --database <absolute-sqlite> --attachment-root <absolute-dir> --operation-ref <uuid> --controller-definition <absolute-file-or-dir> --output <absolute-new-0600-json>

inspect 不读/复制 blob 正文，只绑定 canonical path/device/inode、controller identity、unresolved incident ref/state/expected size+hash、当前 blob size/hash 或 missing、Schema 与时间，输出旁置 SHA-256；公开给用户的摘要只含 incident fingerprint、missing/mismatch 类别、停机范围和回滚说明。用户明确批准该 fingerprint 后，才停止 exact Gateway owner并用 A5 capture `scope=formal-production + phase=attachment-integrity-repair + expected-preflight=inspect hash` evidence。repair CLI 固定为：

    node scripts/attachment-integrity-repair.mjs --preflight <absolute-0600-json> --expected-preflight-sha256 <64-hex> --database <absolute-sqlite> --attachment-root <absolute-dir> --operation-ref <uuid> --stop-evidence <absolute-0600-json> --expected-stop-evidence-sha256 <64-hex> --approval-ref <opaque-nonsecret-ref> --report <absolute-new-0600-json>

CLI 只允许数据库/附件 owner 在 Gateway 精确 stopped、evidence 为上述 scope/phase、入场未过期且路径/incident 与 preflight 完全一致时运行；它不接收替换字节、不读取或输出附件正文。操作者须在 CLI 外按已批准 incident 恢复字节，再运行 CLI。`LocalRepairActor` 固定为 `{kind:"local-operator", approvalRefHash, preflightSha256, stopEvidenceSha256}`；Service 重新计算 size+SHA，匹配才在一个事务 resolve 当前未解决 incident，并写只含 actor hash/action/result/time 的审计，不记录 attachmentRef、文件名、路径、字节或 hash。wrong operation、旧/错误 fingerprint、已过期/错误 owner evidence、非 terminal incident、错误字节和跨 runtime 路径全部 fail-closed；重复同一 repair 幂等。`test-attachment-integrity-repair.sh` 使用 mktemp fixture，覆盖只读 inspect、错误 fingerprint、授权、审计、重复损坏生成新 incident 和零敏感输出。

必须遵守以下次序：

1. write chunk：事务写 pending operation；在同一 attachment 的串行锁内写临时文件、fsync、rename；事务登记 chunk 并标 operation applied。
2. assemble：事务写 pending operation；校验全部 chunk 与总 hash；写临时 final、fsync、rename；事务把 attachment 标 ready 并标 operation applied。
3. cancel/expiry：事务把 attachment 标 deleted 并写 delete operation；事务提交后 unlink；ENOENT 幂等；成功后 applied。
4. open download：授权后同时检查 attachment 状态、未解决 failed_retryable/failed_terminal operation 和真实 blob hash；缺失时原子登记/复用 verify_blob integrity operation 并返回 ATTACHMENT_REPAIR_REQUIRED。

禁止 Route 自行协调 DB/FS；禁止在没有 journal 的情况下删除未知文件。

### C1.6 启动、关闭与运行级验收

- [ ] Gateway 开始监听前执行一次有界 reconcileStartup。Schema/journal 损坏、数据库完整性失败、attachment root 不可安全解析或不可访问、以及在预算内无法完成到安全 checkpoint 的全局扫描属于 fatal_storage：fail-closed，不对外报 healthy。
- [ ] 单个 ready/attached blob 缺失或 hash 不符属于 degraded_attachment：隔离到该 attachment，保留 failed operation，让该附件下载返回 ATTACHMENT_REPAIR_REQUIRED/503；不得因此阻断其他家庭、会话、消息和健康端点启动。健康摘要只增加 allowlist 的 degradedAttachmentCount 和公开错误类别，不含 attachmentRef、文件名、路径或 hash。
- [ ] recovery 测试分别证明 fatal_storage 会阻断监听，而一个和多个 degraded_attachment 会正常启动、只影响目标附件；修复字节后必须通过受授权的显式 repair 验证并 resolve，重复 reconcile/repair 后计数稳定为 0。
- [ ] 后台只重试 failed_retryable 且有 journal 恢复材料的操作，并使用 lease；attempt 上限后转 terminal。verify_blob/failed_terminal 永不自动重试；shutdown 停止领取新任务并等待当前原子步骤。
- [ ] 健康摘要只暴露计数和错误代码，不泄露附件名、路径或正文。
- [ ] 使用 A2 的隔离 Compose project：上传多分片附件，容器重启，下载并校验 SHA-256；根文件系统仍 read-only，进程仍非 root。

验证命令：

    npm exec --workspace @family-ai/contracts -- vitest run test/chatWork.test.ts
    npm exec --workspace @family-ai/gateway -- vitest run test/attachmentMigration.test.ts test/attachmentRepository.test.ts test/attachmentStorage.test.ts test/attachmentRoutes.test.ts test/attachmentRecovery.test.ts test/memberCacheModel.test.ts test/memberIdentityCache.test.ts test/memberRollbackRecovery.test.ts --maxWorkers=1 --no-file-parallelism
    bash scripts/test-runtime-candidate-stage.sh --fixture v10-v11
    npm run check
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-rollback-recovery-image.sh --source-commit "$(git rev-parse HEAD)" --gateway-image-manifest <output>/gateway-image-manifest.json
    bash scripts/test-attachment-integrity-repair.sh
    bash scripts/acceptance-container-attachments.sh --image-manifest <output>/gateway-image-manifest.json --host-port 0 --runtime-root <absolute-mktemp-dir> --project-name <safe-unique>
    bash scripts/static-check.sh
    git diff --check

C1 在 A4 之后只能消费上述 wrapper 的 manifest/config image ID；rollback guard、附件 smoke 与隔离 dev-up/acceptance必须逐项核对同一source commit/receipt。若维护者额外保留裸`docker compose build`，只能标为`local-unverified`且产物不得被任何wrapper/tag消费，并用fixture断言下游参数来自manifest。

### C1.7 文档与回滚

- [ ] 开发记录写明 V10 fixture、V11 migration、四个 kill point、容器重启和字节 hash 证据。
- [ ] 更新 Gateway README 的附件事务边界；设计文档记录状态机和 ATTACHMENT_REPAIR_REQUIRED。
- [ ] 不改端口台账；没有实际 Hermes 架构变化时不改 agent-architecture。
- [ ] 回滚先停止新二进制，用 A5 整体恢复 V10 SQLite、附件、镜像和配置并保持 previous Gateway stopped；由于浏览器 V3 不能降级，只启动本 PR 已验收的独立 guard Compose 来服务 sealed recovery client，直到 forward fix。E0 后续把同一 guard 纳入正式 definition set。禁止只降 Schema、只切旧镜像、启动不认识维护开关的 previous Gateway，或让 previous V2 JS 直接打开 V3。

**完成判据：** V10→V11 副本迁移与服务器数据整体恢复都通过；四个崩溃窗口收敛到唯一稳定状态；Route 不再持有 DB/FS 事务流程；隔离容器重启后附件仍可下载；V2→V3 后恢复 previous runtime 时 previous Gateway 保持停止，独立 guard 只读恢复草稿且证明零业务 mount、零 network、零 IndexedDB 写入。

## 2. Task C2：附件失败、暂停与精确续传 UI

**建议分支：** codex/member-attachment-resume-ui

**依赖：** C1 已合入。只恢复附件上传，不自动重发聊天消息。

**修改文件：**

- package.json
- package-lock.json
- playwright.config.ts
- 新增 browser/attachment-resume.spec.ts
- 新增 browser/rollback-client-recovery.spec.ts
- 新增 scripts/install-browser-runner.sh
- 新增 scripts/sanitize-browser-report.mjs
- 新增 compose.browser-smoke.yaml
- .gitignore
- scripts/static-check.sh
- apps/gateway/member-public/cache.js
- apps/gateway/member-public/attachments.js
- apps/gateway/member-public/api.js
- apps/gateway/member-public/product.js
- apps/gateway/member-public/render.js
- apps/gateway/member-public/index.html
- apps/gateway/member-public/member.css
- apps/gateway/test/memberAttachments.test.ts
- apps/gateway/test/memberCacheModel.test.ts
- apps/gateway/test/memberProductWorkbenchLifecycle.test.ts
- apps/gateway/test/memberRenderLifecycle.test.ts
- apps/gateway/test/restartJourney.test.ts
- apps/gateway/test/memberRollbackRecovery.test.ts
- 新增 scripts/browser-attachment-resume-smoke.sh
- 新增 scripts/test-browser-attachment-resume-smoke.sh
- 新增 scripts/browser-rollback-client-recovery-smoke.sh
- 新增 scripts/test-browser-rollback-client-recovery-smoke.sh
- scripts/gateway-release-capabilities.json（client仍V3，但更新capabilitySetId）
- scripts/test-runtime-backup-restore.sh（same-version required asset fixture）
- `docs/superpowers/specs/2026-08-13-attachment-recovery-journal-design.md`、Gateway README、本计划、总计划和开发记录

### C2.1 固定本地恢复记录

IndexedDB 继续使用 C1/V3 已建立的 `attachmentUploads` store；不再升级版本或替换 keyPath。主键字段 `uploadKey=JSON.stringify([deviceRef, clientLocalUploadRef])`，并同时保存两项原字段用于读取后复核。clientLocalUploadRef 在选择文件后、本地 hashing 前生成，attachmentRef 在 create 成功或重放前允许为空：

| 字段 | 说明 |
|---|---|
| uploadKey、deviceRef、clientLocalUploadRef | 本地稳定主键及其可复核组成；hashing/create 前即可存在 |
| clientUploadId、attachmentRef | clientUploadId 用于 create 幂等；attachmentRef nullable，201/重放后填写 |
| agentRef、threadRef | UI 恢复目标；切换目标时不得误发 |
| fileName、declaredMediaType、sizeBytes、sha256 | 文件指纹 |
| chunkBytes、chunkCount、receivedChunkIndexes | 精确续传；沿用现有公开字段名 |
| blob | 浏览器允许持久化时保存；不能保存时为空 |
| state | hashing、uploading、paused_offline、retryable_failed、terminal_failed、ready |
| attemptCount、lastErrorCode、createdAt、updatedAt | 恢复与可观测字段 |

禁止保存 Entry Token、Cookie、Authorization、Provider prompt、本机绝对路径。lastErrorCode 只能来自公开 allowlist。

### C2.2 RED 场景

- [ ] 三分片上传到第二片后断网；刷新时先查询服务端 receivedChunkIndexes，只发送缺失的第三片。
- [ ] create 已提交但 201 丢失：刷新后用原 clientUploadId 重放得到同一 attachmentRef，不重复预留配额。
- [ ] HTTP 成功响应丢失但服务端已收第二片；恢复后不得重复计入配额或重新创建 attachmentRef。
- [ ] complete 已提交但成功响应丢失：刷新查询 status=ready/attached 后直接收敛本地 ready，不重复 assemble、不再次占用配额；attached 时不得把附件退回上传态。
- [ ] IndexedDB 有 Blob 时刷新自动续传；无 Blob 时 UI 要求重新选择文件。
- [ ] 重选文件只有 sizeBytes 与 sha256 都相等才复用 attachmentRef；不匹配时 terminal_failed，禁止拼接。
- [ ] 一个附件失败时，正文、其他附件和 composer focus 均保留；取消只取消目标附件。
- [ ] ready 后清除 Blob 和分片恢复材料，只保留显示所需元数据。
- [ ] 每个状态具有可访问名称、进度、暂停/重试/取消按钮；键盘可操作，错误不只靠颜色表达。
- [ ] 真实 V2 浏览器 fixture 先由 candidate 升到 V3并保留草稿/上传记录，再恢复 previous runtime 但保持业务 Gateway stopped、启动独立 guard + sealed rollback client；恢复页逐项读回原值，network/数据库写计数均为 0，且直接加载 previous V2 JS 的 VersionError 负例被测试证明不能作为回滚方案。

先运行以下测试并观察新断言失败：

    npm exec --workspace @family-ai/gateway -- vitest run test/memberAttachments.test.ts test/memberCacheModel.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberRenderLifecycle.test.ts --maxWorkers=1 --no-file-parallelism

### C2.3 最小实现与浏览器验收

C2 是第一个需要真实浏览器的行为任务，因此在本 PR 建立后续 D2/E1 复用的 runner，而不是依赖尚未发生的 E1：实施时查官方兼容矩阵，`package.json` 固定 exact `@playwright/test` devDependency，lockfile固定 Chromium revision；`install-browser-runner.sh --browser chromium` 只安装 lockfile 对应版本并打印公开版本，不用 `latest`。`playwright.config.ts` 默认禁止 trace/video/HAR，输出只进 Git ignored `0700` runtime；`sanitize-browser-report.mjs` 只放行计数、公开错误码、image ID、浏览器版本与正式 8790 before/after hash。C2 同时新增并执行 `browser/attachment-resume.spec.ts` 与 `browser/rollback-client-recovery.spec.ts`；D2/E1 后续只增 spec/CI，不重新选择 runner。CI 或本地若 Chromium revision 未安装，preflight 明确失败，不能把依赖错误冒充产品 RED。

C2不升server Schema或IndexedDB物理版本，但它是新的release/client capability：把`capabilitySetId`更新为`attachment-resume-v1`，schemaHead/clientDatabaseVersion仍为11/3，rollbackClientRequired仍true；从C2 exact source commit重建bundle/guard并运行A5 same-version required fixture。不得用C1的旧capabilitySetId或“版本没变”跳过资产重建。

- [ ] api.js 提供 getUploadStatus、putMissingChunk、completeUpload；请求 AbortSignal 只属于当前 attachment attempt。
- [ ] getUploadStatus 返回 ready/attached 时跳过 complete；只有 uploading 且 receivedChunkIndexes 数量等于 chunkCount 时才允许调用一次幂等 complete。
- [ ] attachments.js 只根据服务端 receivedChunkIndexes 计算缺片，不相信本地“已发送”标记。
- [ ] product.js 在 lifecycle generation 变化时停止旧任务，但不删除可恢复记录。
- [ ] render.js 显示明确状态和操作；同一 attachmentRef 只允许一个续传任务。
- [ ] 模拟离线、刷新、恢复网络；最终数据库只有一个 attachment，服务端只接收缺失分片，下载 SHA-256 与原文件一致。
- [ ] 桌面与移动视口无 console error、page error、横向溢出；Enter、Shift+Enter、IME 与 composer 焦点行为不回归。

验证命令：

    npm exec --workspace @family-ai/gateway -- vitest run test/memberAttachments.test.ts test/memberCacheModel.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberRenderLifecycle.test.ts test/restartJourney.test.ts --maxWorkers=1 --no-file-parallelism
    npm run check
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-browser-attachment-resume-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/test-browser-rollback-client-recovery-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/static-check.sh
    git diff --check

browser-attachment-resume-smoke.sh 固定接口：

    bash scripts/browser-attachment-resume-smoke.sh --image-ref <immutable-id> --runtime-dir <absolute-mktemp-dir> --report-dir <absolute-new-dir> --project-name <safe-unique-name> --host-port 0

脚本只允许空的 mktemp runtime、随机 127.0.0.1 端口和本轮唯一 Compose project；开始/结束都核对正式 8790 listener identity 未变化。trap 只清理本轮资源；报告使用 allowlist，不得包含 Blob、文件名、Token、Cookie、请求正文或绝对路径。

两个 `test-browser-*.sh` 是可复制的本地/CI消费wrapper：都强制接收调用方预先生成/下载的 `--image-manifest`，校验相邻archive/SHA、exact source commit、config image ID/archive hash与OCI revision，禁止内部调用A4 builder。rollback wrapper再调用 `build-member-rollback-recovery.mjs` 与 `build-rollback-recovery-image.sh` 并核对同一 commit 的 sealed manifest/guard image ID/archive/revision；两者都调用 `install-browser-runner.sh --browser chromium`，创建各自 new mktemp runtime/report/project，再将固定参数传给对应 smoke。attachment wrapper只运行`browser/attachment-resume.spec.ts`，rollback wrapper只运行`browser/rollback-client-recovery.spec.ts`，两者都经sanitizer输出报告。任何SHA/ID/bundle/guard/Chromium revision不匹配时在启动前失败；缺`--image-manifest`必须在创建资源前usage fail，验证命令不得直接裸跑需要参数的smoke。

**回滚：** C2 只回滚 UI/runner 与 V3 store 的字段使用，不回滚服务端 V11，也不降 IndexedDB 版本或删除 C1 已建 store。旧页面回退前先证明会忽略新增字段；任何 store 删除都必须另立显式、可测试的版本升级，不能清空其他本地缓存。

**完成判据：** 真实浏览器 attachment spec 在断网和刷新后只续传缺片，文件无法恢复时安全要求重选，单附件失败不破坏正文和其他附件；rollback-client-recovery spec 同时证明 V2→V3 后 previous 原生 JS 会安全失败，而 guard + sealed recovery client 能逐项只读恢复且 network/readwrite transaction 均为 0。

## 3. Task D1：V12 持久 Provider Operation 与 lane worker

**建议分支：** codex/durable-provider-operations-v12

**依赖：** A5、B1b、B2、C1、C2 已合入。C2 提供已锁定的 browser runner 与 IndexedDB V3；开始写 migration 前，独立设计必须经维护者批准。

**设计批准 Gate：** 设计至少明确 HTTP 202 契约、状态机、V12 表结构、旧 pending 行迁移、lane 顺序、lease、CLI indeterminate 规则、公开事件、关闭语义和整体回滚。未批准时本任务保持阻断，不得先提交空壳 Repository 或无人调用的 worker。

**修改文件：**

- packages/contracts/src/chatWork.ts
- packages/contracts/src/sync.ts
- packages/contracts/test/chatWork.test.ts
- packages/contracts/test/sync.test.ts
- packages/provider-adapter-sdk/src/index.ts
- packages/provider-adapter-sdk/src/providerRouter.ts
- packages/provider-adapter-sdk/src/codexCliProvider.ts
- packages/provider-adapter-sdk/src/hermesCliProvider.ts
- packages/provider-adapter-sdk/test/fakeProvider.test.ts
- packages/provider-adapter-sdk/test/providerRouter.test.ts
- packages/provider-adapter-sdk/test/codexCliProvider.test.ts
- packages/provider-adapter-sdk/test/hermesCliProvider.test.ts
- apps/gateway/src/database.ts
- apps/gateway/src/chatWorkDomain.ts
- apps/gateway/src/chatWorkProvider.ts
- apps/gateway/src/chatWorkMessageService.ts
- apps/gateway/src/chatWorkRoutes.ts
- apps/gateway/src/domainEventCore.ts
- apps/gateway/member-public/api.js
- apps/gateway/member-public/thread.js
- apps/gateway/member-public/cache.js
- apps/gateway/member-public/sync.js
- apps/gateway/member-public/render.js
- apps/gateway/member-rollback-public/recovery.js
- scripts/build-member-rollback-recovery.mjs
- 新增 apps/gateway/src/providerOperationService.ts
- 新增 apps/gateway/src/providerOperationWorker.ts
- apps/gateway/src/app.ts
- apps/gateway/src/index.ts
- apps/gateway/test/database.test.ts
- apps/gateway/test/chatWorkDomain.test.ts
- apps/gateway/test/chatWorkDomainSecurity.test.ts
- apps/gateway/test/chatWorkProvider.test.ts
- apps/gateway/test/chatWorkProviderRoutes.test.ts
- apps/gateway/test/chatWorkEvents.test.ts
- 新增 apps/gateway/test/providerOperationWorker.test.ts
- apps/gateway/test/eventStreamLive.test.ts
- apps/gateway/test/restartJourney.test.ts
- apps/gateway/test/memberCacheModel.test.ts
- apps/gateway/test/memberPersistenceReview.test.ts
- apps/gateway/test/memberProductWorkbenchLifecycle.test.ts
- apps/gateway/test/memberThreadModel.test.ts
- apps/gateway/test/memberRollbackRecovery.test.ts
- browser/rollback-client-recovery.spec.ts
- scripts/gateway-schema-capabilities.json
- scripts/gateway-release-capabilities.json
- scripts/gateway-schema-capabilities.mjs（如durable-v1映射需扩展）
- scripts/test-runtime-backup-restore.sh（新增 V12 compatibility fixture）
- scripts/test-runtime-candidate-stage.sh（新增V11→V12 fixture）
- 新增 scripts/provider-operation-restart-smoke.sh
- 新增 scripts/test-provider-operation-restart-smoke.sh
- scripts/browser-rollback-client-recovery-smoke.sh
- scripts/test-browser-rollback-client-recovery-smoke.sh
- 新增 `docs/superpowers/specs/2026-08-13-durable-provider-operations-design.md`
- `docs/superpowers/specs/2026-07-23-gateway-chat-work-provider-turns-design.md` 和对应 plan 的 supersede 标记
- Gateway README、本计划、总计划和开发记录

### D1.1 固定状态机与公开契约

thread_provider_turns 从同步 turn 升级为 durable operation aggregate，状态严格为：

    queued  -> claimed -> running -> succeeded
       |         |          |   \-> failed_retryable -> queued
       |         |          |   \-> failed_terminal
       |         |          |   \-> indeterminate
       |         \-> queued（lease过期且未invoking）
       |         \-> cancelled（CAS证明未invoking）
       \-> cancelled

- claimed 表示取得 lease 但尚未产生外部副作用；lease 过期可回 queued。
- running 表示 invocation attempt 已持久化且可能发生外部副作用。
- indeterminate 只能由显式人工决策或 Adapter 能力化查询解决；不得自动回 queued。
- cancelled 只允许在 queued/claimed 且确认未调用 Provider 时进入。
- lane head 为 queued、claimed、running、failed_retryable 或 indeterminate 时，后续 lane_sequence 全部阻塞。succeeded、failed_terminal、cancelled 才允许下一项 claim。indeterminate 默认阻塞以保护 external session/context 顺序；只有未来经审计的人工处置把它变成 terminal outcome 后才放行。
- `POST /api/v1/provider-operations/:operationRef/cancel` 复用完整 device/member/agent/thread 授权；Service 只在 queued，或 claimed 且对应 attempt 尚未进入 invoking 时 CAS 为 cancelled。running/failed/indeterminate/terminal 返回 409 OPERATION_NOT_CANCELLABLE。取消不删除 Person Message、不回收已 attached 附件。
- RED 必须让 cancel 与 `claimed→running/attempt=invoking` 使用同一事务CAS竞争：cancel赢则永远不进入running/不调用Provider；worker赢则cancel稳定409。状态图和实现都禁止running→cancelled。

POST 现有消息路由在同一事务提交后返回 202：

    {
      protocolVersion: 1,
      message: <existing person message>,
      operation: {
        operationRef: <opaque UUID>,
        state: queued,
        stateVersion: 1,
        attemptNo: 0,
        acceptedAt: <UTC ISO>
      }
    }

新增 GET /api/v1/provider-operations/:operationRef，复用 member + agent + thread + device 授权。`PublicProviderOperation` 固定公开 operationRef、state、stateVersion、attemptNo、assistantMessageRef、publicErrorCode、retryable、timestamps；stateVersion 是每个 operation 从 1 开始、每次 durable 状态/attempt 变化都在同一事务递增的单调整数，attemptNo 是当前或最后一次 attempt 序号。GET、lookup、SSE 必须返回同一对值，updatedAt 只用于显示、不得参与去旧。任何未授权请求统一按既有 not-found 边界处理，不能暴露 operation 是否存在。

为“服务端已经接受，但 202 响应在网络中丢失”新增只读查询语义的 POST /api/v1/provider-operations/lookup。当前浏览器只生成 clientMessageId，现有 Provider idempotencyKey 又由服务端 messageRef 派生，因此 D1 不得要求浏览器提供它不知道的 key/hash。lookup 请求体固定为：

    {
      threadRef,
      clientMessageId
    }

deviceRef、member、entry audience 和 Agent 绑定只能取自当前认证上下文，不能由请求体覆盖。Gateway 用认证上下文 + threadRef + clientMessageId 查找 Person Message，再从已存 message origin、thread/agent 绑定和 operation/idempotency 记录验证完整范围；客户端不参与重算服务端 normalized_request_hash。仅当 device + member + thread + agent + clientMessageId 全部匹配时返回同一个 PublicProviderOperation；从未 accepted、字段不匹配、跨设备、跨 Agent、跨 thread 与无权访问都统一返回 404 / PROVIDER_OPERATION_NOT_FOUND。lookup 不创建消息、operation 或幂等记录，不改变 attempt/state，也不调用 Provider。

D1必须包含Member Web最小兼容：202后持久化operationRef并观察，不再立即删除outgoing。当前旧同步route真实返回`201`；contracts/browser特征测试必须证明任何非202（特别是旧201）被明确拒绝或仅经有期限的一次性兼容分支处理。202 response继续包含strict contract的`protocolVersion`，不能因新增operation漏掉。

#### D1.1.1 Adapter 恢复能力必须是可调用 API

先在contracts与SDK各写目标断言并分别观察RED，不能只等`npm run check`：

    npm exec --workspace @family-ai/contracts -- vitest run test/chatWork.test.ts test/sync.test.ts
    npm exec --workspace @family-ai/provider-adapter-sdk -- vitest run test/fakeProvider.test.ts test/providerRouter.test.ts test/codexCliProvider.test.ts test/hermesCliProvider.test.ts --maxWorkers=1 --no-file-parallelism

预期RED分别是202+protocolVersion/operation event契约缺失，以及Adapter recovery API/capability行为缺失；类型编译错误、错误fixture或Hermes运行时缺失不能充当RED。

`none | queryable | idempotent_replay` 不能只是数据库字符串。`packages/provider-adapter-sdk/src/index.ts` 必须固定并导出下列类型（精确命名可在 D1 设计审查时调整，语义不可弱化）：

```ts
type ProviderRecoveryCapability = "none" | "queryable" | "idempotent_replay";

interface ProviderInvocationQuery {
  invocationRef: string;
  correlationRef: string;
  idempotencyKey: string;
  providerProfileRef: string;
  externalSessionRef?: string;
}

type ProviderInvocationQueryResult =
  | { state: "completed"; result: ProviderInvocationResult }
  | { state: "not_started" }
  | { state: "in_flight" }
  | { state: "unknown" };

interface ProviderAdapter {
  readonly recoveryCapability: ProviderRecoveryCapability;
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
  queryInvocation?(query: ProviderInvocationQuery): Promise<ProviderInvocationQueryResult>;
  health(): Promise<AdapterHealth>;
}
```

- [ ] `ProviderAdapterRouter` 返回的实例必须同时暴露 capability；Gateway 在创建 attempt 事务时从已解析 Adapter 读取并持久它，禁止从客户端、请求体或一个独立配置字符串伪造能力。
- [ ] capability=`queryable` 时 `queryInvocation` 必须存在，否则组装阶段 fail-closed。崩溃恢复只查询原 invocation/correlation/idempotency/profile：`completed` 经全部 ID/Session 绑定验证后提交，`not_started` 才可关闭旧 attempt 并把 operation 回 queued，`in_flight` 只做有界查询不 invoke，超时或 `unknown` 转 indeterminate。
- [ ] capability=`idempotent_replay` 只在 Adapter 明确承诺外部系统对该 idempotencyKey 幂等时允许；恢复调用必须使用完全相同的 invocationRef/correlationRef/idempotencyKey/规范化请求，不创建第二个 key。
- [ ] 现有 Hermes/Codex CLI Adapter 固定报 `none`，因为 CLI 当前无可验证查询/外部幂等契约；不得因为“可 resume Session”就声称 queryable/idempotent。
- [ ] `FakeProviderAdapter` 支持三种能力的显式故障注入：query 返回四种结果，idempotent replay 对原 key 返回原结果且外部计数不增，none 证明零 query/零重调。SDK 和 Gateway worker 测试分别覆盖类型组装与崩溃状态机。

### D1.2 V12 数据模型

重建 thread_provider_turns，至少包含：

| 字段 | 约束 |
|---|---|
| operation_ref | UUID 唯一，对外 opaque ref |
| user_message_ref、thread_ref、client_message_id | 业务归属；user_message_ref 仍唯一；client_message_id 用于丢失 202 后的精确对账 |
| device_ref、person_ref、entry_audience | 授权与幂等范围 |
| assignment_ref、agent_ref、provider_profile_ref | 路由快照；禁止跨 Agent/Profile 复用 session |
| idempotency_key、normalized_request_hash | UNIQUE 只覆盖授权 scope + idempotency_key（以及 client_message_id 的既定唯一范围）；hash 是命中后比较值，不得进入 UNIQUE 让同 key/不同 hash 创建第二行 |
| lane_sequence、context_cutoff_sequence | thread 内严格递增；thread_ref + lane_sequence 唯一；cutoff 在接受时固定等于该 Person Message 的 thread_sequence，后续不能扩大 |
| request_attachment_set_hash | 对按 attachment_ref 排序的 opaque ref + immutable size/content hash 做 canonical SHA-256；不存文件名、路径或字节 |
| state | 上述八态 |
| state_version | 从 1 开始；每次 durable state/attempt 可见变化同事务 +1，作为公开快照去旧权威 |
| attempt_count、available_at | 重试控制 |
| lease_owner、lease_until | claimed/running 的 lease |
| assistant_message_ref | succeeded 时唯一且必填 |
| public_error_code | allowlist；禁止 provider stderr |
| requested_at、started_at、completed_at、updated_at | UTC ISO |

新增 provider_invocation_attempts：

| 字段 | 约束 |
|---|---|
| invocation_ref | UUID 主键 |
| operation_ref、attempt_no | 外键和唯一组合 |
| correlation_ref | 唯一 |
| state | created、invoking、completed、failed、indeterminate |
| capability | none、queryable、idempotent_replay |
| external_session_ref | 只能与当前 Agent/Profile context 匹配 |
| context_cutoff_sequence、invocation_request_hash | attempt 创建时固化；hash 覆盖 exact ordered context refs/content hashes、attachment set、Agent/Profile、external session、correlation/idempotency key 和 Provider request 公开结构 |
| started_at、completed_at、updated_at | UTC ISO |
| public_error_code | allowlist |

不保存 prompt、消息正文副本、附件绝对路径、Token、Cookie 或 stderr。Worker 每次从已授权业务表重建请求，但只允许读取 `thread_sequence <= context_cutoff_sequence` 的消息；同 thread 后续已经落库的 Person Message 绝不能进入较早 lane 的 prompt。attachment refs/content hashes、Agent/Profile 和 external session 都取 operation/attempt 快照，不取“当前最新”路由。invoking 前在同一事务写入 attempt 的 invocation_request_hash；query/replay/崩溃恢复前重新构建并 constant-time 比较，任何 context、attachment、route 或 Session 漂移都转 indeterminate，零 spawn/零 query/零 replay。`normalized_request_hash` 只用于客户端幂等输入比较，不可替代 invocation_request_hash。

浏览器缓存随D1由V3升V4，新建compound `providerOutgoing`，不改旧V2 `outgoing` keyPath。legacy映射规则不变。测试必须区分：V2旧store物理上不能同时保存同clientMessageId的两条row，因此V2 fixture不伪造该场景；“同client ID不同thread不碰撞”只在新V4 store测试。另覆盖V2→V4、V3→V4、映射/隔离、升级中断和其他store保留。

D1 同步升级 C1 的 sealed rollback recovery client：supportedClientDatabaseVersions 扩为 [2,3,4]，allowlist 增加 `providerOutgoing`；仍用无 version 的只读 open、零网络、零数据库写。`memberPersistenceReview`、`memberProductWorkbenchLifecycle`、`memberThreadModel` 必须各自新增 202 receipt/刷新观察/不自动 POST 的特征测试；`memberRollbackRecovery` 与 Playwright spec 必须证明 candidate 从真实 V2/V3 升 V4 后，previous runtime 离线恢复且业务 Gateway stopped、独立 guard + rollback bundle 可逐字节读回普通草稿、附件恢复记录和 provider outbox，且不会 claim、lookup、POST 或删行。直接用 previous V2/V3 JS 打开 V4 的 VersionError 是必须保留的负例，不得用 catch 后清库“修复”。

V9/V10/V11 旧 thread_provider_turns 迁移规则固定为：

- succeeded → succeeded，保留 assistant_message_ref；
- failed → failed_terminal，保留经 allowlist 映射的公开错误；
- pending → indeterminate，因为迁移时无法证明旧进程是否已经调用 Provider；
- lane_sequence 固定取关联 Person Message 的 thread_sequence；同 thread 多行即使 requested_at 相同，也必须按 thread_sequence 保持原消息顺序。message 缺失、不是 Person、thread 不一致或 sequence 重复则 migration fail-closed；
- context_cutoff_sequence 同样取关联 Person Message 的 thread_sequence；request_attachment_set_hash 从该 message 已绑定附件的 opaque ref/immutable hash 确定性生成，关联缺失或字节元数据不一致则 fail-closed；state_version 初始为 1；
- 旧 invocation_ref 作为 attempt 1 写入 provider_invocation_attempts，capability 一律为 none：旧 succeeded→attempt completed；旧 failed→attempt failed；旧 pending→attempt indeterminate；
- 旧 terminal/indeterminate attempt 无法证明当时完整 prompt 时，invocation_request_hash 允许为 NULL 并标 `legacy_unverifiable=1`，只能保留结果/人工处置，绝不能 query/replay；V12 新建 attempt 在进入 invoking 前必须非空且 `legacy_unverifiable=0`；
- attempt started_at 取旧 requested_at；succeeded/failed 的 completed_at 取旧 completed_at，pending 为 NULL；updated_at 取 COALESCE(completed_at, requested_at)。operation requested_at/started_at/completed_at/updated_at 使用同一确定映射；
- 缺失的新授权字段从关联 message origin、thread、assignment 中确定性回填，任何关联不唯一则 migration fail-closed。

### D1.3 先写 migration 与事务 RED

- [ ] V11 fixture 逐行映射到 V12；旧 pending 精确变为 indeterminate。
- [ ] 同一 thread 至少三条旧 turn 使用相同 requested_at 且 message thread_sequence 不同；迁移后 lane_sequence 严格等于原 message sequence，attempt state/capability/timestamps 逐字段符合上述映射。
- [ ] V13/未知 Schema 拒绝；迁移失败整体回滚。
- [ ] schema registry追加V12：attachments=present、journal-v1、bounded-replay-v1、providerOperations=durable-v1；release capabilities更新schemaHead=12、clientDatabaseVersion=4、capabilitySetId=`durable-provider-v1`且rollback required保持true。validator与A5 V11→V12 candidate-stage/snapshot/restore通过；如durable enum/source映射缺失，同PR修改validator和fixture。
- [ ] 接受 Person Message、device 级 idempotency record、operation、lane_sequence 和 domain event 必须在一个 SQLite 事务；在每个 INSERT 后注入失败均不得留下半条链。
- [ ] 相同 device/key/hash 返回原 message 与 operation；不同 hash 为 409；不同 device 不返回前一设备结果。
- [ ] 模拟事务已提交但 202 响应丢失：lookup 用原 thread/clientMessageId 返回原 operation；任一字段、device 或 Agent 不匹配均为相同 404，且数据库行数与 Provider 计数不变。
- [ ] Member Web 接收正常 202 后持久化 operationRef 并观察状态，不立即删除 outgoing；刷新后不会因为缺少 D2 的完整未知发送模型而重建 Person Message。
- [ ] 事务提交前不得调用 Provider；202 只在提交后返回。
- [ ] 同一 thread 先连续落库 lane N、N+1、N+2，再执行 N；重建上下文只到 N 的 cutoff。N 在 running 后崩溃并由 query/replay 恢复时 invocation_request_hash 完全相同；篡改后续/旧消息、attachment set、Profile 或 external Session 会在 Provider 前转 indeterminate。

### D1.4 先写 worker RED

- [ ] 不同 thread 可在配置上限内并行；同一 thread 严格按 lane_sequence 串行。
- [ ] queued 在进程退出前未 claim：重启后正好调用一次。
- [ ] claimed 但尚未写 invoking：lease 过期后回 queued。
- [ ] running + capability=none：重启后变 indeterminate，Fake Provider 计数保持 1，不再自动调用。
- [ ] running + queryable：只调用 Adapter query；确认完成后提交结果，确认未发生才回 queued。
- [ ] running + idempotent_replay：只能用已持久化的同 correlation_ref/idempotency_key 和完全相同请求重放；Adapter 必须明确保证该 key 的外部幂等。重放仍用同一个 attempt lineage，不生成可绕过唯一范围的新 key；返回内容/Session 绑定不符则 indeterminate。
- [ ] lane N 后已有 N+1/N+2 Person Message 时，N 的首次 invoke、崩溃 query 和 idempotent replay 都只读到 context cutoff N；rebuild hash 与 attempt 不符时零外部调用并转 indeterminate。
- [ ] failed_retryable 只按有界退避和最大次数回 queued；failed_terminal 不自动重试。
- [ ] indeterminate head 阻塞后续 lane；succeeded/failed_terminal/cancelled 放行下一项。cancel 与 worker claim/invoking 并发时只有一个 CAS 胜出，不能出现已调用 Provider 仍标 cancelled。
- [ ] Provider 成功时，Assistant Message、operation=succeeded、attempt=completed、external session 更新和 domain event 同事务提交。
- [ ] shutdown 停止 claim 新 operation，等待当前 DB 原子段；超时后不把 running 伪装 queued。
- [ ] 同一 external session 绝不跨 assignment、agent 或 provider_profile。

### D1.5 最小接口

    interface ProviderOperationService {
      acceptMessage(input, accessContext): AcceptedProviderOperation;
      getOperation(input, accessContext): PublicProviderOperation;
      findAcceptedOperation(input, accessContext): PublicProviderOperation | null;
      cancelOperation(input, accessContext): PublicProviderOperation;
    }

    interface ProviderOperationWorker {
      start(): Promise<void>;
      drain(options: { timeoutMs: number }): Promise<void>;
      runOnce(now: Date): Promise<WorkerResult>;
    }

ChatWorkMessageService 不再用进程内 ThreadLane 包住完整 Provider 调用；它只调用 acceptMessage。数据库 lane_sequence 与 worker claim SQL 成为唯一顺序权威。

D1 不开放通用 requestRetry route。failed_retryable 只由 worker 的有界退避自动处理；failed_terminal 和 indeterminate 均不得通过客户端 API 直接回 queued。人工处置 indeterminate/terminal 是独立管理设计，必须重新授权、记录审计并明确“确认外部未发生/接受重复风险/创建新消息”三种语义后另做 Task。公开 PublicProviderOperation 必须区分 failed_retryable 与 failed_terminal；D2 UI 不得把二者折叠成一个可自动重试的 failed。

### D1.6 运行级验证与回滚

验证命令：

    npm exec --workspace @family-ai/contracts -- vitest run test/chatWork.test.ts test/sync.test.ts
    npm exec --workspace @family-ai/provider-adapter-sdk -- vitest run test/fakeProvider.test.ts test/providerRouter.test.ts test/codexCliProvider.test.ts test/hermesCliProvider.test.ts --maxWorkers=1 --no-file-parallelism
    npm exec --workspace @family-ai/gateway -- vitest run test/database.test.ts test/chatWorkDomain.test.ts test/chatWorkDomainSecurity.test.ts test/chatWorkProvider.test.ts test/chatWorkProviderRoutes.test.ts test/chatWorkEvents.test.ts test/providerOperationWorker.test.ts test/eventStreamLive.test.ts test/restartJourney.test.ts test/memberCacheModel.test.ts test/memberPersistenceReview.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberThreadModel.test.ts test/memberRollbackRecovery.test.ts --maxWorkers=1 --no-file-parallelism
    bash scripts/test-runtime-candidate-stage.sh --fixture v11-v12
    npm run check
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-provider-operation-restart-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/test-browser-rollback-client-recovery-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/static-check.sh
    git diff --check

provider-operation-restart-smoke.sh 固定接口：

    bash scripts/provider-operation-restart-smoke.sh --image-ref <immutable-id> --runtime-dir <absolute-mktemp-dir> --report-dir <absolute-new-dir> --project-name <safe-unique-name> --host-port 0

脚本在隔离 Fake Provider 上分别于 queued、claimed、running kill/recreate Gateway，并额外丢弃一次 202 后调用 lookup；它必须证明消息/operation/Provider 计数、indeterminate 规则和正式 8790 identity。任何正式 runtime、真实 Provider 配置或非本轮 Compose project 都必须 fail-closed。

`test-provider-operation-restart-smoke.sh` 必须强制接收调用方预先生成/下载的`--image-manifest`，校验相邻archive/SHA、exact source commit、config image ID/archive hash和OCI revision label，再创建新 mktemp runtime/report/project 后将固定接口全部参数传入 smoke；不得在wrapper内部调用builder、直接裸跑需要参数的smoke或复用可变 tag。缺manifest必须在创建资源前usage fail。

- [ ] Smoke 在 queued、claimed、running 三个点杀进程并验证上述恢复规则。
- [ ] 同一 wrapper 运行 `browser/rollback-client-recovery.spec.ts`：V2→V4 与 V3→V4 后离线恢复 previous runtime、保持 Gateway stopped、启动独立 guard + sealed recovery mount；草稿/outbox/附件记录逐项保留，network 与 IndexedDB readwrite transaction 均为 0。
- [ ] 真实 Provider 只用无隐私标记做一条能力确认，不作为自动测试，不以它证明 exactly-once。
- [ ] `docs/superpowers/specs/2026-08-13-durable-provider-operations-design.md` 顶部列明它 supersede 的 2026-07-23 旧同步 Provider Turn design/plan；旧文档只加反向指向，不改写历史。
- [ ] 若正式 Provider 调用架构实际部署，先读并更新 /home/youran/data/agent-architecture.md；仅代码合入、未部署时不写成运行事实。
- [ ] 回滚使用 A5 整体恢复 V11 SQLite、附件、镜像和配置但保持 previous Gateway stopped；只启动 C1 已验收、D1 同 SHA 重建的独立 guard并挂载 sealed recovery client，E0 后续把它纳入正式 definition。禁止旧二进制直接打开 V12，也禁止 previous V3 JS 以低版本号打开浏览器 V4。普通交互只能经 forward fix 恢复。

**完成判据：** HTTP 在 Provider 前持久化并返回 202；queued 可重启接管；CLI 不可判定窗口稳定为 indeterminate 且不双调；同 lane 顺序、跨 lane 并行、授权和事件都由自动化故障注入证明。

## 4. Task D2：浏览器 outbox 与未知发送恢复

**建议分支：** codex/member-outbox-crash-recovery

**依赖：** B2、B3、C2、D1 已合入。durable Operation 前禁止实现自动重发。

**修改文件：**

- apps/gateway/member-public/cache.js
- apps/gateway/member-public/api.js
- apps/gateway/member-public/thread.js
- apps/gateway/member-public/product.js
- apps/gateway/member-public/sync.js
- apps/gateway/member-public/render.js
- apps/gateway/test/memberCacheModel.test.ts
- apps/gateway/test/memberControllers.test.ts
- apps/gateway/test/memberPersistenceReview.test.ts
- apps/gateway/test/memberProductWorkbenchLifecycle.test.ts
- apps/gateway/test/memberThreadModel.test.ts
- apps/gateway/test/restartJourney.test.ts
- 新增 browser/outbox-recovery.spec.ts
- 新增 scripts/browser-outbox-recovery-smoke.sh
- 新增 scripts/test-browser-outbox-recovery-smoke.sh
- scripts/gateway-release-capabilities.json（client仍V4，更新capabilitySetId）
- scripts/test-runtime-backup-restore.sh（same-version required asset fixture）
- `docs/superpowers/specs/2026-08-13-durable-provider-operations-design.md`、Gateway README、本计划、总计划和开发记录

### D2.1 固定 outbox 记录

D2不升server Schema或IndexedDB物理版本，但更新release capabilitySetId为`durable-outbox-v1`，schemaHead/clientDatabaseVersion保持12/4、rollbackClientRequired保持true；从D2 exact source commit重建bundle/guard并跑A5 same-version required fixture。旧D1 asset不得冒充D2最终交付能力。

IndexedDB 不再升级版本；继续使用 D1/V4 的 `providerOutgoing` store，`keyPath="outboxKey"`，其中 `outboxKey=JSON.stringify([deviceRef, threadRef, clientMessageId])`。读取时必须重算并核对三项组成，不能信任单独字段。旧 V2 `outgoing` 仅保留 D1 定义的只读隔离/手工复制语义，D2 绝不自动发送它。最小字段：

    outboxKey, deviceRef, threadRef, conversationRef, agentRef, entryAudience,
    clientMessageId, body, attachmentRefs, operationRef, state,
    stateVersion, attemptNo, attemptCount, createdAt, lastAttemptAt, updatedAt

state 只允许 draft_persisted、sending_unknown、accepted、queued、claimed、running、indeterminate、failed_retryable、failed_terminal、succeeded、cancelled。`accepted` 只表示本地已经持久化 202 receipt、尚未拿到首个公开 operation snapshot，不是服务端状态；claimed 是服务端公开状态。禁止存 Session secret、Cookie、Authorization、Provider output 或本机路径。

### D2.2 RED 场景

- [ ] 本地 outbox 写失败时不发送 HTTP，也不渲染为已发送。
- [ ] 服务端已 202 但响应丢失：刷新后调用 lookup，用原 thread/clientMessageId 对账原 operation；不发送第二次“消息提交 POST”。lookup 本身是只读语义 POST。
- [ ] 请求从未到达服务端：对账明确 not accepted 后，才允许用同一 clientMessageId 和相同规范化请求重发；服务端用已存/新算 hash 保持 conflict 语义。
- [ ] 同一个 clientMessageId 出现在不同 thread 时必须是两条独立 outbox；恢复不得串线、覆盖或清理另一条记录。
- [ ] 从真实 V2 fixture 直接升级到 V4、从 V3 升 V4、以及 upgrade transaction 中断后重开：可证明映射的 legacy row 只复制一次，不可证明的留在只读旧 store且永不 POST；attachmentUploads/其他 store 不丢行，compound identity 无 delimiter 碰撞。
- [ ] accepted/queued/running/indeterminate：只恢复 GET/SSE 观察，不新增 Person Message、不调用第二次 Provider。
- [ ] failed_retryable：只观察服务端有界自动退避，UI 可“继续观察/取消观察”，不得自己 POST 重试；failed_terminal：旧消息与附件保持只读审计记录。用户明确“作为新消息重试”时只复制正文到新草稿并生成新 clientMessageId；现有 `message_attachments.attachment_ref UNIQUE`，旧 attachmentRefs 禁止复用，必须要求重新选择文件并走 create/upload，或未来另立受控 clone 设计生成新 attachmentRef。
- [ ] 含附件的 terminal failure RED：重试 UI 不把旧 attachmentRef 放入新 POST；未重新选择文件时只发送复制正文/保持草稿，重选后使用新的 attachmentRef，旧消息附件仍可读且数据库唯一约束不变。
- [ ] 旧 agent/thread lifecycle 的异步完成不能写入当前界面；AbortSignal 只取消观察，不删除 durable operation。
- [ ] succeeded 后本地 outbox 与服务端消息对齐，清理正文恢复副本但保留最小 receipt。
- [ ] 对同一 operation 乱序投递 stateVersion 7/running、9/succeeded、8/failed_retryable，再重复 9；store/UI 最终只能保留 9/succeeded。不同 operation 的 version 不可互相比较或覆盖。

### D2.3 实现与验收

- [ ] 发送次序固定为：规范化请求 → 写 IndexedDB → POST → 持久化 operationRef → 观察状态。
- [ ] sending_unknown 总是先调用 lookup 对账；只有 Gateway 返回 PROVIDER_OPERATION_NOT_FOUND 且当前授权仍有效，才可重发原消息 POST。
- [ ] 恢复按 agentRef + threadRef lane single-flight；跨 lane 可并行。
- [ ] Sync/SSE 重连先按服务端全局 event sequence 去重；同一 operation 的 GET/lookup/SSE 快照一律按 stateVersion 去旧，attemptNo 只展示/核对 attempt、updatedAt 只展示。不按状态枚举做“单调 rank”；允许更高 stateVersion 的 failed_retryable→queued 新一轮，但旧 version 不能把 succeeded 降回 running。
- [ ] 浏览器旅程：提交后立即关闭页面、丢失响应、重新打开；数据库最终只有一条 Person Message、一个 Operation，以及一条 Assistant Message或明确 indeterminate。

验证命令：

    npm exec --workspace @family-ai/gateway -- vitest run test/memberCacheModel.test.ts test/memberControllers.test.ts test/memberPersistenceReview.test.ts test/memberProductWorkbenchLifecycle.test.ts test/memberThreadModel.test.ts test/restartJourney.test.ts --maxWorkers=1 --no-file-parallelism
    npm run check
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-browser-outbox-recovery-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/static-check.sh
    git diff --check

browser-outbox-recovery-smoke.sh 固定接口：

    bash scripts/browser-outbox-recovery-smoke.sh --image-ref <immutable-id> --runtime-dir <absolute-mktemp-dir> --report-dir <absolute-new-dir> --project-name <safe-unique-name> --host-port 0

脚本在响应代理层精确丢弃消息 POST 的 202 body，再重载页面；必须观察一次 lookup POST、零次第二消息 POST、一个 Person Message、一个 Operation、至多一次 Provider 调用。另建两个 thread 使用相同 clientMessageId，证明 outbox 复合键不会碰撞。脚本隔离、清理与脱敏规则同 C2 smoke。

`test-browser-outbox-recovery-smoke.sh` 复用 C2 已锁定的 Playwright/Chromium、config、compose 和 sanitizer；它强制接收调用方预先生成/下载的`--image-manifest`，校验相邻archive/SHA、source commit、不可变config image ID和40位OCI revision label，禁止内部调用A4 builder；只新增/运行 `browser/outbox-recovery.spec.ts`，创建新 mktemp runtime/report/project，再将固定参数传入 smoke。缺manifest或无参数必须在创建资源前 fail-closed 并显示 usage。

**回滚：** 只回滚 D2 UI/观察逻辑，不回滚服务端 V12，也不降 D1 已完成的 IndexedDB V4；旧页面必须能忽略新 operation 字段。任何后续缓存升级都不得清空附件续传 store、providerOutgoing 或其他设备缓存。

**完成判据：** 丢失 202 响应和页面崩溃都不产生第二条消息或第二次 Provider 调用；未知状态先对账；失败内容可由用户明确恢复。

## 5. Task E4：行为冻结后的热点渐进拆分

**依赖：** E2。E4 不作为F1能力前置，建议F1后执行，且不得与 C2/D2 并行修改同一前端文件。若任一E4 PR在F1前合入，现有E2候选立即标记expired；必须从包含该PR的新`main`完整重跑E2 input-lock、不可变build和恢复演练，F1 verifier必须拒绝旧candidate source commit或buildInputTreeHash。

E4所有浏览器门禁统一消费A4同一HEAD生成的不可变artifact；表格中的`release-journey`、`attachment-resume`或`outbox-recovery`均以这组准备/消费命令为前置，所有wrapper都接收同一个manifest且不得重建Gateway image：

    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-browser-release-smoke.sh journey --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/test-browser-attachment-resume-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json
    bash scripts/test-browser-outbox-recovery-smoke.sh --image-manifest <absolute-new-empty-dir>/gateway-image-manifest.json

四个条目是四个可直接领取的独立direct-main PR，严格串行：

| PR / 新模块 | 精确修改文件 | 结构 RED 与特征回归 | 浏览器门禁 | 单项完成判据 |
|---|---|---|---|---|
| `codex/extract-gateway-composition` / 新增`apps/gateway/src/gatewayComposition.ts` | `app.ts`、`index.ts`；新增`gatewayCompositionBoundary.test.ts`；`gatewayApi.test.ts`、`config.test.ts`、`restartJourney.test.ts` | 先让boundary test因`buildGatewayApp`仍直接创建repository/service/worker而RED；冻结route注册、startup/shutdown、health与失败cleanup：`vitest run test/gatewayCompositionBoundary.test.ts test/gatewayApi.test.ts test/config.test.ts test/restartJourney.test.ts` | 按E4统一artifact命令执行`test-browser-release-smoke.sh journey --image-manifest ...` | app只装配新composition返回值；公开route/health/close顺序字节行为不变，旧入口可单commit revert，无Schema/数据回滚 |
| `codex/extract-entry-lifecycle-state-machine` / 新增`member-public/entry-lifecycle-state.js` | `entry-lifecycle.js`、`entry-storage.js`、`controllers.js`；新增`memberEntryLifecycleBoundary.test.ts`；`memberEntryLifecycle.test.ts`、`memberPairingClient.test.ts`、`memberControllers.test.ts`、`memberRenderLifecycle.test.ts` | boundary test先因generation/Abort/pairing/session/error transition散落而RED；聚焦命令列上述5文件 | `browser/release-journey.spec.ts`桌面/移动 pairing、刷新、Agent切换 | 纯函数状态转移集中，I/O仍在controller；Session secret/DOM/API不变，旧模块revert不触碰IndexedDB |
| `codex/extract-member-product-runtime` / 新增`member-public/member-product-runtime.js` | `product.js`、`attachments.js`、`thread.js`、`render.js`；新增`memberProductRuntimeBoundary.test.ts`；`memberProductWorkbenchLifecycle.test.ts`、`memberAttachments.test.ts`、`memberThreadModel.test.ts`、`memberRenderLifecycle.test.ts` | boundary test先因composer/attachment/outbox/agent lifecycle直接交织而RED；聚焦命令列上述5文件 | attachment-resume、outbox-recovery、release-journey三spec | 每个lifecycle generation单owner；DOM accessible name、Enter/Shift+Enter/IME、V4 store/API不变；revert只还原模块移动 |
| `codex/extract-member-sync-runtime` / 新增`member-public/member-sync-runtime.js` | `sync.js`、`api.js`、`thread.js`；新增`memberSyncRuntimeBoundary.test.ts`；`memberSyncModel.test.ts`、`memberSyncAuth.test.ts`、`deviceSyncIsolation.test.ts`、`eventStreamResilience.test.ts`、`memberPersistenceReview.test.ts` | boundary test先因cursor/SSE/backoff/identity/version比较散落而RED；聚焦命令列上述6文件 | outbox-recovery与release-journey，额外断网/乱序event | cursor与stateVersion保持单调、device隔离和SSE重连不变；无store/schema变化，可整PR revert |

每个PR还必须：

- [ ] 结构RED只能证明职责仍内联；行为特征测试在提取前必须GREEN。纯重构不伪造产品RED；一旦需行为变化，停止并另立TDD任务。
- [ ] 使用表中精确聚焦命令后运行`npm ci`、`npm run check`、A4不可变build、隔离dev-up/acceptance、指定浏览器spec、static-check、diff-check，并按PASS/FAIL/SKIP矩阵报告。
- [ ] 新增覆盖率baseline只针对本PR移动模块的branch/function，阈值不得低于提取前；授权/幂等/补偿断言不能删除。
- [ ] 同分支更新Gateway README的模块所有权、总计划/本文状态和开发记录；无端口/正式服务/Hermes变化时明确不触发公共台账。
- [ ] 回滚固定为revert该PR；禁止删除/降级IndexedDB、回退server Schema或清数据。

**总完成判据：** 四个小 PR 可独立审查和回滚；热点职责下降，但产品行为、存储格式、安全不变量和浏览器旅程不变。
