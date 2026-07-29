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

function cookieValue(cookie: string, name: string): string {
  const encoded = cookie.split("; ")
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) throw new Error(`missing ${name}`);
  return decodeURIComponent(encoded);
}

describe("Web Entry Cookie bridge", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let cookie = "";
  let admin: EntryCredential;
  let webDeviceRef = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-bridge-"));
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
    admin = body.entries.admin;
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
    webDeviceRef = cookieValue(cookie, "family_ai_web_device_ref");
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses HttpOnly Session cookies with the existing Chat, Work and Sync APIs", async () => {
    const attachment = await app.inject({
      method: "POST",
      url: "/api/v1/attachments/uploads",
      headers: {
        cookie,
        "x-family-ai-web-request": "1"
      },
      payload: {
        protocolVersion: 1,
        fileName: "cookie-report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 32
      }
    });
    expect(attachment.statusCode).toBe(201);

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
        agentRef: "agent:personal-assistant",
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
    const blockedAttachment = await app.inject({
      method: "POST",
      url: "/api/v1/attachments/uploads",
      headers: { cookie },
      payload: {
        protocolVersion: 1,
        fileName: "blocked.pdf",
        mediaType: "application/pdf",
        sizeBytes: 32
      }
    });
    expect(blockedAttachment.statusCode).toBe(403);
    expect(blockedAttachment.json()).toMatchObject({
      code: "WEB_REQUEST_FORBIDDEN"
    });

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
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      protocolVersion: 2,
      context: {
        mountedAgents: [{
          agentRef: "agent:personal-assistant",
          providerProfileRef: "provider-profile:fake-local",
          isDefault: true,
          status: "idle",
          statusLabel: "空闲"
        }],
        defaultAgentRef: "agent:personal-assistant"
      }
    });
    expect(context.json().context).not.toHaveProperty("agent");
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

  it("expires revoked Cookie credentials on every bridge surface without touching explicit Authorization", async () => {
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/devices/${encodeURIComponent(webDeviceRef)}`,
      headers: entryHeaders(admin)
    });
    expect(revoked.statusCode).toBe(200);

    const surfaces = [
      "/api/v1/web-entry/context",
      "/api/v1/chat?timezone=UTC",
      "/api/v1/work-conversations",
      "/api/v1/sync/events?afterSequence=0&limit=100"
    ];
    for (const url of surfaces) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie }
      });
      expect(response.statusCode, url).toBe(403);
      const body = response.json() as {
        code?: string;
        error?: { code?: string };
      };
      expect(body.error?.code ?? body.code, url).toBe("DEVICE_REVOKED");
      const setCookie = response.headers["set-cookie"];
      const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(values, url).toHaveLength(4);
      expect(values.map((value) => value.split("=", 1)[0]), url).toEqual([
        "family_ai_web_device_ref",
        "family_ai_web_device_credential",
        "family_ai_web_entry_session_ref",
        "family_ai_web_entry_token"
      ]);
      expect(values.every((value) => value.includes("Max-Age=0")), url).toBe(true);
    }

    const explicitHeaders = {
      cookie,
      authorization: `Bearer ${cookieValue(cookie, "family_ai_web_entry_token")}`,
      "x-entry-session-ref": cookieValue(cookie, "family_ai_web_entry_session_ref")
    };
    for (const url of surfaces) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: explicitHeaders
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
  });
});
