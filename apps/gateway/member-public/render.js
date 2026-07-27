const $ = (documentRef, id) => documentRef.getElementById(id);

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function element(documentRef, tag, className, text = undefined) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function workStatusLabel(status) {
  return ({
    active: "进行中",
    paused: "已暂停",
    waiting_confirmation: "等待确认",
    completed: "已完成",
    archived: "已归档"
  })[status] ?? status ?? "未知状态";
}

function actorLabel(message) {
  switch (message.actor?.type) {
    case "person": return "你";
    case "assistant": return "个人助理";
    case "agent": return "执行 Agent";
    case "system": return "系统";
    default: return "消息";
  }
}

function messageNode(documentRef, listenerOptions, message, input) {
  const row = element(documentRef, "article", `message ${message.actor?.type ?? "system"}`);
  row.dataset.messageRef = message.messageRef;
  if (input.selectable) {
    const checkbox = documentRef.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "message-select";
    checkbox.checked = input.selected.has(message.messageRef);
    checkbox.setAttribute("aria-label", `选择${actorLabel(message)}的消息`);
    checkbox.addEventListener("change", () => input.onSelect(message.messageRef), listenerOptions);
    row.append(checkbox);
  }
  const bubble = element(documentRef, "div", "message-bubble");
  bubble.append(element(documentRef, "p", "message-content", message.content?.text ?? ""));
  const meta = element(documentRef, "div", "message-meta");
  meta.append(element(documentRef, "span", "", actorLabel(message)));
  meta.append(element(documentRef, "time", "", displayTime(message.occurredAt ?? message.createdAt)));
  bubble.append(meta);
  row.append(bubble);
  return row;
}

function outgoingNode(documentRef, listenerOptions, outgoing, onRetry) {
  const failed = outgoing.status === "failed";
  const row = element(documentRef, "article", `message outgoing${failed ? " failed" : ""}`);
  row.dataset.clientMessageId = outgoing.clientMessageId;
  const bubble = element(documentRef, "div", "message-bubble");
  bubble.append(element(documentRef, "p", "message-content", outgoing.content?.text ?? ""));
  const meta = element(documentRef, "div", "message-meta");
  meta.append(element(documentRef, "span", "", failed ? "发送或回复失败" : "正在发送"));
  meta.append(element(documentRef, "time", "", displayTime(outgoing.occurredAt)));
  if (failed && outgoing.error?.retryable) {
    const retry = element(documentRef, "button", "retry-message", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => void onRetry(outgoing.clientMessageId), listenerOptions);
    meta.append(retry);
  }
  bubble.append(meta);
  row.append(bubble);
  return row;
}

function renderThread(documentRef, listenerOptions, input) {
  const distanceFromBottom = input.container.scrollHeight -
    input.container.scrollTop - input.container.clientHeight;
  const shouldStickToBottom = distanceFromBottom < 120;
  clear(input.container);
  const authoritative = input.messages ?? [];
  const outgoing = (input.outgoing ?? []).filter((item) => item.threadRef === input.threadRef);
  const selected = new Set(input.selectedRefs ?? []);
  for (const message of authoritative) {
    input.container.append(messageNode(documentRef, listenerOptions, message, {
      selectable: input.selectable,
      selected,
      onSelect: input.onSelect
    }));
  }
  for (const item of outgoing) input.container.append(outgoingNode(documentRef, listenerOptions, item, input.onRetry));
  input.empty.classList.toggle("hidden", authoritative.length + outgoing.length > 0);
  input.loadEarlier.classList.toggle("hidden", input.nextBeforeSequence == null);
  if (shouldStickToBottom) {
    queueMicrotask(() => {
      input.container.scrollTop = input.container.scrollHeight;
    });
  }
}

function ensureMobileWorkSelect(documentRef, listenerOptions, actions) {
  let select = $(documentRef, "mobileWorkSelect");
  if (!select) {
    select = documentRef.createElement("select");
    select.id = "mobileWorkSelect";
    select.className = "mobile-work-select";
    select.setAttribute("aria-label", "选择 Work");
    $(documentRef, "workListToggle").before(select);
  }
  select.addEventListener("change", (event) => {
    if (event.target.value) void actions.openWork(event.target.value);
  }, listenerOptions);
  return select;
}

function renderWorkList(documentRef, listenerOptions, state, actions) {
  const list = $(documentRef, "workList");
  const select = $(documentRef, "mobileWorkSelect");
  clear(list);
  if (select) {
    clear(select);
    const placeholder = documentRef.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择 Work";
    select.append(placeholder);
  }
  if (!state.works?.length) {
    list.append(element(documentRef, "p", "work-list-empty", "还没有 Work。创建一个长期事项后，它会出现在这里。"));
    return;
  }
  for (const work of state.works) {
    const button = element(documentRef, "button", `work-list-item${state.selectedWorkRef === work.workConversationRef ? " active" : ""}`);
    button.type = "button";
    button.append(element(documentRef, "strong", "", work.title));
    button.append(element(documentRef, "span", "", `${workStatusLabel(work.status)} · ${work.goal}`));
    button.addEventListener("click", () => void actions.openWork(work.workConversationRef), listenerOptions);
    list.append(button);
    if (select) {
      const option = documentRef.createElement("option");
      option.value = work.workConversationRef;
      option.textContent = work.title;
      option.selected = state.selectedWorkRef === work.workConversationRef;
      select.append(option);
    }
  }
}

function renderProgress(documentRef, snapshot) {
  $(documentRef, "workPhaseSummary").textContent = snapshot?.phaseSummary || "尚无结构化进度。";
  const groups = $(documentRef, "workProgressGroups");
  clear(groups);
  if (!snapshot) return;
  const definitions = [
    ["未完成", snapshot.incompleteTasks],
    ["风险", snapshot.risks],
    ["待确认", snapshot.pendingConfirmations],
    ["截止时间", (snapshot.deadlines ?? []).map((deadline) => `${deadline.label} · ${new Date(deadline.dueAt).toLocaleString()}`)]
  ];
  for (const [label, items] of definitions) {
    if (!items?.length) continue;
    const group = element(documentRef, "section", "progress-group");
    group.append(element(documentRef, "strong", "", label));
    const list = documentRef.createElement("ul");
    for (const item of items) list.append(element(documentRef, "li", "", item));
    group.append(list);
    groups.append(group);
  }
}

function setDialogBusy(dialog, busy) {
  dialog.querySelectorAll("button, input, textarea").forEach((node) => {
    node.disabled = busy;
  });
}

export function createRenderer(input) {
  const { store, actions, documentRef = globalThis.document } = input;
  const controller = new (input.AbortControllerClass ?? globalThis.AbortController)();
  const listenerOptions = { signal: controller.signal };
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  let toastTimer = null;
  ensureMobileWorkSelect(documentRef, listenerOptions, actions);

  function showToast(message, kind = "info") {
    const toast = $(documentRef, "productToast");
    toast.textContent = message;
    toast.className = `toast${kind === "error" ? " error" : ""}`;
    if (toastTimer !== null) clearTimeoutFn(toastTimer);
    toastTimer = setTimeoutFn(() => toast.classList.add("hidden"), 4200);
  }

  async function retryOutgoing(clientMessageId) {
    try {
      const result = await actions.retry(clientMessageId);
      if (result?.status === "failed") {
        showToast(result.error?.message ?? "重试失败。", "error");
      }
    } catch (error) {
      showToast(error.message ?? "重试失败。", "error");
    }
  }

  function navigate(section) {
    actions.navigate(section);
  }

  documentRef.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.section), listenerOptions);
  });
  $(documentRef, "createWorkButton").addEventListener("click", () => $(documentRef, "createWorkDialog").showModal(), listenerOptions);
  $(documentRef, "mobileCreateWorkButton").addEventListener("click", () => $(documentRef, "createWorkDialog").showModal(), listenerOptions);
  $(documentRef, "workListToggle").addEventListener("click", () => {
    const select = $(documentRef, "mobileWorkSelect");
    if (select && select.options.length > 1) select.focus();
    else $(documentRef, "createWorkDialog").showModal();
  }, listenerOptions);
  $(documentRef, "convertSelectionButton").addEventListener("click", () => $(documentRef, "chatToWorkDialog").showModal(), listenerOptions);
  documentRef.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => $(documentRef, button.dataset.closeDialog).close(), listenerOptions);
  });
  $(documentRef, "loadEarlierButton").addEventListener("click", () => {
    void actions.loadEarlier("chat").catch((error) => showToast(error.message, "error"));
  }, listenerOptions);
  $(documentRef, "workLoadEarlierButton").addEventListener("click", () => {
    void actions.loadEarlier("work").catch((error) => showToast(error.message, "error"));
  }, listenerOptions);

  for (const [formId, inputId, target] of [
    ["messageComposer", "messageInput", "chat"],
    ["workMessageComposer", "workMessageInput", "work"]
  ]) {
    const form = $(documentRef, formId);
    const textarea = $(documentRef, inputId);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    }, listenerOptions);
    textarea.addEventListener("input", () => {
      void actions.saveDraft(target, textarea.value)
        .catch((error) => showToast(error.message ?? "草稿保存失败。", "error"));
    }, listenerOptions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textarea.value;
      if (!text.trim()) return;
      try {
        const result = await actions.send(target, text);
        if (result?.status === "succeeded") textarea.value = "";
        else if (result?.status === "draft") {
          showToast("当前离线，内容已保存为草稿。", "error");
        } else if (result?.status === "failed") {
          showToast(result.error?.message ?? "消息发送失败。", "error");
        }
      } catch (error) {
        showToast(error.message ?? "消息发送失败。", "error");
      }
    }, listenerOptions);
  }

  $(documentRef, "createWorkForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $(documentRef, "createWorkDialog");
    setDialogBusy(dialog, true);
    try {
      const result = await actions.createWork({
        title: $(documentRef, "createWorkTitleInput").value,
        goal: $(documentRef, "createWorkGoalInput").value
      });
      if (result == null) return;
      event.target.reset();
      dialog.close();
      showToast("Work 已创建。");
    } catch (error) {
      showToast(error.message ?? "创建 Work 失败。", "error");
    } finally {
      setDialogBusy(dialog, false);
    }
  }, listenerOptions);

  $(documentRef, "chatToWorkForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $(documentRef, "chatToWorkDialog");
    setDialogBusy(dialog, true);
    try {
      const result = await actions.convertChatToWork({
        title: $(documentRef, "chatToWorkTitleInput").value,
        goal: $(documentRef, "chatToWorkGoalInput").value
      });
      if (result == null) return;
      event.target.reset();
      dialog.close();
      showToast("已从 Chat 创建 Work。");
    } catch (error) {
      showToast(error.message ?? "Chat 转 Work 失败。", "error");
    } finally {
      setDialogBusy(dialog, false);
    }
  }, listenerOptions);

  function render(state) {
    const section = state.section ?? "chat";
    $(documentRef, "chatSection").classList.toggle("hidden", section !== "chat");
    $(documentRef, "workSection").classList.toggle("hidden", section !== "work");
    documentRef.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $(documentRef, "workspaceKicker").textContent = section === "chat" ? "PERSONAL CHAT" : "WORK CONVERSATIONS";
    $(documentRef, "workspaceTitle").textContent = section === "chat" ? "和个人助理继续聊" : "持续推进重要事项";

    const syncStatus = state.sync?.status ?? "idle";
    $(documentRef, "syncStatus").className = `sync-pill ${syncStatus}`;
    $(documentRef, "syncStatus").textContent = ({
      idle: "准备同步",
      syncing: "正在同步",
      online: "已同步",
      offline: "当前离线",
      degraded: "同步需重试"
    })[syncStatus] ?? syncStatus;

    const connection = $(documentRef, "connectionStatus");
    if (state.network?.online === false || syncStatus === "offline") {
      connection.className = "connection offline";
      connection.lastElementChild.textContent = "当前离线";
    } else if (syncStatus === "degraded") {
      connection.className = "connection degraded";
      connection.lastElementChild.textContent = "连接需恢复";
    } else {
      connection.className = "connection online";
      connection.lastElementChild.textContent = syncStatus === "syncing" ? "正在同步" : "工作台已连接";
    }

    renderWorkList(documentRef, listenerOptions, state, actions);

    const chatThreadRef = state.chat?.threadRef ?? null;
    const selected = state.selectedMessageRefs ?? [];
    $(documentRef, "selectionCount").textContent = selected.length ? `已选择 ${selected.length} 条` : "";
    $(documentRef, "convertSelectionButton").classList.toggle("hidden", selected.length === 0);
    $(documentRef, "chatToWorkSelectionSummary").textContent = `已选择 ${selected.length} 条消息。只会传递这些消息的引用。`;
    renderThread(documentRef, listenerOptions, {
      container: $(documentRef, "threadMessages"),
      empty: $(documentRef, "chatEmptyState"),
      loadEarlier: $(documentRef, "loadEarlierButton"),
      threadRef: chatThreadRef,
      messages: chatThreadRef ? state.messagesByThread?.[chatThreadRef] : [],
      outgoing: state.outgoing,
      nextBeforeSequence: chatThreadRef ? state.paginationByThread?.[chatThreadRef] : null,
      selectable: true,
      selectedRefs: selected,
      onSelect: actions.toggleMessageSelection,
      onRetry: retryOutgoing
    });
    const chatDraft = chatThreadRef ? state.drafts?.[chatThreadRef] ?? "" : "";
    if (documentRef.activeElement !== $(documentRef, "messageInput") && $(documentRef, "messageInput").value !== chatDraft) {
      $(documentRef, "messageInput").value = chatDraft;
    }
    $(documentRef, "composerStatus").textContent = state.network?.online === false
      ? "当前离线，输入会保存为草稿"
      : "Enter 发送 · Shift+Enter 换行";

    const work = state.works?.find((item) => item.workConversationRef === state.selectedWorkRef) ?? null;
    $(documentRef, "workStatus").textContent = work ? workStatusLabel(work.status) : "尚未选择";
    $(documentRef, "workHeading").textContent = work?.title ?? "选择一个 Work";
    $(documentRef, "workGoal").textContent = work?.goal ?? "每个 Work 都有独立的目标和对话上下文。";
    $(documentRef, "workDetailGoal").textContent = work?.goal ?? "选择 Work 后显示目标。";
    $(documentRef, "workSummary").textContent = work?.summary || "尚无阶段摘要。";
    renderProgress(documentRef, work ? state.progressByWork?.[work.workConversationRef] : null);

    const workThreadRef = work?.threadRef ?? null;
    renderThread(documentRef, listenerOptions, {
      container: $(documentRef, "workThreadMessages"),
      empty: $(documentRef, "workEmptyState"),
      loadEarlier: $(documentRef, "workLoadEarlierButton"),
      threadRef: workThreadRef,
      messages: workThreadRef ? state.messagesByThread?.[workThreadRef] : [],
      outgoing: state.outgoing,
      nextBeforeSequence: workThreadRef ? state.paginationByThread?.[workThreadRef] : null,
      selectable: false,
      selectedRefs: [],
      onSelect: () => undefined,
      onRetry: retryOutgoing
    });
    $(documentRef, "workMessageInput").disabled = !work;
    $(documentRef, "workSendMessageButton").disabled = !work;
    const workDraft = workThreadRef ? state.drafts?.[workThreadRef] ?? "" : "";
    if (documentRef.activeElement !== $(documentRef, "workMessageInput") && $(documentRef, "workMessageInput").value !== workDraft) {
      $(documentRef, "workMessageInput").value = workDraft;
    }
    $(documentRef, "workComposerStatus").textContent = !work
      ? "先选择一个 Work"
      : state.network?.online === false
        ? "当前离线，输入会保存为草稿"
        : "只在当前 Work 上下文中发送";
  }

  const unsubscribe = store.subscribe(render);
  render(store.getState());
  return {
    render,
    showToast,
    destroy() {
      controller.abort();
      unsubscribe();
      if (toastTimer !== null) {
        clearTimeoutFn(toastTimer);
        toastTimer = null;
      }
    }
  };
}
