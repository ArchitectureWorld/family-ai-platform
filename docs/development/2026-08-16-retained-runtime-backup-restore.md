# Retained runtime 备份与恢复基础记录

## 范围

本次 A5 只建立发布底层原语，不部署、停止或重启正式 `127.0.0.1:8790`。没有新增持久端口，也没有改变 Gateway/Hermes controller 边界，因此不修改 `/home/youran/data/service-ports.*` 或 `agent-architecture.md`。

## 实现结果

- 两层 capability receipt 被 preflight、snapshot 和 candidate stage 共同消费；V3 legacy 无附件根只在显式 flag 与 registry entry 同时成立时接受。
- tool manifest 从受信 source/expected commit 和 A4 build-input tree 生成，snapshot 会逐项复核当前 Git blob、mode 和 hash。
- stopped runtime snapshot 封口 SQLite、附件、配置、exact image archive、controller replay definition、stop evidence 与逐文件 inventory。
- migration-only 入口不启动 HTTP/Provider；candidate stage 固定 no-network、只写同父 staging，并输出 sealed Schema/inode/inventory manifest。
- 原子 helper 使用 Linux `renameat2(RENAME_EXCHANGE)`；restore 在 syscall 前写 durable intent，交换后保留旧 inode，并支持 receipt 前崩溃的双 inode 对账。
- rollback bundle materializer 拒绝 absolute、`..`、symlink、hardlink 和特殊文件，只输出只读、逐文件 hash 的新目录与 sealed receipt。
- `verify-foundation.sh` 对显式非空 retained runtime 在 reset/Docker 之前 fail-closed。

## RED → GREEN 与验证

初始 RED 分别为缺少 rollback/restore 工具、candidate manifest 工具，以及 disposable preflight 未拒绝 retained runtime。实现后取得：

- `npm run check`：contracts `75/75`、provider SDK `39/39`、Gateway `805/805`，合计 `919/919`；类型检查与构建通过。
- 精确提交镜像构建：容器内 `918 passed / 1 skipped`，production dependency prune 后 `0 vulnerabilities`。
- 本机 stopped-container fixture：V9 snapshot → migration-only candidate → 破坏附件 → atomic restore 通过；V3 真 Schema、显式 legacy 无附件 snapshot/restore 通过。
- sealed image archive ID 在 save/load 后一致；本轮 V9 archive 大小约 259 MB。
- rollback materializer regular bundle 正向与 symlink tar 反向测试通过；`rollbackClientRequired=true` 缺任一整组资产时在 preflight、停服前失败。
- `bash scripts/static-check.sh`、`git diff --check` 通过。

正式 `8790`、正式 runtime、浏览器产品旅程和 F1 发布编排均不在 A5 执行范围内，不能把上述 fixture 记录成正式部署事实。
