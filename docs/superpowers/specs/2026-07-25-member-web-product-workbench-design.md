# Member Web Product Workbench 设计

- 日期：2026-07-25
- 分支：`feat/member-web-product-workbench`
- 目标 PR：#25
- 基线：`main` @ `d7e4530b2bce9d99fa44696d5754b7112a2a42f5`

## 1. 产品原则

本阶段不再创建任何“为了验收而存在”的页面、按钮或业务状态。

统一原则：

```text
一键启动
→ 打开真实 Member Web
→ 使用真实 Web Device / Personal Entry
→ 在正常 Chat / Work 工作状态中体验和验收
```

验收只验证正常产品行为。自动测试、运行证据和开发记录写入 Git 或 Git 忽略的 runtime 目录，不在产品页面显示调试流程。

## 2. 本阶段目标

把 PR #24 的真实浏览器入口壳升级为可以日常使用的个人工作台：

```text
Chat
- 打开唯一 HomeChatStream
- 查看消息时间线
- 发送消息
- 显示 Assistant 回复
- 加载更早消息
- 消息失败重试
- 选择消息转成 Work

Work
- 查看 Work 列表
- 创建 Work
- 打开 Work 详情
- 查看目标、摘要、状态和进度
- 在 Work 内继续对话
- 加载更早消息

Realtime / Recovery
- IndexedDB 本地持久化
- Device Sync 缺失事件补拉
- 累计 ACK
- SSE 实时事件
- 断线重连
- 多标签页共享缓存
- 离线草稿与恢复
```

## 3. 技术路线

延续 PR #24 的同源、零额外服务方案：

```text
Browser ES Modules
→ HttpOnly Cookie Personal Entry
→ Family AI Gateway
→ Chat / Work / Sync / SSE API
→ IndexedDB 本地投影
```

不引入第二个 Web 服务，不增加 CORS，不让 JavaScript 读取 Entry Session Token 或 Device Credential。

本阶段暂不引入 React/Vite。原因：

1. 当前 Gateway 已安全托管 `/member/`，现有运行镜像无需增加第二套构建链；
2. 第一版主要复杂度在同步、离线、幂等和产品状态，不在组件生态；
3. 使用小型 ES Module 边界可以保持代码可测试、可拆分，并降低 PR #14 与部署链风险；
4. 后续视觉组件规模明显扩大时，可在不改变 Gateway API 和 IndexedDB 模型的前提下迁移视图层。

## 4. 模块边界

`apps/gateway/member-public/` 拆分为：

```text
entry.js
- 配对、Session 恢复、退出和设备撤销
- 启动 ProductWorkbench

api.js
- 同源 fetch 封装
- PublicError 规范化
- Chat / Work / Sync / Web Entry 请求

store.js
- 内存状态
- 订阅与不可变快照
- Chat、Work、选中对象、草稿和同步状态

cache.js
- IndexedDB 数据库
- context / threads / messages / drafts / sync meta
- 每次事件应用与 localAppliedSequence 同事务提交

sync.js
- 启动补拉
- SSE 连接和重连
- 事件计划与目标资源刷新
- 累计 ACK
- BroadcastChannel 多标签页通知

chat.js
- Home Chat 加载
- 消息分页与去重
- 乐观消息、失败和同 clientMessageId 重试
- Chat 消息选择与转 Work

work.js
- Work 列表和创建
- Work 详情、进度和消息
- Work 消息发送与分页

render.js
- DOM 渲染
- 可访问状态、空状态、错误、Toast 和对话框

product.js
- 各模块编排
- 路由状态 `chat` / `work/:ref`
- 连接状态与生命周期清理
```

所有业务事实仍由 Gateway 权威 API 返回。本地缓存只是设备投影。

## 5. IndexedDB 模型

数据库：

```text
family-ai-member-web
version = 1
```

Object stores：

```text
meta
- key: string
- value: JSON-safe value
- keys: context, localAppliedSequence, selectedSection, selectedWorkRef

threads
- keyPath: threadRef
- Home Chat 或 Work 元数据

messages
- keyPath: messageRef
- index: threadRef
- index: [threadRef, threadSequence]

works
- keyPath: workConversationRef
- WorkConversation 当前投影

progress
- keyPath: workConversationRef
- WorkProgressSnapshot

drafts
- keyPath: threadRef
- text, updatedAt

outgoing
- keyPath: clientMessageId
- threadRef, occurredAt, content, status, error
```

事件应用规则：

```text
解析并确认 eventSequence
→ 刷新受影响的权威资源
→ 写入 IndexedDB 投影
→ 更新 localAppliedSequence
→ IndexedDB 事务提交
→ POST /api/v1/sync/ack
```

SSE 到达本身绝不直接推进服务端 Cursor。

## 6. 启动与恢复流程

```text
恢复 Web Entry Context
→ 打开 IndexedDB
→ 立即展示可用缓存
→ GET Home Chat（首次携带浏览器时区）
→ GET Work 列表
→ 刷新当前 Chat / Work 最新消息
→ 默认 GET /api/v1/sync/events 补拉服务端未 ACK 事件
→ 应用并 ACK
→ 建立 SSE
```

如果 IndexedDB 为空但服务端 Device Cursor 已经前进，主资源 REST 初始化仍会重建当前 Chat / Work 投影，因此不会依赖完整事件历史重建界面。

## 7. Chat 产品行为

### 7.1 唯一 Chat

用户进入工作台默认打开唯一 Home Chat，不显示“新建 Chat”。首次调用：

```http
GET /api/v1/chat?timezone=<IANA timezone>
```

### 7.2 消息加载

默认读取最近 100 条：

```http
GET /api/v1/threads/:threadRef/messages?limit=100
```

如果 `nextBeforeSequence` 非空，显示“加载更早消息”。合并消息时按 `messageRef` 去重、按 `threadSequence` 升序。

### 7.3 发送与重试

发送前创建：

```text
clientMessageId = web:<crypto.randomUUID()>
occurredAt = 第一次发送时间
```

界面立即显示乐观消息。请求失败时保留同一个 `clientMessageId`、`occurredAt` 和内容，用户点击重试时原样提交，复用 Gateway 幂等和 Provider Turn 恢复能力。

离线状态不显示“已发送”，只保存草稿和明确的离线提示。

### 7.4 Chat 转 Work

用户进入选择模式，选择 1–100 条真实消息，填写 Work 标题和目标，调用：

```http
POST /api/v1/chat/work-conversions
```

不复制全部 Chat 历史；转换成功后刷新 Work 列表并打开新 Work。

## 8. Work 产品行为

Work 列表按 Gateway 返回顺序展示，包含标题、目标、状态和最近活动时间。

创建 Work：

```http
POST /api/v1/work-conversations
```

打开 Work 时加载：

```text
WorkConversation 元数据
Thread 消息
Work Progress（404 表示尚无快照）
```

Work 内消息发送、失败重试和历史分页与 Chat 共用同一消息控制器，不复制两套发送逻辑。

当前 Gateway 没有 Work 状态修改命令，因此本阶段只展示状态，不伪造暂停、完成或归档按钮。

## 9. 实时同步

### 9.1 启动补拉

```http
GET /api/v1/sync/events
```

按 `nextAfterSequence` 分页，逐页应用。每页本地事务成功后累计 ACK 最后事件。

### 9.2 SSE

```http
GET /api/v1/events/stream?afterSequence=<localAppliedSequence>
```

使用同源 `EventSource`，监听 `domain-event`。已知事件映射：

```text
chat.home.created
→ 刷新 Home Chat

work.created / chat.work.created
→ 刷新 Work 列表

thread.message.created
→ 刷新对应 Thread 最近消息

work.progress.updated
→ 刷新 Work 列表与进度

thread.provider_turn.failed
→ 标记对应 outgoing 为失败并展示可重试错误

thread.provider_turn.succeeded
→ 刷新对应 Thread 消息

未知 Opaque Event
→ 保存序号、忽略业务内容、仍可 ACK
```

### 9.3 重连

SSE `error` 时：

```text
关闭当前 EventSource
→ 检查 Web Entry Context
→ 401 时尝试 renew
→ 网络恢复后先补拉
→ 再建立 SSE
```

采用指数退避，最大 30 秒。`online` 事件立即触发补拉重连。

### 9.4 多标签页

使用：

```text
BroadcastChannel("family-ai-member-web")
```

广播：

```text
cache-updated
sync-sequence
selected-work-changed
```

多个标签页允许同时保持 SSE；服务端 ACK 单调，IndexedDB 共享且事件写入幂等。任一标签页 ACK 前必须先完成共享 IndexedDB 事务。

## 10. 页面结构

桌面端：

```text
左侧：身份、Chat、Work 列表、创建 Work、设备操作
中间：当前 Chat / Work 消息时间线与 Composer
右侧：当前 Work 目标、摘要、状态、阶段进度和待确认项
```

Chat 模式不展示无意义的右侧仪表盘；右侧收敛为轻量上下文卡片。

移动浏览器：

```text
顶部：身份与连接状态
主区：当前 Chat / Work
底部：Chat / Work 导航
Work 详情通过抽屉打开
```

产品页面不展示内部 Ref、Token、验收步骤、SQL、Provider Session 或调试日志。

## 11. 可访问性与交互

- 所有按钮有明确文本或 `aria-label`；
- 消息区使用 `aria-live="polite"` 提示新 Assistant 回复；
- Composer 支持 `Enter` 发送、`Shift+Enter` 换行；
- 发送中、失败、离线、重试和连接状态不能只靠颜色表达；
- 对话框使用原生 `<dialog>`；
- Focus 在打开/关闭对话框后恢复；
- 支持 `prefers-reduced-motion`；
- 触控目标不小于 44px。

## 12. 安全与隐私

保持 PR #24 边界：

```text
Cookie HttpOnly / SameSite=Strict
production Secure
unsafe request 自定义 Header + same-origin 校验
Header 认证优先
```

IndexedDB 允许保存：

```text
当前 Person Context 的非敏感展示字段
Chat / Work 元数据
消息正文
草稿
同步序号
```

IndexedDB 禁止保存：

```text
Device Credential
Entry Session Token
Authorization Header
Provider External Session
配对码
```

退出当前 Session 时保留设备缓存但锁定显示；移除浏览器时清空 IndexedDB、localStorage installation id 和内存状态。

## 13. 错误与状态

统一产品状态：

```text
connecting
online
syncing
offline
session_expired
device_revoked
degraded
```

错误处理：

- `ENTRY_SESSION_EXPIRED`：自动 renew；
- `ENTRY_SESSION_INVALID`：进入恢复或配对；
- `DEVICE_REVOKED`：清空本地敏感投影并要求重新配对；
- `THREAD_MESSAGE_CONFLICT`：停止自动重试并提示刷新；
- Provider `502/504`：显示该消息“回复失败，可重试”；
- 其他可重试错误：保留草稿/Outgoing 并显示重试；
- 未知错误：不显示内部堆栈。

## 14. 一键体验

现有 `./scripts/verify-foundation.sh` 继续输出真实 `/member/` 配对链接。

本阶段的一键体验验收是在产品中完成：

```text
打开链接并完成真实配对
→ Chat 发送一句话并看到 Assistant 回复
→ 创建一个 Work
→ 在 Work 内继续一轮对话
→ 刷新页面，状态和消息恢复
→ 重启 Gateway，页面补拉并恢复
```

产品页面不出现“一键验收”按钮。脚本自动测试和证据写入 Git 忽略的 runtime 目录。

## 15. PR 范围

允许修改：

```text
apps/gateway/member-public/**
apps/gateway/src/memberWeb.ts
apps/gateway/test/memberWeb*.test.ts
apps/gateway/test/memberProduct*.test.ts
Dockerfile（仅必要时）
scripts/verify-foundation.sh（仅产品体验说明）
docs/superpowers/**
docs/development/**
README.md（最终阶段记录）
```

如公共 API 形状已足够，不修改 Gateway Chat / Work / Sync 领域代码。

明确不修改：

```text
clients/ios/**
.github/workflows/ios-ci.yml
packages/contracts/src/mobileEntry.ts
packages/contracts/fixtures/mobile-entry/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
```

## 16. 非目标

本阶段不实现：

- 文件上传与预览；
- Markdown 富文本和代码高亮；
- Work 状态修改命令；
- Push Notification；
- 管理后台；
- 语音、图片和相机；
- 服务端全文搜索；
- 微服务或独立 Web 部署。

## 17. 验收标准

1. 正常产品工作台可以完成配对、Chat、Work 和实时恢复；
2. Chat 发送后 Person 与 Assistant 消息按序出现；
3. 相同失败消息使用同一 `clientMessageId` 重试；
4. Work 可创建、打开并独立对话；
5. Chat 可选择消息转成 Work；
6. 刷新和 Gateway 重启后状态恢复；
7. IndexedDB 写入成功后才 ACK；
8. SSE 和显式补拉不会造成消息重复；
9. 多标签页共享缓存并保持服务端 Cursor 单调；
10. 离线不伪装为已发送；
11. 页面不暴露 Token、Credential、内部调试内容；
12. `clients/ios/**` 与 `.github/workflows/ios-ci.yml` 零改动；
13. 全仓 test、static check、typecheck、build 与 Secret Scan 通过；
14. 最终体验证据只写入 Git 文档和 Git 忽略的 runtime 文件。