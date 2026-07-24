import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  SYNC_PROTOCOL_VERSION,
  syncAckRequestSchema,
  syncAckResponseSchema,
  syncEventsResponseSchema
} from "@family-ai/contracts";
import { buildGatewayApp } from "../src/app.js";
import type { DeviceSyncRepository } from "../src/deviceSync.js";
import { registerDeviceSyncRoutes } from "../src/deviceSyncRoutes.js";
import type { DomainEventStore } from "../src/domainEvents.js";
import type { EntrySessionAuthenticator } from "../src/entrySessionAuth.js";

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
        })
      } as unknown as DomainEventStore,
      entryAuthenticator: {
        authenticate: () => ({
          status: "authenticated",
          context: {
            audience: "personal",
            person: { personRef: "person:alice" },
            device: { deviceRef: "device:web-alice" }
          }
        })
      } as unknown as EntrySessionAuthenticator
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
});
