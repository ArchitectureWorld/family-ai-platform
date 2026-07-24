import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_SYNC_EVENT_TYPES,
  SYNC_PROTOCOL_VERSION,
  knownSyncEventSchema,
  opaqueSyncEventSchema,
  syncAckRequestSchema,
  syncAckResponseSchema,
  syncEventSchema,
  syncEventsQuerySchema,
  syncEventsResponseSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/sync/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
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
      const value = fixture(name);
      expect(knownSyncEventSchema.parse(value)).toEqual(value);
      expect(syncEventSchema.parse(value)).toEqual(value);
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

    const payloads: unknown[] = [
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date() },
      { value: () => "not-json" }
    ];
    for (const payload of payloads) {
      expect(syncEventSchema.safeParse({ ...opaque, payload }).success).toBe(false);
    }
  });
});

describe("Event Sync v1 catch-up and ACK", () => {
  it("normalizes strict decimal query input while preserving leading-zero compatibility", () => {
    expect(syncEventsQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(syncEventsQuerySchema.parse({ afterSequence: "001", limit: "020" })).toEqual({
      afterSequence: 1,
      limit: 20
    });
    expect(syncEventsQuerySchema.parse({ afterSequence: "0", limit: "1" })).toEqual({
      afterSequence: 0,
      limit: 1
    });
  });

  it("rejects malformed, repeated and unknown query values", () => {
    for (const query of [
      { afterSequence: "-1" },
      { afterSequence: "1.5" },
      { afterSequence: "1e3" },
      { afterSequence: " 1" },
      { afterSequence: "9007199254740992" },
      { limit: "0" },
      { limit: "201" },
      { limit: ["1", "2"] },
      { unknown: "1" }
    ]) {
      expect(syncEventsQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts canonical catch-up and ACK fixtures", () => {
    expect(SYNC_PROTOCOL_VERSION).toBe(1);
    expect(syncEventsResponseSchema.parse(fixture("sync-events-response.json"))).toBeTruthy();
    expect(syncAckRequestSchema.parse(fixture("sync-ack-request.json"))).toBeTruthy();
    expect(syncAckResponseSchema.parse(fixture("sync-ack-response.json"))).toBeTruthy();
  });

  it("keeps catch-up events within one Person and strict sequence order", () => {
    const response = fixture("sync-events-response.json") as {
      sync: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
      nextAfterSequence: number | null;
    };
    expect(syncEventsResponseSchema.safeParse({
      ...response,
      events: response.events.map((event, index) => index === 1
        ? { ...event, personRef: "person:bob" }
        : event)
    }).success).toBe(false);
    expect(syncEventsResponseSchema.safeParse({
      ...response,
      events: [response.events[1], response.events[0], ...response.events.slice(2)]
    }).success).toBe(false);
    expect(syncEventsResponseSchema.safeParse({
      ...response,
      nextAfterSequence: 6
    }).success).toBe(false);
    expect(syncEventsResponseSchema.safeParse({
      ...response,
      sync: { ...response.sync, acknowledgedSequence: 8 }
    }).success).toBe(false);
  });

  it("rejects trusted identity fields in ACK requests", () => {
    const request = fixture("sync-ack-request.json") as Record<string, unknown>;
    for (const extra of [
      { deviceRef: "device:web-alice" },
      { personRef: "person:alice" },
      { entryBindingRef: "entry-binding:alice" },
      { entrySessionRef: "entry-session:alice" },
      { acknowledgedSequence: 7 },
      { updatedAt: "2026-07-24T08:08:00.000Z" }
    ]) {
      expect(syncAckRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it("keeps ACK advancement consistent with its sequence values", () => {
    const response = fixture("sync-ack-response.json") as {
      sync: Record<string, unknown>;
    };
    expect(syncAckResponseSchema.safeParse({
      ...response,
      sync: { ...response.sync, advanced: false }
    }).success).toBe(false);
    expect(syncAckResponseSchema.safeParse({
      ...response,
      sync: {
        ...response.sync,
        previousSequence: 7,
        acknowledgedSequence: 7,
        advanced: true
      }
    }).success).toBe(false);
    expect(syncAckResponseSchema.safeParse({
      ...response,
      sync: {
        ...response.sync,
        previousSequence: 8,
        acknowledgedSequence: 7,
        advanced: false
      }
    }).success).toBe(false);
  });
});
