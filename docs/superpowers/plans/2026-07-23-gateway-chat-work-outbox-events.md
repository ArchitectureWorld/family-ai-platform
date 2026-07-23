# Gateway Chat / Work Outbox Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为正式 Chat / Work 领域增加 Transactional Outbox、Person 级持久化事件序列和可租约投递状态，为后续 SSE 与 Sync Cursor 提供可靠底座。

**Architecture:** Migration V6 新增 `person_event_sequences`、`domain_events` 和 `outbox_events`。统一 `DomainEventStore` 在领域 Repository 的原事务中写入事件和 Outbox；Gateway 注入共享实例，但本 PR 不开放 HTTP/SSE。

**Tech Stack:** TypeScript 6、Fastify、better-sqlite3、Vitest 4、Zod 4。

## Global Constraints

- 基线固定为 `main` commit `97adaa08bb0b015e7a9b8ade3a43e55aab282238`。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`。
- 不修改 Mobile Entry 配对、Session、认证和浏览器验收台。
- 领域数据与对应 event/outbox 必须同事务提交或回滚。
- Event payload 不得包含消息正文、Token、Credential 或 Provider External Session。
- 行为变更必须先提交失败测试并观察 RED，再提交最小 GREEN。

---

## File Map

- Modify: `apps/gateway/src/database.ts` — Migration V6。
- Create: `apps/gateway/src/domainEvents.ts` — event/outbox persistence and lease state。
- Modify: `apps/gateway/src/chatWorkDomain.ts` — domain mutation events。
- Modify: `apps/gateway/src/chatWorkProvider.ts` — Provider success/failure events。
- Modify: `apps/gateway/src/app.ts` — shared `DomainEventStore` injection。
- Modify: `apps/gateway/test/database.test.ts` — V6 schema tests。
- Create: `apps/gateway/test/domainEvents.test.ts` — sequence, paging, lease, restart tests。
- Create: `apps/gateway/test/chatWorkEvents.test.ts` — Chat/Work/Provider integration and rollback tests。

---

### Task 1: Migration V6

**Files:**
- Modify: `apps/gateway/test/database.test.ts`
- Modify: `apps/gateway/src/database.ts`

- [ ] **Step 1: Write failing migration test**

Update expected ledger to versions 1–6 and assert exact columns for:

```text
person_event_sequences
domain_events
outbox_events
```

Also assert indexes:

```text
domain_events_person_sequence_idx
outbox_events_dispatch_idx
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test -w @family-ai/gateway -- database.test.ts
```

Expected: ledger contains only 1–5 and V6 tables are absent.

- [ ] **Step 3: Implement Migration V6**

Add tables and state checks from the approved design. Advance migration bounds and final version from 5 to 6.

- [ ] **Step 4: Run GREEN and full check**

```bash
npm run test -w @family-ai/gateway -- database.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/database.ts apps/gateway/test/database.test.ts
git commit -m "feat(gateway): add durable domain event schema"
```

---

### Task 2: `DomainEventStore`

**Files:**
- Create: `apps/gateway/src/domainEvents.ts`
- Create: `apps/gateway/test/domainEvents.test.ts`

**Interfaces:**

```ts
export interface DomainEvent {
  eventRef: string;
  personRef: string;
  eventSequence: number;
  eventType: string;
  aggregateType: string;
  aggregateRef: string;
  threadRef: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface DomainEventPage {
  events: DomainEvent[];
  nextAfterSequence: number | null;
}

export interface OutboxDelivery {
  event: DomainEvent;
  attemptCount: number;
  claimedBy: string;
  claimedUntil: string;
}
```

Methods:

```ts
append(input): DomainEvent
listPersonEvents({ personRef, afterSequence?, limit? }): DomainEventPage
claimOutboxBatch({ workerRef, now, claimedUntil, limit? }): OutboxDelivery[]
markPublished({ eventRef, workerRef, publishedAt }): void
markFailed({ eventRef, workerRef, error, availableAt, updatedAt }): void
```

- [ ] **Step 1: Write failing tests**

Cover:

- per-Person monotonic sequence;
- event + pending outbox written together;
- pagination and isolation;
- claim lease and attempt increment;
- expired claim recovery;
- published transition;
- failed transition to pending;
- restart persistence;
- invalid worker cannot finalize another worker's claim.

- [ ] **Step 2: Run RED**

Expected: module not found.

- [ ] **Step 3: Implement minimal store**

Key append transaction:

```ts
const append = db.transaction(() => {
  const sequence = db.prepare(`
    INSERT INTO person_event_sequences(person_ref, last_sequence, updated_at)
    VALUES(?, 1, ?)
    ON CONFLICT(person_ref) DO UPDATE SET
      last_sequence = last_sequence + 1,
      updated_at = excluded.updated_at
    RETURNING last_sequence
  `).get(personRef, createdAt);

  // INSERT domain_events
  // INSERT outbox_events status=pending
});
```

Claim must run in one transaction, reclaim expired leases first, then select and claim ordered pending rows.

- [ ] **Step 4: Run GREEN and full check**

```bash
npm run test -w @family-ai/gateway -- domainEvents.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/domainEvents.ts apps/gateway/test/domainEvents.test.ts
git commit -m "feat(gateway): add transactional outbox store"
```

---

### Task 3: Chat / Work domain events

**Files:**
- Modify: `apps/gateway/src/chatWorkDomain.ts`
- Modify: `apps/gateway/src/app.ts`
- Create: `apps/gateway/test/chatWorkEvents.test.ts`

**Constructor:**

```ts
constructor(
  db: GatewayDatabase,
  now: () => Date = () => new Date(),
  eventStore: DomainEventStore = new DomainEventStore(db, now)
)
```

- [ ] **Step 1: Write failing integration tests**

Cover:

- Home Chat emits `chat.home.created` once;
- Work creation emits `work.created`;
- Person message emits `thread.message.created` once and excludes text;
- identical message retry does not emit a duplicate event;
- Chat → Work emits one `work.created` plus one `chat.work.created`;
- invalid conversion emits neither Work nor events;
- Work progress emits `work.progress.updated`.

- [ ] **Step 2: Run RED**

Expected: event list remains empty.

- [ ] **Step 3: Inject store and append events inside existing transactions**

Use `occurredAt` from the domain fact and `createdAt` from the Repository clock. Do not move Provider or network work into transactions.

- [ ] **Step 4: Run GREEN and full check**

```bash
npm run test -w @family-ai/gateway -- chatWorkEvents.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/chatWorkDomain.ts apps/gateway/test/chatWorkEvents.test.ts
git commit -m "feat(gateway): emit Chat Work domain events"
```

---

### Task 4: Provider Turn events

**Files:**
- Modify: `apps/gateway/src/chatWorkProvider.ts`
- Modify: `apps/gateway/test/chatWorkEvents.test.ts`

- [ ] **Step 1: Add failing tests**

Cover:

- failed Turn emits `thread.provider_turn.failed` in same transaction;
- success emits Assistant `thread.message.created` plus `thread.provider_turn.succeeded`;
- successful replay emits no duplicates;
- Context-change success rollback leaves no Assistant message and no success events;
- event payload excludes External Session and output text.

- [ ] **Step 2: Run RED**

Expected: Provider events absent.

- [ ] **Step 3: Implement event appends**

`markTurnFailed()` must read Thread owner and attempt count, then update Turn and append event inside one transaction.

`commitTurnSucceeded()` must append both success events after Assistant insertion but before transaction completion.

- [ ] **Step 4: Run GREEN and full check**

```bash
npm run test -w @family-ai/gateway -- chatWorkEvents.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/chatWorkProvider.ts apps/gateway/test/chatWorkEvents.test.ts
git commit -m "feat(gateway): emit Provider Turn events"
```

---

### Task 5: Final review and PR boundary

- [ ] **Step 1: Run complete verification**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

- [ ] **Step 2: Review event payloads for secrets**

Confirm no payload contains:

```text
token
credential
externalSessionRef
content.text
Authorization
```

- [ ] **Step 3: Compare changed paths with PR #14**

Expected intersection: zero.

- [ ] **Step 4: Update PR description and mark Ready only after CI + Secret Scan pass**

- [ ] **Step 5: Keep unmerged for review**
