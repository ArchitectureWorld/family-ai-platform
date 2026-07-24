# Gateway Device Sync Cursor 与显式事件补拉设计

- 日期：2026-07-24
- 状态：待书面审阅
- 目标分支：`feat/gateway-device-sync-cursor`
- 基线：`main` @ `90fdd8f0fa42b5488f15186ef1c7d4f9fd90cf1d`
- 前置：PR #15–#21 已合并

## 1. 目标

在已有 `domain_events + SSE` 基础上，为每台受控设备建立持久化、可恢复、单调前进的同步位置，并提供显式缺失事件补拉与累计 ACK：

```text
Personal Entry Session
→ 解析当前 Person 与 Device
→ 读取该设备的 acknowledgedSequence
→ 显式补拉缺失事件
→ 客户端可靠应用到本地状态
→ 显式 ACK 最后成功处理的事件
→ Gateway 持久化单调 Cursor
```

本阶段解决的是“某台设备已经可靠处理到哪里”，而不是“某个 HTTP 响应或 SSE Socket 已经写到哪里”。

## 2. 核心决策

持久化主键固定为：

```text
(deviceRef, personRef)
```

不使用：

```text
entrySessionRef
entryBindingRef
浏览器标签页 ID
SSE connectionRef
```

原因：

- Entry Session 会续期和更换，不是长期同步身份；
- EntryBinding 表示入口授权，不表示设备已经处理到哪个事件；
- 一个设备上的多个页面或连接应共享设备级进度；
- 新设备具有新的 `deviceRef`，必须从独立 Cursor 开始；
- 当前认证上下文已经从可信凭据解析出 `personRef` 与 `deviceRef`，客户端无需也不得自行声明。

## 3. 范围

### 3.1 包含

- 持久化 `device_sync_cursors`；
- 当前设备 Cursor 查询；
- 显式 Person Event 补拉；
- `afterSequence` 排他读取；
- 分页与 `latestSequence`；
- 累计 ACK；
- ACK 事件身份校验；
- Cursor 单调前进与幂等；
- Entry Session 续期后的 Cursor 延续；
- 新设备独立 Cursor；
- Gateway 重启恢复；
- Person、Device 与家庭隔离；
- 与现有 SSE 的职责分离；
- 自动测试、设计、实施计划和验证证据。

### 3.2 不包含

- 修改 SSE 帧协议；
- SSE 自动 ACK；
- Push Notification；
- Outbox 外部发布 Worker；
- 事件保留期和事件清理；
- 正式 Member Web；
- iOS Chat / Work 接入；
- 浏览器验收台修改；
- `packages/contracts` 公共 Event / Sync Schema；
- 多 Gateway 实例协调；
- 按页面或连接维护独立 Cursor。

正式客户端接入前，将另行评审是否把稳定后的 Event / Sync DTO 导出到 `packages/contracts`。本 PR 只建立 Gateway 端权威行为，不提前修改 PR #14 正在消费的公共协议路径。

## 4. 方案选择

### 4.1 方案 A：显式补拉 + 显式累计 ACK（采用）

```text
GET /api/v1/sync/events
POST /api/v1/sync/ack
```

只有客户端完成本地处理并主动 ACK 后，Gateway 才推进持久化 Cursor。

优点：

- HTTP 传输成功不等于本地处理成功；
- SSE 写入 Socket 不等于本地处理成功；
- 网络中断时可以从最后 ACK 位置安全重放；
- Web、iOS、HarmonyOS 和 DIY 可以使用同一语义；
- ACK 可幂等并支持并发标签页；
- 服务端不会因瞬时连接状态错误跳过事件。

### 4.2 方案 B：GET 返回后自动推进（不采用）

服务端无法知道响应是否被完整读取、解析和写入客户端持久缓存。半途中断可能造成事件被错误视为已处理。

### 4.3 方案 C：每个 SSE 帧单独 ACK（不采用）

会把可靠同步绑定到 SSE，增加大量小请求，并让离线补拉、页面刷新和后台恢复变复杂。

## 5. 数据模型

领域事件子系统 Schema 从版本 1 升到版本 2，新增：

```sql
CREATE TABLE device_sync_cursors (
  device_ref TEXT NOT NULL
    REFERENCES managed_devices(device_ref) ON DELETE CASCADE,
  person_ref TEXT NOT NULL
    REFERENCES persons(person_ref) ON DELETE CASCADE,
  acknowledged_sequence INTEGER NOT NULL
    CHECK (acknowledged_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_ref, person_ref)
);

CREATE INDEX device_sync_cursors_person_sequence_idx
  ON device_sync_cursors(person_ref, acknowledged_sequence, device_ref);
```

### 5.1 Schema 归属

该表由 `DomainEventStore` 的独立事件 Schema migration 管理，而不是增加 Gateway Core Migration V6。

理由：

- Cursor 直接依赖 Person Event Sequence；
- `domain_event_schema_migrations` 已是事件子系统的独立迁移账本；
- 避免无关修改 `apps/gateway/src/database.ts`；
- 减少与其他 Gateway 基础开发的冲突面。

实现需把当前一次性事件 Schema 安装拆分为可重复执行的：

```text
Domain Event Migration V1
→ domain_events / outbox_events / triggers

Domain Event Migration V2
→ device_sync_cursors
```

新库依次安装 V1、V2；已有 V1 数据库只安装 V2，不重建或重写已有事件。

### 5.2 默认值与生命周期

- 不存在 Cursor 行等同于 `acknowledgedSequence = 0`；
- 首次有效 ACK 时懒创建；
- GET 补拉不会创建 Cursor 行；
- Session 续期不会新增 Cursor；
- Entry Session logout 不删除 Cursor；
- Device revoke 后 Cursor 可以保留到设备记录删除，认证层会阻止继续访问；
- 新 Device Ref 不继承旧设备 Cursor；
- Person 删除或 Device 删除时通过外键级联清理。

### 5.3 不变量

```text
acknowledged_sequence >= 0
Cursor 只能增加，不能回退
Cursor 属于一个确定的 Device + Person
ACK 的 eventRef 与 eventSequence 必须对应当前 Person 的真实事件
```

如果存储中的 Cursor 大于该 Person 当前 `latestSequence`，视为数据库完整性异常，不能自动回退。

## 6. 组件边界

### 6.1 `DomainEventStore`

继续拥有事件日志查询，并新增窄接口：

```ts
getLatestPersonSequence(personRef: string): number;

findPersonEvent(input: {
  personRef: string;
  eventSequence: number;
  eventRef: string;
}): DomainEvent | null;
```

已有：

```ts
listPersonEvents({ personRef, afterSequence, limit }): DomainEventPage;
```

`DomainEventStore` 不保存设备 Cursor，也不处理 HTTP。

### 6.2 `DeviceSyncRepository`

新文件：

```text
apps/gateway/src/deviceSync.ts
```

职责：

```text
readCursor(deviceRef, personRef)
acknowledge(deviceRef, personRef, eventSequence, eventRef)
```

依赖：

- Gateway SQLite；
- `DomainEventStore`；
- 时钟。

它不认证请求、不解析客户端身份、不发送 HTTP 响应。

### 6.3 `registerDeviceSyncRoutes`

新文件：

```text
apps/gateway/src/deviceSyncRoutes.ts
```

职责：

- Personal Entry Session 认证；
- 严格 Query / Body 校验；
- 从认证上下文解析 Device 与 Person；
- 调用 `DomainEventStore` 和 `DeviceSyncRepository`；
- 返回统一 PublicError。

## 7. 显式事件补拉 API

### 7.1 接口

```http
GET /api/v1/sync/events
```

可选参数：

```http
GET /api/v1/sync/events?afterSequence=120&limit=100
```

认证：

```http
Authorization: Bearer <entry-session-token>
X-Entry-Session-Ref: entry-session:...
```

只允许 `personal` audience。

### 7.2 Query Schema

```ts
{
  afterSequence?: decimalSafeNonNegativeIntegerString,
  limit?: decimalIntegerStringBetween1And200
}
```

规则：

- Schema 为 strict；
- 未知参数拒绝；
- 数组形式拒绝；
- `afterSequence` 必须是非负安全整数；
- `limit` 默认 100，最大 200；
- Cursor 是排他的，只返回 `eventSequence > requestedAfterSequence`。

### 7.3 起始 Cursor 选择

```text
请求未提供 afterSequence
→ requestedAfterSequence = persisted acknowledgedSequence

请求显式提供 afterSequence
→ requestedAfterSequence = 请求值
```

显式值允许：

- 小于持久化 Cursor：用于安全重放和诊断；
- 等于持久化 Cursor：常规补拉；
- 大于持久化 Cursor：允许只读查询，但不会推进持久化 Cursor。

GET 无论成功、失败或返回空数组，都不能修改 `device_sync_cursors`。

### 7.4 响应

```json
{
  "protocolVersion": 1,
  "sync": {
    "deviceRef": "device:...",
    "personRef": "person:...",
    "acknowledgedSequence": 120,
    "requestedAfterSequence": 120,
    "latestSequence": 126
  },
  "events": [
    {
      "eventRef": "event:...",
      "personRef": "person:...",
      "eventSequence": 121,
      "eventType": "thread.message.created",
      "aggregateType": "thread_message",
      "aggregateRef": "message:...",
      "threadRef": "thread:...",
      "payload": {
        "messageRef": "message:...",
        "actorType": "assistant"
      },
      "occurredAt": "2026-07-24T12:00:00.000Z",
      "createdAt": "2026-07-24T12:00:00.000Z"
    }
  ],
  "nextAfterSequence": null
}
```

规则：

- `acknowledgedSequence` 是请求开始时读取的持久化值；
- `requestedAfterSequence` 是本次实际查询起点；
- `latestSequence` 是响应生成时 Person Event Log 的最新序号；
- `events` 严格升序；
- `nextAfterSequence` 非空时，客户端以该值继续分页；
- 空 Person Event Log 的 `latestSequence` 为 0；
- 事件保持当前内部 `DomainEvent` 结构，不增加消息正文或凭据。

## 8. 累计 ACK API

### 8.1 接口

```http
POST /api/v1/sync/ack
Content-Type: application/json
```

请求：

```json
{
  "protocolVersion": 1,
  "eventSequence": 126,
  "eventRef": "event:..."
}
```

Body 为 strict，客户端不能提交：

```text
deviceRef
personRef
entryBindingRef
entrySessionRef
acknowledgedSequence
updatedAt
```

### 8.2 ACK 身份校验

在推进 Cursor 前必须验证：

```text
eventRef 存在
eventSequence 存在
eventRef 与 eventSequence 对应
事件属于当前认证 Person
```

其他 Person 的事件、错误 eventRef 或不存在序号统一表现为：

```text
SYNC_EVENT_NOT_FOUND
HTTP 404
```

不能通过错误差异泄露其他 Person 的事件。

### 8.3 累计语义

ACK `126` 表示：

```text
当前 Device 已可靠处理该 Person 的所有事件 1–126
```

推进规则：

```text
无 Cursor，ACK 126
→ 创建 Cursor 126

当前 120，ACK 126
→ 更新为 126

当前 126，ACK 126
→ 幂等成功，不改时间

当前 126，ACK 120
→ 保持 126，不回退，不改时间
```

ACK 不要求客户端证明它通过哪个连接或分页取得事件。认证设备只能影响自己的同步位置，错误提前 ACK 不得改变领域数据、其他设备 Cursor 或其他 Person Cursor。

### 8.4 响应

```json
{
  "protocolVersion": 1,
  "sync": {
    "deviceRef": "device:...",
    "personRef": "person:...",
    "previousSequence": 120,
    "acknowledgedSequence": 126,
    "advanced": true,
    "updatedAt": "2026-07-24T12:00:00.000Z"
  }
}
```

`advanced` 只有在持久化值实际增加时为 `true`。

## 9. ACK 事务与并发

`acknowledge()` 必须在一个 SQLite 事务中完成：

```text
读取当前 Cursor
→ 验证当前 Person 的 eventRef + eventSequence
→ 计算 max(current, requested)
→ 仅在增加时 INSERT / UPDATE
→ 返回 previous / final / advanced
```

同一设备多个页面并发 ACK：

```text
标签页 A ACK 125
标签页 B ACK 130
```

最终值必须稳定为 130，不得因提交顺序回退。

SQLite 单 Gateway、同步事务和主键约束足以满足第一版，不引入分布式锁或版本号 CAS。

## 10. SSE 与持久化 Cursor 的关系

SSE 继续负责快速通知：

```text
有新事件
→ SSE 尽快通知在线客户端
```

Device Sync Cursor 负责可靠确认：

```text
客户端收到或补拉事件
→ 查询相关 Chat / Work 数据
→ 写入设备共享本地持久状态
→ 本地事务成功
→ POST /api/v1/sync/ack
```

明确禁止：

```text
SSE 写入 Socket
→ Gateway 自动 ACK
```

现有 SSE 路由保持：

```text
GET /api/v1/events/stream?afterSequence=...
Last-Event-ID: ...
```

本 PR 不把 SSE 默认 Cursor 改为持久化 Device Cursor。客户端恢复时应先调用显式补拉 API，再使用自己最后成功处理的事件位置建立 SSE。

## 11. 推荐客户端恢复流程

```text
1. 使用 Personal Entry Session 调用 GET /api/v1/sync/events
2. 服务端默认从 persisted acknowledgedSequence 补拉
3. 客户端严格按 eventSequence 应用事件
4. 每批本地持久化成功后 ACK 最后一个事件
5. 重复分页直到 nextAfterSequence = null
6. 建立 SSE，使用最后成功处理的 sequence
7. SSE 到达新事件后应用并累计 ACK
8. 断线后重复步骤 1
```

该流程提供至少一次恢复语义。客户端必须按 `eventSequence` 幂等处理重放。

## 12. Session、设备与撤销语义

### 12.1 Session 续期

Mobile Session renew 为同一长期 EntryBinding 签发新 Entry Session，但认证上下文仍解析到同一：

```text
deviceRef
personRef
```

因此 Cursor 自动延续，不复制、不迁移。

### 12.2 Logout

Logout 撤销当前 Entry Session，不删除 Device Cursor。设备重新获得有效 Personal Entry 后继续原进度。

### 12.3 新设备

新设备具有新的 `deviceRef`：

```text
old device Cursor = 126
new device Cursor = 0
```

新设备必须独立补拉，不继承旧设备确认状态。

### 12.4 Device revoke

Device revoke 后：

- GET 补拉失败；
- POST ACK 失败；
- SSE 心跳关闭连接；
- Cursor 行不参与认证，不会恢复设备权限；
- 后续若设备记录被删除，外键级联删除 Cursor。

## 13. Web 多标签页语义

同一浏览器设备的多个页面共享：

```text
deviceRef + personRef Cursor
```

正式 Member Web 后续必须：

- 使用设备共享的 IndexedDB 或等价持久存储；
- 只有事件效果写入共享本地状态后才 ACK；
- 不把 React 内存渲染成功视为可靠处理；
- 允许多个标签页重复或乱序发送 ACK；
- 依赖服务端 `max(current, requested)` 保证最终单调。

页面最后打开的 Chat / Work 不属于本 Cursor 表，由终端状态恢复功能另行处理。

## 14. 安全与隐私

### 14.1 身份来源

所有身份来自：

```text
Authorization Bearer Token
+ X-Entry-Session-Ref
→ EntrySessionAuthenticator
→ EntryContext.person.personRef
→ EntryContext.device.deviceRef
```

客户端声明的 Person 或 Device 字段必须被 strict Schema 拒绝。

### 14.2 Person 隔离

事件查询始终增加：

```sql
WHERE person_ref = authenticatedPersonRef
```

ACK 查找也必须同时匹配：

```text
personRef + eventSequence + eventRef
```

### 14.3 数据最小化

Cursor 表不保存：

```text
Token
Credential
Entry Session Ref
Entry Binding Ref
消息正文
Assistant 输出
Provider External Session
Authorization Header
IP 地址
```

补拉 API 只返回已持久化且已脱敏的 Domain Event。

## 15. 错误协议

`/api/v1/sync/**` 属于正式 Chat / Work 通用接口，使用未包装的 `PublicError`，不是 Mobile Gateway Error Envelope。

| 情况 | HTTP | code | category | retryable |
|---|---:|---|---|---|
| Session 缺失或无效 | 401 | `ENTRY_SESSION_INVALID` | permission | false |
| Session 过期 | 401 | `ENTRY_SESSION_EXPIRED` | permission | false |
| Device 撤销 | 403 | `DEVICE_REVOKED` | permission | false |
| 非 Personal audience | 403 | `ENTRY_AUDIENCE_FORBIDDEN` | permission | false |
| Query / Body 不合法 | 400 | `REQUEST_INVALID` | validation | false |
| ACK 事件不存在或不属于本人 | 404 | `SYNC_EVENT_NOT_FOUND` | permission | false |
| Cursor 存储完整性异常 | 500 | `GATEWAY_INTERNAL_ERROR` | internal | true |

路由分类必须确保使用 Device Credential 错误调用 `/api/v1/sync/**` 时仍返回通用 PublicError，不改变现有 Mobile 路由的版本化错误格式。

## 16. Fastify 集成

`buildGatewayApp()` 继续只创建一个 `DomainEventStore`，并将同一实例注入：

```text
PersonEventStreamHub
DeviceSyncRepository / Routes
```

注册顺序建议：

```text
open database
→ install core migrations
→ create DomainEventStore and event migrations
→ bootstrap development data when applicable
→ create repositories and authenticators
→ create PersonEventStreamHub
→ register Chat / Work routes
→ register SSE routes
→ register Device Sync routes
```

Gateway 关闭顺序保持：

```text
await eventStreamHub.close()
→ db.close()
```

Device Sync 不运行定时器，不需要额外 shutdown hook。

## 17. 文件边界

允许修改：

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEvents.ts
apps/gateway/src/deviceSync.ts
apps/gateway/src/deviceSyncRoutes.ts
apps/gateway/test/deviceSync.test.ts
apps/gateway/test/deviceSyncRoutes.test.ts
apps/gateway/test/deviceSyncSecurity.test.ts
docs/superpowers/specs/2026-07-24-gateway-device-sync-cursor-design.md
docs/superpowers/plans/2026-07-24-gateway-device-sync-cursor.md
docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md
```

根据测试组织可增加同主题的 `deviceSync*.test.ts`，但生产范围不扩张。

明确不修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
apps/gateway/public/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
```

浏览器“小白一键验收台”保持原职责。

## 18. 测试策略

### 18.1 Schema 与 Repository

1. 新库安装 Event Schema V1、V2；
2. 已有 Event Schema V1 数据库只增量安装 V2；
3. 缺失 Cursor 返回 0 且不创建行；
4. 首次 ACK 创建 Cursor；
5. 相同 ACK 幂等；
6. 较小 ACK 不回退；
7. 较大 ACK 推进；
8. Gateway 重启后恢复；
9. eventRef / sequence 不匹配拒绝；
10. 其他 Person 事件拒绝；
11. 并发 ACK 最终取最大值。

### 18.2 HTTP 路由

1. 只允许 Personal Entry；
2. 缺失、过期、撤销和错误 audience 使用正确 PublicError；
3. Query 和 Body strict；
4. 未提交 `afterSequence` 时从持久 Cursor 开始；
5. 显式 Cursor 可以重放；
6. 默认 limit 100，最大 200；
7. 事件严格升序；
8. `latestSequence` 和 `nextAfterSequence` 正确；
9. GET 不创建或推进 Cursor；
10. ACK 响应 previous / final / advanced 正确；
11. 客户端身份字段被拒绝。

### 18.3 生命周期与隔离

1. Session 续期后同 Device + Person Cursor 延续；
2. Logout 后新 Session 仍读取原 Cursor；
3. 新设备从 0 开始；
4. Device revoke 后 GET 与 ACK 均失效；
5. 两个 Person 的 Cursor 完全隔离；
6. 同 Person 两台设备的 Cursor 完全隔离；
7. SSE 送达不会自动推进 Cursor；
8. 补拉成功也不会自动推进 Cursor；
9. PR #14 changed-path 交集为零。

### 18.4 全仓门禁

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

同时要求最新 Head 的 Repository CI 与 Secret Scan 成功。

## 19. 成功标准

```text
同一 Device + Person 的同步位置可以跨 Session 与 Gateway 重启恢复
新设备拥有独立 Cursor
显式补拉默认从持久 ACK 之后开始
客户端可以显式重放旧事件
GET 与 SSE 都不会自动 ACK
ACK 只能确认当前 Person 的真实事件
ACK 幂等且永不回退
慢或离线终端可从最后 ACK 无缺口恢复
不同 Device 与 Person 互不影响
PR #14 的 iOS 与 workflow 路径保持零交集
```

## 20. 后续顺序

本 PR 合并并同步开发记录后：

```text
公共 Event / Sync Contract 评审
→ 正式 Member Web 壳与 Personal Entry
→ Chat 页面与消息查询
→ Work 列表与详情
→ IndexedDB + Device Sync Cursor + SSE 闭环
→ Push 唤醒
→ iOS Chat / Work 接入
```

在 PR #14 真机验收完成前，后续独立 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
