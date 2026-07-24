import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";
import type { DomainEvent } from "../src/domainEvents.js";

const bootstrapToken = "device-sync-security-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};
const secondCredential = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const adultCredential = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

interface EntryCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
}

interface Initialized {
  family: { familyRef: string };
  owner: { personRef: string };
  device: { deviceRef: string };
  entries: { admin: EntryCredential; personal: EntryCredential };
}

interface ClaimedDevice {
  device: { deviceRef: string; displayName: string };
  entry: EntryCredential;
}

function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function deviceHeaders(deviceRef: string, credential: string): Record<string, string> {
  return {
    authorization: `Device ${credential}`,
    "x-device-ref": deviceRef
  };
}

async function readFirstDomainEvent(response: Response): Promise<DomainEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out reading Device Sync SSE event")), 5000);
      })
    ]);
    if (result.done) throw new Error("SSE stream ended before a domain event arrived");
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (frame.includes("event: domain-event") && data) {
        return JSON.parse(data.slice("data: ".length)) as DomainEvent;
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  throw new Error("Device Sync SSE event did not arrive");
}

describe("Device Sync lifecycle and security", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let initialized: Initialized;
  let appClosed = false;
  let origin = "";
  const controllers: AbortController[] = [];

  async function openApp(): Promise<void> {
    app = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test",
      now: () => new Date("2026-07-24T17:30:00.000Z")
    });
    appClosed = false;
    origin = "";
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-device-sync-security-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
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
    initialized = response.json() as Initialized;
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    if (!appClosed) await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function openChat(entry: EntryCredential): Promise<void> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(entry)
    });
    expect(response.statusCode).toBe(200);
  }

  async function syncEvents(entry: EntryCredential): Promise<{
    sync: {
      deviceRef: string;
      personRef: string;
      acknowledgedSequence: number;
      latestSequence: number;
    };
    events: DomainEvent[];
  }> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(entry)
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      sync: {
        deviceRef: string;
        personRef: string;
        acknowledgedSequence: number;
        latestSequence: number;
      };
      events: DomainEvent[];
    };
  }

  async function acknowledge(entry: EntryCredential, event: DomainEvent): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(entry),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(response.statusCode).toBe(200);
  }

  async function createMember(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(initialized.entries.admin),
      payload: { displayName: "另一位成人", familyRole: "adult" }
    });
    expect(response.statusCode).toBe(201);
    return String(response.json().member.personRef);
  }

  async function pairDevice(input: {
    personRef: string;
    installationId: string;
    credential: string;
    displayName: string;
  }): Promise<ClaimedDevice> {
    const pairing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(input.personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(initialized.entries.admin),
        host: "family-ai-gateway.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(pairing.statusCode).toBe(201);
    const material = pairing.json() as {
      pairing: { pairingRef: string; code: string };
    };

    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      headers: { host: "family-ai-gateway.example.test" },
      payload: {
        protocolVersion: 1,
        pairingRef: material.pairing.pairingRef,
        code: material.pairing.code,
        installationId: input.installationId,
        deviceCredential: input.credential,
        device: {
          displayName: input.displayName,
          terminalType: "mobile",
          platform: "ios",
          systemVersion: "26.0",
          appVersion: "1.0.0",
          model: "iPhone"
        }
      }
    });
    expect(claim.statusCode).toBe(201);
    return claim.json() as ClaimedDevice;
  }

  it("keeps the Cursor across logout, Session renewal and Gateway restart", async () => {
    await openChat(initialized.entries.personal);
    const first = (await syncEvents(initialized.entries.personal)).events[0]!;
    await acknowledge(initialized.entries.personal, first);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/logout",
      headers: deviceHeaders(initialized.device.deviceRef, bootstrapToken)
    });
    expect(logout.statusCode).toBe(200);

    const oldEntry = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(oldEntry.statusCode).toBe(401);

    const renew = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers: deviceHeaders(initialized.device.deviceRef, bootstrapToken)
    });
    expect(renew.statusCode).toBe(200);
    const renewed = (renew.json() as { entry: EntryCredential }).entry;
    expect(renewed.entrySessionRef).not.toBe(initialized.entries.personal.entrySessionRef);

    await app.close();
    appClosed = true;
    await openApp();

    const state = await syncEvents(renewed);
    expect(state.sync).toMatchObject({
      deviceRef: initialized.device.deviceRef,
      personRef: initialized.owner.personRef,
      acknowledgedSequence: 1,
      latestSequence: 1
    });
    expect(state.events).toEqual([]);
  });

  it("keeps two devices for the same Person on independent Cursors", async () => {
    await openChat(initialized.entries.personal);
    const event = (await syncEvents(initialized.entries.personal)).events[0]!;
    await acknowledge(initialized.entries.personal, event);

    const second = await pairDevice({
      personRef: initialized.owner.personRef,
      installationId: "8d3a6168-fef5-4b04-aeef-3bb853f60ea0",
      credential: secondCredential,
      displayName: "第二台 iPhone"
    });
    const secondState = await syncEvents(second.entry);
    expect(secondState.sync).toMatchObject({
      deviceRef: second.device.deviceRef,
      personRef: initialized.owner.personRef,
      acknowledgedSequence: 0,
      latestSequence: 1
    });
    expect(secondState.events.map((item) => item.eventSequence)).toEqual([1]);
    await acknowledge(second.entry, secondState.events[0]!);

    const db = openGatewayDatabase(databasePath);
    try {
      const rows = db.prepare(
        `SELECT device_ref, person_ref, acknowledged_sequence
         FROM device_sync_cursors WHERE person_ref = ? ORDER BY device_ref`
      ).all(initialized.owner.personRef) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => Number(row.acknowledged_sequence) === 1)).toBe(true);
      expect(new Set(rows.map((row) => String(row.device_ref)))).toEqual(new Set([
        initialized.device.deviceRef,
        second.device.deviceRef
      ]));
    } finally {
      db.close();
    }
  });

  it("isolates two Persons, their events and their Device Cursors", async () => {
    const adultPersonRef = await createMember();
    const adult = await pairDevice({
      personRef: adultPersonRef,
      installationId: "f8200926-f8b0-4289-bf20-c28d4590e36d",
      credential: adultCredential,
      displayName: "成人 iPhone"
    });

    await openChat(initialized.entries.personal);
    await openChat(adult.entry);
    const ownerState = await syncEvents(initialized.entries.personal);
    const adultState = await syncEvents(adult.entry);

    expect(ownerState.events).toHaveLength(1);
    expect(adultState.events).toHaveLength(1);
    expect(ownerState.events[0]?.personRef).toBe(initialized.owner.personRef);
    expect(adultState.events[0]?.personRef).toBe(adultPersonRef);
    expect(JSON.stringify(ownerState)).not.toContain(adultPersonRef);
    expect(JSON.stringify(adultState)).not.toContain(initialized.owner.personRef);

    await acknowledge(initialized.entries.personal, ownerState.events[0]!);
    await acknowledge(adult.entry, adultState.events[0]!);

    const db = openGatewayDatabase(databasePath);
    try {
      const rows = db.prepare(
        `SELECT device_ref, person_ref, acknowledged_sequence
         FROM device_sync_cursors ORDER BY person_ref, device_ref`
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          device_ref: initialized.device.deviceRef,
          person_ref: initialized.owner.personRef,
          acknowledged_sequence: 1
        }),
        expect.objectContaining({
          device_ref: adult.device.deviceRef,
          person_ref: adultPersonRef,
          acknowledged_sequence: 1
        })
      ]));
    } finally {
      db.close();
    }
  });

  it("denies Sync after Device revocation but preserves the stored Cursor", async () => {
    await openChat(initialized.entries.personal);
    const event = (await syncEvents(initialized.entries.personal)).events[0]!;
    await acknowledge(initialized.entries.personal, event);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/devices/${encodeURIComponent(initialized.device.deviceRef)}`,
      headers: entryHeaders(initialized.entries.admin)
    });
    expect(revoke.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(get.statusCode).toBe(403);
    expect(get.json()).toMatchObject({ code: "DEVICE_REVOKED" });

    const ack = await app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(initialized.entries.personal),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(ack.statusCode).toBe(403);
    expect(ack.json()).toMatchObject({ code: "DEVICE_REVOKED" });

    const db = openGatewayDatabase(databasePath);
    try {
      expect(db.prepare(
        `SELECT acknowledged_sequence FROM device_sync_cursors
         WHERE device_ref = ? AND person_ref = ?`
      ).get(initialized.device.deviceRef, initialized.owner.personRef))
        .toEqual({ acknowledged_sequence: 1 });
    } finally {
      db.close();
    }
  });

  it("does not ACK when SSE or GET delivers an event", async () => {
    await openChat(initialized.entries.personal);
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/v1/events/stream?afterSequence=0`, {
      headers: entryHeaders(initialized.entries.personal),
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    const event = await readFirstDomainEvent(response);
    expect(event.eventSequence).toBe(1);

    const fetched = await syncEvents(initialized.entries.personal);
    expect(fetched.events.map((item) => item.eventSequence)).toEqual([1]);

    const db = openGatewayDatabase(databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
    controller.abort();
  });
});
