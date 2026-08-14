# Entry Session 单一认证时钟开发记录

**日期：** 2026-08-13

**分支：** `codex/review-remediation-clock`

**开发基线：** 本地 `main=e73d873`；交付时只把本任务提交重放到当时的 `origin/main`

**隔离工作树：** `/home/youran/.config/superpowers/worktrees/family-ai-platform/review-remediation-clock`

## 1. 基线与问题复现

本地 `main=e73d873`，`origin/main=e2aba59`；本地领先的两个提交为既有 Personal Agent display-name 文档提交。本任务从本地最新 `main` 建立独立 worktree，没有修改原工作区中用户尚未提交的 `render.js`、`config.ts` 和对应测试改动。

初次聚焦命令：

```bash
npm run build:adapter-sdk
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryRepository.test.ts --maxWorkers=1 --no-file-parallelism
```

结果：1 个测试文件失败；14 项中 12 通过、2 失败。两个失败都得到 `{ status: "invalid" }`，而测试注入时钟下 Session 仍有效。根因是：

1. `EntrySessionAuthenticator` 用注入的 `now()` 判断 Session 有效；
2. `FamilyDomainRepository.authenticateEntrySession()` 随后重新读取系统墙钟；
3. Repository 的 `expires_at > ?` 用第二个时间否决同一次认证。

## 2. RED 证据

新增回归测试把 Session 过期时刻设为 `2030-01-01T00:00:00.000Z`，认证时钟第一次返回过期前 1 ms，若被第二次读取则正好返回过期时刻；系统墙钟固定在 2031 年。

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryRepository.test.ts \
  -t "uses one decision instant across Session status and context lookup" \
  --maxWorkers=1 --no-file-parallelism
```

结果：目标测试 1 项失败、14 项跳过；失败仍为 `invalid`。这条测试同时排除了“Authenticator 和 Repository 各调用一次相同 clock 函数”的伪修复，因为第二次采样会恰好跨过期边界。独立审查后又在同一用例补充：Entry Token 只按 SHA-256 落库；错误 Token 不读取 clock、不更新 `last_used_at`，随后正确 Token 仍只使用第一次时钟快照。

另加一条边界特征测试，确认 `authenticatedAt === expires_at` 时状态必须为 `expired`，数据库中的 Session 也被持久化为 `expired`。

## 3. 最小实现

- `EntrySessionAuthenticator.authenticate()` 在 token/device 校验后只获取一次 `authenticatedAt = this.now()`；
- 外层过期判断使用 `authenticatedAt.getTime()`；
- 把同一个 `Date` 作为必填第三参数传给 `FamilyDomainRepository.authenticateEntrySession()`；
- Repository 只生成一次 `authenticatedAtIso`，同时用于 SQL 过期过滤与 `entry_bindings.last_used_at`；
- 保留外层精确 `expired` 状态写入与内层全关系授权过滤，没有放宽授权。

没有修改公开 HTTP API、Token 格式、Session 生命周期、数据库 Schema、端口、Compose、Provider 或其他 Repository 时间写入。

## 4. GREEN 与相关回归

单文件：

```text
Test Files  1 passed (1)
Tests       16 passed (16)
```

此前受影响的 7 个链路文件：

```bash
npm exec --workspace @family-ai/gateway -- vitest run \
  test/webEntryRoutes.test.ts \
  test/deviceSyncIsolation.test.ts \
  test/deviceSyncSession.test.ts \
  test/eventStreamRoutes.test.ts \
  test/webEntryRepository.test.ts \
  test/memberProductFlow.test.ts \
  test/webEntryBridge.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

```text
Test Files  7 passed (7)
Tests       43 passed (43)
```

完整门禁：

```bash
npm run check
```

| Workspace | 测试文件 | 测试用例 | 失败 | 跳过 |
|---|---:|---:|---:|---:|
| contracts | 6 | 75 | 0 | 0 |
| provider-adapter-sdk | 5 | 39 | 0 | 0 |
| gateway | 83 | 800 | 0 | 0 |
| **总计** | **94** | **914** | **0** | **0** |

同一次 `npm run check` 中 typecheck、build、secret-pattern regression 和 static deployment/public repository checks 全部通过，退出码为 0。另行执行的 `npm run typecheck`、`npm run build`、`bash scripts/static-check.sh` 和 `git diff --check` 也通过。

基线完整套件中的 21 个认证时钟失败与 2 个负载下 5 秒超时，本次完整运行均未复现。

## 5. 仍然存在的发布阻断

本任务只完成总计划 A1，不能据此宣称项目 Ready：

- `npm audit --omit=dev --json` 当前仍为 2 个 High、0 Critical：`fast-uri` 与 `find-my-way`，由 Task A3 受控处理；
- Compose 只读根下的默认附件目录仍不可写，由 Task A2 处理；
- 因已知 A2 运行阻断，本任务没有运行 Docker build、`dev-up.sh`、自动 acceptance 或真实浏览器验收；
- 没有部署或重启正式 `127.0.0.1:8790`。

## 6. 数据、端口与架构影响

- 测试只使用临时 SQLite，并由测试清理；没有修改正式数据库或附件；
- 没有新增/删除/改变端口、绑定地址或持久服务，因此没有更新 `/home/youran/data/service-ports.md` 与 `service-ports.json`；
- 已按项目要求只读核对 `/home/youran/data/agent-architecture.md`；本任务没有改变 Hermes 架构、Provider 路由、Home/Profile 或正式运行方式，因此没有更新该台账；
- 现场 `hermes chat --help` 只显示 `-q/--query`，没有受支持的 stdin 单次输入参数；这被记录为后续 Hermes 隐私任务的前置能力门，不属于 A1 改动。

## 7. 文档同步

- 新增 `docs/superpowers/specs/2026-08-13-deep-review-remediation-design.md`；
- 新增 `docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md`；
- 新增 `docs/superpowers/plans/2026-08-13-release-engineering-and-formal-rollout.md`；
- 新增 `docs/superpowers/plans/2026-08-13-security-and-identity-hardening.md`；
- 新增 `docs/superpowers/plans/2026-08-13-durable-recovery-and-client-resume.md`；
- 新增本开发记录；
- 公开行为、运行命令和正式部署事实没有变化，因此本任务不改根 README、Gateway README 或 `AGENTS.md`。这些文档的既有漂移在总计划 A6 和 E3 中分两次校正/收口。

## 8. 回滚

回滚只需把 `entrySessionAuth.ts` 和 `familyDomain.ts` 恢复到本任务前版本，并同时移除本任务两条回归测试；没有 Schema 或数据回滚。回滚会重新引入日历敏感认证失败，因此只能用于代码定位，不能作为正常发布方案。

## 9. 未覆盖项

- 没有做正式容器、正式数据和真实 Provider 调用；
- 没有验证附件持久化或浏览器旅程；
- 远程分支、PR、CI 与最终合入结果属于交付阶段证据，不冒充本地实现验证；

## 10. 独立代码审查

独立 Agent 对最终三处代码改动、调用方和新增测试做了只读复审。这里的“修改范围”只指 A1 的三个生产/测试文件，不包含用户要求同轮交付的总计划、设计和三份执行包。代码审查结论为：

- Critical：0；
- Important：0；
- Minor：0；
- A1 代码没有发现意外扩大修改范围；
- 当前改动可进入后续提交审查。

审查后补强了错误 Token 不采样 clock、不更新 last_used_at，以及正确 Token 仍只采样一次的断言；补强后重新运行受影响 7 个文件为 43/43，通过后又重新执行完整 npm run check，最终仍为 94 个文件、914 项全部通过。

计划文档另由三个独立 Agent 分别复审发布/运维、安全/身份、持久恢复/客户端链路。审查发现并推动修正了：旧 Schema 无附件时的备份规则、停服证据绑定、跨 runner 镜像传递、SQLite NULL 唯一键、单附件损坏不应拖垮全服务、丢失 202 的查询协议、正式运行定义、目录原子交换和正式数据副本禁用 worker/no-egress 等问题。计划复审不冒充代码审查，也不把尚未执行的 Task 写成已完成；最终结论与剩余意见以总计划最新“独立复审”节为准。

## 11. 后续开发计划最终冻结与三路复审

五份可执行计划在最后一次结构修订后冻结为：

| 文件 | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-13-deep-review-remediation-design.md` | `26d93259a8c0f9014f3d45097512937a1e46709559c10977075233b38cde5b3f` |
| `docs/superpowers/plans/2026-08-13-deep-review-remediation-program.md` | `2af279f8032ad89c8e4b946071d10ebe629b84f02a7b777f8452474b47cb7061` |
| `docs/superpowers/plans/2026-08-13-release-engineering-and-formal-rollout.md` | `0fa35365b4be20246a56653e2a0f5fab76437d06fcdce96ab126bebbc82cdeb6` |
| `docs/superpowers/plans/2026-08-13-security-and-identity-hardening.md` | `3914f86f5fc8b5a555a9df73e130b8cc67ee4d6053a0ba6a608270f5437458aa` |
| `docs/superpowers/plans/2026-08-13-durable-recovery-and-client-resume.md` | `f0f8e86d41e1a8dc4015112d18715b811a84a7f6eab6467d1e79fa69c032cf37` |

最终冻结版已通过本地 Markdown 链接、代码围栏、冲突关键词和 `git diff --check` 检查。三个独立方向均先复算上述 hash，再做只读复审：

| 复审方向 | Critical | Important | 结论 |
|---|---:|---:|---|
| 发布、备份、候选冻结与正式切换 | 0 | 0 | Ready |
| 安全、身份、幂等与 Provider 隔离 | 0 | 0 | Ready |
| 持久恢复、浏览器续作、测试与文档运维 | 0 | 0 | Ready |

复审期间发现的问题没有被留作“后续再说”，而是已经写回计划并重新冻结。关键修订包括：

- 把正式发布控制器提前到 E1F 实现并由 E2 封口，F1 只允许执行已测试工具；
- 把 E3 调整为 E2 前置，使文档一致性脚本与 Git mode 进入候选输入锁，消除 E3 导致 E2 候选自失效的依赖环；
- A4 预先固定 `runtime-build`、`quality-tool`、`docs-only` 三分类，E3 同 PR 只登记检查脚本，不临时改变分类语义；
- 正常浏览器旅程固定为 3 条 Person Message、3 条 Assistant Message、3 次本地 Fake Provider 调用和 0 个 `indeterminate`；故障旅程使用独立 runtime，固定为 1/0/1/1，不能拿不确定状态冒充成功回复；
- C2、D1、D2、E1、E4 的浏览器 wrapper 统一只消费调用方预先生成的同 SHA `--image-manifest`，禁止在下游重建候选；
- E1/E0 fixture 只能使用本地可计数、可故障注入 Fake Provider，明确零外部 egress、零真实配置/凭据/Home 挂载、零外部连接和零计费；
- E4 统一依赖 E2；若在 F1 前合入，旧候选立即过期，必须从新 `main` 完整重跑 E2。

这里的 Ready 只表示计划依赖、接口、验证、回滚、审批门和文档同步契约足以交给其他 Agent 逐 Task 实施，不表示 A2–F1 已经实现或正式环境已发布。

## 12. 交付前最终复验

三路计划终审完成且冻结文件不再变化后，重新执行一次完整 `npm run check`，退出码为 0：contracts 6 文件/75 项、provider-adapter-sdk 5 文件/39 项、Gateway 83 文件/800 项，总计 94 文件/914 项，0 失败、0 跳过；typecheck、build、static deployment/public repository checks 与 secret-pattern regression 同次通过。

随后执行生产依赖审计。第一次 npm registry quick-audit 请求返回瞬时 HTTP 400；只读 `npm ls --omit=dev --all --json` 退出码为 0，证明本地 production tree 可解析。按同一命令重试后成功取得有效报告，仍为 2 High、0 Critical：`fast-uri` 与 `find-my-way`，二者 `fixAvailable=true`。因此 A3 仍是明确发布阻断，不能把中间的 registry 400 或 A1 全绿解释成漏洞门禁通过。
