import { describe, expect, it } from "vitest";
import {
  adminAgentCatalogResponseSchema,
  memberAgentMountsResponseSchema,
  mountMemberAgentRequestSchema,
  setDefaultAgentRequestSchema
} from "../src/index.js";

describe("Agent management protocol v1", () => {
  it("accepts reusable Agent status and a member with no default", () => {
    expect(
      adminAgentCatalogResponseSchema.parse({
        protocolVersion: 1,
        agents: [
          {
            agentRef: "agent:codex-cli",
            displayName: "Codex CLI",
            status: "working",
            statusLabel: "工作中",
            activeTurnCount: 2,
            lastCheckedAt: "2026-07-28T10:00:00.000Z",
            publicProblem: null
          }
        ]
      }).agents[0]?.status
    ).toBe("working");

    expect(
      memberAgentMountsResponseSchema.parse({
        protocolVersion: 1,
        personRef: "person:alice",
        defaultAgentRef: null,
        mountedAgents: []
      }).defaultAgentRef
    ).toBeNull();
    expect(setDefaultAgentRequestSchema.parse({ agentRef: null })).toEqual({ agentRef: null });
  });

  it("requires a mounted default to exist exactly once and be marked default", () => {
    const mountedAgent = {
      assignmentRef: "assignment:alice-codex-cli",
      agentRef: "agent:codex-cli",
      displayName: "Codex CLI",
      providerProfileRef: "provider-profile:codex-cli",
      isDefault: true,
      status: "idle",
      statusLabel: "空闲"
    };
    const response = {
      protocolVersion: 1,
      personRef: "person:alice",
      defaultAgentRef: "agent:codex-cli",
      mountedAgents: [mountedAgent]
    };

    expect(memberAgentMountsResponseSchema.safeParse(response).success).toBe(true);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        defaultAgentRef: "agent:missing"
      }).success
    ).toBe(false);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        mountedAgents: [{ ...mountedAgent, isDefault: false }]
      }).success
    ).toBe(false);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        mountedAgents: [mountedAgent, mountedAgent]
      }).success
    ).toBe(false);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        defaultAgentRef: null,
        mountedAgents: [
          { ...mountedAgent, agentRef: "agent:non-default", isDefault: false },
          { ...mountedAgent, agentRef: "agent:non-default", isDefault: false }
        ]
      }).success
    ).toBe(false);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        defaultAgentRef: null
      }).success
    ).toBe(false);
    expect(
      memberAgentMountsResponseSchema.safeParse({
        ...response,
        mountedAgents: [
          mountedAgent,
          { ...mountedAgent, agentRef: "agent:another-default", isDefault: true }
        ]
      }).success
    ).toBe(false);
    expect(mountMemberAgentRequestSchema.parse({ agentRef: "agent:codex-cli" })).toEqual({
      agentRef: "agent:codex-cli"
    });
  });

  it("rejects unallowlisted public Agent problems", () => {
    const agent = {
      agentRef: "agent:codex-cli",
      displayName: "Codex CLI",
      status: "problem",
      statusLabel: "有问题",
      activeTurnCount: 0,
      lastCheckedAt: "2026-07-28T10:00:00.000Z"
    };

    expect(
      adminAgentCatalogResponseSchema.safeParse({
        protocolVersion: 1,
        agents: [{ ...agent, publicProblem: "Agent 当前无法连接。" }]
      }).success
    ).toBe(true);
    expect(
      adminAgentCatalogResponseSchema.safeParse({
        protocolVersion: 1,
        agents: [{ ...agent, publicProblem: "Agent 状态尚未初始化。" }]
      }).success
    ).toBe(true);
    expect(
      adminAgentCatalogResponseSchema.safeParse({
        protocolVersion: 1,
        agents: [{ ...agent, publicProblem: "provider error: token expired" }]
      }).success
    ).toBe(false);
  });
});
