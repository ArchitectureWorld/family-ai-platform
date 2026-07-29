# LAN Admin / Member 直接体验

本文记录 development-only Admin Web 与局域网 Member Web 的运行边界和验收方式。
它不是 production 部署方案。

## 运行结构

```text
局域网设备
  ├─ HTTP  :9080  只允许下载本地 CA，其余路径 404
  └─ HTTPS :9443  /admin/、/member/、/api/、/health
                    │
                    ▼
              127.0.0.1:8791
              Preview Gateway

现有服务：127.0.0.1:8790（不修改、不重启）
```

- Gateway 始终保持回环监听；
- Nginx 使用 `.runtime-preview/lan-nginx` 独立 prefix，不读取 `/etc/nginx`；
- CA 使用 ECDSA P-256，有效期不超过一年；
- 服务器证书使用 IP SAN，有效期不超过 30 天；
- `9080` 不反向代理应用，只提供公开 CA 文件；
- Admin Web 仅 development 模式注册，test 与 production 返回 404；
- Docker production runtime 不复制 Admin Web 静态资源。

## 启动

必须在目标 Linux 的受保护工作树执行：

```bash
./scripts/member-preview-lan-up.sh
```

启动过程会：

1. 校验主机、用户、仓库、分支与工作树；
2. 记录 8790 的健康响应 SHA、Docker 发布行与监听行；
3. 启动或验证 `127.0.0.1:8791` Preview Gateway；
4. 生成或验证本地 CA 与 IP SAN 服务器证书；
5. 以独立 prefix 启动 Nginx；
6. 从 HTTP 与 HTTPS 两侧探测 CA、根入口、Admin、Member 和健康检查；
7. 生成或验证权限 0600 的管理员恢复入口；
8. 再次逐项比较 8790，最后只输出不含凭据的公开地址与 CA 指纹。

已初始化的 Preview 直接打开 `https://<LAN-IP>:9443/admin/`，无需激活码或复制
受保护 URL。仅在尚未建家的首次初始化中，授权操作员使用权限 0600 的 bootstrap
交接文件；不得把它的内容输出到终端、日志、剪贴板历史或聊天记录。

development Preview 明确信任同一局域网：任何能访问 `/admin/` 的设备都获得管理员
权限。production 不注册 Admin Web 或 Preview 自动入口。

## 首次设备信任

设备从下列地址下载公开 CA：

```text
http://<LAN-IP>:9080/family-ai-preview-ca.crt
```

安装前先与启动命令输出的 SHA-256 指纹核对。CA 只用于本地预览，不应部署到公网，
也不应复制 `ca.key`。

## 主要体验路径

1. 管理员入口：直接打开 `/admin/`，确认看到家庭概览和“添加成员”，而不是激活页
   或成员工作台；
2. 家庭管理：添加成人、孩子或长辈，确认成员卡片立即出现；
3. 成员配对：生成五分钟配对码，查看倒计时、二维码和本机成员入口；
4. 安全撤销：关闭配对弹窗后，旧码不可继续使用；也可显式撤销或生成新码；
5. 成员登录：成员设备扫码或输入配对码，确认进入对应 Person；
6. Chat / Work：发送 Chat、查看助理回复、创建 Work、继续对话并刷新恢复；
7. 跨设备访问：同一局域网、已信任 CA 的另一台设备可访问 `9443`，无需 SSH 隧道。

## 停止与保留

```bash
./scripts/member-preview-lan-down.sh
```

停止脚本通过 manifest、`/proc` starttime、cwd、可执行文件、配置 SHA、精确监听行和
pidfd 确认进程归属后才发送 SIGTERM。它只停止隔离 Nginx，保留：

- Preview Gateway 与 SQLite 数据；
- 本地 CA 和服务器证书；
- 管理员与成员受保护交接文件；
- 现有 8790 服务。

## 验收门禁

```bash
npm run check
npm run test:scripts
git diff --check
```

真实运行验收还必须同时确认：

- `9080` 只有 CA 下载路径返回 200；
- `9443` 使用 CA 验证后，`/`、`/admin/`、`/member/`、`/health` 正常；
- Linux 本机与局域网另一设备都能建立 HTTPS；
- 启动前后 8790 健康 SHA、Docker 行与监听行完全一致；
- runtime 密钥、Token、完整交接 URL 没有进入 Git 或命令输出。
