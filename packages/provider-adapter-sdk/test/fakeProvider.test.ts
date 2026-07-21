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
  it("continues the same logical session across turns and adapter restart", async () => {
    const firstAdapter = new FakeProviderAdapter();
    const first = await firstAdapter.invoke(baseRequest);
    expect(first.status).toBe("succeeded");
    expect(first.externalSessionRef).toMatch(/^external-session:fake-.+-turn-1$/);
    expect(first.output?.[0]).toEqual({ type: "text", text: "Fake Provider 第 1 轮回复。" });
    if (!first.externalSessionRef) throw new Error("first session reference missing");

    const second = await firstAdapter.invoke({
      ...baseRequest,
      invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f24",
      idempotencyKey: "device:test:message:0002",
      content: [{ type: "text", text: "第二轮。" }],
      externalSessionRef: first.externalSessionRef
    });
    expect(second.externalSessionRef).toMatch(/^external-session:fake-.+-turn-2$/);
    expect(second.output?.[0]).toEqual({ type: "text", text: "Fake Provider 第 2 轮回复。" });
    if (!second.externalSessionRef) throw new Error("second session reference missing");

    const restartedAdapter = new FakeProviderAdapter();
    const third = await restartedAdapter.invoke({
      ...baseRequest,
      invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f25",
      idempotencyKey: "device:test:message:0003",
      content: [{ type: "text", text: "第三轮。" }],
      externalSessionRef: second.externalSessionRef
    });
    expect(third.externalSessionRef).toMatch(/^external-session:fake-.+-turn-3$/);
    expect(third.output?.[0]).toEqual({ type: "text", text: "Fake Provider 第 3 轮回复。" });
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
