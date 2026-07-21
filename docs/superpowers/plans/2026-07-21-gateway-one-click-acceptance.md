# Gateway One-Click Acceptance Plan

**目标：** Foundation PR 只有在一键 Docker 部署、浏览器体验验收、自动验收脚本和重启恢复全部通过后才能转为 Ready。

## 交付入口

```bash
./scripts/dev-up.sh
./scripts/acceptance.sh
./scripts/dev-down.sh
./scripts/dev-reset.sh
```

- `dev-up.sh`：检查 Docker/Compose，生成 `.runtime`、随机开发 Token 和环境文件，构建并启动 Gateway，等待健康检查，输出并尽量打开验收 URL。
- `acceptance.sh`：执行健康、认证、创建会话、两轮消息、历史、幂等重放、幂等冲突、跨 Agent 拒绝、容器重启和重启恢复，并生成脱敏 Markdown 报告。
- `dev-down.sh`：停止服务但保留数据库。
- `dev-reset.sh`：明确确认后删除一次性开发数据。

## 浏览器体验

开发模式同源提供轻量验收控制台：身份确认、创建会话、发送两轮消息、显示历史、刷新恢复、重启恢复和结构化错误。Token 从 URL fragment 读取后立即清除，只保存在当前页面内存中。

## 安全边界

- 端口只发布到 `127.0.0.1:8790`；
- Token、SQLite、环境文件和运行报告只写入 Git 忽略的 `.runtime/`；
- 不包含正式 Member/Admin Web、配对、附件、真实 Provider、局域网或公网；
- 不复制旧 Gateway 业务代码和旧数据库 Schema。

## Ready 门禁

- `npm ci && npm run check`；
- `docker compose build`；
- 干净 `.runtime` 下 `dev-up.sh` 成功；
- `acceptance.sh` 全部通过；
- 浏览器手工完成两轮消息、刷新恢复和容器重启恢复；
- 仓库扫描无 Token、数据库、旧路径、`/home/` 生产引用和旧库名称。
