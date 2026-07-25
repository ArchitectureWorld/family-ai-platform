# Member Web 身份与入口生命周期加固设计

- 日期：2026-07-25
- 分支：`fix/member-web-entry-hardening`
- 基线：`main` @ `d3e4d2302bf9f0329b3205a07282adb9aaf46ec3`
- 目标：修复 Member Web 跨身份缓存污染、退出后自动续签、远程撤销残留、多标签页生命周期分叉、Renderer 监听器累积和 Web Pairing 响应丢失不可恢复问题

## 1. 产品完成标准

本批工作的完成标准不是“测试通过”，而是用户可以直接进入真实 Member Web 体验修复后的产品行为。

交付链路必须是：

```text
隔离运行的 Preview Gateway
→ Mac 通过 SSH Tunnel 访问
→ 使用真实 Web Pairing 建立 Personal Entry
→ 在正常 Chat / Work 工作台体验
→ 验证 Logout、Resume、多标签页、Revoke 和恢复
```

不得使用调试页面、验收专用假页面或绕过正式 Cookie/Entry/Chat/Work 路径的替代体验。

## 2. 范围

本批包含：

1. 按稳定身份隔离并保留 IndexedDB 投影；
2. 一次性删除无法可信归属的旧全局缓存；
3. 明确区分 Logout、Resume 和 Device Revoke；
4. 跨标签页同步 Entry 生命周期；
5. 避免多标签页并发 renew 互相撤销 Session；
6. Renderer 销毁时移除其拥有的全部 DOM listener；
7. Web Pairing 使用 fragment 传递配对材料；
8. Web Pairing Claim 在首次响应丢失后可安全重放；
9. 提供不碰撞现有 `8790` 容器的直接产品体验实例；
10. 提供面向用户的体验清单。

本批不包含：

- SSE 大积压断连修复；
- Provider Turn 顺序和 Session 重建；
- 正式 Compose 多 checkout 隔离；
- Work 创建幂等、Progress 版本和列表分页；
- `find-my-way` 依赖升级；
- 本地数据加密；
- React、Vite 或新的第三方依赖；
- 正式的多账号切换 UI。

上述内容分别进入后续独立、直接指向 `main` 的分支和 PR，不堆叠在本批之上。

## 3. 已确认的产品语义

### 3.1 身份缓存

不同 `{familyRef, personRef, deviceRef}` 使用不同 IndexedDB。

- 任意已认证 Context 都只能打开其身份三元组对应的数据库；
- 旧身份数据库保留；
- 只有服务器当前 Context 与数据库身份完全一致时才能加载；
- 每个身份拥有独立的消息、Work、草稿、Outgoing、Progress 和 Cursor；
- 本批不提供浏览器内的身份选择器。

当前产品没有同一 installation 在 Person A/B 间切换的可达 UI，服务端绑定也不允许直接切换。因此 A→B→A 只作为 Cache 层的合成 Context 行为测试；用户体验验证的是同一身份经 reload 和 Logout/Resume 后重开同一数据库。不得为满足测试而暗中加入账号切换能力。

### 3.2 Logout

Logout 表示锁定当前浏览器入口，而不是撤销 Device：

- 撤销当前 Entry Session；
- 保留 Device 授权；
- 保留身份数据库；
- 刷新后继续保持 locked；
- 只有用户点击“恢复入口”才允许 renew。

### 3.3 Device Revoke

Device Revoke 表示该浏览器不再可信：

- 撤销 Session、EntryBinding 和 DeviceBinding 的服务端语义保持不变；
- 清除 Session Cookie 和 Device Cookie；
- 删除当前身份数据库；
- 清除本地 lock；
- 轮换 installation ID；
- 所有标签页回到新配对状态。

## 4. 身份数据库

### 4.1 数据库名

`cache.js` 根据服务器 Context 派生数据库名：

```text
family-ai-member-web-v2:<familyRef>:<personRef>:<deviceRef>
```

数据库名只使用稳定 Ref，不使用显示名称、消息正文、Token、Cookie 或配对码。

现有 stores 和索引保持不变：

```text
meta
threads
messages
works
progress
drafts
outgoing
```

保持现有事务边界可以避免重写消息分页、事件应用和本地 Cursor 的正确实现。

### 4.2 Context 防御校验

每个身份数据库的 `meta.context` 保存完整公开 Context。

浏览器另存一个只用于清理定位的非秘密指针：

```text
key = family-ai-member-cache-identity:<installationId>
value = { protocolVersion: 2, familyRef, personRef, deviceRef }
```

该指针只允许在服务器 Context 已认证且数据库 Context 校验成功后写入。它不得作为授权依据，也不得单独触发数据库加载；冷启动收到 `DEVICE_REVOKED` 时，仅用它定位并删除被撤销身份的数据库。

收到 Revoke 时还要持久化 cleanup tombstone：

```text
key = family-ai-member-revoke-cleanup:<oldInstallationId>
value = {
  protocolVersion: 2,
  transitionId,
  identity: { familyRef, personRef, deviceRef },
  phase: "closing" | "deleting"
}
```

Tombstone 不包含秘密。它在数据库删除、Cookie 清理和 installation ID 单次轮换全部确认前不得删除，用于刷新、崩溃或标签关闭后的继续清理。

打开数据库后：

```text
没有 meta.context
→ 在首次初始化事务中写入当前 Context

已有 meta.context 且身份三元组完全一致
→ 允许读取投影

已有 meta.context 但身份不一致
→ 抛出 CACHE_IDENTITY_MISMATCH
→ 关闭数据库
→ 不读取、不渲染、不 ACK
```

`startProductWorkbench(context)` 不得再先覆盖 Context 后读取 Snapshot。

正确顺序是：

```text
取得服务器 Context
→ 派生身份数据库名
→ 打开数据库
→ 校验或初始化 Context
→ 读取该身份 Snapshot
→ 创建 Store / Controller / Renderer / Sync
```

### 4.3 旧全局缓存

旧数据库名 `family-ai-member-web` 中的记录没有逐条身份归属，且可能已经发生过 Context 覆盖，因此不能安全迁移。

升级后首次进入 Member Web 时：

```text
indexedDB.deleteDatabase("family-ai-member-web")
→ success：继续打开身份数据库
→ blocked：抛出 LEGACY_CACHE_DELETE_BLOCKED
→ error：保持页面 locked，显示恢复指引
```

不得在删除失败时回退读取旧数据库。

该清理在成功前每次启动都重试；成功后重复调用删除不存在的旧数据库必须安全成功。不得提前写“迁移完成” marker。`blocked` 页面直接提示关闭其他旧 Member Web 标签，并提供重试。

所有身份数据库连接都监听 `versionchange` 并立即停止使用、关闭连接，使其他标签发起的删除可以完成。

## 5. Entry 生命周期状态机

`entry.js` 成为唯一 Entry 生命周期所有者：

```text
unpaired
pairing
active
locked
revoked
recoverable_error
```

状态转换：

```text
unpaired → pairing
unpaired → recoverable_error
pairing → active
pairing → recoverable_error
pairing → unpaired
active → locked
active → revoked
locked → active
locked → revoked
locked → recoverable_error
recoverable_error → unpaired
recoverable_error → pairing / locked
revoked → unpaired
```

分支规则唯一化：

- 401 Session invalid 且没有本地 lock：进入受互斥保护的正常恢复；
- 存在本地 lock：保持 locked，只有显式 Resume 可恢复；
- `DEVICE_REVOKED`：只进入 revoked cleanup；
- retryable 5xx、timeout 或网络错误：进入 recoverable_error，但不得擅自清身份或续签；
- Pairing 终态错误：回到 unpaired 并清除 pending Claim。

### 5.1 Logout

Logout、Resume 和 Revoke cleanup 共用 §6.1 的 Entry mutation lock。用户点击 Logout 后，必须先 fail closed，再尝试服务端 Logout：

1. 写入非秘密 lock marker；
2. 立即停止本标签 ProductWorkbench，并通过共享 marker 的 `storage` 事件让其他标签停止；
3. 获得 Entry mutation lock；
4. 写入递增 revision 的权威 `locked` 生命周期记录；
5. 广播 `session-locked`；
6. 显示“恢复入口”按钮；
7. 请求服务端撤销当前 Entry Session。

服务端请求失败或响应丢失时仍保持 locked，并显示“服务端退出未确认，可重试退出或稍后显式恢复”。不得因为退出请求失败而自动恢复工作台。

Gateway Logout 必须只撤销本次请求 Cookie 所认证的精确 `entrySessionRef`，不得再按 `entryBindingRef` 撤销所有活动 Session。这样即使旧 Logout 请求迟到，也不能撤销之后显式 Resume 生成的新 Session。

Lock marker：

```text
key = family-ai-member-entry-lock:<installationId>
value = { protocolVersion: 2, lockedAt: RFC3339 timestamp }
```

Marker 不包含身份、Token、Cookie、消息或配对材料。

`restore()` 检测到 marker 后不得请求 renew，也不得启动 ProductWorkbench。

### 5.2 显式 Resume

只有点击“恢复入口”才进入恢复流程：

```text
获得 Entry mutation lock
→ 再次请求 Context
→ 已恢复：直接使用 Context
→ 仍为 401：请求 renew
→ 成功：删除 lock marker
→ 写入递增 revision 的 active 生命周期记录
→ 广播 session-restored
→ 启动 ProductWorkbench
```

Lock 未取得、浏览器不支持 Web Locks、renew 网络失败或服务端仍为 401 时保持 locked。

必须有确定性测试覆盖：标签 A 的 Logout 响应被延迟，同时标签 B 请求 Resume；最终状态由同一个 mutation lock 串行决定，迟到的 Logout 不得撤销新 Session。

### 5.3 Revoke

以下任一路径返回 `DEVICE_REVOKED` 都调用同一个 revoke transition：

- `/web-entry/context`；
- `/web-entry/session/renew`；
- Chat / Work / Sync API；
- SSE 身份失效回调。

Transition：

```text
停止 ProductWorkbench
→ 服务端响应清除 HttpOnly Session / Device Cookie
→ 写入 cleanup tombstone 和权威 revoked 生命周期记录
→ 广播 device-revoke-preparing
→ 所有标签停止工作台并关闭身份数据库
→ 一个标签获得 Entry mutation lock，成为 cleanup leader
→ leader 读取本地身份指针并删除当前身份数据库
→ leader 删除身份指针和 lock marker
→ leader 只生成并写入一次新的 installation ID
→ leader 删除 tombstone
→ leader 广播 device-revoke-complete
→ 所有标签读取同一个新 installation ID 并显示配对页
```

冷启动时即使服务器不再返回 Context，也必须通过本地身份指针完成相同清理。

本地清理失败时仍保持 revoked，不得重新显示缓存，也不得删除身份指针、tombstone 或轮换 installation ID；用户重试时继续删除同一目标。只有数据库删除和 Cookie 清理成功后才能完成指针删除和 installation ID 轮换。

多标签页清理时，`deleteDatabase.onblocked` 只表示仍有标签未关闭连接，不得当场删除指针或进入配对页。页面显示“正在等待其他标签释放本地数据”；其他标签处理 `device-revoke-preparing` 时先关闭数据库。删除请求最终成功后才完成后续轮换；长时间不成功时提示关闭同源标签并重试。

## 6. 多标签页协议

Entry 生命周期使用独立 Channel：

```text
BroadcastChannel("family-ai-member-entry-lifecycle")
```

消息格式：

```json
{
  "protocolVersion": 2,
  "type": "session-locked | session-restored | device-revoke-preparing | device-revoke-complete",
  "installationId": "non-secret local identifier",
  "transitionId": "UUID",
  "revision": 1,
  "occurredAt": "RFC3339 timestamp"
}
```

消息不得包含 Token、Cookie、Credential、配对材料或业务正文。

权威生命周期记录保存在 LocalStorage：

```text
key = family-ai-member-entry-state:<installationId>
value = {
  protocolVersion: 2,
  revision: monotonic integer,
  state: "active" | "locked" | "revoked",
  transitionId: UUID
}
```

所有 revision 更新都在 Entry mutation lock 内完成。Channel 只负责唤醒；接收方必须重读共享记录，并忽略 `revision <= lastAppliedRevision` 的旧消息。`occurredAt` 只用于诊断，绝不用于判定新旧。

处理规则：

- `session-locked`：所有匹配 installation 的标签页停止工作台并显示 locked；
- `session-restored`：其他 locked 标签页重新获取 Context 后才能恢复；
- `device-revoke-preparing`：所有匹配旧 installation 的标签页立即停止并关闭数据库；
- `device-revoke-complete`：其他标签读取共享的新 installation ID 后显示配对页，不得各自生成；
- 事件处理必须幂等，重复广播不得重复删除或重新 renew；
- Lifecycle Channel 属于页面级 Entry Controller，而不是 ProductWorkbench；Logout 停止工作台后仍必须保持 Channel；
- 只有页面卸载或 Entry Controller 最终销毁时才关闭 Lifecycle Channel。

### 6.1 Entry mutation 互斥

所有 Logout、Resume/renew 和 Revoke cleanup 都使用同一个排他 Web Lock：

```text
family-ai-member-entry-mutation:<installationId>
```

本批不使用无法提供严格互斥保证的 LocalStorage lease。浏览器没有 Web Locks 时：

- Logout 仍立即写 marker、锁定所有标签并请求精确 Session Logout；
- Resume/renew fail closed，返回 `ENTRY_MUTATION_LOCK_UNAVAILABLE`；
- Revoke 仍停止并隐藏工作台，但保持 tombstone，提示换用支持的浏览器完成清理；
- 不得退化为并发 renew。

Resume 进入临界区后必须先重新请求 Context，避免另一个标签已经完成 renew 时再次签发 Session。Revoke leader 进入临界区后必须先重读 tombstone 和生命周期 revision，若已有其他 leader 完成则直接复用结果。

## 7. Renderer 生命周期

`createRenderer()` 创建独立 `AbortController`。

Renderer 所有静态 listener 必须使用同一个 signal：

```js
element.addEventListener("event", handler, { signal: controller.signal });
```

包括：

- 导航按钮；
- Create Work；
- Chat→Work；
- Load Earlier；
- Chat / Work Composer；
- Draft input；
- Dialog；
- Retry；
- 移动端 Work 选择。

`destroy()` 的顺序：

```text
abort DOM listeners
→ unsubscribe Store
→ clear toast timer
```

重复调用 `destroy()` 必须安全。

## 8. Pairing URL 和 Claim 重放

### 8.1 Fragment

正式链接改为：

```text
/member/#pairingRef=...&code=...
```

页面必须在 `entry.js` 发起任何 API 或 credentialed fetch 前读取 fragment。HTML、CSS 和 JavaScript 模块本身的正常加载不在此表述内。配对材料不得出现在首个 HTTP URL、Referer、访问日志或产品错误中。

Bootstrap 的固定顺序是：

```text
同步解析并校验 fragment
→ 写入 pending Claim
→ history.replaceState 清除 fragment
→ 才允许 Context、renew 或 Claim 等任何 fetch
```

无效 fragment 也要先清除，再显示不回显原值的错误。

### 8.2 预生成 Device Credential

Web Entry 协议从 `WEB_ENTRY_PROTOCOL_VERSION = 1` 升级为 `2`。API 路径仍属于现有 `/api/v1` 总体 API；所有 Web Entry 顶层 request/response schema 使用版本 2，旧 v1 Claim 严格请求按不兼容协议拒绝，不做静默降级。嵌套的现有 Public Context 自身版本不因本次变更自动提升。

浏览器在首次 Claim 前使用 Web Crypto 生成 32 字节随机 Credential，并保存待处理 Claim：

```text
sessionStorage
- pairingRef
- code
- installationId
- deviceCredential
```

这些字段只在当前标签仍有未决 pending Claim 时存在；服务端已经提交但浏览器尚未收到成功响应时仍会保留，以供精确重放。

`deviceCredential` 必须是 32 字节随机值的 canonical、无 padding Base64URL 表示，解码后长度必须精确为 32 字节。Contracts、Gateway 和浏览器测试都验证同一规则。

Claim Request 携带该 Credential。Gateway：

- 对新 Device 保存 Credential Hash；
- 通过 HttpOnly Cookie 设置同一个 Credential；
- 从该随机 Credential 和 pairingRef 使用 HKDF-SHA256、固定 domain separation info 派生首次 Claim 的 Entry Token，只保存 Token Hash；
- 响应 JSON 不返回 Credential；
- 日志和 PublicError 不包含 Credential。

派生参数固定为：

```text
IKM  = decoded 32-byte deviceCredential
salt = SHA-256(UTF-8 pairingRef)
info = UTF-8 "family-ai:web-entry:claim-session:v2"
L    = 32 bytes, encoded as unpadded Base64URL
```

成功后立即清除 pending Claim 的 `sessionStorage`；fragment 已在首次请求前清除。

### 8.3 Consumed Claim 重放

首次事务提交但响应丢失时，浏览器以完全相同的材料重试。

Gateway 只在以下条件全部满足时重放：

1. pairingRef/code 正确；
2. Pairing 已 consumed；
3. consumed Device 的 installationRef 与请求一致；
4. 请求 Credential Hash 与 Device 当前 Hash 一致；
5. Family、Person、Membership、Assignment、Device 和 Binding 仍有效。
6. 当前时间不晚于 `consumedAt + 2 minutes`；
7. 该 Pairing 的成功 recovery replay 次数小于 3。

成功重放：

- 不创建新 Device、DeviceBinding 或 EntryBinding；
- 使用相同 HKDF 输入定位并复用首次 Claim 已创建且仍 active 的同一 Entry Session；
- 返回完全相同的 Entry Session Ref/Token Cookie，不撤销、不新建 Session；
- 重新设置相同 Device Cookie；
- 返回正常公开 Context。

首次 Claim、recovery deadline 和 replay count 的检查与计数更新必须在同一个数据库事务内。两个并发重放只能得到同一份仍有效的 Cookie 材料，不得产生 Session 轮换或响应乱序失效。

拒绝规则：

- Credential 不同：`DEVICE_AUTH_INVALID`；
- installation 不同：`PAIRING_CONSUMED`；
- revoked Device/Binding：`DEVICE_REVOKED`；
- recovery deadline 或次数耗尽：`PAIRING_CONSUMED`；
- 首次 Claim Session 已失效：`PAIRING_CONSUMED`；
- 新 Pairing 不得借提交的 Credential 更换已有 Device 的 Credential。

### 8.4 Pending Claim 清理

```text
成功
→ 清除 pending Claim

PAIRING_INVALID / EXPIRED / ATTEMPTS_EXCEEDED / terminal CONSUMED conflict
DEVICE_AUTH_INVALID / DEVICE_REVOKED / PAIRING_TARGET_INACTIVE
→ 清除 pending Claim并回到输入页

网络错误 / timeout / 明确 retryable 的 5xx
→ 保留 pending Claim
→ 显示可重试操作
```

## 9. Cookie 清理

浏览器 JavaScript 无法删除 HttpOnly Cookie。

Cookie Bridge 在覆盖或补充 `Authorization` 之前，必须在 request 上记录“身份来自 Web Cookie”这一不可由客户端伪造的内部标志。

Gateway 的清理矩阵：

| 请求/事件 | Cookie 行为 |
| --- | --- |
| Context、renew 的 Cookie-auth `DEVICE_REVOKED` | 响应同时过期 Session 和 Device Cookie |
| Chat / Work / Sync 由 Cookie Bridge 合成身份后返回 `DEVICE_REVOKED` | 响应同时过期 Session 和 Device Cookie |
| 明确 Bearer Authorization 请求 | 即使浏览器同时携带 Cookie，也不得附加 Web Cookie 清理副作用 |
| 普通 `ENTRY_SESSION_INVALID` / 401 | 只走 locked/renew 语义，不得误删 Device Cookie |
| 已经开始传输的 SSE 检测到 Device revoke | SSE 只通知客户端并关闭，不能假装在已发送的响应上追加 `Set-Cookie` |

为 SSE 路径增加同源 `POST /api/v1/web-entry/cookies/clear`：

- 使用与其他 unsafe Web Cookie 请求相同的 Origin/Host 和自定义头 CSRF 防护；
- 不要求 Device 仍然有效；
- 唯一效果是返回全部 Web Entry Cookie 的过期指令；
- 不接受或返回任何 Credential；
- 前端收到 SSE revoke 通知后先调用该端点，再继续本地 revoke cleanup；
- 清理请求网络失败时保持 revoked 和 tombstone，显示重试，不得重新显示缓存。

已经打开的 SSE 在周期性重新认证发现 `DEVICE_REVOKED` 时，只发送不含身份或业务数据的 `entry-revoked` control event 并立即关闭；客户端收到该事件后执行上述 clear 请求。若连接直接断开而没有 control event，则下一次 REST catch-up/context 验证负责得到权威错误，不得仅凭普通网络断线误判为 revoke。

不得让普通 Bearer Header API 获得浏览器 Cookie 副作用。

## 10. 错误处理

新增或明确的本地错误：

```text
CACHE_IDENTITY_MISMATCH
LEGACY_CACHE_DELETE_BLOCKED
MEMBER_CACHE_DELETE_FAILED
ENTRY_MUTATION_LOCK_UNAVAILABLE
PAIRING_CREDENTIAL_UNAVAILABLE
REVOKE_COOKIE_CLEAR_FAILED
```

原则：

- 身份不确定时不显示缓存；
- Revoke 清理不完整时不恢复工作台；
- Logout/Resume 临时失败时保持 locked；
- Pairing 临时失败时保留可安全重放的 pending Claim；
- 错误页面提供用户可以执行的下一步；
- PublicError、日志和 BroadcastChannel 不包含秘密或业务正文。

## 11. TDD 与回归测试

每个生产修改前先写最小失败测试并确认失败原因。

### 11.1 Cache

必须覆盖：

1. Person A 和 Person B 派生不同数据库名；
2. B 不读取 A 的消息、Work、草稿、Outgoing、Progress 或 Cursor；
3. Cache 层传入 A→B→A 合成 Context 时，重新打开完全相同三元组能恢复 A 的投影；
4. 数据库 Context 不一致时 fail closed；
5. 旧全局数据库删除成功；
6. 删除 blocked 时不打开身份数据库；
7. `versionchange` 会关闭其他标签持有的数据库连接；
8. 冷启动 tombstone 能继续完成上次中断的删除。

测试必须执行真实缓存行为，不得只断言源码字符串。

### 11.2 Entry Lifecycle

必须覆盖：

1. `logout → reload` 不请求 renew；
2. 点击 Resume 后才 renew；
3. 两个标签同时 Resume 只有一个进入 renew；
4. `session-locked` 让其他标签停止工作台；
5. `session-restored` 只触发重新获取 Context；
6. `device-revoke-preparing` 让所有标签关闭数据库，只有 leader 清库并单次轮换 installation；
7. 网络失败后保持 locked；
8. 延迟 Logout 与另一标签 Resume 被同一 mutation lock 串行；
9. 迟到 Logout 只撤销原精确 Session，不撤销新 Session；
10. 缺少 Web Locks 时 Resume fail closed；
11. 乱序或重复 lifecycle revision 不覆盖较新状态。

### 11.3 Renderer

必须以行为测试覆盖：

```text
create renderer
→ destroy
→ create renderer
→ submit Create Work
→ action 只执行一次
```

同样覆盖 Composer 和 Draft listener。

### 11.4 Pairing

Repository、Route 和浏览器行为必须覆盖：

1. 首次 Claim 成功；
2. 模拟成功提交后丢失响应，相同材料重放成功；
3. 重放后只有一个 Web Device；
4. 错误 Credential 被拒绝；
5. 不同 installation 被拒绝；
6. 新 Pairing 不能轮换已有 Credential；
7. JSON 响应不包含 Credential；
8. 网络错误保留 pending Claim；
9. 成功和终态错误清除 pending Claim；
10. 正式 URL 使用 fragment；
11. 首个 HTTP URL 不包含配对材料；
12. Credential 必须为 canonical Base64URL 且精确解码为 32 字节；
13. 并发重放返回同一 Entry Session，不产生 Session 轮换；
14. 超过两分钟或三次成功 replay 后拒绝；
15. v1 Web Claim 被明确拒绝，v2 正常工作。

### 11.5 Cookie 和秘密

必须覆盖：

1. Context/renew 的 Cookie-auth `DEVICE_REVOKED` 清除全部 Web Cookie；
2. Cookie Bridge 的 Chat / Work / Sync revoke 清除全部 Web Cookie；
3. 明确 Bearer 请求不产生 `Set-Cookie` 副作用；
4. 普通 Session 401 不清 Device Cookie；
5. SSE `entry-revoked` 后调用同源 clear endpoint；
6. clear endpoint 拒绝跨源或缺少自定义头的请求；
7. 动态 Token、Cookie、Device Credential、pairing code 和完整 fragment 不出现在最终日志字节、PublicError、Channel 或 JSON 响应中。

### 11.6 完整门禁

至少执行：

```bash
npm run check
```

报告测试总数、通过、失败和跳过数量，以及类型检查和构建结果。

## 12. 可直接体验的隔离环境

当前 `compose.yaml` 使用固定项目名、镜像和 `8790` 端口；在正式 Compose 隔离修复前不得用本 worktree 运行 `verify-foundation.sh`。

本批预览使用独立 Node Gateway：

```text
worktree:
/home/youran/Development/family-ai-platform-worktrees/member-web-entry-hardening

database:
<worktree>/.runtime-preview/data/gateway.sqlite

listen:
127.0.0.1:8791

Mac tunnel:
127.0.0.1:8791 → ssh admin-yr → Linux 127.0.0.1:8791

response-loss acceptance proxy:
Linux 127.0.0.1:8792 → upstream 127.0.0.1:8791

proxy tunnel:
Mac 127.0.0.1:8792 → ssh admin-yr → Linux 127.0.0.1:8792
```

预览环境：

- 使用独立数据库、Token、PID 和日志；
- 使用仓库当前 development Provider；如果回复来自 Fake Adapter，体验说明必须明确标注为开发模拟回复，不宣称已接入生产 AI；
- 配置文件权限为 `0600`；
- 日志不得输出 Token、Cookie、Credential 或配对码；
- 不停止、重建或替换现有 `8790` 容器；
- 不使用固定 Compose 镜像标签；
- 只用于本批产品体验；
- 体验完成后可以独立停止。

完成自动验证后，为用户准备真实 Web Pairing fragment URL，并确认 Mac 通过 Tunnel 可以打开正式 `/member/`。URL 只写入独立的 `0600` handoff 文件并直接交给用户，不进入任何被 `tee` 捕获的 stdout 或日志。

“首次 Claim 已提交但响应丢失”的人工体验使用 Preview 外的临时整站反向代理。浏览器从 `8792` 打开 `/member/`，相对 API 和 SSE 也全部经 `8792` 转发到 `8791`；代理保留下游 Host 和 Origin 语义，使 Cookie、SameSite 和 Gateway CSRF 校验仍走正式同源路径。

代理只在上游已完整完成第一次 Claim 后关闭对应下游响应，第二次完全相同的 Claim 原样透传。它不得记录请求体、Cookie、响应 `Set-Cookie` 或 fragment，不得改动产品数据库、Cookie 或请求体，也不得进入正式代码和发布产物。代理具有独立 PID/日志、一次性故障状态和明确启停步骤；自动化测试仍直接覆盖 Repository 与 HTTP Route。

## 13. 用户主要体验清单

用户不需要覆盖所有自动测试。正常进入、Logout、Resume、多标签页和远程撤销是主要产品体验；“配对网络重试”是我准备好故障代理后陪同验证的高级恢复体验。

### 13.1 正常进入和工作

1. 打开配对链接；
2. 进入真实 Member Web；
3. 发送一条 Chat；
4. 收到 Assistant 回复；
5. 创建一个 Work 并发送一条 Work 消息。

### 13.2 Logout 真正锁定

1. 点击“退出当前会话”；
2. 刷新页面；
3. 确认没有自动登录；
4. 页面只提供显式恢复入口。

### 13.3 显式恢复

1. 点击“恢复入口”；
2. 确认回到同一个 Person；
3. Chat、Work、草稿和历史仍在；
4. 创建一个 Work，确认只创建一次。

### 13.4 多标签页

1. 同时打开两个 Member Web 标签；
2. 在标签 A Logout；
3. 确认标签 B 立即锁定；
4. 在一个标签恢复；
5. 确认另一个标签不会反复 renew 或互相踢下线。

### 13.5 配对网络重试（引导式高级体验）

1. 在预设的响应丢失验收场景触发第一次 Claim；
2. 点击重试；
3. 确认进入工作台；
4. 确认没有重复 Device。

### 13.6 远程撤销

1. 从 Admin 路径撤销当前 Web Device；
2. 刷新或继续操作 Member Web；
3. 确认所有标签回到配对页；
4. 确认旧历史不再显示；
5. 使用新配对码重新建立入口。

## 14. 发布和回滚

本批是独立分支和独立 PR，直接基于 `main`。

发布前：

- 所有定向测试通过；
- `npm run check` 通过；
- 隔离 Preview 体验完成；
- 现有 `8790` 容器保持健康；
- Git 工作树干净；
- 无秘密进入 Git 或日志。

回滚代码不会自动恢复被一次性删除的旧 v1 全局缓存。该数据本身无法可信归属，这是已批准的安全取舍。

新的身份数据库不会在普通 Logout 时删除，只在 Device Revoke 时删除。

## 15. 完成定义

只有同时满足以下条件才可报告完成：

1. 所有已批准行为都有先失败后通过的自动回归测试；
2. 完整质量门禁通过；
3. 身份 A/B 缓存隔离得到行为验证；
4. Logout、Resume、Revoke 和多标签页得到行为验证；
5. Pairing 响应丢失重放得到 Repository 和 HTTP 验证；
6. Renderer 重建不再重复写操作；
7. 用户可以从 Mac 直接打开隔离 Preview；
8. 用户收到明确的主要体验清单；
9. 现有 Linux `8790` Gateway 未被停止或替换；
10. Pending Claim 未决期间，配对码和 Device Credential 只短暂存在当前标签的 `sessionStorage`；成功或终态错误后清除，且始终不进入 LocalStorage、IndexedDB、Git、日志、PublicError、BroadcastChannel 或 JSON 响应。
