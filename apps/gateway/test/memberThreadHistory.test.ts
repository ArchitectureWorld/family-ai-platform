import { describe, expect, it, vi } from "vitest";
import { createMemoryCache } from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import { createThreadController } from "../member-public/thread.js";

function message(sequence: number) {
  return {
    messageRef: `message:${String(sequence).padStart(4, "0")}`,
    threadRef: "thread:chat-0001",
    threadSequence: sequence,
    clientMessageId: `message-client-${String(sequence).padStart(4, "0")}`,
    actor: { type: "person", personRef: "person:alice" },
    origin: { deviceRef: "device:web-alice", connectionRef: null, entryAudience: "personal" },
    content: { type: "text", text: `消息 ${sequence}`, language: "zh-CN" },
    occurredAt: `2026-07-25T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    createdAt: `2026-07-25T10:00:${String(sequence).padStart(2, "0")}.000Z`
  };
}

describe("Member Web thread history preservation", () => {
  it("keeps already loaded history and a terminal pagination cursor during realtime refresh", async () => {
    const cache = createMemoryCache();
    const store = createStore({
      messagesByThread: {},
      paginationByThread: {},
      outgoing: [],
      drafts: {}
    });
    const api = {
      sendThreadMessage: vi.fn(),
      getThreadMessages: vi
        .fn()
        .mockResolvedValueOnce({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [message(3)],
          nextBeforeSequence: 3
        })
        .mockResolvedValueOnce({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [message(1), message(2)],
          nextBeforeSequence: null
        })
        .mockResolvedValueOnce({
          protocolVersion: 1,
          threadRef: "thread:chat-0001",
          messages: [message(3), message(4)],
          nextBeforeSequence: 3
        })
    };
    const controller = createThreadController({ api, cache, store });

    await controller.loadLatest("thread:chat-0001");
    await controller.loadEarlier("thread:chat-0001");
    await controller.refresh("thread:chat-0001");

    expect(store.getState().messagesByThread["thread:chat-0001"].map(
      (item: { threadSequence: number }) => item.threadSequence
    )).toEqual([1, 2, 3, 4]);
    expect(store.getState().paginationByThread["thread:chat-0001"]).toBeNull();
  });
});
