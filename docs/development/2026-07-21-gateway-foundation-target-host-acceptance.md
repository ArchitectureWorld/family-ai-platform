# Gateway Foundation 目标主机验收归档

- 日期：2026-07-21
- 仓库：`ArchitectureWorld/family-ai-platform`
- Pull Request：#2 `feat: build Gateway foundation from scratch`
- 验收分支：`feat/gateway-foundation`
- 验收环境：目标 Linux 主机，Docker Compose V2，本机回环地址 `127.0.0.1:8790`

## 验收边界

本次验收仅覆盖 Gateway Foundation 技术闭环：

- 全新空数据库启动；
- development bootstrap；
- 设备 Token Hash 认证；
- 固定成员到个人助理 Agent 的路由；
- 会话创建、消息发送和历史读取；
- Fake Provider 多轮连续性；
- Provider Session 跨容器重启恢复；
- 幂等重放和冲突拒绝；
- Docker 一键构建、启动和本机浏览器验收台。

本次不包含正式 Member/Admin Web、真实 Hermes/Provider、正式配对体系、附件、局域网或公网部署。

## 目标主机验证结果

目标主机操作人确认以下结果均正确：

1. `./scripts/verify-foundation.sh` 完成 Docker 构建、Gateway 启动和自动验收；
2. `GET /health` 返回 `ok: true`、协议版本 `1.0`，并包含服务身份 `family-ai-gateway-foundation`；
3. 浏览器打开 development-only 的 `Family AI Gateway 验收台`，不再连接旧个人助理服务；
4. 页面能够读取测试成员、测试设备和固定个人助理身份；
5. 能够创建体验会话；
6. 第一轮消息返回 `Fake Provider 第 1 轮回复。`；
7. 第二轮消息返回 `Fake Provider 第 2 轮回复。`；
8. 刷新页面后消息历史仍存在；
9. 自动验收日志中的健康检查、身份认证、会话创建、两轮消息、历史持久化、幂等重放、幂等冲突、跨 Agent 拒绝、容器重启恢复、重启后第三轮延续和最终历史均通过。

## 现场问题及修正

目标主机最初存在旧 Family AI 个人助理服务占用 `127.0.0.1:8790` 的问题，导致新容器无法绑定端口，并使浏览器误连旧页面。Foundation 随后完成以下隔离修正：

- Compose 项目名固定为 `family-ai-platform-foundation`；
- Foundation 镜像名使用独立命名空间；
- 健康接口增加稳定服务身份；
- Compose 健康检查、启动脚本和验收脚本均校验服务身份，而不再只判断 HTTP 200；
- 目标主机旧服务被清理后，新 Gateway 正常绑定 `127.0.0.1:8790`。

## 结论

目标主机操作人已完成人工页面验收并确认测试内容无异常。结合仓库内已有的 contracts、Provider SDK、Gateway 测试和本次真实 Docker/原生 SQLite 目标主机运行证据，Gateway Foundation 已达到 PR #2 的合并门槛。

本记录不包含设备 Token、Authorization Header、数据库内容、绝对本地路径或其他敏感运行信息。
