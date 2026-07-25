import { createApiClient } from "./api.js";
import {
  applyEventTransaction,
  clearMemberCache,
  openMemberCache,
  readBootstrapSnapshot,
  saveMeta
} from "./cache.js";
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
  return ["ENTRY_SESSION_EXPIRED", "ENTRY_SESSION_INVALID", "DEVICE_REVOKED"]
    .includes(error?.code);
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

export async function startProductWorkbench(context, options = {}) {
  await stopProductWorkbench();
  const api = createApiClient(options.fetchImpl);
  const cache = await openMemberCache();
  await saveMeta(cache, "context", context);
  const snapshot = await readBootstrapSnapshot(cache);
  const store = createStore(initialState(context, snapshot));
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

  let syncController;
  let renderer;
  let stopped = false;
  let entryRecoveryStarted = false;

  function handleEntryFailure(error) {
    if (!isEntryFailure(error)) return false;
    if (!entryRecoveryStarted) {
      entryRecoveryStarted = true;
      void options.onEntryInvalid?.(error);
    }
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

  const actions = {
    navigate(section) {
      store.setState((current) => nextNavigationState(current, section));
      void saveMeta(cache, "selectedSection", section);
      if (section === "work" && !store.getState().selectedWorkRef) {
        const first = store.getState().works?.[0];
        if (first) void actions.openWork(first.workConversationRef);
      }
    },
    async openWork(workConversationRef) {
      store.setState((current) => ({ ...current, section: "work" }));
      void saveMeta(cache, "selectedSection", "work");
      try {
        await workController.open(workConversationRef);
      } catch (error) {
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

  renderer = createRenderer({ store, actions });
  syncController = createSyncController({
    api,
    cache,
    store,
    applyEvent,
    EventSourceClass: options.EventSourceClass,
    BroadcastChannelClass: options.BroadcastChannelClass,
    onError: handleEntryFailure,
    onCacheUpdated: () => void reloadCacheIntoStore(cache, store)
  });

  const online = () => {
    store.setState((current) => ({ ...current, network: { online: true } }));
    void syncController.reconnectNow();
  };
  const offline = () => {
    store.setState((current) => ({
      ...current,
      network: { online: false },
      sync: { ...current.sync, status: "offline" }
    }));
  };
  globalThis.addEventListener?.("online", online);
  globalThis.addEventListener?.("offline", offline);

  activeWorkbench = {
    async stop() {
      if (stopped) return;
      stopped = true;
      syncController.stop();
      renderer.destroy();
      globalThis.removeEventListener?.("online", online);
      globalThis.removeEventListener?.("offline", offline);
      cache.close();
    },
    store,
    actions,
    cache
  };

  try {
    await Promise.all([chatController.initialize(), workController.initialize()]);
    const savedWork = snapshot.selectedWorkRef && store.getState().works.some(
      (work) => work.workConversationRef === snapshot.selectedWorkRef
    )
      ? snapshot.selectedWorkRef
      : null;
    if (snapshot.selectedSection === "work" && savedWork) {
      await workController.open(savedWork);
      store.setState((current) => nextNavigationState(current, "work"));
    } else {
      store.setState((current) => nextNavigationState(current, "chat"));
      if (snapshot.selectedSection === "work") {
        await saveMeta(cache, "selectedSection", "chat");
      }
    }
    await syncController.start();
  } catch (error) {
    if (!handleEntryFailure(error)) {
      renderer.showToast(error.message ?? "工作台加载失败。", "error");
      store.setState((current) => ({
        ...current,
        sync: { ...current.sync, status: "degraded" }
      }));
    }
  }

  return activeWorkbench;
}

export async function stopProductWorkbench() {
  const current = activeWorkbench;
  activeWorkbench = null;
  await current?.stop();
}

export async function clearProductWorkbenchCache() {
  const cache = await openMemberCache();
  try {
    await clearMemberCache(cache);
  } finally {
    cache.close();
  }
}
