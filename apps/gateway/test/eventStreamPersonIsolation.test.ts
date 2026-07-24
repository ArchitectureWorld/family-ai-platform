import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase, sha256 } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const deviceToken = "event-stream-isolation-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

async function readDomainEvent(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out reading isolated SSE event")), 5000);
      })
    ]);
    if (result.done) throw new Error("SSE stream ended before a domain event arrived");
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (frame.includes("event: domain-event") && dataLine) {
        return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  throw new Error("SSE domain event did not arrive before the deadline");
}

describe("Chat Work SSE Person isolation", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let owner: EntryCredential;
  let second: EntryCredential;
  let ownerPersonRef = "";
  let secondPersonRef = "";
  let familyRef = "";
  let origin = "";
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-event-stream-isolation-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T14:00:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      family: { familyRef: string };
      owner: { personRef: string };
      entries: { personal: EntryCredential };
    };
    familyRef = body.family.familyRef;
    ownerPersonRef = body.owner.personRef;
    owner = body.entries.personal;

    await app.close();
    const db = openGatewayDatabase(databasePath);
    try {
      const familyRepository = new FamilyDomainRepository(db);
      secondPersonRef = familyRepository.createMember({
        familyRef,
        displayName: "另一位成人",
        familyRole: "adult"
      }).personRef;

      const now = "2026-07-24T14:00:00.000Z";
      const deviceRef = `device:${randomUUID()}`;
      const deviceBindingRef = `device-binding:${randomUUID()}`;
      const entryBindingRef = `entry-binding:${randomUUID()}`;
      const entrySessionRef = `entry-session:${randomUUID()}`;
      const token = randomBytes(32).toString("base64url");
      db.transaction(() => {
        db.prepare(
          `INSERT INTO managed_devices
           (device_ref, display_name, terminal_type, platform, status, credential_hash,
            created_at, updated_at, revoked_at)
           VALUES(?, 'Second Web', 'web', 'test', 'active', ?, ?, ?, NULL)`
        ).run(deviceRef, sha256("second-device-credential"), now, now);
        db.prepare(
          `INSERT INTO device_bindings
           (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
            status, bound_at, revoked_at)
           VALUES(?, ?, 'person', ?, ?, 'active', ?, NULL)`
        ).run(deviceBindingRef, deviceRef, familyRef, secondPersonRef, now);
        db.prepare(
          `INSERT INTO entry_bindings
           (entry_binding_ref, device_ref, family_ref, person_ref, audience, status,
            bound_at, last_used_at)
           VALUES(?, ?, ?, ?, 'personal', 'active', ?, NULL)`
        ).run(entryBindingRef, deviceRef, familyRef, secondPersonRef, now);
        db.prepare(
          `INSERT INTO entry_sessions
           (entry_session_ref, entry_binding_ref, token_hash, status,
            created_at, expires_at, revoked_at)
           VALUES(?, ?, ?, 'active', ?, '2026-08-24T14:00:00.000Z', NULL)`
        ).run(entrySessionRef, entryBindingRef, sha256(token), now);
      })();
      second = { entrySessionRef, token };
    } finally {
      db.close();
    }

    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T14:00:00.000Z")
    });
    origin = "";
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await app.close();
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

  async function openStream(entry: EntryCredential): Promise<Response> {
    if (!origin) origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${origin}/api/v1/events/stream?afterSequence=0`, {
      headers: entryHeaders(entry),
      signal: controller.signal
    });
  }

  it("delivers only the authenticated Person's durable event stream", async () => {
    await openChat(owner);
    await openChat(second);

    const [ownerResponse, secondResponse] = await Promise.all([
      openStream(owner),
      openStream(second)
    ]);
    expect(ownerResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const [ownerEvent, secondEvent] = await Promise.all([
      readDomainEvent(ownerResponse),
      readDomainEvent(secondResponse)
    ]);
    expect(ownerEvent).toMatchObject({
      personRef: ownerPersonRef,
      eventSequence: 1,
      eventType: "chat.home.created"
    });
    expect(secondEvent).toMatchObject({
      personRef: secondPersonRef,
      eventSequence: 1,
      eventType: "chat.home.created"
    });
    expect(JSON.stringify(ownerEvent)).not.toContain(secondPersonRef);
    expect(JSON.stringify(secondEvent)).not.toContain(ownerPersonRef);
  });
});
