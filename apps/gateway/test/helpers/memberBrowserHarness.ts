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
  placeholder = "";
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
  dispatchKeyboard(
    type: string,
    key: string,
    shiftKey = false,
    isComposing = false,
  ) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      key: { value: key },
      shiftKey: { value: shiftKey },
      isComposing: { value: isComposing },
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
  agentPickerTitle: "strong",
  agentPickerHint: "span",
  agentChipList: "div",
  agentEmptyState: "p",
  mobileAgentSelect: "select",
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
  currentAgentIdentity: "div",
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
    nodes.currentAgentIdentity,
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
  const parentById: Record<string, string | null> = {
    connectionStatus: null,
    entryView: null,
    loadingState: "entryView",
    pairForm: "entryView",
    pairingMessage: "pairForm",
    pairingCode: "pairForm",
    resumeBrowserButton: "pairForm",
    errorState: "entryView",
    errorMessage: "errorState",
    retryButton: "errorState",
    workspaceView: null,
    workspaceSidebar: "workspaceView",
    personAvatar: "workspaceSidebar",
    personName: "workspaceSidebar",
    familyName: "workspaceSidebar",
    agentPickerTitle: "workspaceSidebar",
    agentPickerHint: "workspaceSidebar",
    agentChipList: "workspaceSidebar",
    agentEmptyState: "workspaceSidebar",
    mobileAgentSelect: "workspaceView",
    primaryNavigation: "workspaceSidebar",
    workNavigationTitle: "workspaceSidebar",
    createWorkButton: "workspaceSidebar",
    workList: "workspaceSidebar",
    logoutButton: "workspaceSidebar",
    revokeButton: "workspaceSidebar",
    workspaceKicker: "workspaceView",
    workspaceTitle: "workspaceView",
    currentAgentIdentity: "workspaceView",
    syncStatus: "workspaceView",
    deviceName: "workspaceView",
    chatSection: "workspaceView",
    chatHeading: "chatSection",
    selectionCount: "chatSection",
    convertSelectionButton: "chatSection",
    loadEarlierButton: "chatSection",
    threadMessages: "chatSection",
    chatEmptyState: "chatSection",
    messageComposer: "chatSection",
    messageInput: "messageComposer",
    composerStatus: "messageComposer",
    sendMessageButton: "messageComposer",
    workSection: "workspaceView",
    workStatus: "workSection",
    workHeading: "workSection",
    workGoal: "workSection",
    workListToggle: "workSection",
    workLoadEarlierButton: "workSection",
    workThreadMessages: "workSection",
    workEmptyState: "workSection",
    workMessageComposer: "workSection",
    workMessageInput: "workMessageComposer",
    workComposerStatus: "workMessageComposer",
    workSendMessageButton: "workMessageComposer",
    workDetail: "workSection",
    workDetailGoal: "workDetail",
    workSummary: "workDetail",
    workProgress: "workDetail",
    workPhaseSummary: "workProgress",
    workProgressGroups: "workProgress",
    mobileNavigation: "workspaceView",
    mobileCreateWorkButton: "mobileNavigation",
    createWorkDialog: null,
    createWorkForm: "createWorkDialog",
    createWorkTitle: "createWorkForm",
    createWorkTitleInput: "createWorkForm",
    createWorkGoalInput: "createWorkForm",
    chatToWorkDialog: null,
    chatToWorkForm: "chatToWorkDialog",
    chatToWorkTitle: "chatToWorkForm",
    chatToWorkSelectionSummary: "chatToWorkForm",
    chatToWorkTitleInput: "chatToWorkForm",
    chatToWorkGoalInput: "chatToWorkForm",
    productToast: null,
  };
  for (const [id, parentId] of Object.entries(parentById)) {
    if (parentId) nodes[parentId].append(nodes[id]);
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
    key(id: string, key: string, shiftKey = false, isComposing = false) {
      return nodes[id].dispatchKeyboard(
        "keydown",
        key,
        shiftKey,
        isComposing,
      );
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
import { createEntryMutationLock } from "../../member-public/entry-mutation.js";
import { createEntryStorage } from "../../member-public/entry-storage.js";
import { createEntryController } from "../../member-public/entry-lifecycle.js";
export { D as FakeDocument, E as FakeElement };
export function createStorage(
  options: {
    onGetItem?: (key: string) => void;
    onSetItem?: (key: string, value: string) => void;
    onRemoveItem?: (key: string) => void;
  } = {},
) {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => {
      options.onGetItem?.(key);
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      const text = String(value);
      values.set(key, text);
      options.onSetItem?.(key, text);
    },
    removeItem: (key: string) => {
      options.onRemoveItem?.(key);
      values.delete(key);
    },
    clear: () => values.clear(),
    dump: () => Object.fromEntries(values),
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
  const requestedNames = calls;
  const events: Array<{
    phase: "request" | "enter" | "exit";
    name: string;
    mode: "exclusive" | "shared";
  }> = [];
  type Request = {
    mode: "exclusive" | "shared";
    callback: (lock: {
      name: string;
      mode: "exclusive" | "shared";
    }) => unknown;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  type Lane = {
    activeExclusive: boolean;
    activeShared: number;
    queue: Request[];
  };
  const lanes = new Map<string, Lane>();
  const eventWaiters: Array<{
    phase: "request" | "enter" | "exit";
    name: string;
    mode?: "exclusive" | "shared";
    occurrence: number;
    resolve: () => void;
  }> = [];

  const record = (
    phase: "request" | "enter" | "exit",
    name: string,
    mode: "exclusive" | "shared",
  ) => {
    events.push({ phase, name, mode });
    for (let index = eventWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = eventWaiters[index];
      if (
        waiter.phase === phase && waiter.name === name &&
        (!waiter.mode || waiter.mode === mode) &&
        events.filter((event) =>
          event.phase === waiter.phase && event.name === waiter.name &&
          (!waiter.mode || event.mode === waiter.mode)
        ).length >= waiter.occurrence
      ) {
        eventWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const laneFor = (name: string) => {
    let lane = lanes.get(name);
    if (!lane) {
      lane = { activeExclusive: false, activeShared: 0, queue: [] };
      lanes.set(name, lane);
    }
    return lane;
  };

  const drain = (name: string) => {
    const lane = laneFor(name);
    if (lane.activeExclusive) return;

    const start = (request: Request) => {
      if (request.mode === "exclusive") lane.activeExclusive = true;
      else lane.activeShared += 1;

      const finish = (settle: () => void) => {
        record("exit", name, request.mode);
        if (request.mode === "exclusive") lane.activeExclusive = false;
        else lane.activeShared -= 1;
        drain(name);
        settle();
      };
      void Promise.resolve()
        .then(() => {
          record("enter", name, request.mode);
          return request.callback({ name, mode: request.mode });
        })
        .then(
          (value) => finish(() => request.resolve(value)),
          (error) => finish(() => request.reject(error)),
        );
    };

    if (lane.activeShared > 0) {
      while (lane.queue[0]?.mode === "shared") start(lane.queue.shift()!);
      return;
    }
    if (lane.queue[0]?.mode === "exclusive") {
      start(lane.queue.shift()!);
      return;
    }
    while (lane.queue[0]?.mode === "shared") start(lane.queue.shift()!);
  };

  return {
    calls,
    snapshot(name: string) {
      const lane = laneFor(name);
      return {
        activeExclusive: lane.activeExclusive,
        activeShared: lane.activeShared,
        queuedModes: lane.queue.map((request) => request.mode),
      };
    },
    requestedNames,
    events,
    waitForEvent(
      phase: "request" | "enter" | "exit",
      name: string,
      mode?: "exclusive" | "shared",
      occurrence = 1,
    ) {
      if (events.filter((event) =>
        event.phase === phase && event.name === name &&
        (!mode || event.mode === mode)
      ).length >= occurrence) return Promise.resolve();
      return new Promise<void>((resolve) => {
        eventWaiters.push({ phase, name, mode, occurrence, resolve });
      });
    },
    request(
      name: string,
      options:
        | { mode?: "exclusive" | "shared" }
        | ((lock: {
            name: string;
            mode: "exclusive" | "shared";
          }) => unknown),
      callback?: (lock: {
        name: string;
        mode: "exclusive" | "shared";
      }) => unknown,
    ) {
      const run = typeof options === "function" ? options : callback!;
      const mode =
        typeof options === "function"
          ? "exclusive"
          : options.mode ?? "exclusive";
      calls.push(name);
      record("request", name, mode);
      const result = new Promise((resolve, reject) => {
        laneFor(name).queue.push({ mode, callback: run, resolve, reject });
      });
      drain(name);
      return result;
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
  options: Record<string, any> = {},
) {
  const installationId =
    options.installationId ?? "00000000-0000-4000-8000-000000000001";
  const rotatedInstallationId =
    options.rotatedInstallationId ?? "00000000-0000-4000-8000-000000000002";
  const fixedNow = options.now ?? (() => new Date("2026-07-25T09:00:00.000Z"));
  const shared = createSharedEntryBrowserStorage();
  const locks = options.locks === null
    ? null
    : options.locks ?? createDeterministicWebLocks();
  const channels = createSharedEntryBroadcastChannels();
  const rootStorage = shared.createTabStorage();
  rootStorage.setItem("family-ai-web-installation-id", installationId);
  const seedStorage = createEntryStorage({
    localStorage: rootStorage,
    cryptoImpl: { randomUUID: () => rotatedInstallationId },
    now: fixedNow,
  });
  if (options.initialMarker) seedStorage.writeLockMarkerLocked(installationId);
  if (options.initialLifecycle) {
    const lifecycle = options.initialLifecycle;
    for (let revision = 1; revision <= lifecycle.revision; revision += 1) {
      seedStorage.advanceLifecycle(
        installationId,
        revision === lifecycle.revision ? lifecycle.state : "active",
        lifecycle.transitionId ??
          `00000000-0000-4000-8000-${String(100 + revision).padStart(12, "0")}`,
      );
    }
  }
  if (options.initialIdentity) {
    seedStorage.writeIdentityPointer(installationId, options.initialIdentity);
  }
  if (options.initialTombstone) {
    seedStorage.writeCleanupTombstone(
      options.initialTombstoneInstallationId ?? installationId,
      options.initialTombstone,
    );
  }
  if (options.initialClaimIntent) {
    seedStorage.writeClaimCookieIntent(options.initialClaimIntent);
  }
  if (options.initialCookieClearPending) {
    seedStorage.writeCookieClearPending(options.initialCookieClearPending);
  }

  let uuidSequence = 1000;
  const defaultContext = options.context ?? memberContextFixture();
  const tabs: any[] = [];

  function createTab(tabOptions: Record<string, any> = {}) {
    const eventTarget = shared.createEventTarget();
    const localStorage = shared.createTabStorage(eventTarget);
    let rotationCount = 0;
    const storage = createEntryStorage({
      localStorage,
      cryptoImpl: {
        randomUUID: () => {
          rotationCount += 1;
          return tabOptions.rotatedInstallationId ?? rotatedInstallationId;
        },
      },
      now: tabOptions.now ?? fixedNow,
    });
    const mutationLock = createEntryMutationLock({
      locks: tabOptions.locks === undefined ? locks : tabOptions.locks,
    });
    const apiImplementations = {
      getWebContext: async () => ({ context: defaultContext }),
      renewWebSession: async () => undefined,
      claimWebPairing: async () => undefined,
      logoutWebSession: async () => undefined,
      revokeWebDevice: async () => undefined,
      clearWebEntryCookies: async () => undefined,
      ...(options.api ?? {}),
      ...(tabOptions.api ?? {}),
    };
    const httpEvents: Array<{ phase: "request-bytes"; operation: string }> = [];
    const requestWaiters = new Map<string, Array<() => void>>();
    const recordRequest = (operation: string) => {
      httpEvents.push({ phase: "request-bytes", operation });
      const waiters = requestWaiters.get(operation) ?? [];
      requestWaiters.delete(operation);
      waiters.forEach((resolve) => resolve());
    };
    const instrument = (operation: keyof typeof apiImplementations) =>
      vi.fn((...args: any[]) => {
        recordRequest(operation);
        return apiImplementations[operation](...args);
      });
    const api = {
      getWebContext: instrument("getWebContext"),
      renewWebSession: instrument("renewWebSession"),
      claimWebPairing: instrument("claimWebPairing"),
      logoutWebSession: instrument("logoutWebSession"),
      revokeWebDevice: instrument("revokeWebDevice"),
      clearWebEntryCookies: instrument("clearWebEntryCookies"),
    };
    const http = {
      events: httpEvents,
      waitForRequest(operation: string) {
        if (httpEvents.some((event) => event.operation === operation)) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const waiters = requestWaiters.get(operation) ?? [];
          waiters.push(resolve);
          requestWaiters.set(operation, waiters);
        });
      },
    };
    const workbench = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => undefined),
      ...(options.workbench ?? {}),
      ...(tabOptions.workbench ?? {}),
    };
    const cacheLifecycle = {
      deleteLegacy: vi.fn(async () => undefined),
      deleteIdentity: vi.fn(async () => undefined),
      ...(options.cacheLifecycle ?? {}),
      ...(tabOptions.cacheLifecycle ?? {}),
    };
    const pendingClaims = {
      clear: vi.fn(),
      isTerminalError: vi.fn((error: any) => [
        "PAIRING_INVALID",
        "PAIRING_EXPIRED",
        "PAIRING_ATTEMPTS_EXCEEDED",
        "PAIRING_CONSUMED",
        "DEVICE_AUTH_INVALID",
        "DEVICE_REVOKED",
        "PAIRING_TARGET_INACTIVE",
      ].includes(error?.code)),
      shouldRetain: vi.fn((error: any) =>
        error instanceof TypeError || error?.retryable === true ||
        ["timeout", "availability"].includes(error?.category) ||
        error?.code === "GATEWAY_UNAVAILABLE"),
      ...(options.pendingClaims ?? {}),
      ...(tabOptions.pendingClaims ?? {}),
    };
    const states: any[] = [];
    const view = {
      states,
      last: () => states.at(-1),
    };
    const deviceDescriptor = tabOptions.deviceDescriptor ??
      options.deviceDescriptor ?? {
        displayName: "Alice 的浏览器",
        browser: "Test Browser",
        operatingSystem: "Test OS",
        appVersion: "0.1.0",
      };
    const tab: any = {
      api,
      http,
      storage,
      localStorage,
      mutationLock,
      cacheLifecycle,
      workbench,
      pendingClaims,
      deviceDescriptor,
      eventTarget,
      view,
      get rotationCount() {
        return rotationCount;
      },
    };
    tab.createController = (controllerOptions: Record<string, any> = {}) => {
      if (tab.controller) return tab.controller;
      tab.controller = createEntryController({
        api,
        storage,
        mutationLock,
        cacheLifecycle,
        workbench,
        pendingClaims,
        deviceDescriptor,
        BroadcastChannelClass: channels.Channel,
        AbortControllerClass: AbortController,
        eventTarget,
        now: tabOptions.now ?? fixedNow,
        uuid: tabOptions.uuid ?? (() =>
          `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`),
        onViewState: (state: unknown) => states.push(structuredClone(state)),
        ...controllerOptions,
      });
      return tab.controller;
    };
    tabs.push(tab);
    return tab;
  }

  const primary = createTab(options.primary ?? {});
  return {
    installationId,
    rotatedInstallationId,
    locks,
    channels,
    shared,
    tabs,
    ...primary,
    get rotationCount() {
      return primary.rotationCount;
    },
    createController: primary.createController,
    createTab,
  };
}

function storageEvent(
  key: string,
  oldValue: string | null,
  newValue: string | null,
) {
  const event = new Event("storage");
  Object.defineProperties(event, {
    key: { value: key },
    oldValue: { value: oldValue },
    newValue: { value: newValue },
  });
  return event;
}

export function createSharedEntryBrowserStorage() {
  const values = new Map<string, string>();
  const targets = new Set<EventTarget>();
  const pendingDispatches = new Set<Promise<void>>();

  function emit(
    source: EventTarget | null,
    key: string,
    oldValue: string | null,
    newValue: string | null,
  ) {
    for (const target of targets) {
      if (target === source) continue;
      const dispatch = Promise.resolve().then(() => {
        target.dispatchEvent(storageEvent(key, oldValue, newValue));
      });
      pendingDispatches.add(dispatch);
      void dispatch.finally(() => pendingDispatches.delete(dispatch));
    }
  }

  return {
    createEventTarget() {
      const target = new EventTarget();
      targets.add(target);
      return target;
    },
    createTabStorage(source: EventTarget | null = null) {
      return {
        get length() {
          return values.size;
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem(key: string, value: string) {
          const text = String(value);
          const oldValue = values.get(key) ?? null;
          if (oldValue === text) return;
          values.set(key, text);
          emit(source, key, oldValue, text);
        },
        removeItem(key: string) {
          const oldValue = values.get(key) ?? null;
          if (oldValue === null) return;
          values.delete(key);
          emit(source, key, oldValue, null);
        },
        clear() {
          for (const key of [...values.keys()]) this.removeItem(key);
        },
        dump: () => Object.fromEntries(values),
      };
    },
    async whenIdle() {
      while (pendingDispatches.size > 0) {
        await Promise.all([...pendingDispatches]);
      }
      await Promise.resolve();
    },
    dispatchToAll(key: string, oldValue: string | null, newValue: string | null) {
      for (const target of targets) {
        target.dispatchEvent(storageEvent(key, oldValue, newValue));
      }
    },
  };
}

export function createSharedEntryBroadcastChannels() {
  const channels = new Set<any>();
  const posted: unknown[] = [];
  const pendingDeliveries = new Set<Promise<void>>();
  let deliveryLane = Promise.resolve();

  const enqueueDelivery = (deliver: () => void) => {
    const delivery = deliveryLane.then(() => {
      deliver();
    });
    deliveryLane = delivery.catch(() => undefined);
    pendingDeliveries.add(delivery);
    void delivery.finally(() => pendingDeliveries.delete(delivery));
  };

  const dispatchMessage = (channel: EventTarget, data: unknown) => {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: structuredClone(data),
    });
    channel.dispatchEvent(event);
  };

  class Channel extends EventTarget {
    closed = false;
    constructor(readonly name: string) {
      super();
      channels.add(this);
    }
    postMessage(data: unknown) {
      if (this.closed) throw new Error("CHANNEL_CLOSED");
      posted.push(structuredClone(data));
      enqueueDelivery(() => {
        for (const peer of channels) {
          if (peer === this || peer.closed || peer.name !== this.name) continue;
          dispatchMessage(peer, data);
        }
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      channels.delete(this);
    }
  }
  return {
    Channel,
    posted,
    get openCount() {
      return channels.size;
    },
    dispatch(data: unknown) {
      enqueueDelivery(() => {
        for (const channel of channels) {
          if (!channel.closed) dispatchMessage(channel, data);
        }
      });
    },
    async whenIdle() {
      while (pendingDeliveries.size > 0) {
        await Promise.all([...pendingDeliveries]);
      }
      await deliveryLane;
    },
  };
}

export function entryError(
  code: string,
  overrides: Record<string, unknown> = {},
) {
  return Object.assign(new Error(code), { code, ...overrides });
}

export function pendingClaimFixture(
  installationId = "00000000-0000-4000-8000-000000000001",
  overrides: Record<string, unknown> = {},
) {
  return {
    protocolVersion: 2,
    pairingRef: "pairing:web-1",
    code: "ABCD-EFGH",
    installationId,
    deviceCredential: "A".repeat(43),
    ...overrides,
  };
}
