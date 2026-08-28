const SAFE_ERROR_TEXT = "暂时无法完成 Agent 配置，请稍后重试。";
const UNAVAILABLE_TEXT = "无法确认当前 Agent 配置。请重新加载后再操作。";
const REUSE_NOTE =
  "同一个 Agent 可以提供给多个成员；如果它连接的是同一个 Hermes Profile，Hermes 内部记忆也可能共享。";
const APPROVED_AGENTS = Object.freeze([
  Object.freeze({ agentRef: "agent:hermes-jarvis", displayName: "Jarvis", system: true }),
  Object.freeze({ agentRef: "agent:hermes-zzh", displayName: "于途", system: false }),
  Object.freeze({ agentRef: "agent:hermes-nsy", displayName: "乔晶晶", system: false })
]);
const PERSONAL_AGENT_REFS = new Set([
  "agent:hermes-zzh",
  "agent:hermes-nsy"
]);

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
  return catalog.filter((agent) =>
    PERSONAL_AGENT_REFS.has(agent.agentRef) && !mounted.has(agent.agentRef)
  );
}

function approvedCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length !== APPROVED_AGENTS.length) {
    throw new Error("ADMIN_AGENT_CATALOG_UNAVAILABLE");
  }
  const byRef = new Map();
  for (const agent of catalog) {
    const approved = APPROVED_AGENTS.find(
      (candidate) => candidate.agentRef === agent?.agentRef
    );
    if (
      approved === undefined ||
      byRef.has(agent.agentRef) ||
      agent.displayName !== approved.displayName ||
      agent.system !== approved.system ||
      !["available", "unavailable"].includes(agent.runtime) ||
      agent.runtimeLabel !== (agent.runtime === "available" ? "可用" : "不可用")
    ) {
      throw new Error("ADMIN_AGENT_CATALOG_UNAVAILABLE");
    }
    byRef.set(agent.agentRef, {
      agentRef: approved.agentRef,
      displayName: approved.displayName,
      system: approved.system,
      runtime: agent.runtime,
      runtimeLabel: agent.runtimeLabel
    });
  }
  return APPROVED_AGENTS.map((approved) => {
    const agent = byRef.get(approved.agentRef);
    if (agent === undefined) throw new Error("ADMIN_AGENT_CATALOG_UNAVAILABLE");
    return agent;
  });
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
  let successMessage = "";
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
      let hidden = false;
      for (let current = target; current !== null; current = current.parentElement) {
        if (current.hidden) {
          hidden = true;
          break;
        }
        if (current === root) break;
      }
      if (target !== null && !target.disabled && !hidden) {
        target.focus();
        if (documentRef.activeElement === target) return;
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
        role: mutationRetry === null ? "status" : "alert",
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
    } else if (successMessage !== "") {
      feedback.append(element(documentRef, "span", { text: successMessage }));
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
    const personalMounts = mounts.mountedAgents.filter((mount) =>
      PERSONAL_AGENT_REFS.has(mount.agentRef)
    );
    const mountsByRef = new Map(
      personalMounts.map((mount) => [mount.agentRef, mount])
    );
    const cards = element(documentRef, "div", {
      className: "agent-card-list",
      attributes: { "aria-label": "可用 Agent" }
    });
    for (const agent of catalog) {
      const mount = mountsByRef.get(agent.agentRef);
      const card = element(documentRef, "article", {
        className: `agent-card agent-runtime-${agent.runtime}`,
        attributes: { "data-agent-card": agent.agentRef }
      });
      const heading = element(documentRef, "div", {
        className: "agent-card-heading"
      });
      heading.append(
        element(documentRef, "h5", { text: agent.displayName }),
        element(documentRef, "span", {
          className: "agent-card-kind",
          text: agent.system ? "系统 Agent" : "可分配"
        })
      );
      card.append(
        heading,
        element(documentRef, "p", {
          className: "agent-card-state",
          text: `运行状态：${agent.runtimeLabel}`
        })
      );
      if (agent.system) {
        card.append(element(documentRef, "p", {
          className: "agent-card-allocation",
          text: "成员分配：由家庭管理系统统一提供。"
        }));
      } else {
        const assigned = mount !== undefined;
        const allocation = element(documentRef, "div", {
          className: "agent-card-allocation"
        });
        allocation.append(element(documentRef, "span", {
          text: `成员分配：${assigned ? "已分配" : "未分配"}`
        }));
        if (mount?.isDefault) {
          allocation.append(element(documentRef, "span", {
            className: "agent-default-badge",
            text: "默认"
          }));
        }
        if (assigned) {
          const remove = control(element(documentRef, "button", {
            className: "agent-remove-button",
            text: "移除",
            attributes: {
              type: "button",
              "data-remove-agent": agent.agentRef,
              "data-focus-key": `remove:${agent.agentRef}`,
              "aria-label": `从成员移除 ${agent.displayName}`
            }
          }));
          remove.addEventListener("click", () => {
            if (busy || !confirmImpl(`从该成员移除 ${agent.displayName}？`)) return;
            const agentRef = agent.agentRef;
            void runMutation({
              action: () => api.unmountAgent(personRef, agentRef),
              applied: (current) =>
                !current.mountedAgents.some((currentMount) =>
                  currentMount.agentRef === agentRef
                ),
              focusKey: `remove:${agentRef}`,
              pendingMessage: "正在移除 Agent…"
            });
          });
          allocation.append(remove);
        }
        card.append(allocation);
      }
      cards.append(card);
    }
    section.append(cards);

    const options = availableAgentOptions(catalog, personalMounts);
    const addControl = element(documentRef, "div", {
      className: "agent-add-menu"
    });
    const menuId = `agent-add-${personRef.replace(/[^a-z0-9_-]/giu, "-")}`;
    const closeAddPopover = (event) => {
      if (event.key !== "Escape" || !menuOpen) return;
      event.preventDefault();
      menuOpen = false;
      render("add-menu");
    };
    const addTrigger = control(element(documentRef, "button", {
      className: "agent-add-trigger",
      text: "+",
      attributes: {
        type: "button",
        "data-add-agent-trigger": "",
        "data-focus-key": "add-menu",
        "aria-label": "添加 Agent",
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
    addTrigger.addEventListener("keydown", closeAddPopover);

    const addMenu = element(documentRef, "div", {
      className: "agent-add-popover",
      attributes: {
        id: menuId,
        "data-add-agent-menu": "",
        "aria-label": "可添加 Agent"
      }
    });
    addMenu.hidden = !menuOpen;
    for (const agent of options) {
      const option = control(element(documentRef, "button", {
        className: `agent-add-option agent-runtime-${agent.runtime}`,
        text: `${agent.displayName} · ${agent.runtimeLabel}`,
        attributes: {
          type: "button",
          "data-mount-agent": agent.agentRef,
          "data-focus-key": `add:${agent.agentRef}`
        }
      }));
      if (agent.runtime !== "available") option.disabled = true;
      option.addEventListener("keydown", closeAddPopover);
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
    for (const mount of personalMounts) {
      const agent = catalog.find((candidate) => candidate.agentRef === mount.agentRef);
      if (agent === undefined) continue;
      defaultSelect.append(element(documentRef, "option", {
        text: agent.displayName,
        attributes: { value: mount.agentRef }
      }));
    }
    defaultSelect.value = personalMounts.some(
      (mount) => mount.agentRef === mounts.defaultAgentRef
    ) ? mounts.defaultAgentRef : "";
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
      catalog: approvedCatalog(catalogResult.agents),
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
          successMessage = "";
          resolvedFocus = "mutation-retry";
        } else {
          mutationRetry = null;
          successMessage = "Agent 配置已更新。";
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
      successMessage = "";
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
    successMessage = "";
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
    refresh: () => {
      successMessage = "";
      return reloadState({
        pendingText: "正在重新加载 Agent 配置…",
        pendingFocus: true,
        successFocus: "add-menu"
      });
    }
  });
}
