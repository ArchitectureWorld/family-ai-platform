# Family AI Platform 当前事实矩阵

## 取证边界

- 源码/自动化基线：A5 merge `be6a52c8daeb8f6d8e7405f2aa68523df3f44fae`；PR #35 的 quality、production-audit、docker-build、container-smoke、retained-runtime-smoke 与 Gitleaks 全部通过。
- Preview：A2/A4/A5 的隔离 runtime、随机 loopback、sealed image artifact 与浏览器/容器报告；2026-08-16 另只读确认 development LAN listener `127.0.0.1:8791`、`0.0.0.0:9080/9443` 仍存在，但本轮 HTTPS 旅程未复验。
- 正式：2026-08-16 CST 只读检查 `127.0.0.1:8790` listener、公开 health、容器 identity/image/创建时间、挂载、SQLite Schema、静态 route/provider 特征和 systemd 状态。未停止、重启、写数据库或读取 token/正文。

## 四层矩阵

| 能力 | 源码存在 | 自动化通过 | 隔离 Preview 验收 | 正式 `8790` 已部署 |
|---|---|---|---|---|
| Browser Entry Session | 是 | 是 | A4 两轮、刷新、重启后第三轮 | 仅旧 V3 入口能力；新版 web-entry/Cookie bridge 未部署 |
| 配对/撤销 | 是 | 是 | Member 入口链路通过 | 旧 mobile/admin pairing route 存在；未做正式写操作验收 |
| Member Web | 是 | 是 | A4 Chromium 通过 | 否；`/member/` 404，根页面仍是旧验收台 |
| Admin Web | development-only | 是 | 本轮未验证 | 否；`/admin/` 404 |
| 附件 | 是 | 是 | A2 持久化、A4 container smoke | 否；Schema V3 且附件根不存在 |
| Fake Provider | 是 | 是 | 是 | 是；正式镜像静态特征只发现 Fake |
| Hermes/Codex Provider | 是 | 进程边界测试通过 | 真实调用未验证 | 否；正式镜像无 Hermes/Codex 特征 |
| 重启恢复 | 是 | 是 | A4 浏览器与容器重启通过 | 未验证；当前容器 `RestartCount=0` |
| development LAN Preview | 是 | 是 | listener 活跃；本轮 HTTPS 旅程未复验 | 不适用，不属于正式 `8790` |
| retained 发布/恢复 | 是 | A5 V3/V9 CI fixture 通过 | stopped fixture 通过 | 未部署；F1 尚未执行 |

## 正式 `8790` 只读事实

- listener：`127.0.0.1:8790`；`GET /health` HTTP 200，identity `family-ai-gateway-foundation`。
- owner：Docker Compose project `family-ai-platform-foundation`、service `gateway`、container `family-ai-platform-foundation-gateway-1`；system/user `family-ai-gateway.service` 均 inactive。
- container ID `b4c2f7876e6d80a2731a7782e3a5cb88a32478e43234723958b7929ce7451fb0`，host PID `1857913`，image ID `sha256:00d6a37fd5ec8e35e85eeb0e70eb5d856647e1452afff01f9ba98b94d6ae7ce7`；创建/启动于 2026-07-22，health healthy，restart count 0。
- runtime bind：仓库 `.runtime/data` → `/app/.runtime/data`，宿主目录 `0700`；数据库 `gateway.sqlite` 为 Schema V3，无 `attachments/`。
- HTTP：`/` 200，标题“家庭 AI 初始化与入口验收台”；`/member/`、`/admin/`、新版 `/api/v1/member/entry/context` 均 404。
- 静态 route 特征仅为旧 `/api/v1/me`、conversation、mobile、pairing 与 portal；Provider 特征发现 Fake，未发现 Hermes/Codex。

## 结论与未覆盖项

A2–A5 是已合入候选能力，不是正式部署事实。正式服务仍健康且未被本轮触碰，但 service-ports 与 agent-architecture 原先把 listener owner 写成 active systemd unit，现已被只读证据否定，A6 同步校正为旧 Compose/V3/Fake-only 并注明候选未部署。

本轮没有执行正式配对、消息、附件、Provider、重启或浏览器旅程；development LAN HTTPS probe 未成功完成，因此这些格子保持“未验证”，不能从历史或源码补推。

## A6 修改范围

- 校正根 `AGENTS.md`、根 README、Gateway README、roadmap、整改设计与两份执行计划，使源码、自动化、隔离 Preview、正式部署四层事实不再混写。
- 同步更新 `scripts/test-remediation-authority.sh`：删除已过期的“A4 合入前/后”强制措辞，改为锁定 A1–A5 当前阶段、四层事实分离、唯一可交付构建入口和裸 Compose build 限制。
- 现场只读证据确认运维台账漂移后，同次校正 `/home/youran/data/service-ports.md`、`service-ports.json` 与 `agent-architecture.md`；只记录当前旧 Compose/V3/Fake-only 运行物，没有把候选能力写成已部署。
- 没有修改业务源码、Schema、Compose、端口、容器、systemd unit 或正式 runtime 数据。

## 验证记录

- `npm ci`：退出 0；安装 142 个 package。npm audit 仍报告 1 个 moderate、1 个 high，本 A6 文档/静态门禁任务未执行越权自动修复。
- `npm run check`：退出 0；94 个测试文件、919 项测试全部通过，0 失败、0 跳过；workspace typecheck 与完整 build 通过。
- `bash scripts/static-check.sh`：退出 0；disposable preflight、runtime backup/restore、candidate-stage、整改授权、CI Compose、Gateway image contract 和公开仓库静态检查全部通过。
- 目标回归：`memberWebOneClick.test.ts` 与 `memberPreviewScripts.test.ts` 共 2 个文件、52 项通过。首次与重型静态脚本并发执行时其中 1 项触发 5 秒超时；顺序重跑 52/52 通过，完整单 worker 套件也通过。
- `jq empty /home/youran/data/service-ports.json`：退出 0；8790 port 记录与 `agent_services` owner 一致。
- `rg` 冲突清单已逐项复核；历史计划/验收记录中的“已完成”保留为当时事实，权威当前入口均已改为四层状态。
- `git diff --check` 在最终文档修改后重跑。

Docker image build、隔离 `dev-up.sh`、`acceptance.sh`、浏览器旅程和真实 Provider 调用均为 `SKIP`：A6 只修改文档及其静态契约，不改变行为或候选构建输入，也未获授权操作正式服务。正式 `8790` 仅做只读取证，最终提交后还需再次核对 container/image/Schema/health 未变化。
