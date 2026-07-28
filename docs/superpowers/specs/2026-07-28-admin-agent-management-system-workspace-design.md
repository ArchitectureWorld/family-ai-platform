# Family AI Agent 挂载、状态监控与管理员系统工作台设计

- 日期：2026-07-28
- 状态：交互设计已确认，书面规格待最终复核
- 目标分支：`fix/member-web-entry-hardening`
- 目标仓库：`ArchitectureWorld/family-ai-platform`（非 legacy）

## 1. 目标

在现有同一 Gateway、同一 SQLite 和 Admin/Personal 双入口之上，交付可以直接体验的多 Agent 产品闭环：

1. 管理员查看平台全部 Agent 的实时聚合状态；
2. 管理员为家庭成员挂载、移除和设置默认 Agent；
3. 成员在自己的入口中使用一个或多个已挂载 Agent；
4. 每个“成员 + Agent”的 Chat、Work、消息与 Provider Session 相互独立；
5. 管理员在独立系统工作台中同时使用 Hermes Jarvis 与 Codex CLI；
6. 同一成员从手机、Windows 或其他终端进入时，继续同一个平台 Chat 和明确的 Provider Session。

本设计扩展正式产品能力，不引入第二套后台、用户库、Agent 库或消息库。

## 2. 已确认的产品决策

### 2.1 Agent 挂载

- 平台维护一份全局 Agent 目录；
- 本版不区分“个人 Agent”“共享 Agent”或“系统 Agent”类型；
- 同一 Agent 可以挂载给多个成员；
- 同一成员不能重复挂载同一 Agent；
- 只有 `family_admin` 可以新增、移除和设置成员的默认 Agent；
- 成员可以在本次使用中临时切换 Agent，但不能修改默认 Agent；
- 默认 Agent 可以暂时为空；
- 移除只结束挂载，不删除 Chat、Work、消息或历史；
- 重新挂载相同 Agent 后，原有平台历史重新可见。

Family AI 保证平台线程和 Provider Session 不跨“成员 + Agent”复用。若管理员把同一个 Hermes Profile 挂载给多个成员，Hermes Profile 自身的内部记忆仍可能共享；本版在管理界面提示该事实，但不增加类型、独占规则或强制拦截。

### 2.2 成员入口

- 有默认 Agent 时，首次进入选择默认 Agent；
- 没有默认 Agent 但存在挂载时，显示“选择一个 Agent 开始”；
- 没有任何挂载时，显示“管理员尚未为你配置 Agent”；
- 临时选择不会写回默认 Agent；
- 已挂载 Agent 控件显示文字状态，不只依赖颜色；
- 切换 Agent 同时切换其独立 Chat、Work 列表和上下文。

### 2.3 管理员入口

Admin Web 使用两个独立页面：

```text
成员与 Agent 配置
系统工作台
```

“成员与 Agent 配置”不嵌入管理员 Chat/Work。“系统工作台”不展示成员配置表。管理员身份不因具备挂载权限而获得成员私人 Chat、Work 或消息正文的读取权。

### 2.4 系统工作台

- 顶部是独立、滚动时保持可见的 Agent 监控容器；
- 默认是只占一行的简约模式；
- 详情模式本版只显示活动数量、最后检查时间和脱敏错误；
- 下方固定 50/50 左右分屏；
- 左侧为 Hermes Jarvis，右侧为 Codex CLI；
- 两个 Agent 同时存在，各自拥有独立 Chat、Work、线程和 Provider Session；
- 家庭创建者的 Admin Entry 默认获得这两个系统工作台 Agent；
- 本版不增加工作目录选择、目录白名单管理、相关 Admin API 或数据库配置；
- Provider Adapter 保留由服务端注入预配置工作目录的扩展点。未配置必要工作目录时，相应 Agent 显示红色“未配置”。

## 3. 方案选择

### 3.1 Provider 接入

采用受控 CLI Adapter。

```text
Gateway
  ├── HermesCliProviderAdapter
  ├── CodexCliProviderAdapter
  └── FakeProviderAdapter（自动测试）
```

没有采用首版 Hermes ACP + Codex CLI 双协议方案。ACP 适合后续优化常驻连接和流式体验，但不会比持久化明确 Session ID 更能保证多端会话一致性。

没有采用 Hermes Dashboard/Gateway WebSocket 作为业务 Provider 接口。该方案会把 Family AI 权限、会话和页面生命周期耦合到 Hermes 内部 Dashboard 协议。

### 3.2 多端 Session 权威

多端一致性由 Gateway 数据模型保证，不依赖浏览器、设备或一个常驻 CLI 进程：

```text
person_ref + agent_ref
→ 唯一 active HomeChatStream
→ 唯一 InteractionThread
→ 唯一 ThreadProviderContext
→ 明确 external_session_ref
```

Provider 首轮返回 Session ID 后，Gateway 将其与线程原子持久化。后续请求：

- Codex 使用 `codex exec resume <SESSION_ID>`；
- Hermes 使用 `hermes chat --resume <SESSION_ID>`；
- 不允许使用 `--last`、最近会话选择器或依赖进程内隐式状态。

不同 Work 使用不同 `InteractionThread` 和 `external_session_ref`。Jarvis 与 Codex 的 Chat/Work 也不共享 Session。

## 4. 现有运行时证据

目标 Linux 已确认：

- 远程 SSH 用户、主机身份和私有 LAN 路径符合部署约束；
- Hermes Jarvis Gateway 的 loopback 健康端点正常；
- Hermes ACP 依赖自检通过；
- 成员 Hermes Profile 已存在：`zzh`、`nsy`、`zzg`；
- Codex CLI 版本为 `0.145.0`；
- Codex 支持 `codex exec resume <SESSION_ID>`；
- Hermes 单次调用的安静模式会输出明确 `session_id`，并支持 `--resume`。

此前非登录 SSH 检测不到 Codex，是因为其 PATH 未包含用户级可执行文件目录，不是 Codex 未安装。实现必须使用经过验证的显式可执行文件配置，不能依赖交互 Shell PATH。

这些主机路径和版本只属于目标环境验收证据，不进入公共 API、浏览器响应或客户端日志。

## 5. 数据模型

所有 Schema 变化通过新的递增 SQLite Migration 完成，不重写既有 migration。

### 5.1 Agent 目录与运行绑定

既有 `agents` 和 `provider_profiles` 继续作为全局 Agent 和 Provider 身份权威。新增内部运行绑定，使一个 Agent 解析到一个启用的 Provider Profile：

```text
agent_runtime_bindings
- agent_ref
- provider_profile_ref
- status: active | disabled
- created_at
- updated_at
```

运行绑定不保存 Token、Cookie、`.env` 内容、CLI 绝对路径或 Provider Session。可执行文件、Hermes Home、Profile 和预配置工作目录由服务端运行配置注入。

### 5.2 成员 Agent 挂载

既有 `assistant_assignments` 从“每个 Person 只能有一个 active”扩展为“每个 Person 对每个 Agent 最多一个 active”：

```text
assistant_assignments
- assignment_ref
- person_ref
- agent_ref
- provider_profile_ref
- status: active | ended
- is_default
- effective_from
- effective_to
```

约束：

- active `(person_ref, agent_ref)` 唯一；
- 每个 Person 最多一个 active `is_default = 1`；
- ended Assignment 不能是默认；
- 默认可全部为空；
- 设置新默认在一个事务内清除旧默认；
- 移除默认 Agent 后不自动选择另一个默认；
- 移除将 Assignment 标记为 ended，不物理删除。

重新挂载相同 Agent 会建立新的 Assignment。若线程的 Person、Agent 和 Provider Profile 均未变化，Gateway 更新线程的当前 Assignment 引用并保留 `external_session_ref`；若 Provider Profile 改变，则保留平台消息历史，但开始新的 Provider Context Segment。

### 5.3 按 Agent 隔离 Chat 与 Work

`home_chat_streams` 增加 `agent_ref`，active 唯一约束改为：

```text
(person_ref, agent_ref) WHERE status = 'active'
```

`work_conversations` 增加 `agent_ref`。Work 创建、列表、Chat 转 Work 和进度读取都必须校验当前 Person 已挂载相同 Agent。

`interaction_threads` 继续是消息基础父对象；线程的 Person 所有权不变。线程对应的 Agent 由 Home Chat 或 Work 业务对象确定，不能由客户端消息正文临时覆盖。

### 5.4 管理员系统工作台

管理员系统工作台使用独立的 Admin Agent Assignment 和 Admin 线程作用域，不复用成员 Personal Assignment：

```text
admin_agent_assignments
- assignment_ref
- family_ref
- person_ref
- agent_ref
- provider_profile_ref
- status: active | ended
- effective_from
- effective_to
```

Admin 工作台线程同时绑定：

```text
family_ref + admin person_ref + agent_ref + entry_audience=family_admin
```

Personal API 不能读取 Admin 工作台线程，Admin 成员配置 API也不能读取 Personal 线程。现有 `family_manager_assignments` 继续表达家庭管家角色；Admin 工作台的 Jarvis Assignment 引用同一个 Agent/Provider 身份，但不改变家庭级授权模型。

## 6. API 与权限

### 6.1 Admin Agent API

新增仅允许 `family_admin` 的端点：

```text
GET    /api/v1/admin/agents
GET    /api/v1/admin/members/:personRef/agent-mounts
POST   /api/v1/admin/members/:personRef/agent-mounts
DELETE /api/v1/admin/members/:personRef/agent-mounts/:agentRef
PUT    /api/v1/admin/members/:personRef/default-agent
GET    /api/v1/admin/system-workspace
```

挂载 POST 只接收 `agentRef`。Provider Profile 由服务端 Agent 运行绑定解析，客户端不能注入 Provider Profile、CLI 路径或 Session ID。

设置默认端点接收：

```json
{ "agentRef": "agent:..." }
```

或：

```json
{ "agentRef": null }
```

所有写操作验证目标 Person 属于当前 Admin 的 Family，并写入不含秘密和消息正文的审计事件。

### 6.2 Personal Context 与 Chat/Work API

`GET /api/v1/portal/context` 的 Personal 响应增加：

```text
mountedAgents[]
defaultAgentRef nullable
```

`GET /api/v1/chat`、Work 列表和创建请求增加明确 `agentRef`。Gateway 必须在返回线程、创建 Work 或发送消息前验证：

```text
当前 Personal Entry 的 person_ref
+ 当前 active Agent Assignment
+ 目标线程的 person_ref
+ 目标线程的 agent_ref
```

客户端传入的 `agentRef` 只是选择器，不是授权声明。未挂载、已移除或跨成员访问一律拒绝。

已有 `/api/v1/threads/:threadRef/messages` 继续从 Thread 反查 Person 和 Agent，不接受额外的可覆盖 Agent 字段。

### 6.3 状态 API

`GET /api/v1/admin/agents` 返回全部 Agent 的脱敏聚合状态：

```text
agentRef
displayName
status: idle | working | problem
statusLabel: 空闲 | 工作中 | 有问题
activeTurnCount
lastCheckedAt
publicProblem nullable
```

不返回消息正文、Prompt、stderr、Session ID、Token、运行路径或成员私人身份列表。

## 7. 状态计算

状态优先级：

```text
problem > working > idle
```

### problem / 红色“有问题”

满足任一条件：

- Agent 没有 active 运行绑定；
- Adapter 可执行文件或必要服务端配置缺失；
- Adapter 健康检查失败；
- Provider Turn 超过其 timeout 与短暂宽限期仍为 pending；
- 最近调用失败且后续健康检查或成功调用尚未清除问题状态。

### working / 橙色“工作中”

Adapter 健康，且该 `agent_ref` 至少有一个未超时的 pending Provider Turn。共享给多个成员时按 Agent 聚合，任一任务运行即显示 working。

### idle / 绿色“空闲”

Adapter 健康，且没有运行中的 Provider Turn。

Admin Web 每五秒读取状态。SSE 状态事件可以在后续减少轮询延迟，但不是本版正确性的前提。

## 8. Provider Adapter

### 8.1 共用安全边界

两个真实 Adapter 都必须：

- 使用 `spawn(executable, args, options)`，禁止 Shell 字符串拼接；
- 使用显式可执行文件配置，不依赖登录 Shell PATH；
- 只传递 Provider 所需的白名单环境变量；
- 使用固定最大运行时间、stdout/stderr 字节上限和并发上限；
- Provider 调用不位于 SQLite 事务内；
- 超时或取消时终止整个子进程组；
- 只解析预期的机器可读输出；
- 对 Session ID、响应文本和状态做 Schema 校验；
- 不把 stderr、绝对路径、配置或凭据写入公共错误、审计或 Git；
- 不把真实 Provider 调用加入自动测试；
- 同一 Thread 使用既有 Lane 串行，不同 Thread 可以并行。

### 8.2 Hermes

服务端运行配置决定 Jarvis Home 或成员 Hermes Profile。调用显式选择 Profile，并使用安静的程序化模式。首轮从机器可读的 `session_id` 输出获取 Session；后续只用保存的 Session ID恢复。

Hermes Profile 的配置、SOUL、记忆、Session 和凭据仍由其自己的 Hermes Home 权威持有。Family AI 不创建、删除、合并或编辑 Hermes Profile。

### 8.3 Codex

Codex 使用结构化 JSONL：

```text
首轮：codex exec --json ...
续接：codex exec resume <SESSION_ID> --json ...
```

Adapter 从明确的 session/thread started 事件提取 Session ID，从 final response 事件提取文本。禁止使用 `--last`。本版不使用 `--ephemeral`，因为它会破坏 Session 续接。

工作目录由服务端在 Adapter 装配时预配置。本版不提供管理员目录选择能力，也不扩大目录授权范围。

## 9. 交互

### 9.1 成员与 Agent 配置

每个成员行包含已挂载 Agent 控件：

- 状态圆点 + Agent 名称 + 状态文字；
- 控件右上角有 Apple 风格红色小叉；
- 点击小叉先进行轻量确认，再结束挂载；
- `+ Agent` 下拉只列出该成员尚未挂载的 Agent；
- 下拉不因为 Agent 已挂载给其他成员而排除它；
- 默认 Agent 有明确“默认”标记；
- 可设置另一个默认，也可清空默认；
- 同一请求重复提交不会产生重复 active Assignment。

### 9.2 成员工作台

顶部 Agent 选择只显示当前成员的 active 挂载。选择 Agent 后：

- 加载对应 Home Chat；
- Work 列表只显示对应 Agent 的 Work；
- 新建 Work 固定绑定当前 Agent；
- 从 Chat 转 Work 继承当前 Agent；
- 页面刷新优先恢复本设备临时选择；不存在时使用服务器默认；
- 临时选择已被管理员移除时，立即回退到选择界面；
- 其他终端的默认变更通过下一次 context 刷新生效，但不会把成员的临时选择写回服务器。

### 9.3 系统工作台

页面从上到下：

```text
Sticky 全部 Agent 监控台
Jarvis 50% | Codex CLI 50%
```

简约监控是一行可横向滚动的状态项。详情容器只增加活动数量、最后检查时间和脱敏问题，不显示 Prompt、消息或日志。

Jarvis 与 Codex 面板各自包含 Chat 和 Work 切换。窄屏仍保持两个逻辑面板独立，可改为纵向排列，但不能合并上下文。

## 10. 数据流

### 10.1 管理员挂载

```text
Admin Entry 鉴权
→ 校验当前 Family 与目标 Person
→ 校验 Agent 运行绑定存在
→ 幂等创建 active Assignment
→ 发布脱敏 Agent Assignment 事件
→ Member Context 下次读取返回新挂载
```

### 10.2 多端 Chat

```text
任意 Personal Device
→ 发送当前 agentRef
→ Gateway 校验 active Assignment
→ 解析 person + agent 的唯一 Home Chat
→ thread lane 串行
→ 读取明确 external_session_ref
→ CLI 首轮或 resume
→ Assistant Message + Session + Turn 状态原子提交
→ Outbox/SSE 通知同一 Person 的其他设备
→ 其他设备按 Sync Cursor 补拉相同消息
```

如果 Provider Session 文件丢失或不可恢复，原平台 Thread 与消息仍保留。Gateway 将该 Provider Context 标记为 problem；经明确重试可建立新 Provider Session，并用平台保存的上下文恢复，不伪造原 Session 仍然存在。

## 11. 错误处理

新增或复用稳定公开错误：

```text
AGENT_NOT_MOUNTED             403
AGENT_MOUNT_CONFLICT          409
AGENT_RUNTIME_UNAVAILABLE     503
PROVIDER_SESSION_NOT_FOUND    502
PROVIDER_RESPONSE_INVALID     502
PROVIDER_TIMEOUT              504
```

规则：

- 授权失败先于幂等或缓存命中；
- 移除挂载期间已开始的 Turn 可以完成持久化，但移除后的新消息必须拒绝；
- Provider 失败保留 Person 消息和失败 Turn，不重复 Person 消息；
- 相同消息重试不创建第二个成功 Assistant 回复；
- CLI 未安装、未认证或配置错误只产生固定的脱敏公开错误；
- 状态红色不阻止管理员移除或重新挂载 Agent；
- 一处 Agent 调用失败不使其他 Agent、其他 Thread 或 Gateway 停止服务。

## 12. Migration 与现有数据

Migration 必须：

1. 在事务内建立新表和索引；
2. 为现有 active Assignment 设置 `is_default = 1`；
3. 按现有 Thread Provider Context 回填 Home Chat 与 Work 的 `agent_ref`；
4. 对没有 Provider Context 的空线程使用该 Person 的现有 active Assignment 回填；
5. 发现无法唯一回填时失败关闭，不猜测 Agent；
6. 重建原“每 Person 一个 active Assignment”索引为“每 Person + Agent 一个 active”；
7. 保留所有既有 Ref、消息、事件、Session 与时间戳；
8. 支持重复启动并通过 migration ledger 验证；
9. 在 Preview 数据副本上验证后才允许切换现有预览。

本设计不迁移 legacy 仓库或旧 Control Center 的任何数据。

## 13. 测试

实施遵循失败测试 → 最小实现 → 全量回归。

### 13.1 数据与领域测试

- 同一 Agent 可挂载给两个不同成员；
- 同一成员重复挂载相同 Agent 幂等或冲突，不产生重复 active 行；
- 只有 Admin 可以挂载、移除和设置默认；
- 默认 Agent 可清空；
- 移除默认后不会自动选择其他 Agent；
- 移除后历史保留，重新挂载恢复；
- 同一成员两个 Agent 拥有不同 Home Chat 和 Work；
- 同一 Agent 的两个成员拥有不同 Thread 和 Provider Session；
- Provider Profile 未变化的重挂载保留明确 Session；
- Provider Profile 改变时平台历史保留、Provider Session 重建；
- Migration 正确回填现有 Preview 数据。

### 13.2 API 与安全测试

- Personal API 无法调用 Admin Agent API；
- Admin 配置 API无法读取成员消息正文；
- 客户端伪造未挂载 `agentRef` 被拒绝；
- Thread 与选择 Agent 不匹配被拒绝；
- 响应不包含 Session ID、stderr、绝对路径或秘密；
- 移除与发送并发时不越过授权边界；
- SSE 与 Sync Cursor 在多端返回同一平台 Thread 的消息。

### 13.3 Adapter 合同测试

使用临时假 CLI 可执行文件覆盖：

- 首轮返回 Session ID；
- 后续使用明确 Session ID resume；
- 永不使用 `--last`；
- stdout 分段、无效 JSON、缺失 Session、非零退出；
- stderr 脱敏；
- 超时、输出超限、进程组终止；
- 同 Thread 串行、不同 Thread 并行；
- 环境变量只包含 allowlist；
- 工作目录只来自服务端 Adapter 配置。

### 13.4 UI 测试

- `+ Agent` 不显示当前成员已挂载 Agent；
- 其他成员已挂载不影响当前下拉；
- 红色小叉可取消和确认；
- 状态颜色始终伴随文字；
- 无默认、有挂载和无挂载三种成员状态；
- 临时 Agent 选择不修改默认；
- 配置页与系统工作台导航、状态和内容隔离；
- Sticky 简约监控和详情切换；
- Jarvis/Codex 两面板不会串换消息或 Work。

## 14. 目标环境验收

自动门禁：

```bash
npm ci
npm run check
docker compose build
./scripts/dev-up.sh
./scripts/acceptance.sh
```

局域网真实验收：

1. Admin Web 查看全部 Agent 状态；
2. 给一个成员挂载两个 Agent，验证下拉不重复；
3. 设置默认、清空默认并验证成员端三个空态；
4. 手机和 Windows 进入同一成员、同一 Agent Chat；
5. 终端 A 发送第一轮，终端 B 继续第二轮；
6. 数据库和 Adapter 证据确认两轮使用同一明确 Provider Session ID；
7. 同一成员切换另一个 Agent，验证 Chat/Work/Session 独立；
8. 移除并重新挂载，验证历史恢复；
9. Admin 系统工作台分别向 Jarvis 和 Codex 发送受控验收消息；
10. 验证两个面板各自继续原 Session，且状态经历 idle → working → idle；
11. 刷新浏览器和重启 Gateway 后再次续接；
12. 验证现有 `127.0.0.1:8790` 服务不被 Preview 改写。

真实 Provider 验收只发送最小非敏感 Prompt，记录通过/失败、耗时和脱敏 Session 指纹，不记录 Prompt 正文、完整 Session ID、Token 或 Provider 输出正文。

## 15. 发布与合并

- 继续在现有 `fix/member-web-entry-hardening` worktree 实施和体验；
- 未完成书面规格复核、实施计划、测试、真实双 Provider 和多端验收前不合并；
- 验收通过后将功能分支合并到非 legacy 主仓库 `main`；
- 合并后在 `main` 重建并验证 LAN Preview；
- 确认不再需要且无未提交内容后，再删除功能 worktree 和任务分支；
- 不复制或合并 `family-ai-platform-legacy`。

## 16. 明确延期

本版不实现：

- Agent 个人/共享/系统类型；
- Hermes Profile 自动创建、删除或秘密配置；
- Hermes Profile 全局独占绑定；
- 管理员工作目录选择与目录白名单管理；
- 监控详情中的 Prompt、消息正文、日志或任务追踪；
- Provider 计费统计；
- ACP 常驻连接；
- 公网入口或异地管理；
- 管理员读取成员私人 Chat、Work、记忆或 Provider Session；
- 多 Agent 自动语义编排。
