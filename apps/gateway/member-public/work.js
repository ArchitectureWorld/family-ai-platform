import { saveMeta, saveProgress, saveWorks } from "./cache.js";

function byRef(works, workConversationRef) {
  return works.find((work) => work.workConversationRef === workConversationRef) ?? null;
}

export function createWorkController(input) {
  const { api, cache, store, threadController } = input;

  async function refreshList() {
    const response = await api.listWorks();
    await saveWorks(cache, response.conversations);
    store.setState((current) => ({ ...current, works: response.conversations }));
    return response.conversations;
  }

  async function refreshProgress(workConversationRef) {
    const response = await api.getWorkProgress(workConversationRef);
    const snapshot = response?.snapshot ?? null;
    if (snapshot) await saveProgress(cache, snapshot);
    store.setState((current) => ({
      ...current,
      progressByWork: {
        ...(current.progressByWork ?? {}),
        [workConversationRef]: snapshot
      }
    }));
    return snapshot;
  }

  async function open(workConversationRef) {
    let currentWorks = store.getState().works ?? [];
    let work = byRef(currentWorks, workConversationRef);
    if (!work) {
      currentWorks = await refreshList();
      work = byRef(currentWorks, workConversationRef);
    }
    if (!work) throw new Error("WORK_NOT_FOUND");
    await saveMeta(cache, "selectedWorkRef", workConversationRef);
    store.setState((current) => ({
      ...current,
      selectedWorkRef: workConversationRef,
      activeThreadRef: work.threadRef
    }));
    await Promise.all([
      threadController.loadLatest(work.threadRef),
      refreshProgress(workConversationRef)
    ]);
    return work;
  }

  async function create(command) {
    const response = await api.createWork({
      protocolVersion: 1,
      title: command.title,
      goal: command.goal
    });
    const current = store.getState().works ?? [];
    const next = [
      response.conversation,
      ...current.filter(
        (work) => work.workConversationRef !== response.conversation.workConversationRef
      )
    ];
    await saveWorks(cache, next);
    store.setState((state) => ({ ...state, works: next }));
    await open(response.conversation.workConversationRef);
    return response.conversation;
  }

  async function initialize() {
    return refreshList();
  }

  return {
    initialize,
    refreshList,
    refreshProgress,
    create,
    open
  };
}
