# Gateway Device Sync Cursor Verification Evidence

- 日期：2026-07-24
- 分支：`feat/gateway-device-sync-cursor`
- PR：#22 `feat(gateway): persist Device Sync cursors`
- 基线：`main` @ `90fdd8f0fa42b5488f15186ef1c7d4f9fd90cf1d`
- 设计：`docs/superpowers/specs/2026-07-24-gateway-device-sync-cursor-design.md`
- 计划：`docs/superpowers/plans/2026-07-24-gateway-device-sync-cursor.md`
- 实现审查 Head：`948e3a2e88b763467fc86e8532cbd03a43203caa`

## 1. 阶段结论

本阶段在已有 `domain_events + SSE` 基础上建立了设备级可靠同步确认：

```text
Personal Entry Session
→ Gateway 解析可信 Device + Person
→ 读取 (deviceRef, personRef) acknowledgedSequence
→ GET 显式补拉缺失事件
→ 客户端可靠应用到本地状态
→ POST 累计 ACK
→ SQLite 单调持久化 Cursor
```

持久化 Cursor 的主键固定为：

```text
(device_ref, person_ref)
```

明确不使用：

```text
entry_session_ref
entry_binding_ref
SSE connection_ref
浏览器标签页 ID
```

因此同一设备在 Session 续期、logout 后重新登录和 Gateway 重启后能够继续原同步位置；新设备拥有独立 Cursor。

## 2. 正式接口

### 2.1 显式缺失事件补拉

```http
GET /api/v1/sync/events
GET /api/v1/sync/events?afterSequence=120&limit=100
```

规则：

- 只允许 `personal` Entry Session；
- 未提交 `afterSequence` 时从设备持久化 Cursor 开始；
- 显式 `afterSequence` 为排他语义，可安全重放旧事件；
- `limit` 默认 100，最大 200；
- 事件严格按 `eventSequence` 升序；
- `nextAfterSequence` 用于继续分页；
- GET 不创建、不推进 Cursor；
- Device、Person 全部来自认证上下文，客户端不能声明。

响应包含：

```text
acknowledgedSequence
requestedAfterSequence
latestSequence
events
nextAfterSequence
```

### 2.2 累计 ACK

```http
POST /api/v1/sync/ack
```

请求：

```json
{
  "protocolVersion": 1,
  "eventSequence": 126,
  "eventRef": "event:..."
}
```

Gateway 在推进前验证：

```text
eventRef 存在
+ eventSequence 存在
+ 两者对应
+ 事件属于当前认证 Person
```

错误引用、错误序号和其他 Person 的事件统一返回：

```text
HTTP 404
SYNC_EVENT_NOT_FOUND
```

防止通过错误差异探测其他成员事件。

## 3. Event Schema V2

事件子系统从 V1 增量迁移到 V2，新增：

```sql
device_sync_cursors
```

字段：

```text
device_ref
person_ref
acknowledged_sequence
created_at
updated_at
```

约束：

- `(device_ref, person_ref)` 主键；
- Device 和 Person 外键；
- `acknowledged_sequence >= 0`；
- Device 或 Person 真正删除时级联清理；
- Device 仅撤销时保留历史 Cursor，但不恢复任何权限。

迁移测试验证：

- 新库依次记录 Event Schema V1 与 V2；
- V2 表、字段和索引存在；
- 既有 V1 事件与 Outbox 不被重写；
- 从模拟 V1 数据库重新打开时自动升级到 V2；
- 多次启动保持幂等；
- `foreign_key_check` 为空。

## 4. 事件核心拆分

原 `apps/gateway/src/domainEvents.ts` 已增长到同时承载：

```text
V1 Schema
事件触发器
事件查询
Outbox 租约
V2 Device Sync 查询
```

为避免继续扩大单文件，本阶段将既有 V1 实现原样移动到：

```text
apps/gateway/src/domainEventCore.ts
```

公开 import 路径仍保持：

```ts
import { DomainEventStore } from "./domainEvents.js";
```

新的 `domainEvents.ts` 作为小型门面：

- 继承既有事件与 Outbox 行为；
- 安装 Event Schema V2；
- 提供 `getLatestPersonSequence()`；
- 提供精确 `findPersonEvent()`；
- 继续导出原有事件类型。

原有 Domain Event、Outbox、SSE、Chat / Work 回归测试全部通过，说明拆分没有改变既有公共行为。

## 5. Cursor 单调事务

`DeviceSyncRepository.acknowledge()` 在一个同步 SQLite 事务中执行：

```text
读取当前 Cursor
→ 读取 Person Event Log 最新位置
→ 校验 eventRef + eventSequence + Person
→ INSERT / 单调 UPSERT
→ 重新读取最终持久值
→ 返回 previous / final / advanced
```

已验证：

```text
无 Cursor，ACK 1
→ 懒创建为 1

当前 1，ACK 1
→ 幂等成功，不改 updated_at

当前 1，ACK 2
→ 推进到 2

当前 2，ACK 1
→ 保持 2，不回退，不改 updated_at
```

还验证了：

- ACK 不存在的事件不创建 Cursor；
- ACK 其他 Person 的事件不创建 Cursor；
- 重启后 Cursor 恢复；
- 持久 Cursor 若异常领先 Event Log，读取会显式失败，而不是静默返回损坏状态。

## 6. 补拉、分页和非自动 ACK

自动测试创建 205 个 Person Event，并验证：

```text
第 1 页：1–200，nextAfterSequence = 200
第 2 页：201–205，nextAfterSequence = null
```

两次 GET 前后：

```text
device_sync_cursors 行数仍为 0
```

真实 SSE 流测试验证：

```text
SSE 收到 chat.home.created
→ GET /api/v1/sync/events 也能读到事件
→ device_sync_cursors 仍没有行
```

只有显式 `POST /api/v1/sync/ack` 才能创建或推进 Cursor。

这冻结了以下边界：

```text
SSE = 快速通知
GET = 可靠补拉
POST ACK = 可靠确认
```

浏览器收到事件不代表全局投递完成，也不会修改 Outbox 状态。

## 7. Session、设备与重启恢复

使用真实 Mobile Pairing 流程创建受控移动设备，验证：

```text
配对移动设备
→ 打开 Home Chat
→ ACK eventSequence 1
→ Device Credential logout
→ 旧 Entry Session 失效
→ 同一 Device Credential renew
→ 新 Entry Session Ref
→ Gateway 重启
→ acknowledgedSequence 仍为 1
```

这证明 Cursor 不绑定短期 Entry Session，而绑定长期 Device + Person。

## 8. 多设备与跨 Person 隔离

### 8.1 同一 Person 的两个设备

验证：

```text
开发浏览器设备 Cursor = 1
新配对 iPhone Cursor = 0
```

新设备独立补拉并 ACK 后，数据库同时保留两行：

```text
(device A, Person, 1)
(device B, Person, 1)
```

任何设备都不会继承或覆盖另一设备的位置。

### 8.2 两个 Person

同一家庭中创建两个 Person、两个 Personal Entry、两个 Home Chat 和两个 Cursor。

验证：

- 每个 Person 的事件序列独立从 1 开始；
- GET 只返回当前认证 Person 的事件；
- 响应不包含另一 Person Ref；
- ACK 只更新当前设备与当前 Person 的行；
- Owner 使用自己的 Entry ACK 另一 Person 的事件时统一返回 404。

## 9. Device revoke

在 Cursor 已持久化后，通过现有管理员设备撤销接口撤销设备。

验证：

```text
GET /api/v1/sync/events → 403 DEVICE_REVOKED
POST /api/v1/sync/ack   → 403 DEVICE_REVOKED
```

同时数据库中的历史 Cursor 仍保留。Cursor 不是凭据，不会恢复设备访问能力。

## 10. 错误与输入边界

### GET Query

拒绝：

```text
负数
小数
超过 Number.MAX_SAFE_INTEGER
limit = 0
limit > 200
未知参数
重复参数数组
```

统一返回：

```text
HTTP 400
REQUEST_INVALID
```

### ACK Body

Body 为 strict，拒绝客户端提交：

```text
deviceRef
personRef
entrySessionRef
acknowledgedSequence
其他未知字段
```

### Error Envelope

`/api/v1/sync/**` 与 Chat / Work 使用相同的未包装 `PublicError`：

```text
code
category
message
retryable
```

即使调用者错误使用 `Authorization: Device ...`，也不会被包装成 Mobile Gateway Error Envelope。

## 11. 隐私检查

测试确认：

- 补拉响应不包含 Entry Session Token；
- 客户端不能提交可信 Device 或 Person；
- 跨 Person Event 统一 404；
- Event Payload 沿用已有无消息正文的内部 Domain Event；
- 本阶段没有写入 Token、Credential、Authorization 或 Provider External Session。

## 12. TDD 与调试记录

| 阶段 | CI | 结果 | 证明内容 |
|---|---:|---|---|
| Spec / Plan 基线 | #321 | GREEN | 当前 main 与书面设计兼容 |
| Event Schema V2 缺失 | #322 | RED | V2 表与精确查询尚不存在 |
| 初始 V2 安装 | #323 | RED | 既有数据库测试固定只接受 V1 |
| 跳过新增测试诊断 | #324 | RED | 失败来自实现影响，不是新断言 |
| 暂停 V2 自动安装诊断 | #325 | GREEN | 模块拆分和新增方法本身无回归 |
| 修正旧迁移断言并恢复全部测试 | #328 | GREEN | V1→V2 增量迁移通过 |
| DeviceSyncRepository 缺失 | #329 | RED | Cursor 仓储尚不存在 |
| 单调 Cursor 仓储 | #330 | GREEN | 懒创建、幂等、回退、重启均通过 |
| Sync 路由缺失 | #331 | RED | GET / ACK 尚未注册 |
| Sync 路由与错误边界 | #333 | GREEN | 补拉、分页、ACK、PublicError 通过 |
| 初始生命周期测试夹具 | #334 | RED | Bootstrap Token 被错误当成 Mobile Credential |
| 真实 Mobile Pairing 生命周期 | #339 | GREEN | Session、多设备、Person、撤销、SSE 边界通过 |
| 完成前隐私审查 | #340 | GREEN | 跨 Person 404 与 Token 非泄露通过 |

CI #334 的失败没有通过放宽生产安全规则修复。根因是测试夹具使用了错误凭据类型；测试改为通过正式 Pairing Code + Mobile Claim 创建真实 Mobile Device，再执行 logout / renew。

## 13. 实现范围

生产代码：

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEventCore.ts
apps/gateway/src/domainEvents.ts
apps/gateway/src/deviceSync.ts
apps/gateway/src/deviceSyncRoutes.ts
```

测试：

```text
apps/gateway/test/database.test.ts
apps/gateway/test/deviceSync.test.ts
apps/gateway/test/deviceSyncRepository.test.ts
apps/gateway/test/deviceSyncRoutes.test.ts
apps/gateway/test/deviceSyncSession.test.ts
apps/gateway/test/deviceSyncIsolation.test.ts
apps/gateway/test/deviceSyncDelivery.test.ts
apps/gateway/test/deviceSyncTestSupport.ts
```

文档：

```text
docs/superpowers/specs/2026-07-24-gateway-device-sync-cursor-design.md
docs/superpowers/plans/2026-07-24-gateway-device-sync-cursor.md
docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md
```

## 14. PR #14 隔离

本 PR 没有修改：

```text
clients/ios/**
.github/workflows/**
packages/contracts/**
apps/gateway/public/**
apps/gateway/src/mobilePairing.ts
apps/gateway/src/mobileRoutes.ts
apps/gateway/src/entrySessionAuth.ts
```

PR #14 在审查时保持：

```text
Open
Draft
Mergeable
Head = e075f114e3f3fcdb728f6bff75797d415c4a5315
```

PR #22 与 PR #14 的 changed-path 集合交集为零。

## 15. 完成前门禁

实现审查 Head `948e3a2e88b763467fc86e8532cbd03a43203caa`：

- Repository CI #340：成功；
- Secret Scan #226：成功；
- 全 workspace 测试、静态检查、类型检查和构建：成功；
- PR #14：Open / Draft / mergeable，Head 未变；
- PR #14 changed-path 交集：0。

本证据文件提交后，仍需对最新文档 Head 再执行一次完整 CI 与 Secret Scan；最终 Head 和最终检查编号记录在 PR 正文中，避免本文件形成自引用提交循环。

## 16. 延后范围

继续放在后续独立 PR：

- 公共 Event / Sync Contracts；
- 正式 Member Web；
- Push Notification；
- Outbox 外部 Publisher；
- iOS Chat / Work 接入；
- 浏览器一键验收台改动。
