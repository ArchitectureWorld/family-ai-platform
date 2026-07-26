class C {
  values = new Set<string>();
  add(...v: string[]) {
    v.forEach((x) => this.values.add(x));
  }
  toggle(v: string, force?: boolean) {
    const yes = force ?? !this.values.has(v);
    if (yes) this.values.add(v);
    else this.values.delete(v);
    return yes;
  }
  contains(v: string) {
    return this.values.has(v);
  }
}
class E extends EventTarget {
  children: E[] = [];
  dataset: Record<string, string> = {};
  classList = new C();
  parentElement: E | null = null;
  value = "";
  disabled = false;
  type = "";
  checked = false;
  selected = false;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  text = "";
  open = false;
  showModalCalls = 0;
  closeCalls = 0;
  private _id = "";
  constructor(
    readonly tagName: string,
    readonly ownerDocument: D,
  ) {
    super();
  }
  get id() {
    return this._id;
  }
  set id(v: string) {
    this._id = v;
    this.ownerDocument.ids.set(v, this);
  }
  get className() {
    return [...this.classList.values].join(" ");
  }
  set className(v: string) {
    this.classList.values = new Set(v.split(/\s+/).filter(Boolean));
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get options() {
    return this.children.filter((x) => x.tagName === "option");
  }
  get textContent() {
    return this.children.length
      ? this.children.map((x) => x.textContent).join("")
      : this.text;
  }
  set textContent(v: string) {
    this.children.forEach((x) => {
      x.parentElement = null;
    });
    this.children = [];
    this.text = String(v ?? "");
  }
  append(...nodes: E[]) {
    nodes.forEach((node) => {
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      this.children.push(node);
    });
  }
  before(...nodes: E[]) {
    const parent = this.parentElement;
    if (!parent) return;
    nodes.forEach((node) => {
      node.parentElement?.removeChild(node);
      node.parentElement = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
    });
  }
  removeChild(node: E) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error("NOT_A_CHILD");
    this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }
  querySelectorAll(selector: string): E[] {
    const match = (node: E) =>
      selector === "button, input, textarea"
        ? ["button", "input", "textarea"].includes(node.tagName)
        : selector === "[data-section]"
          ? node.dataset.section !== undefined
          : selector === "[data-close-dialog]"
            ? node.dataset.closeDialog !== undefined
            : selector.startsWith(".")
              ? node.classList.contains(selector.slice(1))
              : false;
    const out: E[] = [];
    const visit = (node: E) =>
      node.children.forEach((child) => {
        if (match(child)) out.push(child);
        visit(child);
      });
    visit(this);
    return out;
  }
  setAttribute(name: string, value: string) {
    if (name.startsWith("data-"))
      this.dataset[
        name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ] = value;
  }
  removeAttribute(_name: string) {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  requestSubmit() {
    this.dispatchEvent(new Event("submit", { cancelable: true }));
  }
  reset() {
    this.querySelectorAll("button, input, textarea").forEach((x) => {
      x.value = "";
    });
  }
  showModal() {
    this.open = true;
    this.showModalCalls += 1;
  }
  close() {
    this.open = false;
    this.closeCalls += 1;
  }
  dispatchKeyboard(type: string, key: string, shiftKey = false) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      key: { value: key },
      shiftKey: { value: shiftKey },
    });
    this.dispatchEvent(event);
    return event;
  }
  click() {
    this.dispatchEvent(new Event("click", { cancelable: true }));
  }
}
class D {
  ids = new Map<string, E>();
  activeElement: E | null = null;
  body = this.createElement("body");
  getElementById(id: string) {
    return this.ids.get(id) ?? null;
  }
  createElement(tag: string) {
    return new E(tag, this);
  }
  querySelectorAll(selector: string) {
    return this.body.querySelectorAll(selector);
  }
}
const tag: Record<string, string> = {
  entryView: "section",
  loadingState: "div",
  pairForm: "form",
  pairingMessage: "p",
  pairingCode: "input",
  resumeBrowserButton: "button",
  errorState: "div",
  errorMessage: "p",
  retryButton: "button",
  workspaceView: "section",
  workspaceSidebar: "aside",
  personAvatar: "span",
  personName: "strong",
  familyName: "small",
  primaryNavigation: "nav",
  workNavigationTitle: "h2",
  logoutButton: "button",
  revokeButton: "button",
  deviceName: "span",
  chatHeading: "h2",
  chatToWorkTitle: "h2",
  sendMessageButton: "button",
  workDetail: "aside",
  workProgress: "div",
  mobileNavigation: "nav",
  createWorkTitle: "h2",
  connectionStatus: "div",
  chatSection: "section",
  workSection: "section",
  workspaceKicker: "p",
  workspaceTitle: "h2",
  syncStatus: "span",
  workList: "div",
  createWorkButton: "button",
  mobileCreateWorkButton: "button",
  workListToggle: "button",
  convertSelectionButton: "button",
  loadEarlierButton: "button",
  workLoadEarlierButton: "button",
  messageComposer: "form",
  messageInput: "textarea",
  workMessageComposer: "form",
  workMessageInput: "textarea",
  createWorkDialog: "dialog",
  createWorkForm: "form",
  createWorkTitleInput: "input",
  createWorkGoalInput: "textarea",
  chatToWorkDialog: "dialog",
  chatToWorkForm: "form",
  chatToWorkTitleInput: "input",
  chatToWorkGoalInput: "textarea",
  productToast: "div",
  threadMessages: "div",
  workThreadMessages: "div",
  chatEmptyState: "div",
  workEmptyState: "div",
  selectionCount: "span",
  chatToWorkSelectionSummary: "p",
  composerStatus: "span",
  workStatus: "p",
  workHeading: "h2",
  workGoal: "p",
  workDetailGoal: "p",
  workSummary: "p",
  workPhaseSummary: "p",
  workProgressGroups: "div",
  workSendMessageButton: "button",
  workComposerStatus: "span",
};
export function createMemberDocumentHarness() {
  const document = new D();
  const nodes = Object.fromEntries(
    Object.entries(tag).map(([id, name]) => {
      const node = document.createElement(name);
      node.id = id;
      document.body.append(node);
      return [id, node];
    }),
  ) as Record<string, E>;
  nodes.connectionStatus.append(document.createElement("span"));
  nodes.messageComposer.append(nodes.messageInput);
  nodes.workMessageComposer.append(nodes.workMessageInput);
  nodes.createWorkDialog.append(nodes.createWorkForm);
  nodes.createWorkForm.append(
    nodes.createWorkTitleInput,
    nodes.createWorkGoalInput,
  );
  nodes.chatToWorkDialog.append(nodes.chatToWorkForm);
  nodes.chatToWorkForm.append(nodes.chatToWorkTitleInput);
  nodes.entryView.append(nodes.loadingState, nodes.pairForm, nodes.errorState);
  nodes.pairForm.append(
    nodes.pairingMessage,
    nodes.pairingCode,
    nodes.resumeBrowserButton,
  );
  nodes.errorState.append(nodes.errorMessage, nodes.retryButton);
  nodes.workspaceView.append(
    nodes.workspaceSidebar,
    nodes.primaryNavigation,
    nodes.mobileNavigation,
  );
  nodes.workspaceSidebar.append(
    nodes.personAvatar,
    nodes.personName,
    nodes.familyName,
    nodes.workNavigationTitle,
    nodes.createWorkButton,
    nodes.workList,
    nodes.logoutButton,
    nodes.revokeButton,
  );
  nodes.messageComposer.append(nodes.composerStatus, nodes.sendMessageButton);
  nodes.workMessageComposer.append(
    nodes.workComposerStatus,
    nodes.workSendMessageButton,
  );
  nodes.workDetail.append(
    nodes.workDetailGoal,
    nodes.workSummary,
    nodes.workProgress,
  );
  nodes.workProgress.append(nodes.workPhaseSummary, nodes.workProgressGroups);
  nodes.createWorkForm.append(nodes.createWorkTitle);
  nodes.chatToWorkForm.append(nodes.chatToWorkTitle);
  for (const navigation of [nodes.primaryNavigation, nodes.mobileNavigation]) {
    for (const section of ["chat", "work"]) {
      const button = document.createElement("button");
      button.dataset.section = section;
      navigation.append(button);
    }
  }
  for (const dialog of ["createWorkDialog", "chatToWorkDialog"]) {
    const button = document.createElement("button");
    button.dataset.closeDialog = dialog;
    (dialog === "createWorkDialog"
      ? nodes.createWorkForm
      : nodes.chatToWorkForm
    ).append(button);
  }
  return {
    document,
    elements: nodes,
    click(id: string) {
      nodes[id].click();
    },
    input(id: string, value: string) {
      nodes[id].value = value;
      nodes[id].dispatchEvent(new Event("input", { cancelable: true }));
    },
    key(id: string, key: string, shiftKey = false) {
      return nodes[id].dispatchKeyboard("keydown", key, shiftKey);
    },
    submit(id: string) {
      nodes[id].requestSubmit();
    },
    whenIdle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
import { vi } from "vitest";
export { D as FakeDocument, E as FakeElement };
export function createStorage(
  options: { onSetItem?: (key: string, value: string) => void } = {},
) {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const text = String(value);
      values.set(key, text);
      options.onSetItem?.(key, text);
    },
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}
export function zeroCrypto() {
  return {
    getRandomValues: <T extends ArrayBufferView>(values: T) => {
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength).fill(
        0,
      );
      return values;
    },
  };
}
export function deterministicUuidCrypto() {
  let next = 0;
  return {
    ...zeroCrypto(),
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function createDeterministicWebLocks() {
  const calls: string[] = [];
  const lanes = new Map<string, Promise<unknown>>();
  return {
    calls,
    request(
      name: string,
      options: unknown,
      callback?: (lock: { name: string }) => unknown,
    ) {
      const run =
        typeof options === "function"
          ? (options as (lock: { name: string }) => unknown)
          : callback!;
      calls.push(name);
      const previous = lanes.get(name) ?? Promise.resolve();
      const current = previous.then(() => run({ name }));
      lanes.set(
        name,
        current.catch(() => undefined),
      );
      return current;
    },
  };
}
export function memberContextFixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    family: { familyRef: "family:0001", displayName: "测试家庭" },
    person: { personRef: "person:alice", displayName: "Alice" },
    device: { deviceRef: "device:web-alice", displayName: "Alice 的浏览器" },
    ...overrides,
  };
}
export function fakeIdentityCache(
  options: { calls?: string[]; snapshot?: Record<string, unknown> } = {},
) {
  const calls = options.calls ?? [];
  const snapshot = options.snapshot ?? {};
  return {
    calls,
    snapshot,
    async read() {
      calls.push("identity:read");
      return snapshot;
    },
    async write(value: unknown) {
      calls.push("identity:write");
      Object.assign(snapshot, value as object);
    },
    close: vi.fn(),
  };
}
export function memberProductFetchFixture(calls: string[] = []) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const responses: Record<string, unknown> = {
      "GET /api/v1/chat?timezone=UTC": {
        protocolVersion: 1,
        chat: {
          threadRef: "thread:chat-0001",
          homeChatStreamRef: "home-chat:alice",
        },
        currentEpisode: {
          dailyEpisodeRef: "daily-episode:alice",
          threadRef: "thread:chat-0001",
        },
      },
      "GET /api/v1/work-conversations": {
        protocolVersion: 1,
        conversations: [],
      },
      "GET /api/v1/threads/thread%3Achat-0001/messages?limit=100": {
        protocolVersion: 1,
        threadRef: "thread:chat-0001",
        messages: [],
        nextBeforeSequence: null,
      },
    };
    const key = `${method} ${url}`;
    const label: Record<string, string> = {
      "GET /api/v1/chat?timezone=UTC": "chat:init",
      "GET /api/v1/work-conversations": "work:init",
      "GET /api/v1/threads/thread%3Achat-0001/messages?limit=100":
        "chat:messages",
    };
    if (!(key in responses)) throw new Error(`UNEXPECTED_FETCH:${key}`);
    calls.push(label[key]);
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
export function memberState(overrides: Record<string, unknown> = {}) {
  return {
    section: "chat",
    chat: { threadRef: "thread:chat-0001" },
    currentEpisode: null,
    works: [
      {
        workConversationRef: "work:0001",
        threadRef: "thread:work-0001",
        title: "测试 Work",
        goal: "推进",
        status: "active",
        summary: "",
      },
    ],
    selectedWorkRef: "work:0001",
    activeThreadRef: "thread:chat-0001",
    messagesByThread: {
      "thread:chat-0001": [
        {
          messageRef: "message:person-0001",
          actor: { type: "person" },
          content: { text: "你好" },
          occurredAt: "2026-07-25T10:00:00.000Z",
        },
      ],
    },
    paginationByThread: { "thread:chat-0001": 1 },
    outgoing: [
      {
        clientMessageId: "web:failed-0001",
        threadRef: "thread:chat-0001",
        content: { text: "失败" },
        occurredAt: "2026-07-25T10:00:00.000Z",
        status: "failed",
        error: { retryable: true },
      },
    ],
    drafts: {},
    selectedMessageRefs: [],
    progressByWork: {},
    network: { online: true },
    sync: { status: "online" },
    busy: {},
    ...overrides,
  };
}
export function memberActions(overrides: Record<string, unknown> = {}) {
  return {
    navigate: vi.fn(),
    openWork: vi.fn(async () => undefined),
    createWork: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ status: "succeeded" })),
    saveDraft: vi.fn(async () => undefined),
    loadEarlier: vi.fn(async () => undefined),
    retry: vi.fn(async () => ({ status: "succeeded" })),
    toggleMessageSelection: vi.fn(),
    convertChatToWork: vi.fn(async () => undefined),
    ...overrides,
  };
}
export function fakeRenderer() {
  return { destroy: vi.fn() };
}
export function fakeSync(calls: string[]) {
  return {
    start: vi.fn(async () => calls.push("sync:start")),
    stop: vi.fn(() => calls.push("sync:stop")),
    whenIdle: vi.fn(async () => undefined),
  };
}
export function createEntryControllerHarness(
  options: Record<string, unknown> = {},
) {
  return {
    document: createMemberDocumentHarness().document,
    storage: createStorage(),
    crypto: deterministicUuidCrypto(),
    locks: createDeterministicWebLocks(),
    fetch: memberProductFetchFixture(),
    ...options,
  };
}
