const $ = (id) => document.getElementById(id);

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function element(tag, className, text = undefined) {
  const node = document.createElement(tag);
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

function messageNode(message, input) {
  const row = element("article", `message ${message.actor?.type ?? "system"}`);
  row.dataset.messageRef = message.messageRef;
  if (input.selectable) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "message-select";
    checkbox.checked = input.selected.has(message.messageRef);
    checkbox.setAttribute("aria-label", `选择${actorLabel(message)}的消息`);
    checkbox.addEventListener("change", () => input.onSelect(message.messageRef));
    row.append(checkbox);
  }
  const bubble = element("div", "message-bubble");
  bubble.append(element("p", "message-content", message.content?.text ?? ""));
  const meta = element("div", "message-meta");
  meta.append(element("span", "", actorLabel(message)));
  meta.append(element("time", "", displayTime(message.occurredAt ?? message.createdAt)));
  bubble.append(meta);
  row.append(bubble);
  return row;
}

function outgoingNode(outgoing, onRetry) {
  const failed = outgoing.status === "failed";
  const row = element("article", `message outgoing${failed ? " failed" : ""}`);
  row.dataset.clientMessageId = outgoing.clientMessageId;
  const bubble = element("div", "message-bubble");
  bubble.append(element("p", "message-content", outgoing.content?.text ?? ""));
  const meta = element("div", "message-meta");
  meta.append(element("span", "", failed ? "发送或回复失败" : "正在发送"));
  meta.append(element("time", "", displayTime(outgoing.occurredAt)));
  if (failed && outgoing.error?.retryable) {
    const retry = element("button", "retry-message", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => onRetry(outgoing.clientMessageId));
    meta.append(retry);
  }
  bubble.append(meta);
  row.append(bubble);
  return row;
}

function renderThread(input) {
  clear(input.container);
  const authoritative = input.messages ?? [];
  const outgoing = (input.outgoing ?? []).filter((item) => item.threadRef === input.threadRef);
  const selected = new Set(input.selectedRefs ?? []);
  for (const message of authoritative) {
    input.container.append(messageNode(message, {
      selectable: input.selectable,
      selected,
      onSelect: input.onSelect
    }));
  }
  for (const item of outgoing) input.container.append(outgoingNode(item, input.onRetry));
  input.empty.classList.toggle("hidden", authoritative.length + outgoing.length > 0);
  input.loadEarlier.classList.toggle("hidden", input.nextBeforeSequence == null);
  queueMicrotask(() => {
    input.container.scrollTop = input.container.scrollHeight;
  });
}

function renderWorkList(state, actions) {
  const list = $("workList");
  const select = $("mobileWorkSelect");
  clear(list);
  if (select) {
    clear(select);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择 Work";
    select.append(placeholder);
  }
  if (!state.works?.length) {
    list.append(element("p", "work-list-empty", "还没有 Work。创建一个长期事项后，它会出现在这里。"));
    return;
  }
  for (const work of state.works) {
    const button = element("button", `work-list-item${state.selectedWorkRef === work.workConversationRef ? " active" : ""}`);
    button.type = "button";
    button.append(element("strong", "", work.title));
    button.append(element("span", "", `${workStatusLabel(work.status)} · ${work.goal}`));
    button.addEventListener("click", () => actions.openWork(work.workConversationRef));
    list.append(button);
    if (select) {
      const option = document.createElement("option");
      option.value = work.workConversationRef;
      option.textContent = work.title;
      option.selected = state.selectedWorkRef === work.workConversationRef;
      select.append(option);
    }
  }
}

function renderProgress(snapshot) {
  $("workPhaseSummary").textContent = snapshot?.phaseSummary || "尚无结构化进度。";
  const groups = $("workProgressGroups");
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
    const group = element("section", "progress-group");
    group.append(element("strong", "", label));
    const list = document.createElement("ul");
    for (const item of items) list.append(element("li", "", item));
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
  const { store, actions } = input;
  let toastTimer = null;

  function showToast(message, kind = "info") {
    const toast = $("productToast");
    toast.textContent = message;
    toast.className = `toast${kind === "error" ? " error" : ""}`;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 4200);
  }

  function navigate(section) {
    actions.navigate(section);
  }

  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.section));
  });
  $("createWorkButton").addEventListener("click", () => $("createWorkDialog").showModal());
  $("mobileCreateWorkButton").addEventListener("click", () => $("createWorkDialog").showModal());
  $("workListToggle").addEventListener("click", () => {
    const select = $("mobileWorkSelect");
    if (select && select.options.length > 1) select.focus();
    else $("createWorkDialog").showModal();
  });
  $("mobileWorkSelect")?.addEventListener("change", (event) => {
    if (event.target.value) actions.openWork(event.target.value);
  });
  $("convertSelectionButton").addEventListener("click", () => $("chatToWorkDialog").showModal());
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => $(button.dataset.closeDialog).close());
  });
  $("loadEarlierButton").addEventListener("click", () => actions.loadEarlier("chat"));
  $("workLoadEarlierButton").addEventListener("click", () => actions.loadEarlier("work"));

  for (const [formId, inputId, target] of [
    ["messageComposer", "messageInput", "chat"],
    ["workMessageComposer", "workMessageInput", "work"]
  ]) {
    const form = $(formId);
    const textarea = $(inputId);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    textarea.addEventListener("input", () => actions.saveDraft(target, textarea.value));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textarea.value;
      if (!text.trim()) return;
      const result = await actions.send(target, text);
      if (result?.status === "draft") showToast("当前离线，内容已保存为草稿。", "error");
      else if (result?.status === "failed") showToast(result.error?.message ?? "消息发送失败。", "error");
    });
  }

  $("createWorkForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $("createWorkDialog");
    setDialogBusy(dialog, true);
    try {
      await actions.createWork({
        title: $("createWorkTitleInput").value,
        goal: $("createWorkGoalInput").value
      });
      event.target.reset();
      dialog.close();
      showToast("Work 已创建。")
    } catch (error) {
      showToast(error.message ?? "创建 Work 失败。", "error");
    } finally {
      setDialogBusy(dialog, false);
    }
  });

  $("chatToWorkForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $("chatToWorkDialog");
    setDialogBusy(dialog, true);
    try {
      await actions.convertChatToWork({
        title: $("chatToWorkTitleInput").value,
        goal: $("chatToWorkGoalInput").value
      });
      event.target.reset();
      dialog.close();
      showToast("已从 Chat 创建 Work。")
    } catch (error) {
      showToast(error.message ?? "Chat 转 Work 失败。", "error");
    } finally {
      setDialogBusy(dialog, false);
    }
  });

  function render(state) {
    const section = state.section ?? "chat";
    $("chatSection").classList.toggle("hidden", section !== "chat");
    $("workSection").classList.toggle("hidden", section !== "work");
    document.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("workspaceKicker").textContent = section === "chat" ? "PERSONAL CHAT" : "WORK CONVERSATIONS";
    $("workspaceTitle").textContent = section === "chat" ? "和个人助理继续聊" : "持续推进重要事项";

    const syncStatus = state.sync?.status ?? "idle";
    $("syncStatus").className = `sync-pill ${syncStatus}`;
    $("syncStatus").textContent = ({
      idle: "准备同步",
      syncing: "正在同步",
      online: "已同步",
      offline: "当前离线",
      degraded: "同步需重试"
    })[syncStatus] ?? syncStatus;

    renderWorkList(state, actions);

    const chatThreadRef = state.chat?.threadRef ?? null;
    const selected = state.selectedMessageRefs ?? [];
    $("selectionCount").textContent = selected.length ? `已选择 ${selected.length} 条` : "";
    $("convertSelectionButton").classList.toggle("hidden", selected.length === 0);
    $("chatToWorkSelectionSummary").textContent = `已选择 ${selected.length} 条消息。只会传递这些消息的引用。`;
    renderThread({
      container: $("threadMessages"),
      empty: $("chatEmptyState"),
      loadEarlier: $("loadEarlierButton"),
      threadRef: chatThreadRef,
      messages: chatThreadRef ? state.messagesByThread?.[chatThreadRef] : [],
      outgoing: state.outgoing,
      nextBeforeSequence: chatThreadRef ? state.paginationByThread?.[chatThreadRef] : null,
      selectable: true,
      selectedRefs: selected,
      onSelect: actions.toggleMessageSelection,
      onRetry: actions.retry
    });
    const chatDraft = chatThreadRef ? state.drafts?.[chatThreadRef] ?? "" : "";
    if (document.activeElement !== $("messageInput") && $("messageInput").value !== chatDraft) {
      $("messageInput").value = chatDraft;
    }
    $("composerStatus").textContent = state.network?.online === false
      ? "当前离线，输入会保存为草稿"
      : "Enter 发送 · Shift+Enter 换行";

    const work = state.works?.find((item) => item.workConversationRef === state.selectedWorkRef) ?? null;
    $("workStatus").textContent = work ? workStatusLabel(work.status) : "尚未选择";
    $("workHeading").textContent = work?.title ?? "选择一个 Work";
    $("workGoal").textContent = work?.goal ?? "每个 Work 都有独立的目标和对话上下文。";
    $("workDetailGoal").textContent = work?.goal ?? "选择 Work 后显示目标。";
    $("workSummary").textContent = work?.summary || "尚无阶段摘要。";
    renderProgress(work ? state.progressByWork?.[work.workConversationRef] : null);

    const workThreadRef = work?.threadRef ?? null;
    renderThread({
      container: $("workThreadMessages"),
      empty: $("workEmptyState"),
      loadEarlier: $("workLoadEarlierButton"),
      threadRef: workThreadRef,
      messages: workThreadRef ? state.messagesByThread?.[workThreadRef] : [],
      outgoing: state.outgoing,
      nextBeforeSequence: workThreadRef ? state.paginationByThread?.[workThreadRef] : null,
      selectable: false,
      selectedRefs: [],
      onSelect: () => undefined,
      onRetry: actions.retry
    });
    $("workMessageInput").disabled = !work;
    $("workSendMessageButton").disabled = !work;
    const workDraft = workThreadRef ? state.drafts?.[workThreadRef] ?? "" : "";
    if (document.activeElement !== $("workMessageInput") && $("workMessageInput").value !== workDraft) {
      $("workMessageInput").value = workDraft;
    }
    $("workComposerStatus").textContent = !work
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
      unsubscribe();
      if (toastTimer !== null) clearTimeout(toastTimer);
    }
  };
}
