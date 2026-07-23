# Gateway Chat / Work Outbox Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为正式 Chat / Work 领域增加 Person 级持久化事件序列、Transactional Outbox 和可租约投递状态，为后续 SSE 与 Sync Cursor 提供可靠底座。

**Architecture:** 事件子系统使用独立、版本化的 Schema Ledger，并由 SQLite Trigger 在领域事务内捕获 Chat / Work / Provider 状态变化。`DomainEventStore` 提供显式事件追加、Person 事件分页和 Outbox Claim / Publish / Fail API；Gateway 启动时在任何正式领域写入前安装模块。

**Tech Stack:** TypeScript 6、Fastify、better-sqlite3、Vitest 4、SQLite JSON1 / Trigger。

## Global Constraints

- 基线固定为 `main` commit `97adaa08bb0b015e7a9b8ade3a43e55aab282238`。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`。
- 不修改 Mobile Entry 配对、Session、认证和浏览器一键验收台。
- 领域数据与对应 Event / Outbox 必须同事务提交或回滚。
- Event Payload 不得包含消息正文、Token、Credential、Authorization 或 Provider External Session。
- 只有持有匹配且未过期 Lease 的 Worker 才能完成 Outbox 状态。

---

## File Map

- Create: `apps/gateway/src/domainEvents.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/database.test.ts`
- Create: `apps/gateway/test/domainEvents.test.ts`
- Create: `apps/gateway/test/chatWorkEvents.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-gateway-chat-work-outbox-events-design.md`
- Modify: `docs/superpowers/plans/2026-07-23-gateway-chat-work-outbox-events.md`
- Create: `docs/superpowers/evidence/2026-07-23-gateway-chat-work-outbox-events.md`

---

### Task 1: Define the missing event subsystem

- [x] **Write the initial failing schema test**

The test required Person sequences, durable events and Outbox persistence.

- [x] **Observe RED**

CI #276 failed because the event subsystem did not exist. Secret Scan #162 passed.

- [x] **Review the initial V6/manual-append approach**

The initial proposal was rejected during implementation review because manual Repository calls could be omitted. The final design uses a module-owned Schema Ledger plus SQLite triggers, preserving atomicity without changing established repositories.

---

### Task 2: Install the versioned event subsystem

- [x] **Create `domain_event_schema_migrations` version 1**
- [x] **Create `person_event_sequences`**
- [x] **Create `domain_events`**
- [x] **Create `outbox_events`**
- [x] **Create Person-sequence and dispatch indexes**
- [x] **Install the subsystem in `buildGatewayApp()` before domain writes**
- [x] **Verify restart idempotency and foreign keys**

The core Gateway schema remains version 5. The event module has its own explicit migration ledger and requires core schema version 5.

---

### Task 3: Capture formal domain events transactionally

- [x] **Emit `chat.home.created`**
- [x] **Emit `work.created`**
- [x] **Emit `thread.message.created` for Person and Assistant messages**
- [x] **Emit `chat.work.created`**
- [x] **Emit `work.progress.updated`**
- [x] **Emit `thread.provider_turn.failed`**
- [x] **Emit `thread.provider_turn.succeeded`**

Each trigger performs:

```text
increment Person Sequence
→ insert Domain Event
→ insert Pending Outbox
```

Because triggers execute in the caller's SQLite transaction, any domain rollback also removes the event and Outbox row.

---

### Task 4: Implement `DomainEventStore`

**Interfaces:**

```ts
append(input): DomainEvent
listPersonEvents({ personRef, afterSequence?, limit? }): DomainEventPage
claimOutboxBatch({ workerRef, now, claimedUntil, limit? }): OutboxDelivery[]
markPublished({ eventRef, workerRef, publishedAt }): void
markFailed({ eventRef, workerRef, error, availableAt, updatedAt }): void
```

- [x] **Add explicit atomic event append**
- [x] **Add Person-isolated ascending pagination**
- [x] **Add Pending Outbox claim leasing**
- [x] **Increment Attempt on each Claim**
- [x] **Recover expired Claims**
- [x] **Add Published transition**
- [x] **Add Failed-to-Pending transition with backoff time**
- [x] **Reject finalization by a different Worker**
- [x] **Verify database restart recovery**

CI #280 passed the full quality gate. Secret Scan #166 passed.

---

### Task 5: Verify Chat / Work / Provider integration

- [x] **Verify Home Chat, Work, Message, Conversion and Progress events**
- [x] **Verify Assistant and Provider Success events**
- [x] **Verify Provider Failure and Retry events**
- [x] **Verify identical message replay creates no duplicate Event**
- [x] **Verify successful Turn replay creates no duplicate Event**
- [x] **Verify invalid Chat → Work leaves no partial data or Event**
- [x] **Verify Payload excludes message and Provider output text**
- [x] **Verify Payload excludes External Session**

CI #281 passed the full quality gate. Secret Scan #167 passed.

---

### Task 6: Enforce active Lease finalization

- [x] **Write a regression test for expired Worker finalization**
- [x] **Observe RED**

CI #283 failed because the previous SQL checked Worker identity but not Lease expiry.

- [x] **Fix Publish and Fail state transitions**

Both updates now require:

```sql
status = 'claimed'
AND claimed_by = ?
AND claimed_until > completion_timestamp
```

- [x] **Verify GREEN**

CI #285 passed the full quality gate.

---

### Task 7: Preserve ordered Chat → Work source references

- [x] **Write a regression test requiring `sourceMessageRefs`**
- [x] **Observe RED**

CI #286 failed because the conversion event initially contained an empty array.

- [x] **Add source-message enrichment trigger**

Every `chat_work_conversion_messages` insert appends its `message_ref` to the corresponding `chat.work.created` event inside the same transaction.

- [x] **Verify GREEN**

CI #287 passed the full quality gate. Secret Scan #173 passed.

---

### Task 8: Final verification and PR boundary

- [ ] **Run a fresh final CI and Secret Scan on the documentation-complete head**
- [ ] **Confirm PR comments and Review Threads are empty or resolved**
- [ ] **Compare PR #19 paths against PR #14; intersection must be zero**
- [ ] **Confirm PR #14 Head and Draft state are unchanged**
- [ ] **Update PR #19 description and mark Ready for review**
- [ ] **Keep PR #19 unmerged**

Final commands represented by the repository quality gate:

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```
