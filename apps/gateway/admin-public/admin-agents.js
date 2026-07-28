const SAFE_ERROR_TEXT = "暂时无法完成 Agent 配置，请稍后重试。";
const UNAVAILABLE_TEXT = "无法确认当前 Agent 配置。请重新加载后再操作。";
const REUSE_NOTE =
  "同一个 Agent 可以提供给多个成员；如果它连接的是同一个 Hermes Profile，Hermes 内部记忆也可能共享。";

function element(documentRef, name, { className, text, attributes = {} } = {}) {
  const node = documentRef.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

export function availableAgentOptions(catalog, mountedAgents) {
  const mounted = new Set(mountedAgents.map((agent) => agent.agentRef));
  return catalog.filter((agent) => !mounted.has(agent.agentRef));
}

export function renderMemberAgentControls({
  documentRef = document,
  root,
  personRef,
  api,
  confirmImpl = (message) => window.confirm(message)
}) {
  let stateKnown = false;
  let catalog = [];
  let mounts = null;
  let busy = false;
  let pendingMessage = "";
  let menuOpen = false;
  let mutationRetry = null;
  let pendingMutation = null;

  const focusFallbacks = [
    "refresh-retry",
    "mutation-retry",
    "add-menu",
    "default-select",
    "default-save"
  ];

  const focusByKey = (preferredKey) => {
    const keys = preferredKey === null
      ? []
      : [preferredKey, ...focusFallbacks.filter((key) => key !== preferredKey)];
    for (const key of keys) {
      const target = root.querySelector(`[data-focus-key="${key}"]`);
      if (target !== null && !target.disabled) {
        target.focus();
        return;
      }
    }
  };

  const control = (node) => {
    node.disabled = busy;
    return node;
  };

  const feedbackNode = () => {
    const feedback = element(documentRef, "div", {
      className: "agent-feedback",
      attributes: {
        role: "status",
        "aria-live": "polite"
      }
    });
    if (busy) {
      feedback.setAttribute("tabindex", "-1");
      feedback.setAttribute("data-focus-key", "pending");
      feedback.append(element(documentRef, "span", {
        text: pendingMessage
      }));
    } else if (mutationRetry !== null) {
      const retry = element(documentRef, "button", {
        className: "text-button",
        text: "重试",
        attributes: {
          type: "button",
          "data-agent-retry": "",
          "data-focus-key": "mutation-retry"
        }
      });
      retry.addEventListener("click", () => {
        if (busy || mutationRetry === null) return;
        const descriptor = mutationRetry;
        void runMutation(descriptor);
      });
      feedback.append(
        element(documentRef, "span", { text: SAFE_ERROR_TEXT }),
        retry
      );
    }
    return feedback;
  };

  const renderUnknown = (section) => {
    if (busy) {
      section.append(feedbackNode());
      return;
    }
    const retry = element(documentRef, "button", {
      className: "secondary-button",
      text: "重新加载",
      attributes: {
        type: "button",
        "data-agent-refresh-retry": "",
        "data-agent-retry": "",
        "data-focus-key": "refresh-retry"
      }
    });
    retry.addEventListener("click", () => {
      if (busy) return;
      void reloadState({
        pendingText: "正在重新加载 Agent 配置…",
        pendingFocus: true,
        successFocus: pendingMutation?.descriptor.focusKey ?? "refresh-retry"
      });
    });
    const unavailable = element(documentRef, "div", {
      className: "agent-unavailable",
      attributes: { role: "alert" }
    });
    unavailable.append(
      element(documentRef, "p", { text: UNAVAILABLE_TEXT }),
      retry
    );
    section.append(unavailable);
  };

  const renderKnown = (section) => {
    const chips = element(documentRef, "div", {
      className: "agent-chip-list",
      attributes: { "aria-label": "已挂载 Agent" }
    });
    if (mounts.mountedAgents.length === 0) {
      chips.append(element(documentRef, "p", {
        className: "agent-empty",
        text: "尚未挂载 Agent。"
      }));
    }
    for (const mount of mounts.mountedAgents) {
      const chip = element(documentRef, "div", {
        className: `agent-chip agent-status-${mount.status}`
      });
      const identity = element(documentRef, "span", {
        className: "agent-chip-identity"
      });
      identity.append(
        element(documentRef, "strong", { text: mount.displayName }),
        element(documentRef, "span", {
          className: "agent-status",
          text: mount.statusLabel
        })
      );
      if (mount.isDefault) {
        identity.append(element(documentRef, "span", {
          className: "agent-default-badge",
          text: "默认"
        }));
      }
      const remove = control(element(documentRef, "button", {
        className: "agent-remove-button",
        text: "×",
        attributes: {
          type: "button",
          "data-remove-agent": mount.agentRef,
          "data-focus-key": `remove:${mount.agentRef}`,
          "aria-label": `移除 ${mount.displayName}`
        }
      }));
      remove.addEventListener("click", () => {
        if (
          busy ||
          !confirmImpl(`从该成员移除 ${mount.displayName}？`)
        ) {
          return;
        }
        const agentRef = mount.agentRef;
        void runMutation({
          action: () => api.unmountAgent(personRef, agentRef),
          applied: (current) =>
            !current.mountedAgents.some((agent) => agent.agentRef === agentRef),
          focusKey: `remove:${agentRef}`,
          pendingMessage: "正在移除 Agent…"
        });
      });
      chip.append(identity, remove);
      chips.append(chip);
    }
    section.append(chips);

    const options = availableAgentOptions(catalog, mounts.mountedAgents);
    const addControl = element(documentRef, "div", {
      className: "agent-add-menu"
    });
    const menuId = `agent-add-${personRef.replace(/[^a-z0-9_-]/giu, "-")}`;
    const addTrigger = control(element(documentRef, "button", {
      className: "agent-add-trigger",
      text: "+",
      attributes: {
        type: "button",
        "data-add-agent-trigger": "",
        "data-focus-key": "add-menu",
        "aria-label": "添加 Agent",
        "aria-haspopup": "menu",
        "aria-controls": menuId,
        "aria-expanded": String(menuOpen)
      }
    }));
    if (options.length === 0) addTrigger.disabled = true;
    addTrigger.addEventListener("click", () => {
      if (busy || options.length === 0) return;
      menuOpen = !menuOpen;
      render(menuOpen ? `add:${options[0].agentRef}` : "add-menu");
    });

    const addMenu = element(documentRef, "div", {
      className: "agent-add-popover",
      attributes: {
        id: menuId,
        role: "menu",
        "data-add-agent-menu": "",
        "aria-label": "可添加 Agent"
      }
    });
    addMenu.hidden = !menuOpen;
    for (const agent of options) {
      const option = control(element(documentRef, "button", {
        className: `agent-add-option agent-status-${agent.status}`,
        text: `${agent.displayName} · ${agent.statusLabel}`,
        attributes: {
          type: "button",
          role: "menuitem",
          "data-mount-agent": agent.agentRef,
          "data-focus-key": `add:${agent.agentRef}`
        }
      }));
      option.addEventListener("click", () => {
        if (busy) return;
        const agentRef = agent.agentRef;
        menuOpen = false;
        void runMutation({
          action: () => api.mountAgent(personRef, agentRef),
          applied: (current) =>
            current.mountedAgents.some((mount) => mount.agentRef === agentRef),
          focusKey: `add:${agentRef}`,
          pendingMessage: "正在添加 Agent…"
        });
      });
      addMenu.append(option);
    }
    addControl.append(addTrigger, addMenu);
    section.append(addControl);

    const defaultRow = element(documentRef, "div", {
      className: "agent-control-row"
    });
    const defaultLabel = element(documentRef, "label", {
      className: "agent-select-label"
    });
    const defaultSelect = control(element(documentRef, "select", {
      attributes: {
        "data-default-agent": "",
        "data-focus-key": "default-select",
        "aria-label": "选择默认 Agent"
      }
    }));
    defaultSelect.append(element(documentRef, "option", {
      text: "不设默认 Agent",
      attributes: { value: "" }
    }));
    for (const mount of mounts.mountedAgents) {
      defaultSelect.append(element(documentRef, "option", {
        text: mount.displayName,
        attributes: { value: mount.agentRef }
      }));
    }
    defaultSelect.value = mounts.defaultAgentRef ?? "";
    defaultLabel.append(
      element(documentRef, "span", { text: "默认 Agent" }),
      defaultSelect
    );
    const saveDefault = control(element(documentRef, "button", {
      className: "secondary-button",
      text: "保存默认",
      attributes: {
        type: "button",
        "data-save-default-agent": "",
        "data-focus-key": "default-save"
      }
    }));
    saveDefault.addEventListener("click", () => {
      if (busy) return;
      const agentRef = defaultSelect.value === "" ? null : defaultSelect.value;
      void runMutation({
        action: () => api.setDefaultAgent(personRef, agentRef),
        applied: (current) => current.defaultAgentRef === agentRef,
        focusKey: "default-save",
        pendingMessage: "正在保存默认 Agent…"
      });
    });
    defaultRow.append(defaultLabel, saveDefault);
    section.append(defaultRow, feedbackNode());
  };

  const render = (preferredFocusKey = null) => {
    const currentFocusKey = root.contains(documentRef.activeElement)
      ? documentRef.activeElement?.getAttribute("data-focus-key")
      : null;
    const section = element(documentRef, "section", {
      className: "member-agent-controls",
      attributes: { "aria-label": "成员 Agent 配置" }
    });
    section.append(element(documentRef, "h4", {
      className: "member-agent-title",
      text: "个人 Agent"
    }));

    if (stateKnown) renderKnown(section);
    else renderUnknown(section);

    section.append(element(documentRef, "p", {
      className: "agent-reuse-note",
      text: REUSE_NOTE
    }));
    root.replaceChildren(section);
    focusByKey(preferredFocusKey ?? currentFocusKey);
  };

  const readSnapshot = async () => {
    const [catalogResult, mountResult] = await Promise.all([
      api.agents(),
      api.memberAgentMounts(personRef)
    ]);
    return {
      catalog: catalogResult.agents,
      mounts: mountResult
    };
  };

  const reloadState = async ({
    pendingText = "正在加载 Agent 配置…",
    pendingFocus = false,
    successFocus = null
  } = {}) => {
    busy = true;
    pendingMessage = pendingText;
    mutationRetry = null;
    menuOpen = false;
    render(pendingFocus ? "pending" : null);
    try {
      const snapshot = await readSnapshot();
      catalog = snapshot.catalog;
      mounts = snapshot.mounts;
      stateKnown = true;
      busy = false;
      pendingMessage = "";

      let resolvedFocus = successFocus;
      if (pendingMutation !== null) {
        const { descriptor, outcome } = pendingMutation;
        if (outcome === "ambiguous" && !descriptor.applied(mounts)) {
          mutationRetry = descriptor;
          resolvedFocus = descriptor.focusKey;
        } else {
          mutationRetry = null;
          resolvedFocus = descriptor.focusKey;
        }
        pendingMutation = null;
      }
      render(resolvedFocus);
      return true;
    } catch {
      stateKnown = false;
      catalog = [];
      mounts = null;
      busy = false;
      pendingMessage = "";
      mutationRetry = null;
      menuOpen = false;
      render("refresh-retry");
      return false;
    }
  };

  const runMutation = async (descriptor) => {
    if (busy || !stateKnown) return;
    busy = true;
    pendingMessage = descriptor.pendingMessage;
    mutationRetry = null;
    menuOpen = false;
    render("pending");

    let outcome;
    try {
      await descriptor.action();
      outcome = "success";
    } catch {
      outcome = "ambiguous";
    }
    pendingMutation = { descriptor, outcome };
    await reloadState({
      pendingText: outcome === "success"
        ? "正在刷新 Agent 配置…"
        : "正在确认 Agent 配置结果…",
      pendingFocus: true,
      successFocus: descriptor.focusKey
    });
  };

  return Object.freeze({
    ready: reloadState(),
    refresh: () => reloadState({
      pendingText: "正在重新加载 Agent 配置…",
      pendingFocus: true,
      successFocus: "add-menu"
    })
  });
}
