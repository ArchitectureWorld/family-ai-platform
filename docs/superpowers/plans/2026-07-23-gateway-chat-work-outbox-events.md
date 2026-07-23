# Gateway Chat / Work Outbox Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为正式 Chat / Work 领域增加 Person 级持久化事件序列、Transaction Outbox 和可租约投递状态，为后续 SSE 与 Sync Cursor 提供可靠底座。

**Architecture:** 事件子系统使用独立、版本化的 schema ledger，并由 SQLite Trigger 在领域事务内捕获 Chat / Work / Provider 状态变化。`DomainEventStore` 提供显式事件追加、Person 事件分页以及 Outbox claim / publish / fail API；Gateway 启动时在任何正式领域写入前安装该模块。

**Tech Stack:** TypeScript 6、Fastify、better-sqlite3、Vitest 4、SQLite JSON1 / Trigger。

## Global Constraints

- 基线固定为 `main` commit `97adaa08bb0b015e7a9b8ade3a43e55aab282238`。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`。
- 不修改 Mobile Entry 配对、Session、认证和浏览器一键验收台。
- 领域数据与对应 event/outbox 必须同事务提交或回滚。
- Event payload 不得包含消息正文、Token、Credential、Authorization 或 Provider External Session。
- Outbox 只有持有未过期 lease 的 Worker 才能完成 publish 或 fail 状态更新。

---

## File Map

- Create: `apps/gateway/src/domainEvents.ts` — 事件 schema、触发器、事件分页和 Outbox 租约 API。
- Modify: `apps/gateway/src/app.ts` — Gateway 启动时安装事件子系统。
- Modify: `apps/gateway/test/database.test.ts` — 模块 schema ledger、表、索引和重启幂等。
- Create: `apps/gateway/test/domainEvents.test.ts` — 序列、分页、lease、publish、fail、过期回收和重启。
- Create: `apps/gateway/test/chatWorkEvents.test.ts` — Chat / Work / Provider 事件、幂等、回滚和 payload 安全。
- Modify: `docs/superpowers/specs/2026-07-23-gateway-chat-work-outbox-events-design.md` — 最终触发器架构。
- Modify: `docs/superpowers/plans/2026-07-23-gateway-chat-work-outbox-events.md` — 本执行计划。

---

### Task 1: Define the missing event subsystem through RED

**Files:**
- Modify: `apps/gateway/test/database.test.ts`
- Create: `docs/superpowers/specs/2026-07-23-gateway-chat-work-outbox-events-design.md`

- [x] **Step 1: Define event schema requirements**

The initial test required:

```text
person_event_sequences
domain_events
outbox_events
domain_events_person_sequence_idx
outbox_events_dispatch_idx
```

- [x] **Step 2: Observe RED**

GitHub Actions CI #276 failed because the event schema was absent. Secret Scan #162 passed.

- [x] **Step 3: Review the initial migration approach**

The first draft proposed core Migration V6 plus manual Repository appends. Review identified two avoidable risks:

1. every Repository mutation would need a manually maintained event call;
2. missing one call could commit domain data without a durable event.

The final architecture therefore moved the event subsystem to its own schema ledger and used SQLite triggers for atomic capture.

---

### Task 2: Install a versioned event schema and transactional triggers

**Files:**
- Create: `apps/gateway/src/domainEvents.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/database.test.ts`

- [x] **Step 1: Add module schema ledger**

```text
domain_event_schema_migrations
version = 1
```

The installer requires Gateway core schema version 5 and is idempotent across restarts.

- [x] **Step 2: Add event tables**

```text
person_event_sequences
domain_events
outbox_events
```

- [x] **Step 3: Add transactional triggers**

Triggers emit:

```text
chat.home.created
work.created
thread.message.created
chat.work.created
work.progress.updated
thread.provider_turn.failed
thread.provider_turn.succeeded
```

Each trigger performs, inside the caller's existing transaction:

```text
increment Person sequence
→ insert domain event
→ insert pending outbox row
```

- [x] **Step 4: Install before domain writes**

`buildGatewayApp()` constructs `DomainEventStore` immediately after opening the core database and before Development Bootstrap or Repository construction.

- [x] **Step 5: Verify GREEN**

CI #280 passed the full repository quality gate. Secret Scan #166 passed.

---

### Task 3: Implement `DomainEventStore`

**Files:**
- Create: `apps/gateway/src/domainEvents.ts`
- Create: `apps/gateway/test/domainEvents.test.ts`

**Interfaces:**

```ts
append(input): DomainEvent
listPersonEvents({ personRef, afterSequence?, limit? }): DomainEventPage
claimOutboxBatch({ workerRef, now, claimedUntil, limit? }): OutboxDelivery[]
markPublished({ eventRef, workerRef, publishedAt }): void
markFailed({ eventRef, workerRef, error, availableAt, updatedAt }): void
```

- [x] **Step 1: Add explicit event append**

`append()` verifies Person and optional Thread ownership, allocates a Person sequence, then inserts event and pending Outbox in one transaction.

- [x] **Step 2: Add Person event paging**

Events are returned by `event_sequence ASC`, after an exclusive `afterSequence`, with a maximum page size of 200.

- [x] **Step 3: Add Outbox claim leasing**

Claim logic:

```text
reclaim expired claims
→ select available pending rows
→ order by available_at + Person + sequence
→ set worker and claimed_until
→ increment attempt_count
```

- [x] **Step 4: Add publish and fail transitions**

A matching Worker may publish or return an event to pending. Failed delivery stores only a bounded `PublicError`, not raw exceptions.

- [x] **Step 5: Verify lifecycle and restart**

Tests cover Person sequence independence, paging isolation, retries, expired claim recovery, wrong-worker rejection and database restart recovery.

---

### Task 4: Verify Chat / Work / Provider atomic events

**Files:**
- Create: `apps/gateway/test/chatWorkEvents.test.ts`

- [x] **Step 1: Verify Chat and Work events**

Covered:

```text
Home Chat creation
Work creation
Person message creation
Chat → Work conversion
Work Progress update
```

- [x] **Step 2: Verify Provider events**

Covered:

```text
Assistant message event
Provider Turn succeeded
Provider Turn failed
failed Turn retry
successful replay
```

- [x] **Step 3: Verify idempotency**

Identical Person-message replay does not create a second message event. Successful Provider Turn replay does not create another Assistant message or event.

- [x] **Step 4: Verify rollback**

Invalid Chat → Work conversion leaves no partial Work, conversion event or Outbox row because trigger writes participate in the original SQLite transaction.

- [x] **Step 5: Verify payload safety**

Tests confirm serialized events do not contain:

```text
message body
Fake Provider output text
external-session:
```

- [x] **Step 6: Verify GREEN**

CI #281 passed the full repository quality gate. Secret Scan #167 passed.

---

### Task 5: Enforce active lease finalization

**Files:**
- Modify: `apps/gateway/test/domainEvents.test.ts`
- Modify: `apps/gateway/src/domainEvents.ts`

- [x] **Step 1: Write the regression test**

The test claims two events with a one-second lease, then attempts `markPublished()` and `markFailed()` after lease expiry.

- [x] **Step 2: Observe RED**

CI #283 failed, confirming the previous SQL checked Worker identity but not lease expiry.

- [x] **Step 3: Fix at the state-transition boundary**

Both updates now require:

```sql
status = 'claimed'
AND claimed_by = ?
AND claimed_until > completion_timestamp
```

An expired Worker therefore cannot finalize a stale claim. Another worker can reclaim it through `claimOutboxBatch()`.

- [ ] **Step 4: Verify final GREEN**

Required:

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

---

### Task 6: Final PR boundary review

- [ ] **Step 1: Confirm latest CI and Secret Scan pass**
- [ ] **Step 2: Confirm PR comments and review threads are empty or resolved**
- [ ] **Step 3: Compare PR #19 paths against PR #14; intersection must be zero**
- [ ] **Step 4: Confirm PR #14 head and Draft status are unchanged**
- [ ] **Step 5: Update PR #19 description and mark Ready for review**
- [ ] **Step 6: Keep PR #19 unmerged**
