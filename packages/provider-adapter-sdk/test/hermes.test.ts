import { describe, expect, it, vi } from "vitest";
import type { ProviderInvocationRequest } from "@family-ai/contracts";
import {
  HermesProviderAdapter,
  hermesExternalSessionRef
} from "../src/index.js";

const request: ProviderInvocationRequest = {
  protocolVersion: "1.0",
  invocationRef: "invocation:hermes-test-0001",
  correlationRef: "correlation:hermes-test-0001",
  idempotencyKey: "thread-turn:hermes-test-0001",
  requestedAt: "2026-07-25T12:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-zzh",
  targetAgentRef: "agent:yutu",
  conversationRef: "conversation:thread-chat-0001",
  content: [{ type: "text", text: "你好", language: "zh-CN" }],
  timeoutMs: 30000
};

function completion(text = "于途已经接入。") {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1784980800,
    model: "zzh",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop"
    }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function adapter(fetchImpl: typeof fetch) {
  return new HermesProviderAdapter({
    profiles: [{
      providerProfileRef: "provider-profile:hermes-zzh",
      baseUrl: "http://hermes.test:8651/",
      apiKey: "runtime-key-with-safe-length",
      model: "zzh",
      sessionKey: "family-ai:hermes:zzh"
    }],
    fetchImpl,
    clock: () => new Date("2026-07-25T12:00:02.000Z")
  });
}

describe("HermesProviderAdapter", () => {
  it("sends the formal Hermes headers and maps the final assistant text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://hermes.test:8651/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer runtime-key-with-safe-length");
      expect(headers.get("idempotency-key")).toBe(request.idempotencyKey);
      expect(headers.get("x-hermes-session-id")).toBe(
        hermesExternalSessionRef(request.providerProfileRef, request.conversationRef)
      );
      expect(headers.get("x-hermes-session-key")).toBe("family-ai:hermes:zzh");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "zzh",
        messages: [{ role: "user", content: "你好" }],
        stream: false
      });
      return completion();
    }) as typeof fetch;

    const result = await adapter(fetchImpl).invoke(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      protocolVersion: "1.0",
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-25T12:00:02.000Z",
      output: [{ type: "text", text: "于途已经接入。" }],
      externalSessionRef: hermesExternalSessionRef(
        request.providerProfileRef,
        request.conversationRef
      )
    });
  });

  it("reuses an existing external Session exactly", async () => {
    const existing = "external-session:hermes-existing-0001";
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-hermes-session-id")).toBe(existing);
      return completion("继续原来的上下文。");
    }) as typeof fetch;

    const result = await adapter(fetchImpl).invoke({
      ...request,
      externalSessionRef: existing
    });

    expect(result).toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "继续原来的上下文。" }],
      externalSessionRef: existing
    });
  });
});
