# Gateway 可交付镜像与回滚边界

## 发布前只读事实门

任何 candidate 构建、停服或正式切换前，先生成当前 Runtime Truth：

```bash
bash scripts/report-current-runtime.sh > current-runtime.json
jq empty current-runtime.json
```

只比较 allowlist 字段：listener owner、container/image、OCI source revision、Schema、RestartCount、health、route/capability 摘要、附件根状态和 systemd 状态。报告中的 `unknown/not-observed` 是停止条件，不能被解释为“未部署”或用源码事实补齐。命令不执行迁移、配对、消息、附件读取、容器重启或发布。

将该报告与 sealed candidate manifest、preflight 和 stop evidence 分开保存。Runtime Truth 不是发布授权，也不能替代后续 retained-runtime preflight。

## 可交付构建

唯一入口是：

```bash
bash scripts/build-gateway-image.sh \
  --source-commit "$(git rev-parse HEAD)" \
  --expected-source-commit "$(git rev-parse HEAD)" \
  --output-dir <absolute-new-dir>
```

上层必须独立提供 `expected-source-commit`。CI 使用 event `GITHUB_SHA`；后续候选发布流程使用已经封口的 candidate source commit。本地门禁才允许两者都取当前 `HEAD`。脚本拒绝不存在的 commit、两个合法但不同的 commit、未分类 Git 路径、错误能力版本、漂移的基础材料和 caller 手填客户端版本。

脚本从目标 commit 建立临时 detached clean worktree。构建输入由 `scripts/release-build-inputs.json` 分类：`runtime-build` 与 `quality-tool` 进入规范 tree hash，只有 allowlist 的 `docs-only` 被排除。编码包含分类、路径、Git mode、object type 与 object ID，因此内容、可执行位、清单自身或质量裁决工具漂移都会改变候选身份；submodule、未显式允许的 symlink、未知 mode/type 和未分类文件直接失败。

客户端数据库版本只从 `cache.js` 导出的 `MEMBER_CACHE_DATABASE_VERSION` 读取。Schema V3 到当前 head 与当前 release 能力分别由两个 JSON 输入描述，validator 同时核对 server/client source 并生成 `0600` capability receipt 与旁置 SHA-256。

成功目录固定只有：

- `gateway-image.tar`
- `gateway-image.tar.sha256`
- `gateway-image-manifest.json`

manifest 将 exact source commit、Docker config image ID、archive SHA-256、客户端 DB 版本、capability receipt hash、build-input manifest/hash、基础镜像 platform digest、Debian snapshot、精确工具链包和 OCI labels 绑定在一起。本阶段只承诺“本轮 archive 不可变、选择材料可追溯”；未做两次独立构建并得到相同 image ID 与 archive hash 时，不宣称 bit-reproducible。

## CI 阻断

CI 分为 `quality`、`production-audit`、`docker-build`、`container-smoke`、`retained-runtime-smoke`：

- `quality` 保持 15 分钟并执行锁文件安装与 `npm run check`；
- `production-audit` 执行 `npm audit --omit=dev --audit-level=high`；
- `docker-build` 只调用上述 wrapper，并上传以 exact SHA 命名的三文件 artifact；
- `container-smoke` 在新的 runner 校验 archive hash、加载同一 image ID、重放 capability/build-input receipt，然后以临时 runtime 和唯一 Compose project 运行健康及两分片附件重启验收。
- `retained-runtime-smoke` 消费同一 sealed artifact，在 stopped 临时容器下执行 V3/V10 snapshot、V10 migration-only candidate stage、附件破坏后的单 syscall restore，以及 rollback bundle 安全物化；它不接触正式 runtime 或端口。

smoke 使用 non-root、只读 root filesystem、`no-new-privileges` 和随机 loopback 端口；不调用 reset，不读取正式 runtime，也不发布正式端口。artifact 不包含环境变量、Token、Cookie、数据库、附件或原始响应。

## 开发镜像与回滚

`docker compose build` / 普通 `dev-up.sh` 仍可用于本机开发，但产物明确标记为 `local-unverified`，不得上传，也不得交给隔离 acceptance、候选发布或正式切换。

A4 只建立可验证镜像和隔离容器门禁，不修改正式 `127.0.0.1:8790`。A5 提供 retained runtime 的底层安全原语；正式启停和切换仍必须由 F1 逐 Gate 获得用户明确批准。发现错误产物时，删除该临时 artifact 并从可信 source/expected commit 重新构建；不得用可变 tag、重新 pull 或裸 Compose build 代替原 artifact。

## Retained runtime 快照与恢复

这不是一键正式升级命令。调用者必须先完成只读 preflight，再停止精确 controller，并生成五分钟入场有效、phase-scoped 的 stop evidence。备份只消费 sealed preflight、sealed tool manifest 和 stop evidence；复制期间会反复核对同一 owner 仍停止。快照把 runtime、exact image archive、controller replay definition、capability receipt 和逐文件清单作为一个 `0700/0600` 单元封口。

固定顺序为：

```text
preflight（仍在线、只读）
→ 精确停止 controller
→ fresh stop evidence
→ runtime-backup.sh
→ runtime-candidate-stage.sh（network=none，只有 migration-only）
→ runtime-exchange-preflight.mjs
→ 上层批准后单次 RENAME_EXCHANGE
→ 必要时 runtime-restore.sh
```

`runtime-restore.sh` 先在目标同级目录完成复制、SQLite 与 inventory 校验，写 durable intent，之后只用受封口 helper 做一次 `RENAME_EXCHANGE`。若 syscall 已成功但 receipt 尚未写出，重入只依据 intent 与两个实时 inode 唯一对账；不删除交换后保留的旧 runtime。`rollbackClientRequired=true` 时，缺 candidate manifest、bundle、guard archive、portable template、source instance 或 materialization receipt 任一项都会在停服前失败；bundle 只允许 regular file/directory，物化为只读目录，禁止直接挂载 tar。

`scripts/verify-foundation.sh` 仅用于仓库自己的 disposable `.runtime`。显式传入的非空 retained runtime 会在任何 Docker/reset 操作前失败；正式数据升级只能走本节发布链路。

## 管理员入口重签与长期有效激活码

此流程只用于已批准的正式 Family Admin 发布。当前运行物仍需先按“发布前只读事实门”核对，不能把本分支源码当成现网状态；不自动操作正式服务。管理员新会话沿用 V15 Schema，在 `expires_at` 写入 `9999-12-31T23:59:59.999Z` 作为兼容上界；个人 Session 和数据库迁移版本不变。

1. 精确停止 Family Gateway 写入者，取得数据库锁，并分别备份数据库、受保护管理员 Entry 文件及激活目录。备份保持 `0700/0600`，不得复制到 Git、公共台账或日志；记录旧镜像和回滚定义。
2. 在已构建的相同 source commit 下运行仅本机的根入口重签命令。它只接受 Hash 匹配、绑定/设备/家庭仍有效且状态为 `expired` 或时间已过但状态仍为 `active` 的旧管理员 Entry；`revoked` 一律拒绝。命令在独占数据库锁下签发新 Session，旧行仍为 expired，并在受保护目录保留 `0600` 的旧文件备份。成功输出只有 `ADMIN_OPERATOR_REISSUED` 或 `ADMIN_OPERATOR_ALREADY_ACTIVE`。
3. 用已经重签的 Entry 生成新的版本 2 短码。短码无时间期限，仍只可使用一次；重签后生成新码会替换旧码。十次有效格式的错误猜测会锁定该码。命令只在本机 stdout 输出短码；不得把它写入 URL、Git、共享台账或日志。生成前会以只读方式核对当前管理员 Session，失效时拒绝写入。
4. 从实际管理员浏览器激活，核对独立浏览器 Session、刷新与重启后继续使用；检查普通成员拒绝、主动退出只撤销本浏览器、设备撤销阻断所有关联会话。再按正式发布 Gate 记录镜像、数据和入口身份及回滚验证。

占位命令形式如下；实际路径只填在本机受保护终端，不写进本文件：

```bash
python3 apps/gateway/runtime/gateway_lock_exec.py \
  --database "$ADMIN_DB" -- \
  node apps/gateway/dist/adminOperatorCli.js \
  --database "$ADMIN_DB" --entry "$ADMIN_ENTRY"
node scripts/admin-production-activate.mjs \
  --database "$ADMIN_DB" --entry "$ADMIN_ENTRY" --output "$ADMIN_ACTIVATION"
```

若进程在激活码读改写中崩溃，`record.json.lock` 会让后续请求 fail-closed。先确认 Gateway 写入者停止并保存现场，再由 operator 对照受保护目录和备份恢复或重新生成；不得让网页端自动清锁。若根入口重签在文件替换与数据库提交之间中断，先用旧文件备份恢复一致状态，再重新执行；激活脚本的预检会拒绝不一致的入口。正式回滚应同时恢复相同时间点的数据库和受保护入口文件，避免 Session 引用与 Hash 错配。
