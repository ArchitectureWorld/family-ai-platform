import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "provider-routes-bootstrap-device-token";
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

describe("Chat Work Provider HTTP flow", () => {
  let directory = "";
  let databasePath = "";
  let currentNow: Date;
  let adapter: FakeProviderAdapter;
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let personal: EntryCredential;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  async function openApp(providerAdapter = adapter) {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
      providerAdapter,
      now: () => currentNow
    });
  }

  async function initialize() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      owner: { personRef: string };
      device: { deviceRef: string };
      entries: { personal: EntryCredential };
    };
    personal = body.entries.personal;
    ownerPersonRef = body.owner.personRef;
    ownerDeviceRef = body.device.deviceRef;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-provider-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    currentNow = new Date("2026-07-23T17:00:00.000Z");
    adapter = new FakeProviderAdapter({ clock: () => currentNow });
    await openApp();
    await initialize();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function openChat() {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    expect(response.statusCode).toBe(200);
    return response.json().chat as { threadRef: string };
  }

  async function sendMessage(threadRef: string, suffix: string, text: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        clientMessageId: `provider-route-${suffix}-0001`,
        occurredAt: currentNow.toISOString(),
        content: { type: "text", text, language: "zh-CN" }
      }
    });
  }

  it("returns the accepted Person message and persists the generated Assistant reply", async () => {
    const chat = await openChat();

    const sent = await sendMessage(chat.threadRef, "chat-first", "你好，请回复我。");
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      protocolVersion: 1,
      message: {
        threadRef: chat.threadRef,
        threadSequence: 1,
        actor: { type: "person", personRef: ownerPersonRef },
        origin: {
          deviceRef: ownerDeviceRef,
          connectionRef: null,
          entryAudience: "personal"
        },
        content: { type: "text", text: "你好，请回复我。", language: "zh-CN" }
      }
    });
    expect(sent.json()).not.toHaveProperty("assistantMessage");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal)
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().messages).toHaveLength(2);
    expect(listed.json().messages[1]).toMatchObject({
      threadSequence: 2,
      actor: {
        type: "assistant",
        assignmentRef: expect.stringMatching(/^assignment:/),
        agentRef: "agent:personal-assistant",
        providerProfileRef: "provider-profile:fake-local"
      },
      origin: {
        deviceRef: null,
        connectionRef: null,
        entryAudience: "personal"
      },
      content: { type: "text", text: "Fake Provider 第 1 轮回复。" }
    });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({
      providerProfileRef: "provider-profile:fake-local",
      targetAgentRef: "agent:personal-assistant",
      conversationRef: expect.stringMatching(/^conversation:/),
      content: [{ type: "text", text: "你好，请回复我。", language: "zh-CN" }]
    });
    expect(adapter.calls[0]?.externalSessionRef).toBeUndefined();
  });

  it("continues Chat context after restart and keeps Work context independent", async () => {
    const chat = await openChat();
    await sendMessage(chat.threadRef, "restart-first", "第一轮。");
    const firstSessionRef = adapter.results[0]?.externalSessionRef;
    expect(firstSessionRef).toMatch(/^external-session:/);

    await app.close();
    currentNow = new Date("2026-07-23T17:01:00.000Z");
    adapter = new FakeProviderAdapter({ clock: () => currentNow });
    await openApp();

    const second = await sendMessage(chat.threadRef, "restart-second", "第二轮。");
    expect(second.statusCode).toBe(201);
    expect(adapter.calls[0]?.externalSessionRef).toBe(firstSessionRef);
    expect(adapter.results[0]?.output?.[0]?.text).toBe("Fake Provider 第 2 轮回复。");

    const workResponse = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        title: "独立 Provider Work",
        goal: "验证 Work 使用自己的 Context Session"
      }
    });
    expect(workResponse.statusCode).toBe(201);
    const work = workResponse.json().conversation as { threadRef: string };
    currentNow = new Date("2026-07-23T17:02:00.000Z");
    const workSent = await sendMessage(work.threadRef, "work-first", "Work 第一轮。");
    expect(workSent.statusCode).toBe(201);
    expect(adapter.calls[1]?.externalSessionRef).toBeUndefined();
    expect(adapter.results[1]?.output?.[0]?.text).toBe("Fake Provider 第 1 轮回复。");
  });
});
