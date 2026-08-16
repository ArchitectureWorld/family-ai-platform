# Family AI Platform Device-Scoped Chat/Work Idempotency Design

**状态：** 已确认
**日期：** 2026-08-16
**任务：** B2 — Chat/Work 幂等返回先校验 device

## 1. 目标

修复 Chat/Work 消息入口的跨设备幂等结果泄露：同一 Person 的设备 B 不得通过复用设备 A 的 `threadRef + clientMessageId`，取得 A 已创建的 Person Message、Assistant Message 或 Provider Turn 成功结果。

本任务保留现有产品语义：原设备对完全相同请求的重放仍返回原结果；同一 Person 的多个设备仍共享其有权同步的领域事件；Gateway、SQLite、Provider Lane 和 Member Web 仍是同一套产品闭环。

## 2. 当前缺陷

`ChatWorkDomainRepository.appendThreadMessage` 当前按以下顺序执行：

1. `requireThread` 校验当前 Person、Agent、audience 和 Thread；
2. `validateMessageProvenance` 校验消息来源；
3. 用 `thread_ref + client_message_id` 查找已有消息；
4. 比较 actor、正文、发生时间和附件组成的 logical fingerprint；
5. fingerprint 相同就返回已有消息。

fingerprint 不包含 `origin.deviceRef`。因此，同一 Person 的另一个合法设备提交完全相同的 key 和 payload 时，会错误命中第一个设备的已有消息；上层 `ChatWorkMessageService` 随后还能返回已有 Provider Turn 和 `assistantMessageRef`。

## 3. 固定产品决策

现有数据库唯一键 `thread_ref + client_message_id` 保持不变，不新增 migration，也不把唯一键改为 device 复合键。

对同一 `threadRef + clientMessageId`：

| 请求关系 | 结果 | Provider 调用 |
|---|---|---|
| 同 device、同 Person/Agent/audience、同 logical fingerprint | 返回原 Message 和原 Provider Turn | 不新增 |
| 同 device、fingerprint 不同 | `409 THREAD_MESSAGE_CONFLICT` | 不新增 |
| 不同 device、payload 完全相同 | `409 THREAD_MESSAGE_CONFLICT` | 不新增 |
| 不同 device、payload 不同 | 同一个 `409 THREAD_MESSAGE_CONFLICT` | 不新增 |
| Person、Agent、audience 或 Thread 未授权 | 保持既有 not-found/permission 边界 | 不新增 |

不同设备不能独立复用同一个 `clientMessageId`。如果未来产品确实需要这种能力，必须另立设计、引入复合唯一键并重新安排后续 Schema migration；B2 不预留隐藏开关或兼容分支。

## 4. 处理顺序

`appendThreadMessage` 的安全顺序固定为：

```text
requireThread(Person + Agent + audience + Thread)
→ validateMessageProvenance(active Person device)
→ findMessageByClientId(threadRef + clientMessageId)
→ compare existing.origin.deviceRef with incoming.origin.deviceRef
→ compare logical fingerprint
→ return existing or insert new message
```

`requireThread` 与来源校验必须继续发生在已有消息查询和任何缓存结果返回之前。这样错误 Person、错误 Agent、错误 audience、已撤销设备或伪造 device 都不能通过冲突响应探测记录是否存在。

命中已有消息后，device 比较必须先于 fingerprint 比较。两个失败分支使用完全相同的公开错误：

```text
HTTP 409
code = THREAD_MESSAGE_CONFLICT
category = conflict
retryable = false
```

错误正文不得包含旧 `messageRef`、`assistantMessageRef`、正文、附件、deviceRef、Provider Session、数据库字段或本机路径。`connectionRef` 继续不参与幂等身份；同一设备断线重连后仍可正常重放。

## 5. 代码边界

生产行为只需在 `apps/gateway/src/chatWorkDomain.ts` 的既有消息幂等分支增加 device 比较。`chatWorkMessageService.ts` 已把当前认证设备传入 `origin.deviceRef`，且 Domain 冲突发生在进入 Provider Lane 之前，因此没有证据时不修改 Service。

不新增 Repository、缓存、配置项、环境变量、数据表、索引或 API 字段。Person 消息继续要求非空 `deviceRef`；Assistant/System 消息仍沿用既有内部来源规则，不开放新的客户端幂等入口。

## 6. Provider 与并发语义

消息 append 继续运行在 SQLite immediate transaction 内。并发设备使用相同 key 时，唯一键和事务串行化保证至多一个 Person Message 成功创建；另一个请求在读取已有消息后执行 device 检查并返回冲突。

跨设备冲突在 `lanes.run` 和 `prepareTurn` 之前抛出，因此：

- 不创建第二条 Person Message；
- 不创建第二个 Provider Turn；
- 不调用 Provider；
- 不返回第一个设备的 Assistant Message；
- 不改变已有成功 Turn。

原设备的完全相同重放仍进入既有 Lane，`prepareTurn` 读取已成功 Turn，并返回原 `assistantMessageRef`，`replayedProviderTurn=true`。

## 7. Device Sync 不变量

B2 只收紧消息 POST 的幂等结果返回，不改变 Person 级事件可见性。

同一 Person 的设备 A/B 仍能补拉同一 Person 有权看到的 domain event；只有 `device_sync_cursors` 的 cursor/ACK 按设备隔离。禁止在事件查询中增加 `origin_device_ref` 过滤，也禁止把 B2 实现成“只有消息来源设备能看到事件”。

## 8. 测试设计

### 8.1 Domain RED/GREEN

- 设备 A 创建消息后，设备 B 用完全相同 key、正文、时间和附件重放，当前 RED 应错误返回 A 的 Message；修复后返回 `THREAD_MESSAGE_CONFLICT`。
- 设备 B 使用同 key、不同正文得到相同公开冲突。
- 设备 A 完全相同重放仍返回原 Message；更换 `connectionRef` 仍成功。
- 错误 Person、Agent、audience、Thread 或来源设备继续先落入既有授权/来源错误。

### 8.2 Service/Provider RED/GREEN

- 设备 A 首次发送只调用 Fake Provider 一次。
- 设备 B 的同 payload 与不同 payload 重放都返回 409，Fake Provider 调用计数保持 1，响应不包含 A 的 Message/Assistant 引用或正文。
- 设备 A 重放返回原 Provider Turn，调用计数仍为 1。

### 8.3 Route 与 Sync 回归

- 用两个真实 Entry Session 通过 HTTP 路由复现跨设备冲突，验证公开错误 envelope。
- 保留不同 Person/Agent/audience 的隐藏边界。
- 证明设备 A/B 仍能同步同一 Person 的领域事件，而 cursor/ACK 继续按设备隔离。

## 9. 验收与可体验网页

行为 PR 转 Ready 前必须完成：

1. 聚焦 RED 先失败且原因精确为跨设备错误命中；
2. 聚焦 GREEN、全量 `npm run check`、静态检查和 `git diff --check`；
3. 由精确提交构建不可变 Gateway 镜像与 manifest；
4. 在独立 runtime、独立 Compose project、随机 loopback 端口运行 `dev-up.sh`、`acceptance.sh` 和附件持久化验收；
5. 真实浏览器完成两轮消息、刷新恢复、容器重启恢复和第三轮续聊；
6. 保留一个可直接打开的 Member Web 配对入口供用户体验，不在页面添加安全测试按钮、调试面板或管理员捷径；
7. 验证正式 `127.0.0.1:8790` 的 health 指纹、容器、镜像和 listener 身份未改变。

跨设备冲突由自动化和受控 HTTP fixture 验证；交付给用户的页面保持正常产品体验。

## 10. 运维、台账与回滚

本任务不改变正式端口、Hermes Home/Profile、Provider 路由或正式运行架构，因此不更新 `agent-architecture.md`。运行后立即销毁的证据 runtime 使用随机 loopback 端口，不登记为持久服务；最终保留给用户体验的 runtime 在实际端口确定后，必须同步更新 `/home/youran/data/service-ports.md` 和 `service-ports.json`，标明它是临时、loopback、非正式 `8790` 的体验入口。容器重启导致随机端口变化时，两份台账必须同步改为当前实际端口；体验 runtime 停止后也必须移除对应记录。

本任务没有数据 migration。代码回滚会重新开放跨设备幂等结果泄露，只允许用于故障定位，不能作为安全发布结果。若新实现不可用，应保持写入口 fail-closed，而不是恢复跨设备缓存命中。

## 11. 非目标

- 不允许不同设备独立复用同一 `clientMessageId`；
- 不改变 Message、Provider Turn、Domain Event 或 Sync Cursor Schema；
- 不修改 Member Web 公开协议和成功响应；
- 不实现 durable Provider Operation、浏览器 outbox 自动重发或移动 claim 重放；
- 不部署、重启或改写正式 `127.0.0.1:8790`；
- 不调用真实 Hermes/Codex Provider，不产生真实计费请求。
