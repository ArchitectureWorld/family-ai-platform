# Gateway Chat / Work SSE Verification Evidence

- 日期：2026-07-24
- 设计：`docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md`
- 计划：`docs/superpowers/plans/2026-07-24-gateway-chat-work-sse.md`
- 分支：`feat/gateway-chat-work-sse`
- 基线：`main` @ `4bba487ce675f3b338c343185514915a25a6bb2d`
- PR：#20 `feat(gateway): stream Chat Work events over SSE`

## 1. 完成范围

本阶段实现了：

```text
Personal Entry Session 认证
→ GET /api/v1/events/stream
→ afterSequence / Last-Event-ID 排他 Cursor
→ Person 共享持久化事件 Pump
→ SSE 严格升序分发
→ 心跳与授权复核
→ 单连接背压和队列保护
→ 客户端断开与 Gateway 关闭清理
```

SSE 的唯一权威来源仍为 `domain_events`。SSE 不 claim `outbox_events`，也不调用 `markPublished()`。

## 2. HTTP 与帧协议

正式接口：

```http
GET /api/v1/events/stream?afterSequence=123
Authorization: Bearer <entry-session-token>
X-Entry-Session-Ref: entry-session:...
Last-Event-ID: 123
```

规则已经通过自动测试验证：

- 只允许 `personal` Entry Session；
- 缺失或无效 Session 返回未包装的 Chat / Work `PublicError`；
- `family_admin` 被拒绝；
- Device Credential 不能替代 Personal Entry Session；
- Cursor 必须是非负安全十进制整数；
- query 与 `Last-Event-ID` 同时存在时必须相等；
- 未知查询参数被拒绝；
- Cursor 为排他语义，只发送更大的 `eventSequence`；
- 响应使用 `text/event-stream`、`no-cache, no-transform` 和 `X-Accel-Buffering: no`。

连接帧：

```text
retry: 3000
: connected

```

事件帧：

```text
id: 124
event: domain-event
data: {"eventSequence":124,...}

```

心跳帧：

```text
: heartbeat 2026-07-24T...

```

连接和心跳帧均没有 `id`，不会推进 Cursor。

## 3. Person 共享 Pump

`PersonEventStreamHub` 按 Person 维护 Subscriber 集合。测试验证：

- 同一 Person 的多个连接共享一组事件查询；
- 不同 Cursor 的连接只排队各自尚未收到的事件；
- 单连接内事件严格升序；
- 205 条事件可以跨页完整补发；
- 重复 Pump 不会在同一连接内重复排队；
- 不同 Person 的事件和 Cursor 相互隔离；
- 一个 Person 的数据库查询失败不会让其他 Person 的 Pump 失败；
- 失败 Person 会在后续轮询中重新尝试。

## 4. 背压与资源保护

每个 Subscriber 使用独立 FIFO 写队列。测试验证：

- `write()` 返回 `false` 时等待 `drain`；
- 慢连接不会阻塞健康连接；
- 队列超过 256 帧或 1 MiB 时只关闭对应连接；
- 队列计数只统计尚未完成的实际帧；
- 关闭连接会释放等待中的 `drain`；
- Subscriber 注销时清空内存中的 Entry Session Ref 和 Token；
- Hub `close()` 停止轮询和心跳、关闭所有 Subscriber，并在 SQLite 关闭前完成清理；
- 活跃 SSE 响应不会阻塞 `app.close()`。

## 5. 心跳授权复核

每轮心跳重新调用 `EntrySessionAuthenticator.authenticate()`。测试验证：

- Session 有效、Person 一致且 audience 为 `personal` 时发送心跳；
- Session 过期、Device 撤销、入口无效、Person 不一致或 audience 不符时关闭连接；
- 单连接授权复核抛出异常时，只关闭该连接；
- 其他健康连接继续收到同一轮心跳；
- 心跳不会读取或修改 Outbox。

## 6. 端到端实时事件

真实 Fastify 监听器与 Node Fetch 流式客户端验证了：

```text
Home Chat 已建立
→ SSE 从 Cursor 1 连接
→ Person 发送消息
→ Provider 生成 Assistant 回复
→ SSE 收到 sequence 2、3、4
```

对应事件严格为：

```text
thread.message.created       actorType=person
thread.message.created       actorType=assistant
thread.provider_turn.succeeded
```

断言确认 SSE 数据中不存在：

```text
Person 消息正文
Assistant / Fake Provider 输出正文
Provider External Session
Entry Session Token
```

SSE 客户端收到事件后，对应 Outbox 行仍保持：

```text
status = pending
published_at = NULL
```

因此浏览器消费不会错误完成全局 Outbox 投递。

## 7. 跨 Person 隔离

端到端测试建立了同一家庭中的两个 Person、两个 Personal Entry Session、两个独立 Home Chat 和两个并行 SSE 连接。

验证结果：

- 两个 Person 都从自己的 `eventSequence = 1` 开始；
- Owner 连接只收到 Owner 的 `chat.home.created`；
- 第二位成人连接只收到自己的 `chat.home.created`；
- 任一帧均不包含另一 Person Ref。

## 8. TDD 与调试证据

| 阶段 | 运行 | 结果 | 证明内容 |
|---|---:|---|---|
| SSE 协议缺失 | CI #292 | RED | `eventStream.ts` 尚不存在 |
| Cursor 与帧协议 | CI #293 | GREEN | 严格 Cursor 和三类 SSE 帧 |
| 共享 Hub 缺失 | CI #294 | RED | `PersonEventStreamHub` 尚未实现 |
| 初始共享 Hub | CI #295 | RED | 测试错误地把排队当作同步写完成 |
| 异步 Sink 等待修正 | CI #296 | GREEN | 共享查询、顺序、分页、去重 |
| 背压与心跳保护缺失 | CI #297 | RED | drain、队列和授权复核尚未实现 |
| 初始 Promise 队列 | CI #298 | RED | 健康连接短暂被计为积压 |
| 显式 FIFO 队列 | CI #299 | GREEN | 只统计真实未完成帧 |
| SSE 路由缺失 | CI #300 | RED | 正式路由尚未注册 |
| 路由模块已写但 App 未接线 | CI #301 | RED | `buildGatewayApp()` 尚未注册 Hub |
| Gateway 接线 | CI #302 | RED | 测试复用了上一用例已关闭的随机端口 |
| 测试监听器隔离 | CI #303 | GREEN | 认证、Cursor、响应头和历史补发 |
| Person Pump 异常传播 | CI #304 | RED | 单 Person 查询异常向上拒绝 `pumpAll()` |
| Person Pump 隔离 | CI #305 | GREEN | `Promise.allSettled` 保持健康通道 |
| 实时流和 Outbox 边界 | CI #306 | GREEN | Person / Assistant / Provider 实时事件与关停 |
| 心跳异常传播 | CI #307 | RED | 单连接认证异常中止心跳循环 |
| 心跳异常隔离 | CI #308 | GREEN | 异常连接单独关闭，健康连接继续 |
| 跨 Person 端到端隔离 | CI #309 | GREEN | 两个 Personal Entry 流完全隔离 |

后续文档提交继续由完整 CI 与 Secret Scan 验证。PR 转为 Ready 前，以 GitHub 上最新 Head 的结果作为最终门禁；具体编号记录在 PR 正文中。

## 9. 设计审查结论

完成前审查修正了四个非表面问题：

1. Pump 不应等待 Socket 写完，否则慢连接会阻塞 Person 事件查询；测试改为显式等待 Sink，而不是改变生产并发模型。
2. Promise `finally` 才减少队列计数会误伤健康连接；改为显式 FIFO，只保留真实未完成帧。
3. 单 Person 查询失败不能拒绝整个 `pumpAll()`；改为 Person 级 settled 隔离。
4. 单连接授权复核异常不能中止全局心跳；改为关闭异常 Subscriber 后继续循环。

实现与书面设计保持一致。增加了三个更聚焦的测试文件：

```text
apps/gateway/test/eventStreamLive.test.ts
apps/gateway/test/eventStreamResilience.test.ts
apps/gateway/test/eventStreamPersonIsolation.test.ts
```

这是测试组织上的细分，不改变生产范围或公共接口。

路由清理监听 `request.raw.aborted`、`reply.raw.close` 和 `reply.raw.error`。没有监听普通 `request.raw.close`，因为 Node 的 IncomingMessage `close` 也可能表示请求读取完成，不能据此提前关闭仍在工作的 SSE 响应；响应侧 `close` 已覆盖真实连接终止。

## 10. PR #14 隔离

本 PR 的生产代码仅修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/eventStream.ts
```

其余改动仅为 Gateway 测试和 SSE 设计、计划、证据文档。

本 PR 没有修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
apps/gateway/public/**
```

PR #14 继续保持独立 Draft，等待真实 Mac、iPhone 与部署 Gateway 的真机验收。

## 11. 最终门禁规则

PR 转为 Ready 前必须同时满足：

- 最新 Head 的 Repository CI 成功；
- 最新 Head 的 Secret Scan 成功；
- GitHub 报告 PR mergeable；
- PR #20 与 PR #14 changed-path 交集为零；
- PR #14 仍为 Open、Draft，Head 不变；
- PR #20 没有未解决 Review Thread。

最终 Head 和检查编号以 PR 正文为准。本文件冻结，不再追写自身提交 SHA 或检查编号。

## 12. 延后范围

以下内容继续放在独立 PR：

- Device Sync Cursor 和显式补拉 API；
- Push Notification；
- Outbox 外部发布 Worker；
- 公共跨终端 Event Contract；
- HTTP 202 / Operation 生命周期；
- 正式 Member Web；
- iOS Chat / Work 接入；
- 浏览器一键验收台改动。
