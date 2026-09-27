# Gateway V15 离线 WAL 恢复

本工具只恢复精确 V15 数据库的崩溃 WAL。普通 Gateway、migrate、provision 和 readiness 不自动恢复；V14 残留 WAL 必须使用对应旧镜像和离线快照流程，不可交给此工具。

操作前停掉访问同一数据库父目录的授权进程，并保存离线完整快照及原镜像、sealed image manifest。不要手工删除 WAL、SHM、恢复目录或 lock 文件。数据库父目录必须是数值 `1000:1000`、`0700`；main/WAL/SHM 必须同时存在，均为 `1000:1000`、`0600`、单硬链接普通文件，禁止符号链接和 journal。工具不自动 chmod，也不回显路径、SQL、业务内容、底层异常或凭据。

以下命令的 `FAMILY_IMAGE` 必须来自已验证 manifest 的不可变 image ID；`DB_PARENT` 是已停机、已备份的精确数据库父目录。容器沿用镜像默认锁 launcher，只覆盖 CMD；根文件系统只读、网络关闭、无 host 端口。运行 UID/GID 固定，不取宿主机当前 UID。

```bash
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$DB_PARENT,dst=/runtime/data" \
  --env GATEWAY_DATABASE_PATH=/runtime/data/gateway.sqlite \
  "$FAMILY_IMAGE" node apps/gateway/dist/recoverGatewayDatabase.js \
  --database /runtime/data/gateway.sqlite --action recover
```

成功只输出一行 `{"status":"recovered","operationId":"<lowercase32hex>"}`。若原文件已安全恢复，输出 `restored` 且退出 0；这仍然保留阻止启动的 marker 和 failed receipt，需要修正原因后显式 retry。记录 operationId，不要从普通 V15 数据库推断操作已经完成。

使用同一容器限制、同一挂载、同一 image，分别把最后的 CLI 参数替换为：

```text
--database /runtime/data/gateway.sqlite --action status
--database /runtime/data/gateway.sqlite --action status --operation-id <lowercase32hex>
--database /runtime/data/gateway.sqlite --action resume --operation-id <lowercase32hex>
--database /runtime/data/gateway.sqlite --action retry --operation-id <lowercase32hex>
```

`status` 只读验证 active 或 completed 证明，返回 operationId/state，以及有 receipt 时的 stage；没有证明返回 `RECOVERY_INVALID`，没有 idle 状态。stdout 输出前进程被杀时，可用 status 找回操作。`resume` 只继续当前分支，重复调用幂等；failed 重复 resume 仍为 restored，aborted 重复 resume 为 `RECOVERY_FAILED`。只有显式 retry 离开 failed/aborted；不能以新的 recover 代替。

所有失败退出 1、stdout 为空、stderr 仅为以下一行之一：

| 错误 | 处理 |
| --- | --- |
| `RECOVERY_INVALID` | 参数、身份、元数据或证明不符；保留全部文件，检查受保护的现场证据。 |
| `RECOVERY_RESUME_REQUIRED` | 已有操作；先 status，使用对应 operationId。 |
| `RECOVERY_FAILED` | 锁忙、初始化或提交点前失败、aborted；先排除仍持锁的进程和 I/O 故障，再按 status 选择 resume 或显式 retry。 |
| `RECOVERY_FORWARD_RESUME_REQUIRED` | 已过不可逆清理点；只能用同 operationId resume 向前完成。 |

每个入口持有同一父目录 `.family-ai-gateway.lock` inode 的内核排他非阻塞 flock，Node 通过继承的 fd3 验证同一 OFD，整个调用期间持锁。进程被杀由内核释放锁；更换 bind alias 不绕过互斥。绕开 launcher 用同 UID 原始 SQLite 写入属于不支持的操作/DAC 违规。

恢复先写入 `.<db>.wal-recovery/marker.json`（绑定 active root/marker inode 的 exact 8-key canonical JSON），再建立 work。候选恢复和精确 V15 immutable 检验成功前原 main/WAL/SHM 不变。安装由 NOREPLACE helper 与逐步持久 receipt 驱动；首个 `cleanup-quarantine-wal-intent` 是不可逆点。此前同步失败可以恢复原三文件，此后只能向前清理。

SIGKILL 后 marker 或 active root 阻止普通启动，直到安全 terminal rmdir。active root 已删除且父目录已 fsync、但 `marker-removed` 审计尚未追加的窗口，普通启动可以通过；status/resume 依靠 sealed `marker-remove-intent` 和精确 public proof 补全审计。completed sibling 永久保留，不能删除或把任意 sidecar-free V15 当作完成证明。

验收 recovered 后确认无 active root、WAL/SHM/journal，保存 completed receipt，再按原来的受保护 Gateway 启动流程启动；Gateway 自身重新启用 WAL。若已重新启动并写入，旧 completed proof 不再保证与当前数据库一致，status 不应被当作在线健康检查。

宿主机也必须运行固定 UID/GID 1000 的同一 launcher：

```bash
GATEWAY_DATABASE_PATH=/absolute/protected/gateway.sqlite npm --silent run recover:gateway-database -- \
  --database /absolute/protected/gateway.sqlite --action status
```

workspace script 为 `recover-database`；开发 script `recover:gateway-database:dev` 先 build 再执行 built CLI。`node apps/gateway/dist/recoverGatewayDatabase.js --self-check` 只检查安装与 helper 能力，不打开数据库或取得锁，不能代替恢复验收。测试 fault fixture 不进入 runtime image，production 依赖固定 `fault:null`，不接受环境故障开关。

封存门禁绑定源码 TS/helper SHA、构建阶段生成的 JS SHA、运行镜像的文件类型/owner/mode/nlink/SHA 和 `protectedWalRecoveryV1` 能力；候选与 CI 均拒绝缺失或漂移。隔离 rootful gate 使用独立 volume，枚举权威 stage definitions，在真实 SIGKILL 后通过 built production CLI 双 resume、只读 status 和显式 retry；没有正式发布授权含义。
