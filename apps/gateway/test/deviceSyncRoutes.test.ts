import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";
import { DomainEventStore, type DomainEvent } from "../src/domainEvents.js";

const deviceToken = "device-sync-routes-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
}

interface OnboardingBody {
  owner: { personRef: string };
  device: { deviceRef: string };
  entries: { admin: EntryCredential; personal: EntryCredential };
}

function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function expectPublicError(
  response: { json(): unknown },
  expected: { code: string; category: string; retryable: boolean }
): void {
  const body = response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ...expected, message: expect.any(String) });
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("protocolVersion");
}

describe("Device Sync HTTP routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let onboarding: OnboardingBody;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T17:00:00.000Z")
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    onboarding = response.json() as OnboardingBody;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function openChat(): Promise<void> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(onboarding.entries.personal)
    });
    expect(response.statusCode).toBe(200);
  }

  async function getEvents(url = "/api/v1/sync/events") {
    return app.inject({
      method: "GET",
      url,
      headers: entryHeaders(onboarding.entries.personal)
    });
  }

  it("requires a Personal Entry Session and rejects malformed query inputs", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/v1/sync/events" });
    expect(missing.statusCode).toBe(401);
    expectPublicError(missing, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    const admin = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(onboarding.entries.admin)
    });
    expect(admin.statusCode).toBe(403);
    expectPublicError(admin, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });

    for (const url of [
      "/api/v1/sync/events?afterSequence=-1",
      "/api/v1/sync/events?afterSequence=1.5",
      "/api/v1/sync/events?afterSequence=9007199254740992",
      "/api/v1/sync/events?limit=0",
      "/api/v1/sync/events?limit=201",
      "/api/v1/sync/events?unknown=1",
      "/api/v1/sync/events?limit=1&limit=2"
    ]) {
      const invalid = await getEvents(url);
      expect(invalid.statusCode).toBe(400);
      expectPublicError(invalid, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }
  });

  it("defaults to the durable Cursor, permits explicit replay and never auto-ACKs", async () => {
    await openChat();
    const initial = await getEvents();
    expect(initial.statusCode).toBe(200);
    const firstBody = initial.json() as {
      protocolVersion: number;
      sync: Record<string, unknown>;
      events: DomainEvent[];
      nextAfterSequence: number | null;
    };
    expect(firstBody).toMatchObject({
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
    expect(firstBody.events.map((event) => event.eventSequence)).toEqual([1]);
    expect(JSON.stringify(firstBody)).not.toContain(onboarding.entries.personal.token);

    const db = openGatewayDatabase(databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }

    const event = firstBody.events[0]!;
    const ack = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(onboarding.entries.personal),
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
        acknowledgedSequence: 1,
        advanced: true,
        updatedAt: "2026-07-24T17:00:00.000Z"
      }
    });

    const defaultCatchUp = await getEvents();
    expect(defaultCatchUp.statusCode).toBe(200);
    expect(defaultCatchUp.json()).toMatchObject({
      sync: {
        acknowledgedSequence: 1,
        requestedAfterSequence: 1,
        latestSequence: 1
      },
      events: [],
      nextAfterSequence: null
    });

    const replay = await getEvents("/api/v1/sync/events?afterSequence=0");
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { events: DomainEvent[] }).events.map(
      (item) => item.eventSequence
    )).toEqual([1]);

    const verify = openGatewayDatabase(databasePath);
    try {
      expect(verify.prepare(
        `SELECT acknowledged_sequence FROM device_sync_cursors
         WHERE device_ref = ? AND person_ref = ?`
      ).get(onboarding.device.deviceRef, onboarding.owner.personRef))
        .toEqual({ acknowledged_sequence: 1 });
    } finally {
      verify.close();
    }
  });

  it("paginates more than 200 events in strict order without changing the Cursor", async () => {
    const db = openGatewayDatabase(databasePath);
    try {
      const events = new DomainEventStore(
        db,
        () => new Date("2026-07-24T17:01:00.000Z")
      );
      for (let index = 1; index <= 205; index += 1) {
        events.append({
          personRef: onboarding.owner.personRef,
          eventType: `test.sync.page.${index}`,
          aggregateType: "work",
          aggregateRef: `work:sync-page-${index}`,
          payload: { index },
          occurredAt: "2026-07-24T17:01:00.000Z"
        });
      }
    } finally {
      db.close();
    }

    const first = await getEvents("/api/v1/sync/events?afterSequence=0&limit=200");
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      events: DomainEvent[];
      nextAfterSequence: number | null;
    };
    expect(firstBody.events.map((event) => event.eventSequence))
      .toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(firstBody.nextAfterSequence).toBe(200);

    const second = await getEvents(
      `/api/v1/sync/events?afterSequence=${String(firstBody.nextAfterSequence)}&limit=200`
    );
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      events: DomainEvent[];
      nextAfterSequence: number | null;
    };
    expect(secondBody.events.map((event) => event.eventSequence)).toEqual([201, 202, 203, 204, 205]);
    expect(secondBody.nextAfterSequence).toBeNull();

    const verify = openGatewayDatabase(databasePath);
    try {
      expect(verify.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
        .toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });

  it("strictly validates ACK identity and keeps replay responses idempotent", async () => {
    await openChat();
    const events = await getEvents();
    const event = (events.json() as { events: DomainEvent[] }).events[0]!;

    for (const extra of [
      { deviceRef: onboarding.device.deviceRef },
      { personRef: onboarding.owner.personRef },
      { entrySessionRef: onboarding.entries.personal.entrySessionRef },
      { acknowledgedSequence: 1 }
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/sync/ack",
        headers: entryHeaders(onboarding.entries.personal),
        payload: {
          protocolVersion: 1,
          eventSequence: event.eventSequence,
          eventRef: event.eventRef,
          ...extra
        }
      });
      expect(invalid.statusCode).toBe(400);
      expectPublicError(invalid, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(onboarding.entries.personal),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(onboarding.entries.personal),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      sync: {
        previousSequence: 1,
        acknowledgedSequence: 1,
        advanced: false,
        updatedAt: "2026-07-24T17:00:00.000Z"
      }
    });

    for (const payload of [
      { protocolVersion: 1, eventSequence: event.eventSequence, eventRef: "event:not-found" },
      { protocolVersion: 1, eventSequence: event.eventSequence + 1, eventRef: event.eventRef }
    ]) {
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/sync/ack",
        headers: entryHeaders(onboarding.entries.personal),
        payload
      });
      expect(missing.statusCode).toBe(404);
      expectPublicError(missing, {
        code: "SYNC_EVENT_NOT_FOUND",
        category: "permission",
        retryable: false
      });
    }

    const member = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(onboarding.entries.admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(member.statusCode).toBe(201);
    const adultPersonRef = String(member.json().member.personRef);
    const db = openGatewayDatabase(databasePath);
    let adultEvent: DomainEvent;
    try {
      adultEvent = new DomainEventStore(
        db,
        () => new Date("2026-07-24T17:02:00.000Z")
      ).append({
        personRef: adultPersonRef,
        eventType: "test.sync.cross-person",
        aggregateType: "work",
        aggregateRef: "work:sync-cross-person",
        payload: {},
        occurredAt: "2026-07-24T17:02:00.000Z"
      });
    } finally {
      db.close();
    }
    const crossPerson = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(onboarding.entries.personal),
      payload: {
        protocolVersion: 1,
        eventSequence: adultEvent.eventSequence,
        eventRef: adultEvent.eventRef
      }
    });
    expect(crossPerson.statusCode).toBe(404);
    expectPublicError(crossPerson, {
      code: "SYNC_EVENT_NOT_FOUND",
      category: "permission",
      retryable: false
    });

    const deviceHeader = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: {
        authorization: "Device invalid-device-credential",
        "x-device-ref": onboarding.device.deviceRef
      }
    });
    expect(deviceHeader.statusCode).toBe(401);
    expectPublicError(deviceHeader, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });
  });
});
