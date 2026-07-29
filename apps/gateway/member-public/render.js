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

function readableBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function safeDownloadUrl(value) {
  return typeof value === "string" &&
    value.startsWith("/api/v1/attachments/")
    ? value
    : null;
}

function appendMessageAttachments(
  documentRef,
  bubble,
  attachments = [],
  className = ""
) {
  if (!attachments.length) return;
  const list = element(
    documentRef,
    "div",
    `message-attachments${className ? ` ${className}` : ""}`
  );
  for (const attachment of attachments) {
    const downloadUrl = safeDownloadUrl(attachment.downloadUrl);
    const chip = element(
      documentRef,
      downloadUrl ? "a" : "span",
      `message-attachment${downloadUrl ? " message-attachment-download" : ""}`
    );
    chip.append(element(documentRef, "span", "attachment-file-icon", "↗"));
    chip.append(element(
      documentRef,
      "span",
      "attachment-file-copy",
      `${attachment.fileName ?? "附件"} · ${readableBytes(attachment.sizeBytes)}`
    ));
    if (downloadUrl) {
      chip.href = downloadUrl;
      chip.download = attachment.fileName ?? "attachment";
      chip.setAttribute("aria-label", `下载附件 ${attachment.fileName ?? ""}`);
    }
    list.append(chip);
  }
  bubble.append(list);
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
  if (message.content?.text) {
    bubble.append(element(
      documentRef,
      "p",
      "message-content",
      message.content.text
    ));
  }
  appendMessageAttachments(documentRef, bubble, message.attachments);
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
  if (outgoing.content?.text) {
    bubble.append(element(
      documentRef,
      "p",
      "message-content",
      outgoing.content.text
    ));
  }
  appendMessageAttachments(
    documentRef,
    bubble,
    outgoing.attachments,
    "outgoing-attachment"
  );
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

function publicAgentStatus(agent) {
  const labels = {
    idle: "空闲",
    working: "工作中",
    problem: "有问题"
  };
  return labels[agent.status] ?? agent.statusLabel ?? "有问题";
}

function selectedAgent(state) {
  return (state.context?.mountedAgents ?? [])
    .find((agent) => agent.agentRef === state.currentAgentRef) ?? null;
}

function renderCurrentAgent(documentRef, state) {
  const agent = selectedAgent(state);
  const identity = $(documentRef, "currentAgentIdentity");
  clear(identity);
  identity.className =
    `workspace-agent-identity ${agent?.status ?? "unselected"}`;
  identity.append(element(
    documentRef,
    "span",
    "workspace-agent-avatar",
    agent?.displayName?.trim()?.slice(0, 1)?.toUpperCase() ?? "?"
  ));
  const copy = element(documentRef, "span", "workspace-agent-copy");
  copy.append(element(
    documentRef,
    "strong",
    "",
    agent?.displayName ?? "尚未选择"
  ));
  copy.append(element(documentRef, "span", "", "独立会话"));
  identity.append(copy);
  if (agent) {
    const status = element(
      documentRef,
      "span",
      "agent-status",
      publicAgentStatus(agent)
    );
    status.prepend?.(element(documentRef, "span", "agent-status-dot"));
    identity.append(status);
  }
  return agent;
}

function attachmentStateLabel(draft) {
  if (draft.serverState === "ready") return "已就绪";
  if (draft.serverState === "error" || draft.serverState === "failed") {
    return "上传失败";
  }
  const percent = Math.max(
    0,
    Math.min(100, Math.round(Number(draft.progress ?? 0) * 100))
  );
  return `上传中 ${percent}%`;
}

function renderAttachmentTray(
  documentRef,
  listenerOptions,
  tray,
  errorNode,
  drafts,
  onCancel,
  ephemeralError
) {
  clear(tray);
  const errors = [];
  for (const draft of drafts) {
    const state = draft.serverState ?? "uploading";
    const card = element(
      documentRef,
      "article",
      `attachment-card ${state}`
    );
    card.setAttribute("role", "listitem");
    const header = element(documentRef, "div", "attachment-card-header");
    const copy = element(documentRef, "span", "attachment-card-copy");
    copy.append(element(
      documentRef,
      "strong",
      "attachment-name",
      draft.fileName ?? "附件"
    ));
    copy.append(element(
      documentRef,
      "span",
      "attachment-details",
      `${readableBytes(draft.sizeBytes)} · ${draft.mediaType ?? "文件"}`
    ));
    header.append(copy);
    const remove = element(documentRef, "button", "attachment-remove", "×");
    remove.type = "button";
    remove.setAttribute(
      "aria-label",
      `移除附件 ${draft.fileName ?? ""}`
    );
    remove.addEventListener("click", () => {
      onCancel(draft.attachmentRef);
    }, listenerOptions);
    header.append(remove);
    card.append(header);
    const progress = element(documentRef, "div", "attachment-progress");
    const progressValue = element(documentRef, "span", "");
    const percent = Math.max(
      0,
      Math.min(100, Math.round(Number(draft.progress ?? 0) * 100))
    );
    progressValue.setAttribute("style", `width:${percent}%`);
    progress.append(progressValue);
    card.append(progress);
    card.append(element(
      documentRef,
      "span",
      "attachment-state",
      attachmentStateLabel(draft)
    ));
    tray.append(card);
    if (
      (state === "error" || state === "failed") &&
      draft.error?.message
    ) {
      errors.push(`${draft.fileName ?? "附件"}：${draft.error.message}`);
    }
  }
  if (ephemeralError) errors.push(ephemeralError);
  errorNode.textContent = errors.join("；");
  errorNode.classList.toggle("hidden", errors.length === 0);
  return {
    hasReady: drafts.some((draft) => draft.serverState === "ready"),
    blocked: drafts.some((draft) => draft.serverState !== "ready")
  };
}

function renderAgentSelector(documentRef, listenerOptions, state, actions, onError) {
  const agents = state.context?.mountedAgents ?? [];
  const list = $(documentRef, "agentChipList");
  const empty = $(documentRef, "agentEmptyState");
  const mobile = $(documentRef, "mobileAgentSelect");
  if (!list || !empty || !mobile) return;
  clear(list);
  clear(mobile);

  const placeholder = documentRef.createElement("option");
  placeholder.value = "";
  placeholder.textContent = agents.length
    ? "选择一个 Agent 开始"
    : "管理员尚未为你配置 Agent";
  placeholder.selected = !state.currentAgentRef;
  mobile.append(placeholder);

  const emptyMessage = agents.length
    ? "选择一个 Agent 开始"
    : "管理员尚未为你配置 Agent";
  empty.textContent = emptyMessage;
  empty.classList.toggle("hidden", Boolean(state.currentAgentRef));

  for (const agent of agents) {
    const selected = state.currentAgentRef === agent.agentRef;
    const button = element(documentRef, "button", `agent-chip ${agent.status}`);
    button.type = "button";
    button.dataset.agentRef = agent.agentRef;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", selected ? "true" : "false");
    button.append(element(documentRef, "span", "agent-status-dot"));
    button.append(element(documentRef, "span", "agent-chip-name", agent.displayName));
    button.append(element(documentRef, "span", "agent-status", publicAgentStatus(agent)));
    button.addEventListener("click", () => {
      void actions.switchAgent(agent.agentRef).catch(onError);
    }, listenerOptions);
    list.append(button);

    const option = documentRef.createElement("option");
    option.value = agent.agentRef;
    option.textContent = `${agent.displayName} · ${publicAgentStatus(agent)}`;
    option.selected = selected;
    mobile.append(option);
  }
  mobile.disabled = agents.length === 0;
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
  let lastAnnouncedAgentRef = null;
  const composerErrors = { chat: "", work: "" };
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

  function threadForTarget(state, target) {
    if (target === "chat") return state.chat?.threadRef ?? null;
    const work = state.works?.find(
      (item) => item.workConversationRef === state.selectedWorkRef
    );
    return work?.threadRef ?? null;
  }

  function attachmentDraftsFor(state, target) {
    const threadRef = threadForTarget(state, target);
    return (state.attachmentDrafts ?? []).filter(
      (draft) =>
        draft.agentRef === state.currentAgentRef &&
        draft.threadRef === threadRef
    );
  }

  function updateComposerAvailability(target) {
    const state = store.getState();
    const isChat = target === "chat";
    const textarea = $(documentRef, isChat ? "messageInput" : "workMessageInput");
    const sendButton = $(
      documentRef,
      isChat ? "sendMessageButton" : "workSendMessageButton"
    );
    const drafts = attachmentDraftsFor(state, target);
    const hasReady = drafts.some((draft) => draft.serverState === "ready");
    const blocked = drafts.some((draft) => draft.serverState !== "ready");
    const workspaceReady =
      (state.agentWorkspaceStatus ?? "ready") === "ready";
    const targetReady = isChat || Boolean(threadForTarget(state, target));
    sendButton.disabled =
      !state.currentAgentRef ||
      !workspaceReady ||
      !targetReady ||
      blocked ||
      (!textarea.value.trim() && !hasReady);
  }

  async function addFiles(target, files) {
    const values = [...(files ?? [])];
    if (values.length === 0) return;
    composerErrors[target] = "";
    try {
      await actions.addAttachments(target, values);
    } catch (error) {
      if (error?.name === "AbortError") return;
      const names = values
        .map((file) => file?.name)
        .filter(Boolean)
        .join("、");
      composerErrors[target] =
        `${names ? `${names}：` : ""}${error?.message ?? "附件添加失败。"}`;
      showToast(error?.message ?? "附件添加失败。", "error");
    } finally {
      render(store.getState());
    }
  }

  $(documentRef, "retryAgentLoadButton").addEventListener("click", () => {
    const agentRef = store.getState().currentAgentRef;
    if (!agentRef) return;
    void actions.switchAgent(agentRef).catch(
      (error) => showToast(error.message ?? "Agent 加载失败。", "error")
    );
  }, listenerOptions);

  $(documentRef, "mobileAgentSelect")?.addEventListener("change", (event) => {
    if (!event.target.value) return;
    void actions.switchAgent(event.target.value)
      .catch((error) => showToast(error.message ?? "Agent 切换失败。", "error"));
  }, listenerOptions);

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
    const isChat = target === "chat";
    const attachmentButton = $(
      documentRef,
      isChat ? "messageAttachmentButton" : "workAttachmentButton"
    );
    const attachmentInput = $(
      documentRef,
      isChat ? "messageAttachmentInput" : "workAttachmentInput"
    );
    attachmentButton.addEventListener("click", () => {
      attachmentInput.click();
    }, listenerOptions);
    attachmentInput.addEventListener("change", () => {
      const files = [...(attachmentInput.files ?? [])];
      attachmentInput.value = "";
      void addFiles(target, files);
    }, listenerOptions);
    textarea.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(target, files);
    }, listenerOptions);
    form.addEventListener("dragover", (event) => {
      if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
      event.preventDefault();
      form.classList.add("drag-active");
    }, listenerOptions);
    form.addEventListener("dragleave", () => {
      form.classList.remove("drag-active");
    }, listenerOptions);
    form.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      form.classList.remove("drag-active");
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(target, files);
    }, listenerOptions);
    textarea.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        form.requestSubmit();
      }
    }, listenerOptions);
    textarea.addEventListener("input", () => {
      if (textarea.style) {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
      }
      updateComposerAvailability(target);
      void actions.saveDraft(target, textarea.value)
        .catch((error) => showToast(error.message ?? "草稿保存失败。", "error"));
    }, listenerOptions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textarea.value;
      const drafts = attachmentDraftsFor(store.getState(), target);
      const hasReady = drafts.some(
        (draft) => draft.serverState === "ready"
      );
      const blocked = drafts.some(
        (draft) => draft.serverState !== "ready"
      );
      if (blocked || (!text.trim() && !hasReady)) return;
      try {
        const result = await actions.send(target, text);
        if (result?.status === "queued") {
          textarea.value = "";
          if (textarea.style) textarea.style.height = "auto";
          textarea.focus();
          updateComposerAvailability(target);
        }
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
    const agentReady = Boolean(state.currentAgentRef);
    const currentAgent = renderCurrentAgent(documentRef, state);
    const agentName = currentAgent?.displayName ?? null;
    if (state.currentAgentRef !== lastAnnouncedAgentRef) {
      lastAnnouncedAgentRef = state.currentAgentRef;
      $(documentRef, "agentWorkspaceAnnouncement").textContent = agentName
        ? `已切换到 ${agentName} 的独立会话`
        : "当前未选择 Agent";
    }
    const workspaceStatus = state.agentWorkspaceStatus ??
      (agentReady ? "ready" : "empty");
    const workspaceBlocked =
      workspaceStatus === "loading" || workspaceStatus === "error";
    const workspaceState = $(documentRef, "agentWorkspaceState");
    workspaceState.className =
      `agent-workspace-state ${workspaceStatus}${workspaceBlocked ? "" : " hidden"}`;
    $(documentRef, "agentWorkspaceStateTitle").textContent =
      workspaceStatus === "error"
        ? `${agentName ?? "Agent"} 加载失败`
        : `正在打开 ${agentName ?? "Agent"}`;
    $(documentRef, "agentWorkspaceStateMessage").textContent =
      workspaceStatus === "error"
        ? state.agentWorkspaceError?.message ??
          "没有覆盖成其他 Agent 的内容。你可以安全重试。"
        : `正在恢复 ${agentName ?? "这个 Agent"} 的独立 Chat、Work、草稿和附件。`;
    $(documentRef, "retryAgentLoadButton").classList.toggle(
      "hidden",
      workspaceStatus !== "error"
    );
    renderAgentSelector(
      documentRef,
      listenerOptions,
      state,
      actions,
      (error) => showToast(error.message ?? "Agent 切换失败。", "error")
    );
    documentRef.querySelectorAll(
      "[data-section], #createWorkButton, #mobileCreateWorkButton, #convertSelectionButton"
    ).forEach((button) => {
      button.disabled = !agentReady;
    });
    const section = state.section ?? "chat";
    $(documentRef, "chatSection").classList.toggle(
      "hidden",
      workspaceBlocked || section !== "chat"
    );
    $(documentRef, "workSection").classList.toggle(
      "hidden",
      workspaceBlocked || section !== "work"
    );
    documentRef.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $(documentRef, "workspaceKicker").textContent = section === "chat" ? "PERSONAL CHAT" : "WORK CONVERSATIONS";
    $(documentRef, "workspaceTitle").textContent = section === "chat"
      ? agentName ? `和 ${agentName} 继续聊` : "和个人助理继续聊"
      : agentName ? `使用 ${agentName} 推进重要事项` : "持续推进重要事项";
    $(documentRef, "messageInput").placeholder = agentName
      ? `给 ${agentName} 发消息…`
      : "给个人助理发消息…";
    $(documentRef, "workMessageInput").placeholder = agentName
      ? `让 ${agentName} 继续推进当前 Work…`
      : "在当前 Work 中继续…";
    $(documentRef, "chatEmptyTitle").textContent = agentName
      ? `开始和 ${agentName} 对话`
      : "从一句话开始";
    $(documentRef, "chatEmptyMessage").textContent = agentName
      ? `这里是你和 ${agentName} 在所有个人设备上共享的独立 Chat。`
      : "选择 Agent 后开始独立会话。";
    $(documentRef, "workEmptyTitle").textContent = agentName
      ? `让 ${agentName} 继续推进`
      : "让这个事项继续推进";
    $(documentRef, "workEmptyMessage").textContent = agentName
      ? `打开或创建一个只属于 ${agentName} 的 Work。`
      : "打开或创建一个 Work 后，可以在独立上下文中继续对话。";

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
    const chatAttachments = attachmentDraftsFor(state, "chat");
    const chatAttachmentState = renderAttachmentTray(
      documentRef,
      listenerOptions,
      $(documentRef, "messageAttachmentTray"),
      $(documentRef, "messageAttachmentError"),
      chatAttachments,
      (attachmentRef) => {
        void Promise.resolve(actions.cancelAttachment(attachmentRef)).catch(
          (error) => showToast(error.message ?? "附件移除失败。", "error")
        );
      },
      composerErrors.chat
    );
    $(documentRef, "messageInput").disabled =
      !agentReady || workspaceBlocked;
    $(documentRef, "messageAttachmentButton").disabled =
      !agentReady || workspaceBlocked;
    $(documentRef, "messageAttachmentInput").disabled =
      !agentReady || workspaceBlocked;
    updateComposerAvailability("chat");
    $(documentRef, "composerStatus").textContent = state.network?.online === false
      ? "当前离线，输入会保存为草稿"
      : chatAttachmentState.blocked
        ? "等待全部附件上传完成"
      : agentReady
        ? "Enter 发送 · Shift+Enter 换行"
        : state.agentSelectionKind === "unconfigured"
          ? "管理员尚未为你配置 Agent"
          : "选择一个 Agent 开始";

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
    $(documentRef, "workMessageInput").disabled =
      !agentReady || !work || workspaceBlocked;
    const workDraft = workThreadRef ? state.drafts?.[workThreadRef] ?? "" : "";
    if (documentRef.activeElement !== $(documentRef, "workMessageInput") && $(documentRef, "workMessageInput").value !== workDraft) {
      $(documentRef, "workMessageInput").value = workDraft;
    }
    const workAttachments = attachmentDraftsFor(state, "work");
    const workAttachmentState = renderAttachmentTray(
      documentRef,
      listenerOptions,
      $(documentRef, "workAttachmentTray"),
      $(documentRef, "workAttachmentError"),
      workAttachments,
      (attachmentRef) => {
        void Promise.resolve(actions.cancelAttachment(attachmentRef)).catch(
          (error) => showToast(error.message ?? "附件移除失败。", "error")
        );
      },
      composerErrors.work
    );
    $(documentRef, "workAttachmentButton").disabled =
      !agentReady || !work || workspaceBlocked;
    $(documentRef, "workAttachmentInput").disabled =
      !agentReady || !work || workspaceBlocked;
    updateComposerAvailability("work");
    $(documentRef, "workComposerStatus").textContent = !work
      ? "先选择一个 Work"
      : state.network?.online === false
        ? "当前离线，输入会保存为草稿"
        : workAttachmentState.blocked
          ? "等待全部附件上传完成"
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
