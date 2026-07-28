import { saveMeta, saveProgress, saveWorksForAgent } from "./cache.js";

function byRef(works, workConversationRef) {
  return works.find((work) => work.workConversationRef === workConversationRef) ?? null;
}

export function createWorkController(input) {
  const { api, cache, store, threadController } = input;
  function selectedAgentRef() {
    const agentRef = store.getState().currentAgentRef;
    if (!agentRef) throw new Error("AGENT_SELECTION_REQUIRED");
    return agentRef;
  }

  function assertStillSelected(agentRef) {
    if (store.getState().currentAgentRef !== agentRef) {
      const error = new Error("Agent selection changed.");
      error.code = "AGENT_SELECTION_CHANGED";
      throw error;
    }
  }

  async function refreshList() {
    const agentRef = selectedAgentRef();
    const response = store.getState().legacyAgentProjection
      ? await api.listWorks()
      : await api.listWorks(agentRef);
    assertStillSelected(agentRef);
    const conversations = response.conversations.map((work) => ({
      ...work,
      agentRef
    }));
    await saveWorksForAgent(cache, agentRef, conversations);
    assertStillSelected(agentRef);
    store.setState((current) => ({ ...current, works: conversations }));
    return conversations;
  }

  async function refreshProgress(workConversationRef) {
    const agentRef = selectedAgentRef();
    const response = await api.getWorkProgress(workConversationRef);
    assertStillSelected(agentRef);
    const snapshot = response?.snapshot ?? null;
    if (snapshot) await saveProgress(cache, snapshot);
    assertStillSelected(agentRef);
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
    const agentRef = selectedAgentRef();
    let currentWorks = store.getState().works ?? [];
    let work = byRef(currentWorks, workConversationRef);
    if (!work) {
      currentWorks = await refreshList();
      work = byRef(currentWorks, workConversationRef);
    }
    if (!work) throw new Error("WORK_NOT_FOUND");
    if (work.agentRef !== agentRef) throw new Error("WORK_AGENT_MISMATCH");
    await saveMeta(cache, `selectedWorkRef:${agentRef}`, workConversationRef);
    assertStillSelected(agentRef);
    store.setState((current) => ({
      ...current,
      selectedWorkRef: workConversationRef,
      activeThreadRef: work.threadRef
    }));
    await Promise.all([
      threadController.loadLatest(work.threadRef),
      refreshProgress(workConversationRef)
    ]);
    assertStillSelected(agentRef);
    return work;
  }

  async function create(command) {
    const agentRef = selectedAgentRef();
    const request = {
      protocolVersion: 1,
      title: command.title,
      goal: command.goal
    };
    if (!store.getState().legacyAgentProjection) {
      request.agentRef = agentRef;
    }
    const response = await api.createWork(request);
    assertStillSelected(agentRef);
    const conversation = { ...response.conversation, agentRef };
    const current = store.getState().works ?? [];
    const next = [
      conversation,
      ...current.filter(
        (work) => work.workConversationRef !== conversation.workConversationRef
      )
    ];
    await saveWorksForAgent(cache, agentRef, next);
    assertStillSelected(agentRef);
    store.setState((state) => ({ ...state, works: next }));
    await open(conversation.workConversationRef);
    return conversation;
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
