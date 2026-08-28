import { describe, expect, it } from "vitest";
import {
  agentDescriptorV1Schema,
  agentInvocationAuthorityV1Schema,
  agentInvocationRequestV1Schema,
  agentInvocationResultV1Schema,
  federationActorContextV1Schema
} from "../src/federation.js";
import { federationActorContextV1Schema as publicFederationActorContextV1Schema } from "../src/index.js";

const actor = {
  protocolVersion: 1,
  contextRef: "actor-context:ctx-1",
  product: "canvas",
  familyRef: "family:demo",
  personRef: "person:demo",
  deviceRef: "device:demo",
  entrySessionRef: "entry-session:demo",
  roles: ["family_admin"],
  assignmentVersion: 7,
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

describe("Family federation and Agent invocation contracts v1", () => {
  it("accepts the literal Actor fixture and bounded public Agent contracts", () => {
    expect(federationActorContextV1Schema.parse(actor)).toEqual(actor);
    expect(publicFederationActorContextV1Schema.parse(actor)).toEqual(actor);
    expect(agentDescriptorV1Schema.parse(agent)).toEqual(agent);
    expect(agentInvocationRequestV1Schema.parse(invocation)).toEqual(invocation);
    expect(
      agentInvocationResultV1Schema.parse({
        protocolVersion: 1,
        invocationRef: "invocation:demo-1",
        correlationRef: "correlation:demo-1",
        status: "succeeded",
        output: "已规划三道菜。",
        completedAt: "2030-01-01T00:00:30.000Z",
        externalSessionRef: "external-session:opaque-demo-1"
      })
    ).toMatchObject({ status: "succeeded", output: "已规划三道菜。" });
  });

  it("rejects extra identity data, empty scopes, unsupported products, expired Actors, and raw paths", () => {
    expect(
      federationActorContextV1Schema.safeParse({ ...actor, serviceIdentity: "broker:local" }).success
    ).toBe(false);
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
    expect(agentInvocationRequestV1Schema.safeParse({ ...invocation, agentRef: "/srv/agent" }).success).toBe(
      false
    );
    expect(
      agentInvocationResultV1Schema.safeParse({
        protocolVersion: 1,
        invocationRef: "invocation:demo-1",
        correlationRef: "correlation:demo-1",
        status: "failed",
        output: "调用未完成",
        completedAt: "2030-01-01T00:00:30.000Z",
        externalSessionRef: "external-session:opaque-demo-1",
        stderr: "raw provider error"
      }).success
    ).toBe(false);
  });

  it("binds an invocation to the Actor context, person, product, and assigned Agent", () => {
    const authority = {
      actor,
      personRef: "person:demo",
      agentRef: "agent:demo",
      invocation
    };

    expect(agentInvocationAuthorityV1Schema.safeParse(authority).success).toBe(true);
    expect(
      agentInvocationAuthorityV1Schema.safeParse({
        ...authority,
        agentRef: "agent:other"
      }).success
    ).toBe(false);
    expect(
      agentInvocationAuthorityV1Schema.safeParse({
        ...authority,
        personRef: "person:other"
      }).success
    ).toBe(false);
    expect(
      agentInvocationAuthorityV1Schema.safeParse({
        ...authority,
        invocation: { ...invocation, product: "me" }
      }).success
    ).toBe(false);
  });
});
