import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "chat-work-security-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function expectPublicError(
  response: { json(): unknown },
  expected: { code: string; category: string; retryable: boolean }
) {
  const body = response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ...expected,
    message: expect.any(String)
  });
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("protocolVersion");
}

describe("Chat Work HTTP route security", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personal: EntryCredential;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-route-security-"));
    databasePath = join(directory, "gateway.sqlite");
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-24T06:30:00.000Z")
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
    const body = onboarding.json() as {
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    admin = body.entries.admin;
    personal = body.entries.personal;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a personal Entry Session and keeps Chat Work errors in PublicError form", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC"
    });
    expect(missing.statusCode).toBe(401);
    expectPublicError(missing, {
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      retryable: false
    });

    const adminResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(admin)
    });
    expect(adminResponse.statusCode).toBe(403);
    expectPublicError(adminResponse, {
      code: "ENTRY_AUDIENCE_FORBIDDEN",
      category: "permission",
      retryable: false
    });

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(valid.statusCode).toBe(200);
  });
});
