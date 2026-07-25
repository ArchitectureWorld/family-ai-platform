import { describe, expect, it, vi } from "vitest";
import type { ProviderInvocationRequest } from "@family-ai/contracts";
import { loadRuntimeProviderAdapter } from "../src/providerRuntime.js";

const request: ProviderInvocationRequest = {
  protocolVersion: "1.0",
  invocationRef: "invocation:runtime-test-0001",
  correlationRef: "correlation:runtime-test-0001",
  idempotencyKey: "thread-turn:runtime-test-0001",
  requestedAt: "2026-07-25T12:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-zzh",
  targetAgentRef: "agent:yutu",
  conversationRef: "conversation:runtime-test-0001",
  content: [{ type: "text", text: "你好" }],
  timeoutMs: 30000
};

const providerJson = JSON.stringify({
  version: 1,
  profiles: [{
    kind: "hermes",
    providerProfileRef: "provider-profile:hermes-zzh",
    baseUrl: "http://host.docker.internal:8651",
    apiKey: "runtime-hermes-key-with-safe-length",
    model: "zzh",
    sessionKey: "family-ai:hermes:zzh"
  }]
});

function completion() {
  return new Response(JSON.stringify({
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "真实 Hermes 回复。" },
      finish_reason: "stop"
    }]
  }), { status: 200 });
}

describe("runtime Provider composition", () => {
  it("keeps the Fake Provider when development has no runtime file", async () => {
    const adapter = loadRuntimeProviderAdapter({
      mode: "development",
      providerConfigPath: null,
      clock: () => new Date("2026-07-25T12:00:02.000Z")
    });

    await expect(adapter.invoke({
      ...request,
      providerProfileRef: "provider-profile:fake-local"
    })).resolves.toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "Fake Provider 第 1 轮回复。" }]
    });
  });

  it("routes Fake and Hermes profiles together in development", async () => {
    const fetchImpl = vi.fn(async () => completion()) as typeof fetch;
    const adapter = loadRuntimeProviderAdapter({
      mode: "development",
      providerConfigPath: "/runtime/providers.json",
      readFile: (path) => {
        expect(path).toBe("/runtime/providers.json");
        return providerJson;
      },
      fetchImpl,
      clock: () => new Date("2026-07-25T12:00:02.000Z")
    });

    const fake = await adapter.invoke({
      ...request,
      providerProfileRef: "provider-profile:fake-local"
    });
    const hermes = await adapter.invoke(request);

    expect(fake.status).toBe("succeeded");
    expect(hermes).toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "真实 Hermes 回复。" }]
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit real Provider file in production", () => {
    expect(() => loadRuntimeProviderAdapter({
      mode: "production",
      providerConfigPath: null
    })).toThrow("production requires GATEWAY_PROVIDER_CONFIG_PATH");
  });

  it("uses only real Provider routes in production", async () => {
    const adapter = loadRuntimeProviderAdapter({
      mode: "production",
      providerConfigPath: "/runtime/providers.json",
      readFile: () => providerJson,
      fetchImpl: vi.fn(async () => completion()) as typeof fetch,
      clock: () => new Date("2026-07-25T12:00:02.000Z")
    });

    await expect(adapter.invoke({
      ...request,
      providerProfileRef: "provider-profile:fake-local"
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_PROFILE_UNAVAILABLE" }
    });
    await expect(adapter.invoke(request)).resolves.toMatchObject({ status: "succeeded" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown top-level field", JSON.stringify({ version: 1, profiles: [], secret: true })],
    ["wrong version", JSON.stringify({ version: 2, profiles: [] })],
    ["empty profiles", JSON.stringify({ version: 1, profiles: [] })],
    ["duplicate profiles", JSON.stringify({
      version: 1,
      profiles: [
        JSON.parse(providerJson).profiles[0],
        JSON.parse(providerJson).profiles[0]
      ]
    })],
    ["unsafe URL", JSON.stringify({
      version: 1,
      profiles: [{
        ...JSON.parse(providerJson).profiles[0],
        baseUrl: "file:///tmp/hermes.sock"
      }]
    })],
    ["URL credentials", JSON.stringify({
      version: 1,
      profiles: [{
        ...JSON.parse(providerJson).profiles[0],
        baseUrl: "http://user:password@host.docker.internal:8651"
      }]
    })],
    ["short key", JSON.stringify({
      version: 1,
      profiles: [{
        ...JSON.parse(providerJson).profiles[0],
        apiKey: "short"
      }]
    })],
    ["unknown kind", JSON.stringify({
      version: 1,
      profiles: [{
        ...JSON.parse(providerJson).profiles[0],
        kind: "codex"
      }]
    })]
  ])("rejects %s", (_name, source) => {
    expect(() => loadRuntimeProviderAdapter({
      mode: "production",
      providerConfigPath: "/runtime/providers.json",
      readFile: () => source
    })).toThrow();
  });

  it("does not expose a runtime key through health", async () => {
    const adapter = loadRuntimeProviderAdapter({
      mode: "production",
      providerConfigPath: "/runtime/providers.json",
      readFile: () => providerJson,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "zzh", object: "model" }]
      }), { status: 200 })) as typeof fetch
    });
    const health = await adapter.health();
    expect(JSON.stringify(health)).not.toContain("runtime-hermes-key");
    expect(JSON.stringify(health)).not.toContain("host.docker.internal");
  });
});
