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
