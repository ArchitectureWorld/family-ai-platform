import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "gateway-test-device-token-with-enough-length";
const headers = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

function envelope(input: { number: number; text?: string; target?: string; key?: string }) {
  const suffix = String(input.number).padStart(2, "0");
  return {
    protocolVersion: "1.0",
    messageRef: `message:018f47a2-1f10-7a3d-8c2d-61f369284f${suffix}`,
    correlationRef: `correlation:018f47a2-1f10-7a3d-8c2d-61f369284e${suffix}`,
    idempotencyKey: input.key ?? `device:test:message:${suffix}`,
    occurredAt: "2026-07-21T09:00:00.000Z",
    source: { kind: "device", ref: "device:test" },
    target: { kind: "agent", ref: input.target ?? "agent:personal-assistant" },
    payload: { type: "text", text: input.text ?? `第 ${input.number} 轮消息。`, language: "zh-CN" }
  };
}

describe("local Family AI Gateway API", () => {
  let directory = "";
  let databasePath = "";
  let adapter: FakeProviderAdapter;
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-gateway-api-"));
    databasePath = join(directory, "gateway.sqlite");
    adapter = new FakeProviderAdapter();
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      providerAdapter: adapter
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps health public and protects member identity", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, protocolVersion: "1.0" });
    expect(health.body).not.toContain("测试成员");

    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      deviceRef: "device:test",
      memberRef: "member:test",
      agentRef: "agent:personal-assistant"
    });
  });

  it("creates a conversation, preserves two Provider turns, and restores history", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers,
      payload: { title: "体验会话" }
    });
    expect(created.statusCode).toBe(201);
    const conversationRef = created.json().conversation.conversationRef as string;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: envelope({ number: 1 })
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false });
    expect(first.json().response.payload.text).toBe("Fake Provider 第 1 轮回复。");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: envelope({ number: 2 })
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().response.payload.text).toBe("Fake Provider 第 2 轮回复。");
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.externalSessionRef).toBe(adapter.results[0]?.externalSessionRef);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().messages).toHaveLength(4);
  });

  it("authorizes conversation and Agent before idempotency replay", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers,
      payload: { title: "幂等会话" }
    });
    const conversationRef = created.json().conversation.conversationRef as string;
    const request = envelope({ number: 3, key: "device:test:shared-key" });

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: request
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: request
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(adapter.calls).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`,
      headers,
      payload: envelope({ number: 4, key: "device:test:shared-key", text: "不同请求内容" })
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");

    const db = openGatewayDatabase(databasePath);
    const timestamp = new Date().toISOString();
    db.prepare(
      "INSERT INTO agents (agent_ref, display_name, created_at) VALUES (?, ?, ?)"
    ).run("agent:other", "其他 Agent", timestamp);
    db.prepare(
      `INSERT INTO conversations
       (conversation_ref, member_ref, agent_ref, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("conversation:other-agent", "member:test", "agent:other", "其他 Agent 会话", timestamp, timestamp);
    db.close();

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/conversations/conversation%3Aother-agent/messages",
      headers,
      payload: request
    });
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.json().code).toBe("CONVERSATION_NOT_FOUND");
    expect(adapter.calls).toHaveLength(1);
  });
});
