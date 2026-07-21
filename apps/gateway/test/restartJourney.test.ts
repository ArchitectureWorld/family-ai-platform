import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const token = "restart-journey-device-token-with-enough-length";
const headers = {
  authorization: `Bearer ${token}`,
  "x-device-ref": "device:test"
};

function message(number: number) {
  const suffix = String(number).padStart(2, "0");
  return {
    protocolVersion: "1.0",
    messageRef: `message:118f47a2-1f10-7a3d-8c2d-61f369284f${suffix}`,
    correlationRef: `correlation:118f47a2-1f10-7a3d-8c2d-61f369284e${suffix}`,
    idempotencyKey: `restart:message:${suffix}`,
    occurredAt: "2026-07-21T09:00:00.000Z",
    source: { kind: "device", ref: "device:test" },
    target: { kind: "agent", ref: "agent:personal-assistant" },
    payload: { type: "text", text: `重启测试第 ${number} 轮。`, language: "zh-CN" }
  };
}

describe("Gateway restart journey", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("recovers history and continues the Provider Session after restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-restart-"));
    const databasePath = join(directory, "gateway.sqlite");
    const firstApp = await buildGatewayApp({
      databasePath,
      deviceToken: token,
      mode: "test"
    });
    const created = await firstApp.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers,
      payload: { title: "重启恢复" }
    });
    const conversationRef = created.json().conversation.conversationRef as string;
    for (const number of [1, 2]) {
      const response = await firstApp.inject({
        method: "POST",
        url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
        headers,
        payload: message(number)
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().response.payload.text).toBe(`Fake Provider 第 ${number} 轮回复。`);
    }
    await firstApp.close();

    const inspection = openGatewayDatabase(databasePath);
    expect(
      inspection
        .prepare(
          `SELECT external_session_ref FROM provider_sessions
           WHERE conversation_ref = ? AND agent_ref = ? AND provider_profile_ref = ?`
        )
        .get(
          conversationRef,
          "agent:personal-assistant",
          "provider-profile:fake-local"
        )
    ).toMatchObject({
      external_session_ref: expect.stringMatching(/^external-session:fake-.+-turn-2$/)
    });
    inspection.close();

    const secondApp = await buildGatewayApp({
      databasePath,
      deviceToken: token,
      mode: "test"
    });
    const history = await secondApp.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().messages).toHaveLength(4);

    const third = await secondApp.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: message(3)
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().response.payload.text).toBe("Fake Provider 第 3 轮回复。");

    const continuedHistory = await secondApp.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers
    });
    expect(continuedHistory.json().messages).toHaveLength(6);
    expect(
      continuedHistory.json().messages.map((item: { role: string }) => item.role)
    ).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    await secondApp.close();
  });
});
