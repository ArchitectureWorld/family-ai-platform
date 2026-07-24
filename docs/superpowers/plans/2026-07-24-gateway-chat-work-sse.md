# Gateway Chat / Work SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为正式 Chat / Work 领域提供基于 Personal Entry Session 的 SSE 实时事件流，支持历史补发、`Last-Event-ID` 恢复、心跳授权复核和慢连接隔离。

**Architecture:** 新建 `PersonEventStreamHub`，以 `domain_events` 为唯一权威来源，按 Person 共享轮询并向多个 Subscriber 分发严格升序事件。Fastify 路由在认证和 Cursor 校验完成后劫持原始响应，Hub 负责写队列、背压、心跳、授权复核和资源清理；Outbox 状态不因 SSE 消费而改变。

**Tech Stack:** TypeScript 6、Fastify 5、Node.js 22 HTTP/SSE、better-sqlite3、Vitest 4、Zod 4。

## Global Constraints

- 基线固定为 `main` commit `4bba487ce675f3b338c343185514915a25a6bb2d`。
- 路由固定为 `GET /api/v1/events/stream`。
- 只允许 `personal` Entry Session；不能接受 Device Credential 替代。
- Cursor 为排他语义，只发送 `eventSequence > cursor`。
- 默认轮询间隔 `500 ms`、心跳间隔 `15 s`、客户端重连建议 `3000 ms`。
- 单 Subscriber 队列上限为 `256` 帧或估算 `1 MiB`。
- SSE 只读取 `domain_events`，不 claim Outbox，也不调用 `markPublished()`。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`、`apps/gateway/src/entrySessionAuth.ts`、`apps/gateway/public/**`。
- 不增加正式 Member Web、Push、Device Sync Cursor 或公共 Event Contract。

---

## File Map

- Create `apps/gateway/src/eventStream.ts`: Cursor 解析、SSE 帧编码、Subscriber 写队列、Person 共享 Pump、心跳授权复核、Fastify 路由注册。
- Modify `apps/gateway/src/app.ts`: 保留 `DomainEventStore` 实例，创建 Hub，注册 SSE 路由，并在关闭数据库前关闭 Hub。
- Create `apps/gateway/test/eventStream.test.ts`: Hub、顺序、去重、共享查询、背压、队列上限、心跳和清理单元测试。
- Create `apps/gateway/test/eventStreamRoutes.test.ts`: 真实 HTTP SSE 认证、响应头、Cursor、历史补发、实时事件、Person 隔离和关闭行为测试。
- Create `docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md`: RED/GREEN 运行、审查修复、最终验证和 PR #14 隔离证据。

---

### Task 1: Cursor 与 SSE 帧边界

**Files:**
- Create: `apps/gateway/test/eventStream.test.ts`
- Create: `apps/gateway/src/eventStream.ts`

**Interfaces:**
- Produces `parseEventStreamCursor(query: unknown, lastEventId: string | string[] | undefined): number`。
- Produces `formatDomainEventFrame(event: DomainEvent): string`。
- Produces `formatConnectedFrame(reconnectMs: number): string`。
- Produces `formatHeartbeatFrame(timestamp: string): string`。

- [ ] **Step 1: Write failing Cursor and frame tests**

```ts
import { describe, expect, it } from "vitest";
import {
  formatConnectedFrame,
  formatDomainEventFrame,
  formatHeartbeatFrame,
  parseEventStreamCursor
} from "../src/eventStream.js";

it("parses exclusive cursors and rejects malformed or conflicting inputs", () => {
  expect(parseEventStreamCursor({}, undefined)).toBe(0);
  expect(parseEventStreamCursor({ afterSequence: "12" }, undefined)).toBe(12);
  expect(parseEventStreamCursor({}, "12")).toBe(12);
  expect(parseEventStreamCursor({ afterSequence: "12" }, "12")).toBe(12);
  for (const input of [
    [{ afterSequence: "-1" }, undefined],
    [{ afterSequence: "1.5" }, undefined],
    [{ unknown: "1" }, undefined],
    [{ afterSequence: "12" }, "13"]
  ] as const) {
    expect(() => parseEventStreamCursor(input[0], input[1])).toThrow("REQUEST_INVALID");
  }
});

it("formats connected, event and heartbeat frames without advancing heartbeat cursor", () => {
  expect(formatConnectedFrame(3000)).toBe("retry: 3000\n: connected\n\n");
  expect(formatHeartbeatFrame("2026-07-24T12:00:00.000Z"))
    .toBe(": heartbeat 2026-07-24T12:00:00.000Z\n\n");
  const frame = formatDomainEventFrame({
    eventRef: "event:test",
    personRef: "person:test",
    eventSequence: 7,
    eventType: "thread.message.created",
    aggregateType: "thread_message",
    aggregateRef: "message:test",
    threadRef: "thread:test",
    payload: { actorType: "person" },
    occurredAt: "2026-07-24T12:00:00.000Z",
    createdAt: "2026-07-24T12:00:00.000Z"
  });
  expect(frame).toContain("id: 7\n");
  expect(frame).toContain("event: domain-event\n");
  expect(frame).toContain("data: {");
  expect(frame.endsWith("\n\n")).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- eventStream.test.ts
```

Expected: FAIL because `../src/eventStream.js` does not exist.

- [ ] **Step 3: Implement strict parsing and frame formatting**

Use a strict Zod query object with optional decimal `afterSequence`. Convert only safe integers greater than or equal to zero. Convert `GatewayDomainError("REQUEST_INVALID", 400, "validation", false, "事件 Cursor 不正确。")` for every invalid shape or conflict. Serialize event data with one `JSON.stringify()` call so the `data:` field remains one line.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/eventStream.ts apps/gateway/test/eventStream.test.ts
git commit -m "feat(gateway): define SSE cursor and frame protocol"
```

---

### Task 2: Person 共享事件 Pump 与单连接顺序

**Files:**
- Modify: `apps/gateway/src/eventStream.ts`
- Modify: `apps/gateway/test/eventStream.test.ts`

**Interfaces:**
- Consumes `DomainEventStore.listPersonEvents()` through this narrow interface:

```ts
export interface PersonEventSource {
  listPersonEvents(input: {
    personRef: string;
    afterSequence?: number;
    limit?: number;
  }): DomainEventPage;
}
```

- Produces:

```ts
export interface EventStreamSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  end(): void;
  destroy(error?: Error): void;
}

export interface EventStreamSubscriberInput {
  personRef: string;
  cursor: number;
  entrySessionRef: string;
  token: string;
  sink: EventStreamSink;
}

export class PersonEventStreamHub {
  register(input: EventStreamSubscriberInput): () => void;
  pumpPerson(personRef: string): Promise<void>;
  pumpAll(): Promise<void>;
  subscriberCount(personRef?: string): number;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Add failing tests for ordering, exclusive cursor and shared querying**

Create a fake `PersonEventSource` that records every `listPersonEvents` call and returns pages from an in-memory array. Register two Subscribers for the same Person at cursors `0` and `2`; after one `pumpPerson`, assert:

```ts
expect(source.calls).toEqual([{ personRef: ownerPersonRef, afterSequence: 0, limit: 200 }]);
expect(firstSink.domainEventIds()).toEqual([1, 2, 3]);
expect(secondSink.domainEventIds()).toEqual([3]);
```

Register another Person and assert its events never enter the owner sinks.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- eventStream.test.ts
```

Expected: FAIL because `PersonEventStreamHub` is not implemented.

- [ ] **Step 3: Implement Person channels and serialized Pump state**

Use:

```ts
interface Subscriber {
  id: string;
  personRef: string;
  scheduledCursor: number;
  entrySessionRef: string;
  token: string;
  sink: EventStreamSink;
  closed: boolean;
  tail: Promise<void>;
  queuedFrames: number;
  queuedBytes: number;
}

interface PersonChannel {
  subscribers: Set<Subscriber>;
  runningPump: Promise<void> | null;
  pumpAgain: boolean;
}
```

`pumpPerson()` must calculate the minimum live Subscriber cursor, read pages of at most 200 events, enqueue only events newer than each Subscriber cursor, and update `scheduledCursor` at queue time. If another Pump is requested while one is running, set `pumpAgain = true` and execute another pass after the active pass finishes.

- [ ] **Step 4: Verify GREEN**

Run focused tests. Expected: PASS with one shared query sequence per Person.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/eventStream.ts apps/gateway/test/eventStream.test.ts
git commit -m "feat(gateway): add shared Person SSE event pump"
```

---

### Task 3: 背压、队列保护、心跳授权和清理

**Files:**
- Modify: `apps/gateway/src/eventStream.ts`
- Modify: `apps/gateway/test/eventStream.test.ts`

**Interfaces:**
- Consumes:

```ts
export interface EventStreamAuthenticator {
  authenticate(entrySessionRef: string, token: string): EntrySessionAuthentication;
}
```

- Extends Hub options:

```ts
export interface PersonEventStreamHubOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  reconnectMs?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  autoStart?: boolean;
  now?: () => Date;
}
```

- Produces `heartbeatAll(): Promise<void>`.

- [ ] **Step 1: Add failing backpressure and lifecycle tests**

Use a controllable fake sink whose first `write()` returns `false`. Assert a second frame is not written until the sink emits `drain`. Set `maxQueuedFrames: 2`, enqueue three events, and assert only the slow sink is destroyed while a second sink remains registered.

Add authentication outcomes:

```ts
expect(authenticator.calls).toContainEqual([entrySessionRef, token]);
expect(validSink.lastFrame()).toContain(": heartbeat ");
expect(expiredSink.destroyed).toBe(true);
expect(revokedSink.destroyed).toBe(true);
```

After `await hub.close()`, assert `subscriberCount() === 0`, all sinks ended or destroyed, and later `pumpAll()` does not read the event source.

- [ ] **Step 2: Run focused tests and verify RED**

Run the same focused command. Expected: FAIL on missing queue and heartbeat behavior.

- [ ] **Step 3: Implement per-Subscriber Promise queues**

For every queued frame:

1. increment `queuedFrames` and `queuedBytes` before chaining;
2. close the Subscriber if either limit is exceeded;
3. invoke `sink.write(frame)` inside the Subscriber's own `tail` chain;
4. if it returns `false`, await a one-shot `drain` Promise;
5. decrement queue accounting in `finally`;
6. unregister on write failure, sink error or explicit cleanup.

`heartbeatAll()` must re-authenticate every Subscriber and require `result.status === "authenticated"`, `result.context.person.personRef === subscriber.personRef`, and `result.context.audience === "personal"`. Invalid, expired or revoked credentials close the connection without writing a new HTTP error body.

- [ ] **Step 4: Implement timers without test flakiness**

When `autoStart !== false`, create one poll interval and one heartbeat interval. Poll interval calls `void pumpAll()`. Heartbeat interval calls `void heartbeatAll()`. `close()` clears both timers before closing Subscribers.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test -w @family-ai/gateway -- eventStream.test.ts
git add apps/gateway/src/eventStream.ts apps/gateway/test/eventStream.test.ts
git commit -m "feat(gateway): protect SSE streams with heartbeat and backpressure"
```

---

### Task 4: Fastify SSE 路由与 Gateway 生命周期

**Files:**
- Modify: `apps/gateway/src/eventStream.ts`
- Modify: `apps/gateway/src/app.ts`
- Create: `apps/gateway/test/eventStreamRoutes.test.ts`

**Interfaces:**
- Produces:

```ts
export function registerEventStreamRoutes(
  app: FastifyInstance,
  input: {
    hub: PersonEventStreamHub;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void;
```

- [ ] **Step 1: Write failing route authentication and Cursor tests**

Using `app.inject()` for pre-stream errors, verify:

```ts
expect(missing.statusCode).toBe(401);
expect(missing.json()).toMatchObject({ code: "ENTRY_SESSION_INVALID" });
expect(admin.statusCode).toBe(403);
expect(conflict.statusCode).toBe(400);
expect(unknownQuery.statusCode).toBe(400);
```

The error body must remain the common unwrapped `PublicError`, not the Mobile Gateway envelope.

- [ ] **Step 2: Write failing real-listener SSE header and history tests**

Start Fastify on `127.0.0.1` with port `0`, use Node 22 `fetch()` and an `AbortController`, then assert:

```ts
expect(response.status).toBe(200);
expect(response.headers.get("content-type")).toContain("text/event-stream");
expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
expect(response.headers.get("x-accel-buffering")).toBe("no");
```

Read frames until the expected event ID appears. Repeat with `Last-Event-ID` and confirm only newer events arrive.

- [ ] **Step 3: Run route tests and verify RED**

```bash
npm run test -w @family-ai/gateway -- eventStreamRoutes.test.ts
```

Expected: FAIL because the route is not registered.

- [ ] **Step 4: Implement route registration**

Route sequence:

```ts
const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
const cursor = parseEventStreamCursor(request.query, request.headers["last-event-id"]);
const entrySessionRef = String(request.headers["x-entry-session-ref"]);
const token = String(request.headers.authorization).slice("Bearer ".length).trim();
reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
reply.raw.setHeader("Connection", "keep-alive");
reply.raw.setHeader("X-Accel-Buffering", "no");
reply.hijack();
reply.raw.flushHeaders();
const unregister = input.hub.register({
  personRef: context.person.personRef,
  cursor,
  entrySessionRef,
  token,
  sink: reply.raw
});
```

Install one idempotent cleanup callback on request abort/close and response close/error.

- [ ] **Step 5: Integrate in `buildGatewayApp()`**

Replace the discarded event store construction with:

```ts
const domainEventStore = new DomainEventStore(db, now);
const eventStreamHub = new PersonEventStreamHub(
  domainEventStore,
  entryAuthenticator,
  { now }
);
```

Create the Hub after `EntrySessionAuthenticator` exists, register `registerEventStreamRoutes`, classify `/api/v1/events/stream` as a common Chat/Work `PublicError` path, and change `onClose` to:

```ts
app.addHook("onClose", async () => {
  await eventStreamHub.close();
  db.close();
});
```

- [ ] **Step 6: Verify route tests and existing error-envelope tests**

```bash
npm run test -w @family-ai/gateway -- eventStreamRoutes.test.ts chatWorkRoutesErrorEnvelope.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/eventStream.ts apps/gateway/test/eventStreamRoutes.test.ts
git commit -m "feat(gateway): expose authenticated SSE event stream"
```

---

### Task 5: 实时 Chat / Assistant 事件、Person 隔离与 Outbox 边界

**Files:**
- Modify: `apps/gateway/test/eventStreamRoutes.test.ts`
- Modify: `apps/gateway/test/eventStream.test.ts` only if a unit-level race regression is needed

- [ ] **Step 1: Add failing live event tests**

Keep one authenticated SSE request open, then through existing HTTP routes:

1. create/open Home Chat;
2. send one Person message;
3. allow Fake Provider to create the Assistant reply;
4. read SSE until both `thread.message.created` events and `thread.provider_turn.succeeded` arrive.

Assert event IDs are strictly increasing and the event JSON contains neither Person text nor Fake Provider output.

- [ ] **Step 2: Add Person isolation test**

Create a second Person and Personal Entry. Open two streams. Generate owner events and second-person events, then assert each stream contains only its authenticated `personRef`.

- [ ] **Step 3: Add Outbox non-completion test**

After the SSE client receives events, query SQLite and assert the corresponding rows remain:

```sql
status = 'pending'
published_at IS NULL
```

SSE receipt must never call `markPublished()`.

- [ ] **Step 4: Add disconnect and shutdown test**

Abort a client and wait until `hub.subscriberCount()` reaches zero through an injected test hook or direct Hub unit test. Close the Fastify app while a stream is open and assert the response closes without hanging and no timer accesses the closed database.

- [ ] **Step 5: Run tests and verify RED, then make only minimal implementation fixes**

```bash
npm run test -w @family-ai/gateway -- eventStream.test.ts eventStreamRoutes.test.ts
```

Expected initial RED if any race, cleanup or security boundary is missing. Fix the smallest production behavior necessary, then rerun until GREEN.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/eventStream.ts apps/gateway/src/app.ts apps/gateway/test/eventStream.test.ts apps/gateway/test/eventStreamRoutes.test.ts
git commit -m "test(gateway): verify live SSE delivery and isolation"
```

---

### Task 6: 全仓验证、证据和 PR #14 隔离审查

**Files:**
- Create: `docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md`
- Modify: `docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md` only to mark implementation status and document approved deviations, if any

- [ ] **Step 1: Run focused Gateway checks**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
```

Expected: every command exits `0`.

- [ ] **Step 2: Run the full repository quality gate**

```bash
npm run check
```

Expected: all workspace tests, static checks, typechecks and builds pass.

- [ ] **Step 3: Inspect changed paths against PR #14**

Expected SSE PR paths are limited to:

```text
apps/gateway/src/app.ts
apps/gateway/src/eventStream.ts
apps/gateway/test/eventStream.test.ts
apps/gateway/test/eventStreamRoutes.test.ts
docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md
docs/superpowers/plans/2026-07-24-gateway-chat-work-sse.md
docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md
```

Compare against PR #14's `.github/workflows/ios-ci.yml` and `clients/ios/**`; the intersection must be empty.

- [ ] **Step 4: Write evidence**

Record every observed RED/GREEN run, final head SHA, CI and Secret Scan run numbers, route/security coverage, Outbox non-completion, PR comments/review threads and PR #14 status.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/superpowers/evidence/2026-07-24-gateway-chat-work-sse.md docs/superpowers/specs/2026-07-24-gateway-chat-work-sse-design.md
git commit -m "docs: record Chat Work SSE verification"
```

- [ ] **Step 6: Create or update the PR as Draft during RED cycles, then mark Ready only after fresh CI and Secret Scan success**

PR title:

```text
feat(gateway): stream Chat Work events over SSE
```

The PR body must explicitly state that Device Sync Cursor, Member Web, Push, iOS integration and Outbox publishing are deferred.
