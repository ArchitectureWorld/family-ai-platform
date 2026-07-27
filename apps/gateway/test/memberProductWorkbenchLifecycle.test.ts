import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCache, MEMBER_CACHE_STORES } from "../member-public/cache.js";
import {
  startProductWorkbench,
  stopProductWorkbench
} from "../member-public/product.js";
import { createRenderer } from "../member-public/render.js";
import { createSyncController } from "../member-public/sync.js";
import { createEntryMutationLock } from "../member-public/entry-mutation.js";
import {
  createMemberDocumentHarness,
  createDeterministicWebLocks,
  deferred,
  memberContextFixture,
  memberProductFetchFixture
} from "./helpers/memberBrowserHarness.js";

type ProductContext = ReturnType<typeof memberContextFixture>;

function identityFor(context: ProductContext) {
  return {
    familyRef: context.family.familyRef,
    personRef: context.person.personRef,
    deviceRef: context.device.deviceRef
  };
}

async function expectCalled(spy: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 20 && spy.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(spy).toHaveBeenCalled();
}

function trackedCache(calls: string[]) {
  const memory = createMemoryCache();
  let snapshotReads = 0;
  return {
    transaction: vi.fn(async (stores: string[], callback: (transaction: unknown) => unknown) => {
      if (
        stores.length === MEMBER_CACHE_STORES.length &&
        MEMBER_CACHE_STORES.every((store) => stores.includes(store))
      ) {
        snapshotReads += 1;
        calls.push(`snapshot:${snapshotReads}`);
      }
      return memory.transaction(stores, callback as never);
    }),
    close: vi.fn(() => calls.push("cache:close"))
  };
}

function harness(input: Record<string, any> = {}) {
  const calls: string[] = input.calls ?? [];
  const context = input.context ?? memberContextFixture();
  const identity = input.identity ?? identityFor(context);
  const cache = input.cache ?? trackedCache(calls);
  const renderer = input.renderer ?? {
    destroy: vi.fn(() => calls.push("renderer:destroy")),
    showToast: vi.fn((message: string) => calls.push(`toast:${message}`))
  };
  let syncInput: Record<string, any> | undefined;
  const sync = input.sync ?? {
    start: vi.fn(async () => {
      calls.push("sync:start");
    }),
    stop: vi.fn(async () => {
      calls.push("sync:stop");
    }),
    reconnectNow: vi.fn(async () => undefined)
  };
  const globalTarget = input.globalTarget ?? {
    addEventListener: vi.fn((type: string) => calls.push(`listener:add:${type}`)),
    removeEventListener: vi.fn((type: string) => calls.push(`listener:remove:${type}`))
  };
  const openCache = input.openCache ?? vi.fn(async () => {
    calls.push("validate");
    return { cache, identity };
  });
  const rendererFactory = input.rendererFactory ?? vi.fn(() => {
    calls.push("renderer");
    return renderer;
  });
  const syncFactory = input.syncFactory ?? vi.fn((value: Record<string, any>) => {
    calls.push("sync:create");
    syncInput = value;
    return sync;
  });
  const acquireProductFlight = input.acquireProductFlight ?? vi.fn(async () => {
    calls.push("flight:acquire");
    return {
      release: vi.fn(async () => {
        calls.push("flight:release");
      })
    };
  });
  const withIdentityOpenLock = input.withIdentityOpenLock ?? vi.fn(async (operation) => {
    calls.push("cache-lock:enter");
    try {
      return await operation();
    } finally {
      calls.push("cache-lock:exit");
    }
  });
  const assertEntryStartable = input.assertEntryStartable ?? vi.fn(() => {
    calls.push("guard");
  });
  const onCacheValidated = input.onCacheValidated ?? vi.fn(async () => {
    calls.push("pointer");
  });

  return {
    calls,
    context,
    identity,
    cache,
    renderer,
    sync,
    globalTarget,
    openCache,
    rendererFactory,
    syncFactory,
    acquireProductFlight,
    withIdentityOpenLock,
    assertEntryStartable,
    onCacheValidated,
    get syncInput() {
      return syncInput;
    },
    options: {
      fetchImpl: input.fetchImpl ?? memberProductFetchFixture(calls),
      timeZone: "UTC",
      openCache,
      rendererFactory,
      syncFactory,
      globalTarget,
      acquireProductFlight,
      withIdentityOpenLock,
      assertEntryStartable,
      onCacheValidated,
      AbortControllerClass: input.AbortControllerClass,
      EventSourceClass: input.EventSourceClass,
      BroadcastChannelClass: input.BroadcastChannelClass,
      onEntryInvalid: input.onEntryInvalid ?? vi.fn(async () => true),
      onEntryRevoked: input.onEntryRevoked ?? vi.fn(async () => true)
    }
  };
}

async function seedNavigation(
  cache: ReturnType<typeof trackedCache>,
  selectedSection: "chat" | "work",
  selectedWorkRef: string | null,
  works: Array<Record<string, unknown>>
) {
  await cache.transaction(["meta", "works"], async (transaction: any) => {
    await transaction.put("meta", { key: "selectedSection", value: selectedSection });
    if (selectedWorkRef) {
      await transaction.put("meta", { key: "selectedWorkRef", value: selectedWorkRef });
    }
    for (const work of works) await transaction.put("works", work);
  });
}

function productFetchWithWorks(
  calls: string[],
  works: Array<Record<string, unknown>> = [],
  options: {
    failChat?: Error;
    failWork?: Error;
    failWorkAfter?: number;
    failSend?: Error;
  } = {}
) {
  let workCalls = 0;
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = String(init.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    if (key === "GET /api/v1/chat?timezone=UTC") {
      calls.push("chat:init");
      if (options.failChat) throw options.failChat;
      return Response.json({
        protocolVersion: 1,
        chat: {
          threadRef: "thread:chat-0001",
          homeChatStreamRef: "home-chat:alice"
        },
        currentEpisode: {
          dailyEpisodeRef: "daily-episode:alice",
          threadRef: "thread:chat-0001"
        }
      });
    }
    if (key === "GET /api/v1/work-conversations") {
      workCalls += 1;
      calls.push(`work:list:${workCalls}`);
      if (options.failWork && workCalls >= (options.failWorkAfter ?? 1)) {
        throw options.failWork;
      }
      return Response.json({ protocolVersion: 1, conversations: works });
    }
    if (key === "GET /api/v1/threads/thread%3Achat-0001/messages?limit=100") {
      calls.push("chat:messages");
      return Response.json({
        protocolVersion: 1,
        threadRef: "thread:chat-0001",
        messages: [],
        nextBeforeSequence: null
      });
    }
    if (key === "POST /api/v1/threads/thread%3Achat-0001/messages") {
      if (options.failSend) throw options.failSend;
      return new Response(null, { status: 204 });
    }
    const workMessage = key.match(
      /^GET \/api\/v1\/threads\/(thread%3Awork-[^/]+)\/messages\?limit=100$/u
    );
    if (workMessage) {
      const threadRef = decodeURIComponent(workMessage[1]);
      calls.push("work:messages");
      return Response.json({
        protocolVersion: 1,
        threadRef,
        messages: [],
        nextBeforeSequence: null
      });
    }
    const progress = key.match(
      /^GET \/api\/v1\/work-conversations\/(work%3A[^/]+)\/progress$/u
    );
    if (progress) {
      calls.push("work:progress");
      return Response.json({
        protocolVersion: 1,
        snapshot: {
          workConversationRef: decodeURIComponent(progress[1]),
          phaseSummary: "推进中"
        }
      });
    }
    throw new Error(`UNEXPECTED_FETCH:${key}`);
  });
}

function deferredStartupInitializerScenario(calls: string[]) {
  const failure = codedError("CHAT_INIT_FAILED", "chat init failed");
  const workTransactionEntered = deferred<void>();
  const workTransactionRelease = deferred<void>();
  const workTransactionSettled = deferred<void>();
  const chatFailureObserved = deferred<void>();
  const baseCache = trackedCache(calls);
  const baseTransaction = baseCache.transaction;
  let deferWorkTransaction = true;
  const cache = {
    transaction: vi.fn(async (
      stores: string[],
      callback: (transaction: unknown) => unknown
    ) => {
      const shouldDefer = deferWorkTransaction &&
        stores.length === 1 &&
        stores[0] === "works";
      if (shouldDefer) {
        deferWorkTransaction = false;
        calls.push("work:transaction:entered");
        workTransactionEntered.resolve();
        await workTransactionRelease.promise;
        calls.push("work:transaction:released");
      }
      try {
        return await baseTransaction(stores, callback as never);
      } finally {
        if (shouldDefer) workTransactionSettled.resolve();
      }
    }),
    close: baseCache.close
  };
  const fallbackFetch = productFetchWithWorks(calls);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = String(init.method ?? "GET").toUpperCase();
    if (`${method} ${url}` === "GET /api/v1/chat?timezone=UTC") {
      calls.push("chat:init");
      await workTransactionEntered.promise;
      chatFailureObserved.resolve();
      throw failure;
    }
    return fallbackFetch(input, init);
  });
  const env = harness({ calls, cache, fetchImpl });
  return {
    env,
    failure,
    chatFailureObserved,
    workTransactionRelease,
    workTransactionSettled
  };
}

function codedError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

async function expectPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

afterEach(async () => {
  await stopProductWorkbench();
});

describe("Member ProductWorkbench secure lifecycle", () => {
  it("validates identity and publishes the cleanup pointer before projections, rendering, initialization, or Sync", async () => {
    const env = harness();

    await expect(startProductWorkbench(env.context, env.options)).resolves.toBeTruthy();

    const index = (label: string) => env.calls.indexOf(label);
    expect(index("flight:acquire")).toBeLessThan(index("cache-lock:enter"));
    expect(index("cache-lock:enter")).toBeLessThan(index("validate"));
    expect(index("validate")).toBeLessThan(index("pointer"));
    expect(index("pointer")).toBeLessThan(index("snapshot:1"));
    expect(index("snapshot:1")).toBeLessThan(index("renderer"));
    expect(index("renderer")).toBeLessThan(index("chat:init"));
    expect(index("renderer")).toBeLessThan(index("work:init"));
    expect(index("chat:init")).toBeLessThan(index("sync:start"));
    expect(index("work:init")).toBeLessThan(index("sync:start"));
  });

  it("rejects an opened cache whose exact identity does not match Context before publishing or projecting", async () => {
    const context = memberContextFixture();
    const env = harness({
      context,
      identity: { ...identityFor(context), deviceRef: "device:other" }
    });

    await expect(startProductWorkbench(context, env.options)).rejects.toMatchObject({
      code: "CACHE_IDENTITY_MISMATCH"
    });

    expect(env.onCacheValidated).not.toHaveBeenCalled();
    expect(env.cache.transaction).not.toHaveBeenCalled();
    expect(env.rendererFactory).not.toHaveBeenCalled();
    expect(env.syncFactory).not.toHaveBeenCalled();
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it.each(["ENTRY_LOCKED", "ENTRY_REVOKED"])(
    "publishes the validated cleanup locator before a trailing %s guard fails closed",
    async (code) => {
      let guards = 0;
      const assertEntryStartable = vi.fn(() => {
        guards += 1;
        if (guards === 4) {
          const error = new Error(code);
          Object.assign(error, { code });
          throw error;
        }
      });
      const env = harness({ assertEntryStartable });

      await expect(startProductWorkbench(env.context, env.options)).rejects.toMatchObject({ code });

      expect(env.onCacheValidated).toHaveBeenCalledOnce();
      expect(env.cache.transaction).not.toHaveBeenCalled();
      expect(env.rendererFactory).not.toHaveBeenCalled();
      expect(env.cache.close).toHaveBeenCalledOnce();
      expect(env.calls.indexOf("pointer")).toBeLessThan(env.calls.indexOf("cache-lock:exit"));
    }
  );

  it("supersedes a validated cache-open generation but still publishes its locator before generation two starts", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = harness({
      openCache: vi.fn(async function () {
        first.calls.push("validate");
        entered.resolve();
        await release.promise;
        return { cache: first.cache, identity: first.identity };
      })
    });
    const second = harness();
    let lateActiveTransitions = 0;

    const firstStart = startProductWorkbench(first.context, first.options).then((result) => {
      if (result) lateActiveTransitions += 1;
      return result;
    });
    void firstStart.catch(() => undefined);
    await expectCalled(first.openCache);
    await entered.promise;
    const secondStart = startProductWorkbench(second.context, second.options);
    release.resolve();

    await expect(firstStart).resolves.toBeNull();
    await expect(secondStart).resolves.toBeTruthy();
    expect(first.onCacheValidated).toHaveBeenCalledOnce();
    expect(first.cache.close).toHaveBeenCalledOnce();
    expect(first.rendererFactory).not.toHaveBeenCalled();
    expect(second.openCache).toHaveBeenCalledOnce();
    expect(lateActiveTransitions).toBe(0);
  });

  it("disposes a generation superseded during Chat initialization before generation two can survive", async () => {
    const chatEntered = deferred<void>();
    const chatResponse = deferred<Response>();
    const firstCalls: string[] = [];
    const fallback = memberProductFetchFixture(firstCalls);
    const firstFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/chat?timezone=UTC") {
        firstCalls.push("chat:init");
        chatEntered.resolve();
        return chatResponse.promise;
      }
      return fallback(input, init);
    });
    const first = harness({ calls: firstCalls, fetchImpl: firstFetch });
    const second = harness({
      openCache: vi.fn(async function () {
        expect(first.cache.close).toHaveBeenCalledOnce();
        second.calls.push("validate");
        return { cache: second.cache, identity: second.identity };
      })
    });

    const firstStart = startProductWorkbench(first.context, first.options);
    void firstStart.catch(() => undefined);
    await expectCalled(firstFetch);
    await chatEntered.promise;
    const secondStart = startProductWorkbench(second.context, second.options);
    chatResponse.resolve(new Response(JSON.stringify({
      protocolVersion: 1,
      chat: {
        threadRef: "thread:chat-0001",
        homeChatStreamRef: "home-chat:alice"
      },
      currentEpisode: {
        dailyEpisodeRef: "daily-episode:alice",
        threadRef: "thread:chat-0001"
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(firstStart).resolves.toBeNull();
    await expect(secondStart).resolves.toBeTruthy();
    expect(first.renderer.destroy).toHaveBeenCalledOnce();
    expect(first.sync.stop).toHaveBeenCalledOnce();
    expect(first.cache.close).toHaveBeenCalledOnce();
  });

  it("makes concurrent stops join abort, Sync barrier, raw transport drain, teardown, and flight release", async () => {
    const calls: string[] = [];
    class TrackedAbortController extends AbortController {
      override abort(reason?: any) {
        calls.push("abort");
        super.abort(reason);
      }
    }
    const syncStop = deferred<void>();
    const rawFetch = deferred<Response>();
    const rawEntered = deferred<void>();
    let rawSignal: AbortSignal | undefined;
    const startupFetch = memberProductFetchFixture(calls);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/pending-I1") {
        calls.push("raw:I1:start");
        rawSignal = init.signal ?? undefined;
        rawEntered.resolve();
        return rawFetch.promise.finally(() => calls.push("raw:I1:settle"));
      }
      return startupFetch(input, init);
    });
    const sync = {
      start: vi.fn(async () => calls.push("sync:start")),
      stop: vi.fn(async () => {
        calls.push("sync:stop");
        await syncStop.promise;
      }),
      reconnectNow: vi.fn(async () => undefined)
    };
    const env = harness({
      calls,
      fetchImpl,
      sync,
      AbortControllerClass: TrackedAbortController
    });
    const workbench = await startProductWorkbench(env.context, env.options);
    const request = env.syncInput!.api.apiRequest("/pending-I1");
    await rawEntered.promise;

    const firstStop = stopProductWorkbench();
    const secondStop = stopProductWorkbench();
    await Promise.resolve();
    await Promise.resolve();

    expect(rawSignal?.aborted).toBe(true);
    expect(sync.stop).toHaveBeenCalledOnce();
    await expectPending(firstStop);
    await expectPending(secondStop);
    syncStop.resolve();
    await expectPending(firstStop);
    const rendererDestroyedBeforeRawDrain =
      env.renderer.destroy.mock.calls.length;
    const listenersRemovedBeforeRawDrain =
      env.globalTarget.removeEventListener.mock.calls.length;

    rawFetch.resolve(new Response(null, { status: 204 }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([firstStop, secondStop]);

    expect(rendererDestroyedBeforeRawDrain).toBe(0);
    expect(listenersRemovedBeforeRawDrain).toBe(0);
    expect(env.renderer.destroy).toHaveBeenCalledOnce();
    expect(env.globalTarget.removeEventListener).toHaveBeenCalledTimes(2);
    expect(env.cache.close).toHaveBeenCalledOnce();
    expect(calls.indexOf("abort")).toBeLessThan(calls.indexOf("sync:stop"));
    expect(calls.indexOf("sync:stop")).toBeLessThan(calls.indexOf("raw:I1:settle"));
    expect(calls.indexOf("raw:I1:settle")).toBeLessThan(
      calls.indexOf("renderer:destroy")
    );
    expect(calls.indexOf("renderer:destroy")).toBeLessThan(
      calls.indexOf("listener:remove:online")
    );
    expect(calls.indexOf("listener:remove:offline")).toBeLessThan(
      calls.indexOf("cache:close")
    );
    expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
    expect(workbench).toBeTruthy();
  });

  it("reopens a saved valid Work and forwards every runtime seam to Sync", async () => {
    class TestEventSource {}
    class TestBroadcastChannel {}
    const calls: string[] = [];
    const work = {
      workConversationRef: "work:0001",
      threadRef: "thread:work-0001",
      title: "已保存 Work",
      goal: "继续推进",
      status: "active",
      summary: ""
    };
    const env = harness({
      calls,
      fetchImpl: productFetchWithWorks(calls, [work]),
      EventSourceClass: TestEventSource,
      BroadcastChannelClass: TestBroadcastChannel
    });
    await seedNavigation(env.cache, "work", work.workConversationRef, [work]);

    const workbench = await startProductWorkbench(env.context, env.options);

    expect(workbench.store.getState()).toMatchObject({
      section: "work",
      selectedWorkRef: "work:0001",
      activeThreadRef: "thread:work-0001"
    });
    expect(calls).toContain("work:messages");
    expect(calls).toContain("work:progress");
    expect(env.syncInput).toMatchObject({
      EventSourceClass: TestEventSource,
      BroadcastChannelClass: TestBroadcastChannel,
      onError: expect.any(Function),
      onCacheUpdated: expect.any(Function),
      onEntryRevoked: expect.any(Function)
    });
  });

  it("waits for the production Broadcast cache reload callback before stop releases resources", async () => {
    const calls: string[] = [];
    const reloadEntered = deferred<void>();
    const reloadRelease = deferred<void>();
    const baseCache = trackedCache(calls);
    const baseTransaction = baseCache.transaction;
    let delayBroadcastReload = false;
    const cache = {
      transaction: vi.fn(async (
        stores: string[],
        callback: (transaction: unknown) => unknown
      ) => {
        if (
          delayBroadcastReload &&
          stores.length === MEMBER_CACHE_STORES.length &&
          MEMBER_CACHE_STORES.every((store) => stores.includes(store))
        ) {
          delayBroadcastReload = false;
          calls.push("broadcast:reload:entered");
          reloadEntered.resolve();
          await reloadRelease.promise;
          calls.push("broadcast:reload:released");
        }
        return baseTransaction(stores, callback as never);
      }),
      close: baseCache.close
    };
    class LifecycleEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {}
      addEventListener() {}
      close() {
        calls.push("event-source:close");
      }
    }
    let channel: LifecycleBroadcastChannel | undefined;
    class LifecycleBroadcastChannel {
      onmessage: ((message: { data: unknown }) => void) | null = null;
      constructor(_name: string) {
        channel = this;
      }
      postMessage() {}
      close() {
        calls.push("broadcast:close");
      }
      dispatch(data: unknown) {
        this.onmessage?.({ data });
      }
    }
    const startupFetch = memberProductFetchFixture(calls);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = String(init.method ?? "GET").toUpperCase();
      if (`${method} ${url}` === "GET /api/v1/sync/events?limit=200") {
        calls.push("sync:catch-up");
        return Response.json({
          protocolVersion: 1,
          sync: {
            deviceRef: "device:web-alice",
            personRef: "person:alice",
            acknowledgedSequence: 0,
            requestedAfterSequence: 0,
            latestSequence: 0
          },
          events: [],
          nextAfterSequence: null
        });
      }
      return startupFetch(input, init);
    });
    const syncFactory = vi.fn((input: Record<string, any>) => createSyncController({
      ...input,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    }));
    const env = harness({
      calls,
      cache,
      fetchImpl,
      syncFactory,
      EventSourceClass: LifecycleEventSource,
      BroadcastChannelClass: LifecycleBroadcastChannel
    });
    await startProductWorkbench(env.context, env.options);
    expect(channel).toBeDefined();

    delayBroadcastReload = true;
    channel!.dispatch({ type: "cache-updated", eventSequence: 1 });
    await reloadEntered.promise;

    const stop = stopProductWorkbench();
    let stopSettled = false;
    void stop.then(
      () => { stopSettled = true; },
      () => { stopSettled = true; }
    );
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const settledBeforeRelease = stopSettled;
    const closedBeforeRelease = env.cache.close.mock.calls.length;
    const releasedBeforeReload = calls.includes("flight:release");

    reloadRelease.resolve();
    await expect(stop).resolves.toBeUndefined();

    expect(settledBeforeRelease).toBe(false);
    expect(closedBeforeRelease).toBe(0);
    expect(releasedBeforeReload).toBe(false);
    expect(calls.indexOf("broadcast:reload:released")).toBeLessThan(
      calls.indexOf("cache:close")
    );
    expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
  });

  it("falls back from a missing saved Work to Chat and persists that navigation", async () => {
    const calls: string[] = [];
    const env = harness({ calls, fetchImpl: productFetchWithWorks(calls) });
    await seedNavigation(env.cache, "work", "work:missing", []);

    const workbench = await startProductWorkbench(env.context, env.options);
    const selectedSection = await env.cache.transaction(
      ["meta"],
      async (transaction: any) => transaction.get("meta", "selectedSection")
    );

    expect(workbench.store.getState()).toMatchObject({
      section: "chat",
      activeThreadRef: "thread:chat-0001"
    });
    expect(selectedSection).toEqual({ key: "selectedSection", value: "chat" });
  });

  it("keeps a non-Entry Work action on the existing toast path", async () => {
    const calls: string[] = [];
    const onEntryInvalid = vi.fn();
    const onEntryRevoked = vi.fn();
    const env = harness({
      calls,
      fetchImpl: productFetchWithWorks(calls),
      onEntryInvalid,
      onEntryRevoked
    });
    const workbench = await startProductWorkbench(env.context, env.options);

    await workbench.actions.openWork("work:missing");

    expect(env.renderer.showToast).toHaveBeenCalledWith("WORK_NOT_FOUND", "error");
    expect(onEntryInvalid).not.toHaveBeenCalled();
    expect(onEntryRevoked).not.toHaveBeenCalled();
  });

  it.each(["chat", "work", "sync"])(
    "disposes and rejects startup DEVICE_AUTH_INVALID from %s without starting runtime recovery",
    async (source) => {
      const calls: string[] = [];
      const failure = codedError("DEVICE_AUTH_INVALID", `invalid:${source}`);
      const onEntryInvalid = vi.fn();
      const onEntryRevoked = vi.fn();
      const sync = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        reconnectNow: vi.fn(async () => undefined)
      };
      const fetchImpl = productFetchWithWorks(calls, [], {
        ...(source === "chat" ? { failChat: failure } : {}),
        ...(source === "work" ? { failWork: failure } : {})
      });
      const syncFactory = vi.fn((input: Record<string, any>) => ({
        ...sync,
        start: vi.fn(async () => {
          if (source === "sync") input.onError(failure);
        })
      }));
      const env = harness({
        calls,
        fetchImpl,
        syncFactory,
        onEntryInvalid,
        onEntryRevoked
      });

      await expect(startProductWorkbench(env.context, env.options)).rejects.toBe(failure);

      expect(onEntryInvalid).not.toHaveBeenCalled();
      expect(onEntryRevoked).not.toHaveBeenCalled();
      expect(env.cache.close).toHaveBeenCalledOnce();
      expect(env.renderer.destroy).toHaveBeenCalledOnce();
    }
  );

  it("preserves a primary startup invalidation while exposing aggregate cleanup failures", async () => {
    const calls: string[] = [];
    const primaryFailure = codedError(
      "DEVICE_AUTH_INVALID",
      "startup credential invalid"
    );
    const destroyFailure = codedError("DESTROY_FAILED");
    const releaseFailure = codedError("FLIGHT_RELEASE_FAILED");
    const renderer = {
      showToast: vi.fn(),
      destroy: vi.fn(() => {
        calls.push("renderer:destroy:failed");
        throw destroyFailure;
      })
    };
    const acquireProductFlight = vi.fn(async () => ({
      release: vi.fn(async () => {
        calls.push("flight:release:failed");
        throw releaseFailure;
      })
    }));
    const env = harness({
      calls,
      fetchImpl: productFetchWithWorks(calls, [], { failChat: primaryFailure }),
      renderer,
      acquireProductFlight
    });

    const startFailure = await startProductWorkbench(env.context, env.options).then(
      () => null,
      (error) => error
    );

    expect(startFailure).toBe(primaryFailure);
    expect(startFailure.code).toBe("DEVICE_AUTH_INVALID");
    expect((startFailure as any).cleanupFailure).toBeInstanceOf(AggregateError);
    expect((startFailure as any).cleanupFailure.errors).toEqual([
      destroyFailure,
      releaseFailure
    ]);
    expect(calls.indexOf("renderer:destroy:failed")).toBeLessThan(
      calls.indexOf("flight:release:failed")
    );
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it.each(["chat", "work"])(
    "fails closed when a transient startup ownership guard failure fires from %s initialization",
    async (source) => {
      const calls: string[] = [];
      const failure = codedError("ENTRY_COOKIE_CLEAR_PENDING", `guard:${source}`);
      let guardArmed = false;
      const assertEntryStartable = vi.fn(() => {
        if (!guardArmed) return;
        guardArmed = false;
        throw failure;
      });
      const fallbackFetch = productFetchWithWorks(calls);
      const targetPath = source === "chat"
        ? "/api/v1/chat?timezone=UTC"
        : "/api/v1/work-conversations";
      const fetchImpl = vi.fn(async (
        input: RequestInfo | URL,
        init: RequestInit = {}
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const response = await fallbackFetch(input, init);
        if (url === targetPath) guardArmed = true;
        return response;
      });
      const env = harness({ calls, fetchImpl, assertEntryStartable });

      await expect(startProductWorkbench(env.context, env.options)).rejects.toBe(failure);

      expect(guardArmed).toBe(false);
      expect(env.renderer.showToast).not.toHaveBeenCalled();
      expect(env.sync.start).not.toHaveBeenCalled();
      expect(env.renderer.destroy).toHaveBeenCalledOnce();
      expect(env.cache.close).toHaveBeenCalledOnce();
      expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
    }
  );

  it("does not publish degraded startup before both initializers settle", async () => {
    const calls: string[] = [];
    const scenario = deferredStartupInitializerScenario(calls);
    const start = startProductWorkbench(scenario.env.context, scenario.env.options);
    let startSettled = false;
    void start.then(
      () => { startSettled = true; },
      () => { startSettled = true; }
    );
    await scenario.chatFailureObserved.promise;
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const settledBeforeWork = startSettled;

    scenario.workTransactionRelease.resolve();
    const workbench = await start;
    await scenario.workTransactionSettled.promise;

    expect(settledBeforeWork).toBe(false);
    expect(workbench).toBeTruthy();
    expect(scenario.env.renderer.showToast).toHaveBeenCalledWith(
      scenario.failure.message,
      "error"
    );
    expect(workbench.store.getState().sync.status).toBe("degraded");
  });

  it("keeps cache close and flight release behind every startup initializer during stop", async () => {
    const calls: string[] = [];
    const scenario = deferredStartupInitializerScenario(calls);
    const start = startProductWorkbench(scenario.env.context, scenario.env.options);
    void start.catch(() => undefined);
    await scenario.chatFailureObserved.promise;

    const stop = stopProductWorkbench();
    let stopSettled = false;
    void stop.then(
      () => { stopSettled = true; },
      () => { stopSettled = true; }
    );
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    const settledBeforeWork = stopSettled;
    const closeBeforeWork = scenario.env.cache.close.mock.calls.length;
    const releaseBeforeWork = calls.includes("flight:release");

    scenario.workTransactionRelease.resolve();
    const [startResult, stopResult] = await Promise.allSettled([start, stop]);
    await scenario.workTransactionSettled.promise;

    expect(settledBeforeWork).toBe(false);
    expect(closeBeforeWork).toBe(0);
    expect(releaseBeforeWork).toBe(false);
    expect(startResult).toEqual({ status: "fulfilled", value: null });
    expect(stopResult.status).toBe("fulfilled");
    expect(calls.indexOf("work:transaction:released")).toBeLessThan(
      calls.indexOf("cache:close")
    );
    expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
  });

  it("keeps Renderer and global handlers attached but inert until the Sync barrier drains", async () => {
    const calls: string[] = [];
    const work = {
      workConversationRef: "work:0001",
      threadRef: "thread:work-0001",
      title: "生命周期 Work",
      goal: "验证 teardown",
      status: "active",
      summary: ""
    };
    const ui = createMemberDocumentHarness();
    let rendererDestroyed = false;
    const rendererFactory = vi.fn((input: Record<string, any>) => {
      const renderer = createRenderer({
        ...input,
        documentRef: ui.document,
        setTimeoutFn: () => 0,
        clearTimeoutFn: () => undefined
      });
      return {
        ...renderer,
        destroy() {
          rendererDestroyed = true;
          calls.push("renderer:destroy");
          renderer.destroy();
        }
      };
    });
    const listeners = new Map<string, Set<() => void>>();
    const globalTarget = {
      addEventListener(type: string, listener: () => void) {
        const current = listeners.get(type) ?? new Set();
        current.add(listener);
        listeners.set(type, current);
        calls.push(`listener:add:${type}`);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
        calls.push(`listener:remove:${type}`);
      },
      dispatch(type: string) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      }
    };
    const syncStopEntered = deferred<void>();
    const syncStopRelease = deferred<void>();
    const sync = {
      start: vi.fn(async () => calls.push("sync:start")),
      stop: vi.fn(async () => {
        calls.push("sync:stop");
        syncStopEntered.resolve();
        await syncStopRelease.promise;
      }),
      reconnectNow: vi.fn(async () => undefined)
    };
    const env = harness({
      calls,
      fetchImpl: productFetchWithWorks(calls, [work]),
      rendererFactory,
      globalTarget,
      sync
    });
    await seedNavigation(env.cache, "chat", null, [work]);
    await startProductWorkbench(env.context, env.options);
    const workButton = ui.document.querySelectorAll(".work-list-item")[0];
    expect(workButton).toBeDefined();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const dispatchErrors: unknown[] = [];
    let stop: Promise<void> | undefined;
    let destroyedBeforeBarrier = false;
    let listenersBeforeBarrier = -1;
    try {
      stop = stopProductWorkbench();
      await syncStopEntered.promise;

      destroyedBeforeBarrier = rendererDestroyed;
      listenersBeforeBarrier =
        (listeners.get("online")?.size ?? 0) +
        (listeners.get("offline")?.size ?? 0);
      workButton.click();
      for (const type of ["online", "offline"]) {
        try {
          globalTarget.dispatch(type);
        } catch (error) {
          dispatchErrors.push(error);
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      syncStopRelease.resolve();
      if (stop) await Promise.allSettled([stop]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.off("unhandledRejection", onUnhandled);
    }

    expect(destroyedBeforeBarrier).toBe(false);
    expect(listenersBeforeBarrier).toBe(2);
    expect(rendererDestroyed).toBe(true);
    expect(
      (listeners.get("online")?.size ?? 0) +
      (listeners.get("offline")?.size ?? 0)
    ).toBe(0);
    expect(dispatchErrors).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(sync.reconnectNow).not.toHaveBeenCalled();
    expect(calls.indexOf("sync:stop")).toBeLessThan(
      calls.indexOf("renderer:destroy")
    );
    expect(calls.indexOf("renderer:destroy")).toBeLessThan(
      calls.indexOf("listener:remove:online")
    );
    expect(calls.indexOf("listener:remove:offline")).toBeLessThan(
      calls.indexOf("cache:close")
    );
    expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
  });

  it("keeps an in-flight action inert before final real Renderer teardown", async () => {
    const calls: string[] = [];
    const work = {
      workConversationRef: "work:0001",
      threadRef: "thread:work-0001",
      title: "延迟 Work",
      goal: "验证停止后的旧 continuation",
      status: "active",
      summary: ""
    };
    const ui = createMemberDocumentHarness();
    const toastTimers = vi.fn(() => 7);
    let rendererDestroyed = false;
    const rendererFactory = vi.fn((input: Record<string, any>) => {
      const renderer = createRenderer({
        ...input,
        documentRef: ui.document,
        setTimeoutFn: toastTimers,
        clearTimeoutFn: vi.fn()
      });
      return {
        ...renderer,
        destroy() {
          rendererDestroyed = true;
          calls.push("renderer:destroy");
          renderer.destroy();
        }
      };
    });
    const rawEntered = deferred<void>();
    const rawResponse = deferred<Response>();
    const fallback = productFetchWithWorks(calls, [work]);
    const fetchImpl = vi.fn((
      input: RequestInfo | URL,
      init: RequestInit = {}
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/work-conversations/work%3A0001/progress") {
        calls.push("raw:work:start");
        rawEntered.resolve();
        return rawResponse.promise.finally(() => calls.push("raw:work:settle"));
      }
      return fallback(input, init);
    });
    const env = harness({ calls, fetchImpl, rendererFactory });
    await seedNavigation(env.cache, "chat", null, [work]);
    const workbench = await startProductWorkbench(env.context, env.options);

    const action = workbench.actions.openWork(work.workConversationRef);
    void action.finally(() => calls.push("action:settle"));
    await rawEntered.promise;
    const stop = stopProductWorkbench();
    await expectPending(stop);
    const destroyedBeforeRawDrain = rendererDestroyed;

    rawResponse.resolve(Response.json({
      protocolVersion: 1,
      snapshot: {
        workConversationRef: work.workConversationRef,
        phaseSummary: "不会写入旧界面"
      }
    }));
    const [actionResult, stopResult] = await Promise.allSettled([action, stop]);

    expect(destroyedBeforeRawDrain).toBe(false);
    expect(actionResult).toEqual({ status: "fulfilled", value: undefined });
    expect(stopResult).toEqual({ status: "fulfilled", value: undefined });
    expect(toastTimers).not.toHaveBeenCalled();
    expect(ui.document.getElementById("productToast")?.textContent).toBe("");
    expect(rendererDestroyed).toBe(true);
    expect(calls.indexOf("raw:work:settle")).toBeLessThan(
      calls.indexOf("action:settle")
    );
    expect(calls.indexOf("action:settle")).toBeLessThan(
      calls.indexOf("renderer:destroy")
    );
  });

  it("keeps generation two behind a pending direct workbench teardown", async () => {
    const firstCalls: string[] = [];
    const syncStopEntered = deferred<void>();
    const syncStopRelease = deferred<void>();
    const first = harness({
      calls: firstCalls,
      sync: {
        start: vi.fn(async () => firstCalls.push("sync:start")),
        stop: vi.fn(async () => {
          firstCalls.push("sync:stop");
          syncStopEntered.resolve();
          await syncStopRelease.promise;
        }),
        reconnectNow: vi.fn(async () => undefined)
      }
    });
    const firstWorkbench = await startProductWorkbench(first.context, first.options);

    const directStop = firstWorkbench.stop();
    await syncStopEntered.promise;
    const secondCalls: string[] = [];
    let secondBytes = 0;
    const secondFetch = memberProductFetchFixture(secondCalls);
    const second = harness({
      calls: secondCalls,
      fetchImpl: vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        secondBytes += 1;
        return secondFetch(input, init);
      })
    });
    const secondStart = startProductWorkbench(second.context, second.options);
    let directSettled = false;
    let secondSettled = false;
    void directStop.finally(() => {
      directSettled = true;
    });
    void secondStart.finally(() => {
      secondSettled = true;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const secondOpensBeforeTeardown = second.openCache.mock.calls.length;
    const secondBytesBeforeTeardown = secondBytes;
    const directSettledBeforeTeardown = directSettled;
    const secondSettledBeforeTeardown = secondSettled;

    syncStopRelease.resolve();
    await expect(directStop).resolves.toBeUndefined();
    await expect(secondStart).resolves.toBeTruthy();
    expect(secondOpensBeforeTeardown).toBe(0);
    expect(secondBytesBeforeTeardown).toBe(0);
    expect(directSettledBeforeTeardown).toBe(false);
    expect(secondSettledBeforeTeardown).toBe(false);
    expect(second.openCache).toHaveBeenCalledOnce();
    expect(secondBytes).toBeGreaterThan(0);
  });

  it("makes an external global stop join a pending direct workbench teardown", async () => {
    const calls: string[] = [];
    const syncStopEntered = deferred<void>();
    const syncStopRelease = deferred<void>();
    const sync = {
      start: vi.fn(async () => calls.push("sync:start")),
      stop: vi.fn(async () => {
        calls.push("sync:stop");
        syncStopEntered.resolve();
        await syncStopRelease.promise;
      }),
      reconnectNow: vi.fn(async () => undefined)
    };
    const env = harness({ calls, sync });
    const workbench = await startProductWorkbench(env.context, env.options);

    const directStop = workbench.stop();
    await syncStopEntered.promise;
    const externalStop = stopProductWorkbench();
    let directSettled = false;
    let externalSettled = false;
    void directStop.finally(() => {
      directSettled = true;
    });
    void externalStop.finally(() => {
      externalSettled = true;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const directSettledBeforeRelease = directSettled;
    const externalSettledBeforeRelease = externalSettled;

    syncStopRelease.resolve();
    await expect(Promise.all([directStop, externalStop])).resolves.toEqual([
      undefined,
      undefined
    ]);
    expect(directSettledBeforeRelease).toBe(false);
    expect(externalSettledBeforeRelease).toBe(false);
    expect(sync.stop).toHaveBeenCalledOnce();
    expect(env.cache.close).toHaveBeenCalledOnce();
    expect(calls.indexOf("sync:stop")).toBeLessThan(calls.indexOf("cache:close"));
  });

  it("lets only the explicit internal Sync stop reentry bypass its own teardown", async () => {
    const calls: string[] = [];
    const reentryEntered = deferred<void>();
    const deadlockEscape = deferred<void>();
    let reentrantStop: Promise<void> | undefined;
    const syncFactory = vi.fn((
      _input: Record<string, any>,
      privateLifecycle: { stopProductWorkbench(): Promise<void> }
    ) => ({
      start: vi.fn(async () => calls.push("sync:start")),
      stop: vi.fn(async () => {
        calls.push("sync:stop");
        reentrantStop = privateLifecycle?.stopProductWorkbench();
        reentryEntered.resolve();
        await Promise.race([
          reentrantStop ?? deadlockEscape.promise,
          deadlockEscape.promise
        ]);
      }),
      reconnectNow: vi.fn(async () => undefined)
    }));
    const env = harness({ calls, syncFactory });
    const workbench = await startProductWorkbench(env.context, env.options);

    const directStop = workbench.stop();
    let directSettled = false;
    void directStop.then(
      () => { directSettled = true; },
      () => { directSettled = true; }
    );
    await reentryEntered.promise;
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    const settledWithoutEscape = directSettled;

    deadlockEscape.resolve();
    await Promise.all([directStop, reentrantStop]);

    expect(settledWithoutEscape).toBe(true);
    expect(syncFactory.mock.results[0].value.stop).toHaveBeenCalledOnce();
    expect(env.cache.close).toHaveBeenCalledOnce();
    expect(calls.indexOf("sync:stop")).toBeLessThan(calls.indexOf("cache:close"));
    expect(calls.indexOf("cache:close")).toBeLessThan(calls.indexOf("flight:release"));
  });

  it("makes a stale internal Sync stop token inert after a new owner becomes active", async () => {
    let firstLifecycle:
      | { stopProductWorkbench(): Promise<void> }
      | undefined;
    const firstSync = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      reconnectNow: vi.fn(async () => undefined)
    };
    const first = harness({
      syncFactory: vi.fn((
        _input: Record<string, any>,
        privateLifecycle: { stopProductWorkbench(): Promise<void> }
      ) => {
        firstLifecycle = privateLifecycle;
        return firstSync;
      })
    });
    await startProductWorkbench(first.context, first.options);
    const second = harness();
    const secondWorkbench = await startProductWorkbench(
      second.context,
      second.options
    );

    await firstLifecycle!.stopProductWorkbench();

    expect(first.cache.close).toHaveBeenCalledOnce();
    expect(second.cache.close).not.toHaveBeenCalled();
    expect(second.renderer.destroy).not.toHaveBeenCalled();
    await expect(
      secondWorkbench.actions.openWork("work:missing")
    ).resolves.toBeUndefined();
    expect(second.renderer.showToast).toHaveBeenCalledWith(
      "WORK_NOT_FOUND",
      "error"
    );
  });

  it("does not let a failed stale owner poison or skip the next owner teardown", async () => {
    const firstFailure = codedError("GEN1_DESTROY_FAILED");
    const first = harness({
      renderer: {
        showToast: vi.fn(),
        destroy: vi.fn(() => {
          throw firstFailure;
        })
      }
    });
    const firstWorkbench = await startProductWorkbench(first.context, first.options);
    await expect(firstWorkbench.stop()).rejects.toBe(firstFailure);

    const secondCalls: string[] = [];
    const second = harness({ calls: secondCalls });
    const secondWorkbench = await startProductWorkbench(
      second.context,
      second.options
    );
    const staleStop = firstWorkbench.stop();
    void staleStop.catch(() => undefined);
    const third = harness();
    const thirdStart = startProductWorkbench(third.context, third.options);
    const [staleResult, thirdResult] = await Promise.allSettled([
      staleStop,
      thirdStart
    ]);
    const secondStopCallsBeforeFallback = second.sync.stop.mock.calls.length;
    const secondCloseCallsBeforeFallback = second.cache.close.mock.calls.length;
    const secondReleaseCallsBeforeFallback = secondCalls.filter(
      (call) => call === "flight:release"
    ).length;

    await Promise.allSettled([
      secondWorkbench.stop(),
      thirdResult.status === "fulfilled" && thirdResult.value
        ? thirdResult.value.stop()
        : Promise.resolve()
    ]);

    expect(staleResult).toEqual({ status: "rejected", reason: firstFailure });
    expect(thirdResult.status).toBe("fulfilled");
    expect(secondStopCallsBeforeFallback).toBe(1);
    expect(secondCloseCallsBeforeFallback).toBe(1);
    expect(secondReleaseCallsBeforeFallback).toBe(1);
  });

  it("aggregates teardown failures in occurrence order while still releasing every resource", async () => {
    const calls: string[] = [];
    const destroyFailure = codedError("DESTROY_FAILED");
    const syncFailure = codedError("SYNC_STOP_FAILED");
    const closeFailure = codedError("CACHE_CLOSE_FAILED");
    const releaseFailure = codedError("FLIGHT_RELEASE_FAILED");
    const baseCache = trackedCache(calls);
    const cache = {
      transaction: baseCache.transaction,
      close: vi.fn(() => {
        calls.push("cache:close:failed");
        throw closeFailure;
      })
    };
    const renderer = {
      showToast: vi.fn(),
      destroy: vi.fn(() => {
        calls.push("renderer:destroy:failed");
        throw destroyFailure;
      })
    };
    const sync = {
      start: vi.fn(async () => calls.push("sync:start")),
      stop: vi.fn(async () => {
        calls.push("sync:stop:failed");
        throw syncFailure;
      }),
      reconnectNow: vi.fn(async () => undefined)
    };
    const acquireProductFlight = vi.fn(async () => ({
      release: vi.fn(async () => {
        calls.push("flight:release:failed");
        throw releaseFailure;
      })
    }));
    const env = harness({
      calls,
      cache,
      renderer,
      sync,
      acquireProductFlight
    });
    await startProductWorkbench(env.context, env.options);

    const teardownFailure = await stopProductWorkbench().then(
      () => null,
      (error) => error
    );

    expect(teardownFailure).toBeInstanceOf(AggregateError);
    expect(teardownFailure.errors).toEqual([
      syncFailure,
      destroyFailure,
      closeFailure,
      releaseFailure
    ]);
    expect(calls.indexOf("sync:stop:failed")).toBeLessThan(
      calls.indexOf("renderer:destroy:failed")
    );
    expect(calls.indexOf("renderer:destroy:failed")).toBeLessThan(
      calls.indexOf("cache:close:failed")
    );
    expect(calls.indexOf("cache:close:failed")).toBeLessThan(
      calls.indexOf("flight:release:failed")
    );
  });

  it("memoizes runtime DEVICE_AUTH_INVALID recovery across Chat, Work, and Sync and suppresses stale callbacks", async () => {
    const calls: string[] = [];
    const recoveryEntered = deferred<void>();
    const releaseRecovery = deferred<void>();
    const recoveryDone = deferred<void>();
    const failure = codedError("DEVICE_AUTH_INVALID", "device auth invalid");
    const onEntryInvalid = vi.fn();
    const onEntryRevoked = vi.fn(async () => {
      recoveryEntered.resolve();
      await releaseRecovery.promise;
      await stopProductWorkbench();
      recoveryDone.resolve();
      return true;
    });
    const env = harness({
      calls,
      fetchImpl: productFetchWithWorks(calls, [], {
        failWork: failure,
        failWorkAfter: 2,
        failSend: failure
      }),
      onEntryInvalid,
      onEntryRevoked
    });
    const workbench = await startProductWorkbench(env.context, env.options);
    workbench.store.setState((current: Record<string, any>) => ({
      ...current,
      network: { online: true }
    }));

    await expect(workbench.actions.send("chat", "测试失效入口")).resolves.toMatchObject({
      status: "failed",
      error: { code: "DEVICE_AUTH_INVALID" }
    });
    await recoveryEntered.promise;
    await workbench.actions.openWork("work:missing");
    expect(env.syncInput!.onError(failure)).toBe(true);
    releaseRecovery.resolve();
    await recoveryDone.promise;
    expect(env.syncInput!.onError(failure)).toBe(true);

    expect(onEntryRevoked).toHaveBeenCalledOnce();
    expect(onEntryInvalid).not.toHaveBeenCalled();
    expect(env.renderer.showToast).not.toHaveBeenCalled();
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it.each(["owner", "renderer", "sync"])(
    "disposes exactly the resources acquired before a %s factory boundary throws",
    async (stage) => {
      const failure = codedError("TEST_PARTIAL_FAILURE", stage);
      const onCacheValidated = stage === "owner"
        ? vi.fn(async () => {
            throw failure;
          })
        : undefined;
      const rendererFactory = stage === "renderer"
        ? vi.fn(() => {
            throw failure;
          })
        : undefined;
      const syncFactory = stage === "sync"
        ? vi.fn(() => {
            throw failure;
          })
        : undefined;
      const env = harness({ onCacheValidated, rendererFactory, syncFactory });

      await expect(startProductWorkbench(env.context, env.options)).rejects.toBe(failure);

      expect(env.cache.close).toHaveBeenCalledOnce();
      expect(env.calls.filter((call) => call === "flight:release")).toHaveLength(1);
      if (stage === "sync") expect(env.renderer.destroy).toHaveBeenCalledOnce();
      else expect(env.renderer.destroy).not.toHaveBeenCalled();
      expect(env.globalTarget.addEventListener).not.toHaveBeenCalled();
    }
  );

  it("publishes the cache locator but blocks rendering when a tombstone lands during a deferred snapshot", async () => {
    const calls: string[] = [];
    const cache = trackedCache(calls);
    const snapshotEntered = deferred<void>();
    const snapshotRelease = deferred<void>();
    const originalTransaction = cache.transaction;
    let firstSnapshot = true;
    cache.transaction = vi.fn(async (stores: string[], callback: (transaction: unknown) => unknown) => {
      if (
        firstSnapshot &&
        stores.length === MEMBER_CACHE_STORES.length &&
        MEMBER_CACHE_STORES.every((store) => stores.includes(store))
      ) {
        firstSnapshot = false;
        snapshotEntered.resolve();
        await snapshotRelease.promise;
      }
      return originalTransaction(stores, callback);
    });
    let tombstoned = false;
    const assertEntryStartable = vi.fn(() => {
      if (tombstoned) throw codedError("ENTRY_REVOKED");
    });
    const env = harness({ calls, cache, assertEntryStartable });

    const start = startProductWorkbench(env.context, env.options);
    await snapshotEntered.promise;
    tombstoned = true;
    snapshotRelease.resolve();

    await expect(start).rejects.toMatchObject({ code: "ENTRY_REVOKED" });
    expect(env.onCacheValidated).toHaveBeenCalledOnce();
    expect(env.rendererFactory).not.toHaveBeenCalled();
    expect(env.syncFactory).not.toHaveBeenCalled();
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it.each([
    "ENTRY_INSTALLATION_CHANGED",
    "ENTRY_CLAIM_INTENT_CHANGED",
    "ENTRY_COOKIE_CLEAR_PENDING"
  ])("blocks %s before an identity pointer write or projection read", async (code) => {
    let pointerWritten = false;
    const onCacheValidated = vi.fn(async () => {
      if (code) throw codedError(code);
      pointerWritten = true;
    });
    const env = harness({ onCacheValidated });

    await expect(startProductWorkbench(env.context, env.options)).rejects.toMatchObject({ code });

    expect(env.openCache).toHaveBeenCalledOnce();
    expect(onCacheValidated).toHaveBeenCalledOnce();
    expect(pointerWritten).toBe(false);
    expect(env.cache.transaction).not.toHaveBeenCalled();
    expect(env.rendererFactory).not.toHaveBeenCalled();
    expect(env.syncFactory).not.toHaveBeenCalled();
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it("keeps Product-first Revoke lock order and publishes the pointer before exclusive deletion", async () => {
    const installationId = "install-a";
    const locks = createDeterministicWebLocks();
    const mutationLock = createEntryMutationLock({ locks });
    const order: string[] = [];
    const entryAcquired = deferred<void>();
    let publishedIdentity: Record<string, string> | null = null;
    let revokePromise: Promise<unknown> = Promise.resolve();
    let productStop: Promise<void> = Promise.resolve();
    const env = harness({
      acquireProductFlight: vi.fn(async () => {
        const lease = await mutationLock.acquireProductFlight(installationId);
        order.push("product:shared-flight");
        return {
          release: async () => {
            order.push("product:release-flight");
            await lease.release();
          }
        };
      }),
      withIdentityOpenLock: vi.fn((operation) =>
        mutationLock.runCacheOpen(installationId, async () => {
          order.push("product:cache-open");
          return operation();
        })
      ),
      onCacheValidated: vi.fn(async (identity) => {
        revokePromise = mutationLock.runCookieMutation(async () => {
          order.push("revoke:cookie");
          await mutationLock.run(installationId, async () => {
            order.push("revoke:entry");
            productStop = stopProductWorkbench();
            entryAcquired.resolve();
            await mutationLock.runProductDrain(installationId, async () => {
              order.push("revoke:exclusive-flight");
              await mutationLock.runCacheOpen(installationId, async () => {
                order.push("revoke:cache-open");
                expect(publishedIdentity).toEqual(identity);
              });
            });
          });
        });
        await entryAcquired.promise;
        publishedIdentity = identity;
        order.push("product:pointer");
      })
    });

    const result = await startProductWorkbench(env.context, env.options);
    await revokePromise;
    await productStop;

    expect(result).toBeNull();
    const position = (event: string) => order.indexOf(event);
    expect(position("product:shared-flight")).toBeLessThan(position("product:cache-open"));
    expect(position("product:cache-open")).toBeLessThan(position("revoke:cookie"));
    expect(position("revoke:cookie")).toBeLessThan(position("revoke:entry"));
    expect(position("revoke:entry")).toBeLessThan(position("product:pointer"));
    expect(position("product:pointer")).toBeLessThan(position("product:release-flight"));
    expect(position("product:release-flight")).toBeLessThan(position("revoke:exclusive-flight"));
    expect(position("revoke:exclusive-flight")).toBeLessThan(position("revoke:cache-open"));
    expect(env.cache.close).toHaveBeenCalledOnce();
  });

  it("keeps Revoke-first order and rejects Product after exclusive rotation before cache-open", async () => {
    const installationId = "install-a";
    const locks = createDeterministicWebLocks();
    const mutationLock = createEntryMutationLock({ locks });
    const order: string[] = [];
    const revokeCacheEntered = deferred<void>();
    const releaseRevoke = deferred<void>();
    let revoked = false;
    const revoke = mutationLock.runCookieMutation(async () => {
      order.push("revoke:cookie");
      await mutationLock.run(installationId, async () => {
        order.push("revoke:entry");
        await mutationLock.runProductDrain(installationId, async () => {
          order.push("revoke:exclusive-flight");
          await mutationLock.runCacheOpen(installationId, async () => {
            order.push("revoke:cache-open");
            revokeCacheEntered.resolve();
            await releaseRevoke.promise;
            revoked = true;
            order.push("revoke:rotate");
          });
        });
      });
    });
    await revokeCacheEntered.promise;
    const withIdentityOpenLock = vi.fn((operation) =>
      mutationLock.runCacheOpen(installationId, operation)
    );
    const env = harness({
      acquireProductFlight: vi.fn(async () => {
        const lease = await mutationLock.acquireProductFlight(installationId);
        order.push("product:shared-flight");
        return {
          release: async () => {
            order.push("product:release-flight");
            await lease.release();
          }
        };
      }),
      withIdentityOpenLock,
      assertEntryStartable: vi.fn(() => {
        if (revoked) throw codedError("ENTRY_REVOKED");
      })
    });

    const start = startProductWorkbench(env.context, env.options);
    await locks.waitForEvent(
      "request",
      `family-ai-member-product-flight:${installationId}`,
      "shared"
    );
    releaseRevoke.resolve();
    await revoke;

    await expect(start).rejects.toMatchObject({ code: "ENTRY_REVOKED" });
    expect(env.openCache).not.toHaveBeenCalled();
    expect(withIdentityOpenLock).not.toHaveBeenCalled();
    expect(order.indexOf("revoke:exclusive-flight")).toBeLessThan(
      order.indexOf("product:shared-flight")
    );
    expect(order.indexOf("revoke:rotate")).toBeLessThan(
      order.indexOf("product:shared-flight")
    );
    expect(order.at(-1)).toBe("product:release-flight");
  });

  it("drains I1 before I2 sends bytes and makes an already captured I1 callback inert", async () => {
    const firstCalls: string[] = [];
    const rawFetch = deferred<Response>();
    const rawEntered = deferred<void>();
    let rawSignal: AbortSignal | undefined;
    const firstStartupFetch = memberProductFetchFixture(firstCalls);
    const firstFetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/I1-pending") {
        rawSignal = init.signal ?? undefined;
        rawEntered.resolve();
        return rawFetch.promise;
      }
      return firstStartupFetch(input, init);
    });
    const first = harness({ calls: firstCalls, fetchImpl: firstFetch });
    await startProductWorkbench(first.context, first.options);
    const staleOnError = first.syncInput!.onError;
    const pendingRequest = first.syncInput!.api.apiRequest("/I1-pending");
    await rawEntered.promise;

    const stop = stopProductWorkbench();
    let secondBytes = 0;
    const secondCalls: string[] = [];
    const secondStartupFetch = memberProductFetchFixture(secondCalls);
    const second = harness({
      calls: secondCalls,
      fetchImpl: vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        secondBytes += 1;
        return secondStartupFetch(input, init);
      })
    });
    const secondStart = startProductWorkbench(second.context, second.options);
    await Promise.resolve();
    await Promise.resolve();

    expect(rawSignal?.aborted).toBe(true);
    expect(secondBytes).toBe(0);
    expect(second.openCache).not.toHaveBeenCalled();
    await expectPending(stop);
    await expectPending(secondStart);

    rawFetch.resolve(new Response(null, { status: 204 }));
    await expect(pendingRequest).rejects.toMatchObject({ name: "AbortError" });
    await stop;
    const secondWorkbench = await secondStart;
    expect(secondBytes).toBeGreaterThan(0);
    expect(secondWorkbench).toBeTruthy();

    expect(staleOnError(codedError("DEVICE_AUTH_INVALID"))).toBe(true);
    await Promise.resolve();
    expect(first.options.onEntryInvalid).not.toHaveBeenCalled();
    expect(first.options.onEntryRevoked).not.toHaveBeenCalled();
    expect(second.options.onEntryInvalid).not.toHaveBeenCalled();
    expect(second.options.onEntryRevoked).not.toHaveBeenCalled();
    expect(second.cache.close).not.toHaveBeenCalled();
  });

  it("waits for an aborted createWork continuation and permits no post-stop cache or store write", async () => {
    const calls: string[] = [];
    const order: string[] = [];
    const createEntered = deferred<void>();
    const createResponse = deferred<Response>();
    const fallback = productFetchWithWorks(calls);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = String(init.method ?? "GET").toUpperCase();
      if (`${method} ${url}` === "POST /api/v1/work-conversations") {
        createEntered.resolve();
        return createResponse.promise;
      }
      return fallback(input, init);
    });
    const env = harness({
      calls,
      fetchImpl,
      acquireProductFlight: vi.fn(async () => ({
        release: vi.fn(async () => {
          order.push("flight:release");
        })
      }))
    });
    const workbench = await startProductWorkbench(env.context, env.options);
    const action = workbench.actions.createWork({
      title: "隔离中的 Work",
      goal: "停止后不可落盘"
    });
    void action.then(
      () => order.push("action:settle"),
      () => order.push("action:settle")
    );
    await createEntered.promise;
    const transactionBaseline = env.cache.transaction.mock.calls.length;
    let storeWrites = 0;
    const unsubscribe = workbench.store.subscribe(() => {
      storeWrites += 1;
    });

    const stop = stopProductWorkbench();
    void stop.then(() => order.push("stop:settle"));
    await expectPending(stop);
    createResponse.resolve(Response.json({
      protocolVersion: 1,
      conversation: {
        workConversationRef: "work:created",
        threadRef: "thread:work-created",
        title: "隔离中的 Work",
        goal: "停止后不可落盘",
        status: "active",
        summary: ""
      }
    }));

    const [actionResult, stopResult] = await Promise.allSettled([action, stop]);
    unsubscribe();

    expect(actionResult).toEqual({ status: "fulfilled", value: undefined });
    expect(stopResult).toEqual({ status: "fulfilled", value: undefined });
    expect(env.cache.transaction).toHaveBeenCalledTimes(transactionBaseline);
    expect(storeWrites).toBe(0);
    expect(order.indexOf("action:settle")).toBeLessThan(order.indexOf("flight:release"));
    expect(order.indexOf("flight:release")).toBeLessThan(order.indexOf("stop:settle"));
  });

  it("waits for an aborted send continuation and permits no post-stop cache or store write", async () => {
    const calls: string[] = [];
    const order: string[] = [];
    const sendEntered = deferred<void>();
    const sendResponse = deferred<Response>();
    const fallback = productFetchWithWorks(calls);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = String(init.method ?? "GET").toUpperCase();
      if (`${method} ${url}` === "POST /api/v1/threads/thread%3Achat-0001/messages") {
        sendEntered.resolve();
        return sendResponse.promise;
      }
      return fallback(input, init);
    });
    const env = harness({
      calls,
      fetchImpl,
      acquireProductFlight: vi.fn(async () => ({
        release: vi.fn(async () => {
          order.push("flight:release");
        })
      }))
    });
    const workbench = await startProductWorkbench(env.context, env.options);
    workbench.store.setState((current: Record<string, any>) => ({
      ...current,
      network: { online: true }
    }));
    const action = workbench.actions.send("chat", "停止后不能写失败投影");
    void action.then(
      () => order.push("action:settle"),
      () => order.push("action:settle")
    );
    await sendEntered.promise;
    const transactionBaseline = env.cache.transaction.mock.calls.length;
    let storeWrites = 0;
    const unsubscribe = workbench.store.subscribe(() => {
      storeWrites += 1;
    });

    const stop = stopProductWorkbench();
    void stop.then(() => order.push("stop:settle"));
    await expectPending(stop);
    sendResponse.resolve(new Response(null, { status: 204 }));

    const [actionResult, stopResult] = await Promise.allSettled([action, stop]);
    unsubscribe();

    expect(actionResult).toEqual({ status: "fulfilled", value: undefined });
    expect(stopResult).toEqual({ status: "fulfilled", value: undefined });
    expect(env.cache.transaction).toHaveBeenCalledTimes(transactionBaseline);
    expect(storeWrites).toBe(0);
    expect(order.indexOf("action:settle")).toBeLessThan(order.indexOf("flight:release"));
    expect(order.indexOf("flight:release")).toBeLessThan(order.indexOf("stop:settle"));
  });

  it("drops a queued generation-one recovery callback when generation two starts first", async () => {
    const staleRecovery = vi.fn(async () => true);
    const first = harness({ onEntryRevoked: staleRecovery });
    await startProductWorkbench(first.context, first.options);

    expect(first.syncInput!.onError(codedError("DEVICE_AUTH_INVALID"))).toBe(true);
    const second = harness();
    const secondWorkbench = await startProductWorkbench(second.context, second.options);

    expect(secondWorkbench).toBeTruthy();
    expect(staleRecovery).not.toHaveBeenCalled();
    expect(first.cache.close).toHaveBeenCalledOnce();
    expect(second.cache.close).not.toHaveBeenCalled();
  });
});
