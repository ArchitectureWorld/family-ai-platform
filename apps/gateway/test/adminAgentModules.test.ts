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

  focus() {
    if (!this.disabled) this.ownerDocument.activeElement = this;
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
      agentRef: "agent:mounted",
      displayName: "家庭助理",
      status: "working",
      statusLabel: "工作中",
      activeTurnCount: 1,
      lastCheckedAt: "2026-07-28T10:00:00.000Z",
      publicProblem: null
    },
    {
      agentRef: "agent:not-mounted",
      displayName: "研究助理",
      status: "problem",
      statusLabel: "有问题",
      activeTurnCount: 0,
      lastCheckedAt: "2026-07-28T10:00:00.000Z",
      publicProblem: "Agent 当前无法连接。"
    }
  ]
};

const mounted = {
  protocolVersion: 1,
  personRef: "person:alice",
  defaultAgentRef: null,
  mountedAgents: [{
    assignmentRef: "assignment:alice-mounted",
    agentRef: "agent:mounted",
    displayName: "家庭助理",
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
  it("filters only this member's active mounts and renders safe, accessible status controls", async () => {
    const { availableAgentOptions, renderMemberAgentControls } = await agentsModule();
    const addOptions = availableAgentOptions(catalog.agents, mounted.mountedAgents);
    expect(addOptions.map((option: { agentRef: string }) => option.agentRef))
      .toEqual(["agent:not-mounted"]);
    expect(
      availableAgentOptions(catalog.agents, [])
        .map((option: { agentRef: string }) => option.agentRef)
    ).toEqual(["agent:mounted", "agent:not-mounted"]);

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

    expect(card.querySelector("[data-remove-agent]")?.textContent).toBe("×");
    expect(card.querySelector("[data-remove-agent]")?.tagName).toBe("button");
    expect(card.querySelector("[data-remove-agent]")?.getAttribute("aria-label"))
      .toBe("移除 家庭助理");
    expect(card.textContent).toContain("工作中");
    expect(card.textContent).toContain("有问题");
    expect(card.textContent).not.toContain("provider-profile:private");
    expect(card.textContent).not.toContain("Session");
    const addTrigger = card.querySelector("[data-add-agent-trigger]");
    const addMenu = card.querySelector("[data-add-agent-menu]");
    expect(addTrigger?.textContent).toBe("+");
    expect(addTrigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(addTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(addMenu?.getAttribute("role")).toBe("menu");
    expect(addMenu?.hidden).toBe(true);
    addTrigger?.click();
    expect(card.querySelector("[data-add-agent-menu]")?.hidden).toBe(false);
    expect(card.querySelector("[data-add-agent-trigger]")?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(
      card.querySelectorAll("[data-mount-agent]")
        .map((option) => option.getAttribute("data-mount-agent"))
    ).toEqual(["agent:not-mounted"]);
    expect(documentRef.activeElement?.getAttribute("data-mount-agent"))
      .toBe("agent:not-mounted");
    expect(card.querySelector("[data-default-agent]")?.value).toBe("");
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
    expect(card.textContent).toContain("家庭助理");
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
    expect(card.textContent).toContain("尚未挂载");
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
    expect(card.textContent).toContain("尚未挂载");
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
    if (selectDefault) selectDefault.value = "agent:mounted";
    card.querySelector("[data-save-default-agent]")?.click();
    await flush();
    await flush();
    expect(api.setDefaultAgent).toHaveBeenLastCalledWith(
      "person:alice",
      "agent:mounted"
    );
    expect(card.querySelector("[data-default-agent]")?.value)
      .toBe("agent:mounted");
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
    card.querySelector('[data-mount-agent="agent:mounted"]')?.click();
    await flush();

    expect(card.textContent).toContain("暂时无法完成");
    expect(card.textContent).not.toContain("private provider path");
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
      if (url === "/api/v1/admin/agents") return Response.json(catalog);
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
    await api.mountAgent("person:alice", "agent:not-mounted");
    await api.unmountAgent("person:alice", "agent:mounted");
    await api.setDefaultAgent("person:alice", null);

    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
      ["/api/v1/admin/agents", "GET"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts", "GET"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts", "POST"],
      ["/api/v1/admin/members/person%3Aalice/agent-mounts/agent%3Amounted", "DELETE"],
      ["/api/v1/admin/members/person%3Aalice/default-agent", "PUT"]
    ]);
    expect(JSON.parse(String(requests[2]!.init.body))).toEqual({
      agentRef: "agent:not-mounted"
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
        ...catalog,
        agents: [{ ...catalog.agents[0], status: "disabled" }]
      })
    });
    await expect(api.agents()).rejects.toMatchObject({
      code: "ADMIN_AGENTS_INVALID",
      status: 502
    });
  });
});
