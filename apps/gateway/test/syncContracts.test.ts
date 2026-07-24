import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  SYNC_PROTOCOL_VERSION,
  SYNC_SSE_EVENT_NAME,
  syncAckRequestSchema,
  syncAckResponseSchema,
  syncEventsResponseSchema,
  syncSseDataSchema
} from "@family-ai/contracts";
import { buildGatewayApp } from "../src/app.js";
import type { DeviceSyncRepository } from "../src/deviceSync.js";
import { registerDeviceSyncRoutes } from "../src/deviceSyncRoutes.js";
import type { DomainEvent, DomainEventStore } from "../src/domainEvents.js";
import type { EntrySessionAuthenticator } from "../src/entrySessionAuth.js";
import {
  PersonEventStreamHub,
  formatDomainEventFrame,
  type EventStreamSink,
  type PersonEventSource
} from "../src/eventStream.js";

const deviceToken = "sync-contract-bootstrap-device-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type EntryCredential = {
  entrySessionRef: string;
  token: string;
};

type Onboarding = {
  entries: { personal: EntryCredential };
};

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function personalAuthenticator(): EntrySessionAuthenticator {
  return {
    authenticate: () => ({
      status: "authenticated",
      context: {
        audience: "personal",
        person: { personRef: "person:alice" },
        device: { deviceRef: "device:web-alice" }
      }
    })
  } as unknown as EntrySessionAuthenticator;
}

const canonicalMessageEvent = {
  eventRef: "event:alice-message-0001",
  personRef: "person:alice",
  eventSequence: 3,
  eventType: "thread.message.created",
  aggregateType: "thread_message",
  aggregateRef: "message:alice-0001",
  threadRef: "thread:alice-home-chat",
  payload: {
    messageRef: "message:alice-0001",
    threadRef: "thread:alice-home-chat",
    threadSequence: 1,
    actorType: "person",
    clientMessageId: "web-alice-0001"
  },
  occurredAt: "2026-07-24T18:01:00.000Z",
  createdAt: "2026-07-24T18:01:00.000Z"
} as const;

describe("Gateway Event Sync REST contract integration", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("returns catch-up and ACK payloads accepted by the public contracts", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-sync-contracts-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T18:00:00.000Z")
    });

    const onboardingResponse = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(onboardingResponse.statusCode).toBe(201);
    const onboarding = onboardingResponse.json() as Onboarding;

    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(onboarding.entries.personal)
    });
    expect(chat.statusCode).toBe(200);

    const catchUp = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events?afterSequence=000&limit=020",
      headers: entryHeaders(onboarding.entries.personal)
    });
    expect(catchUp.statusCode).toBe(200);
    const catchUpBody = syncEventsResponseSchema.parse(catchUp.json());
    expect(catchUpBody.sync.requestedAfterSequence).toBe(0);
    expect(catchUpBody.events).toHaveLength(1);

    const event = catchUpBody.events[0]!;
    const request = syncAckRequestSchema.parse({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      eventSequence: event.eventSequence,
      eventRef: event.eventRef
    });
    const ack = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(onboarding.entries.personal),
      payload: request
    });
    expect(ack.statusCode).toBe(200);
    expect(syncAckResponseSchema.parse(ack.json()).sync.acknowledgedSequence)
      .toBe(event.eventSequence);
  });

  it("rejects an outbound catch-up response that crosses Person ownership", async () => {
    const testApp = Fastify({ logger: false });
    testApp.setErrorHandler((_error, _request, reply) => reply.code(500).send({
      code: "TEST_OUTBOUND_CONTRACT_INVALID"
    }));

    registerDeviceSyncRoutes(testApp, {
      repository: {
        readCursor: () => ({
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 0,
          latestSequence: 1,
          createdAt: null,
          updatedAt: null
        }),
        acknowledge: () => null
      } as unknown as DeviceSyncRepository,
      events: {
        listPersonEvents: () => ({
          events: [{
            eventRef: "event:bob-notification-0001",
            personRef: "person:bob",
            eventSequence: 1,
            eventType: "notification.created",
            aggregateType: "notification",
            aggregateRef: "notification:bob-0001",
            threadRef: null,
            payload: { notificationRef: "notification:bob-0001" },
            occurredAt: "2026-07-24T18:00:00.000Z",
            createdAt: "2026-07-24T18:00:00.000Z"
          }],
          nextAfterSequence: null
        }),
        getLatestPersonSequence: () => 1
      } as unknown as DomainEventStore,
      entryAuthenticator: personalAuthenticator()
    });

    try {
      const response = await testApp.inject({
        method: "GET",
        url: "/api/v1/sync/events",
        headers: {
          authorization: "Bearer test-entry-token",
          "x-entry-session-ref": "entry-session:test"
        }
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "TEST_OUTBOUND_CONTRACT_INVALID" });
    } finally {
      await testApp.close();
    }
  });

  it("refreshes latestSequence after reading a catch-up page", async () => {
    const testApp = Fastify({ logger: false });
    testApp.setErrorHandler((_error, _request, reply) => reply.code(500).send({
      code: "TEST_OUTBOUND_CONTRACT_INVALID"
    }));

    const concurrentEvent = {
      ...canonicalMessageEvent,
      eventRef: "event:alice-message-0002",
      eventSequence: 2,
      aggregateRef: "message:alice-0002",
      payload: {
        ...canonicalMessageEvent.payload,
        messageRef: "message:alice-0002",
        threadSequence: 2,
        clientMessageId: "web-alice-0002"
      }
    } as DomainEvent;

    registerDeviceSyncRoutes(testApp, {
      repository: {
        readCursor: () => ({
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 0,
          latestSequence: 1,
          createdAt: null,
          updatedAt: null
        }),
        acknowledge: () => null
      } as unknown as DeviceSyncRepository,
      events: {
        listPersonEvents: () => ({
          events: [concurrentEvent],
          nextAfterSequence: null
        }),
        getLatestPersonSequence: () => 2
      } as unknown as DomainEventStore,
      entryAuthenticator: personalAuthenticator()
    });

    try {
      const response = await testApp.inject({
        method: "GET",
        url: "/api/v1/sync/events",
        headers: {
          authorization: "Bearer test-entry-token",
          "x-entry-session-ref": "entry-session:test"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(syncEventsResponseSchema.parse(response.json()).sync.latestSequence).toBe(2);
    } finally {
      await testApp.close();
    }
  });
});

class RecordingSink implements EventStreamSink {
  readonly frames: string[] = [];

  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }

  once(_event: "drain", _listener: () => void): this {
    return this;
  }

  end(): void {}
  destroy(): void {}
}

describe("Gateway Event Sync SSE contract integration", () => {
  it("uses the public SSE event name, id and data schema", () => {
    const parsed = syncSseDataSchema.parse(canonicalMessageEvent);
    const frame = formatDomainEventFrame(parsed);
    const lines = frame.trim().split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);

    expect(name).toBe(SYNC_SSE_EVENT_NAME);
    expect(Number(id)).toBe(parsed.eventSequence);
    expect(syncSseDataSchema.parse(JSON.parse(data ?? "null"))).toEqual(parsed);
  });

  it("refuses to serialize a malformed known event", () => {
    const malformed = {
      ...canonicalMessageEvent,
      payload: { workConversationRef: "work:wrong-payload" }
    } as unknown as DomainEvent;
    expect(() => formatDomainEventFrame(malformed)).toThrow();
  });

  it("does not advance a Subscriber cursor when event validation fails", async () => {
    let sourceEvent: DomainEvent = {
      ...canonicalMessageEvent,
      payload: { workConversationRef: "work:wrong-payload" }
    } as unknown as DomainEvent;
    const calls: number[] = [];
    const source: PersonEventSource = {
      listPersonEvents: (input) => {
        const afterSequence = input.afterSequence ?? 0;
        calls.push(afterSequence);
        return {
          events: afterSequence < sourceEvent.eventSequence ? [sourceEvent] : [],
          nextAfterSequence: null
        };
      }
    };
    const hub = new PersonEventStreamHub(
      source,
      {
        authenticate: () => ({
          status: "authenticated",
          context: {
            audience: "personal",
            person: { personRef: "person:alice" }
          }
        })
      },
      { autoStart: false }
    );
    const sink = new RecordingSink();
    hub.register({
      personRef: "person:alice",
      cursor: 0,
      entrySessionRef: "entry-session:alice",
      token: "entry-token-alice",
      sink
    });

    try {
      await expect(hub.pumpPerson("person:alice")).rejects.toThrow();
      sourceEvent = canonicalMessageEvent as DomainEvent;
      await hub.pumpPerson("person:alice");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual([0, 0]);
      expect(sink.frames.join("\n")).toContain("id: 3");
    } finally {
      await hub.close();
    }
  });
});
