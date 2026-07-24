# Gateway Device Sync Cursor 与显式事件补拉设计

- 日期：2026-07-24
- 状态：已实现
- 目标分支：`feat/gateway-device-sync-cursor`
- 基线：`main` @ `90fdd8f0fa42b5488f15186ef1c7d4f9fd90cf1d`
- 前置：PR #15–#21 已合并
- 实现 PR：#22 `feat(gateway): persist Device Sync cursors`

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

本阶段解决的是：

> 某台设备已经可靠处理到哪个 Person Event Sequence。

它不把 HTTP 响应完成、SSE Socket 写入或页面显示视为可靠确认。

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

- Entry Session 会续期和更换；
- EntryBinding 表示授权关系，不表示处理进度；
- 同一设备多个页面应共享设备级同步位置；
- 新设备必须拥有独立 Cursor；
- Personal Entry 认证上下文已经可信解析出 Device 与 Person；
- 客户端不得自行声明这些身份。

## 3. 范围

### 3.1 包含

- Event Schema V2；
- `device_sync_cursors`；
- 当前设备 Cursor 查询；
- 显式 Person Event 补拉；
- 排他 `afterSequence`；
- 最多 200 条分页；
- 累计 ACK；
- ACK 事件身份校验；
- Cursor 单调前进与幂等；
- Entry Session 更换后的 Cursor 延续；
- 新设备独立 Cursor；
- Gateway 重启恢复；
- Person、Device 与家庭隔离；
- Device revoke 后拒绝 Sync；
- SSE 与 GET 非自动 ACK；
- 自动测试、实施计划和验证证据。

### 3.2 不包含

- 公共 `packages/contracts` Event / Sync Schema；
- 正式 Member Web；
- Push Notification；
- Outbox 外部发布 Worker；
- HTTP 202 / Operation 生命周期；
- iOS Chat / Work 接入；
- 浏览器一键验收台修改；
- 多 Gateway 实例同步协调。

## 4. PR #14 隔离

允许的生产代码范围：

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEventCore.ts
apps/gateway/src/domainEvents.ts
apps/gateway/src/deviceSync.ts
apps/gateway/src/deviceSyncRoutes.ts
```

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

PR #14 继续保持独立 Draft，只进行真实 Mac、iPhone 与部署 Gateway 的真机验收。

## 5. Event Schema V2

事件子系统迁移账本由 V1 增量推进到 V2。

新增表：

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
```

索引：

```sql
CREATE INDEX device_sync_cursors_person_sequence_idx
  ON device_sync_cursors(
    person_ref,
    acknowledged_sequence,
    device_ref
  );
```

规则：

- 缺失行等同于 Cursor 0；
- 不预创建空 Cursor 行；
- 首次有效 ACK 时懒创建；
- Device 或 Person 真正删除时级联删除；
- Device 仅撤销时保留历史 Cursor；
- Cursor 不参与身份认证。

Event Schema 与 Gateway Core Schema 分开演进，因此本阶段不增加 Gateway Core Migration V6。

## 6. Domain Event Store 扩展

现有 Event V1、触发器与 Outbox 实现保持不变，并原样移动到：

```text
apps/gateway/src/domainEventCore.ts
```

公开导入路径继续是：

```ts
import { DomainEventStore } from "./domainEvents.js";
```

`domainEvents.ts` 作为小型门面：

```text
既有 Event / Outbox 核心
+ Event Schema V2 安装
+ getLatestPersonSequence(personRef)
+ findPersonEvent(personRef, sequence, eventRef)
```

该拆分是职责收敛，不改变现有 Event、Outbox 或 SSE 公共行为。

## 7. 显式事件补拉 API

### 7.1 接口

```http
GET /api/v1/sync/events
GET /api/v1/sync/events?afterSequence=120&limit=100
```

认证：

```http
Authorization: Bearer <entry-session-token>
X-Entry-Session-Ref: entry-session:...
```

只允许 `personal` audience。

### 7.2 Query

严格对象：

```text
afterSequence?: 非负安全十进制整数
limit?: 1–200 的十进制整数
```

规则：

- 两者均可省略；
- `limit` 默认 100；
- 未知参数被拒绝；
- 重复参数形成数组时被拒绝；
- `afterSequence` 为排他语义；
- 显式旧 Cursor 允许安全重放；
- GET 永不创建或推进持久化 Cursor。

### 7.3 查询起点

未提交 `afterSequence`：

```text
requestedAfterSequence = persisted acknowledgedSequence
```

显式提交：

```text
requestedAfterSequence = query.afterSequence
```

显式查询不会覆盖或回退持久 Cursor。

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
  "events": [],
  "nextAfterSequence": null
}
```

规则：

- Device 与 Person 来自认证上下文；
- 事件严格升序；
- `latestSequence` 为当前 Person Event Log 最新值；
- `nextAfterSequence` 非空时继续分页；
- Event Log 为空时最新序号为 0；
- 响应不包含 Entry Token、Device Credential 或 Authorization。

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

### 8.2 身份校验

推进前必须验证：

```text
eventRef 存在
+ eventSequence 存在
+ 两者精确对应
+ 事件属于当前认证 Person
```

以下情况统一返回：

```text
HTTP 404
SYNC_EVENT_NOT_FOUND
```

- Event 不存在；
- Event Ref 与 Sequence 不对应；
- Event 属于其他 Person。

这样不会通过错误差异泄露其他成员事件。

### 8.3 累计语义

ACK 126 表示：

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

`advanced` 只有持久值实际增加时才为 `true`。

## 9. ACK 事务与并发

`acknowledge()` 在一个 SQLite 同步事务中完成：

```text
读取当前 Cursor
→ 校验 Event 身份
→ 单调 INSERT / UPSERT
→ 重新读取最终值
→ 返回 previous / final / advanced
```

核心 SQL 只在新序号更大时更新：

```sql
WHERE device_sync_cursors.acknowledged_sequence
  < excluded.acknowledged_sequence
```

因此同一设备多个页面以不同顺序提交 ACK 时，最终值稳定为最大序号，不会回退。

## 10. SSE 与 Cursor

SSE 负责快速通知：

```text
有新事件
→ SSE 尽快通知在线客户端
```

Device Sync Cursor 负责可靠确认：

```text
收到或补拉事件
→ 读取相关 Chat / Work 数据
→ 写入设备共享本地持久状态
→ 本地事务成功
→ POST /api/v1/sync/ack
```

明确禁止：

```text
SSE 写入 Socket
→ Gateway 自动 ACK
```

也禁止：

```text
GET 返回事件
→ Gateway 自动 ACK
```

现有 SSE 继续使用客户端提供的 `afterSequence` / `Last-Event-ID`，本 PR 不把 SSE 默认 Cursor 改为设备持久 Cursor。

## 11. 推荐客户端恢复流程

```text
1. GET /api/v1/sync/events
2. 默认从 persisted acknowledgedSequence 补拉
3. 严格按 eventSequence 应用事件
4. 每批本地持久化成功后 ACK 最后事件
5. 重复分页直到 nextAfterSequence = null
6. 使用最后成功处理的 sequence 建立 SSE
7. SSE 到达后应用并累计 ACK
8. 断线后回到步骤 1
```

提供至少一次恢复语义。客户端必须按 `eventSequence` 幂等处理重放。

## 12. Session、设备与撤销

### 12.1 Session 续期

Mobile renew 为同一长期 EntryBinding 签发新 Session，但认证上下文仍解析到同一：

```text
deviceRef
personRef
```

Cursor 自动延续。

### 12.2 Logout

Logout 撤销 Entry Session，不删除 Device Cursor。设备重新取得有效 Personal Entry 后继续原位置。

### 12.3 新设备

```text
old device Cursor = 126
new device Cursor = 0
```

新设备独立补拉，不继承旧设备位置。

### 12.4 Device revoke

撤销后：

- GET 补拉返回 `DEVICE_REVOKED`；
- POST ACK 返回 `DEVICE_REVOKED`；
- SSE 心跳会关闭连接；
- Cursor 行保留但不提供任何权限；
- Device 真正删除时外键级联清理。

## 13. Web 多标签页语义

同一浏览器设备的多个页面共享：

```text
deviceRef + personRef Cursor
```

正式 Member Web 后续必须：

- 使用共享 IndexedDB 或等价设备本地存储；
- 只有事件效果写入共享本地状态后才 ACK；
- 不因某个标签页仅显示过事件就 ACK；
- 多标签页重复 ACK 依赖服务端幂等与单调推进。

## 14. 错误协议

连接建立前与普通 REST 请求使用未包装 `PublicError`：

| 情况 | HTTP | Code |
|---|---:|---|
| Session 无效 | 401 | `ENTRY_SESSION_INVALID` |
| Session 过期 | 401 | `ENTRY_SESSION_EXPIRED` |
| Device 撤销 | 403 | `DEVICE_REVOKED` |
| 非 Personal audience | 403 | `ENTRY_AUDIENCE_FORBIDDEN` |
| Query / Body 无效 | 400 | `REQUEST_INVALID` |
| ACK Event 无效或不属于 Person | 404 | `SYNC_EVENT_NOT_FOUND` |

`Authorization: Device ...` 不能替代 Personal Entry，并且 `/api/v1/sync/**` 不使用 Mobile Gateway Error Envelope。

## 15. 测试策略

自动测试覆盖：

1. 新库 Event Schema V1→V2；
2. 既有 V1 数据增量升级；
3. 缺失 Cursor 等于 0 且不创建行；
4. 首次 ACK 懒创建；
5. 重复 ACK 幂等；
6. 小序号 ACK 不回退；
7. 重启恢复；
8. 损坏 Cursor 检测；
9. 默认补拉从持久 Cursor 开始；
10. 显式旧 Cursor 重放；
11. 205 条事件跨页补拉；
12. GET 与 SSE 非自动 ACK；
13. ACK strict Body；
14. Event Ref / Sequence 精确校验；
15. 跨 Person 统一 404；
16. Session logout / renew 延续；
17. 同 Person 多设备独立；
18. 两个 Person 完全隔离；
19. Device revoke 后 GET / ACK 失效；
20. Sync 响应不泄露 Entry Token；
21. 现有 Event、Outbox、SSE、Mobile 与 Chat / Work 回归。

详细证据：

```text
docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md
```

## 16. 成功标准

```text
Personal Entry 能可靠读取当前设备 Cursor
缺失事件可按 Person Sequence 升序补拉
Cursor 只在显式 ACK 后推进
相同或较小 ACK 永不回退
Session 更换和 Gateway 重启不丢 Cursor
新设备不继承旧设备位置
其他 Person Event 无法读取或 ACK
Device revoke 立即阻止补拉和 ACK
SSE 与 GET 均不自动确认
PR #14 路径保持完全隔离
```

## 17. 后续顺序

本 PR 合并后：

```text
公共 Event / Sync Contracts
→ 正式 Member Web Chat / Work
→ Push 唤醒
→ iOS 接入统一 Chat / Work 与同步协议
```

在 PR #14 真机验收完成前，后续独立 PR 继续不修改 `clients/ios/**` 和 `.github/workflows/ios-ci.yml`。
