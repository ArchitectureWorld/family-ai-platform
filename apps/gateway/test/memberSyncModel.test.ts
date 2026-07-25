import { describe, expect, it, vi } from "vitest";
import {
  applyEventTransaction,
  createMemoryCache,
  readBootstrapSnapshot
} from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import {
  createSyncController,
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

function syncState() {
  return {
    activeThreadRef: "thread:chat-0001",
    sync: {
      status: "idle",
      localAppliedSequence: 0,
      acknowledgedSequence: 0,
      latestSequence: 0,
      error: null
    }
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
  }
}

class FakeBroadcastChannel {
  messages: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  close() {}
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

describe("Member Web durable sync controller", () => {
  it("applies every catch-up event before cumulatively acknowledging the page", async () => {
    const cache = createMemoryCache();
    const store = createStore(syncState());
    const actions: string[] = [];
    const first = event("notification.created", { eventRef: "event:0001", eventSequence: 1 });
    const second = event("notification.created", { eventRef: "event:0002", eventSequence: 2 });
    const api = {
      getSyncEvents: vi.fn(async () => ({
        protocolVersion: 1,
        sync: {
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 0,
          requestedAfterSequence: 0,
          latestSequence: 2
        },
        events: [first, second],
        nextAfterSequence: null
      })),
      ackSyncEvent: vi.fn(async (target) => {
        actions.push(`ack:${target.eventSequence}`);
        return { protocolVersion: 1 };
      })
    };
    const controller = createSyncController({
      api,
      cache,
      store,
      applyEvent: async (target) => {
        await applyEventTransaction(cache, target.eventSequence, async () => {
          actions.push(`apply:${target.eventSequence}`);
        });
      },
      EventSourceClass: FakeEventSource,
      BroadcastChannelClass: FakeBroadcastChannel,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });

    await controller.catchUp();
    expect(actions).toEqual(["apply:1", "apply:2", "ack:2"]);
    expect(store.getState().sync).toMatchObject({
      status: "online",
      localAppliedSequence: 2,
      acknowledgedSequence: 2,
      latestSequence: 2
    });
  });

  it("does not ACK an event page when its local transaction fails", async () => {
    const cache = createMemoryCache();
    const store = createStore(syncState());
    const api = {
      getSyncEvents: vi.fn(async () => ({
        protocolVersion: 1,
        sync: {
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 0,
          requestedAfterSequence: 0,
          latestSequence: 1
        },
        events: [event("notification.created", { eventRef: "event:0001", eventSequence: 1 })],
        nextAfterSequence: null
      })),
      ackSyncEvent: vi.fn()
    };
    const controller = createSyncController({
      api,
      cache,
      store,
      applyEvent: async () => {
        throw new Error("LOCAL_WRITE_FAILED");
      },
      EventSourceClass: FakeEventSource,
      BroadcastChannelClass: FakeBroadcastChannel,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });

    await expect(controller.catchUp()).rejects.toThrow("LOCAL_WRITE_FAILED");
    expect(api.ackSyncEvent).not.toHaveBeenCalled();
    expect(store.getState().sync.status).toBe("degraded");
  });

  it("opens SSE from the durable local sequence, applies opaque events and broadcasts cache updates", async () => {
    FakeEventSource.instances = [];
    const cache = createMemoryCache();
    await applyEventTransaction(cache, 1, async () => undefined);
    const store = createStore({
      ...syncState(),
      sync: { ...syncState().sync, localAppliedSequence: 1 }
    });
    const channel = new FakeBroadcastChannel();
    const api = {
      getSyncEvents: vi.fn(async () => ({
        protocolVersion: 1,
        sync: {
          deviceRef: "device:web-alice",
          personRef: "person:alice",
          acknowledgedSequence: 1,
          requestedAfterSequence: 1,
          latestSequence: 1
        },
        events: [],
        nextAfterSequence: null
      })),
      ackSyncEvent: vi.fn(async () => ({ protocolVersion: 1 }))
    };
    const controller = createSyncController({
      api,
      cache,
      store,
      applyEvent: async (target) => {
        await applyEventTransaction(cache, target.eventSequence, async () => undefined);
      },
      EventSourceClass: FakeEventSource,
      BroadcastChannelClass: class {
        constructor() { return channel; }
      },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });

    await controller.start();
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/v1/events/stream?afterSequence=1");
    source.emit("domain-event", event("notification.created", {
      eventRef: "event:0002",
      eventSequence: 2
    }), "2");
    await controller.whenIdle();

    expect(api.ackSyncEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventRef: "event:0002",
      eventSequence: 2
    }));
    expect((await readBootstrapSnapshot(cache)).localAppliedSequence).toBe(2);
    expect(channel.messages).toContainEqual({ type: "cache-updated", eventSequence: 2 });
    controller.stop();
    expect(source.closed).toBe(true);
  });
});
