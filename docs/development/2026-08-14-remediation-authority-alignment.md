# 整改阶段授权规则对齐开发记录

**日期：** 2026-08-14

**分支：** `codex/remediation-authority-alignment`

**基线：** `origin/main=29baa8f`（A1 经 PR #30 合入后的最新主线）

**授权来源：** 仓库维护者在当前开发任务中要求“继续完成开发”，并明确要求只在确有并行价值时使用子 Agent。本任务按已编制总计划串行执行，没有启动子 Agent。

## 1. 问题与 RED

仓库已经实现了浏览器 Session、设备配对、附件和 Provider Adapter，但根 `AGENTS.md` 仍把这些能力整类列为“暂不开发”。这会让后续 Agent 同时收到“按 A2–F1 加固既有能力”和“禁止触碰这些能力”两条互相冲突的命令。

先新增 `scripts/test-remediation-authority.sh` 并接入 `scripts/static-check.sh`，保持旧 `AGENTS.md` 不变运行：

```bash
bash scripts/test-remediation-authority.sh
```

退出码为 1。失败只报告缺少整改授权边界，以及仍存在以下三条整类禁令：正式浏览器 Session、设备配对和附件、真实 Hermes/Codex Provider；没有路径或 Markdown 解析错误。

## 2. 保留、放开、仍禁止

### 保留

- 单一 Family AI Platform、单 Gateway、单主要数据库和空库起步；
- 禁止旧平台数据迁移、兼容层和第二套业务权威；
- 全部 14 条安全不变量；
- 独立分支、直接指向 `main` 的单任务 PR、禁止 force push；
- RED→GREEN、完整验证和 Ready 前五项门禁；
- 正式 `127.0.0.1:8790` 的 R1/R2/R3 分段用户批准。

### 放开

- 只允许按总计划加固仓库已经存在的 Session、设备配对、附件、Provider Adapter、浏览器客户端和发布工具；
- A2 获准实现隔离 runtime/project/随机 loopback port/不可变镜像参数，但这些参数在 A2 合入前不能冒充已可用；
- A4 获准在同一 PR 把可交付构建门禁迁移到届时真实存在的不可变 wrapper。

### 仍禁止

- 公网、TLS 反向代理、OAuth/SSO、异地管理；
- 新建第二后端、旧数据迁移或兼容层；
- 新建独立正式 Member/Admin Web 应用、新终端、公共语音和多 Agent 语义编排；
- 未经独立设计批准的新真实 Provider 产品能力和真实计费自动测试；
- 未经 F1 R1/R2/R3 批准的正式 runtime、端口、Provider 架构、部署或重启；
- LAN Preview 在 B4 完成前保持 `disabled-verified`。

## 3. 实现

- 把 `AGENTS.md` 的旧阶段整类禁令改为“允许加固的既有能力 / 仍然禁止的新增范围 / 正式运行与发布 Gate”三段；
- 新增可直接执行的授权一致性测试，逐条校验 14 条安全不变量、Git/TDD 门禁、三类授权边界和 A2/A4 迁移约束；
- 测试内置旧阶段规则变体，确保以后重新加入整类禁令会失败；
- `scripts/static-check.sh` 调用新测试，因此本地、Docker 构建中的 `npm run check` 和 CI 都会执行该门禁；
- 同步深度整改设计、总计划状态和本开发记录。

没有修改业务源码、数据库 Schema、Compose、依赖、端口、runtime 或 Provider 配置。

## 4. 验证

| 项目 | 结果 | 证据 |
|---|---|---|
| `npm ci` | PASS | 安装 142 个 package；退出码 0 |
| `bash scripts/test-remediation-authority.sh` | PASS | `Remediation authority alignment checks passed.` |
| `bash scripts/static-check.sh` | PASS | Foundation preflight、授权边界与 public repository checks 通过 |
| `npm run check` | PASS | contracts 6 文件/75 项、adapter 5 文件/39 项、Gateway 83 文件/800 项；合计 94 文件/914 项，0 失败、0 跳过；typecheck/build 同次通过 |
| `git diff --check` | PASS | 无空白错误 |
| Docker build | SKIP | 文档/静态门禁任务，无 Dockerfile、Compose 或镜像行为变化 |
| `dev-up.sh` / acceptance | SKIP | 无 runtime 行为变化，且不得触碰正式 8790 |
| 浏览器验收 | SKIP | 无页面或 API 行为变化 |
| 真实 Provider | SKIP | 无 Provider 行为变化；Hermes v0.20.0 仍没有受支持的 stdin/FD 单次输入参数 |

`npm ci` 的通用审计摘要为 1 Moderate、3 High；本任务没有依赖变化。生产依赖 High 的受控处理仍属于 A3，不能把 A1D 全绿解释成漏洞门禁通过。

## 5. 数据、端口与 Hermes

- 没有读取或写入正式业务数据；
- 没有新增、删除或改变监听端口、绑定地址或持久服务，因此不更新 `/home/youran/data/service-ports.md` 与 `service-ports.json`；
- 已按项目规则核对 `/home/youran/data/agent-architecture.md`；本任务没有改变 Hermes Home/Profile、Provider 路由或正式运行方式，因此不更新架构台账；
- Hermes 当前为 v0.20.0，但 H0 私密输入能力仍未满足，不影响 A1D，也不能解锁 B1b/D1。

## 6. 回滚与未覆盖

回滚本任务只需恢复 `AGENTS.md` 和 `scripts/static-check.sh`，删除授权测试及本记录。回滚后 A2+ 必须重新阻断，不能在旧规则冲突仍存在时继续开发。

未覆盖 Docker、正式服务、浏览器、真实 Provider 和端口运行证据；这些均与本任务无运行行为变化相符。A1D 只有在独立 PR 的 CI 与维护者措辞确认通过并合入 `main` 后，才允许 A2 从新的主线开始。
