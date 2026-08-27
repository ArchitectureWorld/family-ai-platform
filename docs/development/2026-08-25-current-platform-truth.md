# Family AI Platform 当前运行事实

## 事实边界

本文件保持四层事实分离，不能用源码或历史 Preview 推断正式部署：

- 源码基线：`origin/main` = `ebc2b2017036ddb04b0421d837e9c15eda94d963`。
- 自动化：以当前分支新鲜执行的 `npm run check` 与 Runtime Truth fixture 测试为准。
- 隔离 Preview：沿用已封口的 A2/A4/A5 与 device-scoped Chat 证据；本 WP4 未重新执行产品写入旅程。
- 正式运行物：2026-08-27 只读执行 `scripts/report-current-runtime.sh`；未配对、未发送消息、未读附件正文、未修改数据库、未重启或发布。

## 四层矩阵

| 能力 | 源码存在 | 自动化通过 | 隔离 Preview 验收 | 正式 `8790` 已部署 |
|---|---|---|---|---|
| Browser Entry Session | 是 | 是 | 已有刷新与容器重建证据，本 WP4 未重验 | 仅旧 V3 入口；新版 Entry Session 未部署 |
| 配对/撤销 | 是 | 是 | 已有 Member 入口证据，本 WP4 未重验 | 旧 pairing route 存在；本 WP4 未做写操作 |
| Member Web | 是 | 是 | 既有 Chromium 证据，本 WP4 未重验 | 否；`/member/` 当前 404 |
| Admin Web | development-only | 是 | 本 WP4 未验证 | 否；`/admin/` 当前 404 |
| 附件 | 是 | 是 | 既有隔离持久化证据，本 WP4 未重验 | 否；Schema 3 且附件根不存在 |
| Fake Provider | 是 | 是 | 是 | 是；当前 V3 运行物只确认 Fake |
| Hermes Provider | 是 | 进程边界测试存在 | 真实调用未验证 | 否 |
| Codex Provider | 是 | 进程边界测试存在 | 真实调用未验证 | 否 |
| retained 发布/恢复 | 是 | V3/V9 fixture 覆盖 | stopped fixture 已有证据 | 未部署；本 WP4 不执行发布 |

## 正式 `127.0.0.1:8790` 现场摘要

以下字段来自 2026-08-27 的只读 JSON 报告：

- listener：`127.0.0.1:8790`，状态 `observed`；`/health` 为 healthy。
- owner：Docker Compose project `family-ai-platform-foundation`、service `gateway`、container `family-ai-platform-foundation-gateway-1`。
- image：`sha256:00d6a37fd5ec8e35e85eeb0e70eb5d856647e1452afff01f9ba98b94d6ae7ce7`；旧镜像没有可读取的 OCI source revision，报告为 `unknown`。
- runtime：Schema `3`、`RestartCount=0`；容器创建于 `2026-07-22T12:30:34.935564581Z`，启动于 `2026-07-22T12:30:36.996292579Z`。
- routes：`/` 200；`/member/`、`/admin/`、`/api/v1/member/entry/context` 均 404。
- attachment：正式 runtime 没有 `attachments/`，文件数摘要 0；未读取任何文件名或正文。
- providers：V3/Fake-only；Hermes/Codex 正式能力均 false。
- systemd：system 与 user `family-ai-gateway.service` 均 inactive。

这些事实与 `scripts/fixtures/runtime-truth/formal-v3.json` 的 Schema、owner、route 与 capability 判定一致。`candidate-v9.json` 只用于测试候选状态，不是正式部署声明。

## 可重复生成

```bash
bash scripts/report-current-runtime.sh > current-runtime.json
jq empty current-runtime.json
rg -n -i '(Bearer|Authorization|token|secret|credential|cookie|upstreamBody|stack)' current-runtime.json
```

最后一条命令预期零匹配。脚本只调用 allowlist 的 Docker inspect format、HTTP status probe、只读 SQLite schema query、目录权限/数量摘要和 systemd state；不会读取容器环境变量、消息正文、附件正文或 Credential。

没有 Docker、监听器、SQLite CLI 或 systemd 时，报告使用稳定的 `not-observed`，不把“没有观测到”伪装成“确定未部署”。fixture 模式只供自动化测试，含额外字段或 credential-like 字段会 fail closed。

## 结论

当前源码候选显著领先于正式 `8790`，但 WP4 只报告差异，不执行升级。任何正式发布仍必须遵循 `docs/operations/release-and-rollback.md` 的 preflight、停止证据、sealed backup、migration-only candidate、原子交换与 restore 顺序，并另行取得用户授权。

## 2026-08-27 新鲜验证

- `npm ci` 成功；npm audit 仍报告仓库既有 1 moderate、1 high，本工作包未自动升级依赖。
- `npm run check` 成功：Contracts 6 文件/75 测试、Provider SDK 5/27、Gateway 83/811，共 94 个 workspace 测试文件、913 项测试；另有 Runtime Truth 4/4。
- workspace typecheck、完整 build、secret-pattern、disposable preflight、backup/restore、candidate-stage、authority、CI Compose、Gateway image 与 public repository 静态门禁全部通过。
- 正式 Runtime Truth 再生成后仍为同一 Compose owner、同一 image、Schema 3、RestartCount 0、health healthy；敏感词扫描零匹配。
