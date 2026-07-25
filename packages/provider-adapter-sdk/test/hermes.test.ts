import { describe, expect, it, vi } from "vitest";
import type { ProviderInvocationRequest } from "@family-ai/contracts";
import {
  HermesProviderAdapter,
  hermesExternalSessionRef
} from "../src/index.js";

const apiKey = "runtime-key-with-safe-length";
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
      apiKey,
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
      expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
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

  it.each([
    [401, "HERMES_AUTH_FAILED", "permission", false],
    [403, "HERMES_AUTH_FAILED", "permission", false],
    [408, "HERMES_BUSY", "availability", true],
    [429, "HERMES_BUSY", "availability", true],
    [500, "HERMES_UNAVAILABLE", "availability", true],
    [503, "HERMES_UNAVAILABLE", "availability", true],
    [400, "HERMES_REQUEST_REJECTED", "validation", false]
  ] as const)(
    "maps Hermes HTTP %s without leaking the upstream body",
    async (status, code, category, retryable) => {
      const fetchImpl = vi.fn(async () => new Response(
        `upstream detail includes ${apiKey}`,
        { status }
      )) as typeof fetch;

      const result = await adapter(fetchImpl).invoke(request);

      expect(result).toMatchObject({
        status: "failed",
        error: { code, category, retryable }
      });
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(JSON.stringify(result)).not.toContain("upstream detail");
    }
  );

  it("maps an AbortError to a formal timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;

    await expect(adapter(fetchImpl).invoke(request)).resolves.toMatchObject({
      status: "timed_out",
      error: {
        code: "HERMES_TIMEOUT",
        category: "timeout",
        retryable: true
      }
    });
  });

  it("maps network exceptions without exposing their text", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`connect refused ${apiKey}`);
    }) as typeof fetch;

    const result = await adapter(fetchImpl).invoke(request);
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "HERMES_UNAVAILABLE",
        category: "availability",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    completion("   ")
  ])("rejects an invalid successful response", async (response) => {
    const fetchImpl = vi.fn(async () => response.clone()) as typeof fetch;
    await expect(adapter(fetchImpl).invoke(request)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "HERMES_RESPONSE_INVALID",
        category: "internal",
        retryable: true
      }
    });
  });

  it("reports online, degraded and offline health without exposing profile secrets", async () => {
    const profiles = [
      {
        providerProfileRef: "provider-profile:hermes-jarvis",
        baseUrl: "http://hermes.test:8650",
        apiKey: "jarvis-runtime-key-safe-length",
        model: "jarvis",
        sessionKey: "family-ai:hermes:jarvis"
      },
      {
        providerProfileRef: "provider-profile:hermes-zzh",
        baseUrl: "http://hermes.test:8651",
        apiKey,
        model: "zzh",
        sessionKey: "family-ai:hermes:zzh"
      }
    ];
    const responseFor = (input: string | URL | Request, failing = new Set<string>()) => {
      const url = String(input);
      if (failing.has(url)) return new Response(null, { status: 503 });
      const model = url.includes(":8650") ? "jarvis" : "zzh";
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: model, object: "model" }]
      }), { status: 200 });
    };
    const build = (failing: Set<string>) => new HermesProviderAdapter({
      profiles,
      fetchImpl: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
        return responseFor(input, failing);
      }) as typeof fetch,
      clock: () => new Date("2026-07-25T12:00:02.000Z")
    });

    const online = await build(new Set()).health();
    const degraded = await build(new Set(["http://hermes.test:8650/v1/models"])).health();
    const offline = await build(new Set([
      "http://hermes.test:8650/v1/models",
      "http://hermes.test:8651/v1/models"
    ])).health();

    expect(online.status).toBe("online");
    expect(degraded.status).toBe("degraded");
    expect(offline.status).toBe("offline");
    expect(online.providerProfiles).toEqual([
      "provider-profile:hermes-jarvis",
      "provider-profile:hermes-zzh"
    ]);
    expect(JSON.stringify([online, degraded, offline])).not.toContain("runtime-key");
    expect(JSON.stringify([online, degraded, offline])).not.toContain("hermes.test");
  });

  it("rejects unsafe profile configuration before a request is sent", () => {
    expect(() => new HermesProviderAdapter({
      profiles: [{
        providerProfileRef: "provider-profile:hermes-zzh",
        baseUrl: "https://user:password@hermes.test:8651/v1?secret=yes",
        apiKey,
        model: "zzh",
        sessionKey: "family-ai:hermes:zzh"
      }]
    })).toThrow("must not contain credentials");
  });
});
