import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../member-public/api.js";
import {
  createMemoryCache,
  readBootstrapSnapshot
} from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import { createSyncController } from "../member-public/sync.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settlementWithin(promise: Promise<unknown>, timeoutMs = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(() => "fulfilled" as const, () => "rejected" as const),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emptySyncPage() {
  return {
    protocolVersion: 1,
    sync: {
      deviceRef: "device:web-alice",
      personRef: "person:alice",
      acknowledgedSequence: 0,
      requestedAfterSequence: 0,
      latestSequence: 0
    },
    events: [] as Array<ReturnType<typeof realtimeEvent>>,
    nextAfterSequence: null as number | null
  };
}

function realtimeEvent() {
  return {
    eventRef: "event:0001",
    personRef: "person:alice",
    eventSequence: 1,
    eventType: "notification.created",
    aggregateType: "future",
    aggregateRef: "future:0001",
    threadRef: null,
    payload: {},
    occurredAt: "2026-07-27T10:00:00.000Z",
    createdAt: "2026-07-27T10:00:00.000Z"
  };
}

function createSourceHarness() {
  const instances: FakeEventSource[] = [];

  class FakeEventSource {
    url: string;
    closeCount = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, Array<(event: { data: string; lastEventId: string }) => unknown>>();

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    addEventListener(
      type: string,
      listener: (event: { data: string; lastEventId: string }) => unknown
    ) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, data: unknown, lastEventId = "") {
      return (this.listeners.get(type) ?? []).map((listener) => listener({
        data: JSON.stringify(data),
        lastEventId
      }));
    }

    close() {
      this.closeCount += 1;
    }
  }

  return { EventSourceClass: FakeEventSource, instances };
}

function createClockHarness() {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeoutFn(callback: () => void) {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutFn(id: number) {
      timers.delete(id);
    },
    pendingTimers() {
      return timers.size;
    },
    runNext() {
      const next = timers.entries().next().value as [number, () => void] | undefined;
      if (!next) throw new Error("NO_PENDING_TIMER");
      timers.delete(next[0]);
      next[1]();
    }
  };
}

function createSyncHarness(options: {
  getSyncEvents?: () => Promise<ReturnType<typeof emptySyncPage>>;
  applyEvent?: (target: ReturnType<typeof realtimeEvent>) => Promise<void>;
  onEntryRevoked?: () => unknown;
  onCacheUpdated?: (sequence: number) => unknown;
} = {}) {
  const sources = createSourceHarness();
  const clock = createClockHarness();
  const cache = createMemoryCache();
  const store = createStore({
    activeThreadRef: null,
    sync: {
      status: "idle",
      localAppliedSequence: 0,
      acknowledgedSequence: 0,
      latestSequence: 0,
      error: null
    }
  });
  const channel = {
    messages: [] as unknown[],
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) { this.messages.push(message); },
    close: vi.fn()
  };
  const api = {
    getSyncEvents: vi.fn(options.getSyncEvents ?? (async () => emptySyncPage())),
    ackSyncEvent: vi.fn(async () => ({ protocolVersion: 1 }))
  };
  const applyEvent = vi.fn(options.applyEvent ?? (async () => undefined));
  const controller = createSyncController({
    api,
    cache,
    store,
    applyEvent,
    onEntryRevoked: options.onEntryRevoked,
    onCacheUpdated: options.onCacheUpdated,
    EventSourceClass: sources.EventSourceClass,
    BroadcastChannelClass: class { constructor() { return channel; } },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });
  return { controller, sources, clock, channel, api, applyEvent, cache, store };
}

describe("Member Web sync authentication recovery", () => {
  it("reports an expired Entry Session to the Entry lifecycle before retrying", async () => {
    const error = new GatewayError({
      status: 401,
      code: "ENTRY_SESSION_EXPIRED",
      category: "permission",
      message: "入口会话已经过期。",
      retryable: false
    });
    const onError = vi.fn();
    const controller = createSyncController({
      api: {
        getSyncEvents: vi.fn(async () => { throw error; }),
        ackSyncEvent: vi.fn()
      },
      cache: createMemoryCache(),
      store: createStore({
        activeThreadRef: null,
        sync: {
          status: "idle",
          localAppliedSequence: 0,
          acknowledgedSequence: 0,
          latestSequence: 0,
          error: null
        }
      }),
      applyEvent: vi.fn(),
      onError,
      EventSourceClass: class {},
      BroadcastChannelClass: undefined,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });

    await expect(controller.catchUp()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("terminates on the first valid v2 revoke control and joins duplicates without reconnecting", async () => {
    const onEntryRevoked = vi.fn(async () => undefined);
    const { controller, sources, clock, channel, api, applyEvent } = createSyncHarness({
      onEntryRevoked
    });
    await controller.start();
    const source = sources.instances[0];

    source.emit("entry-revoked", { protocolVersion: 1, type: "device_revoked" });
    source.emit("entry-revoked", { protocolVersion: 2, type: "other" });
    await flushMicrotasks();
    const closeCountBeforeValidControl = source.closeCount;

    source.emit("entry-revoked", { protocolVersion: 2, type: "device_revoked" });
    source.emit("entry-revoked", { protocolVersion: 2, type: "device_revoked" });
    await controller.whenIdle();
    source.onerror?.();

    expect(closeCountBeforeValidControl).toBe(0);
    expect(source.closeCount).toBe(1);
    expect(onEntryRevoked).toHaveBeenCalledOnce();
    expect(clock.pendingTimers()).toBe(0);
    expect(sources.instances).toHaveLength(1);
    expect(applyEvent).not.toHaveBeenCalled();
    expect(api.ackSyncEvent).not.toHaveBeenCalled();
    expect(channel.messages).toEqual([]);
  });

  it("keeps ordinary disconnect on the catch-up and reconnect path", async () => {
    const { controller, sources, clock, api } = createSyncHarness();
    await controller.start();
    const source = sources.instances[0];

    source.onerror?.();
    expect(clock.pendingTimers()).toBe(1);
    clock.runNext();
    await controller.whenIdle();

    expect(api.getSyncEvents).toHaveBeenCalledTimes(2);
    expect(sources.instances).toHaveLength(2);
    expect(sources.instances[1].url).toBe("/api/v1/events/stream?afterSequence=0");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("starts revoke recovery immediately while whenIdle joins the predecessor and callback", async () => {
    const predecessor = deferred();
    const predecessorEntered = deferred();
    const callbackRelease = deferred();
    let callbackStarted = false;
    const { controller, sources } = createSyncHarness({
      applyEvent: async () => {
        predecessorEntered.resolve();
        await predecessor.promise;
      },
      onEntryRevoked: async () => {
        callbackStarted = true;
        await callbackRelease.promise;
      }
    });
    await controller.start();
    sources.instances[0].emit("domain-event", realtimeEvent(), "1");
    await predecessorEntered.promise;

    sources.instances[0].emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });
    let idleSettled = false;
    const idle = controller.whenIdle().then(() => { idleSettled = true; });
    await flushMicrotasks();
    const callbackStartedBeforePredecessorRelease = callbackStarted;

    predecessor.resolve();
    await flushMicrotasks();
    const idleSettledBeforeCallbackRelease = idleSettled;
    callbackRelease.resolve();
    await idle;

    expect(callbackStartedBeforePredecessorRelease).toBe(true);
    expect(idleSettledBeforeCallbackRelease).toBe(false);
  });

  it("lets callback-driven Revoke reenter Sync stop without self-deadlock", async () => {
    let controller: ReturnType<typeof createSyncController>;
    let callbackFinished = false;
    const harness = createSyncHarness({
      onEntryRevoked: async () => {
        await controller.stop();
        callbackFinished = true;
      }
    });
    controller = harness.controller;
    await controller.start();

    harness.sources.instances[0].emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });

    expect(await settlementWithin(controller.whenIdle())).toBe("fulfilled");
    expect(callbackFinished).toBe(true);
  });

  it("cancels an already scheduled reconnect when a revoke control wins", async () => {
    const onEntryRevoked = vi.fn(async () => undefined);
    const { controller, sources, clock } = createSyncHarness({ onEntryRevoked });
    await controller.start();
    const source = sources.instances[0];
    source.onerror?.();
    expect(clock.pendingTimers()).toBe(1);

    source.emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });
    await controller.whenIdle();

    expect(clock.pendingTimers()).toBe(0);
    expect(onEntryRevoked).toHaveBeenCalledOnce();
    expect(sources.instances).toHaveLength(1);
  });

  it("makes external stop await the older lane but not the revoke callback tail", async () => {
    const predecessor = deferred();
    const predecessorEntered = deferred();
    const callbackRelease = deferred();
    let callbackStarted = false;
    const { controller, sources } = createSyncHarness({
      applyEvent: async () => {
        predecessorEntered.resolve();
        await predecessor.promise;
      },
      onEntryRevoked: async () => {
        callbackStarted = true;
        await callbackRelease.promise;
      }
    });
    await controller.start();
    sources.instances[0].emit("domain-event", realtimeEvent(), "1");
    await predecessorEntered.promise;
    sources.instances[0].emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });

    let stopSettled = false;
    const stop = Promise.resolve(controller.stop()).then(() => { stopSettled = true; });
    await flushMicrotasks();
    const stopSettledBeforePredecessorRelease = stopSettled;
    const callbackStartedBeforePredecessorRelease = callbackStarted;
    predecessor.resolve();
    const stopOutcome = await settlementWithin(stop);
    const stopSettledBeforeCallbackRelease = stopSettled;
    callbackRelease.resolve();
    await controller.whenIdle();

    expect(stopSettledBeforePredecessorRelease).toBe(false);
    expect(stopOutcome).toBe("fulfilled");
    expect(callbackStartedBeforePredecessorRelease).toBe(true);
    expect(stopSettledBeforeCallbackRelease).toBe(true);
  });

  it("lets revoke recovery abort the only pending raw Sync fetch and finish cleanup", async () => {
    const rawFetch = deferredValue<ReturnType<typeof emptySyncPage>>();
    const rawFetchEntered = deferred();
    let requestCount = 0;
    let controller: ReturnType<typeof createSyncController>;
    let recoveryFinished = false;
    const harness = createSyncHarness({
      getSyncEvents: async () => {
        requestCount += 1;
        if (requestCount === 1) return emptySyncPage();
        rawFetchEntered.resolve();
        return rawFetch.promise;
      },
      onEntryRevoked: async () => {
        rawFetch.reject(new Error("ABORTED_BY_PRODUCT"));
        await controller.stop();
        recoveryFinished = true;
      }
    });
    controller = harness.controller;
    await controller.start();
    const source = harness.sources.instances[0];
    const reconnect = controller.reconnectNow();
    await rawFetchEntered.promise;

    source.emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });
    const idle = controller.whenIdle();
    const outcome = await settlementWithin(idle, 400);
    if (outcome === "timeout") rawFetch.reject(new Error("TEST_CLEANUP"));
    await settlementWithin(reconnect);
    await Promise.resolve(controller.stop());

    expect(outcome).toBe("fulfilled");
    expect(recoveryFinished).toBe(true);
    expect(harness.clock.pendingTimers()).toBe(0);
    expect(harness.sources.instances).toHaveLength(1);
  });

  it("ignores a valid revoke control delivered late by a stale EventSource", async () => {
    const onEntryRevoked = vi.fn(async () => undefined);
    const { controller, sources, clock } = createSyncHarness({ onEntryRevoked });
    await controller.start();
    const staleSource = sources.instances[0];
    staleSource.onerror?.();
    clock.runNext();
    await controller.whenIdle();
    const currentSource = sources.instances[1];

    staleSource.emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked"
    });
    await flushMicrotasks();

    expect(onEntryRevoked).not.toHaveBeenCalled();
    expect(currentSource.closeCount).toBe(0);
    currentSource.onerror?.();
    expect(clock.pendingTimers()).toBe(1);
    await controller.stop();
    expect(clock.pendingTimers()).toBe(0);
  });

  it("rejects non-exact revoke payloads and throwing message data without closing current Sync", async () => {
    const onEntryRevoked = vi.fn(async () => undefined);
    const { controller, sources, clock } = createSyncHarness({ onEntryRevoked });
    await controller.start();
    const source = sources.instances[0];

    source.emit("entry-revoked", {
      protocolVersion: 2,
      type: "device_revoked",
      reason: "extra-field"
    });
    source.emit("entry-revoked", [
      { protocolVersion: 2, type: "device_revoked" }
    ]);
    for (const listener of source.listeners.get("entry-revoked") ?? []) {
      listener({
        get data(): string { throw new Error("MESSAGE_DATA_GETTER_FAILED"); },
        lastEventId: ""
      });
    }
    await flushMicrotasks();

    expect(onEntryRevoked).not.toHaveBeenCalled();
    expect(source.closeCount).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(sources.instances).toHaveLength(1);
    await controller.stop();
  });

  it("keeps stop pending on initial catch-up and blocks every post-stop side effect", async () => {
    const response = deferredValue<ReturnType<typeof emptySyncPage>>();
    const requestEntered = deferred();
    const harness = createSyncHarness({
      getSyncEvents: async () => {
        requestEntered.resolve();
        return response.promise;
      }
    });
    const start = harness.controller.start();
    await requestEntered.promise;

    let stopSettled = false;
    const stop = Promise.resolve(harness.controller.stop()).then(() => { stopSettled = true; });
    await flushMicrotasks();
    const stopSettledBeforeResponse = stopSettled;
    const page = emptySyncPage();
    response.resolve({
      ...page,
      sync: {
        ...page.sync,
        requestedAfterSequence: 7,
        latestSequence: 1
      },
      events: [realtimeEvent()]
    });

    expect(await settlementWithin(stop)).toBe("fulfilled");
    await start;
    const snapshot = await readBootstrapSnapshot(harness.cache);
    expect(stopSettledBeforeResponse).toBe(false);
    expect(snapshot.localAppliedSequence).toBe(0);
    expect(harness.applyEvent).not.toHaveBeenCalled();
    expect(harness.api.ackSyncEvent).not.toHaveBeenCalled();
    expect(harness.channel.messages).toEqual([]);
    expect(harness.sources.instances).toHaveLength(0);
  });

  it("keeps reconnectNow completely inert after stop", async () => {
    const harness = createSyncHarness();
    await harness.controller.start();
    await harness.controller.stop();
    harness.store.setState((current) => ({
      ...current,
      sync: { ...current.sync, status: "stopped-sentinel" }
    }));
    const beforeState = harness.store.getState();
    const beforeRequests = harness.api.getSyncEvents.mock.calls.length;
    const beforeSources = harness.sources.instances.length;

    expect(await settlementWithin(harness.controller.reconnectNow())).toBe("fulfilled");
    expect(harness.api.getSyncEvents).toHaveBeenCalledTimes(beforeRequests);
    expect(harness.sources.instances).toHaveLength(beforeSources);
    expect(harness.clock.pendingTimers()).toBe(0);
    expect(harness.store.getState()).toEqual(beforeState);
  });

  it("joins an accepted Broadcast callback and makes a captured handler inert after stop", async () => {
    const callbackRelease = deferred();
    const callbackStarted = deferred();
    const onCacheUpdated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackRelease.promise;
    });
    const harness = createSyncHarness({ onCacheUpdated });
    await harness.controller.start();
    const capturedOnMessage = harness.channel.onmessage!;
    capturedOnMessage({
      data: { type: "cache-updated", eventSequence: 7 }
    });
    await callbackStarted.promise;
    expect(harness.store.getState().sync.localAppliedSequence).toBe(7);

    let stopSettled = false;
    const stop = Promise.resolve(harness.controller.stop()).then(() => { stopSettled = true; });
    await flushMicrotasks();
    const stopSettledBeforeCallbackRelease = stopSettled;
    callbackRelease.resolve();
    expect(await settlementWithin(stop)).toBe("fulfilled");
    const stateAfterStop = harness.store.getState();
    const callsAfterStop = onCacheUpdated.mock.calls.length;
    capturedOnMessage({
      data: { type: "cache-updated", eventSequence: 9 }
    });
    await flushMicrotasks();

    expect(stopSettledBeforeCallbackRelease).toBe(false);
    expect(onCacheUpdated).toHaveBeenCalledTimes(callsAfterStop);
    expect(harness.store.getState()).toEqual(stateAfterStop);
    expect(harness.channel.close).toHaveBeenCalledOnce();
  });
});
