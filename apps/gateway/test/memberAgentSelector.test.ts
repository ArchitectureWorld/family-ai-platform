import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../member-public/api.js";
import { chooseInitialAgent } from "../member-public/agent-selector.js";
import {
  createMemoryCache,
  readBootstrapSnapshot,
  saveMeta,
  saveWorksForAgent
} from "../member-public/cache.js";

function mounted(agentRef: string) {
  return {
    assignmentRef: `assignment:${agentRef.slice("agent:".length)}`,
    agentRef,
    displayName: agentRef === "agent:a" ? "Agent A" : "Agent B",
    providerProfileRef: `provider-profile:${agentRef.slice("agent:".length)}`,
    isDefault: false,
    status: "idle",
    statusLabel: "空闲"
  };
}

describe("Member Agent selection policy", () => {
  it("requires an explicit selection when Agents are mounted without a default", () => {
    expect(chooseInitialAgent({
      mountedAgents: [mounted("agent:a")],
      defaultAgentRef: null
    }, null)).toEqual({ kind: "selection_required" });
  });

  it("reports an unconfigured member and ignores stale device selection", () => {
    expect(chooseInitialAgent({
      mountedAgents: [],
      defaultAgentRef: null
    }, "agent:stale")).toEqual({ kind: "unconfigured" });
  });

  it("selects the mounted server default initially", () => {
    expect(chooseInitialAgent({
      mountedAgents: [{ ...mounted("agent:a"), isDefault: true }],
      defaultAgentRef: "agent:a"
    }, null)).toEqual({ kind: "selected", agentRef: "agent:a" });
  });

  it("lets a saved temporary choice win only while that Agent remains mounted", () => {
    const context = {
      mountedAgents: [
        { ...mounted("agent:a"), isDefault: true },
        mounted("agent:b")
      ],
      defaultAgentRef: "agent:a"
    };

    expect(chooseInitialAgent(context, "agent:b")).toEqual({
      kind: "selected",
      agentRef: "agent:b"
    });
    expect(chooseInitialAgent({
      mountedAgents: [{ ...mounted("agent:a"), isDefault: true }],
      defaultAgentRef: "agent:a"
    }, "agent:b")).toEqual({
      kind: "selected",
      agentRef: "agent:a"
    });
  });
});

describe("Member Agent API and offline projection", () => {
  it("sends the selected Agent on Agent-scoped Chat and Work requests", async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    const api = createApiClient(vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, body: init.body?.toString() });
      return Response.json({ protocolVersion: 1 });
    }) as typeof fetch);

    await api.getHomeChat("agent:a", "Asia/Shanghai");
    await api.listWorks("agent:a");
    await api.createWork({
      protocolVersion: 1,
      agentRef: "agent:a",
      title: "Agent A Work",
      goal: "只属于 Agent A"
    });

    expect(requests).toEqual([
      {
        path: "/api/v1/chat?agentRef=agent%3Aa&timezone=Asia%2FShanghai",
        body: undefined
      },
      {
        path: "/api/v1/work-conversations?agentRef=agent%3Aa",
        body: undefined
      },
      {
        path: "/api/v1/work-conversations",
        body: JSON.stringify({
          protocolVersion: 1,
          agentRef: "agent:a",
          title: "Agent A Work",
          goal: "只属于 Agent A"
        })
      }
    ]);
  });

  it("replaces cached Works for one Agent without deleting another Agent projection", async () => {
    const cache = createMemoryCache();
    const work = (agentRef: string, suffix: string) => ({
      workConversationRef: `work:${suffix}`,
      threadRef: `thread:work-${suffix}`,
      agentRef,
      title: suffix,
      goal: suffix,
      lastActiveAt: "2026-07-28T10:00:00.000Z"
    });

    await saveWorksForAgent(cache, "agent:a", [
      work("agent:a", "a-old")
    ]);
    await saveWorksForAgent(cache, "agent:b", [
      work("agent:b", "b-kept")
    ]);
    await saveWorksForAgent(cache, "agent:a", [
      work("agent:a", "a-new")
    ]);
    await saveMeta(cache, "selectedAgentRef", "agent:b");
    await saveMeta(cache, "selectedWorkRef:agent:a", "work:a-new");
    await saveMeta(cache, "selectedWorkRef:agent:b", "work:b-kept");

    await expect(readBootstrapSnapshot(cache, "agent:a")).resolves.toMatchObject({
      selectedAgentRef: "agent:b",
      selectedWorkRef: "work:a-new",
      works: [{ workConversationRef: "work:a-new", agentRef: "agent:a" }]
    });
    await expect(readBootstrapSnapshot(cache, "agent:b")).resolves.toMatchObject({
      selectedAgentRef: "agent:b",
      selectedWorkRef: "work:b-kept",
      works: [{ workConversationRef: "work:b-kept", agentRef: "agent:b" }]
    });
    await expect(readBootstrapSnapshot(cache)).resolves.toMatchObject({
      works: [
        { workConversationRef: "work:a-new" },
        { workConversationRef: "work:b-kept" }
      ]
    });
  });
});
