import { createApiClient } from "./api.js";
import {
  applyEventTransaction,
  readBootstrapSnapshot,
  saveMeta
} from "./cache.js";
import {
  cacheIdentityFromContext,
  openIdentityMemberCache,
  sameCacheIdentity
} from "./cache-identity.js";
import { createChatController } from "./chat.js";
import { createRenderer } from "./render.js";
import { createStore } from "./store.js";
import { createSyncController, eventRefreshPlan } from "./sync.js";
import {
  createThreadController,
  mergeThreadMessages,
  reconcileOutgoing
} from "./thread.js";
import { createWorkController } from "./work.js";

let activeWorkbench = null;
let requestedGeneration = 0;
let startLane = Promise.resolve();
let detachedTeardown = null;
const INTERNAL_SYNC_STOP = Symbol("internal-sync-stop");
const workbenchDisposers = new WeakMap();

function groupByThread(messages) {
  const grouped = {};
  for (const message of messages ?? []) {
    const list = grouped[message.threadRef] ?? [];
    list.push(message);
    grouped[message.threadRef] = list;
  }
  for (const list of Object.values(grouped)) {
    list.sort((left, right) => left.threadSequence - right.threadSequence);
  }
  return grouped;
}

function mapBy(items, key) {
  return Object.fromEntries((items ?? []).map((item) => [item[key], item]));
}

function draftMap(drafts) {
  return Object.fromEntries((drafts ?? []).map((draft) => [draft.threadRef, draft.text]));
}

function selectedWork(state) {
  return state.works?.find((work) => work.workConversationRef === state.selectedWorkRef) ?? null;
}

export function nextNavigationState(state, section) {
  if (section === "chat") {
    return {
      ...state,
      section: "chat",
      activeThreadRef: state.chat?.threadRef ?? null
    };
  }
  const work = selectedWork(state);
  return {
    ...state,
    section: "work",
    activeThreadRef: work?.threadRef ?? null
  };
}

function initialState(context, snapshot) {
  const section = snapshot.selectedSection === "work" ? "work" : "chat";
  return {
    context,
    section,
    chat: null,
    currentEpisode: null,
    works: snapshot.works ?? [],
    selectedWorkRef: snapshot.selectedWorkRef ?? null,
    activeThreadRef: null,
    messagesByThread: groupByThread(snapshot.messages),
    paginationByThread: {},
    outgoing: snapshot.outgoing ?? [],
    drafts: draftMap(snapshot.drafts),
    selectedMessageRefs: [],
    progressByWork: mapBy(snapshot.progress, "workConversationRef"),
    network: { online: typeof navigator === "undefined" || navigator.onLine },
    sync: {
      status: "idle",
      localAppliedSequence: snapshot.localAppliedSequence ?? 0,
      acknowledgedSequence: 0,
      latestSequence: snapshot.localAppliedSequence ?? 0,
      error: null
    },
    busy: {}
  };
}

function isEntryFailure(error) {
  return [
    "ENTRY_SESSION_EXPIRED",
    "ENTRY_SESSION_INVALID",
    "DEVICE_REVOKED",
    "DEVICE_AUTH_INVALID"
  ].includes(error?.code);
}

async function reloadCacheIntoStore(cache, store) {
  const snapshot = await readBootstrapSnapshot(cache);
  store.setState((current) => ({
    ...current,
    works: snapshot.works,
    messagesByThread: groupByThread(snapshot.messages),
    outgoing: snapshot.outgoing,
    drafts: draftMap(snapshot.drafts),
    progressByWork: mapBy(snapshot.progress, "workConversationRef"),
    sync: {
      ...current.sync,
      localAppliedSequence: Math.max(
        current.sync?.localAppliedSequence ?? 0,
        snapshot.localAppliedSequence
      )
    }
  }));
}

function userMessageForEvent(target, threadPages, state) {
  const messageRef = target.payload?.userMessageRef;
  if (!messageRef || !target.threadRef) return null;
  const page = threadPages.get(target.threadRef);
  return page?.messages?.find((message) => message.messageRef === messageRef) ??
    state.messagesByThread?.[target.threadRef]?.find((message) => message.messageRef === messageRef) ??
    null;
}

function failedOutgoing(target, message) {
  if (!message?.clientMessageId) return null;
  return {
    threadRef: message.threadRef,
    clientMessageId: message.clientMessageId,
    occurredAt: message.occurredAt,
    content: structuredClone(message.content),
    status: "failed",
    error: {
      status: 502,
      code: target.payload?.error?.code ?? "PROVIDER_FAILED",
      category: target.payload?.error?.category ?? "availability",
      message: "个人助理回复失败，可以重试。",
      retryable: Boolean(target.payload?.error?.retryable)
    }
  };
}

export function createEventApplier(input) {
  const { api, cache, store } = input;
  const timeZone = input.timeZone ?? "UTC";

  return async function applyEvent(target) {
    const beforeSnapshot = await readBootstrapSnapshot(cache);
    if (target.eventSequence <= beforeSnapshot.localAppliedSequence) return false;
    if (target.eventSequence !== beforeSnapshot.localAppliedSequence + 1) {
      throw new Error("SYNC_SEQUENCE_GAP");
    }

    const plan = eventRefreshPlan(target, store.getState().activeThreadRef);
    const chatResponse = plan.chat ? await api.getHomeChat(timeZone) : null;
    const worksResponse = plan.works ? await api.listWorks() : null;
    const threadPages = new Map();
    for (const threadRef of plan.threads) {
      threadPages.set(threadRef, await api.getThreadMessages(threadRef, { limit: 100 }));
    }
    const progressResponses = new Map();
    for (const workConversationRef of plan.progress) {
      progressResponses.set(
        workConversationRef,
        await api.getWorkProgress(workConversationRef)
      );
    }

    const currentState = store.getState();
    const userMessage = userMessageForEvent(target, threadPages, currentState);
    const failure = target.eventType === "thread.provider_turn.failed"
      ? failedOutgoing(target, userMessage)
      : null;
    const succeededClientMessageId = target.eventType === "thread.provider_turn.succeeded"
      ? userMessage?.clientMessageId ?? null
      : null;

    const committed = await applyEventTransaction(cache, target.eventSequence, async (transaction) => {
      if (chatResponse) {
        await transaction.put("meta", { key: "chat", value: chatResponse });
        await transaction.put("threads", chatResponse.chat);
      }
      if (worksResponse) {
        await transaction.clear("works");
        for (const work of worksResponse.conversations) {
          await transaction.put("works", work);
          await transaction.put("threads", work);
        }
      }
      for (const page of threadPages.values()) {
        for (const message of page.messages) await transaction.put("messages", message);
      }
      for (const response of progressResponses.values()) {
        if (response?.snapshot) await transaction.put("progress", response.snapshot);
      }

      const cachedOutgoing = await transaction.getAll("outgoing");
      const authoritativeMessages = [...threadPages.values()].flatMap((page) => page.messages);
      const reconciled = reconcileOutgoing(cachedOutgoing, authoritativeMessages);
      const reconciledIds = new Set(reconciled.map((item) => item.clientMessageId));
      for (const item of cachedOutgoing) {
        if (!reconciledIds.has(item.clientMessageId)) {
          await transaction.delete("outgoing", item.clientMessageId);
        }
      }
      if (failure) await transaction.put("outgoing", failure);
      if (succeededClientMessageId) {
        await transaction.delete("outgoing", succeededClientMessageId);
      }
    });
    if (!committed) return false;

    const afterSnapshot = await readBootstrapSnapshot(cache);
    store.setState((current) => {
      const paginationByThread = { ...(current.paginationByThread ?? {}) };
      for (const [threadRef, page] of threadPages) {
        if (!Object.prototype.hasOwnProperty.call(paginationByThread, threadRef)) {
          paginationByThread[threadRef] = page.nextBeforeSequence ?? null;
        }
      }
      const works = worksResponse?.conversations ?? afterSnapshot.works;
      const selectedStillExists = works.some(
        (work) => work.workConversationRef === current.selectedWorkRef
      );
      return {
        ...current,
        chat: chatResponse?.chat ?? current.chat,
        currentEpisode: chatResponse?.currentEpisode ?? current.currentEpisode,
        works,
        selectedWorkRef: selectedStillExists ? current.selectedWorkRef : null,
        messagesByThread: groupByThread(afterSnapshot.messages),
        paginationByThread,
        outgoing: afterSnapshot.outgoing,
        progressByWork: mapBy(afterSnapshot.progress, "workConversationRef")
      };
    });
    return true;
  };
}

function beginWorkbenchTeardown(workbench) {
  if (!workbench) return detachedTeardown?.promise ?? Promise.resolve();
  if (detachedTeardown?.owner === workbench) {
    return detachedTeardown.promise;
  }
  if (activeWorkbench === workbench) activeWorkbench = null;
  const predecessor = detachedTeardown
    ? detachedTeardown.promise.catch(() => undefined)
    : Promise.resolve();
  const dispose = workbenchDisposers.get(workbench);
  if (typeof dispose !== "function") return predecessor;
  const teardown = predecessor.then(() => dispose());
  const record = {
    owner: workbench,
    predecessor,
    promise: teardown
  };
  detachedTeardown = record;
  const clearIfOwned = () => {
    if (detachedTeardown === record) detachedTeardown = null;
  };
  teardown.then(clearIfOwned, clearIfOwned);
  return teardown;
}

function detachActiveWorkbench(token, owner) {
  if (token === INTERNAL_SYNC_STOP) {
    if (!owner) return Promise.resolve();
    if (detachedTeardown?.owner === owner) {
      return detachedTeardown.predecessor;
    }
    if (activeWorkbench === owner) {
      return beginWorkbenchTeardown(owner);
    }
    return Promise.resolve();
  }
  const current = activeWorkbench;
  if (current) return beginWorkbenchTeardown(current);
  return detachedTeardown?.promise ?? Promise.resolve();
}

function stopWorkbenchFromSync(owner) {
  if (activeWorkbench === owner) requestedGeneration += 1;
  return detachActiveWorkbench(INTERNAL_SYNC_STOP, owner);
}

function attachCleanupFailure(primary, cleanupFailure) {
  if (
    primary !== null &&
    (typeof primary === "object" || typeof primary === "function")
  ) {
    try {
      if (Object.isExtensible(primary) && !("cleanupFailure" in primary)) {
        Object.defineProperty(primary, "cleanupFailure", {
          configurable: true,
          enumerable: false,
          value: cleanupFailure
        });
        return primary;
      }
    } catch {
      // A hostile or non-extensible foreign error is wrapped below.
    }
  }
  const combined = new AggregateError(
    [primary, cleanupFailure],
    primary?.message ?? "Product startup and cleanup failed."
  );
  if (primary?.code !== undefined) combined.code = primary.code;
  Object.defineProperty(combined, "cause", {
    configurable: true,
    value: primary
  });
  Object.defineProperty(combined, "cleanupFailure", {
    configurable: true,
    value: cleanupFailure
  });
  return combined;
}

export function startProductWorkbench(context, options = {}) {
  const generation = ++requestedGeneration;
  const eagerStop = detachActiveWorkbench();
  const result = startLane.then(() =>
    startWorkbenchGeneration(context, options, generation, eagerStop)
  );
  startLane = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function startWorkbenchGeneration(context, options, generation, eagerStop) {
  const assertEntryStartable = options.assertEntryStartable ?? (() => {});
  const openCache = options.openCache ?? openIdentityMemberCache;
  const rendererFactory = options.rendererFactory ?? createRenderer;
  const syncFactory = options.syncFactory ?? createSyncController;
  const globalTarget = options.globalTarget ?? globalThis;
  const withIdentityOpenLock = options.withIdentityOpenLock ?? (async (operation) => operation());
  const acquireProductFlight = options.acquireProductFlight ?? (async () => ({
    release: async () => {}
  }));
  const onCacheValidated = options.onCacheValidated ?? (() => {});
  const onEntryInvalid = options.onEntryInvalid ?? (() => {});
  const onEntryRevoked = options.onEntryRevoked ?? (() => {});
  const AbortControllerClass = options.AbortControllerClass ?? globalThis.AbortController;
  const requestAbort = new AbortControllerClass();
  const pendingRequests = new Set();
  const pendingActions = new Set();
  const ownershipGuardFailures = new WeakSet();
  const api = createApiClient(options.fetchImpl, {
    defaultSignal: requestAbort.signal,
    onRequest(promise) {
      pendingRequests.add(promise);
      promise.then(
        () => pendingRequests.delete(promise),
        () => pendingRequests.delete(promise)
      );
    }
  });
  let disposed = false;
  let cache = null;
  let identity = null;
  let renderer = null;
  let syncController = null;
  let onlineAttached = false;
  let offlineAttached = false;
  let ownedWorkbench = null;
  let productFlightLease = null;
  let disposePromise = null;
  let online = () => undefined;
  let offline = () => undefined;

  function assertCurrentGeneration() {
    if (generation !== requestedGeneration) {
      const error = new Error("Product start was superseded.");
      error.code = "PRODUCT_START_SUPERSEDED";
      throw error;
    }
  }

  function disposedWorkbenchError() {
    const error = new Error("Product workbench is disposed.");
    error.code = "PRODUCT_WORKBENCH_DISPOSED";
    return error;
  }

  function ownershipGuardFailure(caught) {
    if (
      (typeof caught === "object" && caught !== null) ||
      typeof caught === "function"
    ) {
      ownershipGuardFailures.add(caught);
      return caught;
    }
    const error = new Error("Entry ownership guard failed.");
    error.code = "PRODUCT_ENTRY_OWNERSHIP_GUARD_FAILED";
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: caught
    });
    ownershipGuardFailures.add(error);
    return error;
  }

  function assertEntryOwnership() {
    try {
      assertEntryStartable();
    } catch (error) {
      throw ownershipGuardFailure(error);
    }
  }

  function isOwnershipGuardFailure(error) {
    return (
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    ) && ownershipGuardFailures.has(error);
  }

  function assertStartupOwnership() {
    assertCurrentGeneration();
    assertEntryOwnership();
  }

  function assertRuntimeOwnership() {
    if (disposed) throw disposedWorkbenchError();
    assertCurrentGeneration();
    assertEntryOwnership();
  }

  function runtimeInactive() {
    return disposed || generation !== requestedGeneration;
  }

  function guardedTransaction(transaction) {
    return new Proxy(transaction, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args) => {
          assertRuntimeOwnership();
          const result = await value.apply(target, args);
          assertRuntimeOwnership();
          return result;
        };
      }
    });
  }

  function guardedCache(cacheConnection) {
    return {
      async transaction(storeNames, operation) {
        assertRuntimeOwnership();
        const result = await cacheConnection.transaction(
          storeNames,
          async (transaction) => {
            assertRuntimeOwnership();
            const value = await operation(guardedTransaction(transaction));
            assertRuntimeOwnership();
            return value;
          }
        );
        assertRuntimeOwnership();
        return result;
      },
      close() {
        cacheConnection.close();
      }
    };
  }

  function guardedStore(storeConnection) {
    return {
      getState: () => storeConnection.getState(),
      setState(update) {
        assertRuntimeOwnership();
        const guardedUpdate = typeof update === "function"
          ? (current) => {
              assertRuntimeOwnership();
              const next = update(current);
              assertRuntimeOwnership();
              return next;
            }
          : update;
        const result = storeConnection.setState(guardedUpdate);
        assertRuntimeOwnership();
        return result;
      },
      subscribe: (listener) => storeConnection.subscribe(listener),
      reset() {
        assertRuntimeOwnership();
        const result = storeConnection.reset();
        assertRuntimeOwnership();
        return result;
      }
    };
  }

  function trackActionPromise(promise) {
    const tracked = Promise.resolve(promise);
    pendingActions.add(tracked);
    const release = () => pendingActions.delete(tracked);
    tracked.then(release, release);
    return tracked;
  }

  function runTrackedAction(action) {
    if (runtimeInactive()) return Promise.resolve(undefined);
    let tracked;
    try {
      assertRuntimeOwnership();
      tracked = trackActionPromise(action());
    } catch (error) {
      if (runtimeInactive()) return Promise.resolve(undefined);
      return Promise.reject(error);
    }
    return tracked.then(
      (value) => runtimeInactive() ? undefined : value,
      (error) => {
        if (runtimeInactive()) return undefined;
        throw error;
      }
    );
  }

  function runOwnedAction(action) {
    if (runtimeInactive()) return undefined;
    assertRuntimeOwnership();
    const result = action();
    assertRuntimeOwnership();
    return result;
  }

  async function releaseProductFlight() {
    const lease = productFlightLease;
    productFlightLease = null;
    await lease?.release?.();
  }

  function disposeOwnedResources() {
    if (disposePromise) return disposePromise;
    disposed = true;
    let resolveDispose;
    let rejectDispose;
    disposePromise = new Promise((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    const disposalErrors = [];
    try {
      requestAbort.abort();
    } catch (error) {
      disposalErrors.push(error);
    }

    Promise.resolve().then(async () => {
      const settleStage = async (operation) => {
        try {
          await operation();
        } catch (error) {
          disposalErrors.push(error);
        }
      };
      await settleStage(() => syncController?.stop?.());
      await settleStage(async () => {
        while (pendingRequests.size > 0) {
          await Promise.allSettled([...pendingRequests]);
        }
      });
      await settleStage(async () => {
        while (pendingActions.size > 0) {
          await Promise.allSettled([...pendingActions]);
        }
      });
      await settleStage(() => renderer?.destroy?.());
      await settleStage(() => {
        if (!onlineAttached) return;
        try {
          globalTarget.removeEventListener?.("online", online);
        } finally {
          onlineAttached = false;
        }
      });
      await settleStage(() => {
        if (!offlineAttached) return;
        try {
          globalTarget.removeEventListener?.("offline", offline);
        } finally {
          offlineAttached = false;
        }
      });
      await settleStage(() => cache?.close?.());
      await settleStage(() => releaseProductFlight());
      if (disposalErrors.length === 1) throw disposalErrors[0];
      if (disposalErrors.length > 1) {
        throw new AggregateError(
          disposalErrors,
          "Product workbench teardown failed."
        );
      }
    }).then(resolveDispose, rejectDispose);
    return disposePromise;
  }

  try {
    await eagerStop;
    assertStartupOwnership();
    productFlightLease = await acquireProductFlight();
    assertStartupOwnership();
    await withIdentityOpenLock(async () => {
      assertStartupOwnership();
      const opened = await openCache(context);
      cache = opened.cache;
      identity = opened.identity;
      if (!sameCacheIdentity(identity, cacheIdentityFromContext(context))) {
        const error = new Error("CACHE_IDENTITY_MISMATCH");
        error.code = "CACHE_IDENTITY_MISMATCH";
        throw error;
      }
      await onCacheValidated(identity);
      assertStartupOwnership();
    });
    assertStartupOwnership();
    const snapshot = await readBootstrapSnapshot(cache);
    assertStartupOwnership();
  cache = guardedCache(cache);
  const store = guardedStore(createStore(initialState(context, snapshot)));
  const threadController = createThreadController({
    api,
    cache,
    store,
    isOnline: () => store.getState().network.online,
    now: options.now,
    uuid: options.uuid
  });
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const chatController = createChatController({
    api,
    cache,
    store,
    threadController,
    timeZone
  });
  const workController = createWorkController({ api, cache, store, threadController });
  const applyEvent = createEventApplier({ api, cache, store, timeZone });

  let startupSettled = false;
  let startupEntryFailure = null;
  let entryRecoveryPromise = null;

  function deviceRevokedError() {
    const error = new Error("当前浏览器入口已被移除。");
    error.code = "DEVICE_REVOKED";
    return error;
  }

  function routeEntryFailure(error) {
    if (!isEntryFailure(error)) return null;
    if (disposed || generation !== requestedGeneration) {
      return Promise.resolve();
    }
    if (!startupSettled) {
      startupEntryFailure ??= error;
      return Promise.resolve();
    }
    if (!entryRecoveryPromise) {
      const callback =
        error.code === "DEVICE_REVOKED" || error.code === "DEVICE_AUTH_INVALID"
          ? onEntryRevoked
          : onEntryInvalid;
      entryRecoveryPromise = Promise.resolve().then(() => {
        if (disposed || generation !== requestedGeneration) return undefined;
        return callback(error);
      });
    }
    return entryRecoveryPromise;
  }

  function handleEntryFailure(error) {
    return routeEntryFailure(error) !== null;
  }

  async function awaitEntryRecovery(error) {
    const recovery = routeEntryFailure(error);
    if (!recovery) return false;
    await recovery;
    return true;
  }

  async function guarded(action) {
    try {
      return await action();
    } catch (error) {
      handleEntryFailure(error);
      throw error;
    }
  }

  const actionImplementations = {
    navigate(section) {
      store.setState((current) => nextNavigationState(current, section));
      void trackActionPromise(saveMeta(cache, "selectedSection", section));
      if (section === "work" && !store.getState().selectedWorkRef) {
        const first = store.getState().works?.[0];
        if (first) void actions.openWork(first.workConversationRef);
      }
    },
    async openWork(workConversationRef) {
      store.setState((current) => ({ ...current, section: "work" }));
      await saveMeta(cache, "selectedSection", "work");
      try {
        await workController.open(workConversationRef);
      } catch (error) {
        if (runtimeInactive()) return;
        if (!handleEntryFailure(error)) renderer?.showToast(error.message, "error");
      }
    },
    async createWork(command) {
      return guarded(async () => {
        const work = await workController.create(command);
        store.setState((current) => ({ ...current, section: "work" }));
        await saveMeta(cache, "selectedSection", "work");
        return work;
      });
    },
    async send(target, text) {
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : selectedWork(state)?.threadRef;
      if (!threadRef) throw new Error("THREAD_NOT_SELECTED");
      const result = await threadController.send(threadRef, text, "zh-CN");
      if (result?.status === "failed") handleEntryFailure(result.error);
      return result;
    },
    async saveDraft(target, text) {
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : selectedWork(state)?.threadRef;
      if (threadRef) await threadController.saveDraft(threadRef, text);
    },
    async loadEarlier(target) {
      return guarded(async () => {
        const state = store.getState();
        const threadRef = target === "chat"
          ? state.chat?.threadRef
          : selectedWork(state)?.threadRef;
        if (threadRef) await threadController.loadEarlier(threadRef);
      });
    },
    async retry(clientMessageId) {
      const result = await threadController.retry(clientMessageId);
      if (result?.status === "failed") handleEntryFailure(result.error);
      return result;
    },
    toggleMessageSelection: (messageRef) => chatController.toggleMessageSelection(messageRef),
    async convertChatToWork(command) {
      return guarded(async () => {
        const result = await chatController.convertSelectionToWork({
          ...command,
          decisions: [],
          openQuestions: []
        });
        await workController.refreshList();
        await actions.openWork(result.conversation.workConversationRef);
        return result;
      });
    }
  };

  const actions = {
    navigate: (...args) => runOwnedAction(
      () => actionImplementations.navigate(...args)
    ),
    openWork: (...args) => runTrackedAction(
      () => actionImplementations.openWork(...args)
    ),
    createWork: (...args) => runTrackedAction(
      () => actionImplementations.createWork(...args)
    ),
    send: (...args) => runTrackedAction(
      () => actionImplementations.send(...args)
    ),
    saveDraft: (...args) => runTrackedAction(
      () => actionImplementations.saveDraft(...args)
    ),
    loadEarlier: (...args) => runTrackedAction(
      () => actionImplementations.loadEarlier(...args)
    ),
    retry: (...args) => runTrackedAction(
      () => actionImplementations.retry(...args)
    ),
    toggleMessageSelection: (...args) => runOwnedAction(
      () => actionImplementations.toggleMessageSelection(...args)
    ),
    convertChatToWork: (...args) => runTrackedAction(
      () => actionImplementations.convertChatToWork(...args)
    )
  };

  assertStartupOwnership();
  renderer = rendererFactory({ store, actions });
  assertStartupOwnership();
  syncController = syncFactory(
    {
      api,
      cache,
      store,
      applyEvent,
      EventSourceClass: options.EventSourceClass,
      BroadcastChannelClass: options.BroadcastChannelClass,
      onError: handleEntryFailure,
      onCacheUpdated: () => reloadCacheIntoStore(cache, store),
      onEntryRevoked: () => awaitEntryRecovery(deviceRevokedError())
    },
    Object.freeze({
      stopProductWorkbench: () => stopWorkbenchFromSync(ownedWorkbench)
    })
  );

  online = () => {
    if (runtimeInactive()) return;
    store.setState((current) => ({ ...current, network: { online: true } }));
    void syncController.reconnectNow();
  };
  offline = () => {
    if (runtimeInactive()) return;
    store.setState((current) => ({
      ...current,
      network: { online: false },
      sync: { ...current.sync, status: "offline" }
    }));
  };
  globalTarget.addEventListener?.("online", online);
  onlineAttached = true;
  globalTarget.addEventListener?.("offline", offline);
  offlineAttached = true;
  assertStartupOwnership();

  ownedWorkbench = {
    stop() {
      if (activeWorkbench === ownedWorkbench) {
        requestedGeneration += 1;
        return beginWorkbenchTeardown(ownedWorkbench);
      }
      if (detachedTeardown?.owner === ownedWorkbench) {
        return detachedTeardown.promise;
      }
      return disposePromise ?? Promise.resolve();
    },
    store,
    actions,
    cache
  };
  workbenchDisposers.set(ownedWorkbench, disposeOwnedResources);
  activeWorkbench = ownedWorkbench;

  try {
    const initializerResults = await trackActionPromise(Promise.allSettled([
      chatController.initialize(),
      workController.initialize()
    ]));
    assertStartupOwnership();
    if (startupEntryFailure) throw startupEntryFailure;
    const initializerFailures = initializerResults.filter(
      (result) => result.status === "rejected"
    );
    const initializerFailure = initializerFailures.find(
      (result) => isOwnershipGuardFailure(result.reason)
    ) ?? initializerFailures.find(
      (result) => isEntryFailure(result.reason)
    ) ?? initializerFailures[0];
    if (initializerFailure) throw initializerFailure.reason;
    const savedWork = snapshot.selectedWorkRef && store.getState().works.some(
      (work) => work.workConversationRef === snapshot.selectedWorkRef
    )
      ? snapshot.selectedWorkRef
      : null;
    if (snapshot.selectedSection === "work" && savedWork) {
      await workController.open(savedWork);
      assertStartupOwnership();
      if (startupEntryFailure) throw startupEntryFailure;
      store.setState((current) => nextNavigationState(current, "work"));
    } else {
      store.setState((current) => nextNavigationState(current, "chat"));
      if (snapshot.selectedSection === "work") {
        await saveMeta(cache, "selectedSection", "chat");
        assertStartupOwnership();
        if (startupEntryFailure) throw startupEntryFailure;
      }
    }
    if (startupEntryFailure) throw startupEntryFailure;
    await syncController.start();
    assertStartupOwnership();
    if (startupEntryFailure) throw startupEntryFailure;
  } catch (error) {
    assertCurrentGeneration();
    if (isOwnershipGuardFailure(error)) throw error;
    const entryFailure = startupEntryFailure ?? (isEntryFailure(error) ? error : null);
    if (entryFailure) throw entryFailure;
    renderer.showToast(error.message ?? "工作台加载失败。", "error");
    store.setState((current) => ({
      ...current,
      sync: { ...current.sync, status: "degraded" }
    }));
  }

  startupSettled = true;
  assertStartupOwnership();
  return ownedWorkbench;
  } catch (error) {
    if (activeWorkbench === ownedWorkbench) activeWorkbench = null;
    let cleanupFailure = null;
    try {
      await disposeOwnedResources();
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    if (error?.code === "PRODUCT_START_SUPERSEDED") {
      if (cleanupFailure) throw cleanupFailure;
      return null;
    }
    if (cleanupFailure) throw attachCleanupFailure(error, cleanupFailure);
    throw error;
  }
}

export async function stopProductWorkbench() {
  const stopGeneration = ++requestedGeneration;
  const pendingAtStop = startLane;
  await detachActiveWorkbench();
  await pendingAtStop;
  if (requestedGeneration === stopGeneration) {
    await detachActiveWorkbench();
  }
}
