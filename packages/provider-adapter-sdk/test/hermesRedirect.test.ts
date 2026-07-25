import { describe, expect, it, vi } from "vitest";
import type { ProviderInvocationRequest } from "@family-ai/contracts";
import { HermesProviderAdapter } from "../src/index.js";

const request: ProviderInvocationRequest = {
  protocolVersion: "1.0",
  invocationRef: "invocation:redirect-test-0001",
  correlationRef: "correlation:redirect-test-0001",
  idempotencyKey: "thread-turn:redirect-test-0001",
  requestedAt: "2026-07-25T12:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-zzh",
  targetAgentRef: "agent:yutu",
  conversationRef: "conversation:redirect-test-0001",
  content: [{ type: "text", text: "你好" }],
  timeoutMs: 30000
};

describe("Hermes HTTP redirect policy", () => {
  it("never follows a redirect with the Hermes Bearer credential", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      redirects.push(init?.redirect);
      if (String(_input).endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          object: "list",
          data: [{ id: "zzh", object: "model" }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "完成。" },
          finish_reason: "stop"
        }]
      }), { status: 200 });
    }) as typeof fetch;
    const adapter = new HermesProviderAdapter({
      profiles: [{
        providerProfileRef: "provider-profile:hermes-zzh",
        baseUrl: "http://hermes.test:8651",
        apiKey: "redirect-test-key-with-safe-length",
        model: "zzh",
        sessionKey: "family-ai:hermes:zzh"
      }],
      fetchImpl
    });

    await adapter.invoke(request);
    await adapter.health();

    expect(redirects).toEqual(["error", "error"]);
  });
});
