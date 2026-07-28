import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult
} from "@family-ai/contracts";
import {
  FakeProviderAdapter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

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

class MissingSessionProviderAdapter implements ProviderAdapter {
  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:missing-session-test",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: "2026-07-23T17:00:00.000Z"
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-23T17:00:01.000Z",
      output: [{ type: "text", text: "缺少 External Session 的回复。" }]
    };
  }
}

class RecoveringSessionProviderAdapter implements ProviderAdapter {
  readonly calls: ProviderInvocationRequest[] = [];
  private failedMissingSession = false;
  private nextSession = 1;

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:recovering-session-test",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: "2026-07-23T17:00:00.000Z"
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    this.calls.push(request);
    if (
      request.externalSessionRef &&
      request.content[0]?.text === "触发 Provider Session 丢失。" &&
      !this.failedMissingSession
    ) {
      this.failedMissingSession = true;
      return {
        protocolVersion: PROTOCOL_VERSION,
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "failed",
        completedAt: "2026-07-23T17:05:00.000Z",
        error: {
          code: "PROVIDER_SESSION_NOT_FOUND",
          category: "conflict",
          message: "Provider Session 已不存在。",
          retryable: true
        }
      };
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-23T17:05:01.000Z",
      output: [{ type: "text", text: `恢复回复 ${this.calls.length}` }],
      externalSessionRef: `external-session:recovering-${this.nextSession++}`
    };
  }
}

class HoldingProviderAdapter implements ProviderAdapter {
  readonly calls: ProviderInvocationRequest[] = [];
  private releaseInvocation!: () => void;
  readonly invoked = new Promise<void>((resolve) => {
    this.releaseInvocation = resolve;
  });
  private continueInvocation!: () => void;
  private readonly continued = new Promise<void>((resolve) => {
    this.continueInvocation = resolve;
  });

  release(): void {
    this.continueInvocation();
  }

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:holding-provider-test",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: "2026-07-23T17:00:00.000Z"
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    this.calls.push(request);
    this.releaseInvocation();
    await this.continued;
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-23T17:10:00.000Z",
      output: [{ type: "text", text: "已授权 Turn 完成。" }],
      externalSessionRef: "external-session:holding-provider"
    };
  }
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

  async function openApp(providerAdapter: ProviderAdapter = adapter) {
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

  async function listMessages(threadRef: string) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal)
    });
    expect(response.statusCode).toBe(200);
    return response.json().messages as Array<Record<string, unknown>>;
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

    const messages = await listMessages(chat.threadRef);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
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
        agentRef: "agent:personal-assistant",
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

  it("keeps the Person message after Provider failure and succeeds on exact retry", async () => {
    await app.close();
    adapter = new FakeProviderAdapter({ failNext: true, clock: () => currentNow });
    await openApp();
    const chat = await openChat();

    const failed = await sendMessage(chat.threadRef, "retry", "失败后重试。");
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      category: "availability",
      retryable: true
    });
    expect(await listMessages(chat.threadRef)).toHaveLength(1);

    const retried = await sendMessage(chat.threadRef, "retry", "失败后重试。");
    expect(retried.statusCode).toBe(201);
    expect(await listMessages(chat.threadRef)).toHaveLength(2);
    expect(adapter.calls).toHaveLength(2);
    expect(retried.json().message.threadSequence).toBe(1);
  });

  it("returns PublicError for an invalid Provider result while preserving the Person message", async () => {
    await app.close();
    await openApp(new MissingSessionProviderAdapter());
    const chat = await openChat();

    const response = await sendMessage(chat.threadRef, "invalid-provider", "请保留这条输入。");
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      category: "internal",
      retryable: true,
      message: expect.any(String)
    });
    expect(response.json()).not.toHaveProperty("error");
    expect(response.json()).not.toHaveProperty("protocolVersion");

    const messages = await listMessages(chat.threadRef);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      actor: { type: "person", personRef: ownerPersonRef },
      content: { type: "text", text: "请保留这条输入。" }
    });
  });

  it("clears only a missing external Session and rebuilds it from persisted Thread history", async () => {
    await app.close();
    const recovering = new RecoveringSessionProviderAdapter();
    await openApp(recovering);
    const chat = await openChat();

    expect((await sendMessage(chat.threadRef, "recover-first", "第一轮历史。")).statusCode)
      .toBe(201);
    const firstChatSession = recovering.calls[0]?.externalSessionRef;
    expect(firstChatSession).toBeUndefined();

    const workResponse = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        agentRef: "agent:personal-assistant",
        title: "不受影响的 Work",
        goal: "验证另一个 Thread 的 Session 不被清除"
      }
    });
    expect(workResponse.statusCode).toBe(201);
    const workThreadRef = workResponse.json().conversation.threadRef as string;
    expect((await sendMessage(workThreadRef, "recover-work-first", "Work 第一轮。")).statusCode)
      .toBe(201);
    const workSession = recovering.calls[1]?.externalSessionRef;
    expect(workSession).toBeUndefined();

    const failed = await sendMessage(
      chat.threadRef,
      "recover-missing",
      "触发 Provider Session 丢失。"
    );
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "PROVIDER_SESSION_NOT_FOUND" });
    expect(await listMessages(chat.threadRef)).toHaveLength(3);

    const retried = await sendMessage(
      chat.threadRef,
      "recover-missing",
      "触发 Provider Session 丢失。"
    );
    expect(retried.statusCode).toBe(201);
    expect(recovering.calls[3]?.externalSessionRef).toBeUndefined();
    expect(recovering.calls[3]?.content).toHaveLength(1);
    expect(recovering.calls[3]?.content[0]?.text).toContain("成员:第一轮历史。");
    expect(recovering.calls[3]?.content[0]?.text).toContain("助理:恢复回复 1");
    expect(recovering.calls[3]?.content[0]?.text).toContain(
      "成员:触发 Provider Session 丢失。"
    );
    expect(await listMessages(chat.threadRef)).toHaveLength(4);

    expect((await sendMessage(workThreadRef, "recover-work-second", "Work 第二轮。")).statusCode)
      .toBe(201);
    expect(recovering.calls[4]?.externalSessionRef).toBe(
      "external-session:recovering-2"
    );
  });

  it("lets an authorized in-flight Turn commit after unmount and blocks the next send", async () => {
    await app.close();
    const holding = new HoldingProviderAdapter();
    await openApp(holding);
    const chat = await openChat();

    const inFlight = sendMessage(chat.threadRef, "unmount-in-flight", "等待 Provider。");
    await holding.invoked;
    const db = openGatewayDatabase(databasePath);
    db.prepare(
      `UPDATE assistant_assignments
       SET status = 'ended', effective_to = ?
       WHERE person_ref = ? AND agent_ref = ? AND status = 'active'`
    ).run(
      "2026-07-23T17:09:00.000Z",
      ownerPersonRef,
      "agent:personal-assistant"
    );
    db.close();

    holding.release();
    expect((await inFlight).statusCode).toBe(201);
    const blocked = await sendMessage(
      chat.threadRef,
      "unmount-blocked",
      "不应调用 Provider。"
    );
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: "AGENT_NOT_MOUNTED",
      category: "permission",
      retryable: false
    });
    expect(holding.calls).toHaveLength(1);

    const verification = openGatewayDatabase(databasePath);
    expect(verification.prepare(
      `SELECT COUNT(*) AS count FROM thread_messages
       WHERE thread_ref = ? AND actor_type = 'assistant'`
    ).get(chat.threadRef)).toEqual({ count: 1 });
    verification.close();
  });
});
