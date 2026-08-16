# Chat/Work device 级幂等开发记录

## 范围与基线

B2 从 B1a 已合入的 `origin/main`
`cd742fb532359e2001783e4ae87e2fd3b970459f` 建立独立分支
`codex/device-scoped-chat-idempotency`。行为修复提交为
`2651c1949a1719321712bc2d1c0583593121399e`，加强路由泄漏断言后的证据
HEAD 为 `c59cd3f2c8ed0bc813ff0506f4dd120f66b5d27d`。

本任务只收紧 Chat/Work 消息 POST 的跨设备幂等返回。不修改
Service、唯一索引、Schema/migration、Domain Event 查询或 Device Sync cursor/ACK，
也不部署、停止或重启正式 `127.0.0.1:8790`。主工作树原有 4 个
未提交修改保持不动。

## 行为语义与实现边界

命中同一 `threadRef + clientMessageId` 时，固定语义为：

- 同 device + 同 logical fingerprint：返回原 Message 和 Provider Turn；
- 同 device + 不同 payload：返回净化后的
  `409 THREAD_MESSAGE_CONFLICT`；
- 不同 device：无论 payload 相同或不同，都返回完全相同的净化
  `409 THREAD_MESSAGE_CONFLICT`；
- 上述冲突均不新建 Message/Provider Turn，Provider 总调用次数保持 1。

安全顺序保持为
`requireThread → validateMessageProvenance → findMessageByClientId → device 比较 → logical fingerprint 比较`。
因此授权和 provenance 校验发生在查询已有消息与返回缓存结果之前；
不同 Person/Agent/audience/Thread 和撤销或伪造 device 仍走原有隐藏边界。

Person 级 Domain Event 仍对同一 Person 的多设备可见，只有 cursor/ACK 按
device 隔离。实现未修改 Service 或 Sync，Schema 仍为 V9。

## RED 与 GREEN

聚焦 RED 命令覆盖 Domain、Route、Provider Service 和未修改的 Device Sync：

- `4 files`，`3 failed / 1 passed`；
- `3 failed / 22 passed`；
- 三个失败都来自旧行为错误地返回设备 A 的 Message/Provider 结果，
  不是编译、fixture 或环境失败；Device Sync 回归保持通过。

最小实现后：

- 聚焦 GREEN：`4 files / 25 tests`，全部通过；
- 邻近 Domain/Route/Attachment：`3 files / 21 tests`，全部通过；
- 独立 Review 发现路由测试曾把公开响应不存在的
  `assistantMessageRef` 当成负向断言；后续从只读数据库取真实 Assistant ref，
  并对冲突 envelope 做精确键值断言；
- 加强后 route/provider 回归：`2 files / 11 tests`，全部通过。

## 统一门禁矩阵

| 门禁 | 结果 | 证据 |
|---|---|---|
| 聚焦 RED | PASS | 4 files，3 failed / 1 passed；3 failed / 22 passed，失败精确命中跨设备错误复用 |
| 聚焦 GREEN 与领域回归 | PASS | focused `25/25`；neighbor `21/21`；加强 route/provider 断言后 `11/11` |
| `npm ci` / `npm run check` | PASS | `npm ci` 成功；npm audit 仍有开发依赖 1 moderate + 1 high，本任务未越界自动修复。行为证据 HEAD `c59cd3f2c8ed0bc813ff0506f4dd120f66b5d27d` 的宿主 check 为 94 files / 913 passed / 0 failed / 0 skipped；static、typecheck、build 和 `git diff --check` 通过。包含后续文档提交的 final exact-HEAD 门禁仍由 Task 4 重跑 |
| 不可变镜像构建 / Docker | PASS | source/OCI revision `c59cd3f2c8ed0bc813ff0506f4dd120f66b5d27d`；image `sha256:50c5bd5857f3bf9dba3cdb31a757825cc9733da36d0c290929b50e046c01a25b`；archive SHA-256 `e32f53b45979c53a25e280680b70fa047d822c363bd1fdeceaeed08935d44cbc`；manifest SHA-256 `b62cd4c5badf75d879a3e78910a6eb5ee775c6add5a5ca7d4d8c9511a3a3caf7`；build-input tree `d8046b18bbd38910a762e803a84c29c2a39956a8da0f739141270369b6dfa86c`；容器内 contracts `75 passed`、SDK `27 passed`、Gateway `810 passed / 1 environment-only skipped` |
| 隔离 dev-up / acceptance | PASS | 独立 project 与 `0700` runtime 消费同一份 `0600` manifest，随机 loopback；core acceptance 和 attachment 2-chunk/restart/SHA 验收通过，报告 `gateway-foundation-20260816-155033.md` SHA-256 `987a8b34aa823dcfea89ab14f4405f5d5909ff962ad25ccc34e870bcc0ca765a` |
| 任务专属容器 / 浏览器 | PASS | R1/R2 只作编排收敛，权威证据为 R3：`agent-browser 0.27.0` 完成两轮消息、刷新恢复、Gateway 重启并重解析随机端口 `32818 → 32819`、同一身份 SHA 匹配、第三轮和 Work 往返；console/errors 均为空，无 overlay；19-step journey 全部成功。当次临时截图 `family-ai-b2-browser-r3-c59cd3f2.png` SHA-256 `16e8c06c18b7af1f0985047dd34be91567add3d3a78c9f774b3d731789b272ae` 已独立目检正常，未将二进制截图固化到仓库，不承诺本次会话结束后仍可取 |
| 正式服务 / 真实 Provider | SKIP | 未获正式部署或真实 Provider 调用授权；只使用 Fake Provider。正式 `8790` before/after 的 health SHA-256 `169e9de22c2ac0692d38b07ecfd8800519e99140c49bb935cb3cadb47f252f1b`、container ID `b4c2f7876e6d80a2731a7782e3a5cb88a32478e43234723958b7929ce7451fb0`、image ID `sha256:00d6a37fd5ec8e35e85eeb0e70eb5d856647e1452afff01f9ba98b94d6ae7ce7` 和唯一 `127.0.0.1:8790` listener 全部不变 |
| 文档与运维台账 | PASS | 本分支同步 Gateway README、详细执行包、总计划、本记录与仓内稳定脱敏证据 bundle。证据 runtime 已销毁，不是持久服务，因此未更新 `service-ports.*`；无 Hermes 运行架构变化，未更新 `agent-architecture.md` |

不可变构建身份以 manifest、OCI revision、image ID、archive hash 与
build-input tree 的交叉一致为证；`/health` 响应的 SHA-256 只用来比较
正式服务 before/after，不单独作为候选镜像证明。

## 证据边界、端口与未覆盖项

R3 当次临时 allowlist 的 42 份公开证据均为 `0600`，安全词扫描通过；临时索引
`browser-evidence-index.json` SHA-256 为
`7355718f0074e718c8804f751d8cf543890d2a07ebae75f441d5423a95e4ef7f`。这个结论只
覆盖该 42 份经 allowlist 保留的公开证据，不代表整个 runtime 不含
一次性凭据或其他秘密。配对码、Token、Cookie、handoff fragment 和私密
消息正文均未进入 Git 或本文。

上述 42 份不被描述为长期保留；其中关键、脱敏、纯文本证据已固化到
[`device-scoped-chat-idempotency 证据 bundle`](evidence/2026-08-16-device-scoped-chat-idempotency/README.md)。
bundle 只保留结构化步骤、UI 可访问性快照、计数、哈希和运行身份摘要，
不包含 runtime Compose、Token、Cookie、fragment、绝对私有路径或消息正文。
bundle `manifest.json` SHA-256 为
`e08a74fd67d4cec29735257497ed7813df224a4b3567294bc6bb20e8e75bffa3`，
其内 12 份非 manifest 文件已按仓库相对路径和实际 SHA-256 逐一复核。

R3 的临时 curl capture wrapper 在清理时已删除，因此它不能再做
逐字节复审。后续最终 retained runtime 若采用类似编排，必须保留不含
敏感材料的 wrapper SHA-256 与脱敏源码证据，再能将该链路列为可复审证据。

所有 B2 证据 runtime 已精确销毁，容器、网络和随机端口 listener 均为
0，因此本记录不声称当前已有可直接体验页面。后续从最终文档 HEAD
重建并保留用户体验 runtime 后，才在实际端口确定时同步写入
`/home/youran/data/service-ports.md` 与 `service-ports.json`。

未执行正式部署、正式重启、公网/LAN、mobile 专项或真实 Hermes/Codex
Provider 调用，均按当前 Task 范围保持 SKIP。PR、GitHub CI 和 merge 尚未发生，
不由本地证据预先宣称。

## 回滚

本任务没有数据 migration。代码回滚会重新开放跨设备结果泄露，只能用于
故障定位，不能作为安全发布结果。若新实现不可用，应保持消息写入
fail-closed，不能恢复跨设备缓存命中。
