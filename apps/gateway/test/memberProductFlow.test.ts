import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "member-product-flow-bootstrap-token-with-enough-length";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = () => new Date("2026-07-25T10:00:00.000Z");
const directories: string[] = [];

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

async function createClaimedMemberApp() {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-member-product-flow-"));
  directories.push(directory);
  const databasePath = join(directory, "gateway.sqlite");
  const app = await buildGatewayApp({ databasePath, deviceToken, mode: "test", now });
  const onboarding = await app.inject({
    method: "POST",
    url: "/api/v1/onboarding/family",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "x-device-ref": "device:test"
    },
    payload: {
      familyName: "产品体验家庭",
      ownerName: "Alice",
      deviceName: "家庭服务器"
    }
  });
  expect(onboarding.statusCode).toBe(201);
  const initialized = onboarding.json() as {
    owner: { personRef: string };
    entries: { admin: EntryCredential };
  };
  const pairing = await app.inject({
    method: "POST",
    url: `/api/v1/admin/members/${encodeURIComponent(initialized.owner.personRef)}/pairing-codes`,
    headers: entryHeaders(initialized.entries.admin)
  });
  expect(pairing.statusCode).toBe(201);
  const material = pairing.json() as { pairing: { pairingRef: string; code: string } };
  async function claim() {
    return app.inject({
      method: "POST",
      url: "/api/v1/web-entry/pairing/claim",
      headers: {
        "x-family-ai-web-request": "1",
        host: "family.example",
        origin: "https://family.example",
        "x-forwarded-proto": "https"
      },
      payload: {
        protocolVersion: 2,
        pairingRef: material.pairing.pairingRef,
        code: material.pairing.code,
        installationId: "89be7a40-6173-43b3-8b75-aee8f0ab92e6",
        deviceCredential,
        device: {
          displayName: "Alice 的浏览器",
          browser: "Chrome 140",
          operatingSystem: "macOS",
          appVersion: "0.1.0"
        }
      }
    });
  }
  const initialClaim = await claim();
  const replayedClaim = await claim();
  expect(initialClaim.statusCode).toBe(204);
  expect(replayedClaim.statusCode).toBe(204);
  expect(initialClaim.body).toBe("");
  expect(replayedClaim.body).toBe("");
  expect(cookieHeader(replayedClaim.headers["set-cookie"]))
    .toBe(cookieHeader(initialClaim.headers["set-cookie"]));

  const cookie = cookieHeader(initialClaim.headers["set-cookie"]);
  const context = await app.inject({
    method: "GET",
    url: "/api/v1/web-entry/context",
    headers: { cookie }
  });
  expect(context.statusCode).toBe(200);
  expect(context.json()).toMatchObject({
    protocolVersion: 2,
    context: {
      protocolVersion: 1,
      person: { personRef: initialized.owner.personRef }
    }
  });
  return { app, databasePath, cookie };
}

function cookieWriteHeaders(cookie: string) {
  return {
    cookie,
    "x-family-ai-web-request": "1",
    host: "family.example",
    origin: "https://family.example",
    "x-forwarded-proto": "https"
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Member Web normal product flow", () => {
  it("uses the real Cookie entry for Chat, Assistant reply, Work and Chat-to-Work", async () => {
    const setup = await createClaimedMemberApp();
    try {
      const chatResponse = await setup.app.inject({
        method: "GET",
        url: "/api/v1/chat?timezone=America%2FLos_Angeles",
        headers: { cookie: setup.cookie }
      });
      expect(chatResponse.statusCode).toBe(200);
      const chat = chatResponse.json() as {
        chat: { threadRef: string; homeChatStreamRef: string };
        currentEpisode: { dailyEpisodeRef: string };
      };

      const chatSend = await setup.app.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(chat.chat.threadRef)}/messages`,
        headers: cookieWriteHeaders(setup.cookie),
        payload: {
          protocolVersion: 1,
          clientMessageId: "web:member-product-chat-0001",
          occurredAt: "2026-07-25T10:00:00.000Z",
          content: { type: "text", text: "你好，请介绍现在的工作状态。", language: "zh-CN" }
        }
      });
      expect(chatSend.statusCode).toBe(201);

      const chatMessagesResponse = await setup.app.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(chat.chat.threadRef)}/messages?limit=100`,
        headers: { cookie: setup.cookie }
      });
      expect(chatMessagesResponse.statusCode).toBe(200);
      const chatMessages = chatMessagesResponse.json() as {
        messages: Array<{
          messageRef: string;
          clientMessageId: string;
          actor: { type: string };
          threadSequence: number;
        }>;
      };
      expect(chatMessages.messages.map((message) => message.actor.type)).toEqual([
        "person",
        "assistant"
      ]);
      expect(chatMessages.messages.map((message) => message.threadSequence)).toEqual([1, 2]);

      const createWork = await setup.app.inject({
        method: "POST",
        url: "/api/v1/work-conversations",
        headers: cookieWriteHeaders(setup.cookie),
        payload: {
          protocolVersion: 1,
          title: "家庭 AI 产品工作台",
          goal: "验证独立 Work 对话"
        }
      });
      expect(createWork.statusCode).toBe(201);
      const work = createWork.json() as {
        conversation: { workConversationRef: string; threadRef: string };
      };

      const workSend = await setup.app.inject({
        method: "POST",
        url: `/api/v1/threads/${encodeURIComponent(work.conversation.threadRef)}/messages`,
        headers: cookieWriteHeaders(setup.cookie),
        payload: {
          protocolVersion: 1,
          clientMessageId: "web:member-product-work-0001",
          occurredAt: "2026-07-25T10:00:02.000Z",
          content: { type: "text", text: "请只在这个 Work 中继续。", language: "zh-CN" }
        }
      });
      expect(workSend.statusCode).toBe(201);
      const workMessages = await setup.app.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(work.conversation.threadRef)}/messages?limit=100`,
        headers: { cookie: setup.cookie }
      });
      expect(workMessages.statusCode).toBe(200);
      expect((workMessages.json() as { messages: Array<{ threadRef: string }> }).messages)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ threadRef: work.conversation.threadRef })
        ]));
      expect(JSON.stringify(workMessages.json())).not.toContain(chat.chat.threadRef);

      const conversion = await setup.app.inject({
        method: "POST",
        url: "/api/v1/chat/work-conversions",
        headers: cookieWriteHeaders(setup.cookie),
        payload: {
          protocolVersion: 1,
          title: "从 Chat 转出的事项",
          goal: "继续处理 Chat 中的结论",
          source: {
            homeChatStreamRef: chat.chat.homeChatStreamRef,
            dailyEpisodeRef: chat.currentEpisode.dailyEpisodeRef,
            messageRefs: [chatMessages.messages[0]!.messageRef]
          },
          decisions: [],
          openQuestions: []
        }
      });
      expect(conversion.statusCode).toBe(201);

      const works = await setup.app.inject({
        method: "GET",
        url: "/api/v1/work-conversations",
        headers: { cookie: setup.cookie }
      });
      expect(works.statusCode).toBe(200);
      expect((works.json() as { conversations: unknown[] }).conversations).toHaveLength(2);

      const sync = await setup.app.inject({
        method: "GET",
        url: "/api/v1/sync/events?afterSequence=0&limit=200",
        headers: { cookie: setup.cookie }
      });
      expect(sync.statusCode).toBe(200);
      const events = (sync.json() as {
        events: Array<{ eventRef: string; eventSequence: number; eventType: string }>;
      }).events;
      expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
        "chat.home.created",
        "thread.message.created",
        "work.created",
        "chat.work.created",
        "thread.provider_turn.succeeded"
      ]));
      const last = events.at(-1)!;
      const ack = await setup.app.inject({
        method: "POST",
        url: "/api/v1/sync/ack",
        headers: cookieWriteHeaders(setup.cookie),
        payload: {
          protocolVersion: 1,
          eventSequence: last.eventSequence,
          eventRef: last.eventRef
        }
      });
      expect(ack.statusCode).toBe(200);
      expect(ack.json()).toMatchObject({
        sync: { acknowledgedSequence: last.eventSequence, advanced: true }
      });
    } finally {
      await setup.app.close();
    }
  });

  it("restores the same product state after Gateway restart", async () => {
    const setup = await createClaimedMemberApp();
    const chat = await setup.app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: { cookie: setup.cookie }
    });
    const threadRef = (chat.json() as { chat: { threadRef: string } }).chat.threadRef;
    const send = await setup.app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: cookieWriteHeaders(setup.cookie),
      payload: {
        protocolVersion: 1,
        clientMessageId: "web:restart-0001",
        occurredAt: "2026-07-25T10:00:00.000Z",
        content: { type: "text", text: "重启后继续。", language: "zh-CN" }
      }
    });
    expect(send.statusCode).toBe(201);
    await setup.app.close();

    const restarted = await buildGatewayApp({
      databasePath: setup.databasePath,
      deviceToken,
      mode: "test",
      now
    });
    try {
      const context = await restarted.inject({
        method: "GET",
        url: "/api/v1/web-entry/context",
        headers: { cookie: setup.cookie }
      });
      expect(context.statusCode).toBe(200);

      const restoredChat = await restarted.inject({
        method: "GET",
        url: "/api/v1/chat",
        headers: { cookie: setup.cookie }
      });
      expect(restoredChat.statusCode).toBe(200);
      expect((restoredChat.json() as { chat: { threadRef: string } }).chat.threadRef).toBe(threadRef);

      const messages = await restarted.inject({
        method: "GET",
        url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages?limit=100`,
        headers: { cookie: setup.cookie }
      });
      expect(messages.statusCode).toBe(200);
      expect((messages.json() as { messages: unknown[] }).messages).toHaveLength(2);
    } finally {
      await restarted.close();
    }
  });
});
