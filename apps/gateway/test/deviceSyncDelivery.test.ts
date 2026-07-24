import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase } from "../src/database.js";
import type { DomainEvent } from "../src/domainEvents.js";
import {
  DeviceSyncHarness,
  entryHeaders
} from "./deviceSyncTestSupport.js";

async function withTimeout<T>(work: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out reading Device Sync SSE event")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readFirstDomainEvent(response: Response): Promise<DomainEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await withTimeout(reader.read());
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
}

describe("Device Sync revocation and delivery boundaries", () => {
  let harness: DeviceSyncHarness;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    harness = new DeviceSyncHarness();
    await harness.start();
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await harness.dispose();
  });

  it("denies Sync after Device revocation but preserves the stored Cursor", async () => {
    await harness.openChat(harness.initialized.entries.personal);
    const event = (await harness.syncEvents(harness.initialized.entries.personal)).events[0]!;
    await harness.acknowledge(harness.initialized.entries.personal, event);

    const revoke = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/devices/${encodeURIComponent(harness.initialized.device.deviceRef)}`,
      headers: entryHeaders(harness.initialized.entries.admin)
    });
    expect(revoke.statusCode).toBe(200);

    const get = await harness.app.inject({
      method: "GET",
      url: "/api/v1/sync/events",
      headers: entryHeaders(harness.initialized.entries.personal)
    });
    expect(get.statusCode).toBe(403);
    expect(get.json()).toMatchObject({
      code: "DEVICE_REVOKED",
      category: "permission",
      retryable: false
    });

    const ack = await harness.app.inject({
      method: "POST",
      url: "/api/v1/sync/ack",
      headers: entryHeaders(harness.initialized.entries.personal),
      payload: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    });
    expect(ack.statusCode).toBe(403);
    expect(ack.json()).toMatchObject({ code: "DEVICE_REVOKED" });

    const db = openGatewayDatabase(harness.databasePath);
    try {
      expect(db.prepare(
        `SELECT acknowledged_sequence FROM device_sync_cursors
         WHERE device_ref = ? AND person_ref = ?`
      ).get(
        harness.initialized.device.deviceRef,
        harness.initialized.owner.personRef
      )).toEqual({ acknowledged_sequence: 1 });
    } finally {
      db.close();
    }
  });

  it("does not ACK when SSE or GET delivers an event", async () => {
    await harness.openChat(harness.initialized.entries.personal);
    const origin = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/api/v1/events/stream?afterSequence=0`, {
      headers: entryHeaders(harness.initialized.entries.personal),
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    const event = await readFirstDomainEvent(response);
    expect(event.eventSequence).toBe(1);

    const fetched = await harness.syncEvents(harness.initialized.entries.personal);
    expect(fetched.events.map((item) => item.eventSequence)).toEqual([1]);

    const db = openGatewayDatabase(harness.databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM device_sync_cursors").get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
    controller.abort();
  });
});
