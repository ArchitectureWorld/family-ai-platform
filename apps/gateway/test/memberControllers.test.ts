import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../member-public/api.js";
import { createChatController } from "../member-public/chat.js";
import {
  createMemoryCache,
  readBootstrapSnapshot,
  saveAttachmentDraft
} from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import { createThreadController } from "../member-public/thread.js";
import { createWorkController } from "../member-public/work.js";

function state() {
  return {
    currentAgentRef: "agent:personal-assistant",
    chat: null,
    currentEpisode: null,
    works: [],
    selectedWorkRef: null,
    activeThreadRef: null,
    messagesByThread: {},
    paginationByThread: {},
    outgoing: [],
    drafts: {},
    attachmentDrafts: [],
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
  it("commits outgoing text and ready attachments before a pending Provider settles", async () => {
    let resolveSend!: (value: unknown) => void;
    const pendingSend = new Promise((resolve) => {
      resolveSend = resolve;
    });
    const cache = createMemoryCache();
    const store = createStore(state());
    const api = {
      sendThreadMessage: vi.fn(() => pendingSend),
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
    const publicMetadata = {
      attachmentRef: "attachment:ready-0001",
      fileName: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      downloadUrl:
        "/api/v1/attachments/attachment%3Aready-0001"
    };
    const attachmentDraft = {
      ...publicMetadata,
      agentRef: "agent:personal-assistant",
      threadRef: "thread:chat-0001",
      serverState: "ready",
      publicMetadata
    };
    await saveAttachmentDraft(cache, attachmentDraft);
    store.setState((current) => ({
      ...current,
      attachmentDrafts: [attachmentDraft]
    }));

    const queued = await controller.enqueue(
      "thread:chat-0001",
      "你好",
      [attachmentDraft],
      "zh-CN"
    );

    expect(queued).toMatchObject({
      status: "queued",
      outgoing: {
        clientMessageId: "web:fixed-uuid",
        attachmentRefs: ["attachment:ready-0001"]
      },
      transmission: expect.any(Promise)
    });
    expect(store.getState()).toMatchObject({
      drafts: {},
      attachmentDrafts: [],
      outgoing: [{ status: "sending" }]
    });
    expect(await readBootstrapSnapshot(cache)).toMatchObject({
      drafts: [],
      attachmentDrafts: [],
      outgoing: [{
        clientMessageId: "web:fixed-uuid",
        attachmentRefs: ["attachment:ready-0001"]
      }]
    });

    resolveSend({ protocolVersion: 1, message: personMessage });
    await expect(queued.transmission).resolves.toEqual({
      status: "succeeded"
    });
    expect(api.sendThreadMessage).toHaveBeenCalledWith(
      "thread:chat-0001",
      {
        protocolVersion: 1,
        clientMessageId: "web:fixed-uuid",
        occurredAt: "2026-07-25T10:00:00.000Z",
        content: { type: "text", text: "你好", language: "zh-CN" },
        attachmentRefs: ["attachment:ready-0001"]
      }
    );
  });

  it("finishes the captured Agent Thread after selection changes without projecting into the new Agent", async () => {
    let resolveSend!: (value: unknown) => void;
    const pendingSend = new Promise((resolve) => {
      resolveSend = resolve;
    });
    const cache = createMemoryCache();
    const store = createStore(state());
    const controller = createThreadController({
      api: {
        sendThreadMessage: vi.fn(() => pendingSend),
        getThreadMessages: vi.fn(async () => ({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [personMessage, assistantMessage],
          nextBeforeSequence: null
        }))
      },
      cache,
      store,
      isOnline: () => true,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      uuid: () => "fixed-uuid"
    });

    const queued = await controller.enqueue(
      "thread:chat-0001",
      "发给原 Agent",
      [],
      "zh-CN"
    );
    store.setState((current) => ({
      ...current,
      currentAgentRef: "agent:second",
      messagesByThread: {},
      outgoing: []
    }));
    resolveSend({ protocolVersion: 1, message: personMessage });

    await expect(queued.transmission).resolves.toEqual({
      status: "succeeded"
    });
    expect(store.getState()).toMatchObject({
      currentAgentRef: "agent:second",
      messagesByThread: {},
      outgoing: []
    });
    expect((await readBootstrapSnapshot(cache)).messages).toHaveLength(2);
    expect((await readBootstrapSnapshot(cache)).outgoing).toEqual([]);
  });

  it("preserves the draft and attachment tray when the enqueue transaction fails", async () => {
    const backingCache = createMemoryCache();
    const store = createStore(state());
    const publicMetadata = {
      attachmentRef: "attachment:ready-0001",
      fileName: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      downloadUrl:
        "/api/v1/attachments/attachment%3Aready-0001"
    };
    const attachmentDraft = {
      ...publicMetadata,
      agentRef: "agent:personal-assistant",
      threadRef: "thread:chat-0001",
      serverState: "ready",
      publicMetadata
    };
    const api = {
      sendThreadMessage: vi.fn(),
      getThreadMessages: vi.fn()
    };
    const controller = createThreadController({
      api,
      cache: {
        transaction(storeNames: string[], callback: (transaction: unknown) => unknown) {
          if (storeNames.includes("outgoing")) {
            throw new Error("IDB_COMMIT_FAILED");
          }
          return backingCache.transaction(storeNames, callback);
        },
        close() {}
      },
      store,
      isOnline: () => true,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      uuid: () => "fixed-uuid"
    });
    await controller.saveDraft("thread:chat-0001", "你好");
    await saveAttachmentDraft(backingCache, attachmentDraft);
    store.setState((current) => ({
      ...current,
      attachmentDrafts: [attachmentDraft]
    }));

    await expect(
      controller.enqueue(
        "thread:chat-0001",
        "你好",
        [attachmentDraft],
        "zh-CN"
      )
    ).rejects.toThrow("IDB_COMMIT_FAILED");

    expect(api.sendThreadMessage).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      drafts: { "thread:chat-0001": "你好" },
      attachmentDrafts: [attachmentDraft],
      outgoing: []
    });
    expect(await readBootstrapSnapshot(backingCache)).toMatchObject({
      drafts: [{ threadRef: "thread:chat-0001", text: "你好" }],
      attachmentDrafts: [attachmentDraft],
      outgoing: []
    });
  });

  it("does not project a late message page after the selected Agent changes", async () => {
    let resolvePage!: (value: Record<string, unknown>) => void;
    const page = new Promise<Record<string, unknown>>((resolve) => {
      resolvePage = resolve;
    });
    const store = createStore(state());
    const controller = createThreadController({
      api: {
        getThreadMessages: vi.fn(() => page),
        sendThreadMessage: vi.fn()
      },
      cache: createMemoryCache(),
      store
    });

    const loading = controller.loadLatest("thread:chat-0001");
    store.setState((current) => ({
      ...current,
      currentAgentRef: "agent:second"
    }));
    resolvePage({
      protocolVersion: 1,
      threadRef: "thread:chat-0001",
      messages: [personMessage],
      nextBeforeSequence: null
    });

    await expect(loading).rejects.toMatchObject({
      code: "AGENT_SELECTION_CHANGED"
    });
    expect(store.getState()).toMatchObject({
      currentAgentRef: "agent:second",
      messagesByThread: {}
    });
  });

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
    const queued = await controller.send(
      "thread:chat-0001",
      "你好",
      "zh-CN"
    );
    expect(queued).toMatchObject({
      status: "queued",
      transmission: expect.any(Promise)
    });
    await expect(queued.transmission).resolves.toEqual({
      status: "succeeded"
    });

    expect(api.sendThreadMessage).toHaveBeenCalledWith("thread:chat-0001", {
      protocolVersion: 1,
      clientMessageId: "web:fixed-uuid",
      occurredAt: "2026-07-25T10:00:00.000Z",
      content: { type: "text", text: "你好", language: "zh-CN" },
      attachmentRefs: []
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

    const first = await controller.send(
      "thread:chat-0001",
      "你好",
      "zh-CN"
    );
    expect(first).toMatchObject({
      status: "queued",
      transmission: expect.any(Promise)
    });
    await expect(first.transmission).resolves.toEqual({
      status: "failed",
      error: expect.objectContaining({ code: "PROVIDER_FAILED", retryable: true })
    });
    expect(store.getState().outgoing[0]).toMatchObject({
      clientMessageId: "web:fixed-uuid",
      status: "failed"
    });

    const retry = await controller.retry("web:fixed-uuid");
    expect(retry).toMatchObject({
      status: "queued",
      transmission: expect.any(Promise)
    });
    await expect(retry.transmission).resolves.toEqual({ status: "succeeded" });
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
  it("does not project a late Home Chat response after the selected Agent changes", async () => {
    let resolveChat!: (value: Record<string, unknown>) => void;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      resolveChat = resolve;
    });
    const store = createStore(state());
    const controller = createChatController({
      api: { getHomeChat: vi.fn(() => response) },
      cache: createMemoryCache(),
      store,
      threadController: { loadLatest: vi.fn() },
      timeZone: "UTC"
    });

    const initialization = controller.initialize();
    store.setState((current) => ({
      ...current,
      currentAgentRef: "agent:second"
    }));
    resolveChat({
      protocolVersion: 1,
      chat: {
        threadRef: "thread:chat-late",
        threadKind: "home_chat",
        personRef: "person:alice",
        agentRef: "agent:personal-assistant",
        homeChatStreamRef: "home-chat:late",
        status: "active"
      },
      currentEpisode: null
    });

    await expect(initialization).rejects.toMatchObject({
      code: "AGENT_SELECTION_CHANGED"
    });
    expect(store.getState()).toMatchObject({
      currentAgentRef: "agent:second",
      chat: null,
      messagesByThread: {}
    });
  });

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
          agentRef: "agent:personal-assistant",
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
    expect(api.getHomeChat).toHaveBeenCalledWith(
      "agent:personal-assistant",
      "America/Los_Angeles"
    );
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
      agentRef: "agent:personal-assistant",
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
    expect(api.listWorks).toHaveBeenCalledWith("agent:personal-assistant");
    expect(store.getState().works).toEqual([work]);
    await controller.create({ title: "家庭 AI", goal: "持续开发" });
    expect(api.createWork).toHaveBeenCalledWith({
      protocolVersion: 1,
      agentRef: "agent:personal-assistant",
      title: "家庭 AI",
      goal: "持续开发"
    });
    expect(store.getState().selectedWorkRef).toBe("work:0001");
    expect(store.getState().activeThreadRef).toBe("thread:work-0001");
    expect(threadController.loadLatest).toHaveBeenCalledWith("thread:work-0001");
    expect(store.getState().progressByWork).toEqual({ "work:0001": null });
  });
});
