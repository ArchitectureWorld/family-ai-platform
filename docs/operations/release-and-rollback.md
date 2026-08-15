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

CI 分为 `quality`、`production-audit`、`docker-build`、`container-smoke`：

- `quality` 保持 15 分钟并执行锁文件安装与 `npm run check`；
- `production-audit` 执行 `npm audit --omit=dev --audit-level=high`；
- `docker-build` 只调用上述 wrapper，并上传以 exact SHA 命名的三文件 artifact；
- `container-smoke` 在新的 runner 校验 archive hash、加载同一 image ID、重放 capability/build-input receipt，然后以临时 runtime 和唯一 Compose project 运行健康及两分片附件重启验收。

smoke 使用 non-root、只读 root filesystem、`no-new-privileges` 和随机 loopback 端口；不调用 reset，不读取正式 runtime，也不发布正式端口。artifact 不包含环境变量、Token、Cookie、数据库、附件或原始响应。

## 开发镜像与回滚

`docker compose build` / 普通 `dev-up.sh` 仍可用于本机开发，但产物明确标记为 `local-unverified`，不得上传，也不得交给隔离 acceptance、候选发布或正式切换。

A4 只建立可验证镜像和隔离容器门禁，不修改正式 `127.0.0.1:8790`，也不提供 retained runtime 的备份/恢复授权。整体 SQLite、附件和配置快照、候选副本迁移、原子交换与 previous restore 由 A5 提供；正式启停和切换仍必须由 F1 逐 Gate 获得用户明确批准。发现错误产物时，删除该临时 artifact 并从可信 source/expected commit 重新构建；不得用可变 tag、重新 pull 或裸 Compose build 代替原 artifact。
