import { saveMeta } from "./cache.js";

function uniqueRefs(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function createChatController(input) {
  const { api, cache, store, threadController } = input;
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  async function initialize() {
    const response = await api.getHomeChat(timeZone);
    await saveMeta(cache, "chat", response);
    store.setState((current) => ({
      ...current,
      chat: response.chat,
      currentEpisode: response.currentEpisode,
      activeThreadRef: response.chat.threadRef
    }));
    await threadController.loadLatest(response.chat.threadRef);
    return response;
  }

  async function refresh() {
    const response = await api.getHomeChat(timeZone);
    await saveMeta(cache, "chat", response);
    store.setState((current) => ({
      ...current,
      chat: response.chat,
      currentEpisode: response.currentEpisode
    }));
    return response;
  }

  function toggleMessageSelection(messageRef) {
    store.setState((current) => {
      const selected = new Set(current.selectedMessageRefs ?? []);
      if (selected.has(messageRef)) selected.delete(messageRef);
      else selected.add(messageRef);
      return { ...current, selectedMessageRefs: [...selected] };
    });
  }

  function clearSelection() {
    store.setState((current) => ({ ...current, selectedMessageRefs: [] }));
  }

  async function convertSelectionToWork(command) {
    const current = store.getState();
    const messageRefs = uniqueRefs(current.selectedMessageRefs ?? []);
    if (!current.chat || messageRefs.length === 0) throw new Error("CHAT_SELECTION_REQUIRED");
    const result = await api.convertChatToWork({
      protocolVersion: 1,
      title: command.title,
      goal: command.goal,
      source: {
        homeChatStreamRef: current.chat.homeChatStreamRef,
        dailyEpisodeRef: current.currentEpisode?.dailyEpisodeRef ?? null,
        messageRefs
      },
      decisions: command.decisions ?? [],
      openQuestions: command.openQuestions ?? []
    });
    clearSelection();
    return result;
  }

  return {
    initialize,
    refresh,
    toggleMessageSelection,
    clearSelection,
    convertSelectionToWork
  };
}
