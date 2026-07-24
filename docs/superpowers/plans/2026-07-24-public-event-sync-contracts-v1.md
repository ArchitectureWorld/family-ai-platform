# Public Event / Sync Contracts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a versioned Event / Sync v1 contract shared by Gateway REST, Gateway SSE and future Web/mobile clients without changing the existing wire behavior.

**Architecture:** Add `packages/contracts/src/sync.ts` as the public boundary. Known events use strict per-type schemas and cross-field invariants; unknown future events use a JSON-only opaque envelope whose `eventType` explicitly excludes known values. Gateway validates catch-up responses, ACK requests/responses and SSE data through those shared schemas while keeping SQLite event models internal.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, Fastify 5, npm workspaces, GitHub Actions.

## Global Constraints

- Work only on `feat/contracts-event-sync-v1`, based on `main` commit `58f2ccae76902b77790cecb05483a062259b7083`.
- `SYNC_PROTOCOL_VERSION` wire value is numeric `1`.
- Known event payloads and envelopes are strict; malformed known events must not fall back to the opaque schema.
- Opaque payloads accept only finite JSON values and plain objects.
- Preserve current Gateway query compatibility, including leading-zero decimal strings such as `"001"`.
- REST catch-up and SSE business data use the same `syncEventSchema`.
- Do not modify database schemas, event triggers, Device Sync transactions, SSE heartbeat/Hub/backpressure, Mobile Entry v1 or the browser acceptance console.
- Do not modify `clients/ios/**`, `.github/workflows/**`, `packages/contracts/src/mobileEntry.ts`, `packages/contracts/fixtures/mobile-entry/**`, `apps/gateway/src/mobilePairing.ts`, `apps/gateway/src/mobileRoutes.ts`, `apps/gateway/src/entrySessionAuth.ts`, `apps/gateway/src/deviceSync.ts`, `apps/gateway/src/domainEventCore.ts`, `apps/gateway/src/domainEvents.ts`, or `apps/gateway/public/**`.
- Every behavior phase follows RED → observed failing CI → minimal GREEN → observed passing CI.

---

## File Map

### New files

- `packages/contracts/src/sync.ts` — public Event / Sync v1 schemas, constants and inferred types.
- `packages/contracts/test/sync.test.ts` — canonical schema, compatibility and invariant tests.
- `packages/contracts/fixtures/sync/*.json` — eleven synthetic canonical wire fixtures.
- `apps/gateway/test/syncContracts.test.ts` — Gateway REST/SSE contract-boundary integration tests.
- `docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md` — final RED/GREEN and compatibility evidence.

### Modified files

- `packages/contracts/src/index.ts` — export `sync.ts` from the package root.
- `apps/gateway/src/deviceSyncRoutes.ts` — consume shared query, response and ACK schemas.
- `apps/gateway/src/eventStream.ts` — consume shared SSE event name and data schema.
- Existing Gateway tests may receive narrow assertions but no production behavior changes.

---

### Task 1: Freeze canonical known and opaque event behavior

**Files:**
- Create: `packages/contracts/fixtures/sync/chat-home-created.json`
- Create: `packages/contracts/fixtures/sync/work-created.json`
- Create: `packages/contracts/fixtures/sync/thread-message-created.json`
- Create: `packages/contracts/fixtures/sync/chat-work-created.json`
- Create: `packages/contracts/fixtures/sync/work-progress-updated.json`
- Create: `packages/contracts/fixtures/sync/provider-turn-failed.json`
- Create: `packages/contracts/fixtures/sync/provider-turn-succeeded.json`
- Create: `packages/contracts/fixtures/sync/opaque-future-event.json`
- Create: `packages/contracts/test/sync.test.ts`

**Interfaces:**
- Consumes: existing `workConversationStatusSchema` from `packages/contracts/src/chatWork.ts`.
- Produces: required exports `KNOWN_SYNC_EVENT_TYPES`, `knownSyncEventSchema`, `opaqueSyncEventSchema`, `syncEventSchema` and inferred event types.

- [ ] **Step 1: Add canonical known-event fixtures**

Use synthetic references only. Example exact `chat-home-created.json`:

```json
{
  "eventRef": "event:alice-chat-home-0001",
  "personRef": "person:alice",
  "eventSequence": 1,
  "eventType": "chat.home.created",
  "aggregateType": "home_chat",
  "aggregateRef": "home-chat:alice",
  "threadRef": "thread:alice-home-chat",
  "payload": {
    "homeChatStreamRef": "home-chat:alice",
    "dailyEpisodeRef": "daily-episode:alice-20260724",
    "threadRef": "thread:alice-home-chat"
  },
  "occurredAt": "2026-07-24T08:00:00.000Z",
  "createdAt": "2026-07-24T08:00:00.000Z"
}
```

Use the following exact payloads for the remaining known fixtures:

```json
{
  "work-created.json": {
    "eventRef": "event:alice-work-0001",
    "personRef": "person:alice",
    "eventSequence": 2,
    "eventType": "work.created",
    "aggregateType": "work",
    "aggregateRef": "work:family-ai-platform",
    "threadRef": "thread:work-family-ai-platform",
    "payload": {
      "workConversationRef": "work:family-ai-platform",
      "threadRef": "thread:work-family-ai-platform",
      "status": "active"
    },
    "occurredAt": "2026-07-24T08:01:00.000Z",
    "createdAt": "2026-07-24T08:01:00.000Z"
  },
  "thread-message-created.json": {
    "eventRef": "event:alice-message-0001",
    "personRef": "person:alice",
    "eventSequence": 3,
    "eventType": "thread.message.created",
    "aggregateType": "thread_message",
    "aggregateRef": "message:alice-0001",
    "threadRef": "thread:alice-home-chat",
    "payload": {
      "messageRef": "message:alice-0001",
      "threadRef": "thread:alice-home-chat",
      "threadSequence": 1,
      "actorType": "person",
      "clientMessageId": "web-alice-0001"
    },
    "occurredAt": "2026-07-24T08:02:00.000Z",
    "createdAt": "2026-07-24T08:02:00.000Z"
  },
  "chat-work-created.json": {
    "eventRef": "event:alice-conversion-0001",
    "personRef": "person:alice",
    "eventSequence": 4,
    "eventType": "chat.work.created",
    "aggregateType": "chat_work_conversion",
    "aggregateRef": "chat-work-conversion:alice-0001",
    "threadRef": "thread:work-family-ai-platform",
    "payload": {
      "conversionRef": "chat-work-conversion:alice-0001",
      "homeChatStreamRef": "home-chat:alice",
      "workConversationRef": "work:family-ai-platform",
      "sourceMessageRefs": ["message:alice-0001"]
    },
    "occurredAt": "2026-07-24T08:03:00.000Z",
    "createdAt": "2026-07-24T08:03:00.000Z"
  },
  "work-progress-updated.json": {
    "eventRef": "event:alice-progress-0001",
    "personRef": "person:alice",
    "eventSequence": 5,
    "eventType": "work.progress.updated",
    "aggregateType": "work_progress",
    "aggregateRef": "work:family-ai-platform",
    "threadRef": "thread:work-family-ai-platform",
    "payload": {
      "workConversationRef": "work:family-ai-platform",
      "status": "waiting_confirmation",
      "updatedAt": "2026-07-24T08:04:00.000Z"
    },
    "occurredAt": "2026-07-24T08:04:00.000Z",
    "createdAt": "2026-07-24T08:04:01.000Z"
  },
  "provider-turn-failed.json": {
    "eventRef": "event:alice-provider-failed-0001",
    "personRef": "person:alice",
    "eventSequence": 6,
    "eventType": "thread.provider_turn.failed",
    "aggregateType": "provider_turn",
    "aggregateRef": "message:alice-0001",
    "threadRef": "thread:alice-home-chat",
    "payload": {
      "userMessageRef": "message:alice-0001",
      "threadRef": "thread:alice-home-chat",
      "attemptCount": 1,
      "error": {
        "code": "PROVIDER_UNAVAILABLE",
        "category": "availability",
        "retryable": true
      }
    },
    "occurredAt": "2026-07-24T08:05:00.000Z",
    "createdAt": "2026-07-24T08:05:00.000Z"
  },
  "provider-turn-succeeded.json": {
    "eventRef": "event:alice-provider-succeeded-0001",
    "personRef": "person:alice",
    "eventSequence": 7,
    "eventType": "thread.provider_turn.succeeded",
    "aggregateType": "provider_turn",
    "aggregateRef": "message:alice-0001",
    "threadRef": "thread:alice-home-chat",
    "payload": {
      "userMessageRef": "message:alice-0001",
      "assistantMessageRef": "message:alice-0002",
      "threadRef": "thread:alice-home-chat",
      "attemptCount": 1
    },
    "occurredAt": "2026-07-24T08:06:00.000Z",
    "createdAt": "2026-07-24T08:06:00.000Z"
  }
}
```

- [ ] **Step 2: Add an opaque future-event fixture**

```json
{
  "eventRef": "event:alice-notification-0001",
  "personRef": "person:alice",
  "eventSequence": 8,
  "eventType": "notification.created",
  "aggregateType": "notification",
  "aggregateRef": "notification:alice-0001",
  "threadRef": null,
  "payload": {
    "notificationRef": "notification:alice-0001",
    "priority": 2,
    "channels": ["web", "mobile"],
    "metadata": { "dismissible": true },
    "optional": null
  },
  "occurredAt": "2026-07-24T08:07:00.000Z",
  "createdAt": "2026-07-24T08:07:00.000Z"
}
```

- [ ] **Step 3: Write failing event-schema tests**

Create `packages/contracts/test/sync.test.ts` importing the not-yet-existing schemas from `../src/index.js`. Tests must:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_SYNC_EVENT_TYPES,
  knownSyncEventSchema,
  opaqueSyncEventSchema,
  syncEventSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(`../fixtures/sync/${name}`, import.meta.url)),
    "utf8"
  ));
}

const knownFiles = [
  "chat-home-created.json",
  "work-created.json",
  "thread-message-created.json",
  "chat-work-created.json",
  "work-progress-updated.json",
  "provider-turn-failed.json",
  "provider-turn-succeeded.json"
] as const;

describe("Event Sync v1 events", () => {
  it("accepts all canonical known events", () => {
    expect(KNOWN_SYNC_EVENT_TYPES).toHaveLength(7);
    for (const name of knownFiles) {
      expect(knownSyncEventSchema.parse(fixture(name))).toEqual(fixture(name));
    }
  });

  it("accepts a JSON-safe unknown future event", () => {
    const event = fixture("opaque-future-event.json");
    expect(opaqueSyncEventSchema.parse(event)).toEqual(event);
    expect(syncEventSchema.parse(event)).toEqual(event);
  });

  it("does not let malformed known events degrade to opaque", () => {
    const event = fixture("thread-message-created.json") as Record<string, unknown>;
    const malformed = {
      ...event,
      payload: { workConversationRef: "work:wrong-payload" }
    };
    expect(knownSyncEventSchema.safeParse(malformed).success).toBe(false);
    expect(opaqueSyncEventSchema.safeParse(malformed).success).toBe(false);
    expect(syncEventSchema.safeParse(malformed).success).toBe(false);
  });

  it("enforces known-event cross-field references", () => {
    const event = fixture("work-created.json") as Record<string, unknown>;
    expect(syncEventSchema.safeParse({
      ...event,
      aggregateRef: "work:another-work"
    }).success).toBe(false);
    expect(syncEventSchema.safeParse({
      ...event,
      threadRef: "thread:another-work"
    }).success).toBe(false);
  });

  it("rejects duplicate Chat-to-Work source message references", () => {
    const event = fixture("chat-work-created.json") as {
      payload: Record<string, unknown>;
    };
    expect(syncEventSchema.safeParse({
      ...event,
      payload: {
        ...event.payload,
        sourceMessageRefs: ["message:alice-0001", "message:alice-0001"]
      }
    }).success).toBe(false);
  });

  it("rejects unknown top-level fields and non-JSON opaque payloads", () => {
    const opaque = fixture("opaque-future-event.json") as Record<string, unknown>;
    expect(syncEventSchema.safeParse({ ...opaque, databaseRowId: 42 }).success).toBe(false);
    for (const payload of [
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date() },
      { value: () => "not-json" }
    ]) {
      expect(syncEventSchema.safeParse({ ...opaque, payload }).success).toBe(false);
    }
  });
});
```

- [ ] **Step 4: Run the Contracts test and observe RED**

Run:

```bash
npm run test -w @family-ai/contracts
```

Expected: FAIL because the new exports and `sync.ts` do not exist.

- [ ] **Step 5: Commit the RED state**

```bash
git add packages/contracts/fixtures/sync packages/contracts/test/sync.test.ts
git commit -m "test(contracts): define Event Sync v1 events"
```

---

### Task 2: Implement known and opaque event schemas

**Files:**
- Create: `packages/contracts/src/sync.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/sync.test.ts`

**Interfaces:**
- Produces: all event constants, schemas and inferred event types required by Task 1 and later REST/SSE tasks.

- [ ] **Step 1: Implement public foundations in `sync.ts`**

Define exact constants and schemas:

```ts
import { z } from "zod";
import { workConversationStatusSchema } from "./chatWork.js";

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_SSE_EVENT_NAME = "domain-event" as const;

function fixedRef(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

export const syncEventRefSchema = fixedRef("event");
export const syncPersonRefSchema = fixedRef("person");
export const syncDeviceRefSchema = fixedRef("device");
export const syncThreadRefSchema = fixedRef("thread");
export const syncMessageRefSchema = fixedRef("message");
const syncHomeChatStreamRefSchema = fixedRef("home-chat");
const syncDailyEpisodeRefSchema = fixedRef("daily-episode");
const syncWorkConversationRefSchema = fixedRef("work");
const syncChatWorkConversionRefSchema = fixedRef("chat-work-conversion");
export const syncGenericRefSchema = z.string().regex(
  /^[a-z][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._:-]{1,126}$/
);
export const syncEventTypeSchema = z.string().min(3).max(128).regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
);
export const syncAggregateTypeSchema = z.string().min(1).max(64).regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
);
export const syncEventSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const syncCursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const syncTimestampSchema = z.string().datetime({ offset: true });
export const syncClientMessageIdSchema = z.string().min(8).max(128).regex(/^\S+$/);
export const syncPublicErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export const syncPublicErrorCategorySchema = z.enum([
  "validation", "permission", "availability", "timeout", "conflict", "internal"
]);
```

- [ ] **Step 2: Implement recursive JSON-only schemas**

Use a lazy recursive schema and a plain-object refinement:

```ts
export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };

const finiteNumberSchema = z.number().finite();
const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const syncJsonValueSchema: z.ZodType<SyncJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), finiteNumberSchema, z.string(),
  z.array(syncJsonValueSchema),
  z.record(z.string(), syncJsonValueSchema).refine(plainObject)
]));
export const syncJsonObjectSchema = z.record(z.string(), syncJsonValueSchema).refine(plainObject);
```

- [ ] **Step 3: Implement the seven strict known event schemas**

Create a strict shared envelope and seven strict variants. Add `superRefine` for:

```text
chat.home.created: aggregateRef == payload.homeChatStreamRef; threadRef == payload.threadRef
work.created: aggregateRef == payload.workConversationRef; threadRef == payload.threadRef
thread.message.created: aggregateRef == payload.messageRef; threadRef == payload.threadRef
chat.work.created: aggregateRef == payload.conversionRef; sourceMessageRefs non-empty and unique
work.progress.updated: aggregateRef == payload.workConversationRef; occurredAt == payload.updatedAt
thread.provider_turn.failed: aggregateRef == payload.userMessageRef; threadRef == payload.threadRef
thread.provider_turn.succeeded: aggregateRef == payload.userMessageRef; threadRef == payload.threadRef; assistantMessageRef != userMessageRef
```

Export:

```ts
export const KNOWN_SYNC_EVENT_TYPES = [
  "chat.home.created",
  "work.created",
  "thread.message.created",
  "chat.work.created",
  "work.progress.updated",
  "thread.provider_turn.failed",
  "thread.provider_turn.succeeded"
] as const;
export const knownSyncEventTypeSchema = z.enum(KNOWN_SYNC_EVENT_TYPES);
export const knownSyncEventSchema = z.discriminatedUnion("eventType", [/* seven schemas */]);
```

- [ ] **Step 4: Implement the opaque schema and anti-downgrade gate**

```ts
const knownTypes = new Set<string>(KNOWN_SYNC_EVENT_TYPES);
const futureSyncEventTypeSchema = syncEventTypeSchema.refine(
  (value) => !knownTypes.has(value),
  "known event types must use their strict schema"
);

export const opaqueSyncEventSchema = z.object({
  eventRef: syncEventRefSchema,
  personRef: syncPersonRefSchema,
  eventSequence: syncEventSequenceSchema,
  eventType: futureSyncEventTypeSchema,
  aggregateType: syncAggregateTypeSchema,
  aggregateRef: syncGenericRefSchema,
  threadRef: syncThreadRefSchema.nullable(),
  payload: syncJsonObjectSchema,
  occurredAt: syncTimestampSchema,
  createdAt: syncTimestampSchema
}).strict();

export const syncEventSchema = z.union([knownSyncEventSchema, opaqueSyncEventSchema]);
export const syncSseDataSchema = syncEventSchema;
```

Export all inferred types with `z.infer`.

- [ ] **Step 5: Export the module from `index.ts`**

Append:

```ts
export * from "./sync.js";
```

- [ ] **Step 6: Run Contracts tests and observe GREEN**

```bash
npm run test -w @family-ai/contracts
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the GREEN state**

```bash
git add packages/contracts/src/sync.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add Event Sync v1 events"
```

---

### Task 3: Add query, catch-up and ACK contracts

**Files:**
- Create: `packages/contracts/fixtures/sync/sync-events-response.json`
- Create: `packages/contracts/fixtures/sync/sync-ack-request.json`
- Create: `packages/contracts/fixtures/sync/sync-ack-response.json`
- Modify: `packages/contracts/test/sync.test.ts`
- Modify: `packages/contracts/src/sync.ts`

**Interfaces:**
- Produces: `syncEventsQuerySchema`, `syncEventsResponseSchema`, `syncAckRequestSchema`, `syncAckResponseSchema` and inferred types.

- [ ] **Step 1: Add canonical request/response fixtures**

`sync-events-response.json` contains the seven known events in ascending order, `acknowledgedSequence: 0`, `requestedAfterSequence: 0`, `latestSequence: 7`, and `nextAfterSequence: null`.

`sync-ack-request.json`:

```json
{
  "protocolVersion": 1,
  "eventSequence": 7,
  "eventRef": "event:alice-provider-succeeded-0001"
}
```

`sync-ack-response.json`:

```json
{
  "protocolVersion": 1,
  "sync": {
    "deviceRef": "device:web-alice",
    "personRef": "person:alice",
    "previousSequence": 6,
    "acknowledgedSequence": 7,
    "advanced": true,
    "updatedAt": "2026-07-24T08:08:00.000Z"
  }
}
```

- [ ] **Step 2: Extend tests with RED assertions**

Add imports and tests for:

```ts
syncEventsQuerySchema
syncEventsResponseSchema
syncAckRequestSchema
syncAckResponseSchema
SYNC_PROTOCOL_VERSION
```

Required expectations:

```ts
expect(syncEventsQuerySchema.parse({})).toEqual({ limit: 100 });
expect(syncEventsQuerySchema.parse({ afterSequence: "001", limit: "020" }))
  .toEqual({ afterSequence: 1, limit: 20 });
for (const query of [
  { afterSequence: "-1" }, { afterSequence: "1.5" }, { afterSequence: "1e3" },
  { afterSequence: " 1" }, { afterSequence: "9007199254740992" },
  { limit: "0" }, { limit: "201" }, { limit: ["1", "2"] }, { unknown: "1" }
]) expect(syncEventsQuerySchema.safeParse(query).success).toBe(false);

expect(syncEventsResponseSchema.parse(fixture("sync-events-response.json"))).toBeTruthy();
expect(syncAckRequestSchema.parse(fixture("sync-ack-request.json"))).toBeTruthy();
expect(syncAckResponseSchema.parse(fixture("sync-ack-response.json"))).toBeTruthy();
```

Also mutate fixtures to prove Person mismatch, non-increasing event order, wrong `nextAfterSequence`, trusted identity fields in ACK and inconsistent `advanced` values are rejected.

- [ ] **Step 3: Run Contracts tests and observe RED**

```bash
npm run test -w @family-ai/contracts
```

Expected: FAIL because query/response/ACK exports do not exist.

- [ ] **Step 4: Commit the RED state**

```bash
git add packages/contracts/fixtures/sync packages/contracts/test/sync.test.ts
git commit -m "test(contracts): define Event Sync catch-up and ACK"
```

- [ ] **Step 5: Implement query normalization**

Use a canonical decimal transport schema that accepts leading zeroes but rejects signs, whitespace, decimals and exponent notation:

```ts
const decimalStringSchema = z.string().regex(/^\d+$/);
function parseSafeDecimal(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("invalid decimal integer");
  }
  return parsed;
}

export const syncEventsQuerySchema = z.object({
  afterSequence: decimalStringSchema.optional(),
  limit: decimalStringSchema.optional()
}).strict().transform((value, context) => {
  try {
    return {
      ...(value.afterSequence === undefined ? {} : {
        afterSequence: parseSafeDecimal(value.afterSequence, 0, Number.MAX_SAFE_INTEGER)
      }),
      limit: value.limit === undefined ? 100 : parseSafeDecimal(value.limit, 1, 200)
    };
  } catch {
    context.addIssue({ code: "custom", message: "invalid sync query" });
    return z.NEVER;
  }
});
```

- [ ] **Step 6: Implement catch-up response invariants**

Create a strict response object with `events: z.array(syncEventSchema).max(200)` and a `superRefine` enforcing every invariant in the approved Spec. Allow `requestedAfterSequence > latestSequence` only when `events` is empty and `nextAfterSequence` is null.

- [ ] **Step 7: Implement strict ACK request/response schemas**

The request is a strict object containing only protocol version, event sequence and event ref. The response is strict and verifies:

```text
acknowledgedSequence >= previousSequence
advanced true iff acknowledgedSequence > previousSequence
advanced false iff acknowledgedSequence == previousSequence
```

- [ ] **Step 8: Run Contracts tests and observe GREEN**

```bash
npm run test -w @family-ai/contracts
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
```

- [ ] **Step 9: Commit the GREEN state**

```bash
git add packages/contracts/src/sync.ts
git commit -m "feat(contracts): add Event Sync catch-up and ACK"
```

---

### Task 4: Make Gateway REST use the public contracts

**Files:**
- Create: `apps/gateway/test/syncContracts.test.ts`
- Modify: `apps/gateway/src/deviceSyncRoutes.ts`

**Interfaces:**
- Consumes: Task 3 schemas.
- Produces: Gateway GET/ACK wire responses parsed by shared contracts without behavioral drift.

- [ ] **Step 1: Write failing Gateway contract-integration tests**

Use `buildGatewayApp`, formal onboarding and a Personal Entry. Assert:

```ts
const response = await app.inject({
  method: "GET",
  url: "/api/v1/sync/events?afterSequence=000&limit=020",
  headers: entryHeaders(personal)
});
expect(response.statusCode).toBe(200);
expect(syncEventsResponseSchema.parse(response.json()).sync.requestedAfterSequence).toBe(0);

const event = syncEventsResponseSchema.parse(response.json()).events[0]!;
const ackRequest = syncAckRequestSchema.parse({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  eventSequence: event.eventSequence,
  eventRef: event.eventRef
});
const ack = await app.inject({
  method: "POST",
  url: "/api/v1/sync/ack",
  headers: entryHeaders(personal),
  payload: ackRequest
});
expect(syncAckResponseSchema.parse(ack.json())).toBeTruthy();
```

Add a test that monkey-patches or directly passes malformed route output to the public schema to prove the integration test catches Person or pagination drift.

- [ ] **Step 2: Run Gateway tests and observe RED**

```bash
npm run test -w @family-ai/gateway
```

Expected: FAIL because Gateway still uses private schemas and the new integration contract is not wired.

- [ ] **Step 3: Commit the RED state**

```bash
git add apps/gateway/test/syncContracts.test.ts
git commit -m "test(gateway): require shared Event Sync REST contracts"
```

- [ ] **Step 4: Replace private route schemas with shared imports**

In `deviceSyncRoutes.ts`, import:

```ts
import {
  SYNC_PROTOCOL_VERSION,
  syncAckRequestSchema,
  syncAckResponseSchema,
  syncEventsQuerySchema,
  syncEventsResponseSchema
} from "@family-ai/contracts";
```

Remove local decimal, query, event-ref and ACK schemas plus `safeInteger()`.

Parse query using `syncEventsQuerySchema.safeParse(request.query)`. Parse outgoing GET and ACK objects through the shared response schemas before returning. Keep existing `REQUEST_INVALID` and `SYNC_EVENT_NOT_FOUND` mapping unchanged.

- [ ] **Step 5: Run Gateway and full tests and observe GREEN**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

- [ ] **Step 6: Commit the GREEN state**

```bash
git add apps/gateway/src/deviceSyncRoutes.ts
git commit -m "refactor(gateway): use shared Event Sync REST contracts"
```

---

### Task 5: Make Gateway SSE use the same public event schema

**Files:**
- Modify: `apps/gateway/test/syncContracts.test.ts`
- Modify: `apps/gateway/src/eventStream.ts`

**Interfaces:**
- Consumes: `SYNC_SSE_EVENT_NAME` and `syncSseDataSchema`.
- Produces: SSE frames whose event name and data are contract-validated before serialization.

- [ ] **Step 1: Add failing SSE contract tests**

Test `formatDomainEventFrame()` directly and through a real SSE stream:

```ts
const frame = formatDomainEventFrame(syncSseDataSchema.parse(event));
const lines = Object.fromEntries(
  frame.trim().split("\n").map((line) => line.split(": ", 2))
);
expect(lines.event).toBe(SYNC_SSE_EVENT_NAME);
expect(Number(lines.id)).toBe(event.eventSequence);
expect(syncSseDataSchema.parse(JSON.parse(lines.data))).toEqual(event);
```

Add a malformed known `DomainEvent` and assert `formatDomainEventFrame()` throws before writing a frame.

- [ ] **Step 2: Run Gateway tests and observe RED**

```bash
npm run test -w @family-ai/gateway
```

Expected: malformed known data is still serialized because the formatter does not parse the shared schema.

- [ ] **Step 3: Commit the RED state**

```bash
git add apps/gateway/test/syncContracts.test.ts
git commit -m "test(gateway): require shared Event Sync SSE contract"
```

- [ ] **Step 4: Implement shared SSE serialization**

Import:

```ts
import { SYNC_SSE_EVENT_NAME, syncSseDataSchema } from "@family-ai/contracts";
```

Replace the formatter with:

```ts
export function formatDomainEventFrame(event: DomainEvent): string {
  const data = syncSseDataSchema.parse(event);
  return `id: ${data.eventSequence}\nevent: ${SYNC_SSE_EVENT_NAME}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

Do not alter cursor parsing, heartbeat, Hub, queue limits, backpressure or shutdown behavior.

- [ ] **Step 5: Run Gateway and full tests and observe GREEN**

```bash
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

- [ ] **Step 6: Commit the GREEN state**

```bash
git add apps/gateway/src/eventStream.ts
git commit -m "refactor(gateway): validate SSE with Event Sync contracts"
```

---

### Task 6: Verify current Gateway events, privacy and frozen Mobile Entry

**Files:**
- Modify: `apps/gateway/test/syncContracts.test.ts`
- Modify: `packages/contracts/test/sync.test.ts`

**Interfaces:**
- Proves all seven current event producers remain compatible and no sensitive fields enter the public protocol.

- [ ] **Step 1: Add a Gateway test generating all seven known event types**

Use formal Home Chat, Work, message, Chat-to-Work, progress and Provider success/failure flows. Read `domain_events` through the sync endpoint and assert:

```ts
const events = syncEventsResponseSchema.parse(response.json()).events;
expect(new Set(events.map((event) => event.eventType))).toEqual(new Set(KNOWN_SYNC_EVENT_TYPES));
for (const event of events) expect(knownSyncEventSchema.parse(event)).toEqual(event);
```

- [ ] **Step 2: Add privacy scans**

Serialize all sync fixtures and generated Gateway events, lower-case the output, and reject:

```text
authorization
entrysessiontoken
entry_session_token
devicecredential
device_credential
externalsessionref
external_session_ref
bearer 
```

Do not reject harmless reference fields such as `deviceRef` and `personRef` in responses.

- [ ] **Step 3: Add frozen Mobile Entry regression assertions**

Re-run existing Mobile Entry fixtures and assert root exports remain present. Do not modify Mobile Entry source or fixture files.

- [ ] **Step 4: Run tests and commit**

```bash
npm run test -w @family-ai/contracts
npm run test -w @family-ai/gateway
npm run check
git add packages/contracts/test/sync.test.ts apps/gateway/test/syncContracts.test.ts
git commit -m "test: verify Event Sync compatibility and privacy"
```

---

### Task 7: Final review, evidence and PR readiness

**Files:**
- Create: `docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md`
- Update PR #23 body.

- [ ] **Step 1: Run fresh complete verification**

```bash
npm run test -w @family-ai/contracts
npm run typecheck -w @family-ai/contracts
npm run build -w @family-ai/contracts
npm run test -w @family-ai/gateway
npm run typecheck -w @family-ai/gateway
npm run build -w @family-ai/gateway
npm run check
```

Expected: every command exits 0 with no failed tests.

- [ ] **Step 2: Review changed paths against PR #14**

```bash
git diff --name-only 58f2ccae76902b77790cecb05483a062259b7083...HEAD
```

Expected intersection with PR #14 changed paths is empty. Confirm no files under `clients/ios/**` or `.github/workflows/**` changed.

- [ ] **Step 3: Record evidence**

The evidence document must include:

```text
final Head SHA
RED and GREEN CI run numbers
Contracts and Gateway test results
known/opaque compatibility proof
REST/SSE shared-schema proof
privacy scan result
PR #14 state, head and path intersection
remaining deferred work
```

- [ ] **Step 4: Commit evidence and run final Head checks**

```bash
git add docs/superpowers/evidence/2026-07-24-public-event-sync-contracts-v1.md
git commit -m "docs: record Event Sync contracts verification"
```

Wait for Repository CI and Secret Scan on the evidence Head and require success.

- [ ] **Step 5: Recheck PR #14**

Confirm:

```text
state = open
draft = true
head = e075f114e3f3fcdb728f6bff75797d415c4a5315
mergeable = true
```

Because `packages/contracts/**` can trigger iOS CI, record any new PR #14 merged-tree iOS run and require success if it exists.

- [ ] **Step 6: Mark PR #23 Ready for review**

Update the PR body with scope, protocol details, compatibility model, verification evidence, exact changed paths, PR #14 boundary and deferred work. Only then convert the PR from Draft to Ready.
