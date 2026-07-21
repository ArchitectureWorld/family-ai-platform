import { describe, expect, it } from "vitest";
import {
  messageEnvelopeSchema,
  providerInvocationRequestSchema,
  providerInvocationResultSchema
} from "../src/index.js";

const message = {
  protocolVersion: "1.0",
  messageRef: "message:018f47a2-1f10-7a3d-8c2d-61f369284f15",
  correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f16",
  idempotencyKey: "device:test:message:0001",
  occurredAt: "2026-07-21T09:00:00.000Z",
  source: { kind: "device", ref: "device:test" },
  target: { kind: "agent", ref: "agent:personal-assistant" },
  payload: { type: "text", text: "第一轮测试消息。", language: "zh-CN" }
} as const;

describe("message envelope", () => {
  it("accepts a strict versioned text message", () => {
    expect(messageEnvelopeSchema.parse(message)).toEqual(message);
  });

  it.each([
    { ...message, protocolVersion: "2.0" },
    { ...message, payload: { type: "text", text: "" } },
    { ...message, source: { kind: "device", ref: "agent:wrong-kind" } },
    { ...message, databaseId: 42 }
  ])("rejects invalid or private fields", (candidate) => {
    expect(messageEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("provider invocation", () => {
  const request = {
    protocolVersion: "1.0",
    invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f17",
    correlationRef: message.correlationRef,
    idempotencyKey: message.idempotencyKey,
    requestedAt: "2026-07-21T09:00:00.100Z",
    providerProfileRef: "provider-profile:fake-local",
    targetAgentRef: "agent:personal-assistant",
    conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f18",
    content: [{ type: "text", text: "第一轮测试消息。" }],
    timeoutMs: 30000
  } as const;

  it("rejects runtime paths and unsupported fields", () => {
    expect(providerInvocationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      providerInvocationRequestSchema.safeParse({ ...request, executablePath: "/usr/bin/fake" })
        .success
    ).toBe(false);
  });

  it("requires output for success and a safe error for failure", () => {
    expect(
      providerInvocationResultSchema.safeParse({
        protocolVersion: "1.0",
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "succeeded",
        completedAt: "2026-07-21T09:00:01.000Z",
        output: [{ type: "text", text: "Fake Provider 第 1 轮回复。" }],
        externalSessionRef: "external-session:fake-1"
      }).success
    ).toBe(true);

    expect(
      providerInvocationResultSchema.safeParse({
        protocolVersion: "1.0",
        invocationRef: request.invocationRef,
        correlationRef: request.correlationRef,
        status: "failed",
        completedAt: "2026-07-21T09:00:01.000Z",
        error: {
          code: "PROVIDER_UNAVAILABLE",
          category: "availability",
          message: "个人助理暂时不可用。",
          retryable: true
        }
      }).success
    ).toBe(true);
  });
});
