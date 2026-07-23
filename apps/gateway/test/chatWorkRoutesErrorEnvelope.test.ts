import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "chat-work-envelope-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

describe("Chat Work HTTP error envelopes", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses common PublicError when Device authorization is misapplied to Chat", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-envelope-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
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
    expect(onboarding.statusCode).toBe(201);
    const deviceRef = onboarding.json().device.deviceRef as string;

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: {
        authorization: `Device ${"A".repeat(43)}`,
        "x-device-ref": deviceRef
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "ENTRY_SESSION_INVALID",
      category: "permission",
      message: expect.any(String),
      retryable: false
    });
    expect(response.json()).not.toHaveProperty("error");
    expect(response.json()).not.toHaveProperty("protocolVersion");
  });
});
