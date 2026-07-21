# Gateway Foundation 体验验收

## 适用范围

本验收只确认本机 Gateway Foundation：固定成员—Agent 绑定、两轮连续消息、幂等安全、SQLite 持久化、容器重启恢复和重启后继续第三轮。

它不验收真实 Hermes/Codex、正式 Member/Admin Web、设备配对、附件、局域网或公网。

## 验收前准备

在 Linux 或 NAS 上确认：

```bash
docker --version
docker compose version
curl --version
```

然后进入仓库：

```bash
cd /home/youran/Development/family-ai-platform
git fetch origin
git switch feat/gateway-foundation
git pull --ff-only origin feat/gateway-foundation
```

## A. 一键启动

执行：

```bash
./scripts/dev-up.sh
```

正确结果：

- 脚本没有要求手工编辑环境变量；
- 自动构建并启动容器；
- 显示 `Family AI Gateway 已启动`；
- 输出一个以 `http://127.0.0.1:8790/#token=` 开头的页面地址；
- `docker compose --env-file .runtime/config/compose.env ps` 显示 Gateway healthy；
- `.runtime/config/device-token` 和 `.runtime/config/gateway.env` 权限为 `600`；
- `.runtime/data` 已创建。

错误结果：

- 端口发布到 `0.0.0.0`；
- Token 或数据库出现在 Git 状态中；
- 需要复制旧数据库；
- 服务不断重启；
- 健康检查超过 60 秒。

## B. 浏览器体验

打开启动脚本输出的地址。

### B1. 身份

点击“读取当前身份”。

应看到：

- 成员：测试成员；
- 设备：测试设备；
- 固定个人助理：个人助理；
- 页面地址栏已移除 `#token=...`；
- 页面和日志中没有显示 Token。

### B2. 创建会话

点击“创建体验会话”。

应看到一个以 `conversation:` 开头的会话编号。

### B3. 两轮连续消息

直接发送第一轮示例。

正确回复：

```text
Fake Provider 第 1 轮回复。
```

点击“填入第二轮示例”，再发送。

正确回复：

```text
Fake Provider 第 2 轮回复。
```

历史区应有四条消息，顺序是：我、个人助理、我、个人助理。

### B4. 刷新恢复

刷新浏览器页面。

正确结果：

- 身份仍可读取；
- 当前会话仍被恢复；
- 四条历史仍存在；
- 没有重新创建数据库或设备。

### B5. 容器重启与继续对话

执行：

```bash
docker compose --env-file .runtime/config/compose.env restart gateway
```

等待健康恢复后，在页面点击“刷新当前历史”，应仍有四条消息。

再发送一条第三轮消息，正确回复必须是：

```text
Fake Provider 第 3 轮回复。
```

这一步确认 Provider Session 不是只存在于进程内存。

## C. 自动验收

执行：

```bash
./scripts/acceptance.sh
```

必须全部 PASS：

- Health；
- Device authentication；
- Create conversation；
- First message；
- Second message；
- History before restart；
- Idempotent replay；
- Idempotency conflict；
- Cross-Agent rejection；
- Restart history recovery；
- Post-restart continuation；
- Final history。

报告生成在：

```text
docs/acceptance/runtime/gateway-foundation-<timestamp>.md
```

报告不得包含 Token、Authorization、SQL、堆栈或本机绝对路径。

## D. 质量门禁

首次在新仓库生成锁文件：

```bash
npm install
```

确认新的 `package-lock.json` 只属于新仓库，不是旧仓库复制品。然后执行：

```bash
npm run check
docker compose build
```

最终应记录：

- 测试文件数；
- 测试总数、通过数、失败数、跳过数；
- TypeScript 检查结果；
- 构建结果；
- Docker 构建结果；
- 自动验收报告路径；
- 浏览器验收结果。

## E. 停止与重置

停止但保留体验数据：

```bash
./scripts/dev-down.sh
```

重新执行 `./scripts/dev-up.sh` 后，原历史应仍在。

彻底清除一次性开发状态：

```bash
./scripts/dev-reset.sh
```

输入 `RESET` 后，`.runtime` 被删除。再次执行 `dev-up.sh` 应生成新 Token 和空数据库。

## 回滚

当前阶段没有旧数据迁移。回滚只需：

```bash
./scripts/dev-down.sh
./scripts/dev-reset.sh --yes
git switch main
```

不会修改 `family-ai-platform-legacy` 或任何旧平台数据。
