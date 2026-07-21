import { describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "../src/index.js";

const baseRequest = {
  protocolVersion: "1.0" as const,
  invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f21",
  correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f22",
  idempotencyKey: "device:test:message:0001",
  requestedAt: "2026-07-21T09:00:00.000Z",
  providerProfileRef: "provider-profile:fake-local",
  targetAgentRef: "agent:personal-assistant",
  conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f23",
  content: [{ type: "text" as const, text: "第一轮。" }],
  timeoutMs: 30000
};

describe("FakeProviderAdapter", () => {
  it("preserves one external session across two turns", async () => {
    const adapter = new FakeProviderAdapter();
    const first = await adapter.invoke(baseRequest);
    expect(first.status).toBe("succeeded");
    expect(first.externalSessionRef).toMatch(/^external-session:fake-/);
    expect(first.output?.[0]).toEqual({ type: "text", text: "Fake Provider 第 1 轮回复。" });

    const second = await adapter.invoke({
      ...baseRequest,
      invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f24",
      idempotencyKey: "device:test:message:0002",
      content: [{ type: "text", text: "第二轮。" }],
      externalSessionRef: first.externalSessionRef
    });

    expect(second.externalSessionRef).toBe(first.externalSessionRef);
    expect(second.output?.[0]).toEqual({ type: "text", text: "Fake Provider 第 2 轮回复。" });
  });

  it("returns a safe structured failure without internal details", async () => {
    const adapter = new FakeProviderAdapter({ failNext: true });
    const result = await adapter.invoke(baseRequest);
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "PROVIDER_UNAVAILABLE",
        category: "availability",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(JSON.stringify(result)).not.toContain("stderr");
  });
});
