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
import { createThreadController } from "./thread.js";
import { createWorkController } from "./work.js";

let activeWorkbench = null;

function groupByThread(messages) {
  const grouped = {};
  for (const message of messages ?? []) {
    const list = grouped[message.threadRef] ?? [];
    list.push(message);
    grouped[message.threadRef] = list;
  }
  return grouped;
}

function mapBy(items, key) {
  return Object.fromEntries((items ?? []).map((item) => [item[key], item]));
}

function draftMap(drafts) {
  return Object.fromEntries((drafts ?? []).map((draft) => [draft.threadRef, draft.text]));
}

function initialState(context, snapshot) {
  return {
    context,
    section: "chat",
    chat: null,
    currentEpisode: null,
    works: snapshot.works ?? [],
    selectedWorkRef: null,
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

function entryFailure(error, callback) {
  const code = error?.code;
  if (!["ENTRY_SESSION_EXPIRED", "ENTRY_SESSION_INVALID", "DEVICE_REVOKED"].includes(code)) {
    return false;
  }
  void callback?.(error);
  return true;
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
  const chatController = createChatController({
    api,
    cache,
    store,
    threadController,
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
  });
  const workController = createWorkController({ api, cache, store, threadController });

  let syncController;
  let renderer;
  let stopped = false;

  async function applyEvent(target) {
    const plan = eventRefreshPlan(target, store.getState().activeThreadRef);
    if (plan.chat) await chatController.refresh();
    if (plan.works) await workController.refreshList();
    for (const threadRef of plan.threads) await threadController.refresh(threadRef);
    for (const workConversationRef of plan.progress) {
      await workController.refreshProgress(workConversationRef);
    }
    await applyEventTransaction(cache, target.eventSequence, async () => undefined);
  }

  async function guarded(action) {
    try {
      return await action();
    } catch (error) {
      entryFailure(error, options.onEntryInvalid);
      throw error;
    }
  }

  const actions = {
    navigate(section) {
      store.setState((current) => ({ ...current, section }));
      if (section === "work" && !store.getState().selectedWorkRef) {
        const first = store.getState().works?.[0];
        if (first) void actions.openWork(first.workConversationRef);
      }
    },
    async openWork(workConversationRef) {
      store.setState((current) => ({ ...current, section: "work" }));
      try {
        await workController.open(workConversationRef);
      } catch (error) {
        if (!entryFailure(error, options.onEntryInvalid)) renderer?.showToast(error.message, "error");
      }
    },
    async createWork(command) {
      return guarded(async () => {
        const work = await workController.create(command);
        store.setState((current) => ({ ...current, section: "work" }));
        return work;
      });
    },
    async send(target, text) {
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : state.works?.find((work) => work.workConversationRef === state.selectedWorkRef)?.threadRef;
      if (!threadRef) throw new Error("THREAD_NOT_SELECTED");
      const result = await threadController.send(threadRef, text, "zh-CN");
      if (result?.status === "failed") entryFailure(result.error, options.onEntryInvalid);
      return result;
    },
    async saveDraft(target, text) {
      const state = store.getState();
      const threadRef = target === "chat"
        ? state.chat?.threadRef
        : state.works?.find((work) => work.workConversationRef === state.selectedWorkRef)?.threadRef;
      if (threadRef) await threadController.saveDraft(threadRef, text);
    },
    async loadEarlier(target) {
      return guarded(async () => {
        const state = store.getState();
        const threadRef = target === "chat"
          ? state.chat?.threadRef
          : state.works?.find((work) => work.workConversationRef === state.selectedWorkRef)?.threadRef;
        if (threadRef) await threadController.loadEarlier(threadRef);
      });
    },
    async retry(clientMessageId) {
      const result = await threadController.retry(clientMessageId);
      if (result?.status === "failed") entryFailure(result.error, options.onEntryInvalid);
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
    onError: (error) => entryFailure(error, options.onEntryInvalid),
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
    await syncController.start();
  } catch (error) {
    if (!entryFailure(error, options.onEntryInvalid)) {
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
