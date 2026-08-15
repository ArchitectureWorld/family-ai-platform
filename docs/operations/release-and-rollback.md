# Gateway 可交付镜像与回滚边界

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
- `retained-runtime-smoke` 消费同一 sealed artifact，在 stopped 临时容器下执行 V3/V9 snapshot、V9 migration-only candidate stage、附件破坏后的单 syscall restore，以及 rollback bundle 安全物化；它不接触正式 runtime 或端口。

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
