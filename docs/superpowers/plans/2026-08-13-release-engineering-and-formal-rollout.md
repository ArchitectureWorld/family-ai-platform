# Family AI Platform 发布工程与正式升级执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans one task at a time. Use superpowers:test-driven-development for scripts and behavior, and superpowers:verification-before-completion before reporting a gate as passed.

**Goal:** 建立可自动阻断回归的 CI、可验证的 SQLite+附件+配置整体快照、不可变镜像与副本恢复演练；最终只有在用户批准后，才升级正式 127.0.0.1:8790。

**Architecture:** disposable 验收环境与 retained 正式环境彻底分开。CI 只创建隔离临时资源。retained 发布先停止目标写入，生成权限收紧的整体快照并验证，再在副本迁移，最后原子替换；不可逆外部副作用前失败时，数据库、附件、配置和镜像作为一个单元恢复到离线 previous 状态。浏览器 IndexedDB 不做降级，previous Gateway 保持停止，只由零业务挂载、只读的独立 guard 服务 sealed recovery client；跨过外部副作用边界后只允许 candidate 维护态 forward recovery。

**Tech Stack:** GitHub Actions、Node.js 22、Vitest、Bash、better-sqlite3、Docker Compose、真实浏览器自动化、SHA-256 manifest。

---

## 0. 领取规则

- [ ] 先读根 AGENTS.md、README.md、apps/gateway/README.md、总计划和当前任务直接相关脚本。
- [ ] 创建分支或改文件前实时刷新远端 main；本地领先提交不能证明已在远端时立即停止。
- [ ] A4、A5、A6、E0、E1、E1F、E2分别是独立direct-main任务；F1是只消费已冻结工具的受控运维任务。下游必须等依赖合入main后重新建分支。
- [ ] 每个任务同分支更新总计划、本执行包和一份 docs/development 开发记录。
- [ ] A4/A5/A6/E0/E1/E1F/E2只使用临时或副本数据，禁止触碰正式8790。F1必须另获用户明确批准。
- [ ] 新脚本默认 umask 077、set -euo pipefail、关闭 xtrace；不得把 Token、Cookie、消息正文、Provider stderr、附件名或宿主私有路径写入日志/artifact。
- [ ] 每个 Task 最终报告逐项填写：聚焦 RED、聚焦 GREEN/领域回归、npm ci/check、不可变 build/Docker smoke、隔离 dev-up/acceptance、专属容器/浏览器、正式服务/真实 Provider、文档/台账；每项只能是 PASS、FAIL 或 `SKIP + 具体原因`。F1 每个 R Gate 另生成独立阶段报告，不能只写最终总结。

## 1. Task A4：CI 自动阻断 audit、镜像与容器回归

**当前实现状态（2026-08-15，提交前工作树）：** 静态 CI RED、client version RED、capability/build-input fixture RED 已转 GREEN；wrapper、CI artifact/load、manifest-bound 隔离入口和运维文档已落地。最终提交 SHA 的完整 npm/audit/Docker/container/GitHub 证据尚待执行，不能以本行代替完成判据。

**建议分支：** codex/ci-release-blocker-gates

**依赖：** A2 与 A3 已合入。

**修改文件：**

- .github/workflows/ci.yml
- Dockerfile
- compose.yaml
- scripts/static-check.sh
- scripts/dev-up.sh
- scripts/acceptance-container-attachments.sh
- apps/gateway/member-public/cache.js（只导出当前 client DB version 常量）
- apps/gateway/test/memberCacheModel.test.ts
- 新增 scripts/gateway-schema-capabilities.json、scripts/gateway-release-capabilities.json
- 新增 scripts/gateway-schema-capabilities.mjs 与最小数据驱动 fixture/test（A4 建立 receipt 生产器；A5 扩展 retained compatibility）
- 新增 scripts/release-build-inputs.json 与 tree-hash validator/test
- 新增 scripts/build-gateway-image.sh
- 新增 scripts/test-build-gateway-image.sh
- 新增 scripts/ci-compose-smoke.sh
- 新增 scripts/test-ci-compose-smoke.sh
- AGENTS.md
- README.md
- apps/gateway/README.md
- 新增 docs/operations/release-and-rollback.md
- 本执行包、总计划和开发记录

### A4.1 静态 RED

test-ci-compose-smoke.sh 必须先证明当前仓库缺少以下事实：

- [ ] CI job 明确分为 quality、production-audit、docker-build、container-smoke；
- [ ] production-audit 执行 npm audit --omit=dev --audit-level=high；
- [ ] docker-build 使用受跟踪 lockfile 构建当前提交；
- [ ] container-smoke 依赖 docker-build 成功，并执行 A2 的附件重启验收；
- [ ] smoke 不调用 dev-reset.sh，不读取仓库 .runtime，不发布宿主 8790；
- [ ] 每个 job 有独立超时，quality 保持 15 分钟；Docker/浏览器拆到下游 job，不能靠把 quality 放宽到 20 分钟掩盖串行膨胀。

先运行：

    bash scripts/test-ci-compose-smoke.sh

预期 RED：明确指出缺少 job 或命令，不允许因 YAML 解析器/依赖缺失而失败。

随后为 build wrapper 写独立 fixture RED，并先运行：

    bash scripts/test-build-gateway-image.sh

预期 RED 必须来自 exact commit worktree、source-derived labels、archive/manifest 契约尚未实现；不能因为 Docker 不可用或测试脚本语法错误失败。fixture 用受信上层给出的 expected source commit 覆盖“请求构建另一个合法 commit”的 mismatch，并覆盖目标 commit 不存在、tracked build input 被外部工作树脏改、client version 伪造和 archive 篡改；builder 不能凭一个 caller 自报的 40-hex 判断“目标”。

### A4.2 最小 CI 拓扑

| Job | 必做 | 依赖 | 建议超时 |
|---|---|---|---:|
| quality | checkout、Node 22.16.0、npm ci、npm run check | 无 | 15 分钟 |
| production-audit | checkout、npm ci、production audit | 无 | 10 分钟 |
| docker-build | BuildKit 构建当前 SHA image，记录 digest | quality、production-audit | 25 分钟 |
| container-smoke | 加载同一 digest，运行健康、附件上传、重建、下载 | docker-build | 15 分钟 |

- [ ] GitHub Action 固定完整 commit SHA。
- [ ] A4 先建立两层 capability 的最小 V3…V9 registry、当前 release capability 与数据驱动 validator/receipt；字段、枚举和 CLI 以 A5.1.1 为提前生效的唯一契约。A4 fixture 证明 registry 连续、server/client source 一致、receipt/旁置 hash 可重放；A5 只扩展 snapshot/retained compatibility、不得另造 receipt 生产器。这样 A4 wrapper 不依赖尚未存在的 A5 文件。
- [ ] `cache.js` 把同一运行常量导出为 `MEMBER_CACHE_DATABASE_VERSION`，open 仍只引用该常量；A4 不改变数值/存储。Dockerfile 用 wrapper 内部 build arg 写入 OCI `org.opencontainers.image.revision=<40-hex>` 与 `org.architectureworld.family-ai.client-database-version=<positive-int>` label；版本来自目标 commit 的模块导出，不允许运行者手填覆盖。CI 与后续 smoke wrapper在启动前用 image inspect、manifest、capability receipt 与同一 commit source逐项核对；缺失/unknown/不匹配一律失败。
- [ ] Dockerfile 的 build/runtime `FROM` 都固定为实施时从官方 Node 镜像核验的 `node:22.16.0-bookworm-slim@sha256:<platform-digest>`，明确目标 platform。build stage 的 apt 源固定到一个受跟踪 Debian snapshot 时间点，`python3/make/g++/git` 使用该 snapshot 的精确版本并在 manifest记录 snapshot URL/package versions；禁止实时 `apt-get update` 漂移。A4 manifest/labels 记录 base image ref/digest/platform、两个 stage resolved identity与toolchain material；fixture模拟tag/snapshot/package漂移、错误digest/platform并fail-closed。A4只承诺“本轮archive不可变、所有选择材料可追溯”；只有重复隔离构建实际得到相同image ID/archive hash时才可另称bit-reproducible，不能把exact Git SHA等同于这个结论。
- [ ] `release-build-inputs.json` 是后续 build input 的唯一分类权威，A4 即固定且测试三种互斥分类：`runtime-build`（影响 Gateway/guard/bundle/helper/template/release-controller 的运行输入）、`quality-tool`（不进入运行镜像但会裁决候选是否可发布的受跟踪检查器/测试）和 `docs-only`（显式允许不使候选失效的纯文档）；禁止未知分类和未分类新增路径。`runtime-build` 与 `quality-tool` 都进入 candidate input tree hash，只有 allowlist 中的 `docs-only` 可排除。tree hash 对每项编码“分类 NUL + UTF-8 规范相对路径 NUL + Git mode NUL + object type NUL + object ID NUL”，按完整字节串排序后 SHA-256；清单文件自身也以 `runtime-build` 四元组纳入 hash。普通文件只接受 `100644|100755`，符号链接必须显式分类并按 `120000/blob` 处理，submodule和未知mode/type直接拒绝。A4 manifest 同时绑定清单 hash 与 buildInputTreeHash；fixture 覆盖清单自身漂移、三种分类枚举、质量脚本误列为docs-only、新增未分类文件、任一 include 漂移、仅改变 executable bit、symlink/submodule以及误把运行脚本/config列为docs-only。后续 E3 可在同一 PR 向清单增加明确的 `quality-tool` 路径，但不得修改分类语义或 validator；该 PR 的不可变 build 必须从包含新清单和新脚本的同一 commit 计算 hash。
- [ ] A4 合入后，生成**可交付或可作为验收证据**镜像的唯一入口固定为 `build-gateway-image.sh`。脚本从指定 commit 创建临时 detached clean worktree并只从该目录构建，拒绝不存在/非 commit object、submodule 漂移和无法证明的 build context；外部工作树即使脏也不能污染产物。附件/浏览器 smoke、E2、F1 只消费其 manifest。默认开发模式可做明确标记为 `local-unverified` 的裸 build，但该产物不得上传、不得传给隔离 acceptance 或发布链。
- [ ] A4 同 PR 把 AGENTS 的可交付 Docker 门禁、README、Gateway README 和 release-and-rollback 文档改为 wrapper；`docker compose config --quiet` 仍是配置门禁，裸 `docker compose build` 不再是可交付证明。
- [ ] 镜像 tag 使用 source commit；docker-build 对精确 image ID 执行 docker save，生成 SHA-256 后用固定 commit 的 artifact action传递。artifact 容器名固定 `gateway-image-<40hex>`，内部只含 `gateway-image.tar`、`gateway-image.tar.sha256`、`gateway-image-manifest.json`；manifest 固定记录 `manifestKind=gateway-image-v1`、sourceCommit、imageId、archiveSha256、clientDatabaseVersion、releaseCapabilityReceiptSha256、releaseBuildInputsSha256、buildInputTreeHash、baseImageRef/digest/platform 和 labels。镜像内不得含 runtime/config secret。
- [ ] GitHub job 不共享 Docker daemon。container-smoke 必须下载、校验 hash、docker load 同一 image archive，再核对实际 image ID/digest；禁止假设上一个 runner 的本地镜像存在，也禁止重新拉取 foundation 可变 tag。
- [ ] CI 临时运行目录用 mktemp -d，Compose project 名含 run id；trap 只删除本轮容器、网络、卷和临时目录。
- [ ] smoke 容器保持 non-root、read_only root、no-new-privileges，只挂临时 data/attachments，可在容器网络内部访问而不发布宿主端口。
- [ ] 上传 artifact 只包含测试计数、状态、image digest 和脱敏失败代码；任何原始 env、handoff URL、数据库或附件都不上传。

### A4.3 验证

统一构建接口；`expected` 必须来自上层受信上下文，不能由 builder 自己猜：CI 使用 event `GITHUB_SHA`，E2 使用 sealed input-lock 的 `candidateSourceCommit`，本地开发门禁才允许两者都取当前 HEAD：

    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>

脚本把两个 SHA 分别解析为 full commit object并要求相等，再从 source commit 建 detached clean worktree；CI/E2 wrapper分别负责从 event/input-lock提供不可由构建参数覆盖的expected值。随后按受跟踪 `release-build-inputs.json` 拒绝未分类路径并计算规范tree hash，核对所有构建输入都来自该tree；用A4 validator从两层capability input与server/client source生成sealed receipt，再从该tree的`cache.js`与receipt读取正整数client DB version。构建前核对两个stage的官方base digest/platform、Debian snapshot和精确toolchain package均为受跟踪固定值；只对本轮内部构建设置revision/version arg。构建后解析强制存在的Docker config image ID，核对OCI revision、client version、capability receipt/build-input/base/toolchain labels，对精确ID执行`docker save`并写固定三文件契约。`repoDigest`仅在inspect实际返回时作为可选字段记录；本地BuildKit没有RepoDigest不是失败。`test-build-gateway-image.sh`覆盖source/expected为两个不同合法commit、不存在/非commit SHA、外部dirty tree不影响detached build、tracked input错误复制、registry/receipt/source漂移、清单/未分类路径/tree hash漂移、可变或错误base/snapshot/package/platform、labels漂移、命令行覆盖版本、模块导出无效、archive/ID不匹配和RepoDigest为null；`memberCacheModel.test.ts`证明open使用版本与导出相同。

    bash scripts/test-build-gateway-image.sh
    bash scripts/test-ci-compose-smoke.sh
    bash scripts/static-check.sh
    npm run check
    npm audit --omit=dev --audit-level=high
    docker compose config --quiet
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/ci-compose-smoke.sh --image-manifest <output>/gateway-image-manifest.json
    git diff --check

GitHub 侧证据必须是该 PR 最新 SHA 的四个 job 均通过；本地通过不能替代远端 required checks。

**回滚：** 脚本和 workflow 可一起回退，但不得在没有等价门禁时移除 production audit、digest 一致性或 container smoke。误报应修复隔离/断言，不得用 continue-on-error。

**完成判据：** 已知附件只读根回归、production High 漏洞、错误 source commit、伪造 client version、archive/manifest 漂移任一重现时 CI 必须失败；正常提交四个 job 全绿，artifact 名称/内部三文件契约与 E1 一致且无敏感内容；公开文档只把 wrapper 产物称为可交付镜像。

## 2. Task A5：retained runtime 整体快照与原子恢复

**建议分支：** codex/retained-runtime-backup-restore-foundation

**依赖：** A4 已合入。所有 V10+ migration 的硬前置。

**新增/修改文件：**

- 扩展 A4 已建立的 scripts/gateway-schema-capabilities.json、scripts/gateway-release-capabilities.json
- 扩展 A4 已建立的 scripts/gateway-schema-capabilities.mjs 与数据驱动 fixture/test（不得替换 CLI/receipt 格式）
- 新增 scripts/runtime-backup-preflight.mjs（B3/C1/D1/E2/F1 共用）
- 新增 scripts/runtime-stop-evidence.mjs
- 新增 scripts/runtime-snapshot.mjs、scripts/runtime-backup.sh
- 新增 scripts/runtime-tool-manifest.mjs 与 fixture/test（从受控 source commit和release-build-inputs生成sealed工具清单）
- 新增 scripts/runtime-candidate-stage.sh 与 candidate manifest validator
- 新增 apps/gateway/src/migrate.ts 及 migration-only 测试入口
- 新增 scripts/runtime-rollback-assets.mjs（validate/materialize）
- 新增 scripts/runtime-exchange-preflight.mjs
- 新增 scripts/atomic-dir-exchange.c、scripts/build-atomic-dir-exchange.sh
- 新增 scripts/runtime-restore.sh
- 新增 scripts/test-runtime-backup-restore.sh、scripts/test-runtime-candidate-stage.sh
- scripts/verify-foundation.sh
- scripts/test-verify-foundation-preflight.sh
- 扩展 A4 已建立的 docs/operations/release-and-rollback.md
- README.md
- apps/gateway/README.md
- 本执行包、总计划和开发记录

### A5.1 固定命令接口

#### A5.1.1 两层 capability receipt（本节是唯一版本权威）

不得把 server Schema 与 client release 混在“每个 Schema 一个 client version”的条目里。A4 已建立下面两个独立、受跟踪的输入和 validator；A5 将其纳入 retained snapshot/preflight 并增加 compatibility fixture，不改变既有 receipt CLI/格式：

```json
{
  "formatVersion": 1,
  "snapshotFormat": { "write": 1, "read": [1] },
  "schemas": [
    {
      "schemaVersion": 3,
      "migrationHead": 3,
      "attachments": "absent-legacy",
      "attachmentJournal": "none",
      "mobileClaimReplay": "legacy",
      "providerOperations": "legacy"
    }
  ]
}
```

`gateway-schema-capabilities.json` 从 V3 连续列到当前 head；枚举固定为：attachments=`absent-legacy|present`、attachmentJournal=`none|journal-v1`、mobileClaimReplay=`legacy|bounded-replay-v1`、providerOperations=`legacy|durable-v1`。B3/C1/D1 分别增加新 Schema entry；如果新增枚举，必须同 PR 修改 validator 与 fixture test，不能只写自然语言。

```json
{
  "formatVersion": 1,
  "capabilitySetId": "foundation-v9",
  "schemaHead": 9,
  "clientDatabaseVersion": 2,
  "databaseNameScheme": "identity-scoped-v2",
  "rollbackClientRequired": false,
  "rollbackClientBundleFormat": "none",
  "rollbackGuardFormat": "none"
}
```

`gateway-release-capabilities.json` 只描述当前源码交付能力，不保存 Git SHA。C1 把 `rollbackClientRequired` 改为 true并把两个 format 改为 `sealed-static-v1` / `static-guard-v1`；此后 C2/D1/D2 即使 client 物理版本不变，也必须更新 capabilitySetId 和 compatibility fixture，且 required 不得退回 false。D1 才把 clientDatabaseVersion 升为 4。A5 当前 client V2 仍为 false，因此不依赖未来 C1 guard，不形成 A5→C1→A5 循环。

固定 validator：

    node scripts/gateway-schema-capabilities.mjs validate --schema-registry <absolute-tracked-json> --release-capabilities <absolute-tracked-json> --database-source <absolute-database.ts> --client-cache-source <absolute-cache.js> --output <absolute-new-0600-json>

receipt 绑定两份输入、server/client source hash、连续 schema entries、candidate head、当前 client version、capabilitySetId 和 rollback formats，并有旁置 SHA-256。它证明 **candidate code/head**；读取旧 V3/V9 source DB 时只要求其 Schema 命中 receipt 内某个受支持 entry，再单独核对 source image/client provenance，绝不要求 source Schema/client 等于 candidate head。不存在 `minimumImageRevision`；exact candidate SHA 由 A4 构建 manifest 绑定。历史 image 可如实为 `legacy-unknown-revision`。snapshot compatibility 只用上面显式 `snapshotFormat.write/read`，未知或不在 read allowlist 的 format fail-closed。

#### A5.1.2 停服前通用 preflight

B3/C1/D1、E2、F1 全部复用 A5 提供的通用入口，后续任务不得再发明一个未来才存在的 fixture inspector：

    node scripts/runtime-backup-preflight.mjs --scope <formal-production|fixture-rehearsal> --phase <prepare-backup|cutover-final-backup|activate-candidate|rollback-unarmed-candidate|fixture-source-snapshot> --release-id <safe-id> --runtime-root <absolute-existing-runtime> --controller-definition <absolute-file-or-dir> --capability-receipt <absolute-0600-json> --expected-capability-receipt-sha256 <64-hex> --source-image-role <current-retained|candidate-retained|fixture-baseline> --source-image-id <sha256:docker-config-id> --output <absolute-new-0600-json> [--source-image-revision <40-hex>] [--legacy-attachments absent-if-schema-before-v8] [--candidate-image-manifest <absolute-A4-or-E2-manifest> --rollback-client-bundle <absolute-tar> --rollback-guard-image-archive <absolute-tar> --rollback-guard-image-id <sha256:docker-config-id> --rollback-recovery-template <absolute-portable-template> --rollback-recovery-instance-set <absolute-current-instance-set> --rollback-materialization-receipt <absolute-0600-json>]

除新建`0600`output/旁置hash外它只读：realpath/owner/mode/space、SQLite quick_check/foreign_key_check、Schema entry、source image identity/client provenance、controller owner、附件适用性全部在停服前检查。`prepare-backup`、`cutover-final-backup`与`fixture-source-snapshot`可授权对应backup；`activate-candidate`与`rollback-unarmed-candidate`只为当前candidate owner生成新鲜只读source fingerprint，绝不授权backup/restore。前两者只接受`current-retained`，候选两phase只接受`candidate-retained`，fixture只接受`fixture-baseline`；scope/phase/role/owner组合不合法一律拒绝。release receipt为`rollbackClientRequired=true`时，candidate image manifest、bundle、guard archive/ID、可移植recovery template、当前instance set与materialization receipt全部必填；false时全部禁止。candidate manifest仅接受带显式`manifestKind`的A4 `gateway-image-v1`或E2 `release-candidate-v1`；后者必须内嵌并封口前者，validator按kind交叉核对Gateway revision/receipt、guard revision、bundle sourceCommit/formats，拒绝其他结构。template只能含唯一`${RECOVERY_ASSET_DIR}`token，instance必须由该template+receipt渲染且当前绝对路径精确匹配。所有关系/hash与exact source identity封进fingerprint，彼此一致但来自错误commit的asset也必须在stop前失败。

fixture baseline 允许从 exact historical commit 的静态 asset 以严格 allowlist识别旧 `const DATABASE_VERSION=<positive-int>`，状态记 `legacy-static-inspected`；操作者不能手填。formal current 没有 label时只记 `legacy-inspected|legacy-absent|legacy-unknown`。candidate 永远要求 A4 verified labels/receipt；legacy 状态不放宽 candidate。

#### A5.1.3 stop evidence、backup、candidate stage 与 restore

先由同一发布流程在目标已经按批准范围停止后生成一次性停服证据：

    node scripts/runtime-stop-evidence.mjs capture --scope <formal-production|fixture-rehearsal> --phase <prepare-backup|cutover-final-backup|fixture-source-snapshot|fixture-work-copy-stop|candidate-exchange|candidate-rollback|restore-previous|activate-validation-stop|activate-acceptance-stop|attachment-integrity-repair> --release-id <safe-id> --expected-preflight-sha256 <64-hex> --controller docker-compose --project-name <exact-project> --service gateway --expected-bind <127.0.0.1:port|none> --output <absolute-new-json>

若只读取证确认实际 owner 是 systemd，可把 controller 换为 systemd-system 或 systemd-user，并用 --unit <exact-unit> 取代 project/service；禁止把不是 listener owner 的 unit 写进 evidence。`formal-production` 的 `--expected-bind` 必须是本 Gate 精确 loopback 地址；`fixture-rehearsal` 没有宿主发布端口时必须显式传 `none` 并证明 container 内 listener owner 已停止。脚本验证 scope/phase 合法组合（例如 fixture 禁止 cutover、formal 禁止 fixture-source），把二者都写入 JSON/自身 hash；capture 必须实时证明精确 container/unit 已 stopped、目标 listener 消失、无第二 owner，输出 regular 0600 JSON 和自身 SHA-256。

stop evidence 的 5 分钟 TTL 只控制“能否进入一次 backup/restore 命令”，不是要求一个运行中的长复制任务自行伪造新证据。命令入场时再次实时核对 owner/listener 后建立进程内 stop lease；此后在每个写入/交换 checkpoint 前、且长循环至少每 30 秒，重新核对同一 owner 仍 stopped、listener 仍 absent。任一核对失败立刻停在下一次写入之前并留下可恢复 staging；进程崩溃或重新调用命令必须用当前 phase 新取的 evidence，不能靠旧 lease resume。

stop evidence 是 phase-scoped，不是贯穿整次发布的万能票据。Compose fixture 生命周期固定为 `create → start → stop`；receipt/candidate manifest 完成前禁止 `down`/`rm`，证据绑定 stopped container ID、createdAt、project、config hash和 image ID。prepare backup、fixture snapshot、cutover final backup、candidate exchange/rollback 与 previous restore各自重新 capture fresh evidence；fixture 永不用于 production。证据入场 TTL 为 5 分钟，长操作每 30 秒和每个写 checkpoint复核 owner仍 stopped/listener absent；崩溃重进必须重取。

runtime-backup 不重新接受一组可漂移的 capability/asset 参数；它只消费停服前的 sealed preflight与 fresh stop evidence：

    bash scripts/runtime-backup.sh --scope <formal-production|fixture-rehearsal> --phase <prepare-backup|cutover-final-backup|fixture-source-snapshot> --release-id <safe-id> --preflight <absolute-0600-json> --expected-preflight-sha256 <64-hex> --stop-evidence <absolute-0600-json> --runtime-root <absolute-existing-runtime> --output-root <absolute-existing-empty-parent> --backup-tool-manifest <absolute-sealed-0600-json> --expected-backup-tool-manifest-sha256 <64-hex>

`runtime-tool-manifest.mjs`只接受上层受信的source/expected commit，复用A4 build-input算法，封口sourceCommit、inputTreeHash、A5生产脚本/validator/helper source/build script的blob/hash；E2/F1 candidate manifest再绑定它。runtime-backup逐文件核对，禁止caller裸传任意40hex。manifest中的backupToolGitSha来自sealed tool manifest，只表示工具代码。verified/legacy image、client provenance、receipt及required candidate manifest/bundle/guard/template/source instance/materialization receipt全部与preflight逐字节相等。A5基础capability为false；required=true时即使client版本相同也不得省略任一项。

旧 Schema 确实没有附件能力时，唯一允许的例外参数是 preflight 的 `--legacy-attachments absent-if-schema-before-v8`；脚本必须按 schema registry entry判断。V8+、未知 Schema 或未显式给参数时，缺附件根一律拒绝。

candidate staging 的唯一生产者：

    bash scripts/runtime-candidate-stage.sh --release-id <safe-id> --source-snapshot <absolute-sealed-dir> --candidate-image-manifest <absolute-A4-or-E2-manifest> --capability-receipt <absolute-0600-json> --expected-capability-receipt-sha256 <64-hex> --candidate-definition <absolute-migration-definition> --target-parent <absolute-existing-same-filesystem-parent> --output-name <safe-new-basename> --manifest <absolute-new-0600-json>

它从 snapshot 物化 staging，只接受前述两种`manifestKind`及E0/C1 compatibility 契约生产、candidate manifest绑定的 migration definition：固定`node apps/gateway/dist/migrate.js`、worker-disabled、`network_mode:none`、无publish/HTTP/Provider/release-control；CLI的target-parent/output-name必须与instance set中的candidateStaging parent/basename及migration mount逐字节相等，和current同父/同设备，目标事前不存在。E2 manifest必须把内嵌A4 gateway manifest、migration definition与同一source tree一起封口，传入validation或任一漂移定义都拒绝。不启动HTTP、不claim、不读真实Provider。完成quick_check/foreign_key_check/附件hash后fsync并封口candidate runtime manifest：sourceSnapshotSha256、candidateImageId/revision/receipt/migrationDefinitionSha256、before/afterSchema、runtime相对清单/hash、目录device/inode。`candidateRuntimeManifestSha256`只有这一生产者，B3/C1/D1 compatibility fixture、E2、F1全部调用它。

交换能力必须在停止服务前、且在目标同一文件系统上先证明；helper 的构建与 probe 都不是 restore 第 4 步才做：

    bash scripts/build-atomic-dir-exchange.sh --output <absolute-new-helper> --receipt <absolute-new-0600-json>
    node scripts/runtime-exchange-preflight.mjs --helper <absolute-helper> --target-parent <absolute-existing-parent> --output <absolute-new-0600-json>

probe 只在 target parent 下创建两个本轮 `0700` 空目录，执行一次 exchange、核对 inode后交换回来并清理；输出绑定parent device/mount、helper source/binary hash和结果。A5 fixture可本轮构建；E2必须从exact source commit构建并把helper binary/source/build-script hash封进release candidate manifest。F1禁止批准后build：R2 formal preflight先用E2 helper在正式target parent probe，把capability receipt hash纳入用户fingerprint；获批后只复核/执行该binary。任一漂移使批准失效。

runtime-restore.sh：

    bash scripts/runtime-restore.sh --scope <formal-production|fixture-rehearsal> --phase <candidate-rollback|restore-previous> --release-id <safe-id> --preflight <absolute-0600-json> --expected-preflight-sha256 <64-hex> --stop-evidence <absolute-0600-json> --exchange-capability <absolute-0600-json> --snapshot <absolute-snapshot-dir> --target-runtime-root <absolute-target> --client-rollback-mode <previous-native|read-only-recovery> --receipt <absolute-new-0600-json> [--candidate-manifest <absolute-0600-json> --committed-exchange-receipt <absolute-0600-json>] [--recovery-release-root <absolute-existing-0700-dir> --recovery-instance-output <absolute-new-dir> --materialization-receipt-output <absolute-new-0600-json> --guard-handoff-manifest-output <absolute-new-0600-json>]

所有接口必须拒绝相对路径、空字符串、`/`、home/仓库根、符号链接目标、跨文件系统swap、非空输出、运行中owner、未知Schema、权限过宽和空间不足。pre-exchange restore使用source preflight封口的canonical path/device/inode/controller；`candidate-rollback`强制消费candidate manifest与committed exchange receipt，证明target当前为candidate inode、parked为原source inode、方向和durable intent一致。syscall成功但receipt前崩溃时只用intent双inode与target/parked实时inode唯一对账，再补receipt；caller不能裸报inode或拿旧source inode检查合法candidate target。`read-only-recovery`时后四个recovery输出参数全部必填：release root必须已存在且0700，三个output必须全新；restore安全materialize snapshot bundle、从portable template渲染新instance，并输出绑定snapshot/template/new root/guard ID与各hash的sealed handoff manifest，外层只能消费该handoff启动guard。`previous-native`时这些参数全部禁止。布尔`--expected-service-stopped`不存在。

F1/E2 的 orchestration命令必须把同一release-id贯穿所有phase；A5 stop-evidence/backup/stage/restore只接收并核对source preflight hash，外层rehearsal/formal controller同时记录formal preflight hash并验证其封口的source hash。两种hash不得互换；任一parent-child/release-id不等都在写数据或启停服务前失败。

“已知 Schema”、client version 与 rollback asset 条件只来自 A5.1.1 的两层 receipt；后文任何旧式单 registry/“版本前进才需要”措辞都不构成替代规则。每个 Schema PR 必须追加 schema entry并更新 release capability的 schemaHead、validator fixture和 N-1→N candidate-stage/snapshot/restore；C2/D2 等无 server migration 的 client PR仍更新 release capabilitySetId和bundle/guard fixture。validator为数据驱动；如果新能力无法由现有枚举/源码检查表达，该 PR必须显式扩展validator及其聚焦测试。

浏览器 IndexedDB只前进。`rollbackClientRequired=false` 仅允许A5基础/V9能力；C1改为true后永不回退，E2/F1和所有后续same-version release都强制bundle tar、guard image和独立recovery definition完整存在。A5只验证、materialize、复制和封口，不自行生成产品recovery assets。

### A5.2 快照格式

快照目录固定为：

    <snapshot>/
      manifest.json
      manifest.sha256
      payload/runtime/
      payload/image/gateway-image.tar
      payload/controller/original/
      payload/controller/exact-replay/
      payload/image/rollback-guard-image.tar（rollbackClientRequired=true）
      payload/controller/rollback-recovery-template/（required=true；可移植token模板）
      payload/controller/rollback-recovery-source-instance/（required=true；仅来源审计）
      payload/client-rollback/rollback-recovery-client.tar（required=true）
      verification/quick-check.txt
      verification/foreign-key-check.txt
      verification/capability-receipt.json
      verification/candidate-image-manifest.json（required=true）
      verification/backup-tool-manifest.json
      verification/source-materialization-receipt.json（required=true）

manifest.json 只记录下列 allowlist 字段；其中发布链与停服证据绑定不是可选元数据，E2/F1 必须能仅凭 sealed manifest 校验来源，不能依赖旁边某份未封口报告补字段：

- formatVersion、createdAt、releaseId、expectedPreflightSha256、backupToolManifestSha256、backupToolGitSha/inputTreeHash、imageId、imageProvenanceStatus、可空imageRevision、imageCreatedAt、可选repoDigest、imageArchiveSha256、originalControllerDefinitionSha256、exactReplayDefinitionSha256、schemaVersion；
- capabilityReceiptSha256，以及两份 registry/server/client source hash、candidate head、source schema entry、release capabilitySetId/rollbackClientRequired；receipt 的受保护副本写入 `verification/capability-receipt.json` 并由 manifest 单独列出 size/mode/hash；
- sourceImageClientDatabaseVersionStatus=`verified-label|legacy-static-inspected|legacy-inspected|legacy-absent|legacy-unknown` 与可空 sourceImageClientDatabaseVersion；required=true时candidateImageManifestSha256、rollbackClientBundleSha256、bundle manifest hash、rollbackGuardImageId/archiveSha256/revision、rollbackRecoveryTemplateSha256、sourceInstanceSetSha256、sourceMaterializationReceiptSha256、candidate build Git SHA、supportedClientDatabaseVersions、materializer format和guard静态根全部非空，false时全部为空且对应payload不存在；
- controller.kind、启动 identity、原始状态、可重放 service definition 的相对路径/hash 和非敏感 launch args；
- 数据库相对路径、size、mode、SHA-256；
- 附件/配置文件的相对路径、类型、size、mode、SHA-256；
- 文件数和总字节；
- stop evidence 的 scope、phase、releaseId、expectedPreflightSha256、service identity、停止时间和 stopEvidenceSha256；这四项授权字段必须与命令参数和 evidence 本体逐项相等。

禁止记录文件内容、Token/Cookie、绝对路径或 Provider stderr。payload 与 manifest 权限 0700/0600，snapshot 不能进入 Git 或 CI artifact。

payload/controller 必须足以在没有当前仓库工作树的情况下重放旧服务：

- original保存实际 Compose `-f` source/env/project/service或 systemd unit/drop-in/EnvironmentFile，仅用于审计且仍受0600保护。
- exact-replay是唯一可启动版本：Compose在seal前把mutable tag解析并替换为manifest exact image ID；systemd绑定executable canonical path/device/inode/hash。启动前再次解析结果；无法生成无当前工作树可重放的exact定义时backup fail-closed，禁止启动后才检查image。
- rollback bundle仍以tar交付，但绝不直接bind mount tar。`runtime-rollback-assets.mjs materialize`验证seal/manifest，只接受regular file/dir，拒绝absolute/`..`/symlink/hardlink/device/FIFO/重复路径/超限字节；提取到new0700 staging，逐文件hash、chmod只读、fsync后rename为`<release-root>/recovery/<bundle-sha256>/`并写receipt。snapshot只保存含唯一`${RECOVERY_ASSET_DIR}`token的可移植template及hash，来源instance只作审计；restore在目标release root重新materialize并从template渲染全新instance，绑定new root/receipt/template hash。旧绝对路径instance不得复用；guard只ro挂新目录。

### A5.3 RED 矩阵

在 test-runtime-backup-restore.sh 的 mktemp 根内先写失败测试：

- [ ] 路径为 /、home、仓库根、相对路径、符号链接逃逸、含 ..；
- [ ] service 仍运行或 stop evidence 已过期/身份不匹配；
- [ ] stop evidence 的 release-id/preflight hash/controller 与命令不一致，或 capture 后 listener/owner 状态变化；
- [ ] manifest 缺少/篡改 releaseId、expectedPreflightSha256、evidence scope/phase/stopEvidenceSha256、capabilityReceiptSha256或backupToolManifestSha256；source/expected commit不同、caller伪造合法40hex、当前脚本/hash/tree与tool manifest漂移时verify、E2/F1在任何启动/迁移前拒绝；
- [ ] schema registry缺版本/能力与真实表不符、release head/client source不符、snapshot format未知、receipt漂移；V12 candidate receipt读取V3/V9 source必须成功，误要求source=head的实现由负测抓住；
- [ ] A5基础`rollbackClientRequired=false`的V9 fixture可运行且禁止半组asset；required=true即使client版本相同，也在停服前拒绝缺candidate manifest/bundle/guard/template/source instance/materialization receipt，或Gateway/guard/bundle SHA、OCI、asset、version range漂移；
- [ ] tar含absolute/`..`/link/device/重复/超限、materialized hash漂移、把tar直接挂目录或definition token超出唯一allowlist时拒绝；
- [ ] evidence 在操作开始前过期必须拒绝；入场后跨 TTL 允许既有进程在 stop lease 下继续，但 owner/listener checkpoint 变化必须在下一次写前中止；崩溃重进或回滚复用 original/candidate/fixture 旧 evidence 必须拒绝；
- [ ] SQLite 有未协调写入、quick_check 失败、foreign_key_check 非空；
- [ ] Schema V8+ attachment 根缺失；Schema V3 等旧版本只有显式 legacy-attachments=absent-if-schema-before-v8 才允许缺失；
- [ ] 文件在两次清单之间变化、配置权限过宽、docker image save 失败；
- [ ] output 非空、磁盘空间不足、manifest/hash/image tar 任一被篡改；
- [ ] Compose overlay/env 或 systemd unit/drop-in 任一缺失/被篡改，不能重放旧启动定义；
- [ ] original Compose使用mutable tag且tag已漂移时，exact replay仍解析为snapshot image ID；无法生成exact replay则backup失败，绝不能启动后才发现；
- [ ] candidate stage的source snapshot/image/receipt/definition/schema/inode任一漂移、migration尝试联网/worker claim、candidate manifest部分写或篡改都失败且source不变；
- [ ] target 在另一文件系统、部分 staging、target identity path/device/inode/controller 漂移、managed manifest（若有）不符、重复 restore；legacy-unsealed fixture 即使内容被故意破坏也必须按 identity 恢复并保留交换后的旧 inode；
- [ ] read-only-recovery缺任一recovery输出、release root非0700、output已存在/互相重叠、materialization或新instance/handoff hash漂移时，在交换或启动前失败；previous-native携带这些参数也拒绝；
- [ ] kernel/filesystem 不支持 renameat2(RENAME_EXCHANGE)，helper source/binary hash 不符，或 capability parent/device 与目标不符；必须在停服前 preflight 失败，禁止退化成两次 rename；
- [ ] restore 任一校验失败时 target 的 inode/hash 完全不变。

RED 必须指向缺失功能；测试只能操作 mktemp 目录和测试子进程。

### A5.4 备份实现次序

1. 复核停服前生成的 preflight、stop evidence、release-id/hash/TTL/controller，并实时拒绝目标 listener/PID/container仍存在。
2. realpath 所有路径并验证包含关系、非符号链接、owner/mode。
3. 用 better-sqlite3 打开数据库，执行 wal_checkpoint(TRUNCATE)、quick_check、foreign_key_check；关闭后确认 WAL/SHM 不再承载未合并内容。
4. 对精确 image ID 执行 docker image save；hash image tar，并证明 archive load 后解析为同一 image ID。
5. 保存original controller并生成exact replay；required=true时只复制preflight已验证的candidate manifest、bundle、guard archive、portable recovery template、source instance和materialization receipt，hash必须完全相同。
6. 对 runtime 做第一遍相对路径清单；复制到同一文件系统的 staging，保持 mode。
7. 对源和 staging 做第二遍 size/hash 清单；任何变化都删除本轮未密封 staging 并失败。
8. 在 staging 内写 manifest.json、manifest.sha256 与验证摘要；校验 hash 后 fsync 所有文件和 staging 目录。manifest.sha256 必须在封口 rename 前已经存在，不能让最终目录出现“有 payload、无 seal”的窗口。
9. fsync 输出父目录，单次 rename staging 为最终 snapshot，再 fsync 父目录；最终目录一旦可见就必须是完整、已封口且可验证的快照。

不允许把在线复制的 SQLite 与正在变化的附件描述为一致性快照。

### A5.5 恢复实现次序

1. 在任何交换/启动前复核stop evidence、preflight、snapshot seal、payload、exact replay/recovery template、candidate/tool manifest、image、target identity与空间；legacy-unsealed target不要求虚构manifest，但identity必须匹配。
2. 在停止/交换目标前 docker load image archive，核对实际 image ID；不匹配立即失败。
3. 把payload复制到目标同级restore-staging；quick_check/foreign_key_check/附件hash通过。required=true时只验证bundle/template与四个recovery输出路径并预留安全basename，不在交换前生成可被误启动的instance。写durable exchange intent记录current/staging inode、manifest和方向。
4. 只使用停服前已经构建、probe 并由 receipt 绑定的 helper；再次核对 source/binary hash、parent device/mount identity。helper 通过父目录 fd、两个 basename 和 renameat2(RENAME_EXCHANGE) 单次交换现目标与 staging。目标/候选必须是同一父目录下的 regular directory、非符号链接且同一文件系统；本步骤禁止现场 build/probe，禁止用 current→rollback、staging→current 两次 rename 冒充原子操作。
5. fsync父目录并写exchange receipt；在任何controller尚未启动时完成最终target quick_check/foreign_key_check/附件/manifest验证。若失败，此时仍持有listener-absent lease，可用同一helper换回并写revert receipt；不得引入第三个目录搬移。
6. 最终数据验证成功后即不再自动交换。false/`previous-native`只用exact-replay启动；true/`read-only-recovery`保持previous Gateway stopped，load exact guard，在显式recovery release root安全materialize bundle，写新materialization receipt，从snapshot portable template渲染/封口显式new instance，再写sealed guard handoff manifest并只按handoff启动唯一loopback owner；来源绝对路径instance不可复用。
7. guard/previous启动或health失败时，不再拿旧stop lease交换目录：精确停止本轮失败controller（若已起），保持业务离线、保留已验证previous runtime、materialization/instance/handoff证据并报告人工forward fix。成功才写restore receipt；receipt绑定三个recovery输出hash，旧目标/rollback/recovery目录不自动删除。

禁止只恢复 DB、只恢复附件、只切镜像或让旧二进制打开新 Schema。

### A5.6 副本演练、文档和边界

- [ ] 创建 V9 fixture，写入至少一个 member、三轮消息、多分片附件和权限收紧的配置；删除 daemon 中 fixture image 后从 archive load，确认 image ID 一致。
- [ ] 另建 V3 legacy fixture：显式 legacy flag 时允许 attachment 根 absent；V8+ 或未给 flag 时必须拒绝。
- [ ] 用A5当前`rollbackClientRequired=false`完成全链；再用合成required=true tar/guard/definition完成validate→materialize→read-only restore，证明same client version也不可省略。
- [ ] 对N-1→N fixture运行`runtime-candidate-stage.sh`并核对candidate manifest；该命令是B3/C1/D1以后唯一migration副本入口。
- [ ] 快照后故意破坏副本数据库与附件，再整体恢复；逐字节核对消息、附件、配置、Schema、mode 和 manifest。
- [ ] 重复 verify 不改变数据；带错误 hash 的 restore 不改变目标。
- [ ] verify-foundation.sh 顶部明确 disposable-only，并在非空/retained runtime 上 fail-closed；不得让 retained 流程调用 dev-reset.sh。

验证命令：

    bash scripts/test-runtime-backup-restore.sh
    bash scripts/test-runtime-candidate-stage.sh
    bash scripts/test-verify-foundation-preflight.sh
    bash scripts/static-check.sh
    npm run check
    git diff --check

**回滚：** 回退工具代码不会删除已生成快照或 rollback 目录；清理由用户另行明确批准。脚本没有自动删除现有 runtime 的路径。

**完成判据：** A5.3全部RED变GREEN；V3/V9、两层capability receipt、停服前preflight、stop lease、exact replay、candidate stage/manifest、atomic exchange crash窗口与false/true两种rollback asset路径都有自动证据。V3 legacy无附件根只在显式schema entry下成功；任一失败不覆盖目标、不提前停服务、不启动错误image，且A5不依赖未来C1产物。

## 3. Task A6：把文档校正为当前运行事实

**建议分支：** codex/document-current-platform-truth

**依赖：** A1–A5 已合入并有最新证据。

**修改文件：**

- AGENTS.md
- README.md
- apps/gateway/README.md
- docs/superpowers/specs/2026-08-13-deep-review-remediation-design.md
- docs/development/roadmap.md（若存在）
- `/home/youran/data/service-ports.md`（只在现场端口 owner/健康事实漂移时条件修改）
- `/home/youran/data/service-ports.json`（与上一项同次、同事实条件修改）
- `/home/youran/data/agent-architecture.md`（只在 Gateway/Hermes controller 边界事实漂移时先读后条件修改）
- 本执行包、总计划和开发记录

### A6.1 先建立只读事实矩阵

对 Session、配对、Member Web、Admin Web、附件、真实/Fake Provider、重启恢复、LAN Preview、正式 8790 分别填写四列：

| 能力 | 源码存在 | 自动化通过 | 隔离 Preview 验收 | 正式 8790 已部署 |
|---|---|---|---|---|

证据来源固定为：

- 源码/测试：最新 main SHA 和该 SHA 的 CI；
- Preview：验收报告中的 project、image digest、Schema、时间和命令；
- 正式：只读查询 container/systemd owner、PID、cwd、image ID/digest、创建时间、Schema、listener 与 health identity；
- 无证据的格子写“未验证”，禁止从本地源码推断正式运行物。

读取正式事实不能停止、重启或修改服务。若权限不足，记录未知，不猜测；已被新证据证伪的旧台账不能原样保留为当前事实。

2026-08-13 只读快照仅用于提醒实施者刷新：8790 的实际 owner 是旧 Docker Compose container，健康身份正常，正式 Schema 为 V3，正式 runtime 没有附件目录是旧 Schema 的合法事实；system/user family-ai-gateway.service 都不是 listener owner。service-ports 与 agent-architecture 的 controller/PID 描述存在漂移。A6 必须用实施当天的新只读证据校正“当前旧部署”的 controller/listener/Schema/health provenance；不能照抄这份旧 PID，也不能提前把候选写成已部署。

### A6.2 文档 RED 与修改

- [x] 先用 rg/static-check 建立冲突清单：README 用单一“完成”覆盖四层事实，Gateway README 仍只描述旧 Foundation/Fake Provider，运维台账误写 systemd owner。
- [x] AGENTS 保留全部安全不变量，改写当前代码阶段、仍禁止范围和正式部署 Gate。
- [x] 根 README 分开描述“代码具备、CI 通过、Preview 验收、正式部署”，不再用一个“完成”覆盖四种事实。
- [x] Gateway README 更新真实模块职责、Session/配对/附件/Provider 和 retained/disposable 区别。
- [x] verify-foundation.sh 明确会重置 disposable runtime；正式数据升级只链接 release-and-rollback.md。
- [x] 旧设计只增加接续链接，不把历史文档改写成当时已有的新方案。

验证命令：

    bash scripts/static-check.sh
    npm exec --workspace @family-ai/gateway -- vitest run test/memberWebOneClick.test.ts test/memberPreviewScripts.test.ts --maxWorkers=1 --no-file-parallelism
    rg -n '暂不开发|已完成|已部署|真实产品|dev-reset' AGENTS.md README.md apps/gateway/README.md docs
    git diff --check

**运维台账：** A6 不把未发布代码写进 service-ports 或 agent-architecture，但必须修正经实施时只读证据确认的当前旧部署事实。若 8790 的 owner/controller/健康说明有误，同次更新 `/home/youran/data/service-ports.md` 与 `service-ports.json`；若 Hermes/Gateway controller 边界描述有误，先读后更新 `agent-architecture.md`。只写旧 deployment 的实测值、证据时间和“候选未部署”，不写未来镜像/Schema。权限不足则把字段明确标成 unknown/待核，不能保留已证伪值。

**回滚：** 文档可回退，但不能恢复为已被证据否定的运行声明；若事实源变化，重新取证并更新矩阵。

**完成判据：** 三份权威入口和运维台账对每项能力的四层状态表述一致；当前旧部署的 controller/listener/Schema 没有已知假值，后续 Agent 不会因“暂不开发/已经正式部署”的矛盾做错边界判断。

## 4. Task E0：正式运行定义与 Provider 宿主边界

**建议分支：** `codex/production-runtime-definition`

**依赖：** A5、B1b、C1、D1 已合入。该任务只建立可复现的 template/renderer/validator 和隔离验证，不冻结最终候选、不部署、不停止或重启正式 `127.0.0.1:8790`。E0 测试产物使用合成 artifact；E2 必须从最终 SHA 重新生成 template set，F1 再用私有 descriptor 实例化并把 instance hash 纳入批准 fingerprint。

**新增/修改文件：**

- 新增 `compose.production.yaml`
- C1 已建立的 `compose.rollback-recovery.yaml`
- C1 已建立的 `Dockerfile.rollback-recovery`
- C1 已建立的 `scripts/rollback-recovery-server.mjs`
- C1 已建立的 `scripts/build-rollback-recovery-image.sh` 与测试 wrapper
- 新增 `config/production-runtime-descriptor.schema.json`
- 新增 `config/production-runtime.example.json`（只含占位符和固定容器目标）
- 新增 `scripts/production-runtime-render.mjs`
- 新增 `scripts/production-runtime-preflight.sh`
- 新增 `scripts/test-production-runtime.sh`
- 新增 `scripts/provider-config-validate.mjs`
- `apps/gateway/src/config.ts`
- `apps/gateway/src/providerWorkerConfig.ts`（若 D1 未建立等价模块）
- `apps/gateway/src/releaseMode.ts`（若 D1 未建立等价的维护态/验收能力校验）
- `apps/gateway/test/config.test.ts`
- `apps/gateway/test/chatWorkProvider.test.ts`
- 新增 `apps/gateway/test/releaseMode.test.ts`
- `.gitignore`、`.dockerignore`、`scripts/static-check.sh`
- `docs/operations/release-and-rollback.md`、Gateway README、本执行包、总计划和开发记录

### E0.1 私有 descriptor 与固定渲染结果

仓库中的 example 不得出现现场路径或 secret。实施/发布时，操作者在 Git ignored、`0700` 目录中创建 `0600` descriptor，最小结构固定为：

    {
      "formatVersion": 1,
      "releaseId": "<safe-id>",
      "scope": "formal-production|fixture-rehearsal|prepare-copy",
      "bindPolicy": "formal-8790|random-loopback",
      "currentRuntimeDataSource": "<absolute-existing-dir>",
      "candidateStaging": {
        "parent": "<absolute-existing-same-filesystem-parent>",
        "basename": "<safe-new-basename>"
      },
      "releaseControlSource": "<absolute-0700-dir>",
      "image": {
        "id": "sha256:<docker-config-id>",
        "repoDigest": "<name>@sha256:<registry-manifest-digest>|null",
        "archive": "<absolute-tar>",
        "archiveSha256": "<64-hex>"
      },
      "rollbackClient": {
        "bundle": "<absolute-sealed-tar>",
        "bundleSha256": "<64-hex>",
        "manifest": "<absolute-0600-json>",
        "manifestSha256": "<64-hex>",
        "materializedRoot": "<absolute-read-only-dir>",
        "materializationReceipt": "<absolute-0600-json>"
      },
      "rollbackGuardImage": {
        "id": "sha256:<docker-config-id>",
        "archive": "<absolute-tar>",
        "archiveSha256": "<64-hex>",
        "revision": "<40-hex>"
      },
      "clientStorage": {
        "databaseNameScheme": "identity-scoped-v2",
        "candidateDatabaseVersion": 4
      },
      "hermes": {
        "runtimeSource": "<absolute-dir>",
        "runtimeSha256": "<64-hex-tree>",
        "executableRelative": "<safe-relative>",
        "jarvisHomeSource": "<absolute-dir>",
        "personalHomeSource": "<absolute-dir>",
        "profiles": ["<allowlisted-name>"],
        "homeAccess": "exclusive|shared-approved",
        "approvalRef": "<required-for-shared-approved>"
      },
      "codex": {
        "runtimeSource": "<absolute-dir>",
        "runtimeSha256": "<64-hex-tree>",
        "executableRelative": "<safe-relative>",
        "homeSource": "<absolute-dir>",
        "workingDirectorySource": "<absolute-dedicated-dir>",
        "homeAccess": "exclusive|shared-approved",
        "approvalRef": "<required-for-shared-approved>"
      }
    }

固定容器目标不能由 descriptor 改写：

| 宿主来源 | 容器目标 | 权限 |
|---|---|---|
| candidateStaging.parent/basename 解析出的全新路径（仅 migration） | /app/.runtime/data | rw |
| currentRuntimeDataSource（仅 validation/acceptance/active） | /app/.runtime/data | rw |
| releaseControlSource | /run/family-ai-release | ro |
| rollbackClient 已验证 materializedRoot（只在独立 guard；tar 不可直接挂载） | /srv/recovery | ro |
| Hermes runtimeSource | /providers/hermes-runtime | ro |
| Jarvis Home | /providers/hermes-jarvis-home | rw |
| Personal Home | /providers/hermes-personal-home | rw |
| Codex runtimeSource | /providers/codex-runtime | ro |
| Codex Home | /providers/codex-home | rw |
| 专用 Codex workspace | /providers/codex-workspace | rw |

禁止挂载 `/`、宿主 home 根、`/home/youran/Development` 根、Docker socket、SSH/Git credential 目录或 descriptor 未列出的路径。`currentRuntimeDataSource`必须已存在；candidate staging以canonical parent+safe basename确定，要求与current同父/同文件系统、目标事前不存在且不能是current/parked/snapshot/release root。renderer只把确定性staging路径写入migration定义，不创建目录；A5 candidate-stage是唯一创建者并逐字核对CLI的target-parent/output-name、descriptor和migration definition。其余runtime/executable必须由两遍树清单验证为regular file/dir、非符号链接逃逸、owner/mode合法且hash匹配。`releaseControlSource`只允许固定名称的`acceptance-state.json`、旁置hash与公开commit receipt，目录`0700`、文件`0600`，容器只读。Home/workspace可能包含凭据，只允许运行时bind，不进入镜像、Git、CI artifact、manifest明文字段或日志。`shared-approved`必须带本次发布审批引用和并发安全证据；没有时只允许`exclusive`。

本文统一把 Docker `image ID` 定义为 `docker image inspect --format '{{.Id}}'` 返回的 config content digest，它在本地 build/load 后必有且为强制身份；`repoDigest` 只在镜像确实来自 registry 且 `RepoDigests` 存在时记录，可为 null，绝不能用可变 tag 冒充。A4 后构建的 candidate、fixture baseline、E2 和 CI 镜像强制同时绑定 image ID、archive SHA-256 与 OCI revision label。唯一例外是 A5/F1 对发布前已经在运行且确实无 label 的旧 retained image 做 `legacy-unknown-revision` 备份；该例外只是不伪造未知 Git SHA，不放宽 image ID/archive/created/controller/config provenance，也不能用于候选启动。提到“digest”但未写 repo 的地方均指 image ID/config digest。

`production-runtime-render.mjs` 固定两阶段接口：

    node scripts/production-runtime-render.mjs template --artifact-manifest <absolute-final-artifacts-json> --output-root <absolute-new-empty-dir> --report <absolute-new-json>
    node scripts/production-runtime-render.mjs instance --template-set <absolute-template-set-json> --descriptor <absolute-0600-json> --output-root <absolute-new-empty-dir> --report <absolute-new-json>

template 阶段只允许类型化 token，不含宿主路径；E2 从同一 final SHA 的 Gateway/guard/bundle/capability receipt生成并封口。instance 阶段是唯一可启动输出；E2 用 rehearsal descriptor实例化，F1 用formal descriptor在批准前实例化。输出目录固定包含：

    modes/migration/gateway.env
    modes/migration/compose.production.rendered.yaml
    modes/migration/service-definition.json
    modes/migration/service-definition.sha256
    modes/validation/gateway.env
    modes/validation/compose.production.rendered.yaml
    modes/validation/service-definition.json
    modes/validation/service-definition.sha256
    modes/acceptance/gateway.env
    modes/acceptance/compose.production.rendered.yaml
    modes/acceptance/service-definition.json
    modes/acceptance/service-definition.sha256
    modes/active/gateway.env
    modes/active/compose.production.rendered.yaml
    modes/active/service-definition.json
    modes/active/service-definition.sha256
    rollback/compose.rollback-recovery.rendered.yaml
    rollback/recovery-definition.json
    rollback/recovery-definition.sha256
    service-definition-instance-set.json
    service-definition-instance-set.sha256

四份candidate `gateway.env`与rendered Compose均为`0600`，允许包含实际bind source/运行环境，只能进入A5受保护的`payload/controller`。scope/bind组合固定：formal-production只能formal-8790；fixture-rehearsal/prepare-copy只能random-loopback。`migration`是独立离线定义：固定command=`node apps/gateway/dist/migrate.js`、`network_mode:none`、无publish/health HTTP、无Provider Home/workspace/release-control、worker disabled，只把descriptor确定的全新candidate staging路径挂为data；不得拿validation定义代替，也不得指向current。其余三份定义只把`currentRuntimeDataSource`挂为data，并由受跟踪typed mode matrix确定差异：validation=`maintenance:validation/worker:disabled`且只连接`internal:true`无egress网络、按bindPolicy发布loopback；acceptance=`maintenance:acceptance/worker:acceptance-only`与active=`maintenance:off/worker:enabled`共享同一批准Provider网络/挂载，只有两个mode env不同。除matrix明确允许的mode/network差异外，image、mount、profile、security options和其他env必须字节级一致。prepare-copy controller只能启动migration/validation，禁止acceptance/active；fixture只能使用本地可计数/可故障注入的Fake Provider，固定零外部网络、零真实Provider配置/凭据和零计费请求，“无计费测试Provider”不得替代；formal才可在R3批准后启动acceptance/active。原子交换后current路径才承载candidate inode，运行定义无需改字节；staging路径变成parked previous且绝不再由migration定义启动。rollback recovery是第五个独立definition：只绑定专用guard image、materialized recovery目录/receipt、固定ro`/srv/recovery`和loopback publish；不得包含previous/candidate runtime mount、SQLite、附件、Provider Home、release control、业务env或API proxy。instance set记录templateSetSha256、releaseId、scope/bindPolicy、共享candidate identity、current/staging canonical identity、typed mode matrix hash、migration/validation/acceptance/active definition hash和rollbackRecoveryDefinitionSha256；私有instance可含路径，只进0600 release root。

同一 template/artifact manifest必须字节级生成相同template hash；同一template+descriptor必须字节级生成相同instance hashes，时间戳另写report。`databaseNameScheme`只接受`identity-scoped-v2`；descriptor不声明source/current client version，current/legacy provenance只能由A5/E2/F1 source preflight读取，避免用不存在字段校验。rollback bundle/guard Git SHA必须等于candidate revision，supported versions必须覆盖release capability声明的candidate version；source版本另由formal preflight核对。materializedRoot/receipt必须由A5安全materializer产生；tar路径直接作为mount、额外/rw mount、非loopback、业务env或backend network立即失败。

`rollback-recovery-server.mjs` 是无框架最小静态进程，只注册 `/health`（固定公开 body `service=family-ai-rollback-recovery`）、`/member`/`/member/` 和 sealed manifest allowlist 中的 `/member/<asset>`；`/api/*`、`/admin/*`、未知路径与非 GET/HEAD 方法统一拒绝，不反代任何 upstream。构建脚本必须复用 A4 的 revision/image-ID/archive 语义，固定 base digest并输出 config image ID、archive hash、OCI revision；Dockerfile 不 COPY Gateway 源码/dependencies，不包含 shell/curl，non-root、read-only root 下运行。它不能读取 DB，也不能声明 Provider/业务配置。

### E0.2 Gateway 配置与 worker 开关

production env 的最小 key 固定为：

    NODE_ENV=production
    FAMILY_AI_PROVIDER_MODE=real
    FAMILY_AI_PROVIDER_WORKER_MODE=enabled|disabled|acceptance-only
    FAMILY_AI_MAINTENANCE_MODE=off|validation|acceptance
    FAMILY_AI_RELEASE_ACCEPTANCE_STATE_PATH=/run/family-ai-release/acceptance-state.json
    FAMILY_AI_RELEASE_ACCEPTANCE_STATE_SHA256_PATH=/run/family-ai-release/acceptance-state.sha256
    FAMILY_AI_HERMES_EXECUTABLE=/providers/hermes-runtime/<relative>
    FAMILY_AI_HERMES_JARVIS_HOME=/providers/hermes-jarvis-home
    FAMILY_AI_HERMES_PERSONAL_HOME=/providers/hermes-personal-home
    FAMILY_AI_HERMES_PROFILES=<allowlist>
    FAMILY_AI_CODEX_EXECUTABLE=/providers/codex-runtime/<relative>
    FAMILY_AI_CODEX_HOME=/providers/codex-home
    FAMILY_AI_CODEX_WORKING_DIRECTORY=/providers/codex-workspace

B1b 已验证的 Hermes 私密输入模式也必须显式出现；缺失时 production fail-closed。`config.ts` 要把 Codex `HOME/CODEX_HOME`、Hermes `HOME/HERMES_HOME` 和 B1b 所需变量逐项加入 Adapter allowlist，不能透传整个 Gateway environment。相同 Provider external session 的 Agent/Profile 隔离规则不变。

`FAMILY_AI_PROVIDER_WORKER_MODE=disabled`只用于config validation、正式数据副本迁移/健康smoke和人工诊断：D1 worker不claim operation，消息提交路由返回稳定`PROVIDER_WORKER_DISABLED`，且不得调用任何Provider。该开关不能回退到Fake Provider，也不能改变数据库状态。F1 preflight必须拒绝缺migration/validation/acceptance/active/rollback任一definition、scope/bind/mode/network matrix错误，或三份运行Gateway definition出现matrix未允许的漂移；不再要求R2直接用active/enabled启动。

`maintenance=validation`时所有业务mutation返回503，worker disabled，只允许真正无写读取。`maintenance=acceptance`只接受绑定controllerGenerationId且Session精确匹配subject的capability；其他503。acceptance worker初始unarmed，每次claim/attempt前重读state+hash，只能claim armed refs且已有durable commit；身份/预算/lane必须精确，不claim旧operation。

acceptance state 是 Git ignored 的 `0600` JSON，固定写到宿主 `releaseControlSource/acceptance-state.json`，以同目录临时文件→fsync→rename→目录 fsync 原子更新，旁置 `acceptance-state.sha256`；validation/acceptance/active definition均只固定相同ro目录mount和两个env路径，**controllerGenerationId不写入definition**，因此获批instance hash不因R3 generation生成而变化。字段固定为stateVersion、releaseId、controllerGenerationId、capabilityHash、familyRef、personRef、deviceRef、entryBindingRef、agentRef、providerProfileRef、acceptedAfter、maxProviderInvocations、maxAttachmentBytes、budgetCeiling、retentionPolicy、externalSessionPolicy（第一版只允许`dedicated-new-thread`）、expiresAt、approvalReceiptSha256、armedOperationRefs、externalSideEffectCommitSha256；不保存capability明文。R3 receipt绑定实际generation与state hash；同一acceptance definition的受控Gateway重启保持同generation/capability，切换validation/active或重新批准时只原子轮换inactive/acceptance state并使旧capability失效，不能改definition。process identity只记审计。validation/active使用空armed list的inactive state；字段/hash/commit/subject/budget任一不符fail-closed。capability明文只在release runner内存/0600一次性文件，由浏览器harness注入，禁止日志/trace/HAR。

mode切换固定为“批准instance + 受控重建controller”：R2 validation，R3 acceptance，验收receipt后active。三步核对同一candidate/template/instance链，全程单owner；active只在durable intent后出现。

`provider-config-validate.mjs` 固定接口：

    node scripts/provider-config-validate.mjs --env-file <absolute-0600-file> --mode parse-only --report <absolute-new-json>

parse-only 只加载/验证路径、profile、环境 allowlist 和 Adapter 构造参数；不得打开/迁移 SQLite、监听端口、启动 worker、spawn CLI 或联网。报告只含 mode、provider profile refs、key allowlist、路径内容 hash 和公开错误码。

### E0.3 Compose 安全不变量

`compose.production.yaml` 必须：

- 使用精确 image ID/digest，不含 `build:`、`latest` 或其他可变 tag；
- `user` 为传入且已验证的非 root UID:GID，`read_only: true`，`security_opt: no-new-privileges:true`，`cap_drop: [ALL]`；
- 只给 `/tmp` 最小 `tmpfs`，只挂当前 mode 在上表允许的目标；rollback client mount 只允许出现在独立 guard definition；不 privileged、不 host PID/IPC、不 Docker socket；
- formal-production只发布`127.0.0.1:8790`；fixture-rehearsal/prepare-copy只使用`127.0.0.1::8790`随机宿主端口。validation连接internal无egress网络；acceptance/active只有formal-production+对应R3/active state才允许批准的Provider网络，prepare-copy永远禁止启动这两种mode；
- healthcheck 不输出 env、路径、Profile 或 Provider 错误正文；
- graceful stop 时间大于 D1 worker drain 上限；worker 超时后保留 running/indeterminate 语义；
- E2 final template set、A5快照中的实际 instance和F1批准 fingerprint必须形成可追溯链；F1只允许用E0 renderer从E2 template+批准descriptor实例化，禁止临时拼另一套overlay或就地改env。
- rollback recovery controller只能把A5已验证、已materialize的只读目录挂到`/srv/recovery`，不能直接挂tar；使用专用guard且不与Gateway双占listener，不得挂runtime、DB、附件、Admin assets、Provider Home/release control或backend network。

### E0.4 RED 与隔离验收

`test-production-runtime.sh` 先覆盖：

- [ ] relative/root/home/Development 根、symlink、owner/mode 过宽、source hash 漂移、runtime/home/workspace 重叠；current不存在、staging已存在/不同文件系统/与current或reserved path相同，以及candidate-stage CLI parent/name与descriptor/migration定义不一致；
- [ ] 缺 image archive/digest、archive load 后 ID 不符、descriptor/profile 非 allowlist、shared-approved 无 approvalRef；
- [ ] template/instance renderer两次结果不一致、公开template set/manifest/report/log含宿主绝对路径、或private env/Compose权限不是0600；私有instance必须反向证明每个absolute bind source精确来自descriptor canonical path；
- [ ] Compose出现build/latest、root user、可写root、额外mount、0.0.0.0、privileged/capability；scope/bind非法、validation可egress、prepare-copy可启动acceptance/active、fixture可用真实计费Provider，或acceptance/active的Provider网络漂移；
- [ ] parse-only 意外打开 DB、监听、spawn 或联网；
- [ ] worker-disabled 仍 claim operation/调用 Provider，或 enabled 缺真实 Provider 配置仍启动；
- [ ] validation 模式发生任一业务写入；acceptance 模式无 capability/错误 subject 仍可写；state path/mount/hash/批准字段任一缺失仍启动；acceptance-only 在 unarmed 或 external commit receipt 前 claim，或 claim 旧 operation、超预算 operation、其他 Agent/Profile；
- [ ] 五定义集缺migration/validation/acceptance/active/rollback任一项；migration会启动HTTP、publish端口、挂Provider/release-control、联网或不是固定migrate command；其余三Gateway mode组合、typed network matrix不正确或存在matrix外差异；
- [ ] rollback bundle/manifest/hash/SHA/version range/CSP/static root 或 guard image ID/archive/revision 任一漂移；guard 出现额外/rw/业务数据 mount、API proxy、backend network、非 loopback bind，或与任一 Gateway 双 owner，必须在任何正式 stop 前失败；
- [ ] descriptor 企图提供具体 IndexedDB 名称/identity ref、databaseNameScheme 非固定值，或 recovery client 通过拆冒号猜 identity；必须改用枚举 + meta.context 反算精确名字，伪造/mismatch/legacy unscoped 库只计数隔离且不泄露 refs；
- [ ] 在 validation→acceptance、acceptance→active 的 stop 前/后和 start 前/后崩溃；resume 必须维持单 owner，不短暂开普通 mutation，不让 worker 越界 claim，active 只能在验收 receipt 已 durable 后出现；
- [ ] acceptance同definition重启时process identity改变但state中的controllerGenerationId/capability保持有效且预算/armed refs不重置；修改definition会使批准失效，切换mode/新批准只轮换state并使旧generation capability立即失效；
- [ ] `CODEX_HOME` / `HERMES_HOME` 未进入精确 allowlist，或 Gateway 其他 secret 被透传。

隔离验证命令：

    bash scripts/test-production-runtime.sh
    node scripts/production-runtime-render.mjs template --artifact-manifest <synthetic-artifacts> --output-root <mktemp-template> --report <new-json>
    node scripts/production-runtime-render.mjs instance --template-set <mktemp-template/set.json> --descriptor <synthetic-0600-descriptor> --output-root <mktemp-instance> --report <another-new-json>
    docker compose -f compose.yaml -f compose.production.yaml -f <rendered> config --quiet
    bash scripts/production-runtime-preflight.sh --definition-set <service-definition-instance-set.json> --mode isolated-no-egress --report <new-json>
    bash scripts/production-runtime-preflight.sh --definition-set <service-definition-instance-set.json> --mode isolated-loopback --host-port 0 --report <another-new-json>
    npm run check
    bash scripts/static-check.sh
    git diff --check

自动 smoke 拆成两个互不冒充的阶段：`isolated-no-egress` 使用 mktemp 数据、合成 Hermes/Codex executable、`worker-disabled`、`network_mode:none`，不发布任何宿主端口，只用容器 healthcheck/`docker inspect` 证明配置可解析、进程 non-root/read-only、附件目录可写且无 spawn/egress；`isolated-loopback` 使用独立 internal bridge 与随机 `127.0.0.1` 宿主端口做 HTTP health，不能设置 `network_mode:none`。两阶段都核对正式 `8790` before/after identity 不变，不宣称真实 Provider 可用。

真实 Hermes/Codex 能力只在用户知晓成本和隐私边界后，由受控人工 probe 发送合成无隐私 marker；probe 结果只记录 profile、公开状态、时间和 hash，不记录 prompt/output/session ref。若实际采用 shared Home，先只读核对并发支持和服务 PID；E0 不重启 Hermes。

**文档与台账：** Gateway README 记录 descriptor、worker-disabled 和正式/隔离区别；开发记录写测试统计及真实 probe 是否执行。没有实际部署或端口变化时不改 `service-ports`；已读 `agent-architecture.md` 但 E0 只写候选定义，不能把它更新成运行事实。

**回滚：** 回退 Compose/renderer/config 代码；保留任何受保护 descriptor/output 供人工审计，不自动删除 Home/runtime。E0 未部署，所以不做服务或数据回滚。

**完成判据：** E0提供确定性template/instance renderer和校验器；合成artifact可生成validation/acceptance/active与独立guard instance并通过隔离验证，但不得称它为最终候选。E2可从后续final SHA重新生成template set，F1可从该set+私有descriptor实例化；guard只挂materialized目录、零业务mount/backend network。任何路径、hash、权限、mode、镜像、挂载或owner漂移在启动前失败。

## 5. Task E1：真实浏览器发布门禁

**建议分支：** codex/browser-release-gates

**依赖：** A4、C2、D2 已合入。

**修改文件：**

- playwright.config.ts（复用 C2 已锁定 runner，只增加 release project）
- 新增 browser/release-journey.spec.ts
- 新增 scripts/browser-release-smoke.sh
- 新增 scripts/test-browser-release-smoke.sh
- scripts/install-browser-runner.sh
- scripts/sanitize-browser-report.mjs
- compose.browser-smoke.yaml
- .github/workflows/ci.yml
- scripts/static-check.sh
- AGENTS.md
- Gateway README、本执行包、总计划和开发记录

### E1.1 Runner 与隔离边界

- [ ] 先证明 C2 锁定的 exact `@playwright/test`、lockfile Chromium revision、install script、config、compose 和 sanitizer 均存在且可复现；E1 不重新挑版本。若官方安全/兼容变化必须升级，先作为独立依赖 PR 合入，再从新 main 开 E1，不能在门禁 PR 临场漂移。
- [ ] browser-release 在自己的 runner 下载 A4 固定容器`gateway-image-<github.sha>`，内部只接受`gateway-image.tar`、`gateway-image.tar.sha256`、`gateway-image-manifest.json`；先校验容器名/三文件/commit/hash，再load并核对image ID。禁止重建、拉可变tag或假设needs共享daemon。
- [ ] 使用独立 mktemp runtime、Compose project、network 和当前 SHA digest；以 127.0.0.1 随机端口发布，运行前后都证明正式 8790 identity/PID 未变化。
- [ ] Provider 只能是同一隔离 Compose project 内、可计数且可故障注入的本地 Fake Provider；Provider/Gateway 测试网络禁止外部 egress，fixture 不挂载或注入任何 Hermes/Codex Home、真实 Provider endpoint/API key/credential/config。启动前检查 env/mount/network allowlist，旅程后断言外部连接尝试与计费请求均为 0；“无计费测试 Provider”不能替代这些证明。
- [ ] 配对材料从 0600 临时文件读入 runner 内存；claim 后立即清除 URL fragment。禁止把 handoff URL、Cookie、Authorization、数据库、trace/network body 上传。
- [ ] 失败 artifact 只能是经过 sanitize-browser-report.mjs allowlist 后的统计、公开错误代码、image digest 和脱敏截图；原始 trace/HAR 仅留在 Git ignored 的本地 0700 临时目录，CI 结束即清除。

### E1.2 先写 RED 旅程

release-journey.spec.ts 用两个全新、互不复用数据库、浏览器存储或 Compose project 的隔离用例验证。正常用例依次执行：

1. 通过正式 pairing/Entry Session 路径进入 Member Web；
2. 发送第一轮消息并等待唯一一条成功 Assistant Message，Agent 绑定正确；
3. 上传三分片附件，在第二片后模拟离线，刷新，再只续传缺片；
4. 发送第二轮消息并故意丢弃该次 202 响应，刷新后 outbox 按原 idempotency key/请求 hash 查询原 operation，不重复 POST；
5. 页面刷新后消息、草稿、附件和 operation 状态恢复，并等待第二条成功 Assistant Message；
6. 重建 Gateway 容器，复用同一临时 data/attachments；
7. 重连后发送第三轮并等待第三条成功 Assistant Message，下载之前附件并核对 SHA-256；
8. 精确断言 3 条 Person Message、3 条 Assistant Message、3 次本地 Fake Provider 调用、0 个 `indeterminate` Operation，且三轮的 message/operation/idempotency key 均没有重复；
9. 桌面与移动视口均无 console/page error、横向溢出，Enter、Shift+Enter、IME 和键盘焦点通过。

第二个命名故障用例只验证 D1 的外部副作用崩溃边界：在全新 runtime 中让本地 Fake Provider 记录一次模拟外部成功后、Gateway 持久化 Assistant 结果前崩溃；重启后精确断言 1 条 Person Message、0 条 Assistant Message、1 次本地 Fake Provider 调用、1 个 `indeterminate` Operation，并证明观察/刷新不会自动重调。两个用例的计数分别写入报告，禁止把故障用例的 `indeterminate` 算作正常三轮回复。

E1 不改产品行为，不能伪造一个“产品 RED”。先为CI/wrapper契约写fixture test并运行：

    bash scripts/test-browser-release-smoke.sh contract

该模式只解析mktemp中的合成workflow/artifact manifest，预期因browser-release job、固定三文件契约或wrapper参数链缺失而RED；同时必须用正反fixture证明Provider endpoint只指向本Compose project的Fake service、Provider/Gateway网络无外部egress、env/mount allowlist排除真实Provider配置/凭据/Home，并拒绝任一真实endpoint、egress网络、真实配置变量或宿主Provider挂载。Docker/Chromium/服务都不是前置，环境缺失不能冒充RED。最小contract实现GREEN后，调用方先单独用A4 builder生成exact commit artifact，再把已存在的manifest交给只消费、不重建的本地journey wrapper：

    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>

    bash scripts/test-browser-release-smoke.sh journey --image-manifest <absolute-gateway-image-manifest.json>

它内部执行`npm exec playwright test browser/release-journey.spec.ts --project=release-chromium`；若C2/D2行为已正确，首次集成旅程允许直接成为characterization GREEN，但必须记录这一事实，不能谎称先失败。真实journey失败只能来自上述正常九步或独立故障用例断言，不能来自runner未安装或服务未启动。

### E1.3 CI job 与验收输出

新增 browser-release job，依赖 docker-build 和 container-smoke，单独 25 分钟超时。job 先用固定 commit 的 download-artifact action取得 gateway-image-<github.sha>，校验随附 SHA-256，docker load 后把精确 image ID 传给 browser-release-smoke.sh。输出固定为 docs/acceptance/runtime/browser-release-report.json（Git ignored）：

- git SHA、image digest、Schema、浏览器版本；
- 每一步 passed/failed、开始/结束时间；
- 测试文件数和用例数；
- 按正常/故障用例分别记录 Provider 调用计数、Person/Assistant/indeterminate Operation/attachment 数量；
- console/page error 数量；
- 正式 8790 before/after identity hash。

报告不得含消息正文、附件名、Token、Cookie、绝对路径或 stderr。

`browser-release-smoke.sh` 固定接口：

    bash scripts/browser-release-smoke.sh --image-ref <immutable-id> --runtime-dir <absolute-empty-mktemp-dir> --report-dir <absolute-new-dir> --project-name <safe-unique-name> --host-port 0

无参数或可变 tag 必须在创建资源前 fail-closed。CI 直接传入已从同 SHA artifact 校验/load 的 image ID，并用 C2 install script 安装 lockfile 对应 Chromium。`test-browser-release-smoke.sh` 是本地消费 wrapper：`journey` 模式强制接收调用方预先生成的 `--image-manifest`，校验 manifest kind/source commit、相邻 archive/SHA 文件、archive hash、load 后的 image ID 和 40 位 OCI revision label，复用 C2 runner/config/compose/sanitizer，创建新 mktemp runtime/report/project，再把不可变 image ID 传给 `browser-release-smoke.sh`；它不得调用 A4 builder、复用正式 runtime 或直接信任 foundation tag。contract fixture 必须证明“传 manifest 时发生 builder 调用”会失败。

验证命令：

    npm ci
    npm run check
    bash scripts/test-browser-release-smoke.sh contract
    bash scripts/build-gateway-image.sh --source-commit "$(git rev-parse HEAD)" --expected-source-commit "$(git rev-parse HEAD)" --output-dir <absolute-new-empty-dir>
    bash scripts/test-browser-release-smoke.sh journey --image-manifest <absolute-gateway-image-manifest.json>
    bash scripts/static-check.sh
    git diff --check

远端最新 SHA 的 quality、audit、docker-build、container-smoke、browser-release 必须全部通过。

**回滚：** workflow、runner 与依赖作为同一提交回退；不得仅把 browser job 改为非阻断。若浏览器版本暂时不可用，发布保持阻断。

**完成判据：** AGENTS 要求的正常三轮精确得到 3 条 Person Message、3 条 Assistant Message、3 次本地 Fake Provider 调用且 `indeterminate=0`；独立故障用例精确得到 1/0/1/1 并证明不自动重调。contract和运行报告同时证明零外部egress、零真实Provider配置/凭据/Home挂载、零外部连接尝试和零计费请求。刷新、容器重启、附件续传与丢失 202 响应均自动化；本地和 CI 都只消费 A4 同 SHA artifact，正式 8790 全程未被触碰。

## 6. Task E1F：正式发布控制器工具冻结

**建议分支：** codex/formal-release-controller-foundation

**依赖：** A5、E0、E1 已合入。该任务只在mktemp fixture/模拟controller上实现和验证正式发布工具；不读取、停止、备份、迁移或启动正式8790，不请求R1/R2/R3批准。

**新增文件：**

- scripts/formal-release-inspect.sh
- scripts/test-formal-release-inspect.sh
- scripts/release-approval-receipt.mjs
- scripts/test-release-approval-receipt.mjs
- scripts/release-controller.sh
- scripts/release-cutover.sh
- scripts/release-state.mjs
- scripts/test-release-cutover.sh
- 修改 scripts/release-build-inputs.json、scripts/runtime-tool-manifest.mjs及其fixture/test
- 本执行包、总计划和开发记录
- 本执行包、总计划和开发记录

本Task实现第8节F1列出的**完整固定接口和状态机**，F1只执行它们，不再新增发布代码。A4的release-build-inputs必须把上述脚本、Git mode/type、测试和直接调用的A5/E0 helper列为运行build input；A5 runtime-tool-manifest扩展为封口这些文件。E1F merge commit加入E2 required-tasks，E2 candidate manifest绑定其source commit、blob/mode/tree hash与测试证据。E2以后任何脚本、测试、helper、配置或mode变化都使候选过期，必须另立修复PR并从E2重新构建/演练；不得在F1现场热修脚本。

### E1F.1 RED

先用fixture写失败测试，分别证明当前缺少：

- [ ] formal/source preflight parent-child绑定、approvalContextRef防串票和四scope精确口令；
- [ ] prepare/final双快照、每Gate source/formal hash、controller generation与单owner durable state；
- [ ] current/staging双路径、migration-only staging、单syscall exchange intent/receipt和崩溃resume；
- [ ] unarmed处置fresh preflight与final snapshot restore preflight双输入，且二者不可互换；
- [ ] R1/R2 load-before-stop、stop evidence、worker-disabled/no-egress和R3 arm-before-claim边界；
- [ ] read-only recovery显式release root/materialization/new instance/handoff输出；
- [ ] 失败报告脱敏、0600/0700权限和输入不可覆盖。

RED只能操作mktemp runtime、随机loopback/none listener、Fake Provider和模拟controller。测试必须在任何资源创建前拒绝127.0.0.1:8790、仓库.runtime、已知正式runtime或非fixture scope；不能用脚本不存在、语法错误或Docker缺失充当行为RED。

### E1F.2 最小实现与验证

- [ ] `release-state.mjs`原子写+fsync，严格schema、phase CAS与resume；state不含secret、正文或绝对路径。
- [ ] inspect/approval只读或只写本轮0600 receipt；controller/cutover验证全部hash、inode、definition、tool manifest和批准scope后才允许fixture状态变化。
- [ ] runtime切换只调用A5 helper；迁移只调用migration definition；恢复只调用A5 restore；不得复制这些安全关键实现。
- [ ] test-release-cutover在stop、两次snapshot、candidate stage、exchange、mode切换、operation落库/arm、unarmed disposition、active/rollback每个窗口注入崩溃，证明唯一resume结果。
- [ ] fixture测试交叉混传prepare/cutover/activate/rollback-unarmed、fresh disposition/final restore两类preflight，以及current/staging路径；全部在写入/启停前fail-closed。
- [ ] static-check阻断xtrace、argv secret、相对/宽泛删除路径、两次rename、mutable tag、现场build/probe和F1临时脚本覆盖。

验证命令：

    npm ci
    node scripts/test-release-approval-receipt.mjs
    bash scripts/test-formal-release-inspect.sh
    bash scripts/test-release-cutover.sh
    bash scripts/test-runtime-backup-restore.sh
    bash scripts/test-runtime-candidate-stage.sh
    npm run check
    bash scripts/static-check.sh
    git diff --check

**回滚：** 可整PR回退，未触碰正式runtime。E2一旦以本Task为祖先冻结候选，就不能单独回退/修改；必须让候选失效并重跑E2。

**完成判据：** F1全部命令和崩溃恢复状态机已在合成fixture可执行、测试全绿并被build-input/tool manifest分类；正式8790/真实Provider均为SKIP+未获发布Gate。开发记录给出测试统计、接口版本、merge commit和未覆盖现场项。

## 7. Task E2：当前 Schema 不可变镜像与全量恢复演练

**建议分支：** codex/current-schema-release-rehearsal

**依赖：** A5、B4、D1、E0、E1、E1F、E3 已合入。B4必须为`disabled-verified`；E2冻结的候选不得早于B4/E1F/E3。H0/B1b未满足会经D1传递阻断本Task。

**修改文件：**

- 新增 scripts/release-preflight.sh
- 新增 scripts/release-rehearsal-work-copy.sh
- 新增 scripts/build-rehearsal-baseline.sh
- 新增 scripts/build-release-candidate.sh（编排A4 Gateway、C1 guard/bundle、A5 helper和E0 template renderer）
- 新增 scripts/release-candidate-input-lock.mjs
- 新增 scripts/release-rehearsal.sh
- 新增 scripts/test-release-preflight.sh
- 新增 scripts/test-release-rehearsal-work-copy.sh
- 新增 scripts/test-release-rehearsal.sh
- 新增 docs/fixtures/release-rehearsal-baselines.json
- 新增 docs/fixtures/release-candidate-required-tasks.json
- scripts/runtime-snapshot.mjs
- compose.release-rehearsal.yaml
- docs/operations/release-and-rollback.md
- 新增 docs/acceptance/release-rehearsal-v3-v9.json（固定 allowlist 脱敏摘要）
- 本执行包、总计划和开发记录

固定接口分三道，避免“preflight 依赖尚未构建的candidate、却又禁止build”的循环。第一道`release-candidate-input-lock.mjs`就是candidate-input preflight：只读校验required-task祖先、B4结果、exact source/expected commit、A4 build-input清单/tree hash、base/toolchain锁；它失败时零build。通过后只允许执行一次`build-release-candidate.sh`并封口artifact。构建后先用A5 materializer验证sealed bundle，在本轮0700 recovery root物化只读asset，再由E0 portable template渲染source instance set并写materialization receipt；这一步只写本轮临时root，不接触source runtime。第二道source preflight直接复用A5入口并绑定这些已存在的artifact/instance；失败时允许保留已封口artifact，但零load/migrate/start/target write：

    node scripts/runtime-backup-preflight.mjs --scope fixture-rehearsal --phase fixture-source-snapshot --release-id <safe-id> --runtime-root <absolute-copy> --controller-definition <absolute-file-or-dir> --capability-receipt <absolute-0600-json> --expected-capability-receipt-sha256 <64-hex> --source-image-role fixture-baseline --source-image-id <sha256:docker-config-id> --candidate-image-manifest <absolute-E2-candidate-manifest> --rollback-client-bundle <absolute-tar> --rollback-guard-image-archive <absolute-tar> --rollback-guard-image-id <sha256:docker-config-id> --rollback-recovery-template <absolute-portable-template> --rollback-recovery-instance-set <absolute-instance-set> --rollback-materialization-receipt <absolute-0600-json> --output <absolute-new-0600-json> [--legacy-attachments absent-if-schema-before-v8]

V3 fixture必须显式传`--legacy-attachments absent-if-schema-before-v8`且真实无附件目录；V9禁止传该参数。命令级RED分别证明“V3缺flag拒绝/V3带flag通过”和“V9带flag拒绝”。

停止隔离fixture时用该preflight hash和实际bind/`none` capture evidence，再由A5生成sealed snapshot。随后rehearsal preflight直接消费并绑定这份snapshot与E2 final artifact/template set：

    bash scripts/release-preflight.sh --scope fixture-rehearsal --release-id <safe-id> --capability-receipt <absolute-0600-json> --expected-capability-receipt-sha256 <64-hex> --source-preflight <absolute-0600-json> --source-snapshot <absolute-sealed-dir> --release-candidate-manifest <absolute-0600-json> --candidate-template-set <absolute-template-set.json> --atomic-helper-manifest <absolute-0600-json> --output <absolute-new-0600-json>

preflight证明snapshot的expectedPreflightSha256等于source-preflight hash，并把两层receipt、source snapshot/previous image、E2 candidate Gateway/guard/bundle、E0 final template set、A5 helper artifact与required-task input lock全部纳入fingerprint。任一字节替换或candidate build-input tree漂移都在启动前失败。它拒绝正式8790/runtime，也不能作为F1批准fingerprint。

E2冻结候选前先运行`release-candidate-input-lock.mjs`：`docs/fixtures/release-candidate-required-tasks.json`逐项列A1–A6、B1a/B1b、B2–B4、C1/C2、D1/D2、E0/E1/E1F/E3的实际merge commit与development evidence；脚本用`git merge-base --is-ancestor`证明全部是candidate source commit祖先，B4结果字段只能是`disabled-verified`。candidate source commit必须是E2分支上已提交、tracked build inputs干净的full SHA，且build-input tree的quality-tool分类必须绑定E3一致性脚本、测试和Git mode。构建后只允许追加本E2脱敏报告/计划状态，以及F1批准前显式allowlist的docs-only证据；`release-candidate-input-lock`记录的buildInputTreeHash必须与最终E2分支及F1时main的运行构建allowlist一致。任何源码、脚本、Git mode/type、Docker、lockfile或config变化都使E2过期并要求重跑。

固定编排接口：

    bash scripts/build-release-candidate.sh --source-commit <exact-40-hex> --expected-source-commit <same-value-from-sealed-input-lock> --required-tasks <tracked-json> --input-lock <absolute-sealed-json> --output-root <absolute-new-empty-dir> --manifest <absolute-new-0600-json>

它从同一exact commit分别调用A4 Gateway builder、C1 guard/bundle builder、A5 tool/helper builder和E0`template` renderer；四者revision/source tree必须完全一致。输出`manifestKind=release-candidate-v1`，内嵌并封口`gateway-image-v1` manifest，绑定Gateway image/archive、guard image/archive、bundle tar/manifest、capability receipt、含E1F controller文件/mode/tests的tool manifest、atomic helper binary/source/build-script hash、migration+final runtime template set和buildInputTreeHash。E0早期合成output不能传入；E2必须重新渲染。historical baseline不属于candidate，只用于source fixture。

preflight 后先创建工作副本；该命令只 materialize、verify、启动/停止隔离 **previous** controller，不迁移候选：

    bash scripts/release-rehearsal-work-copy.sh prepare --release-id <safe-id> --preflight <absolute-0600-json> --expected-preflight-sha256 <64-hex> --source-snapshot <absolute-dir> --release-candidate-manifest <absolute-0600-json> --candidate-instance-set <absolute-rehearsal-instance-set.json> --work-root <absolute-new-dir> --project-name <safe-unique> --host-port 0 --report <absolute-new-0600-json>

prepare从snapshot复制previous runtime，load exact previous image，用exact-replay definition按`create→start→stop`运行；receipt前禁止down/rm，work-copy manifest绑定stopped container ID/createdAt/project/config/image、runtime inode、capability receipt和fresh `fixture-work-copy-stop` evidence。任何失败只清本轮资源，不碰source/8790。

    bash scripts/release-rehearsal.sh --release-id <safe-id> --preflight <absolute-0600-json> --expected-preflight-sha256 <64-hex> --work-copy-manifest <absolute-0600-json> --stop-evidence <absolute-0600-json> --source-snapshot <absolute-dir> --release-candidate-manifest <absolute-0600-json> --candidate-instance-set <absolute-rehearsal-instance-set.json> --work-root <absolute-existing-prepared-dir> --report <absolute-new-json>

rehearsal在任何load/migration/start前核对全部sealed inputs；调用A5 `runtime-candidate-stage.sh`生成candidate runtime/manifest，再取fresh `candidate-exchange` evidence并使用E2封口helper。每次rollback/restore先精确stop实际controller、取当前phase evidence；不得预造。candidate instance必须由E0 renderer从E2 template+rehearsal descriptor产生，不能复用E0早期合成output。

历史 previous image 的来源固定：manifest为V3/V9记录官方origin full commit/tree/Dockerfile/预期server Schema和client provenance。builder先验证exact commit来自官方origin，再在detached clean worktree构建并写revision；client version不能操作者手填：若旧源码已有当前export则读取export，旧式源码只允许单一静态`const DATABASE_VERSION=<positive-int>`解析并标`legacy-static-inspected`，动态/多定义/缺失记unknown并按fixture规则fail-closed。测试覆盖伪造label与错误解析。输出image ID/archive/hash/report；禁止branch/短SHA/latest/来源不明缓存。

### E2.1 fail-closed preflight RED

- [ ] 拒绝未知/未来 Schema、运行中未协调 SQLite、quick_check/foreign_key_check 失败、可变 image tag 无 digest、配置 hash 缺失、磁盘不足。
- [ ] Schema V8+ 缺附件根必须拒绝；Schema V3 等旧版本只可标为 not-applicable-legacy，若目录实际存在仍必须纳入快照。
- [ ] 拒绝 snapshot 只有 DB 或只有附件；拒绝 current/previous image 任一无法本地解析到 digest。
- [ ] 拒绝snapshot manifest未绑定A5 source-preflight、previous archive/config ID/exact-replay hash漂移，或baseline manifest使用短SHA/branch/tag/非官方origin commit。
- [ ] 拒绝两层capability receipt缺失/权限过宽/registry/source hash漂移，或source-preflight/snapshot/rehearsal三处hash不等；V3/V9 source只需匹配受支持entry，candidate head必须匹配receipt。
- [ ] 拒绝required-task input lock缺B4/E1F/E3/任一强制任务、merge commit非candidate祖先、B4非disabled-verified、candidate source commit与buildInputTreeHash不符、E0早期合成definition冒充final template、E1F发布脚本或E3一致性脚本/mode/tool manifest未封口，或E2后build input漂移。
- [ ] 拒绝 client V2/V3→V4 演练缺 sealed rollback bundle、bundle/overlay/候选 SHA/version range 不匹配，或 bundle 可联网、写 IndexedDB、触发 versionchange；不得把 previous 低版本 JS 成功加载作为假设。
- [ ] 拒绝正式 8790、正式 runtime 或非 mktemp 路径；本任务只允许副本。
- [ ] candidate-input preflight失败不得build；candidate build完成后的source/snapshot/rehearsal preflight失败可以保留sealed artifact，但不得load、migrate、start或写目标。报告必须区分这两级，不能把“任一preflight零build”写成不可满足的规则。

### E2.2 演练矩阵

1. `build-release-candidate.sh`从同一exact source commit构建Gateway、guard、sealed recovery client和atomic helper，并用E0 renderer生成final template set；manifest逐项交叉核对revision、capability receipt、input lock和buildInputTreeHash。缺任一产物、B4/E1F/E3祖先、E3质量脚本mode/hash或SHA不同立即失败。
2. 构造“最旧受支持/当前正式已知” V3 legacy fixture：只写该 Schema 真实存在的 family/member binding、entry Session、`conversations/messages/provider_sessions`，不伪造 V5 才出现的 `thread_provider_turns`；无 attachment root 并显式标记 legacy not-applicable。用候选镜像逐步执行 V3→当前 head 全链，验证每个 ledger 版本恰好一次。
3. 另构造 V9 rich fixture：写入 member、Session、claim、三轮消息、多分片附件、旧 pending/succeeded/failed Provider turn；在副本逐次执行 V10、V11、V12 至当前 head。
4. 两条路径都用A5 snapshot与`runtime-candidate-stage.sh`生成sealed candidate manifest，再验证migration失败恢复；V9 rich另验证B3原Session重放、C1 journal、D1 queued/running/indeterminate。
5. 运行 quick_check、foreign_key_check、附件清单/hash、operation 对账和完整 browser release journey。V3 路径在迁移创建附件能力前不得伪造历史附件。
6. 故意让新版本启动失败；整体恢复previous但保持Gateway stopped；安全materialize snapshot内bundle，从portable recovery template为新root渲染instance并用exact guard在随机loopback服务，不直接挂tar或复用来源绝对路径。
7. 从 candidate/previous/guard archive 分别 docker load 并核对 image ID；离线验证两种旧 Schema、消息和附件适用性/逐字节恢复，并在线验证 guard health identity、零业务 mount、零 API/Provider；不得拿 guard health冒充 previous Gateway health。
8. 用真实 Chromium 先让 candidate 从 V2、V3 IndexedDB fixture 升到 V4并保存合成草稿/附件/outbox，随后按上一步恢复 previous runtime + 启动 guard/sealed recovery client；逐项读回本地记录，断言所有 network API 和 readwrite transaction 为 0。previous 原生低版本 JS 的 VersionError 作为负例保留，报告只能称“previous runtime restored offline + client read-only recovery”，不能称 previous Gateway/完整旧前端无损恢复。

演练报告只记录合成 fixture 的计数、hash、Schema 和 digest，不记录凭据或正文。

验证命令：

    bash scripts/test-release-preflight.sh
    bash scripts/build-release-candidate.sh --source-commit <exact-clean-commit> --expected-source-commit <same-from-input-lock> --required-tasks docs/fixtures/release-candidate-required-tasks.json --input-lock <absolute-sealed-json> --output-root <absolute-new-dir> --manifest <absolute-new-0600-json>
    bash scripts/test-release-rehearsal-work-copy.sh
    bash scripts/test-release-rehearsal.sh
    npm run check
    bash scripts/static-check.sh
    git diff --check

**回滚：** 本任务只操作副本；cleanup trap只删本轮project/mktemp。失败时保留权限0700的脱敏诊断摘要，敏感payload由trap删除。E2合入后若E1F或任一运行build input需要修复，旧candidate立即标为expired并保留审计；修复PR合入后必须从新的exact commit重跑整个E2，不能只补打一个controller脚本包。

**完成判据：** B4=`disabled-verified`、E1F/E3及全部强制任务均为candidate祖先；Gateway/guard/bundle/helper/release-controller/final template set和E3质量脚本来自同一exact commit与build-input tree。V3→head、V9→head、candidate-stage manifest、失败后previous离线整体恢复+materialized独立guard只读恢复均自动证明；E2后的allowlisted docs-only差异可识别，任何运行或质量脚本build input变化会使候选过期。不得把guard health冒充previous Gateway health。

## 8. Task F1：经批准升级正式 127.0.0.1:8790

**性质：** 运维发布任务，不与普通功能 PR 混合。必须经过 R1“准备/副本演练”、R2“可逆切换/维护态验证”和 R3“真实 Provider/开放写入”三次独立批准；R1 不授权切换，R2 不授权业务写入或 Provider 调用。

**依赖：** 总计划 A1、A1D、A2–A6、B1a、B1b、B2–B4、C1–C2、D1–D2、E0–E3及E1F全部达到发布退出标准；B4=`disabled-verified`；E2最新演练通过且其candidate source含E1F与E3 merge commit。

**由E1F已实现并被E2封口、本任务只消费的文件：**

- scripts/formal-release-inspect.sh
- scripts/test-formal-release-inspect.sh
- scripts/release-approval-receipt.mjs
- scripts/test-release-approval-receipt.mjs
- scripts/release-controller.sh
- scripts/release-cutover.sh
- scripts/release-state.mjs
- scripts/test-release-cutover.sh

F1 是纯运维执行与证据记录任务，不新增或修改上述脚本、A5/E0 helper、运行config、lockfile或其他build input。若现场发现工具缺陷，立即停止、保持当前安全状态，另立direct-main修复PR并让旧E2候选失效；修复合入后重跑E2，不允许现场patch。`release-cutover.sh`必须调用A5受测试的`atomic-dir-exchange` helper并把intent/receipt纳入发布报告。R1的production配置验证必须调用E0的parse-only与worker-disabled/no-egress路径，不能直接启动正常worker。

`release-state.mjs`在0700 release root维护0600 state，原子写+fsync。固定字段：releaseId、approvalContextRefHash、prepare/cutover/activate/rollbackUnarmedFormalPreflightSha256、prepare/cutover/activate/rollbackUnarmedSourcePreflightSha256、rollbackRestoreSourcePreflightSha256、prepareCopyInstanceSetSha256、approvalReceiptSha256、scope/phase、controllerIdentity、candidateManifestSha256、candidateTemplateSetSha256、migration/validation/acceptance/active/rollbackRecovery instance hashes、capabilityReceiptSha256、rollback bundle/guard hashes、backupToolManifestSha256、atomicHelperManifestSha256、exchangeCapabilitySha256、stopEvidenceSha256；R1与R2快照分别记录`prepareSnapshot={id,relativePath,manifestSha256}`、`finalSnapshot={id,relativePath,manifestSha256}`，禁止一个`snapshotManifestSha256`覆盖两者，rollback只接受final。`rollbackRestoreSourcePreflightSha256`只能复制并锁定创建final snapshot的cutover source preflight hash，不能由处置阶段重写。另记录candidateRuntimeManifestSha256、exchange intent/receipt、controllerGenerationId、acceptanceStateSha256、acceptanceAuditDeltaSha256、externalSideEffectCommitSha256、unarmedDispositionReceiptSha256、recovery materialization/instance/handoff hashes、各service state和lastUpdatedAt；不得含secret、正文或绝对路径。固定目录为`<release-root>/snapshots/prepare/<id>`和`.../final/<id>`，多份/错phase/absolute path一律拒绝。所有phase前后写state，resume只按receipt/inode/state推进。

首次inspect前先执行`release-state.mjs init --release-id ... --approval-context-ref <opaque-current-task-ref>`；该ref只用于防止不同发布任务串票，不声称脚本能认证Codex任务身份。formal preflight把其hash纳入fingerprint，后续receipt必须与preflight/state三方一致。用户给出精确批准后，操作者只把该条原文写入本次0700 release root下全新0600 approval.txt；不能猜或自动代用户生成。receipt唯一接口：

    node scripts/release-approval-receipt.mjs create --scope <prepare|cutover|activate|rollback-unarmed> --release-id <safe-id> --formal-preflight <absolute-0600-json> --expected-formal-preflight-sha256 <64-hex> --source-preflight <absolute-A5-0600-json> --expected-source-preflight-sha256 <64-hex> --approval-context-ref <opaque-current-task-ref> --approval-text-file <absolute-0600-file> --output <absolute-new-0600-json> [--acceptance-subject <absolute-0600-json>] [--acceptance-audit-delta <absolute-0600-json> --final-snapshot-manifest <absolute-0600-json> --candidate-runtime-manifest <absolute-0600-json>]

脚本逐字读取单行原文，核对scope/phase/releaseId、formal/source两份hash的parent-child绑定与approvalContextRefHash。prepare/cutover/activate只接受三条既定口令；`rollback-unarmed`另只接受“批准处置 <release-id> <disposition-fingerprint>”，并强制绑定新生成的rollback-unarmed formal/source preflight、final snapshot、candidate/current inode、acceptanceAuditDeltaSha256、零ordinary write/零Provider attempt证明和retention/disposition，不能复用activate preflight，也不能从R3启用批准推断删除/回滚授权。receipt保存context hash与原文hash，不保存原文。activate从已绑定subject提取预算/留存/externalSessionPolicy；第一版只接受`dedicated-new-thread`。测试覆盖旧delta/旧snapshot/旧activate source preflight/无disposition receipt、错误fingerprint/context/scope、权限、subject漂移和output不可覆盖。

正式只读 preflight 是批准 fingerprint 的唯一生产者，与 E2 拒绝正式 runtime 的 fixture preflight 不是同一产物：

    bash scripts/formal-release-inspect.sh --phase <prepare|cutover|activate|rollback-unarmed> --release-id <safe-id> --approval-context-ref <opaque-current-task-ref> --expected-bind 127.0.0.1:8790 --source-preflight <absolute-A5-0600-json> --release-candidate-manifest <absolute-E2-0600-json> --candidate-template-set <absolute-E2-template-set.json> --candidate-instance-set <absolute-formal-instance-set.json> --atomic-helper-manifest <absolute-E2-0600-json> --output <absolute-new-json> [--prepare-copy-instance-set <absolute-R1-copy-instance-set.json>] [--exchange-capability <absolute-target-probe-0600-json>] [--acceptance-subject <absolute-0600-json>] [--acceptance-audit-delta <absolute-0600-json> --final-snapshot-manifest <absolute-0600-json> --candidate-runtime-manifest <absolute-0600-json>]

每次formal inspect之前，先对**当时实际owner/runtime**重新运行A5只读source preflight：R1=`prepare-backup`，R2=`cutover-final-backup`，R3=`activate-candidate`，未armed处置=`rollback-unarmed-candidate`；后两者只生成指纹且不能传给backup/restore。不得复用上一个Gate、切换前或写入前的source preflight。prepare还必须在inspect前用E0 renderer从同一E2 template生成一套`scope=prepare-copy/bindPolicy=random-loopback`的R1副本专用instance：current指向全新隔离work-copy，candidate staging指向其同父全新basename，validation只连internal无egress网络并发布随机loopback、worker disabled；它和formal instance严格分离，acceptance/active不得启动。`--prepare-copy-instance-set`仅prepare必填、其他phase禁止，formal fingerprint/state绑定其hash。formal脚本除新建output/hash外只读，不stop/start/build/load/migrate/backup/发消息。E0 instance renderer与target helper probe都必须在inspect前完成；inspect只验证并把其hash纳入fingerprint。它绑定approval context、live owner/runtime/source Schema、A5 source preflight/two-layer receipt、E2 candidate/input-lock/buildInputTree、template+formal instance五定义、prepare copy instance（仅R1）、bundle/materialization/guard、helper source/binary与target probe。candidate receipt证明head；live旧DB只需匹配受支持entry。cutover/activate/rollback-unarmed强制exchange capability；activate强制subject且externalSessionPolicy只能dedicated-new-thread。rollback-unarmed只在state证明专用acceptance写入且未arm/零attempt时可用，强制绑定新鲜source preflight、audit delta、final snapshot、candidate/current inode和处置策略，输出disposition fingerprint供新批准。任何candidate运行build input相对E2变化都fail-closed。报告不含路径值/secret/正文；测试证明四phase identity不可混用且失败零运行物变化。

固定控制接口：

    bash scripts/release-controller.sh stop --scope <prepare|cutover|activate> --release-id <safe-id> --formal-preflight <absolute-0600-json> --expected-formal-preflight-sha256 <64-hex> --source-preflight <absolute-A5-0600-json> --expected-source-preflight-sha256 <64-hex> --approval-receipt <absolute-json> --release-state <absolute-0600-json> --controller-definition <absolute-preflight-bound-instance> --target-runtime-root <absolute-existing-dir> --stop-evidence-output <absolute-new-json>

该命令只用于每个Gate首次stop。helper由E2构建、target probe在cutover inspect前完成并被批准，receipt后禁止build/probe新binary。controller在stop前核对receipt/preflight/state/live owner/instance hash，只停exact owner并映射fresh stop evidence。R3 acceptance→active不能复用旧validation PID；cutover从state读取亲自启动的acceptance identity/generation/definition hash，实时核对后只停该owner。启动/恢复只用snapshot exact-replay或已批准formal instance，拒绝当前worktree mutable Compose。

    bash scripts/release-cutover.sh <prepare|apply|activate|resume|rollback> --release-id <safe-id> --formal-preflight <absolute-0600-json> --expected-formal-preflight-sha256 <64-hex> --source-preflight <absolute-A5-0600-json> --expected-source-preflight-sha256 <64-hex> --exchange-capability <absolute-target-probe-0600-json> --approval-receipt <absolute-json> --release-state <absolute-0600-json> --target-runtime-root <absolute-existing-dir> --candidate-instance-set <absolute-formal-instance-set.json> --release-candidate-manifest <absolute-E2-manifest> --release-root <absolute-0700-dir> --report <absolute-new-json> [--acceptance-state <absolute-0600-json>] [--unarmed-disposition-receipt <absolute-0600-json> --restore-source-preflight <absolute-cutover-A5-0600-json> --expected-restore-source-preflight-sha256 <64-hex>]

formal preflight是用户批准fingerprint，普通Gate的source preflight是A5 backup/stop-evidence运行授权；formal只封口source hash而不泄露路径。controller/cutover同时验证parent-child关系，state/report记录两份，禁止混传。prepare只写`prepare/<id>`并恢复original；apply只写`final/<id>`、用migration definition调用A5 candidate-stage、原子交换并启动validation。R2零acceptance写入的rollback可直接以cutover source preflight调用A5 restore；存在unarmed acceptance写入时，顶层source preflight必须是fresh rollback-unarmed disposition preflight并与formal/approval绑定，同时三个restore参数必须提供创建final snapshot时的原cutover source preflight/path/hash。cutover先证明该restore hash等于state锁定值和final manifest的expectedPreflightSha256，再只把它传给A5 restore；fresh disposition preflight绝不传入restore。release root下的materialization、new instance和guard handoff输出使用state规定的全新相对位置并显式传给A5，不由hash猜路径。所有asset/helper/receipt/definitions与显式顶层路径核对。resume按phase/inode/receipt继续，任何时刻唯一listener owner。

`test-release-approval-receipt.mjs`与`test-release-cutover.sh`是F1前门禁。后者在original stop、prepare/final snapshot、candidate stage、exchange各窗口、三mode切换、operation落库/arm前后、acceptance同generation重启、active与rollback各窗口注入SIGKILL。operation已落库但尚未arm时，resume唯一结果是同一candidate unarmed maintenance：worker零claim；不得自动snapshot rollback。维护者选择回滚时先封口`acceptance-audit-delta.json`，再生成独立rollback-unarmed disposition fingerprint/receipt；旧delta、旧final snapshot、inode漂移或无receipt都拒绝。armed后只能forward maintenance。测试还交叉混传formal/source hash、fresh disposition/cutover restore preflight并证明拒绝，验证controllerGenerationId在同definition重启稳定、仅轮换state使旧capability失效、prepare/final快照不会选错，且A5收到的永远是final snapshot原cutover preflight。

### F1.1 批准前只读取证

- [ ] 先运行 `test-formal-release-inspect.sh`；再对当前正式owner运行A5 `prepare-backup`只读source preflight，最后用 `formal-release-inspect.sh --phase prepare ...` 封口该source hash并生成本次 `0600` formal preflight 与 fingerprint。人工摘要只引用 hash/公开 identity，不复制其中私有路径。
- [ ] 记录正式 owner、systemd/Compose identity、PID、cwd、image ID/digest、创建时间、127.0.0.1:8790 listener、health body hash。
- [ ] 识别真实 runtime、SQLite、attachments、config 和当前 Schema；只运行 read-only quick_check/foreign_key_check。
- [ ] Schema-aware：V8+ 要求附件根存在；V3 等旧版本可标记 not-applicable-legacy，不能为迎合新代码擅自创建目录。
- [ ] 记录 current 与候选 SHA/digest/image archive hash、迁移链、预计两次停机、快照输出位置、空间、回滚命令和验收清单。
- [ ] 证明 production mode 不使用 Fake Provider；配置不足时 F1 阻断。
- [ ] 把上述摘要与 release-id/preflight fingerprint 给用户；未批准前不 fetch/checkout/install/build/load/stop/backup/migrate/发消息/改台账。

### F1.2 Gate R1：批准准备与正式数据副本演练

只有用户明确回复“批准准备 <release-id> <prepare-preflight-fingerprint>”才进入 R1。缺 fingerprint、使用旧 fingerprint 或只说“可以/继续”都不授权。用上述固定 CLI 生成 prepare receipt 后，R1 只授权：

1. 再次确认批准的 SHA/digest/fingerprint 未漂移；
2. 在停止任何服务前，从R1 fingerprint绑定的archive执行幂等`docker load`，核对candidate/guard config image ID、revision、receipt/base/toolchain labels并写load receipt；干净daemon失败则零停服，禁止在短停窗口临时构建或拉可变tag；
3. 只短暂停止实际 owning 的 Family AI Gateway，证明 Hermes、个人助理和其他服务 PID 未变化；
4. 生成fresh stop-evidence，用A5保存current image、SQLite+attachments+config、两层capability receipt及required rollback assets/definition到`prepare/<id>`整体快照；
5. 恢复原服务状态，并证明 backup 前后正式 image/Schema/health/PID owner 语义一致；
6. 从正式快照建立隔离副本，只用prepare fingerprint绑定的R1 copy instance中的migration definition，在其candidate staging执行正式现场Schema（2026-08-13快照为V3，执行时刷新）到当前head完整链；不得使用formal current/staging路径或临时改mount；
7. 先用E0的`provider-config-validate --mode parse-only`验证production配置；然后只用同一R1 copy instance的validation definition、候选副本、worker disabled/no-egress做健康smoke，证明不会claim复制来的queued/running operation、不会spawn/联网、不会调用真实Provider。浏览器旅程只能另起全合成数据+Fake Provider隔离环境，禁止在正式数据副本上发送消息或启用worker。

R1后必须报告prepare snapshot ID/hash、原服务恢复、数据副本迁移/config smoke/rollback。即使逻辑上仍是previous，短停重启可能改变PID/start time；进入等待R2的durable状态前，立即实测并同步两个service-ports文件与agent-architecture的actual previous owner/PID/image/Schema/mode，jq校验JSON。任何失败都停止；R1绝不替换正式runtime。

### F1.3 Gate R2：批准可逆切换与维护态验证

R1 全绿后使用 `formal-release-inspect.sh --phase cutover ...` 重新执行只读 preflight。只有用户明确回复“批准切换 <release-id> <cutover-preflight-fingerprint>”才继续；fingerprint、owner、image、Schema、PID、runtime/controller inode、配置或候选任一漂移都使旧批准失效。

获 R2 后：

1. 在停止任何服务前，从R2 fingerprint绑定的archive执行幂等`docker load`，核对candidate/guard config image ID、revision、receipt/base/toolchain labels并写load receipt；干净daemon也必须成功，失败则零停服。resume每次重新inspect，缺失时只从同一archive幂等reload，不能把daemon缓存当持久事实。
2. 记录无关 Hermes/个人助理 PID，只停止实际 owning Compose project 的 Gateway。
3. Gateway stopped后创建`final/<id>`整体快照；它与prepare ID/path/hash分开，保持stopped并捕获最后写入。
4. 用formal instance set中的migration definition调用A5 `runtime-candidate-stage.sh`从final snapshot构造同父candidate staging与sealed candidate manifest；离线验证quick_check、foreign_key_check、消息、附件、claim和operation。禁止拿validation definition迁移。
5. 写 durable exchange intent，重新核对 stop 前已经 probe 并绑定到 receipt/release-state 的 helper source/binary hash、parent device 与 `renameat2(RENAME_EXCHANGE)` capability；本步禁止重新 build/probe。用 A5 同一个 helper 单系统调用交换 current runtime 与 candidate staging。交换后 candidate 路径成为完整 pre-release parked runtime；fsync 父目录并写 receipt。禁止使用两次 rename；capability 漂移时停在维护态，不临场降级。
6. 只用已绑定 hash 的 validation definition 重建 controller，以 `maintenance=validation`、`worker=disabled` 启动精确 image：确认唯一 127.0.0.1:8790 listener、health identity、Schema=head、production real-config 已解析、非 root、read-only root、附件根权限、无业务 mutation、无 Provider spawn/egress、无关 PID 不变。不得就地修改 env 或用 active definition。
7. 运行静态资源、只读授权、Schema/operation/attachment reconcile 和浏览器加载检查；并发模拟普通客户端 mutation 与迁移旧 queued operation，前者必须 503，后者计数/state 不变。
8. 任一失败可在零普通业务写入/Provider attempt时用state精确指定的final snapshot、candidate manifest和committed exchange receipt恢复previous并保持Gateway stopped；安全materialize bundle后从portable template渲染新recovery instance再启动guard。全部通过则保持candidate validation；不得开放写入。

R2无论成功进入candidate validation，还是失败进入guard recovery，都是可跨任务等待的正式8790状态；离开本Gate前必须立即同步两个service-ports文件和agent-architecture：actual owner/PID/image/Schema/mode/health，明确`candidate validation + worker disabled`或`Gateway stopped + recovery-only guard`，不能保留R1台账等R3。

### F1.4 Gate R3：批准真实 Provider 验收与开放写入

R2 全绿后先把拟定 subject 写入 Git ignored `0600` 文件，用 `formal-release-inspect.sh --phase activate --acceptance-subject ...` 对当前 candidate validation owner 重新取证。再向用户报告 candidate identity、维护态结果、activate fingerprint、subject hash 和不可逆边界。用户必须明确回复“批准启用 <release-id> <activate-preflight-fingerprint>”，并批准该 exact acceptance subject：

    familyRef, personRef, deviceRef, entryBindingRef,
    agentRef, providerProfileRef,
    maxProviderInvocations, maxAttachmentBytes, budgetCeiling,
    retentionPolicy, externalSessionPolicy

禁止自动挑第一条家庭、成员、assignment或Profile。第一版externalSessionPolicy唯一允许值为`dedicated-new-thread`；复用既有测试Session因无法绑定exact externalSessionRef而不在本计划授权内，若未来需要必须另立设计。retentionPolicy默认`retain-audit`；清理需独立计划。

获 R3 后：

1. 生成绑定本次`controllerGenerationId`的acceptance capability与unarmed state并fsync；R3 receipt绑定generation/state hash但definition保持已批准字节不变。停止validation，用批准acceptance instance重建。generation在本Gate的受控Gateway重启中稳定，不绑定PID；切mode/新批准时只原子轮换state。unarmed worker零claim，普通mutation503；崩溃只恢复validation或同一unarmed generation。
2. 浏览器带 capability 用批准 subject 创建专用测试 thread并提交本轮消息 operation；Gateway 只允许请求事务落库，worker 因 operationRef 未在 allowlist 而不能 claim。release runner 从 DB/acceptance audit 读取该 operationRef，逐项核对 capability、subject、acceptedAfter、Agent/Profile、附件与剩余预算；旧 queued/其他 subject 保持不变。
3. 在允许任何 claim 前，release-state 先原子写 `external-side-effect-commit` receipt并 fsync；再把该 receipt hash与唯一 operationRef 原子写入 acceptance state 的 `externalSideEffectCommitSha256 + armedOperationRefs`，fsync 后 worker 才可 CAS claim。两文件写入之间崩溃保持 unarmed；state armed 之后即跨过不可逆边界，因为 Provider 可立即被调用，禁止用旧 snapshot 盲目覆盖。后续每轮 operation 都重复“先落库且 unarmed→核对预算/subject→追加 durable arm receipt→原子更新 allowlist”，不得靠切 env 或第四份 definition。
4. 在预算内完成两轮消息、刷新、附件上传下载、丢失响应 lookup、Gateway 维护态重启、第三轮和幂等重放；核对 exact Agent/Profile/external Session 未跨边界。
5. 验收全绿后，先 fsync acceptance receipt/report 与 active-transition intent，再精确停止 acceptance controller、用 active definition 重建为 `maintenance=off + worker=enabled`，确认普通业务开放和旧 queued 按 D1 规则接管；这一步是正式 activation。这是受控重启，不能描述为就地原子改 env。
6. Provider attempt commit前失败时：若尚无acceptance写入，可直接按final snapshot rollback；若专用thread/message/operation已落库但仍unarmed，先保持candidate maintenance，封口脱敏acceptance audit delta并证明零**普通业务写入**、零Provider attempt，再对当前candidate重新生成`rollback-unarmed-candidate` source preflight和formal disposition fingerprint；只有收到精确“批准处置”并生成rollback-unarmed receipt后才可rollback。不能复用R3 activate preflight，不能用R3启用receipt推断该授权，也不能无delta自动覆盖。跨边界后立即回validation/worker-disabled并forward recovery。

R3结束无论是active、guard recovery还是candidate forward-maintenance，都在离开Gate前实测并同步两个service-ports文件与agent-architecture；记录actual owner/PID/image/Schema/mode、Provider边界和health，不等待另一个任务补台账。

### F1.5 失败处置边界

在`external-side-effect-commit`之前，以下任一出现先立即关写/停claim。若DB证明没有ordinary业务写入且没有acceptance写入，可直接恢复final snapshot；若只有批准subject的unarmed acceptance写入，保持candidate maintenance，先封口acceptance audit delta并由维护者确认处置，再恢复；若出现ordinary写入则不得盲回滚，转forward maintenance：

- health 超时或 identity/listener 不符；
- migration、quick_check、foreign_key_check、附件 hash 或 operation reconcile 失败；
- 认证/授权、配对重放、消息幂等、安全绑定不变量失败；
- 候选之外服务 PID/端口发生变化。

回滚必须停止候选、隔离failed runtime，只接受state中`finalSnapshot`的ID/path/hash，整体恢复并离线验证；安全materialize bundle后保持previous Gateway stopped、用绑定guard恢复只读客户端。禁止选择R1 prepare snapshot、只切镜像/DB、拿guard health冒充Gateway或让低版本JS打开高版本IndexedDB。

跨 commit 后的消息/附件/Provider/第三轮失败不能自动 snapshot rollback，因为它会丢 candidate 新写入且无法撤销外部副作用。脚本必须关写/停 claim、生成 delta/invocation/attachment 清单和脱敏 incident report，并保持单一 candidate owner；后续只能走维护者批准的 forward fix，或先完成精确 delta 保存/外部处置后另批 reconciled rollback。

### F1.6 文档与台账

每个Gate进入可跨任务等待的durable状态都在**该Gate内**更新，不等最终成功：R1记录restored previous，R2记录candidate validation或guard，R3记录active/guard/forward-maintenance。每次都先实时取证，再同次更新：

- `docs/acceptance/formal-release-<release-id>.json`：时间、SHA、digest、before/after Schema、R1/R2/R3 receipts、acceptance subject hash/预算/留存策略、测试统计、commit boundary、验收和 rollback/forward-recovery 结果；
- README、Gateway README、总计划、执行包和开发记录的正式部署列；
- /home/youran/data/service-ports.md 与 service-ports.json：实际 127.0.0.1:8790 owner、服务、健康与 provenance；
- 先读后更新 /home/youran/data/agent-architecture.md：只记录实际部署的 Gateway/Provider/Hermes 边界，不写 secret、消息正文或私人路径。
- 对 service-ports.json 运行 jq empty；即使端口仍为 8790，也要校正实际 controller/image/Schema，而不是保留漂移 PID。

失败/回滚也记录失败点、acceptance audit delta（若有）、离线previous digest/runtime、实际guard或candidate maintenance owner/health；不得把候选或previous Gateway写成正在运行。若R1恢复previous但PID变化也必须更新，不以“服务名字没变”省略。

批准前可复制门禁固定为：

    npm ci
    node scripts/test-release-approval-receipt.mjs
    bash scripts/test-formal-release-inspect.sh
    bash scripts/test-release-cutover.sh
    bash scripts/test-runtime-backup-restore.sh
    bash scripts/test-runtime-candidate-stage.sh
    npm run check
    bash scripts/static-check.sh
    git diff --check

另运行E2 candidate manifest/input-lock verifier，证明当前main相对E2只有允许的docs-only差异。普通`docker compose build`、正式stop/migrate、浏览器真实Provider旅程在批准前必须记SKIP（未获R Gate），不能以本地smoke冒充。每个R1/R2/R3报告都列：fingerprint/receipt、执行命令、测试统计、before/after owner/PID/Schema/mode、snapshot ID、浏览器/Provider调用数、PASS/FAIL/SKIP+reason、台账diff和未覆盖项。

**完成判据：** R1/R2/R3 的 release-id、fingerprint、subject/budget 与 commit boundary 可审计；用户批准的 immutable digest 在正式 8790 上通过完整旅程并安全 activation，或在 commit 前失败后 previous runtime/data 整体恢复离线保留、业务 Gateway stopped且 guard 提供可验证的只读草稿恢复页，或在 commit 后失败时保持 candidate 维护态且外部副作用证据完整。任何结局都不静默丢普通用户在发布窗口产生的数据，也不把 guard/recovery 冒充旧 Gateway/完整前端；snapshot、parked runtime、release-state、bundle、guard image 和报告持续保留，清理另行批准。
