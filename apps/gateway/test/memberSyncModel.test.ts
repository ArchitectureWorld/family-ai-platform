import { describe, expect, it } from "vitest";
import {
  eventRefreshPlan,
  highestContiguousSequence,
  nextReconnectDelay
} from "../member-public/sync.js";

function event(eventType: string, input: Record<string, unknown> = {}) {
  return {
    eventRef: `event:${eventType.replaceAll(".", "-")}`,
    personRef: "person:alice",
    eventSequence: 1,
    eventType,
    aggregateType: "future",
    aggregateRef: "future:item-0001",
    threadRef: null,
    payload: {},
    occurredAt: "2026-07-25T10:00:00.000Z",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...input
  };
}

describe("Member Web sync model", () => {
  it("maps every known event to the minimum authoritative refresh", () => {
    expect(eventRefreshPlan(event("chat.home.created", {
      threadRef: "thread:chat-0001",
      payload: {
        homeChatStreamRef: "home-chat:alice",
        dailyEpisodeRef: "daily-episode:alice-20260725",
        threadRef: "thread:chat-0001"
      }
    }), "thread:chat-0001")).toEqual({ chat: true, works: false, threads: [], progress: [] });

    expect(eventRefreshPlan(event("work.created", {
      threadRef: "thread:work-0001",
      payload: {
        workConversationRef: "work:0001",
        threadRef: "thread:work-0001",
        status: "active"
      }
    }), "thread:chat-0001")).toEqual({ chat: false, works: true, threads: [], progress: [] });

    expect(eventRefreshPlan(event("thread.message.created", {
      threadRef: "thread:chat-0001",
      payload: {
        messageRef: "message:0001",
        threadRef: "thread:chat-0001",
        threadSequence: 1,
        actorType: "person",
        clientMessageId: "web:message-0001"
      }
    }), "thread:chat-0001")).toEqual({
      chat: false,
      works: false,
      threads: ["thread:chat-0001"],
      progress: []
    });

    expect(eventRefreshPlan(event("chat.work.created", {
      threadRef: "thread:work-0001",
      payload: {
        conversionRef: "chat-work-conversion:0001",
        homeChatStreamRef: "home-chat:alice",
        workConversationRef: "work:0001",
        sourceMessageRefs: ["message:0001"]
      }
    }), "thread:chat-0001")).toEqual({ chat: false, works: true, threads: [], progress: [] });

    expect(eventRefreshPlan(event("work.progress.updated", {
      threadRef: "thread:work-0001",
      payload: {
        workConversationRef: "work:0001",
        status: "active",
        updatedAt: "2026-07-25T10:00:00.000Z"
      }
    }), "thread:work-0001")).toEqual({
      chat: false,
      works: true,
      threads: [],
      progress: ["work:0001"]
    });

    for (const type of [
      "thread.provider_turn.failed",
      "thread.provider_turn.succeeded"
    ]) {
      expect(eventRefreshPlan(event(type, {
        threadRef: "thread:chat-0001",
        payload: {
          userMessageRef: "message:0001",
          threadRef: "thread:chat-0001",
          attemptCount: 1,
          ...(type.endsWith("failed")
            ? { error: { code: "PROVIDER_FAILED", category: "availability", retryable: true } }
            : { assistantMessageRef: "message:0002" })
        }
      }), "thread:chat-0001")).toEqual({
        chat: false,
        works: false,
        threads: ["thread:chat-0001"],
        progress: []
      });
    }
  });

  it("accepts opaque future events without inventing a product refresh", () => {
    expect(eventRefreshPlan(event("notification.created"), null)).toEqual({
      chat: false,
      works: false,
      threads: [],
      progress: []
    });
  });

  it("uses bounded reconnect delays", () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(nextReconnectDelay)).toEqual([
      1000,
      2000,
      4000,
      8000,
      16000,
      30000,
      30000
    ]);
  });

  it("advances only through strictly contiguous event sequences", () => {
    expect(highestContiguousSequence(4, [
      { eventSequence: 5 },
      { eventSequence: 6 },
      { eventSequence: 7 }
    ])).toBe(7);
    expect(() => highestContiguousSequence(4, [
      { eventSequence: 5 },
      { eventSequence: 7 }
    ])).toThrow("SYNC_SEQUENCE_GAP");
    expect(() => highestContiguousSequence(4, [
      { eventSequence: 4 }
    ])).toThrow("SYNC_SEQUENCE_REGRESSION");
  });
});
