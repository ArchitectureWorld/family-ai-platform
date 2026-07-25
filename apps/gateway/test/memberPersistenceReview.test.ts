import { describe, expect, it, vi } from "vitest";
import {
  createMemoryCache,
  readBootstrapSnapshot,
  saveMeta
} from "../member-public/cache.js";
import {
  createEventApplier,
  nextNavigationState
} from "../member-public/product.js";
import { createStore } from "../member-public/store.js";

const userMessage = {
  messageRef: "message:user-0001",
  threadRef: "thread:work-0001",
  threadSequence: 1,
  clientMessageId: "web:work-message-0001",
  actor: { type: "person", personRef: "person:alice" },
  origin: { deviceRef: "device:web-alice", connectionRef: null, entryAudience: "personal" },
  content: { type: "text", text: "请继续推进。", language: "zh-CN" },
  occurredAt: "2026-07-25T10:00:00.000Z",
  createdAt: "2026-07-25T10:00:00.000Z"
};
const assistantMessage = {
  ...userMessage,
  messageRef: "message:assistant-0002",
  threadSequence: 2,
  clientMessageId: "assistant:reply-0002",
  actor: {
    type: "assistant",
    assignmentRef: "assignment:alice",
    agentRef: "agent:personal-assistant",
    providerProfileRef: "provider-profile:fake-local"
  },
  origin: { deviceRef: null, connectionRef: null, entryAudience: "personal" },
  content: { type: "text", text: "已经继续推进。", language: "zh-CN" }
};

function productState() {
  return {
    section: "chat",
    chat: { threadRef: "thread:chat-0001" },
    works: [{
      workConversationRef: "work:0001",
      threadRef: "thread:work-0001",
      title: "家庭 AI"
    }],
    selectedWorkRef: "work:0001",
    activeThreadRef: "thread:chat-0001",
    messagesByThread: {},
    paginationByThread: {},
    outgoing: [{
      threadRef: "thread:work-0001",
      clientMessageId: "web:work-message-0001",
      occurredAt: "2026-07-25T10:00:00.000Z",
      content: userMessage.content,
      status: "sending",
      error: null
    }],
    progressByWork: {},
    drafts: {},
    sync: { localAppliedSequence: 0 }
  };
}

describe("Member Web durable product selection", () => {
  it("reads the last selected section and Work from the device projection", async () => {
    const cache = createMemoryCache();
    await saveMeta(cache, "selectedSection", "work");
    await saveMeta(cache, "selectedWorkRef", "work:0001");

    await expect(readBootstrapSnapshot(cache)).resolves.toMatchObject({
      selectedSection: "work",
      selectedWorkRef: "work:0001"
    });
  });

  it("changes the active Thread when navigating between Chat and the selected Work", () => {
    const state = productState();
    expect(nextNavigationState(state, "work")).toMatchObject({
      section: "work",
      activeThreadRef: "thread:work-0001"
    });
    expect(nextNavigationState({ ...state, section: "work" }, "chat")).toMatchObject({
      section: "chat",
      activeThreadRef: "thread:chat-0001"
    });
  });
});

describe("Member Web atomic event application", () => {
  it("persists Provider failure status with the authoritative Person message before sequence advancement", async () => {
    const cache = createMemoryCache();
    const store = createStore(productState());
    const api = {
      getThreadMessages: vi.fn(async () => ({
        protocolVersion: 1,
        threadRef: "thread:work-0001",
        messages: [userMessage],
        nextBeforeSequence: null
      })),
      getHomeChat: vi.fn(),
      listWorks: vi.fn(),
      getWorkProgress: vi.fn()
    };
    const apply = createEventApplier({ api, cache, store, timeZone: "UTC" });

    await apply({
      eventRef: "event:provider-failed-0001",
      personRef: "person:alice",
      eventSequence: 1,
      eventType: "thread.provider_turn.failed",
      aggregateType: "provider_turn",
      aggregateRef: "message:user-0001",
      threadRef: "thread:work-0001",
      payload: {
        userMessageRef: "message:user-0001",
        threadRef: "thread:work-0001",
        attemptCount: 1,
        error: { code: "PROVIDER_FAILED", category: "availability", retryable: true }
      },
      occurredAt: "2026-07-25T10:00:01.000Z",
      createdAt: "2026-07-25T10:00:01.000Z"
    });

    const snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot.localAppliedSequence).toBe(1);
    expect(snapshot.messages).toEqual([userMessage]);
    expect(snapshot.outgoing).toEqual([
      expect.objectContaining({
        clientMessageId: "web:work-message-0001",
        status: "failed",
        error: expect.objectContaining({ code: "PROVIDER_FAILED", retryable: true })
      })
    ]);
    expect(store.getState().outgoing).toEqual(snapshot.outgoing);
  });

  it("removes the retry marker when the Provider turn later succeeds", async () => {
    const cache = createMemoryCache();
    const initial = productState();
    initial.outgoing[0] = {
      ...initial.outgoing[0],
      status: "failed",
      error: { code: "PROVIDER_FAILED", category: "availability", message: "回复失败", retryable: true }
    };
    const store = createStore(initial);
    await saveMeta(cache, "localAppliedSequence", 1);
    await cache.transaction(["outgoing"], (transaction: { put(store: string, value: unknown): Promise<void> }) =>
      transaction.put("outgoing", initial.outgoing[0])
    );
    const api = {
      getThreadMessages: vi.fn(async () => ({
        protocolVersion: 1,
        threadRef: "thread:work-0001",
        messages: [userMessage, assistantMessage],
        nextBeforeSequence: null
      })),
      getHomeChat: vi.fn(),
      listWorks: vi.fn(),
      getWorkProgress: vi.fn()
    };
    const apply = createEventApplier({ api, cache, store, timeZone: "UTC" });

    await apply({
      eventRef: "event:provider-succeeded-0002",
      personRef: "person:alice",
      eventSequence: 2,
      eventType: "thread.provider_turn.succeeded",
      aggregateType: "provider_turn",
      aggregateRef: "message:user-0001",
      threadRef: "thread:work-0001",
      payload: {
        userMessageRef: "message:user-0001",
        assistantMessageRef: "message:assistant-0002",
        threadRef: "thread:work-0001",
        attemptCount: 2
      },
      occurredAt: "2026-07-25T10:00:02.000Z",
      createdAt: "2026-07-25T10:00:02.000Z"
    });

    const snapshot = await readBootstrapSnapshot(cache);
    expect(snapshot.localAppliedSequence).toBe(2);
    expect(snapshot.outgoing).toEqual([]);
    expect(snapshot.messages.map((message: { messageRef: string }) => message.messageRef)).toEqual([
      "message:user-0001",
      "message:assistant-0002"
    ]);
  });

  it("rolls back resource writes and sequence when a projected event is invalid", async () => {
    const cache = createMemoryCache();
    const store = createStore(productState());
    const api = {
      getThreadMessages: vi.fn(async () => ({
        protocolVersion: 1,
        threadRef: "thread:work-0001",
        messages: [{ threadRef: "thread:work-0001", threadSequence: 1 }],
        nextBeforeSequence: null
      })),
      getHomeChat: vi.fn(),
      listWorks: vi.fn(),
      getWorkProgress: vi.fn()
    };
    const apply = createEventApplier({ api, cache, store, timeZone: "UTC" });

    await expect(apply({
      eventRef: "event:message-0001",
      personRef: "person:alice",
      eventSequence: 1,
      eventType: "thread.message.created",
      aggregateType: "thread_message",
      aggregateRef: "message:user-0001",
      threadRef: "thread:work-0001",
      payload: {
        messageRef: "message:user-0001",
        threadRef: "thread:work-0001",
        threadSequence: 1,
        actorType: "person",
        clientMessageId: "web:work-message-0001"
      },
      occurredAt: "2026-07-25T10:00:00.000Z",
      createdAt: "2026-07-25T10:00:00.000Z"
    })).rejects.toThrow("CACHE_KEY_INVALID:messages");

    await expect(readBootstrapSnapshot(cache)).resolves.toMatchObject({
      localAppliedSequence: 0,
      messages: []
    });
  });
});
