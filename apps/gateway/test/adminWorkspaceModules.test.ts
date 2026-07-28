import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const adminPublic = fileURLToPath(new URL("../admin-public/", import.meta.url));
const workspaceModuleUrl =
  pathToFileURL(join(adminPublic, "admin-workspace.js")).href;
const apiModuleUrl = pathToFileURL(join(adminPublic, "admin-api.js")).href;
const token = `${"A".repeat(42)}A`;

async function workspaceModule() {
  return import(`${workspaceModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

async function apiModule() {
  return import(`${apiModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

class TestClassList {
  readonly values = new Set<string>();

  add(...names: string[]) {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.values.delete(name);
  }

  contains(name: string) {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean) {
    const next = force === undefined ? !this.values.has(name) : force;
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }

  toString() {
    return [...this.values].join(" ");
  }
}

class TestElement extends EventTarget {
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = new TestClassList();
  parentElement: TestElement | null = null;
  value = "";
  disabled = false;
  hidden = false;
  private text = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: TestDocument
  ) {
    super();
  }

  get className() {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.values.clear();
    for (const name of String(value).split(/\s+/u).filter(Boolean)) {
      this.classList.add(name);
    }
  }

  get textContent() {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this.text;
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.text = String(value ?? "");
  }

  append(...nodes: TestElement[]) {
    for (const node of nodes) {
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: TestElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.children.splice(0);
    this.text = "";
    this.append(...nodes);
  }

  removeChild(node: TestElement) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "value") this.value = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name: string) {
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const attributeSelector = selector.match(
      /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/u
    );
    const classSelector = selector.match(/^\.([a-z0-9-]+)$/u);
    const matches = (node: TestElement) => {
      if (attributeSelector !== null) {
        return attributeSelector[2] === undefined
          ? node.attributes.has(attributeSelector[1]!)
          : node.attributes.get(attributeSelector[1]!) === attributeSelector[2];
      }
      if (classSelector !== null) return node.classList.contains(classSelector[1]!);
      return node.tagName === selector.toLowerCase();
    };
    const result: TestElement[] = [];
    const visit = (node: TestElement) => {
      for (const child of node.children) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  click() {
    if (!this.disabled) {
      this.dispatchEvent(new Event("click", { cancelable: true }));
    }
  }

  input(value: string) {
    this.value = value;
    this.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

class TestDocument {
  createElement(tagName: string) {
    return new TestElement(tagName.toLowerCase(), this);
  }
}

const statuses = {
  protocolVersion: 1,
  agents: [
    {
      agentRef: "agent:hermes-jarvis",
      displayName: "Jarvis",
      status: "idle",
      statusLabel: "空闲",
      activeTurnCount: 0,
      lastCheckedAt: "2026-07-28T10:00:00.000Z",
      publicProblem: null
    },
    {
      agentRef: "agent:codex-cli",
      displayName: "Codex",
      status: "working",
      statusLabel: "工作中",
      activeTurnCount: 2,
      lastCheckedAt: "2026-07-28T10:00:01.000Z",
      publicProblem: null
    },
    {
      agentRef: "agent:offline",
      displayName: "离线助手",
      status: "problem",
      statusLabel: "有问题",
      activeTurnCount: 0,
      lastCheckedAt: "2026-07-28T10:00:02.000Z",
      publicProblem: "Agent 当前无法连接。"
    }
  ]
};

const summary = {
  protocolVersion: 1,
  agents: [
    { agentRef: "agent:hermes-jarvis", displayName: "Jarvis" },
    { agentRef: "agent:codex-cli", displayName: "Codex" }
  ]
};

function chat(agentRef: string, threadRef: string) {
  return {
    protocolVersion: 1,
    chat: { agentRef, threadRef, threadKind: "home_chat" }
  };
}

function work(agentRef: string, suffix: string) {
  return {
    agentRef,
    threadRef: `thread:${suffix}`,
    threadKind: "work",
    workConversationRef: `work:${suffix}`,
    title: `${suffix} Work`,
    status: "active"
  };
}

function messages(threadRef: string, text = "历史消息") {
  return {
    protocolVersion: 1,
    threadRef,
    messages: [{
      messageRef: `message:${threadRef.slice(7)}`,
      threadRef,
      threadSequence: 1,
      content: { type: "text", text }
    }]
  };
}

function workspaceApi() {
  const chats = new Map([
    ["agent:hermes-jarvis", chat("agent:hermes-jarvis", "thread:jarvis-chat")],
    ["agent:codex-cli", chat("agent:codex-cli", "thread:codex-chat")]
  ]);
  const works = new Map([
    ["agent:hermes-jarvis", work("agent:hermes-jarvis", "jarvis-work")],
    ["agent:codex-cli", work("agent:codex-cli", "codex-work")]
  ]);
  return {
    agents: vi.fn(async () => statuses),
    systemWorkspace: vi.fn(async () => summary),
    systemAgentChat: vi.fn(async (agentRef: string) => chats.get(agentRef)),
    systemAgentWorkConversations: vi.fn(async (agentRef: string) => ({
      protocolVersion: 1,
      conversations: [works.get(agentRef)]
    })),
    createSystemAgentWork: vi.fn(),
    systemThreadMessages: vi.fn(async (threadRef: string) => messages(threadRef)),
    sendSystemThreadMessage: vi.fn(async (threadRef: string, text: string) => ({
      protocolVersion: 1,
      message: {
        messageRef: "message:new",
        threadRef,
        threadSequence: 2,
        content: { type: "text", text }
      }
    })),
    systemWorkProgress: vi.fn(async (workRef: string) => ({
      protocolVersion: 1,
      snapshot: {
        workConversationRef: workRef,
        status: "active",
        phaseSummary: "正在执行",
        incompleteTasks: [],
        risks: [],
        pendingConfirmations: [],
        deadlines: [],
        updatedAt: "2026-07-28T10:00:03.000Z"
      }
    }))
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Admin sticky Agent monitor", () => {
  it("starts as one compact row, exposes public detail only, polls every five seconds, and destroys its interval", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const intervalCallback = vi.fn();
    const setIntervalImpl = vi.fn((callback: () => void, delay: number) => {
      intervalCallback.mockImplementation(callback);
      return 71;
    });
    const clearIntervalImpl = vi.fn();

    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl,
      clearIntervalImpl
    });
    await controller.ready;

    const monitor = root.querySelector("[data-agent-monitor]");
    expect(root.children[0]).toBe(monitor);
    expect(monitor?.classList.contains("compact")).toBe(true);
    expect(monitor?.textContent).toContain("空闲");
    expect(monitor?.textContent).toContain("工作中");
    expect(monitor?.textContent).toContain("有问题");
    expect(monitor?.textContent).not.toContain("Agent 当前无法连接。");
    expect(root.querySelectorAll("[data-agent-status-dot]")).toHaveLength(3);
    expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 5000);

    root.querySelector("[data-monitor-toggle]")?.click();
    expect(monitor?.classList.contains("compact")).toBe(false);
    expect(monitor?.textContent).toContain("2 个进行中");
    expect(monitor?.textContent).toContain("2026-07-28T10:00:01.000Z");
    expect(monitor?.textContent).toContain("Agent 当前无法连接。");
    expect(monitor?.textContent).not.toContain("provider-profile");
    expect(monitor?.textContent).not.toContain("Session");

    await intervalCallback();
    expect(api.agents).toHaveBeenCalledTimes(2);
    controller.destroy();
    expect(clearIntervalImpl).toHaveBeenCalledWith(71);

    const second = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 72,
      clearIntervalImpl
    });
    await second.ready;
    expect(root.querySelectorAll("[data-agent-pane]")).toHaveLength(2);
    second.destroy();
  });
});

describe("Admin Jarvis/Codex workspace panes", () => {
  it("keeps fixed pane order and independent Chat/Work thread, messages, draft, busy, and error state", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 72,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const paneNodes = root.querySelectorAll("[data-agent-pane]");
    expect(paneNodes).toHaveLength(2);
    expect(paneNodes.map((pane) => pane.getAttribute("data-agent-pane")))
      .toEqual(["agent:hermes-jarvis", "agent:codex-cli"]);

    const jarvisState = controller.panes.get("agent:hermes-jarvis");
    const codexState = controller.panes.get("agent:codex-cli");
    expect(jarvisState.chat.threadRef).toBe("thread:jarvis-chat");
    expect(codexState.chat.threadRef).toBe("thread:codex-chat");
    expect(jarvisState.chat.threadRef).not.toBe(codexState.chat.threadRef);
    expect(jarvisState.work.threadRef).toBe("thread:jarvis-work");
    expect(codexState.work.threadRef).toBe("thread:codex-work");
    expect(jarvisState).not.toHaveProperty("activeThreadRef");
    expect(codexState).not.toHaveProperty("activeThreadRef");

    paneNodes[0]?.querySelector('[data-pane-mode="work"]')?.click();
    expect(jarvisState.mode).toBe("work");
    expect(codexState.mode).toBe("chat");
    expect(codexState.chat.threadRef).toBe("thread:codex-chat");
    expect(paneNodes[0]?.textContent).toContain("正在执行");

    const jarvisDraft = paneNodes[0]?.querySelector("[data-pane-draft]");
    const codexDraft = paneNodes[1]?.querySelector("[data-pane-draft]");
    jarvisDraft?.input("给 Jarvis 的任务");
    codexDraft?.input("给 Codex 的消息");
    expect(jarvisState.work.draft).toBe("给 Jarvis 的任务");
    expect(codexState.chat.draft).toBe("给 Codex 的消息");

    paneNodes[1]?.querySelector("[data-pane-send]")?.click();
    await flush();
    expect(api.sendSystemThreadMessage).toHaveBeenCalledTimes(1);
    expect(api.sendSystemThreadMessage).toHaveBeenCalledWith(
      "thread:codex-chat",
      "给 Codex 的消息"
    );
    expect(jarvisState.work.draft).toBe("给 Jarvis 的任务");
    expect(codexState.chat.draft).toBe("");
    expect(jarvisState.busy).toBe(false);
    expect(codexState.busy).toBe(false);
    expect(jarvisState.error).toBeNull();
    expect(codexState.error).toBeNull();
  });

  it("reloads authoritative messages after send so the Agent reply appears only in the captured pane and channel", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const reads = new Map<string, number>();
    api.systemThreadMessages.mockImplementation(async (threadRef: string) => {
      const count = (reads.get(threadRef) ?? 0) + 1;
      reads.set(threadRef, count);
      if (threadRef === "thread:codex-chat" && count === 2) {
        return {
          protocolVersion: 1,
          threadRef,
          messages: [
            {
              messageRef: "message:codex-history",
              threadRef,
              threadSequence: 1,
              content: { type: "text", text: "Codex 历史消息" }
            },
            {
              messageRef: "message:codex-user",
              threadRef,
              threadSequence: 2,
              content: { type: "text", text: "请修复入口" }
            },
            {
              messageRef: "message:codex-agent",
              threadRef,
              threadSequence: 3,
              content: { type: "text", text: "Codex Agent 回复" }
            }
          ]
        };
      }
      return messages(threadRef);
    });
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 81,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const [jarvisPane, codexPane] = root.querySelectorAll("[data-agent-pane]");
    codexPane?.querySelector("[data-pane-draft]")?.input("请修复入口");
    codexPane?.querySelector("[data-pane-send]")?.click();
    await flush();
    await flush();

    expect(api.sendSystemThreadMessage).toHaveBeenCalledWith(
      "thread:codex-chat",
      "请修复入口"
    );
    expect(reads.get("thread:codex-chat")).toBe(2);
    expect(codexPane?.textContent).toContain("Codex Agent 回复");
    expect(jarvisPane?.textContent).not.toContain("Codex Agent 回复");
    expect(controller.panes.get("agent:codex-cli").chat.messages)
      .toHaveLength(3);
    expect(controller.panes.get("agent:hermes-jarvis").chat.messages)
      .toHaveLength(1);
    controller.destroy();
  });

  it("drops a late Chat send result after that pane switches to Work without affecting the other Agent", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const pendingSend = deferred<{
      protocolVersion: number;
      message: {
        messageRef: string;
        threadRef: string;
        threadSequence: number;
        content: { type: string; text: string };
      };
    }>();
    api.sendSystemThreadMessage.mockImplementationOnce(
      async () => pendingSend.promise
    );
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 82,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const [jarvisPane, codexPane] = root.querySelectorAll("[data-agent-pane]");
    const detachedWorkSwitch =
      codexPane?.querySelector('[data-pane-mode="work"]');
    codexPane?.querySelector("[data-pane-draft]")?.input("迟到的 Chat");
    codexPane?.querySelector("[data-pane-send]")?.click();
    detachedWorkSwitch?.click();
    expect(controller.panes.get("agent:codex-cli").mode).toBe("work");

    pendingSend.resolve({
      protocolVersion: 1,
      message: {
        messageRef: "message:late-user",
        threadRef: "thread:codex-chat",
        threadSequence: 2,
        content: { type: "text", text: "迟到的 Chat" }
      }
    });
    await flush();
    await flush();

    const codex = controller.panes.get("agent:codex-cli");
    const jarvis = controller.panes.get("agent:hermes-jarvis");
    expect(codex.mode).toBe("work");
    expect(codex.chat.messages).toHaveLength(1);
    expect(codex.chat.draft).toBe("迟到的 Chat");
    expect(codex.work.messages).toHaveLength(1);
    expect(jarvis.chat.messages).toHaveLength(1);
    expect(jarvisPane?.textContent).not.toContain("迟到的 Chat");
    expect(
      api.systemThreadMessages.mock.calls
        .filter(([threadRef]) => threadRef === "thread:codex-chat")
    ).toHaveLength(1);
    controller.destroy();
  });

  it("drops a late authoritative GET after the captured pane switches channel", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const latePage = deferred<ReturnType<typeof messages>>();
    const reads = new Map<string, number>();
    api.systemThreadMessages.mockImplementation(async (threadRef: string) => {
      const count = (reads.get(threadRef) ?? 0) + 1;
      reads.set(threadRef, count);
      if (threadRef === "thread:codex-chat" && count === 2) {
        return latePage.promise;
      }
      return messages(threadRef);
    });
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 83,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const codexPane = root.querySelectorAll("[data-agent-pane]")[1];
    const detachedWorkSwitch =
      codexPane?.querySelector('[data-pane-mode="work"]');
    codexPane?.querySelector("[data-pane-draft]")?.input("等待重拉");
    codexPane?.querySelector("[data-pane-send]")?.click();
    await flush();
    expect(reads.get("thread:codex-chat")).toBe(2);
    detachedWorkSwitch?.click();
    latePage.resolve({
      protocolVersion: 1,
      threadRef: "thread:codex-chat",
      messages: [{
        messageRef: "message:late-get-agent",
        threadRef: "thread:codex-chat",
        threadSequence: 3,
        content: { type: "text", text: "不应写入的迟到回复" }
      }]
    });
    await flush();
    await flush();

    const codex = controller.panes.get("agent:codex-cli");
    expect(codex.mode).toBe("work");
    expect(codex.chat.messages).toHaveLength(1);
    expect(codex.chat.draft).toBe("等待重拉");
    expect(codex.work.messages).toHaveLength(1);
    expect(codexPane?.textContent).not.toContain("不应写入的迟到回复");
    controller.destroy();
  });

  it("refreshes only the captured Jarvis Work messages and progress after send", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const messageReads = new Map<string, number>();
    const progressReads = new Map<string, number>();
    api.systemThreadMessages.mockImplementation(async (threadRef: string) => {
      const count = (messageReads.get(threadRef) ?? 0) + 1;
      messageReads.set(threadRef, count);
      if (threadRef === "thread:jarvis-work" && count === 2) {
        return {
          protocolVersion: 1,
          threadRef,
          messages: [{
            messageRef: "message:jarvis-work-agent",
            threadRef,
            threadSequence: 3,
            content: { type: "text", text: "Jarvis Work 回复" }
          }]
        };
      }
      return messages(threadRef);
    });
    api.systemWorkProgress.mockImplementation(async (workRef: string) => {
      const count = (progressReads.get(workRef) ?? 0) + 1;
      progressReads.set(workRef, count);
      return {
        protocolVersion: 1,
        snapshot: {
          workConversationRef: workRef,
          status: "active",
          phaseSummary: count === 1 ? "正在执行" : "回复后进度",
          incompleteTasks: [],
          risks: [],
          pendingConfirmations: [],
          deadlines: [],
          updatedAt: "2026-07-28T10:00:03.000Z"
        }
      };
    });
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 84,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const [jarvisPane, codexPane] = root.querySelectorAll("[data-agent-pane]");
    jarvisPane?.querySelector('[data-pane-mode="work"]')?.click();
    jarvisPane?.querySelector("[data-pane-draft]")?.input("更新 Work");
    jarvisPane?.querySelector("[data-pane-send]")?.click();
    await flush();
    await flush();

    expect(messageReads.get("thread:jarvis-work")).toBe(2);
    expect(progressReads.get("work:jarvis-work")).toBe(2);
    expect(jarvisPane?.textContent).toContain("Jarvis Work 回复");
    expect(jarvisPane?.textContent).toContain("回复后进度");
    expect(codexPane?.textContent).not.toContain("Jarvis Work 回复");
    expect(controller.panes.get("agent:codex-cli").chat.messages)
      .toHaveLength(1);
    controller.destroy();
  });

  it("drops late Work selection reads after the pane changes mode", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const lateMessages = deferred<ReturnType<typeof messages>>();
    api.systemAgentWorkConversations.mockImplementation(
      async (agentRef: string) => ({
        protocolVersion: 1,
        conversations: agentRef === "agent:hermes-jarvis"
          ? [
              work(agentRef, "jarvis-work"),
              work(agentRef, "jarvis-second")
            ]
          : [work(agentRef, "codex-work")]
      })
    );
    api.systemThreadMessages.mockImplementation(async (threadRef: string) => {
      if (threadRef === "thread:jarvis-second") return lateMessages.promise;
      return messages(threadRef);
    });
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 85,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const [jarvisPane] = root.querySelectorAll("[data-agent-pane]");
    jarvisPane?.querySelector('[data-pane-mode="work"]')?.click();
    const detachedChatSwitch =
      jarvisPane?.querySelector('[data-pane-mode="chat"]');
    const secondWork = jarvisPane?.querySelectorAll("[data-work-ref]")[1];
    const jarvis = controller.panes.get("agent:hermes-jarvis");
    const previousMessages = jarvis.work.messages;
    const previousProgress = jarvis.work.progress;
    secondWork?.click();
    detachedChatSwitch?.click();
    expect(jarvis.mode).toBe("chat");

    lateMessages.resolve({
      protocolVersion: 1,
      threadRef: "thread:jarvis-second",
      messages: [{
        messageRef: "message:late-selection",
        threadRef: "thread:jarvis-second",
        threadSequence: 1,
        content: { type: "text", text: "迟到的 Work 选择" }
      }]
    });
    await flush();
    await flush();

    expect(jarvis.mode).toBe("chat");
    expect(jarvis.work.messages).toBe(previousMessages);
    expect(jarvis.work.progress).toBe(previousProgress);
    expect(jarvisPane?.textContent).not.toContain("迟到的 Work 选择");
    expect(controller.panes.get("agent:codex-cli").work.messages)
      .toHaveLength(1);
    controller.destroy();
  });

  it("drops a late create-Work POST after the pane changes mode", async () => {
    const { createAdminWorkspace } = await workspaceModule();
    const documentRef = new TestDocument();
    const root = documentRef.createElement("section");
    const api = workspaceApi();
    const pendingCreate = deferred<{
      protocolVersion: number;
      conversation: ReturnType<typeof work>;
    }>();
    api.createSystemAgentWork.mockImplementationOnce(
      async () => pendingCreate.promise
    );
    const controller = createAdminWorkspace({
      root,
      api,
      documentRef,
      setIntervalImpl: () => 86,
      clearIntervalImpl: vi.fn()
    });
    await controller.ready;

    const [jarvisPane] = root.querySelectorAll("[data-agent-pane]");
    jarvisPane?.querySelector('[data-pane-mode="work"]')?.click();
    const detachedChatSwitch =
      jarvisPane?.querySelector('[data-pane-mode="chat"]');
    const createForm = jarvisPane?.querySelector("[data-create-work]");
    const [title, goal] = createForm?.querySelectorAll("input") ?? [];
    if (title) title.value = "新 Work";
    if (goal) goal.value = "不应被迟到响应写入";
    createForm?.dispatchEvent(new Event("submit", { cancelable: true }));
    detachedChatSwitch?.click();

    pendingCreate.resolve({
      protocolVersion: 1,
      conversation: work("agent:hermes-jarvis", "late-created")
    });
    await flush();
    await flush();

    const jarvis = controller.panes.get("agent:hermes-jarvis");
    expect(jarvis.mode).toBe("chat");
    expect(
      jarvis.work.conversations
        .map((conversation: { workConversationRef: string }) =>
          conversation.workConversationRef)
    ).not.toContain("work:late-created");
    expect(jarvis.work.workConversationRef).toBe("work:jarvis-work");
    expect(jarvis.work.threadRef).toBe("thread:jarvis-work");
    expect(jarvis.work.messages).toHaveLength(1);
    controller.destroy();
  });
});

describe("Admin system workspace API client", () => {
  it("uses only the frozen Task 10 routes and never sends Person, Family, Provider, or Provider Session refs", async () => {
    const { createAdminApi } = await apiModule();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/v1/admin/system-workspace") return Response.json(summary);
      if (url.endsWith("/chat")) {
        return Response.json(chat("agent:hermes-jarvis", "thread:jarvis-chat"));
      }
      if (url.endsWith("/work-conversations") && init.method === "POST") {
        return Response.json({
          protocolVersion: 1,
          conversation: work("agent:hermes-jarvis", "new-work")
        }, { status: 201 });
      }
      if (url.endsWith("/work-conversations")) {
        return Response.json({
          protocolVersion: 1,
          conversations: [work("agent:hermes-jarvis", "jarvis-work")]
        });
      }
      if (url.endsWith("/messages") && init.method === "POST") {
        return Response.json({
          protocolVersion: 1,
          message: messages("thread:jarvis-chat").messages[0]
        }, { status: 201 });
      }
      if (url.endsWith("/messages")) {
        return Response.json(messages("thread:jarvis-chat"));
      }
      if (url.endsWith("/progress")) {
        return Response.json({
          protocolVersion: 1,
          snapshot: {
            workConversationRef: "work:jarvis-work",
            status: "active",
            phaseSummary: "进行中",
            incompleteTasks: [],
            risks: [],
            pendingConfirmations: [],
            deadlines: [],
            updatedAt: "2026-07-28T11:00:00.000Z"
          }
        });
      }
      return Response.json({ code: "UNEXPECTED" }, { status: 500 });
    });
    const api = createAdminApi({
      fetchImpl,
      uuid: () => "00000000-0000-4000-8000-000000000011",
      now: () => new Date("2026-07-28T11:00:00.000Z"),
      credential: {
        kind: "entry",
        entrySessionRef: "entry-session:preview-admin",
        token
      }
    });

    await api.systemWorkspace();
    await api.systemAgentChat("agent:hermes-jarvis");
    await api.systemAgentWorkConversations("agent:hermes-jarvis");
    await api.createSystemAgentWork("agent:hermes-jarvis", {
      title: "修复入口",
      goal: "完成安全修复"
    });
    await api.systemThreadMessages("thread:jarvis-chat");
    expect(
      await api.sendSystemThreadMessage("thread:jarvis-chat", "继续")
    ).toEqual({
      protocolVersion: 1,
      message: messages("thread:jarvis-chat").messages[0]
    });
    await api.systemWorkProgress("work:jarvis-work");

    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
      ["/api/v1/admin/system-workspace", "GET"],
      ["/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/chat", "GET"],
      ["/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations", "GET"],
      ["/api/v1/admin/system-workspace/agents/agent%3Ahermes-jarvis/work-conversations", "POST"],
      ["/api/v1/admin/system-workspace/threads/thread%3Ajarvis-chat/messages", "GET"],
      ["/api/v1/admin/system-workspace/threads/thread%3Ajarvis-chat/messages", "POST"],
      ["/api/v1/admin/system-workspace/work-conversations/work%3Ajarvis-work/progress", "GET"]
    ]);
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({
      protocolVersion: 1,
      title: "修复入口",
      goal: "完成安全修复"
    });
    expect(JSON.parse(String(requests[5]?.init.body))).toEqual({
      protocolVersion: 1,
      clientMessageId: "admin-web:00000000-0000-4000-8000-000000000011",
      occurredAt: "2026-07-28T11:00:00.000Z",
      content: { type: "text", text: "继续" }
    });
    const serialized = JSON.stringify(requests);
    expect(serialized).not.toContain("personRef");
    expect(serialized).not.toContain("familyRef");
    expect(serialized).not.toContain("providerProfileRef");
    expect(serialized).not.toContain("providerSession");
  });
});
