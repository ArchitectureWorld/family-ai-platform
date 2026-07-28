import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { PersonEventStreamHub } from "../src/eventStream.js";

const deviceToken = "event-stream-bootstrap-device-token";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
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

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function cookieValue(cookie: string, name: string): string {
  const encoded = cookie.split("; ")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) throw new Error(`missing ${name}`);
  return decodeURIComponent(encoded);
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

async function readWithTimeout<T>(work: Promise<T>, timeoutMs = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out reading SSE response")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readFrameUntil(
  response: Response,
  predicate: (frame: SseFrame) => boolean
): Promise<SseFrame> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no readable body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await readWithTimeout(reader.read());
    if (result.done) throw new Error(`SSE stream ended before expected frame: ${buffer}`);
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const frame = parseFrame(raw);
      if (predicate(frame)) return frame;
      separator = buffer.indexOf("\n\n");
    }
  }
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

describe("Chat Work SSE HTTP route", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personal: EntryCredential;
  let ownerPersonRef = "";
  let origin = "";
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    origin = "";
    directory = mkdtempSync(join(tmpdir(), "family-ai-event-stream-routes-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      configuredAgentRuntimes: [{
        agentRef: "agent:personal-assistant",
        displayName: "个人助理",
        providerProfileRef: "provider-profile:fake-local",
        providerKind: "fake"
      }],
      now: () => new Date("2026-07-24T12:00:00.000Z")
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
      owner: { personRef: string };
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    ownerPersonRef = body.owner.personRef;
    admin = body.entries.admin;
    personal = body.entries.personal;
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function listen(): Promise<void> {
    if (origin) return;
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  }

  async function fetchStream(
    path: string,
    headers: Record<string, string> = entryHeaders(personal)
  ): Promise<{ response: Response; controller: AbortController }> {
    await listen();
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}${path}`, {
      headers,
      signal: controller.signal
    });
    return { response, controller };
  }

  async function claimBrowserCookie(): Promise<string> {
    const pairing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(ownerPersonRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(admin),
        host: "family.example",
        "x-forwarded-proto": "https"
      }
    });
    expect(pairing.statusCode).toBe(201);
    const material = pairing.json() as {
      pairing: { pairingRef: string; code: string };
    };
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/pairing/claim",
      headers: { "x-family-ai-web-request": "1" },
      payload: {
        protocolVersion: 2,
        pairingRef: material.pairing.pairingRef,
        code: material.pairing.code,
        installationId: "a378ea35-4cab-4bb9-a2ac-fc66320854db",
        deviceCredential,
        device: {
          displayName: "SSE 路由浏览器",
          browser: "Firefox 142",
          operatingSystem: "Linux",
          appVersion: "0.1.0"
        }
      }
    });
    expect(claim.statusCode).toBe(204);
    return cookieHeader(claim.headers["set-cookie"]);
  }

  it("requires a Personal Entry Session and keeps pre-stream errors in PublicError form", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/v1/events/stream" });
    expect(missing.statusCode).toBe(401);
    expectPublicError(missing, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    const familyAdmin = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream",
      headers: entryHeaders(admin)
    });
    expect(familyAdmin.statusCode).toBe(403);
    expectPublicError(familyAdmin, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });

    const deviceHeader = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream",
      headers: {
        authorization: "Device invalid-device-credential",
        "x-device-ref": "device:test"
      }
    });
    expect(deviceHeader.statusCode).toBe(401);
    expectPublicError(deviceHeader, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });
  });

  it("rejects malformed, conflicting and unknown Cursor inputs before streaming", async () => {
    for (const request of [
      { url: "/api/v1/events/stream?afterSequence=-1" },
      { url: "/api/v1/events/stream?unknown=1" },
      {
        url: "/api/v1/events/stream?afterSequence=1",
        headers: { ...entryHeaders(personal), "last-event-id": "2" }
      }
    ]) {
      const response = await app.inject({
        method: "GET",
        url: request.url,
        headers: request.headers ?? entryHeaders(personal)
      });
      expect(response.statusCode).toBe(400);
      expectPublicError(response, {
        code: "REQUEST_INVALID",
        category: "validation",
        retryable: false
      });
    }
  });

  it("returns SSE headers and backfills durable events after an exclusive query Cursor", async () => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(chat.statusCode).toBe(200);

    const { response } = await fetchStream("/api/v1/events/stream?afterSequence=0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const frame = await readFrameUntil(response, (candidate) => candidate.event === "domain-event");
    expect(frame.id).toBe(1);
    expect(frame.data).toMatchObject({
      eventSequence: 1,
      eventType: "chat.home.created"
    });
  });

  it("uses Last-Event-ID as an exclusive reconnect Cursor", async () => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(chat.statusCode).toBe(200);
    const work = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        agentRef: "agent:personal-assistant",
        title: "SSE Work",
        goal: "验证 Last-Event-ID 恢复"
      }
    });
    expect(work.statusCode).toBe(201);

    const { response } = await fetchStream("/api/v1/events/stream", {
      ...entryHeaders(personal),
      "last-event-id": "1"
    });
    const frame = await readFrameUntil(response, (candidate) => candidate.event === "domain-event");
    expect(frame.id).toBe(2);
    expect(frame.data).toMatchObject({
      eventSequence: 2,
      eventType: "work.created"
    });
  });

  it("keeps an initial revoked Cookie request in the pre-flush HTTP cleanup matrix", async () => {
    const cookie = await claimBrowserCookie();
    const deviceRef = cookieValue(cookie, "family_ai_web_device_ref");
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/devices/${encodeURIComponent(deviceRef)}`,
      headers: entryHeaders(admin)
    });
    expect(revoked.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
    const body = response.json() as {
      code?: string;
      error?: { code?: string };
    };
    expect(body.error?.code ?? body.code).toBe("DEVICE_REVOKED");
    const setCookie = response.headers["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(values).toHaveLength(4);
    expect(values.map((value) => value.split("=", 1)[0])).toEqual([
      "family_ai_web_device_ref",
      "family_ai_web_device_credential",
      "family_ai_web_entry_session_ref",
      "family_ai_web_entry_token"
    ]);
    expect(values.every((value) => value.includes("Max-Age=0"))).toBe(true);
    expect(response.body).not.toContain("event: entry-revoked");
    expect(response.headers["content-type"])
      .not.toContain("text/event-stream");

    const explicit = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream",
      headers: {
        cookie,
        authorization: `Bearer ${cookieValue(cookie, "family_ai_web_entry_token")}`,
        "x-entry-session-ref": cookieValue(cookie, "family_ai_web_entry_session_ref")
      }
    });
    expect(explicit.statusCode).toBe(403);
    expect(explicit.headers["set-cookie"]).toBeUndefined();
    expect(explicit.body).not.toContain("event: entry-revoked");
  });

  it("maps Cookie provenance into subscribers while explicit Authorization wins", async () => {
    const cookie = await claimBrowserCookie();
    const registerSpy = vi.spyOn(PersonEventStreamHub.prototype, "register");

    try {
      const cookieStream = await fetchStream("/api/v1/events/stream", { cookie });
      const connected = await readFrameUntil(cookieStream.response, (frame) => frame.raw.includes(": connected"));
      expect(connected.id).toBeNull();
      expect(registerSpy.mock.calls.at(-1)?.[0]).toMatchObject({ authenticationSource: "entry_cookie" });
      cookieStream.controller.abort();

      const explicitStream = await fetchStream(
        "/api/v1/events/stream",
        {
          cookie,
          authorization: `Bearer ${cookieValue(cookie, "family_ai_web_entry_token")}`,
          "x-entry-session-ref": cookieValue(cookie, "family_ai_web_entry_session_ref")
        }
      );
      await readFrameUntil(explicitStream.response, (frame) => frame.raw.includes(": connected"));
      expect(registerSpy.mock.calls.at(-1)?.[0]).toMatchObject({ authenticationSource: "explicit_authorization" });
      explicitStream.controller.abort();
    } finally {
      registerSpy.mockRestore();
    }
  });
});
