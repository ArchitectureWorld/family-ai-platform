import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "event-stream-live-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

interface SseFrame {
  raw: string;
  id: number | null;
  event: string | null;
  data: Record<string, unknown> | null;
}

function entryHeaders(entry: EntryCredential): Record<string, string> {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out during SSE integration test")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseFrame(raw: string): SseFrame {
  let id: number | null = null;
  let event: string | null = null;
  let data: Record<string, unknown> | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice("id: ".length));
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    if (line.startsWith("data: ")) {
      data = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
    }
  }
  return { raw, id, event, data };
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    this.reader = reader;
  }

  async nextFrame(): Promise<SseFrame> {
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        return parseFrame(raw);
      }
      const result = await withTimeout(this.reader.read());
      if (result.done) throw new Error(`SSE stream ended with buffered data: ${this.buffer}`);
      this.buffer += this.decoder
        .decode(result.value, { stream: true })
        .replaceAll("\r\n", "\n");
    }
  }

  async nextDomainEvents(count: number): Promise<SseFrame[]> {
    const events: SseFrame[] = [];
    while (events.length < count) {
      const frame = await this.nextFrame();
      if (frame.event === "domain-event") events.push(frame);
    }
    return events;
  }
}

describe("Chat Work live SSE delivery", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let personal: EntryCredential;
  let origin = "";
  let appClosed = false;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-event-stream-live-"));
    databasePath = join(directory, "gateway.sqlite");
    origin = "";
    appClosed = false;
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T13:30:00.000Z")
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
    personal = (onboarding.json() as {
      entries: { personal: EntryCredential };
    }).entries.personal;
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    if (!appClosed) await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function listen(): Promise<void> {
    if (!origin) origin = await app.listen({ host: "127.0.0.1", port: 0 });
  }

  async function openStream(afterSequence: number): Promise<{
    response: Response;
    reader: SseReader;
    controller: AbortController;
  }> {
    await listen();
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(
      `${origin}/api/v1/events/stream?afterSequence=${afterSequence}`,
      {
        headers: entryHeaders(personal),
        signal: controller.signal
      }
    );
    expect(response.status).toBe(200);
    return { response, reader: new SseReader(response), controller };
  }

  async function openChat(): Promise<{ threadRef: string }> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(response.statusCode).toBe(200);
    return response.json().chat as { threadRef: string };
  }

  it("streams Person, Assistant and Provider-success events in order without message text", async () => {
    const chat = await openChat();
    const { reader } = await openStream(1);
    const connected = await reader.nextFrame();
    expect(connected.raw).toContain(": connected");
    expect(connected.id).toBeNull();

    const personText = "这段用户正文绝对不能进入 SSE 事件。";
    const send = await fetch(
      `${origin}/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      {
        method: "POST",
        headers: {
          ...entryHeaders(personal),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          protocolVersion: 1,
          clientMessageId: "event-stream-live-message-0001",
          occurredAt: "2026-07-24T13:30:01.000Z",
          content: { type: "text", text: personText, language: "zh-CN" }
        })
      }
    );
    expect(send.status).toBe(201);

    const events = await reader.nextDomainEvents(3);
    expect(events.map((frame) => frame.id)).toEqual([2, 3, 4]);
    expect(events.map((frame) => frame.data?.eventType)).toEqual([
      "thread.message.created",
      "thread.message.created",
      "thread.provider_turn.succeeded"
    ]);
    expect(events[0]?.data?.payload).toMatchObject({ actorType: "person" });
    expect(events[1]?.data?.payload).toMatchObject({ actorType: "assistant" });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(personText);
    expect(serialized).not.toContain("Fake Provider");
    expect(serialized).not.toContain("external-session:");
    expect(serialized).not.toContain(personal.token);

    const eventRefs = events.map((frame) => String(frame.data?.eventRef));
    const placeholders = eventRefs.map(() => "?").join(", ");
    const db = openGatewayDatabase(databasePath);
    try {
      const outboxRows = db.prepare(
        `SELECT event_ref, status, published_at
         FROM outbox_events
         WHERE event_ref IN (${placeholders})
         ORDER BY event_ref`
      ).all(...eventRefs) as Array<{
        event_ref: string;
        status: string;
        published_at: string | null;
      }>;
      expect(outboxRows).toHaveLength(3);
      expect(outboxRows.every((row) =>
        row.status === "pending" && row.published_at === null
      )).toBe(true);
    } finally {
      db.close();
    }
  });

  it("closes active SSE responses before completing Gateway shutdown", async () => {
    await openChat();
    const { reader, controller } = await openStream(1);
    const connected = await reader.nextFrame();
    expect(connected.raw).toContain(": connected");

    const closePromise = app.close();
    try {
      await withTimeout(closePromise, 2500);
      appClosed = true;
    } finally {
      if (!appClosed) {
        controller.abort();
        await closePromise;
        appClosed = true;
      }
    }
  });
});
