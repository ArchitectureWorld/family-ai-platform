import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chatWorkConversionSchema,
  createWorkConversationRequestSchema,
  createWorkConversationResponseSchema,
  createWorkFromChatRequestSchema,
  createWorkFromChatResponseSchema,
  dailyEpisodeSchema,
  homeChatStreamResponseSchema,
  sendThreadMessageRequestSchema,
  sendThreadMessageResponseSchema,
  threadMessageListResponseSchema,
  threadMessageSchema,
  workConversationListResponseSchema,
  workConversationSchema,
  workProgressSnapshotResponseSchema
} from "../src/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/chat-work/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Chat / Work protocol v1 read models", () => {
  it("accepts canonical read-model fixtures", () => {
    expect(homeChatStreamResponseSchema.parse(fixture("home-chat-response.json"))).toBeTruthy();
    expect(workConversationListResponseSchema.parse(fixture("work-list-response.json"))).toBeTruthy();
    expect(
      threadMessageListResponseSchema.parse(fixture("thread-message-list-response.json"))
    ).toBeTruthy();
  });

  it("keeps the current Episode consistent with the Home Chat", () => {
    const response = fixture("home-chat-response.json") as {
      chat: Record<string, unknown>;
      currentEpisode: Record<string, unknown>;
    };
    expect(
      homeChatStreamResponseSchema.safeParse({
        ...response,
        currentEpisode: {
          ...response.currentEpisode,
          threadRef: "thread:another-chat"
        }
      }).success
    ).toBe(false);
  });

  it("requires message pages to belong to one thread in sequence order", () => {
    const response = fixture("thread-message-list-response.json") as {
      messages: Record<string, unknown>[];
    };
    expect(
      threadMessageListResponseSchema.safeParse({
        ...response,
        messages: [
          response.messages[0],
          {
            ...response.messages[1],
            threadSequence: 1
          }
        ]
      }).success
    ).toBe(false);
    expect(
      threadMessageListResponseSchema.safeParse({
        ...response,
        messages: [
          response.messages[0],
          {
            ...response.messages[1],
            threadRef: "thread:another-chat"
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("Chat / Work protocol v1 commands", () => {
  const sendMessage = {
    protocolVersion: 1,
    clientMessageId: "web-chat-0003",
    occurredAt: "2026-07-23T08:03:00.000Z",
    content: {
      type: "text",
      text: "开始实现这个 Work。",
      language: "zh-CN"
    }
  } as const;

  it("accepts canonical command and progress fixtures", () => {
    expect(
      createWorkConversationRequestSchema.parse(fixture("create-work-request.json"))
    ).toBeTruthy();
    expect(
      createWorkFromChatRequestSchema.parse(fixture("create-work-from-chat-request.json"))
    ).toBeTruthy();
    expect(workProgressSnapshotResponseSchema.parse(fixture("work-progress-response.json"))).toBeTruthy();
    expect(sendThreadMessageRequestSchema.parse(sendMessage)).toEqual(sendMessage);
  });

  it("accepts canonical response envelopes", () => {
    const workList = fixture("work-list-response.json") as {
      conversations: Record<string, unknown>[];
    };
    const messageList = fixture("thread-message-list-response.json") as {
      messages: Record<string, unknown>[];
    };
    const conversionRequest = fixture("create-work-from-chat-request.json") as {
      source: {
        homeChatStreamRef: string;
        dailyEpisodeRef: string | null;
        messageRefs: string[];
      };
    };
    const conversion = {
      conversionRef: "chat-work-conversion:alice-0001",
      homeChatStreamRef: conversionRequest.source.homeChatStreamRef,
      dailyEpisodeRef: conversionRequest.source.dailyEpisodeRef,
      sourceMessageRefs: conversionRequest.source.messageRefs,
      workConversationRef: "work:family-ai-platform",
      createdAt: "2026-07-23T10:05:00.000Z"
    };

    expect(
      createWorkConversationResponseSchema.parse({
        protocolVersion: 1,
        conversation: workList.conversations[0]
      })
    ).toBeTruthy();
    expect(
      sendThreadMessageResponseSchema.parse({
        protocolVersion: 1,
        message: messageList.messages[0]
      })
    ).toBeTruthy();
    expect(chatWorkConversionSchema.parse(conversion)).toEqual(conversion);
    expect(
      createWorkFromChatResponseSchema.parse({
        protocolVersion: 1,
        conversation: workList.conversations[0],
        conversion
      })
    ).toBeTruthy();
  });

  it.each([
    ["personRef", "person:alice"],
    ["agentRef", "agent:personal-assistant"],
    ["deviceRef", "device:web-alice"]
  ])("rejects trusted identity field %s in a Work command", (field, value) => {
    const request = fixture("create-work-request.json") as Record<string, unknown>;
    expect(createWorkConversationRequestSchema.safeParse({ ...request, [field]: value }).success).toBe(
      false
    );
  });

  it.each([
    ["personRef", "person:alice"],
    ["agentRef", "agent:personal-assistant"],
    ["deviceRef", "device:web-alice"],
    ["origin", { deviceRef: "device:web-alice" }]
  ])("rejects trusted identity or origin field %s in a message command", (field, value) => {
    expect(sendThreadMessageRequestSchema.safeParse({ ...sendMessage, [field]: value }).success).toBe(
      false
    );
  });

  it("rejects unsupported versions and unknown private fields", () => {
    const request = fixture("create-work-request.json") as Record<string, unknown>;
    expect(createWorkConversationRequestSchema.safeParse({ ...request, protocolVersion: 2 }).success).toBe(
      false
    );
    expect(createWorkConversationRequestSchema.safeParse({ ...request, databaseId: 42 }).success).toBe(
      false
    );
  });

  it("requires unique source message references for Chat to Work", () => {
    const request = fixture("create-work-from-chat-request.json") as {
      source: Record<string, unknown>;
    };
    expect(
      createWorkFromChatRequestSchema.safeParse({
        ...request,
        source: {
          ...request.source,
          messageRefs: ["message:chat-0001", "message:chat-0001"]
        }
      }).success
    ).toBe(false);
  });
});

describe("Chat / Work protocol v1 cross-field invariants", () => {
  it("keeps open and archived Episode fields consistent", () => {
    const response = fixture("home-chat-response.json") as {
      currentEpisode: Record<string, unknown>;
    };
    const episode = response.currentEpisode;
    expect(
      dailyEpisodeSchema.safeParse({
        ...episode,
        endedAt: "2026-07-23T23:00:00.000Z"
      }).success
    ).toBe(false);
    expect(
      dailyEpisodeSchema.safeParse({
        ...episode,
        archiveStatus: "archived",
        archiveVersion: 1,
        endedAt: null
      }).success
    ).toBe(false);
  });

  it("keeps archived Work fields consistent", () => {
    const response = fixture("work-list-response.json") as {
      conversations: Record<string, unknown>[];
    };
    const active = response.conversations[0];
    expect(
      workConversationSchema.safeParse({
        ...active,
        status: "archived",
        archivedAt: null
      }).success
    ).toBe(false);
    expect(
      workConversationSchema.safeParse({
        ...active,
        archivedAt: "2026-07-23T12:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("requires a device origin for Person messages", () => {
    const response = fixture("thread-message-list-response.json") as {
      messages: Record<string, unknown>[];
    };
    const message = response.messages[0];
    const origin = message.origin as Record<string, unknown>;
    expect(
      threadMessageSchema.safeParse({
        ...message,
        origin: {
          ...origin,
          deviceRef: null
        }
      }).success
    ).toBe(false);
  });

  it("requires the system audience for System messages", () => {
    const response = fixture("thread-message-list-response.json") as {
      messages: Record<string, unknown>[];
    };
    const message = response.messages[1];
    expect(
      threadMessageSchema.safeParse({
        ...message,
        actor: {
          type: "system",
          systemRef: "system:daily-archive"
        },
        origin: {
          deviceRef: null,
          connectionRef: null,
          entryAudience: "personal"
        }
      }).success
    ).toBe(false);
  });
});
