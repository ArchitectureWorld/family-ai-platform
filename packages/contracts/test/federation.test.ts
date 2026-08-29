import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as federationContracts from "../src/federation.js";
import {
  agentDescriptorV1Schema,
  agentInvocationRequestV1Schema,
  agentInvocationResultV1Schema,
  federationActorContextV1Schema,
  federationAgentListV1Schema,
  federationInvocationPostResponseV1Schema,
  federationInvocationResponseV1Schema,
  federationInvocationStatusV1Schema
} from "../src/federation.js";
import { federationActorContextV1Schema as publicFederationActorContextV1Schema } from "../src/index.js";
import * as publicContracts from "../src/index.js";

const actor = {
  protocolVersion: 1,
  contextRef: "actor-context:ctx-1",
  product: "canvas",
  familyRef: "family:demo",
  personRef: "person:demo",
  deviceRef: "device:demo",
  entrySessionRef: "entry-session:demo",
  personDisplayName: "管理员",
  familyDisplayName: "演示家庭",
  roles: ["family_admin"],
  assignmentVersion: 7,
  contextVersion: 3,
  expiresAt: "2030-01-01T00:01:00.000Z"
};

const agent = {
  protocolVersion: 1,
  agentRef: "agent:demo",
  displayName: "Demo Agent",
  kind: "agent",
  runtime: "hermes-local",
  status: "available",
  capabilities: ["chat"],
  system: false,
  observedAt: "2030-01-01T00:00:00.000Z"
};

const invocation = {
  protocolVersion: 1,
  invocationRef: "invocation:demo-1",
  correlationRef: "correlation:demo-1",
  product: "canvas",
  actorContextRef: "actor-context:ctx-1",
  agentRef: "agent:demo",
  localSessionRef: "local-session:demo-1",
  prompt: "帮我规划晚餐",
  timeoutMs: 30000
};

const result = {
  protocolVersion: 1,
  invocationRef: "invocation:demo-1",
  correlationRef: "correlation:demo-1",
  status: "succeeded" as const,
  output: "已规划三道菜。",
  completedAt: "2030-01-01T00:00:30.000Z",
  externalSessionRef: "external-session:opaque-demo-1"
};

const scope = {
  serviceRef: "service:canvas",
  product: "canvas" as const,
  actorContextRef: actor.contextRef,
  familyRef: actor.familyRef,
  personRef: actor.personRef,
  agentRef: agent.agentRef,
  localSessionRef: invocation.localSessionRef
};

const liveResponse = {
  protocolVersion: 1 as const,
  scope,
  correlationRef: invocation.correlationRef,
  result
};

describe("Family federation and Agent invocation contracts v1", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts the literal Actor fixture and bounded public Agent contracts", () => {
    expect(federationActorContextV1Schema.parse(actor)).toEqual(actor);
    expect(publicFederationActorContextV1Schema.parse(actor)).toEqual(actor);
    expect(agentDescriptorV1Schema.parse(agent)).toEqual(agent);
    expect(agentInvocationRequestV1Schema.parse(invocation)).toEqual(invocation);
    expect(
      agentInvocationResultV1Schema.parse(result)
    ).toMatchObject({ status: "succeeded", output: "已规划三道菜。" });
  });

  it("preserves exact invocation prompt code units while rejecting blank or oversized input", () => {
    for (const prompt of ["  x  ", "\t多 字节🙂\n", "x".repeat(12_000)]) {
      expect(agentInvocationRequestV1Schema.parse({ ...invocation, prompt }).prompt)
        .toBe(prompt);
    }
    for (const prompt of ["", "   ", "\t\n", "x".repeat(12_001)]) {
      expect(agentInvocationRequestV1Schema.safeParse({ ...invocation, prompt }).success)
        .toBe(false);
    }
    expect(agentInvocationResultV1Schema.parse({ ...result, output: "  保持原输出语义  " }).output)
      .toBe("保持原输出语义");
  });

  it("rejects unknown fields on every public object and keeps paths and secrets out", () => {
    expect(agentDescriptorV1Schema.safeParse({ ...agent, unexpected: true }).success).toBe(false);
    expect(
      federationActorContextV1Schema.safeParse({ ...actor, serviceIdentity: "broker:local" }).success
    ).toBe(false);
    expect(
      agentInvocationRequestV1Schema.safeParse({ ...invocation, unexpected: true }).success
    ).toBe(false);
    expect(agentInvocationResultV1Schema.safeParse({ ...result, stderr: "raw provider error" }).success).toBe(
      false
    );
    expect(agentDescriptorV1Schema.safeParse({ ...agent, token: "test-token" }).success).toBe(false);
    expect(agentInvocationRequestV1Schema.safeParse({ ...invocation, localPath: "/srv/agent" }).success).toBe(
      false
    );
    expect(agentInvocationRequestV1Schema.safeParse({ ...invocation, agentRef: "/srv/agent" }).success).toBe(
      false
    );
  });

  it("rejects empty scopes, unsupported products, and expired Actors", () => {
    expect(federationActorContextV1Schema.safeParse({ ...actor, roles: [] }).success).toBe(false);
    expect(federationActorContextV1Schema.safeParse({ ...actor, product: "browser" }).success).toBe(
      false
    );
    expect(
      federationActorContextV1Schema.safeParse({
        ...actor,
        expiresAt: "2000-01-01T00:00:00.000Z"
      }).success
    ).toBe(false);
    expect(federationActorContextV1Schema.safeParse({ ...actor, contextVersion: 0 }).success)
      .toBe(false);
    expect(federationActorContextV1Schema.safeParse({
      ...actor,
      personDisplayName: "名".repeat(81)
    }).success).toBe(false);
    expect(federationActorContextV1Schema.safeParse({
      ...actor,
      familyDisplayName: "家庭\n注入"
    }).success).toBe(false);
    expect(federationActorContextV1Schema.safeParse({
      ...actor,
      personDisplayName: "坏\ud800名称"
    }).success).toBe(false);
  });

  it("does not publish an allocation authority contract", () => {
    expect(federationContracts).not.toHaveProperty("AgentInvocationAuthorityV1");
    expect(federationContracts).not.toHaveProperty("agentInvocationAuthorityV1Schema");
    expect(publicContracts).not.toHaveProperty("agentInvocationAuthorityV1Schema");
  });

  it("publishes strict scoped Agent list and live invocation envelopes", () => {
    expect(federationAgentListV1Schema.parse({
      protocolVersion: 1,
      scope: {
        serviceRef: scope.serviceRef,
        product: scope.product,
        actorContextRef: scope.actorContextRef,
        familyRef: scope.familyRef,
        personRef: scope.personRef,
        assignmentVersion: 7,
        contextVersion: 3
      },
      agents: [agent]
    })).toMatchObject({ agents: [{ agentRef: agent.agentRef }] });
    expect(federationInvocationResponseV1Schema.parse(liveResponse)).toEqual(liveResponse);
    expect(federationInvocationPostResponseV1Schema.parse(liveResponse)).toEqual(liveResponse);
    expect(federationInvocationResponseV1Schema.safeParse({
      ...liveResponse,
      scope: { ...scope, unexpected: true }
    }).success).toBe(false);
    expect(federationInvocationResponseV1Schema.safeParse({
      ...liveResponse,
      correlationRef: "correlation:other"
    }).success).toBe(false);
  });

  it("publishes a strict output-free invocation recovery union", () => {
    const accepted = {
      protocolVersion: 1 as const,
      invocationRef: invocation.invocationRef,
      correlationRef: invocation.correlationRef,
      scope,
      status: "accepted" as const,
      leaseExpiresAt: "2030-01-01T00:00:30.000Z",
      retryAfter: 30
    };
    const succeeded = {
      protocolVersion: 1 as const,
      invocationRef: invocation.invocationRef,
      correlationRef: invocation.correlationRef,
      scope,
      status: "succeeded" as const,
      externalSessionRef: result.externalSessionRef,
      completedAt: result.completedAt,
      outputAvailable: false as const
    };
    const failed = {
      protocolVersion: 1 as const,
      invocationRef: invocation.invocationRef,
      correlationRef: invocation.correlationRef,
      scope,
      status: "failed" as const,
      completedAt: result.completedAt,
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    };
    for (const status of [accepted, succeeded, failed]) {
      expect(federationInvocationStatusV1Schema.parse(status)).toEqual(status);
      expect(federationInvocationPostResponseV1Schema.parse(status)).toEqual(status);
    }
    expect(federationInvocationStatusV1Schema.safeParse({
      ...succeeded,
      output: "private output"
    }).success).toBe(false);
    expect(federationInvocationStatusV1Schema.safeParse({
      ...accepted,
      retryAfter: 0
    }).success).toBe(false);
    expect(federationInvocationStatusV1Schema.safeParse({
      ...failed,
      errorCode: "raw error"
    }).success).toBe(false);
  });
});
