import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { ChatWorkDomainRepository } from "../src/chatWorkDomain.js";
import { openGatewayDatabase } from "../src/database.js";

const deviceToken = "chat-work-routes-bootstrap-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

describe("Chat Work HTTP routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let currentNow = new Date("2026-07-24T06:30:00.000Z");
  let admin: EntryCredential;
  let personal: EntryCredential;
  let ownerPersonRef = "";
  let ownerDeviceRef = "";

  async function openApp() {
    app = await buildGatewayApp({
      databasePath,
      deviceToken,
      mode: "test",
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
      entries: { admin: EntryCredential; personal: EntryCredential };
    };
    admin = body.entries.admin;
    personal = body.entries.personal;
    ownerPersonRef = body.owner.personRef;
    ownerDeviceRef = body.device.deviceRef;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-chat-work-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
    await initialize();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates one Home Chat using the authenticated Person and server-derived local date", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=America%2FLos_Angeles",
      headers: entryHeaders(personal)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      chat: {
        threadKind: "home_chat",
        personRef: ownerPersonRef,
        status: "active",
        lastSequence: 0
      },
      currentEpisode: {
        localDate: "2026-07-23",
        timezone: "America/Los_Angeles",
        archiveStatus: "open",
        lastMessageSequence: 0
      }
    });
    expect(response.body).not.toContain(personal.token);
    expect(ownerDeviceRef).toMatch(/^device:/);
    expect(admin.entrySessionRef).not.toBe(personal.entrySessionRef);

    const repeated = await app.inject({
      method: "GET",
      url: "/api/v1/chat",
      headers: entryHeaders(personal)
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(response.json());
  });

  it("requires a valid IANA timezone only when Home Chat does not exist", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/chat",
      headers: entryHeaders(personal)
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      code: "REQUEST_INVALID",
      category: "validation",
      retryable: false
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=Not%2FA-Timezone",
      headers: entryHeaders(personal)
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("creates and lists only the authenticated Person's Work Conversations", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal)
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ protocolVersion: 1, conversations: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        title: "家庭 AI 平台",
        goal: "建立正式 Web 与多端共用的 Work"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      protocolVersion: 1,
      conversation: {
        threadKind: "work",
        personRef: ownerPersonRef,
        title: "家庭 AI 平台",
        goal: "建立正式 Web 与多端共用的 Work",
        status: "active",
        summary: "",
        archivedAt: null
      }
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/work-conversations",
      headers: entryHeaders(personal)
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().conversations).toEqual([created.json().conversation]);
  });

  it("persists Person and Assistant messages, replays retries and returns ascending pages", async () => {
    const chatResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    const chat = chatResponse.json().chat as { threadRef: string };

    const firstPayload = {
      protocolVersion: 1,
      clientMessageId: "web-owner-message-0001",
      occurredAt: "2026-07-24T06:31:00.000Z",
      content: {
        type: "text",
        text: "  保留消息两侧空格。  ",
        language: "zh-CN"
      }
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: firstPayload
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      protocolVersion: 1,
      message: {
        threadRef: chat.threadRef,
        threadSequence: 1,
        clientMessageId: firstPayload.clientMessageId,
        actor: { type: "person", personRef: ownerPersonRef },
        origin: {
          deviceRef: ownerDeviceRef,
          connectionRef: null,
          entryAudience: "personal"
        },
        content: firstPayload.content
      }
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: firstPayload
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        ...firstPayload,
        content: { ...firstPayload.content, text: "不同内容" }
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "THREAD_MESSAGE_CONFLICT" });

    for (let index = 2; index <= 5; index += 1) {
      currentNow = new Date(`2026-07-24T06:3${index}:00.000Z`);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
        headers: entryHeaders(personal),
        payload: {
          protocolVersion: 1,
          clientMessageId: `web-owner-message-${String(index).padStart(4, "0")}`,
          occurredAt: currentNow.toISOString(),
          content: { type: "text", text: `第 ${index} 条消息`, language: "zh-CN" }
        }
      });
      expect(response.statusCode).toBe(201);
    }

    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages?limit=2`,
      headers: entryHeaders(personal)
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().messages.map(
      (message: { threadSequence: number }) => message.threadSequence
    )).toEqual([9, 10]);
    expect(latest.json().nextBeforeSequence).toBe(9);
    expect(latest.json().messages.map(
      (message: { actor: { type: string } }) => message.actor.type
    )).toEqual(["person", "assistant"]);

    const older = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages?beforeSequence=9&limit=2`,
      headers: entryHeaders(personal)
    });
    expect(older.statusCode).toBe(200);
    expect(older.json().messages.map(
      (message: { threadSequence: number }) => message.threadSequence
    )).toEqual([7, 8]);
    expect(older.json().nextBeforeSequence).toBe(7);
  });

  it("converts Chat references into a Work and reads a trusted progress snapshot after restart", async () => {
    const chatResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    const chat = chatResponse.json().chat as {
      threadRef: string;
      homeChatStreamRef: string;
    };
    const episode = chatResponse.json().currentEpisode as { dailyEpisodeRef: string };

    currentNow = new Date("2026-07-24T06:31:00.000Z");
    const source = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(chat.threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        clientMessageId: "conversion-source-0001",
        occurredAt: currentNow.toISOString(),
        content: { type: "text", text: "把当前讨论转成 Work。", language: "zh-CN" }
      }
    });
    expect(source.statusCode).toBe(201);
    const sourceMessageRef = source.json().message.messageRef as string;

    const conversion = await app.inject({
      method: "POST",
      url: "/api/v1/chat/work-conversions",
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        title: "正式 HTTP 路由",
        goal: "把 Chat 讨论转为独立 Work",
        source: {
          homeChatStreamRef: chat.homeChatStreamRef,
          dailyEpisodeRef: episode.dailyEpisodeRef,
          messageRefs: [sourceMessageRef]
        },
        decisions: ["路由和 Provider 保持分层"],
        openQuestions: ["何时接入 SSE"]
      }
    });
    expect(conversion.statusCode).toBe(201);
    expect(conversion.json()).toMatchObject({
      protocolVersion: 1,
      conversation: {
        title: "正式 HTTP 路由",
        personRef: ownerPersonRef
      },
      conversion: {
        homeChatStreamRef: chat.homeChatStreamRef,
        sourceMessageRefs: [sourceMessageRef]
      }
    });

    const workConversationRef = conversion.json().conversation.workConversationRef as string;
    await app.close();

    const db = openGatewayDatabase(databasePath);
    const repository = new ChatWorkDomainRepository(db, () => currentNow);
    repository.saveWorkProgressSnapshot({
      personRef: ownerPersonRef,
      snapshot: {
        workConversationRef,
        status: "active",
        phaseSummary: "HTTP 路由已建立",
        incompleteTasks: ["接入实时同步"],
        risks: ["不得影响 PR #14"],
        pendingConfirmations: [],
        deadlines: [{
          label: "完成路由验收",
          dueAt: "2026-07-25T06:30:00.000Z"
        }],
        updatedAt: "2026-07-24T07:00:00.000Z"
      }
    });
    db.close();

    await openApp();
    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/work-conversations/${encodeURIComponent(workConversationRef)}/progress`,
      headers: entryHeaders(personal)
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({
      protocolVersion: 1,
      snapshot: {
        workConversationRef,
        phaseSummary: "HTTP 路由已建立",
        risks: ["不得影响 PR #14"]
      }
    });
  });
});
