const SAFE_ERROR_TEXT = "暂时无法完成 Agent 配置，请稍后重试。";
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
  let catalog = [];
  let mounts = {
    personRef,
    defaultAgentRef: null,
    mountedAgents: []
  };
  let busy = false;
  let pendingMessage = "";
  let failedAction = null;

  const setControlState = (node) => {
    node.disabled = busy;
    return node;
  };

  const render = () => {
    const section = element(documentRef, "section", {
      className: "member-agent-controls",
      attributes: { "aria-label": "成员 Agent 配置" }
    });
    section.append(element(documentRef, "h4", {
      className: "member-agent-title",
      text: "个人 Agent"
    }));

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
      const remove = setControlState(element(documentRef, "button", {
        className: "agent-remove-button",
        text: "×",
        attributes: {
          type: "button",
          "data-remove-agent": mount.agentRef,
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
        void mutate(
          () => api.unmountAgent(personRef, mount.agentRef),
          "正在移除 Agent…"
        );
      });
      chip.append(identity, remove);
      chips.append(chip);
    }
    section.append(chips);

    const addRow = element(documentRef, "div", {
      className: "agent-control-row"
    });
    const addLabel = element(documentRef, "label", {
      className: "agent-select-label"
    });
    const addSelect = setControlState(element(documentRef, "select", {
      attributes: {
        "data-add-agent": "",
        "aria-label": "选择要添加的 Agent"
      }
    }));
    addSelect.append(element(documentRef, "option", {
      text: "选择 Agent",
      attributes: { value: "" }
    }));
    const options = availableAgentOptions(catalog, mounts.mountedAgents);
    for (const agent of options) {
      addSelect.append(element(documentRef, "option", {
        text: `${agent.displayName} · ${agent.statusLabel}`,
        attributes: {
          value: agent.agentRef,
          "data-agent-ref": agent.agentRef
        }
      }));
    }
    addSelect.value = "";
    if (options.length === 0) addSelect.disabled = true;
    addLabel.append(
      element(documentRef, "span", { text: "添加 Agent" }),
      addSelect
    );
    const add = setControlState(element(documentRef, "button", {
      className: "secondary-button agent-add-button",
      text: "+ Agent",
      attributes: {
        type: "button",
        "data-add-agent-submit": ""
      }
    }));
    if (options.length === 0) add.disabled = true;
    add.addEventListener("click", () => {
      if (busy || addSelect.value === "") return;
      const agentRef = addSelect.value;
      void mutate(
        () => api.mountAgent(personRef, agentRef),
        "正在添加 Agent…"
      );
    });
    addRow.append(addLabel, add);
    section.append(addRow);

    const defaultRow = element(documentRef, "div", {
      className: "agent-control-row"
    });
    const defaultLabel = element(documentRef, "label", {
      className: "agent-select-label"
    });
    const defaultSelect = setControlState(element(documentRef, "select", {
      attributes: {
        "data-default-agent": "",
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
    const saveDefault = setControlState(element(documentRef, "button", {
      className: "secondary-button",
      text: "保存默认",
      attributes: {
        type: "button",
        "data-save-default-agent": ""
      }
    }));
    saveDefault.addEventListener("click", () => {
      if (busy) return;
      void mutate(
        () => api.setDefaultAgent(
          personRef,
          defaultSelect.value === "" ? null : defaultSelect.value
        ),
        "正在保存默认 Agent…"
      );
    });
    defaultRow.append(defaultLabel, saveDefault);
    section.append(defaultRow);

    section.append(element(documentRef, "p", {
      className: "agent-reuse-note",
      text: REUSE_NOTE
    }));

    const feedback = element(documentRef, "div", {
      className: "agent-feedback",
      attributes: {
        role: "status",
        "aria-live": "polite"
      }
    });
    if (busy) {
      feedback.append(element(documentRef, "span", {
        text: pendingMessage
      }));
    } else if (failedAction !== null) {
      feedback.append(
        element(documentRef, "span", { text: SAFE_ERROR_TEXT }),
        element(documentRef, "button", {
          className: "text-button",
          text: "重试",
          attributes: {
            type: "button",
            "data-agent-retry": ""
          }
        })
      );
      feedback.children[1].addEventListener("click", () => {
        if (busy || failedAction === null) return;
        const retry = failedAction;
        void mutate(retry.action, retry.pendingMessage);
      });
    }
    section.append(feedback);
    root.replaceChildren(section);
  };

  const refreshServerState = async () => {
    const [catalogResult, mountResult] = await Promise.all([
      api.agents(),
      api.memberAgentMounts(personRef)
    ]);
    catalog = catalogResult.agents;
    mounts = mountResult;
  };

  const mutate = async (action, message) => {
    if (busy) return;
    busy = true;
    pendingMessage = message;
    failedAction = null;
    render();
    try {
      await action();
      await refreshServerState();
      busy = false;
      pendingMessage = "";
      render();
    } catch {
      busy = false;
      pendingMessage = "";
      failedAction = { action, pendingMessage: message };
      render();
    }
  };

  const load = async () => {
    busy = true;
    pendingMessage = "正在加载 Agent 配置…";
    render();
    try {
      await refreshServerState();
      busy = false;
      pendingMessage = "";
      failedAction = null;
      render();
    } catch {
      busy = false;
      pendingMessage = "";
      failedAction = { action: load, pendingMessage: "正在加载 Agent 配置…" };
      render();
    }
  };

  return Object.freeze({
    ready: load(),
    refresh: load
  });
}
