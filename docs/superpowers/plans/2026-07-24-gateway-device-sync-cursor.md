# Gateway Device Sync Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个受控 `Device + Person` 建立持久化、可恢复、单调前进的同步 Cursor，并提供显式事件补拉与累计 ACK API。

**Architecture:** `DomainEventStore` 继续作为 Person Event Log 的唯一查询权威，并把独立事件 Schema 从 V1 增量迁移到 V2。新 `DeviceSyncRepository` 只负责设备同步位置与 ACK 事务；新 `registerDeviceSyncRoutes` 使用 Personal Entry Session 解析可信 Device 与 Person，提供 `GET /api/v1/sync/events` 和 `POST /api/v1/sync/ack`。SSE 继续只负责快速通知，绝不自动推进持久化 Cursor。

**Tech Stack:** TypeScript 6、Fastify 5、better-sqlite3、SQLite transactions / foreign keys、Zod 4、Vitest 4、Node.js 22。

## Global Constraints

- 基线固定为 `main` commit `90fdd8f0fa42b5488f15186ef1c7d4f9fd90cf1d`。
- 持久化主键固定为 `(device_ref, person_ref)`，不使用 Entry Session、Entry Binding、标签页或 SSE Connection。
- 正式接口固定为 `GET /api/v1/sync/events` 与 `POST /api/v1/sync/ack`。
- 只允许 `personal` Entry Session；Device Credential 不能替代 Personal Entry 认证。
- 客户端不得提交可信 `deviceRef`、`personRef`、`entryBindingRef` 或 `entrySessionRef`。
- `afterSequence` 为排他 Cursor；`limit` 默认 100、最大 200。
- GET 补拉无论成功、失败或返回空列表，都不能创建或推进 Cursor。
- ACK 必须同时验证当前 Person 的 `eventRef + eventSequence`，并使用累计、幂等、永不回退语义。
- 相同或更小 ACK 不更新 `updated_at`；只有持久值实际增加时 `advanced = true`。
- SSE 写入 Socket、SSE 客户端收到事件、GET 返回事件均不自动 ACK。
- 事件子系统 Schema 从 V1 增量迁移到 V2；不增加 Gateway Core Migration V6。
- 不修改 `clients/ios/**`、`.github/workflows/**`、`packages/contracts/**`、`apps/gateway/public/**`、`apps/gateway/src/mobilePairing.ts`、`apps/gateway/src/mobileRoutes.ts` 或 `apps/gateway/src/entrySessionAuth.ts`。
- 浏览器“小白一键验收台”保持原职责。

---

## File Map

- Modify `apps/gateway/src/domainEvents.ts`: 把事件 Schema 安装拆成 V1/V2 增量迁移；增加最新 Person Sequence 与精确 Event 查找。
- Create `apps/gateway/src/deviceSync.ts`: 保存和读取 `(deviceRef, personRef)` Cursor；实现 ACK 身份校验、单调推进与完整性检查。
- Create `apps/gateway/src/deviceSyncRoutes.ts`: 严格解析补拉 Query 和 ACK Body，认证 Personal Entry，返回通用 PublicError。
- Modify `apps/gateway/src/app.ts`: 创建并注入 `DeviceSyncRepository`，注册 Sync 路由，将 `/api/v1/sync/**` 分类为 Chat / Work 通用错误协议。
- Create `apps/gateway/test/deviceSync.test.ts`: 事件 Schema V2、Repository、ACK、重启与并发顺序测试。
- Create `apps/gateway/test/deviceSyncRoutes.test.ts`: GET/ACK HTTP 行为、分页、strict validation 与默认 Cursor 测试。
- Create `apps/gateway/test/deviceSyncSecurity.test.ts`: Session 续期、logout、新设备、撤销、跨 Person / Device、SSE 非自动 ACK 测试。
- Create `docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md`: RED/GREEN、最终门禁和 PR #14 隔离证据。

---

### Task 1: Domain Event Schema V2 与查询原语

**Files:**
- Modify: `apps/gateway/src/domainEvents.ts`
- Create: `apps/gateway/test/deviceSync.test.ts`

**Interfaces:**
- Produces `DOMAIN_EVENT_SCHEMA_VERSION = 2`。
- Produces `DomainEventStore.getLatestPersonSequence(personRef: string): number`。
- Produces `DomainEventStore.findPersonEvent(input: { personRef: string; eventSequence: number; eventRef: string }): DomainEvent | null`。
- Produces SQLite table `device_sync_cursors` with primary key `(device_ref, person_ref)`。

- [ ] **Step 1: Write failing migration and query tests**

Create `apps/gateway/test/deviceSync.test.ts` with a real temporary SQLite database and this initial behavior:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

let directory = "";
let databasePath = "";
let db: GatewayDatabase;
let events: DomainEventStore;
let ownerPersonRef = "";
let adultPersonRef = "";
let ownerDeviceRef = "";
let now = new Date("2026-07-24T16:00:00.000Z");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-"));
  databasePath = join(directory, "gateway.sqlite");
  db = openGatewayDatabase(databasePath);
  const family = new FamilyDomainRepository(db);
  const onboarding = family.initializeFamily({
    familyName: "测试家庭",
    ownerName: "家庭创建者",
    deviceName: "测试电脑",
    deviceCredential: "device-sync-test-credential-with-enough-length"
  });
  ownerPersonRef = onboarding.owner.personRef;
  ownerDeviceRef = onboarding.device.deviceRef;
  adultPersonRef = family.createMember({
    familyRef: onboarding.family.familyRef,
    displayName: "另一位成人",
    familyRole: "adult"
  }).personRef;
  events = new DomainEventStore(db, () => now);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
```

Add these assertions:

```ts
it("installs Domain Event migrations V1 and V2 and creates the Device Cursor table", () => {
  expect(db.prepare(
    "SELECT version FROM domain_event_schema_migrations ORDER BY version"
  ).all()).toEqual([{ version: 1 }, { version: 2 }]);
  expect(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_sync_cursors'"
  ).get()).toEqual({ name: "device_sync_cursors" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it("returns latest Person sequence and resolves only an exact Person event identity", () => {
  const first = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.first",
    aggregateType: "work",
    aggregateRef: "work:sync-first",
    payload: {},
    occurredAt: now.toISOString()
  });
  const second = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.second",
    aggregateType: "work",
    aggregateRef: "work:sync-second",
    payload: {},
    occurredAt: now.toISOString()
  });
  const hidden = events.append({
    personRef: adultPersonRef,
    eventType: "test.sync.hidden",
    aggregateType: "work",
    aggregateRef: "work:sync-hidden",
    payload: {},
    occurredAt: now.toISOString()
  });

  expect(events.getLatestPersonSequence(ownerPersonRef)).toBe(2);
  expect(events.getLatestPersonSequence("person:no-events")).toBe(0);
  expect(events.findPersonEvent({
    personRef: ownerPersonRef,
    eventSequence: second.eventSequence,
    eventRef: second.eventRef
  })).toEqual(second);
  expect(events.findPersonEvent({
    personRef: ownerPersonRef,
    eventSequence: hidden.eventSequence,
    eventRef: hidden.eventRef
  })).toBeNull();
  expect(first.eventSequence).toBe(1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @family-ai/gateway -- deviceSync.test.ts
```

Expected: FAIL because Event Schema V2, `getLatestPersonSequence()` and `findPersonEvent()` do not exist.

- [ ] **Step 3: Split the event schema into a ledger plus V1/V2 migrations**

In `apps/gateway/src/domainEvents.ts`, retain the existing V1 SQL unchanged except for moving the migration ledger into its own constant, then add:

```ts
export const DOMAIN_EVENT_SCHEMA_VERSION = 2 as const;

const DOMAIN_EVENT_SCHEMA_LEDGER = `
CREATE TABLE IF NOT EXISTS domain_event_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const DOMAIN_EVENT_MIGRATION_V2 = `
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
`;
```

Replace the one-shot installation with exact incremental logic:

```ts
private installSchema(): void {
  const coreVersion = this.db.prepare(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  ).get() as { version: number } | undefined;
  if (coreVersion?.version !== 5) {
    throw new Error(
      `Domain Event schema requires Gateway schema version 5, got ${String(coreVersion?.version)}`
    );
  }

  this.db.transaction(() => {
    this.db.exec(DOMAIN_EVENT_SCHEMA_LEDGER);
    let latest = (this.db.prepare(
      "SELECT version FROM domain_event_schema_migrations ORDER BY version DESC LIMIT 1"
    ).get() as { version: number } | undefined)?.version ?? 0;

    if (latest > DOMAIN_EVENT_SCHEMA_VERSION || latest < 0) {
      throw new Error(`Unsupported Domain Event schema version: ${latest}`);
    }
    if (latest === 0) {
      this.db.exec(DOMAIN_EVENT_MIGRATION_V1);
      this.db.prepare(
        "INSERT INTO domain_event_schema_migrations(version, applied_at) VALUES(1, ?)"
      ).run(this.now().toISOString());
      latest = 1;
    }
    if (latest === 1) {
      this.db.exec(DOMAIN_EVENT_MIGRATION_V2);
      this.db.prepare(
        "INSERT INTO domain_event_schema_migrations(version, applied_at) VALUES(2, ?)"
      ).run(this.now().toISOString());
      latest = 2;
    }
    if (latest !== DOMAIN_EVENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported Domain Event schema version: ${latest}`);
    }
  })();
}
```

- [ ] **Step 4: Add the exact event lookup methods**

```ts
getLatestPersonSequence(personRef: string): number {
  const row = this.db.prepare(
    `SELECT COALESCE(MAX(event_sequence), 0) AS latest_sequence
     FROM domain_events WHERE person_ref = ?`
  ).get(personRef) as { latest_sequence: number };
  return Number(row.latest_sequence);
}

findPersonEvent(input: {
  personRef: string;
  eventSequence: number;
  eventRef: string;
}): DomainEvent | null {
  const row = this.db.prepare(
    `SELECT * FROM domain_events
     WHERE person_ref = ? AND event_sequence = ? AND event_ref = ?`
  ).get(input.personRef, input.eventSequence, input.eventRef) as
    | Record<string, unknown>
    | undefined;
  return row ? mapEvent(row) : null;
}
```

- [ ] **Step 5: Add an incremental-upgrade regression**

In the same test file, create an event, then simulate an existing V1 installation without deleting event data:

```ts
it("upgrades an existing Event Schema V1 database without rewriting events", () => {
  const existing = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.upgrade",
    aggregateType: "work",
    aggregateRef: "work:sync-upgrade",
    payload: { preserved: true },
    occurredAt: now.toISOString()
  });

  db.exec("DROP TABLE device_sync_cursors");
  db.prepare("DELETE FROM domain_event_schema_migrations WHERE version = 2").run();
  db.close();

  db = openGatewayDatabase(databasePath);
  events = new DomainEventStore(db, () => new Date("2026-07-24T16:05:00.000Z"));

  expect(db.prepare(
    "SELECT version FROM domain_event_schema_migrations ORDER BY version"
  ).all()).toEqual([{ version: 1 }, { version: 2 }]);
  expect(events.findPersonEvent({
    personRef: ownerPersonRef,
    eventSequence: existing.eventSequence,
    eventRef: existing.eventRef
  })).toEqual(existing);
});
```

- [ ] **Step 6: Verify GREEN and commit**

```bash
npm run test -w @family-ai/gateway -- deviceSync.test.ts domainEvents.test.ts
git add apps/gateway/src/domainEvents.ts apps/gateway/test/deviceSync.test.ts
git commit -m "feat(gateway): add Device Sync event schema"
```

Expected: all focused tests PASS.

---

### Task 2: DeviceSyncRepository 与单调 ACK

**Files:**
- Create: `apps/gateway/src/deviceSync.ts`
- Modify: `apps/gateway/test/deviceSync.test.ts`

**Interfaces:**
- Consumes `GatewayDatabase` and `DomainEventStore.findPersonEvent()` / `getLatestPersonSequence()`。
- Produces `DeviceSyncRepository.readCursor(input)`。
- Produces `DeviceSyncRepository.acknowledge(input)`。

- [ ] **Step 1: Add failing Repository tests**

Add tests for missing state, lazy creation, idempotency, no rollback, advancement, cross-Person rejection, restart and integrity corruption:

```ts
it("treats a missing Cursor as zero without creating a row", () => {
  const sync = new DeviceSyncRepository(db, events, () => now);
  expect(sync.readCursor({ deviceRef: ownerDeviceRef, personRef: ownerPersonRef }))
    .toMatchObject({ acknowledgedSequence: 0, latestSequence: 0, updatedAt: null });
  expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
    .toEqual({ count: 0 });
});

it("creates, replays and advances one Device + Person Cursor monotonically", () => {
  const first = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.ack.first",
    aggregateType: "work",
    aggregateRef: "work:sync-ack-first",
    payload: {},
    occurredAt: now.toISOString()
  });
  const second = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.ack.second",
    aggregateType: "work",
    aggregateRef: "work:sync-ack-second",
    payload: {},
    occurredAt: now.toISOString()
  });
  const sync = new DeviceSyncRepository(db, events, () => now);

  const created = sync.acknowledge({
    deviceRef: ownerDeviceRef,
    personRef: ownerPersonRef,
    eventSequence: first.eventSequence,
    eventRef: first.eventRef
  });
  expect(created).toMatchObject({
    previousSequence: 0,
    acknowledgedSequence: 1,
    advanced: true
  });

  const originalUpdatedAt = created?.updatedAt;
  now = new Date("2026-07-24T16:01:00.000Z");
  expect(sync.acknowledge({
    deviceRef: ownerDeviceRef,
    personRef: ownerPersonRef,
    eventSequence: first.eventSequence,
    eventRef: first.eventRef
  })).toMatchObject({
    previousSequence: 1,
    acknowledgedSequence: 1,
    advanced: false,
    updatedAt: originalUpdatedAt
  });

  expect(sync.acknowledge({
    deviceRef: ownerDeviceRef,
    personRef: ownerPersonRef,
    eventSequence: second.eventSequence,
    eventRef: second.eventRef
  })).toMatchObject({
    previousSequence: 1,
    acknowledgedSequence: 2,
    advanced: true,
    updatedAt: "2026-07-24T16:01:00.000Z"
  });
});
```

Add an invalid identity test:

```ts
it("rejects mismatched or cross-Person events without mutating the Cursor", () => {
  const ownerEvent = events.append({
    personRef: ownerPersonRef,
    eventType: "test.sync.owner",
    aggregateType: "work",
    aggregateRef: "work:sync-owner",
    payload: {},
    occurredAt: now.toISOString()
  });
  const adultEvent = events.append({
    personRef: adultPersonRef,
    eventType: "test.sync.adult",
    aggregateType: "work",
    aggregateRef: "work:sync-adult",
    payload: {},
    occurredAt: now.toISOString()
  });
  const sync = new DeviceSyncRepository(db, events, () => now);

  expect(sync.acknowledge({
    deviceRef: ownerDeviceRef,
    personRef: ownerPersonRef,
    eventSequence: adultEvent.eventSequence,
    eventRef: adultEvent.eventRef
  })).toBeNull();
  expect(sync.acknowledge({
    deviceRef: ownerDeviceRef,
    personRef: ownerPersonRef,
    eventSequence: ownerEvent.eventSequence,
    eventRef: adultEvent.eventRef
  })).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
    .toEqual({ count: 0 });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm run test -w @family-ai/gateway -- deviceSync.test.ts
```

Expected: FAIL because `DeviceSyncRepository` does not exist.

- [ ] **Step 3: Implement the focused Repository**

Create `apps/gateway/src/deviceSync.ts`:

```ts
import type { GatewayDatabase } from "./database.js";
import type { DomainEventStore } from "./domainEvents.js";

export interface DeviceSyncCursorState {
  deviceRef: string;
  personRef: string;
  acknowledgedSequence: number;
  latestSequence: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeviceSyncAcknowledgement {
  deviceRef: string;
  personRef: string;
  previousSequence: number;
  acknowledgedSequence: number;
  advanced: boolean;
  updatedAt: string;
}

export class DeviceSyncRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly events: DomainEventStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  readCursor(input: { deviceRef: string; personRef: string }): DeviceSyncCursorState {
    const row = this.db.prepare(
      `SELECT acknowledged_sequence, created_at, updated_at
       FROM device_sync_cursors WHERE device_ref = ? AND person_ref = ?`
    ).get(input.deviceRef, input.personRef) as
      | { acknowledged_sequence: number; created_at: string; updated_at: string }
      | undefined;
    const acknowledgedSequence = row ? Number(row.acknowledged_sequence) : 0;
    const latestSequence = this.events.getLatestPersonSequence(input.personRef);
    if (acknowledgedSequence > latestSequence) {
      throw new Error("DEVICE_SYNC_CURSOR_AHEAD_OF_EVENT_LOG");
    }
    return {
      deviceRef: input.deviceRef,
      personRef: input.personRef,
      acknowledgedSequence,
      latestSequence,
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null
    };
  }

  acknowledge(input: {
    deviceRef: string;
    personRef: string;
    eventSequence: number;
    eventRef: string;
  }): DeviceSyncAcknowledgement | null {
    return this.db.transaction(() => {
      const current = this.readCursor({
        deviceRef: input.deviceRef,
        personRef: input.personRef
      });
      const event = this.events.findPersonEvent({
        personRef: input.personRef,
        eventSequence: input.eventSequence,
        eventRef: input.eventRef
      });
      if (!event) return null;

      if (input.eventSequence <= current.acknowledgedSequence) {
        if (!current.updatedAt) throw new Error("DEVICE_SYNC_CURSOR_STATE_INVALID");
        return {
          deviceRef: input.deviceRef,
          personRef: input.personRef,
          previousSequence: current.acknowledgedSequence,
          acknowledgedSequence: current.acknowledgedSequence,
          advanced: false,
          updatedAt: current.updatedAt
        };
      }

      const updatedAt = this.now().toISOString();
      if (current.createdAt === null) {
        this.db.prepare(
          `INSERT INTO device_sync_cursors(
             device_ref, person_ref, acknowledged_sequence, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?)`
        ).run(
          input.deviceRef,
          input.personRef,
          input.eventSequence,
          updatedAt,
          updatedAt
        );
      } else {
        this.db.prepare(
          `UPDATE device_sync_cursors
           SET acknowledged_sequence = ?, updated_at = ?
           WHERE device_ref = ? AND person_ref = ? AND acknowledged_sequence < ?`
        ).run(
          input.eventSequence,
          updatedAt,
          input.deviceRef,
          input.personRef,
          input.eventSequence
        );
      }
      return {
        deviceRef: input.deviceRef,
        personRef: input.personRef,
        previousSequence: current.acknowledgedSequence,
        acknowledgedSequence: input.eventSequence,
        advanced: true,
        updatedAt
      };
    })();
  }
}
```

- [ ] **Step 4: Add restart and no-rollback regressions**

Close and reopen SQLite after ACK and verify `readCursor()` returns the same sequence. ACK a larger event and then a smaller valid event; final storage must remain at the larger sequence and retain its `updated_at`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test -w @family-ai/gateway -- deviceSync.test.ts
git add apps/gateway/src/deviceSync.ts apps/gateway/test/deviceSync.test.ts
git commit -m "feat(gateway): persist monotonic Device Sync cursors"
```

---

### Task 3: 显式事件补拉 HTTP API

**Files:**
- Create: `apps/gateway/src/deviceSyncRoutes.ts`
- Create: `apps/gateway/test/deviceSyncRoutes.test.ts`
- Modify: `apps/gateway/src/app.ts`

**Interfaces:**
- Consumes `DeviceSyncRepository.readCursor()` and `DomainEventStore.listPersonEvents()`。
- Produces `registerDeviceSyncRoutes(app, { repository, events, entryAuthenticator })`。
- Produces `GET /api/v1/sync/events`。

- [ ] **Step 1: Write failing GET route tests**

Use `buildGatewayApp()` with onboarding fixtures. Verify:

```ts
const response = await app.inject({
  method: "GET",
  url: "/api/v1/sync/events",
  headers: entryHeaders(personal)
});
expect(response.statusCode).toBe(200);
expect(response.json()).toMatchObject({
  protocolVersion: 1,
  sync: {
    deviceRef: onboarding.device.deviceRef,
    personRef: onboarding.owner.personRef,
    acknowledgedSequence: 0,
    requestedAfterSequence: 0,
    latestSequence: 1
  },
  nextAfterSequence: null
});
```

Create an ACK row through the Repository, then assert a GET without `afterSequence` starts after the persisted value. Assert `?afterSequence=0` safely replays older events but does not change storage.

Strict validation table:

```ts
for (const url of [
  "/api/v1/sync/events?afterSequence=-1",
  "/api/v1/sync/events?afterSequence=1.5",
  "/api/v1/sync/events?afterSequence=9007199254740992",
  "/api/v1/sync/events?limit=0",
  "/api/v1/sync/events?limit=201",
  "/api/v1/sync/events?unknown=1",
  "/api/v1/sync/events?limit=1&limit=2"
]) {
  const invalid = await app.inject({ method: "GET", url, headers: entryHeaders(personal) });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ code: "REQUEST_INVALID" });
}
```

- [ ] **Step 2: Run route tests and verify RED**

```bash
npm run test -w @family-ai/gateway -- deviceSyncRoutes.test.ts
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement strict query parsing and GET response**

Create `apps/gateway/src/deviceSyncRoutes.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import { CHAT_WORK_PROTOCOL_VERSION } from "@family-ai/contracts";
import { z } from "zod";
import type { DeviceSyncRepository } from "./deviceSync.js";
import type { DomainEventStore } from "./domainEvents.js";
import {
  requireEntryRequest,
  type EntrySessionAuthenticator
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

const decimalSchema = z.string().regex(/^\d+$/);
const syncEventsQuerySchema = z.object({
  afterSequence: decimalSchema.optional(),
  limit: decimalSchema.optional()
}).strict();

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function safeInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest("同步参数不正确。");
  }
  return parsed;
}
```

Register GET:

```ts
app.get("/api/v1/sync/events", async (request) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const parsed = syncEventsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw invalidRequest("同步参数不正确。");

  const state = input.repository.readCursor({
    deviceRef: context.device.deviceRef,
    personRef: context.person.personRef
  });
  const requestedAfterSequence = parsed.data.afterSequence === undefined
    ? state.acknowledgedSequence
    : safeInteger(parsed.data.afterSequence, 0, Number.MAX_SAFE_INTEGER);
  const limit = parsed.data.limit === undefined
    ? 100
    : safeInteger(parsed.data.limit, 1, 200);
  const page = input.events.listPersonEvents({
    personRef: context.person.personRef,
    afterSequence: requestedAfterSequence,
    limit
  });

  return {
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    sync: {
      deviceRef: context.device.deviceRef,
      personRef: context.person.personRef,
      acknowledgedSequence: state.acknowledgedSequence,
      requestedAfterSequence,
      latestSequence: state.latestSequence
    },
    events: page.events,
    nextAfterSequence: page.nextAfterSequence
  };
});
```

- [ ] **Step 4: Wire the Repository and route into `buildGatewayApp()`**

After `DomainEventStore` and `EntrySessionAuthenticator` exist:

```ts
const deviceSyncRepository = new DeviceSyncRepository(db, domainEventStore, now);
```

Register:

```ts
registerDeviceSyncRoutes(app, {
  repository: deviceSyncRepository,
  events: domainEventStore,
  entryAuthenticator
});
```

Do not add a shutdown hook; the Repository has no timers.

- [ ] **Step 5: Add 205-event pagination and GET non-mutation tests**

Append 205 events for the authenticated Person through a second SQLite connection, request `limit=200`, assert sequences 1–200 and `nextAfterSequence = 200`; request the next page and assert 201–205. Query `device_sync_cursors` before and after both GETs and confirm the row count and values are unchanged.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npm run test -w @family-ai/gateway -- deviceSyncRoutes.test.ts
git add apps/gateway/src/deviceSyncRoutes.ts apps/gateway/src/app.ts apps/gateway/test/deviceSyncRoutes.test.ts
git commit -m "feat(gateway): expose Device Sync event catch-up"
```

---

### Task 4: 累计 ACK API 与 PublicError 边界

**Files:**
- Modify: `apps/gateway/src/deviceSyncRoutes.ts`
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/deviceSyncRoutes.test.ts`

**Interfaces:**
- Consumes `DeviceSyncRepository.acknowledge()`。
- Produces `POST /api/v1/sync/ack`。
- Produces `SYNC_EVENT_NOT_FOUND` as unwrapped PublicError。

- [ ] **Step 1: Add failing ACK route tests**

Valid request:

```ts
const ack = await app.inject({
  method: "POST",
  url: "/api/v1/sync/ack",
  headers: entryHeaders(personal),
  payload: {
    protocolVersion: 1,
    eventSequence: event.eventSequence,
    eventRef: event.eventRef
  }
});
expect(ack.statusCode).toBe(200);
expect(ack.json()).toMatchObject({
  protocolVersion: 1,
  sync: {
    deviceRef: onboarding.device.deviceRef,
    personRef: onboarding.owner.personRef,
    previousSequence: 0,
    acknowledgedSequence: event.eventSequence,
    advanced: true,
    updatedAt: expect.any(String)
  }
});
```

Strict Body rejection:

```ts
for (const extra of [
  { deviceRef: onboarding.device.deviceRef },
  { personRef: onboarding.owner.personRef },
  { entrySessionRef: personal.entrySessionRef },
  { acknowledgedSequence: 1 }
]) {
  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/sync/ack",
    headers: entryHeaders(personal),
    payload: {
      protocolVersion: 1,
      eventSequence: event.eventSequence,
      eventRef: event.eventRef,
      ...extra
    }
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ code: "REQUEST_INVALID" });
}
```

Mismatched or cross-Person event must return the same 404:

```ts
expect(response.statusCode).toBe(404);
expect(response.json()).toMatchObject({
  code: "SYNC_EVENT_NOT_FOUND",
  category: "permission",
  retryable: false
});
```

- [ ] **Step 2: Run route tests and verify RED**

```bash
npm run test -w @family-ai/gateway -- deviceSyncRoutes.test.ts
```

Expected: FAIL because ACK route is absent.

- [ ] **Step 3: Implement strict ACK parsing**

```ts
const eventRefSchema = z.string().regex(/^event:[a-z0-9][a-z0-9._:-]{1,126}$/);
const syncAckSchema = z.object({
  protocolVersion: z.literal(CHAT_WORK_PROTOCOL_VERSION),
  eventSequence: z.number().int().positive().safe(),
  eventRef: eventRefSchema
}).strict();

function syncEventNotFound(): GatewayDomainError {
  return new GatewayDomainError(
    "SYNC_EVENT_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到可以确认的同步事件。"
  );
}
```

Register POST:

```ts
app.post("/api/v1/sync/ack", async (request) => {
  const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
  const parsed = syncAckSchema.safeParse(request.body);
  if (!parsed.success) throw invalidRequest("同步确认请求不正确。");

  const result = input.repository.acknowledge({
    deviceRef: context.device.deviceRef,
    personRef: context.person.personRef,
    eventSequence: parsed.data.eventSequence,
    eventRef: parsed.data.eventRef
  });
  if (!result) throw syncEventNotFound();
  return {
    protocolVersion: CHAT_WORK_PROTOCOL_VERSION,
    sync: result
  };
});
```

- [ ] **Step 4: Preserve the common Chat / Work error envelope**

In `mobileErrorRoute()` inside `apps/gateway/src/app.ts`, classify all Sync paths with the existing common APIs:

```ts
const chatWorkPath = path === "/api/v1/chat" ||
  path.startsWith("/api/v1/chat/") ||
  path === "/api/v1/work-conversations" ||
  path.startsWith("/api/v1/work-conversations/") ||
  path.startsWith("/api/v1/threads/") ||
  path === "/api/v1/events/stream" ||
  path.startsWith("/api/v1/sync/");
```

A request using `Authorization: Device ...` against `/api/v1/sync/events` must receive the unwrapped PublicError `{ code, category, message, retryable }`, not Mobile Gateway `{ protocolVersion, error }`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test -w @family-ai/gateway -- deviceSyncRoutes.test.ts chatWorkRoutesErrorEnvelope.test.ts eventStreamRoutes.test.ts
git add apps/gateway/src/deviceSyncRoutes.ts apps/gateway/src/app.ts apps/gateway/test/deviceSyncRoutes.test.ts
git commit -m "feat(gateway): acknowledge Device Sync events"
```

---

### Task 5: Session、设备、Person 隔离与 SSE 非自动 ACK

**Files:**
- Create: `apps/gateway/test/deviceSyncSecurity.test.ts`
- Modify: `apps/gateway/src/deviceSync.ts` only if a failing lifecycle test reveals a repository defect
- Modify: `apps/gateway/src/deviceSyncRoutes.ts` only if a failing security test reveals a route defect

**Interfaces:**
- Uses existing Mobile Session renew/logout/revoke routes without modifying them。
- Verifies Sync Cursor identity remains `(deviceRef, personRef)` across Session replacement。

- [ ] **Step 1: Write failing Session replacement and restart tests**

Flow:

```text
Onboarding Personal Entry
→ Create event
→ ACK event
→ POST /api/v1/mobile/session/logout with Device credential
→ POST /api/v1/mobile/session/renew with same Device credential
→ GET /api/v1/sync/events with new Entry Session
→ acknowledgedSequence remains unchanged
```

Use:

```ts
const deviceHeaders = {
  authorization: `Device ${deviceToken}`,
  "x-device-ref": onboarding.device.deviceRef
};
```

Also close and rebuild the Gateway against the same SQLite path before the final GET to prove persistence across restart.

- [ ] **Step 2: Write failing new-device and same-Person device-isolation tests**

Insert a second active device, device binding, Personal EntryBinding and EntrySession for the same Person in a test-only SQLite fixture. ACK sequence 2 from the first device. Verify:

```text
first device acknowledgedSequence = 2
second device acknowledgedSequence = 0
```

After the second device ACKs sequence 1, verify both rows coexist and remain independent.

- [ ] **Step 3: Write failing cross-Person isolation tests**

Create a second Person, device, binding and Personal Entry. Generate one event for each Person. Verify each GET only returns its own Person events and each ACK only changes its own `(deviceRef, personRef)` row.

- [ ] **Step 4: Write failing revoke behavior**

After a valid ACK, revoke the device through the existing admin route. Verify both:

```text
GET /api/v1/sync/events → 403 DEVICE_REVOKED
POST /api/v1/sync/ack   → 403 DEVICE_REVOKED
```

Then query SQLite directly and verify the Cursor row remains stored but cannot restore access.

- [ ] **Step 5: Write the SSE and GET non-ACK regression**

Create a Home Chat event, open a real SSE connection from Cursor 0, read the `chat.home.created` event, then call GET Sync and query SQLite. Assert:

```text
SSE event arrived
GET returned the event
acknowledgedSequence remains 0
no device_sync_cursors row exists
```

Only an explicit POST ACK may create the row.

- [ ] **Step 6: Run focused tests and fix only observed defects**

```bash
npm run test -w @family-ai/gateway -- deviceSyncSecurity.test.ts deviceSyncRoutes.test.ts deviceSync.test.ts
```

Expected initial RED for any missing lifecycle or isolation behavior; make the smallest production correction, then rerun until GREEN.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/test/deviceSyncSecurity.test.ts apps/gateway/src/deviceSync.ts apps/gateway/src/deviceSyncRoutes.ts
git commit -m "test(gateway): verify Device Sync lifecycle isolation"
```

---

### Task 6: 全仓验证、证据和 PR #14 隔离审查

**Files:**
- Create: `docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md`
- Modify: `docs/superpowers/specs/2026-07-24-gateway-device-sync-cursor-design.md` only to set implementation status and record approved deviations

- [ ] **Step 1: Run focused Gateway quality gates**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete repository quality gate**

```bash
npm run check
```

Expected: all workspace tests, static checks, TypeScript typechecks and builds pass.

- [ ] **Step 3: Review the final changed-path boundary**

Allowed production paths:

```text
apps/gateway/src/app.ts
apps/gateway/src/domainEvents.ts
apps/gateway/src/deviceSync.ts
apps/gateway/src/deviceSyncRoutes.ts
```

All remaining paths must be `apps/gateway/test/deviceSync*.test.ts` or the approved spec/plan/evidence documents. The changed-path intersection with PR #14 must be empty.

- [ ] **Step 4: Record the evidence**

The evidence document must include:

- every observed RED/GREEN CI run;
- Event Schema V1 → V2 incremental migration proof;
- Cursor lazy creation, monotonicity and restart recovery;
- Session renewal/logout continuity;
- new-device and cross-Person isolation;
- GET and SSE non-ACK proof;
- Device revoke behavior;
- final CI and Secret Scan run numbers;
- PR comments and unresolved review threads;
- PR #14 Open/Draft/Head/mergeable status and zero path intersection.

- [ ] **Step 5: Commit documentation**

```bash
git add \
  docs/superpowers/specs/2026-07-24-gateway-device-sync-cursor-design.md \
  docs/superpowers/evidence/2026-07-24-gateway-device-sync-cursor.md
git commit -m "docs: record Device Sync cursor verification"
```

- [ ] **Step 6: Create the Pull Request as Draft during RED cycles**

Title:

```text
feat(gateway): persist Device Sync cursors
```

The PR body must state that public Event/Sync contracts, Member Web, Push and iOS integration remain deferred.

- [ ] **Step 7: Mark Ready only after fresh final checks**

Required before Ready:

```text
latest Head CI = success
latest Head Secret Scan = success
GitHub mergeable = true
PR comments = none or resolved
unresolved review threads = none
PR #14 remains Open and Draft
PR #14 Head remains e075f114e3f3fcdb728f6bff75797d415c4a5315
changed-path intersection with PR #14 = 0
```
