import { createApiClient } from "./api.js";
import {
  applyEventTransaction,
  readBootstrapSnapshot,
  readSelectedAgentRef,
  saveMeta
} from "./cache.js";
import {
  cacheIdentityFromContext,
  openIdentityMemberCache,
  sameCacheIdentity
} from "./cache-identity.js";
import { chooseInitialAgent, isMountedAgent } from "./agent-selector.js";
import { createAttachmentController } from "./attachments.js";
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

function initialState(context, snapshot, selection) {
  const section = snapshot.selectedSection === "work" ? "work" : "chat";
  const currentAgentRef = selection.kind === "selected" ? selection.agentRef : null;
  const cachedChat = currentAgentRef ? snapshot.chat : null;
  return {
    context,
    currentAgentRef,
    legacyAgentProjection: !Array.isArray(context?.mountedAgents),
    agentSelectionKind: selection.kind,
    section,
    chat: cachedChat?.chat ?? null,
    currentEpisode: cachedChat?.currentEpisode ?? null,
    works: snapshot.works ?? [],
    selectedWorkRef: snapshot.selectedWorkRef ?? null,
    activeThreadRef: cachedChat?.chat?.threadRef ?? null,
    messagesByThread: groupByThread(snapshot.messages),
    paginationByThread: {},
    outgoing: snapshot.outgoing ?? [],
    drafts: draftMap(snapshot.drafts),
    attachmentDrafts: snapshot.attachmentDrafts ?? [],
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

export function projectAgentState(current, context, snapshot, agentRef) {
  const projected = initialState(
    context,
    snapshot,
    agentRef
      ? { kind: "selected", agentRef }
      : {
          kind: context.mountedAgents?.length
            ? "selection_required"
            : "unconfigured"
        }
  );
  return {
    ...projected,
    network: current.network,
    sync: current.sync,
    section: current.section,
    activeThreadRef: current.section === "work"
      ? selectedWork(projected)?.threadRef ?? null
      : projected.chat?.threadRef ?? null
  };
}

function agentUnavailableError() {
  const error = new Error("当前 Agent 已不可用，请重新选择。");
  error.code = "AGENT_NOT_MOUNTED";
  return error;
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
  const agentRef = store.getState().currentAgentRef ?? null;
  const cached = await readBootstrapSnapshot(cache, agentRef);
  const snapshot = agentRef
    ? cached
    : {
        ...cached,
        works: [],
        messages: [],
        outgoing: [],
        drafts: [],
        attachmentDrafts: [],
        progress: [],
        chat: null,
        selectedWorkRef: null
      };

  store.setState((current) => {
    if ((current.currentAgentRef ?? null) !== agentRef) {
      return current;
    }

    const workRefs = new Set(snapshot.works.map((work) => work.workConversationRef));
    const selectedWorkRef = workRefs.has(current.selectedWorkRef)
      ? current.selectedWorkRef
      : workRefs.has(snapshot.selectedWorkRef)
        ? snapshot.selectedWorkRef
        : snapshot.works[0]?.workConversationRef ?? null;

    return {
      ...current,
      chat: snapshot.chat,
      works: snapshot.works,
      selectedWorkRef,
      messagesByThread: groupByThread(snapshot.messages),
      outgoing: snapshot.outgoing,
      drafts: draftMap(snapshot.drafts),
      attachmentDrafts: snapshot.attachmentDrafts ?? [],
      progressByWork: mapBy(snapshot.progress, "workConversationRef"),
      sync: {
        ...current.sync,
        localAppliedSequence: Math.max(
          current.sync?.localAppliedSequence ?? 0,
          snapshot.localAppliedSequence
        )
      }
    };
  });
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
  const selectionGeneration = input.selectionGeneration ?? (() => 0);

  return async function applyEvent(target) {
    const beforeSnapshot = await readBootstrapSnapshot(cache);
    if (target.eventSequence <= beforeSnapshot.localAppliedSequence) return false;
    if (target.eventSequence !== beforeSnapshot.localAppliedSequence + 1) {
      throw new Error("SYNC_SEQUENCE_GAP");
    }

    const selectionState = store.getState();
    const hasAgentProjection = Object.prototype.hasOwnProperty.call(
      selectionState,
      "currentAgentRef"
    );
    const agentRef = hasAgentProjection
      ? selectionState.currentAgentRef
      : selectionState.context?.agent?.agentRef ?? "agent:personal-assistant";
    const capturedGeneration = selectionGeneration();
    let projectionInvalidated = false;
    function observeProjectionOwnership() {
      if (
        hasAgentProjection &&
        (
          store.getState().currentAgentRef !== agentRef ||
          selectionGeneration() !== capturedGeneration
        )
      ) {
        projectionInvalidated = true;
      }
      return !projectionInvalidated;
    }
    const eventAgentRef = target.payload?.agentRef ?? null;
    if (!agentRef || (eventAgentRef && eventAgentRef !== agentRef)) {
      return applyEventTransaction(
        cache,
        target.eventSequence,
        async () => undefined
      );
    }
    const plan = eventRefreshPlan(target, store.getState().activeThreadRef);
    let chatResponse = null;
    if (plan.chat) {
      chatResponse = hasAgentProjection
        ? await api.getHomeChat(agentRef, timeZone)
        : await api.getHomeChat(timeZone);
      observeProjectionOwnership();
    }
    let worksResponse = null;
    if (plan.works) {
      worksResponse = hasAgentProjection
        ? await api.listWorks(agentRef)
        : await api.listWorks();
      observeProjectionOwnership();
    }
    const threadPages = new Map();
    for (const threadRef of plan.threads) {
      threadPages.set(threadRef, await api.getThreadMessages(threadRef, { limit: 100 }));
      observeProjectionOwnership();
    }
    const progressResponses = new Map();
    for (const workConversationRef of plan.progress) {
      progressResponses.set(
        workConversationRef,
        await api.getWorkProgress(workConversationRef)
      );
      observeProjectionOwnership();
    }

    const userMessage = userMessageForEvent(target, threadPages, selectionState);
    const failureBase = target.eventType === "thread.provider_turn.failed"
      ? failedOutgoing(target, userMessage)
      : null;
    const failure = failureBase ? { ...failureBase, agentRef } : null;
    const succeededClientMessageId = target.eventType === "thread.provider_turn.succeeded"
      ? userMessage?.clientMessageId ?? null
      : null;

    const committed = await applyEventTransaction(cache, target.eventSequence, async (transaction) => {
      if (chatResponse) {
        await transaction.put("meta", {
          key: `chat:${agentRef}`,
          value: chatResponse
        });
        await transaction.put("threads", chatResponse.chat);
      }
      if (worksResponse) {
        const allWorks = await transaction.getAll("works");
        for (const work of allWorks) {
          if (work.agentRef === agentRef) {
            await transaction.delete("works", work.workConversationRef);
          }
        }
        for (const work of worksResponse.conversations) {
          const projectedWork = { ...work, agentRef };
          await transaction.put("works", projectedWork);
          await transaction.put("threads", projectedWork);
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
    observeProjectionOwnership();
    if (!committed) return false;

    const afterSnapshot = await readBootstrapSnapshot(cache, agentRef);
    observeProjectionOwnership();
    store.setState((current) => {
      if (
        projectionInvalidated ||
        (
          hasAgentProjection &&
          (
            current.currentAgentRef !== agentRef ||
            selectionGeneration() !== capturedGeneration
          )
        )
      ) {
        return current;
      }
      const paginationByThread = { ...(current.paginationByThread ?? {}) };
      for (const [threadRef, page] of threadPages) {
        if (!Object.prototype.hasOwnProperty.call(paginationByThread, threadRef)) {
          paginationByThread[threadRef] = page.nextBeforeSequence ?? null;
        }
      }
      const works = worksResponse?.conversations?.map(
        (work) => ({ ...work, agentRef })
      ) ?? afterSnapshot.works;
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
  const setIntervalFn = options.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
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
  let attachmentController = null;
  let onlineAttached = false;
  let offlineAttached = false;
  let ownedWorkbench = null;
  let productFlightLease = null;
  let disposePromise = null;
  let online = () => undefined;
  let offline = () => undefined;
  let contextRefreshTimer = null;

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
    try {
      attachmentController?.stop?.();
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
      await settleStage(() => {
        if (contextRefreshTimer === null) return;
        clearIntervalFn(contextRefreshTimer);
        contextRefreshTimer = null;
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
    const baseSnapshot = await readBootstrapSnapshot(cache);
    const savedAgentRef = Array.isArray(context?.mountedAgents)
      ? await readSelectedAgentRef(cache)
      : null;
    const selection = chooseInitialAgent(context, savedAgentRef);
    const snapshot = selection.kind === "selected" &&
      Array.isArray(context?.mountedAgents)
      ? await readBootstrapSnapshot(cache, selection.agentRef)
      : selection.kind === "selected"
        ? baseSnapshot
      : {
          ...baseSnapshot,
          chat: null,
          selectedWorkRef: null,
          threads: [],
          messages: [],
          works: [],
          progress: [],
          drafts: [],
          attachmentDrafts: [],
          outgoing: []
        };
    assertStartupOwnership();
  cache = guardedCache(cache);
  const store = guardedStore(createStore(initialState(context, snapshot, selection)));
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
  attachmentController = createAttachmentController({
    api,
    cache,
    store,
    cryptoImpl: options.cryptoImpl,
    now: options.now
  });
  let agentSwitchGeneration = 0;
  const applyEvent = createEventApplier({
    api,
    cache,
    store,
    timeZone,
    selectionGeneration: () => agentSwitchGeneration
  });

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

  function emptyAgentSnapshot(base = {}) {
    return {
      ...base,
      chat: null,
      selectedWorkRef: null,
      threads: [],
      messages: [],
      works: [],
      progress: [],
      drafts: [],
      attachmentDrafts: [],
      outgoing: []
    };
  }

  function assertUsableAgent() {
    const state = store.getState();
    if (
      !state.currentAgentRef ||
      !isMountedAgent(state.context, state.currentAgentRef)
    ) {
      throw agentUnavailableError();
    }
    return state.currentAgentRef;
  }

  async function refreshAgentContext() {
    const response = await api.getWebContext();
    const nextContext = response.context;
    const current = store.getState();
    const currentAgentRef = current.currentAgentRef;
    if (currentAgentRef && !isMountedAgent(nextContext, currentAgentRef)) {
      agentSwitchGeneration += 1;
      store.setState((state) => projectAgentState(
        state,
        nextContext,
        emptyAgentSnapshot(),
        null
      ));
      await saveMeta(cache, "selectedAgentRef", null);
      renderer?.showToast("当前 Agent 已被管理员移除，请重新选择。", "error");
      return { kind: "revoked" };
    }
    store.setState((state) => ({ ...state, context: nextContext }));
    return { kind: "current" };
  }

  async function switchAgent(agentRef) {
    const current = store.getState();
    if (!isMountedAgent(current.context, agentRef)) {
      throw agentUnavailableError();
    }
    const switchGeneration = ++agentSwitchGeneration;
    store.setState((state) => projectAgentState(
      state,
      state.context,
      emptyAgentSnapshot({ selectedSection: state.section }),
      agentRef
    ));
    await saveMeta(cache, "selectedAgentRef", agentRef);
    const projected = await readBootstrapSnapshot(cache, agentRef);
    if (
      switchGeneration !== agentSwitchGeneration ||
      !isMountedAgent(store.getState().context, agentRef)
    ) {
      throw agentUnavailableError();
    }
    store.setState((state) => projectAgentState(
      state,
      state.context,
      projected,
      agentRef
    ));
    const results = await Promise.allSettled([
      chatController.initialize(),
      workController.initialize()
    ]);
    if (switchGeneration !== agentSwitchGeneration) return null;
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      if (failure.reason?.code === "AGENT_NOT_MOUNTED") {
        await refreshAgentContext();
      }
      throw failure.reason;
    }
    const savedWork = projected.selectedWorkRef && store.getState().works.some(
      (work) => work.workConversationRef === projected.selectedWorkRef
    )
      ? projected.selectedWorkRef
      : null;
    if (projected.selectedSection === "work" && savedWork) {
      await workController.open(savedWork);
      store.setState((state) => nextNavigationState(state, "work"));
    } else {
      store.setState((state) => nextNavigationState(state, "chat"));
    }
    return agentRef;
  }

  const actionImplementations = {
    switchAgent,
    refreshAgentContext,
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
      assertUsableAgent();
      return guarded(async () => {
        const work = await workController.create(command);
        store.setState((current) => ({ ...current, section: "work" }));
        await saveMeta(cache, "selectedSection", "work");
        return work;
      });
    },
    async send(target, text) {
      assertUsableAgent();
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
      assertUsableAgent();
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : selectedWork(state)?.threadRef;
      if (threadRef) await threadController.saveDraft(threadRef, text);
    },
    async addAttachments(target, files) {
      const agentRef = assertUsableAgent();
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : selectedWork(state)?.threadRef;
      if (!threadRef) throw new Error("THREAD_NOT_SELECTED");
      return attachmentController.addFiles({ agentRef, threadRef, files });
    },
    async cancelAttachment(attachmentRef) {
      assertUsableAgent();
      return attachmentController.cancelAttachment(attachmentRef);
    },
    async loadEarlier(target) {
      assertUsableAgent();
      return guarded(async () => {
        const state = store.getState();
        const threadRef = target === "chat"
          ? state.chat?.threadRef
          : selectedWork(state)?.threadRef;
        if (threadRef) await threadController.loadEarlier(threadRef);
      });
    },
    async retry(clientMessageId) {
      assertUsableAgent();
      const result = await threadController.retry(clientMessageId);
      if (result?.status === "failed") handleEntryFailure(result.error);
      return result;
    },
    toggleMessageSelection: (messageRef) => chatController.toggleMessageSelection(messageRef),
    async convertChatToWork(command) {
      assertUsableAgent();
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
    switchAgent: (...args) => runTrackedAction(
      () => actionImplementations.switchAgent(...args)
    ),
    refreshAgentContext: (...args) => runTrackedAction(
      () => actionImplementations.refreshAgentContext(...args)
    ),
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
    addAttachments: (...args) => runTrackedAction(
      () => actionImplementations.addAttachments(...args)
    ),
    cancelAttachment: (...args) => runTrackedAction(
      () => actionImplementations.cancelAttachment(...args)
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
    const initializerResults = store.getState().currentAgentRef
      ? await trackActionPromise(Promise.allSettled([
          chatController.initialize(),
          workController.initialize()
        ]))
      : [];
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
    const savedWork = store.getState().currentAgentRef &&
      snapshot.selectedWorkRef &&
      store.getState().works.some(
      (work) => work.workConversationRef === snapshot.selectedWorkRef
    )
      ? snapshot.selectedWorkRef
      : null;
    if (store.getState().currentAgentRef && snapshot.selectedSection === "work" && savedWork) {
      await workController.open(savedWork);
      assertStartupOwnership();
      if (startupEntryFailure) throw startupEntryFailure;
      store.setState((current) => nextNavigationState(current, "work"));
    } else if (store.getState().currentAgentRef) {
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
    contextRefreshTimer = setIntervalFn(() => {
      void actions.refreshAgentContext().catch((error) => {
        if (runtimeInactive() || handleEntryFailure(error)) return;
        renderer?.showToast("Agent 状态刷新失败，请稍后重试。", "error");
      });
    }, 5000);
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
