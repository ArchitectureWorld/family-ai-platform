const FIXED_PANES = Object.freeze([
  Object.freeze({
    agentRef: "agent:hermes-jarvis",
    displayName: "Jarvis"
  }),
  Object.freeze({
    agentRef: "agent:codex-cli",
    displayName: "Codex"
  })
]);

function element(documentRef, name, {
  className,
  text,
  attributes = {}
} = {}) {
  const node = documentRef.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

function createPaneState(agent) {
  return {
    agentRef: agent.agentRef,
    displayName: agent.displayName,
    mode: "chat",
    chat: {
      threadRef: null,
      messages: [],
      draft: ""
    },
    work: {
      workConversationRef: null,
      threadRef: null,
      conversations: [],
      messages: [],
      draft: "",
      progress: null
    },
    busy: false,
    error: null
  };
}

function messageText(message) {
  return typeof message?.content?.text === "string"
    ? message.content.text
    : "";
}

function boundedError() {
  return "暂时无法加载此 Agent，请稍后重试。";
}

export function createAdminWorkspace({
  root,
  api,
  documentRef = document,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval
}) {
  if (!root || !api) throw new Error("ADMIN_WORKSPACE_INPUT_INVALID");

  let destroyed = false;
  let detailed = false;
  let intervalId = null;
  let statusSnapshot = [];

  const panes = new Map(
    FIXED_PANES.map((agent) => [agent.agentRef, createPaneState(agent)])
  );
  const paneRoots = new Map();

  let monitorRoot = root.querySelector("[data-agent-monitor]");
  if (monitorRoot === null) {
    monitorRoot = element(documentRef, "section", {
      attributes: {
        id: "admin-agent-monitor",
        "data-agent-monitor": ""
      }
    });
  }
  let workspaceRoot = root.querySelector("[data-agent-workspace]");
  if (workspaceRoot === null) {
    workspaceRoot = element(documentRef, "section", {
      attributes: {
        id: "admin-agent-workspace",
        "data-agent-workspace": ""
      }
    });
  }
  root.replaceChildren(monitorRoot, workspaceRoot);

  function renderMonitor() {
    monitorRoot.className =
      `agent-monitor ${detailed ? "detail" : "compact"}`;
    const heading = element(documentRef, "strong", {
      text: "Agent 运行状态",
      className: "agent-monitor-title"
    });
    const statuses = element(documentRef, "div", {
      className: "agent-monitor-statuses"
    });
    for (const agent of statusSnapshot) {
      const item = element(documentRef, "div", {
        className: `agent-monitor-item status-${agent.status}`
      });
      const summary = element(documentRef, "span", {
        className: "agent-monitor-summary"
      });
      summary.append(
        element(documentRef, "span", {
          className: "agent-status-dot",
          attributes: {
            "data-agent-status-dot": "",
            "aria-hidden": "true"
          }
        }),
        element(documentRef, "span", {
          text: `${agent.displayName}：${agent.statusLabel}`
        })
      );
      item.append(summary);
      if (detailed) {
        const detail = element(documentRef, "span", {
          className: "agent-monitor-detail",
          text:
            `${agent.activeTurnCount} 个进行中 · ${agent.lastCheckedAt}` +
            `${agent.publicProblem ? ` · ${agent.publicProblem}` : ""}`
        });
        item.append(detail);
      }
      statuses.append(item);
    }
    const toggle = element(documentRef, "button", {
      className: "agent-monitor-toggle",
      text: detailed ? "收起详情" : "查看详情",
      attributes: {
        type: "button",
        "data-monitor-toggle": "",
        "aria-expanded": String(detailed)
      }
    });
    toggle.addEventListener("click", () => {
      detailed = !detailed;
      renderMonitor();
    });
    monitorRoot.replaceChildren(heading, statuses, toggle);
  }

  async function refreshMonitor() {
    try {
      const response = await api.agents();
      if (destroyed) return;
      statusSnapshot = response.agents;
      renderMonitor();
    } catch {
      if (destroyed) return;
      statusSnapshot = [];
      monitorRoot.className = "agent-monitor compact";
      monitorRoot.replaceChildren(
        element(documentRef, "strong", {
          text: "Agent 运行状态"
        }),
        element(documentRef, "span", {
          text: "状态暂时不可用",
          attributes: { role: "status" }
        })
      );
    }
  }

  function activeChannel(state) {
    return state.mode === "chat" ? state.chat : state.work;
  }

  function renderMessages(state, container) {
    const channel = activeChannel(state);
    if (channel.messages.length === 0) {
      container.append(element(documentRef, "p", {
        className: "agent-pane-empty",
        text: "暂无消息。"
      }));
      return;
    }
    for (const message of channel.messages) {
      container.append(element(documentRef, "p", {
        className: "agent-pane-message",
        text: messageText(message)
      }));
    }
  }

  async function selectWork(state, conversation) {
    if (state.busy || destroyed) return;
    state.busy = true;
    state.error = null;
    state.work.workConversationRef = conversation.workConversationRef;
    state.work.threadRef = conversation.threadRef;
    renderPane(state);
    try {
      const [messageResult, progressResult] = await Promise.all([
        api.systemThreadMessages(conversation.threadRef),
        api.systemWorkProgress(conversation.workConversationRef)
      ]);
      if (destroyed) return;
      state.work.messages = messageResult.messages;
      state.work.progress = progressResult.snapshot;
    } catch {
      if (!destroyed) state.error = boundedError();
    } finally {
      if (!destroyed) {
        state.busy = false;
        renderPane(state);
      }
    }
  }

  async function createWork(state, title, goal) {
    if (state.busy || destroyed) return;
    state.busy = true;
    state.error = null;
    renderPane(state);
    try {
      const response = await api.createSystemAgentWork(
        state.agentRef,
        { title, goal }
      );
      if (destroyed) return;
      state.work.conversations = [
        response.conversation,
        ...state.work.conversations.filter((conversation) =>
          conversation.workConversationRef !==
            response.conversation.workConversationRef)
      ];
      state.work.workConversationRef =
        response.conversation.workConversationRef;
      state.work.threadRef = response.conversation.threadRef;
      state.work.messages = [];
      state.work.progress = null;
    } catch {
      if (!destroyed) state.error = boundedError();
    } finally {
      if (!destroyed) {
        state.busy = false;
        renderPane(state);
      }
    }
  }

  async function send(state) {
    const channel = activeChannel(state);
    const text = channel.draft.trim();
    if (state.busy || destroyed || text === "" || !channel.threadRef) return;
    state.busy = true;
    state.error = null;
    renderPane(state);
    try {
      const response = await api.sendSystemThreadMessage(
        channel.threadRef,
        text
      );
      if (destroyed) return;
      channel.messages = [...channel.messages, response.message];
      channel.draft = "";
    } catch {
      if (!destroyed) state.error = boundedError();
    } finally {
      if (!destroyed) {
        state.busy = false;
        renderPane(state);
      }
    }
  }

  function renderWorkNavigation(state, pane) {
    const works = element(documentRef, "div", {
      className: "agent-work-list",
      attributes: { "aria-label": `${state.displayName} Work 列表` }
    });
    for (const conversation of state.work.conversations) {
      const selected =
        conversation.workConversationRef === state.work.workConversationRef;
      const button = element(documentRef, "button", {
        className: `agent-work-item${selected ? " is-selected" : ""}`,
        text: conversation.title,
        attributes: {
          type: "button",
          "data-work-ref": conversation.workConversationRef,
          "aria-pressed": String(selected)
        }
      });
      button.disabled = state.busy;
      button.addEventListener("click", () => {
        void selectWork(state, conversation);
      });
      works.append(button);
    }

    const createForm = element(documentRef, "form", {
      className: "agent-work-create",
      attributes: { "data-create-work": "" }
    });
    const title = element(documentRef, "input", {
      attributes: {
        name: "title",
        placeholder: "Work 标题",
        maxlength: "120",
        required: ""
      }
    });
    const goal = element(documentRef, "input", {
      attributes: {
        name: "goal",
        placeholder: "目标",
        maxlength: "4000",
        required: ""
      }
    });
    const submit = element(documentRef, "button", {
      text: "新建 Work",
      attributes: { type: "submit" }
    });
    submit.disabled = state.busy;
    createForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void createWork(state, title.value.trim(), goal.value.trim());
    });
    createForm.append(title, goal, submit);
    pane.append(works, createForm);
    if (state.work.progress) {
      pane.append(element(documentRef, "p", {
        className: "agent-work-progress",
        text:
          state.work.progress.phaseSummary ??
          `Work 状态：${state.work.progress.status}`,
        attributes: {
          "data-work-progress": "",
          role: "status"
        }
      }));
    }
  }

  function renderPane(state) {
    const pane = paneRoots.get(state.agentRef);
    if (!pane) return;
    const heading = element(documentRef, "header", {
      className: "agent-pane-heading"
    });
    heading.append(
      element(documentRef, "p", {
        className: "eyebrow",
        text: state.agentRef === "agent:hermes-jarvis"
          ? "左侧 Agent"
          : "右侧 Agent"
      }),
      element(documentRef, "h3", { text: state.displayName })
    );
    const modes = element(documentRef, "div", {
      className: "agent-pane-modes"
    });
    for (const [mode, label] of [["chat", "Chat"], ["work", "Work"]]) {
      const button = element(documentRef, "button", {
        className: state.mode === mode ? "is-selected" : "",
        text: label,
        attributes: {
          type: "button",
          "data-pane-mode": mode,
          "aria-pressed": String(state.mode === mode)
        }
      });
      button.disabled = state.busy;
      button.addEventListener("click", () => {
        state.mode = mode;
        state.error = null;
        renderPane(state);
      });
      modes.append(button);
    }
    pane.replaceChildren(heading, modes);
    if (state.mode === "work") renderWorkNavigation(state, pane);

    const messages = element(documentRef, "div", {
      className: "agent-pane-messages",
      attributes: {
        "data-pane-messages": "",
        "aria-live": "polite"
      }
    });
    renderMessages(state, messages);
    const channel = activeChannel(state);
    const composer = element(documentRef, "div", {
      className: "agent-pane-composer"
    });
    const draft = element(documentRef, "textarea", {
      attributes: {
        "data-pane-draft": "",
        "aria-label": `${state.displayName} ${state.mode} 消息`,
        maxlength: "12000"
      }
    });
    draft.value = channel.draft;
    draft.disabled = state.busy || !channel.threadRef;
    draft.addEventListener("input", () => {
      channel.draft = draft.value;
    });
    const sendButton = element(documentRef, "button", {
      className: "primary-button",
      text: state.busy ? "处理中…" : "发送",
      attributes: {
        type: "button",
        "data-pane-send": ""
      }
    });
    sendButton.disabled = state.busy || !channel.threadRef;
    sendButton.addEventListener("click", () => {
      void send(state);
    });
    composer.append(draft, sendButton);
    pane.append(messages, composer);
    if (state.error) {
      pane.append(element(documentRef, "p", {
        className: "agent-pane-error",
        text: state.error,
        attributes: { role: "alert" }
      }));
    }
  }

  async function loadPane(state) {
    state.busy = true;
    renderPane(state);
    try {
      const [chatResult, workResult] = await Promise.all([
        api.systemAgentChat(state.agentRef),
        api.systemAgentWorkConversations(state.agentRef)
      ]);
      if (destroyed) return;
      state.chat.threadRef = chatResult.chat.threadRef;
      state.work.conversations = workResult.conversations;
      const firstWork = workResult.conversations[0] ?? null;
      if (firstWork) {
        state.work.workConversationRef = firstWork.workConversationRef;
        state.work.threadRef = firstWork.threadRef;
      }
      const requests = [
        api.systemThreadMessages(state.chat.threadRef)
          .then((value) => {
            state.chat.messages = value.messages;
          })
      ];
      if (firstWork) {
        requests.push(
          api.systemThreadMessages(firstWork.threadRef)
            .then((value) => {
              state.work.messages = value.messages;
            }),
          api.systemWorkProgress(firstWork.workConversationRef)
            .then((value) => {
              state.work.progress = value.snapshot;
            })
        );
      }
      await Promise.all(requests);
    } catch {
      if (!destroyed) state.error = boundedError();
    } finally {
      if (!destroyed) {
        state.busy = false;
        renderPane(state);
      }
    }
  }

  workspaceRoot.replaceChildren();
  for (const agent of FIXED_PANES) {
    const pane = element(documentRef, "article", {
      className: "agent-pane",
      attributes: { "data-agent-pane": agent.agentRef }
    });
    paneRoots.set(agent.agentRef, pane);
    workspaceRoot.append(pane);
    renderPane(panes.get(agent.agentRef));
  }

  const ready = (async () => {
    await refreshMonitor();
    try {
      await api.systemWorkspace();
    } catch {
      for (const state of panes.values()) state.error = boundedError();
    }
    await Promise.all([...panes.values()].map((state) => loadPane(state)));
    if (!destroyed) {
      intervalId = setIntervalImpl(() => {
        void refreshMonitor();
      }, 5000);
    }
  })();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (intervalId !== null) {
      clearIntervalImpl(intervalId);
      intervalId = null;
    }
  }

  return { ready, panes, destroy };
}
