import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const adminPublic = fileURLToPath(new URL("../admin-public/", import.meta.url));
const agentsModuleUrl = pathToFileURL(join(adminPublic, "admin-agents.js")).href;
const apiModuleUrl = pathToFileURL(join(adminPublic, "admin-api.js")).href;
const token = `${"A".repeat(42)}A`;

async function agentsModule() {
  return import(`${agentsModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

async function apiModule() {
  return import(`${apiModuleUrl}?test=${Date.now()}-${Math.random()}`);
}

class TestElement extends EventTarget {
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  parentElement: TestElement | null = null;
  value = "";
  disabled = false;
  hidden = false;
  selected = false;
  private text = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: TestDocument
  ) {
    super();
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

  get options() {
    return this.children.filter((child) => child.tagName === "option");
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
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const attributeSelector = selector.match(
      /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/u
    );
    const matches = (node: TestElement) =>
      attributeSelector !== null
        ? attributeSelector[2] === undefined
          ? node.attributes.has(attributeSelector[1]!)
          : node.attributes.get(attributeSelector[1]!) === attributeSelector[2]
        : node.tagName === selector.toLowerCase();
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

  contains(node: TestElement | null): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  private isHiddenFromView(): boolean {
    let current: TestElement | null = this;
    while (current !== null) {
      if (current.hidden) return true;
      current = current.parentElement;
    }
    return false;
  }

  focus() {
    if (!this.disabled && !this.isHiddenFromView()) {
      this.ownerDocument.activeElement = this;
    }
  }

  keydown(key: string) {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    this.dispatchEvent(event);
    return event;
  }

  click() {
    if (!this.disabled) {
      this.focus();
      this.dispatchEvent(new Event("click", { cancelable: true }));
    }
  }
}

class TestDocument {
  activeElement: TestElement | null = null;

  createElement(tagName: string) {
    return new TestElement(tagName.toLowerCase(), this);
  }
}

const catalog = {
  protocolVersion: 1,
  agents: [
    {
      agentRef: "agent:hermes-jarvis",
      displayName: "Jarvis",
      system: true,
      runtime: "available",
      runtimeLabel: "可用"
    },
    {
      agentRef: "agent:hermes-zzh",
      displayName: "于途",
      system: false,
      runtime: "available",
      runtimeLabel: "可用"
    },
    {
      agentRef: "agent:hermes-nsy",
      displayName: "乔晶晶",
      system: false,
      runtime: "unavailable",
      runtimeLabel: "不可用"
    }
  ]
};

const rawCatalog = {
  protocolVersion: 1,
  agents: catalog.agents.map((agent) => ({
    agentRef: agent.agentRef,
    displayName: agent.displayName,
    status: agent.runtime === "available" ? "idle" : "problem",
    statusLabel: agent.runtime === "available" ? "空闲" : "有问题",
    activeTurnCount: 0,
    lastCheckedAt: "2026-07-28T10:00:00.000Z",
    publicProblem: agent.runtime === "available"
      ? null
      : "Agent 当前无法连接。"
  }))
};

const mounted = {
  protocolVersion: 1,
  personRef: "person:alice",
  defaultAgentRef: null,
  mountedAgents: [{
    assignmentRef: "assignment:alice-zzh",
    agentRef: "agent:hermes-zzh",
    displayName: "于途",
    providerProfileRef: "provider-profile:private",
    isDefault: false,
    status: "working",
    statusLabel: "工作中"
  }]
};

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Admin member Agent controls", () => {
  it("renders exactly the approved three cards with textual runtime and allocation states", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    const hostileMounts = {
      ...mounted,
      mountedAgents: [
        ...mounted.mountedAgents,
        {
          agentRef: "agent:hermes-jarvis",
          displayName: "Jarvis /srv/private/runtime",
          providerProfileRef: "provider-profile:private-jarvis",
          isDefault: true,
          status: "working",
          statusLabel: "工作中"
        }
      ]
    };
    const api = {
      agents: vi.fn(async () => ({
        ...catalog,
        agents: catalog.agents.map((agent) => ({
          ...agent,
          providerProfileRef: "provider-profile:private",
          home: "/srv/private/runtime",
          profile: "nsy",
          serviceToken: "secret"
        }))
      })),
      memberAgentMounts: vi.fn(async () => hostileMounts),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    const cards = card.querySelectorAll("[data-agent-card]");
    expect(cards.map((node) => node.getAttribute("data-agent-card"))).toEqual([
      "agent:hermes-jarvis",
      "agent:hermes-zzh",
      "agent:hermes-nsy"
    ]);
    expect(cards[0]?.textContent).toContain("Jarvis");
    expect(cards[0]?.textContent).toContain("系统 Agent");
    expect(cards[0]?.textContent).toContain("可用");
    expect(cards[0]?.textContent).toContain("由家庭管理系统统一提供");
    expect(cards[0]?.querySelector("[data-mount-agent]")).toBeNull();
    expect(cards[0]?.querySelector("[data-remove-agent]")).toBeNull();
    expect(cards[1]?.textContent).toContain("于途");
    expect(cards[1]?.textContent).toContain("可分配");
    expect(cards[1]?.textContent).toContain("已分配");
    expect(cards[2]?.textContent).toContain("乔晶晶");
    expect(cards[2]?.textContent).toContain("不可用");
    expect(cards[2]?.textContent).toContain("未分配");
    expect(card.querySelector('[data-mount-agent="agent:hermes-nsy"]')?.disabled)
      .toBe(true);
    expect(card.querySelector("[data-default-agent]")?.options.map((option) => option.value))
      .toEqual(["", "agent:hermes-zzh"]);
    expect(card.textContent).not.toContain("provider-profile:private");
    expect(card.textContent).not.toContain("/srv/private");
    expect(card.textContent).not.toContain("serviceToken");
  });

  it("allows an assigned unavailable personal Agent to be removed safely", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let serverMounts = {
      ...mounted,
      mountedAgents: [{
        ...mounted.mountedAgents[0],
        assignmentRef: "assignment:alice-nsy",
        agentRef: "agent:hermes-nsy",
        displayName: "hostile raw profile nsy",
        status: "problem",
        statusLabel: "有问题"
      }]
    };
    const api = {
      agents: vi.fn(async () => catalog),
      memberAgentMounts: vi.fn(async () => serverMounts),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(async (_personRef: string, agentRef: string) => {
        serverMounts = { ...serverMounts, mountedAgents: [] };
        expect(agentRef).toBe("agent:hermes-nsy");
      }),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    const remove = card.querySelector('[data-remove-agent="agent:hermes-nsy"]');
    expect(remove?.disabled).toBe(false);
    expect(card.textContent).not.toContain("hostile raw profile nsy");
    remove?.click();
    await flush();
    await flush();
    expect(api.unmountAgent).toHaveBeenCalledWith(
      "person:alice",
      "agent:hermes-nsy"
    );
    expect(card.querySelector('[data-remove-agent="agent:hermes-nsy"]')).toBeNull();
    expect(card.querySelector('[data-mount-agent="agent:hermes-nsy"]')?.disabled)
      .toBe(true);
  });

  it.each([
    ["missing", catalog.agents.slice(0, 2)],
    ["duplicate", [...catalog.agents, catalog.agents[2]]],
    ["renamed", catalog.agents.map((agent) => agent.agentRef === "agent:hermes-nsy" ? { ...agent, displayName: "新名字" } : agent)],
    ["unexpected", [...catalog.agents, { ...catalog.agents[2], agentRef: "agent:unknown" }]]
  ])("fails closed for %s first-release catalog drift", async (_kind, agents) => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api: {
        agents: vi.fn(async () => ({ protocolVersion: 1, agents })),
        memberAgentMounts: vi.fn(async () => mounted),
        mountAgent: vi.fn(),
        unmountAgent: vi.fn(),
        setDefaultAgent: vi.fn()
      }
    });
    await controller.ready;

    expect(card.textContent).toContain("无法确认当前 Agent 配置");
    expect(card.querySelectorAll("[data-agent-card]")).toHaveLength(0);
    expect(card.querySelector("[data-mount-agent]")).toBeNull();
    expect(card.querySelector("[data-remove-agent]")).toBeNull();
    expect(card.querySelector("[data-save-default-agent]")).toBeNull();
    expect(card.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("filters only this member's active mounts and renders safe, accessible status controls", async () => {
    const { availableAgentOptions, renderMemberAgentControls } = await agentsModule();
    const addOptions = availableAgentOptions(catalog.agents, mounted.mountedAgents);
    expect(addOptions.map((option: { agentRef: string }) => option.agentRef))
      .toEqual(["agent:hermes-nsy"]);
    expect(
      availableAgentOptions(catalog.agents, [])
        .map((option: { agentRef: string }) => option.agentRef)
    ).toEqual(["agent:hermes-zzh", "agent:hermes-nsy"]);

    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api: {
        agents: vi.fn(async () => catalog),
        memberAgentMounts: vi.fn(async () => mounted),
        mountAgent: vi.fn(),
        unmountAgent: vi.fn(),
        setDefaultAgent: vi.fn()
      },
      confirmImpl: () => true
    });
    await controller.ready;

    expect(card.querySelector("[data-remove-agent]")?.textContent).toBe("移除");
    expect(card.querySelector("[data-remove-agent]")?.tagName).toBe("button");
    expect(card.querySelector("[data-remove-agent]")?.getAttribute("aria-label"))
      .toBe("从成员移除 于途");
    expect(card.textContent).toContain("可用");
    expect(card.textContent).toContain("不可用");
    expect(card.textContent).not.toContain("provider-profile:private");
    expect(card.textContent).not.toContain("Session");
    const addTrigger = card.querySelector("[data-add-agent-trigger]");
    const addMenu = card.querySelector("[data-add-agent-menu]");
    expect(addTrigger?.textContent).toBe("+");
    expect(addTrigger?.getAttribute("aria-haspopup")).toBeNull();
    expect(addTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(addMenu?.getAttribute("role")).toBeNull();
    expect(addMenu?.hidden).toBe(true);
    addTrigger?.click();
    expect(card.querySelector("[data-add-agent-menu]")?.hidden).toBe(false);
    expect(card.querySelector("[data-add-agent-trigger]")?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(
      card.querySelectorAll("[data-mount-agent]")
        .map((option) => option.getAttribute("data-mount-agent"))
    ).toEqual(["agent:hermes-nsy"]);
    expect(documentRef.activeElement?.getAttribute("data-mount-agent"))
      .toBeNull();
    expect(documentRef.activeElement?.getAttribute("data-add-agent-trigger"))
      .toBe("");
    expect(card.querySelector("[data-default-agent]")?.value).toBe("");
  });

  it("uses a button popover and returns Escape focus to its trigger", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api: {
        agents: vi.fn(async () => catalog),
        memberAgentMounts: vi.fn(async () => mounted),
        mountAgent: vi.fn(),
        unmountAgent: vi.fn(),
        setDefaultAgent: vi.fn()
      },
      confirmImpl: () => true
    });
    await controller.ready;

    const trigger = card.querySelector("[data-add-agent-trigger]");
    expect(trigger?.getAttribute("aria-haspopup")).toBeNull();
    trigger?.click();

    const menu = card.querySelector("[data-add-agent-menu]");
    const option = card.querySelector("[data-mount-agent]");
    expect(menu?.getAttribute("role")).toBeNull();
    expect(option?.getAttribute("role")).toBeNull();
    expect(option?.tagName).toBe("button");
    expect(option?.disabled).toBe(true);
    expect(documentRef.activeElement)
      .toBe(card.querySelector("[data-add-agent-trigger]"));

    const escape = option?.keydown("Escape");
    expect(escape?.defaultPrevented).toBe(true);
    expect(card.querySelector("[data-add-agent-menu]")?.hidden).toBe(true);
    expect(card.querySelector("[data-add-agent-trigger]")?.getAttribute("aria-expanded"))
      .toBe("false");
    expect(documentRef.activeElement?.getAttribute("data-add-agent-trigger")).toBe("");
  });

  it("keeps unknown initial state unavailable and mutation-free until reload succeeds", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let unavailable = true;
    const api = {
      agents: vi.fn(async () => {
        if (unavailable) throw new Error("private initial failure");
        return catalog;
      }),
      memberAgentMounts: vi.fn(async () => mounted),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    expect(card.textContent).toContain("无法确认当前 Agent 配置");
    expect(card.textContent).not.toContain("尚未挂载");
    expect(card.textContent).not.toContain("private initial failure");
    expect(card.querySelector("[data-add-agent-trigger]")).toBeNull();
    expect(card.querySelector("[data-default-agent]")).toBeNull();
    expect(card.querySelector("[data-save-default-agent]")).toBeNull();
    expect(documentRef.activeElement?.getAttribute("data-agent-refresh-retry"))
      .toBe("");

    unavailable = false;
    card.querySelector("[data-agent-refresh-retry]")?.click();
    await flush();
    await flush();
    expect(card.textContent).toContain("于途");
    expect(card.querySelector("[data-add-agent-trigger]")).not.toBeNull();
    expect(api.mountAgent).not.toHaveBeenCalled();
    expect(api.unmountAgent).not.toHaveBeenCalled();
    expect(api.setDefaultAgent).not.toHaveBeenCalled();
  });

  it("keeps the mounted control pending, deduplicates clicks, and refreshes server state", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let resolveUnmount!: () => void;
    const unmountPending = new Promise<void>((resolve) => {
      resolveUnmount = resolve;
    });
    let serverMounts: typeof mounted | { mountedAgents: never[] } = mounted;
    const api = {
      agents: vi.fn(async () => catalog),
      memberAgentMounts: vi.fn(async () => serverMounts),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(async () => {
        await unmountPending;
        serverMounts = {
          ...mounted,
          mountedAgents: []
        };
      }),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    const remove = card.querySelector("[data-remove-agent]");
    remove?.click();
    remove?.click();
    await flush();
    expect(api.unmountAgent).toHaveBeenCalledTimes(1);
    expect(card.querySelector("[data-remove-agent]")).not.toBeNull();
    expect(card.textContent).toContain("正在移除");

    resolveUnmount();
    await flush();
    await flush();
    expect(api.memberAgentMounts).toHaveBeenCalledTimes(2);
    expect(card.querySelector("[data-remove-agent]")).toBeNull();
    expect(card.textContent).toContain("未分配");
    expect(card.textContent).toContain("Agent 配置已更新");
    expect(card.querySelector('[role="status"]')?.getAttribute("aria-live"))
      .toBe("polite");
    expect(card.querySelector("[data-default-agent]")?.value).toBe("");
  });

  it("retries only refresh after a successful mutation and restores focus", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let mountReads = 0;
    const removedState = { ...mounted, mountedAgents: [] };
    const api = {
      agents: vi.fn(async () => catalog),
      memberAgentMounts: vi.fn(async () => {
        mountReads += 1;
        if (mountReads === 2) throw new Error("private refresh failure");
        return mountReads === 1 ? mounted : removedState;
      }),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(async () => undefined),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    card.querySelector("[data-remove-agent]")?.click();
    expect(documentRef.activeElement?.getAttribute("data-focus-key"))
      .toBe("pending");
    expect(card.querySelector('[role="status"]')?.getAttribute("aria-live"))
      .toBe("polite");
    await flush();
    await flush();
    expect(api.unmountAgent).toHaveBeenCalledTimes(1);
    expect(card.textContent).toContain("无法确认当前 Agent 配置");
    expect(card.textContent).not.toContain("尚未挂载");
    expect(card.querySelector("[data-add-agent-trigger]")).toBeNull();
    expect(documentRef.activeElement?.getAttribute("data-agent-refresh-retry"))
      .toBe("");

    card.querySelector("[data-agent-refresh-retry]")?.click();
    await flush();
    await flush();
    expect(api.unmountAgent).toHaveBeenCalledTimes(1);
    expect(api.memberAgentMounts).toHaveBeenCalledTimes(3);
    expect(card.textContent).toContain("未分配");
    expect(documentRef.activeElement?.getAttribute("data-focus-key"))
      .toBe("add-menu");
  });

  it("sets and clears a nullable default from refreshed server state", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let serverMounts = mounted;
    const api = {
      agents: vi.fn(async () => catalog),
      memberAgentMounts: vi.fn(async () => serverMounts),
      mountAgent: vi.fn(),
      unmountAgent: vi.fn(),
      setDefaultAgent: vi.fn(async (_personRef: string, agentRef: string | null) => {
        serverMounts = {
          ...mounted,
          defaultAgentRef: agentRef,
          mountedAgents: mounted.mountedAgents.map((agent) => ({
            ...agent,
            isDefault: agent.agentRef === agentRef
          }))
        };
      })
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;

    const selectDefault = card.querySelector("[data-default-agent]");
    if (selectDefault) selectDefault.value = "agent:hermes-zzh";
    card.querySelector("[data-save-default-agent]")?.click();
    await flush();
    await flush();
    expect(api.setDefaultAgent).toHaveBeenLastCalledWith(
      "person:alice",
      "agent:hermes-zzh"
    );
    expect(card.querySelector("[data-default-agent]")?.value)
      .toBe("agent:hermes-zzh");
    expect(card.textContent).toContain("默认");

    const clearDefault = card.querySelector("[data-default-agent]");
    if (clearDefault) clearDefault.value = "";
    card.querySelector("[data-save-default-agent]")?.click();
    await flush();
    await flush();
    expect(api.setDefaultAgent).toHaveBeenLastCalledWith(
      "person:alice",
      null
    );
    expect(card.querySelector("[data-default-agent]")?.value).toBe("");
    expect(api.memberAgentMounts).toHaveBeenCalledTimes(3);
  });

  it("shows a bounded error and retries the failed mutation", async () => {
    const { renderMemberAgentControls } = await agentsModule();
    const documentRef = new TestDocument();
    const card = documentRef.createElement("article");
    let mountAttempts = 0;
    let serverMounts: typeof mounted | { mountedAgents: never[] } = { mountedAgents: [] };
    const api = {
      agents: vi.fn(async () => catalog),
      memberAgentMounts: vi.fn(async () => serverMounts),
      mountAgent: vi.fn(async () => {
        mountAttempts += 1;
        if (mountAttempts === 1) throw new Error("private provider path");
        serverMounts = mounted;
      }),
      unmountAgent: vi.fn(),
      setDefaultAgent: vi.fn()
    };
    const controller = renderMemberAgentControls({
      documentRef,
      root: card,
      personRef: "person:alice",
      api,
      confirmImpl: () => true
    });
    await controller.ready;
    card.querySelector("[data-add-agent-trigger]")?.click();
    card.querySelector('[data-mount-agent="agent:hermes-zzh"]')?.click();
    await flush();

    expect(card.textContent).toContain("暂时无法完成");
    expect(card.textContent).not.toContain("private provider path");
    expect(card.querySelector('[role="alert"]')?.getAttribute("aria-live"))
      .toBe("polite");
    expect(documentRef.activeElement?.getAttribute("data-focus-key"))
      .toBe("mutation-retry");
    card.querySelector("[data-agent-retry]")?.click();
    await flush();
    await flush();
    expect(api.mountAgent).toHaveBeenCalledTimes(2);
    expect(api.memberAgentMounts).toHaveBeenCalledTimes(3);
    expect(card.querySelector("[data-remove-agent]")).not.toBeNull();
  });
});

describe("Admin Agent API client", () => {
  it("uses encoded POST, DELETE, and PUT paths without sending private Provider data", async () => {
    const { createAdminApi } = await apiModule();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/v1/admin/agents") return Response.json(rawCatalog);
      return Response.json(mounted, {
        status: init.method === "POST" ? 201 : 200
      });
    });
    const api = createAdminApi({
      fetchImpl,
      credential: {
        kind: "entry",
        entrySessionRef: "entry-session:preview-admin",
        token
      }
    });

    await api.agents();
    await api.memberAgentMounts("person:alice");
    await api.mountAgent("person:alice", "agent:hermes-nsy");
    await api.unmountAgent("person:alice", "agent:hermes-zzh");
    await api.setDefaultAgent("person:alice", null);

    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
      ["/api/v1/admin/agents", "GET"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts", "GET"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts", "POST"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts/agent%3Ahermes-zzh", "DELETE"],
      ["/api/v1/admin/members/person%3Aalice/default-agent", "PUT"]
    ]);
    expect(JSON.parse(String(requests[2]!.init.body))).toEqual({
      agentRef: "agent:hermes-nsy"
    });
    expect(requests[3]!.init.body).toBeUndefined();
    expect(JSON.parse(String(requests[4]!.init.body))).toEqual({
      agentRef: null
    });
    const serializedRequests = JSON.stringify(requests);
    expect(serializedRequests).not.toContain("providerProfileRef");
    expect(serializedRequests).not.toContain("externalSessionRef");
    expect(serializedRequests).not.toContain("provider-profile:private");

    await expect(api.memberAgentMounts("person:alice/../../private"))
      .rejects.toThrow("ADMIN_PERSON_REF_INVALID");
    await expect(api.mountAgent("person:alice", "agent:bad/ref"))
      .rejects.toThrow("ADMIN_AGENT_REF_INVALID");
  });

  it("rejects status values outside the public catalog enum", async () => {
    const { createAdminApi } = await apiModule();
    const api = createAdminApi({
      credential: {
        kind: "entry",
        entrySessionRef: "entry-session:preview-admin",
        token
      },
      fetchImpl: async () => Response.json({
        ...rawCatalog,
        agents: rawCatalog.agents.map((agent, index) =>
          index === 0 ? { ...agent, status: "disabled" } : agent
        )
      })
    });
    await expect(api.agents()).rejects.toMatchObject({
      code: "ADMIN_AGENTS_INVALID",
      status: 502
    });
  });
});
