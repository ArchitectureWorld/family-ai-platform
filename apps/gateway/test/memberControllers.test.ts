import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../member-public/api.js";
import { createChatController } from "../member-public/chat.js";
import {
  createMemoryCache,
  readBootstrapSnapshot
} from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import { createThreadController } from "../member-public/thread.js";
import { createWorkController } from "../member-public/work.js";

function state() {
  return {
    chat: null,
    currentEpisode: null,
    works: [],
    selectedWorkRef: null,
    activeThreadRef: null,
    messagesByThread: {},
    paginationByThread: {},
    outgoing: [],
    drafts: {},
    selectedMessageRefs: [],
    progressByWork: {},
    network: { online: true },
    busy: {}
  };
}

const personMessage = {
  messageRef: "message:person-0001",
  threadRef: "thread:chat-0001",
  threadSequence: 1,
  clientMessageId: "web:fixed-uuid",
  actor: { type: "person", personRef: "person:alice" },
  origin: { deviceRef: "device:web-alice", connectionRef: null, entryAudience: "personal" },
  content: { type: "text", text: "你好", language: "zh-CN" },
  occurredAt: "2026-07-25T10:00:00.000Z",
  createdAt: "2026-07-25T10:00:00.000Z"
};
const assistantMessage = {
  ...personMessage,
  messageRef: "message:assistant-0002",
  threadSequence: 2,
  clientMessageId: "assistant:0002",
  actor: {
    type: "assistant",
    assignmentRef: "assignment:alice",
    agentRef: "agent:personal-assistant",
    providerProfileRef: "provider-profile:fake-local"
  },
  origin: { deviceRef: null, connectionRef: null, entryAudience: "personal" },
  content: { type: "text", text: "你好，我在。", language: "zh-CN" }
};

describe("Member Web Thread controller", () => {
  it("keeps offline input as a draft and never reports it as sent", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const api = { sendThreadMessage: vi.fn(), getThreadMessages: vi.fn() };
    const controller = createThreadController({
      api,
      cache,
      store,
      isOnline: () => false,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      uuid: () => "fixed-uuid"
    });

    await expect(controller.send("thread:chat-0001", "离线草稿", "zh-CN")).resolves.toEqual({
      status: "draft"
    });
    expect(api.sendThreadMessage).not.toHaveBeenCalled();
    expect(store.getState().drafts).toEqual({ "thread:chat-0001": "离线草稿" });
    expect((await readBootstrapSnapshot(cache)).drafts).toMatchObject([
      { threadRef: "thread:chat-0001", text: "离线草稿" }
    ]);
  });

  it("shows an outgoing message, reconciles authoritative Person/Assistant messages and clears the draft", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const api = {
      sendThreadMessage: vi.fn(async () => ({ protocolVersion: 1, message: personMessage })),
      getThreadMessages: vi.fn(async () => ({
        protocolVersion: 1,
        threadRef: "thread:chat-0001",
        messages: [personMessage, assistantMessage],
        nextBeforeSequence: null
      }))
    };
    const controller = createThreadController({
      api,
      cache,
      store,
      isOnline: () => true,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      uuid: () => "fixed-uuid"
    });

    await controller.saveDraft("thread:chat-0001", "你好");
    await expect(controller.send("thread:chat-0001", "你好", "zh-CN")).resolves.toEqual({
      status: "succeeded"
    });

    expect(api.sendThreadMessage).toHaveBeenCalledWith("thread:chat-0001", {
      protocolVersion: 1,
      clientMessageId: "web:fixed-uuid",
      occurredAt: "2026-07-25T10:00:00.000Z",
      content: { type: "text", text: "你好", language: "zh-CN" }
    });
    expect(store.getState().outgoing).toEqual([]);
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().messagesByThread["thread:chat-0001"]).toHaveLength(2);
  });

  it("retains a failed logical message and retries the exact same payload", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const send = vi
      .fn()
      .mockRejectedValueOnce(new GatewayError({
        status: 502,
        code: "PROVIDER_FAILED",
        category: "availability",
        message: "回复失败",
        retryable: true
      }))
      .mockResolvedValueOnce({ protocolVersion: 1, message: personMessage });
    const api = {
      sendThreadMessage: send,
      getThreadMessages: vi.fn(async () => ({
        protocolVersion: 1,
        threadRef: "thread:chat-0001",
        messages: [personMessage, assistantMessage],
        nextBeforeSequence: null
      }))
    };
    const controller = createThreadController({
      api,
      cache,
      store,
      isOnline: () => true,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      uuid: () => "fixed-uuid"
    });

    await expect(controller.send("thread:chat-0001", "你好", "zh-CN")).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "PROVIDER_FAILED", retryable: true })
    });
    expect(store.getState().outgoing[0]).toMatchObject({
      clientMessageId: "web:fixed-uuid",
      status: "failed"
    });

    await expect(controller.retry("web:fixed-uuid")).resolves.toEqual({ status: "succeeded" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });

  it("merges older pages without changing the latest-page cursor", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const api = {
      sendThreadMessage: vi.fn(),
      getThreadMessages: vi
        .fn()
        .mockResolvedValueOnce({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [assistantMessage],
          nextBeforeSequence: 2
        })
        .mockResolvedValueOnce({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [personMessage],
          nextBeforeSequence: null
        })
    };
    const controller = createThreadController({ api, cache, store });

    await controller.loadLatest("thread:chat-0001");
    await controller.loadEarlier("thread:chat-0001");
    expect(store.getState().messagesByThread["thread:chat-0001"].map(
      (message: { threadSequence: number }) => message.threadSequence
    )).toEqual([1, 2]);
    expect(api.getThreadMessages.mock.calls).toEqual([
      ["thread:chat-0001", { limit: 100 }],
      ["thread:chat-0001", { beforeSequence: 2, limit: 100 }]
    ]);
  });
});

describe("Member Web Chat and Work controllers", () => {
  it("initializes the one Home Chat and converts a unique message selection into Work", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const threadController = { loadLatest: vi.fn(async () => undefined) };
    const api = {
      getHomeChat: vi.fn(async () => ({
        protocolVersion: 1,
        chat: {
          threadRef: "thread:chat-0001",
          threadKind: "home_chat",
          personRef: "person:alice",
          lastSequence: 2,
          createdAt: "2026-07-25T09:00:00.000Z",
          lastActiveAt: "2026-07-25T10:00:01.000Z",
          homeChatStreamRef: "home-chat:alice",
          status: "active",
          currentEpisodeRef: "daily-episode:alice-20260725"
        },
        currentEpisode: {
          dailyEpisodeRef: "daily-episode:alice-20260725",
          homeChatStreamRef: "home-chat:alice",
          threadRef: "thread:chat-0001",
          localDate: "2026-07-25",
          timezone: "America/Los_Angeles",
          startedAt: "2026-07-25T09:00:00.000Z",
          endedAt: null,
          boundaryReason: "initial",
          archiveStatus: "open",
          archiveVersion: 0,
          lastMessageSequence: 2
        }
      })),
      convertChatToWork: vi.fn(async () => ({
        protocolVersion: 1,
        conversation: { workConversationRef: "work:converted", threadRef: "thread:work-converted" },
        conversion: { conversionRef: "chat-work-conversion:0001" }
      }))
    };
    const controller = createChatController({
      api,
      cache,
      store,
      threadController,
      timeZone: "America/Los_Angeles"
    });

    await controller.initialize();
    expect(api.getHomeChat).toHaveBeenCalledWith("America/Los_Angeles");
    expect(threadController.loadLatest).toHaveBeenCalledWith("thread:chat-0001");
    controller.toggleMessageSelection("message:person-0001");
    controller.toggleMessageSelection("message:person-0001");
    controller.toggleMessageSelection("message:person-0001");
    await controller.convertSelectionToWork({
      title: "转成 Work",
      goal: "继续推进",
      decisions: [],
      openQuestions: []
    });

    expect(api.convertChatToWork).toHaveBeenCalledWith({
      protocolVersion: 1,
      title: "转成 Work",
      goal: "继续推进",
      source: {
        homeChatStreamRef: "home-chat:alice",
        dailyEpisodeRef: "daily-episode:alice-20260725",
        messageRefs: ["message:person-0001"]
      },
      decisions: [],
      openQuestions: []
    });
    expect(store.getState().selectedMessageRefs).toEqual([]);
  });

  it("loads, creates and opens independent Work conversations with optional progress", async () => {
    const cache = createMemoryCache();
    const store = createStore(state());
    const work = {
      workConversationRef: "work:0001",
      threadRef: "thread:work-0001",
      title: "家庭 AI",
      goal: "持续开发",
      summary: "",
      status: "active",
      archivedAt: null,
      threadKind: "work",
      personRef: "person:alice",
      lastSequence: 0,
      createdAt: "2026-07-25T10:00:00.000Z",
      lastActiveAt: "2026-07-25T10:00:00.000Z"
    };
    const api = {
      listWorks: vi.fn(async () => ({ protocolVersion: 1, conversations: [work] })),
      createWork: vi.fn(async () => ({ protocolVersion: 1, conversation: work })),
      getWorkProgress: vi.fn(async () => null)
    };
    const threadController = { loadLatest: vi.fn(async () => undefined) };
    const controller = createWorkController({ api, cache, store, threadController });

    await controller.initialize();
    expect(store.getState().works).toEqual([work]);
    await controller.create({ title: "家庭 AI", goal: "持续开发" });
    expect(api.createWork).toHaveBeenCalledWith({
      protocolVersion: 1,
      title: "家庭 AI",
      goal: "持续开发"
    });
    expect(store.getState().selectedWorkRef).toBe("work:0001");
    expect(store.getState().activeThreadRef).toBe("thread:work-0001");
    expect(threadController.loadLatest).toHaveBeenCalledWith("thread:work-0001");
    expect(store.getState().progressByWork).toEqual({ "work:0001": null });
  });
});
