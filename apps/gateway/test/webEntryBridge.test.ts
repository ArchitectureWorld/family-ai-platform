import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "web-entry-bridge-bootstrap-device-token-with-enough-length";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef,
    host: "family.example",
    "x-forwarded-proto": "https"
  };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

describe("Web Entry Cookie bridge", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let cookie = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-bridge-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-25T10:00:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-device-ref": "device:test"
      },
      payload: {
        familyName: "测试家庭",
        ownerName: "Alice",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      owner: { personRef: string };
      entries: { admin: EntryCredential };
    };
    const pairing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(body.owner.personRef)}/pairing-codes`,
      headers: entryHeaders(body.entries.admin)
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
        installationId: "d8096c57-95e1-45ec-a5fc-64f779ff7c18",
        deviceCredential,
        device: {
          displayName: "产品工作台浏览器",
          browser: "Firefox 142",
          operatingSystem: "Linux",
          appVersion: "0.1.0"
        }
      }
    });
    expect(claim.statusCode).toBe(204);
    expect(claim.body).toBe("");
    cookie = cookieHeader(claim.headers["set-cookie"]);
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses HttpOnly Session cookies with the existing Chat, Work and Sync APIs", async () => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: { cookie }
    });
    expect(chat.statusCode).toBe(200);
    const threadRef = (chat.json() as { chat: { threadRef: string } }).chat.threadRef;

    const work = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: {
        cookie,
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        title: "真实产品 Work",
        goal: "验证浏览器 Cookie 进入正常工作状态"
      }
    });
    expect(work.statusCode).toBe(201);

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: {
        cookie,
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        clientMessageId: "web-product-message-0001",
        occurredAt: "2026-07-25T10:00:01.000Z",
        content: {
          type: "text",
          text: "这是一条正常产品消息。",
          language: "zh-CN"
        }
      }
    });
    expect(send.statusCode).toBe(201);

    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: { cookie }
    });
    expect(messages.statusCode).toBe(200);
    expect((messages.json() as { messages: unknown[] }).messages).toHaveLength(2);

    const sync = await app.inject({
      method: "GET",
      url: "/api/v1/sync/events?afterSequence=0&limit=100",
      headers: { cookie }
    });
    expect(sync.statusCode).toBe(200);
    expect((sync.json() as { events: unknown[] }).events.length).toBeGreaterThanOrEqual(5);
  });

  it("blocks unsafe Cookie writes but keeps explicit Bearer Header behavior unchanged", async () => {
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: { cookie },
      payload: {
        protocolVersion: 1,
        title: "不应创建",
        goal: "缺少浏览器同源 Header"
      }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "WEB_REQUEST_FORBIDDEN" });

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie }
    });
    const entrySessionRef = (context.json() as { context: { entrySessionRef: string } })
      .context.entrySessionRef;

    const explicit = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: {
        cookie,
        authorization: "Bearer deliberately-invalid-explicit-token",
        "x-entry-session-ref": entrySessionRef
      }
    });
    expect(explicit.statusCode).toBe(401);
    expect(explicit.json()).toMatchObject({ code: "ENTRY_SESSION_INVALID" });
  });
});
