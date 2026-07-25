import { describe, expect, it } from "vitest";
import type {
  AdapterHealth,
  ProviderInvocationRequest,
  ProviderInvocationResult
} from "@family-ai/contracts";
import {
  ProviderAdapterRouter,
  type ProviderAdapter
} from "../src/index.js";

const request: ProviderInvocationRequest = {
  protocolVersion: "1.0",
  invocationRef: "invocation:router-test-0001",
  correlationRef: "correlation:router-test-0001",
  idempotencyKey: "thread-turn:router-test-0001",
  requestedAt: "2026-07-25T12:00:00.000Z",
  providerProfileRef: "provider-profile:hermes-zzh",
  targetAgentRef: "agent:yutu",
  conversationRef: "conversation:router-test-0001",
  content: [{ type: "text", text: "你好" }],
  timeoutMs: 30000
};

class RecordingAdapter implements ProviderAdapter {
  readonly calls: ProviderInvocationRequest[] = [];

  constructor(
    private readonly adapterRef: string,
    private readonly profiles: string[],
    private readonly status: AdapterHealth["status"] = "online"
  ) {}

  async invoke(input: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    this.calls.push(structuredClone(input));
    return {
      protocolVersion: "1.0",
      invocationRef: input.invocationRef,
      correlationRef: input.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-25T12:00:01.000Z",
      output: [{ type: "text", text: this.adapterRef }],
      externalSessionRef: `external-session:${this.adapterRef.replace("adapter:", "")}`
    };
  }

  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: "1.0",
      adapterRef: this.adapterRef,
      status: this.status,
      providerProfiles: this.profiles,
      checkedAt: "2026-07-25T12:00:01.000Z"
    };
  }
}

describe("ProviderAdapterRouter", () => {
  it("routes a request only to its exact Provider Profile owner", async () => {
    const fake = new RecordingAdapter("adapter:fake-route", ["provider-profile:fake-local"]);
    const hermes = new RecordingAdapter("adapter:hermes-route", [
      "provider-profile:hermes-jarvis",
      "provider-profile:hermes-zzh"
    ]);
    const router = new ProviderAdapterRouter([
      { providerProfileRefs: ["provider-profile:fake-local"], adapter: fake },
      {
        providerProfileRefs: [
          "provider-profile:hermes-jarvis",
          "provider-profile:hermes-zzh"
        ],
        adapter: hermes
      }
    ]);

    const result = await router.invoke(request);

    expect(result).toMatchObject({
      status: "succeeded",
      output: [{ type: "text", text: "adapter:hermes-route" }]
    });
    expect(fake.calls).toEqual([]);
    expect(hermes.calls).toHaveLength(1);
  });

  it("returns a formal failure for an unregistered Profile without fallback", async () => {
    const fake = new RecordingAdapter("adapter:fake-route", ["provider-profile:fake-local"]);
    const router = new ProviderAdapterRouter([
      { providerProfileRefs: ["provider-profile:fake-local"], adapter: fake }
    ], () => new Date("2026-07-25T12:00:03.000Z"));

    const result = await router.invoke(request);

    expect(result).toEqual({
      protocolVersion: "1.0",
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "failed",
      completedAt: "2026-07-25T12:00:03.000Z",
      error: {
        code: "PROVIDER_PROFILE_UNAVAILABLE",
        category: "availability",
        message: "当前 Provider Profile 暂时不可用。",
        retryable: true
      }
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects duplicate Profile ownership during construction", () => {
    const first = new RecordingAdapter("adapter:first", ["provider-profile:hermes-zzh"]);
    const second = new RecordingAdapter("adapter:second", ["provider-profile:hermes-zzh"]);
    expect(() => new ProviderAdapterRouter([
      { providerProfileRefs: ["provider-profile:hermes-zzh"], adapter: first },
      { providerProfileRefs: ["provider-profile:hermes-zzh"], adapter: second }
    ])).toThrow("Duplicate Provider Profile route");
  });

  it("aggregates health with offline taking precedence over degraded and online", async () => {
    const online = new RecordingAdapter(
      "adapter:online",
      ["provider-profile:fake-local"],
      "online"
    );
    const degraded = new RecordingAdapter(
      "adapter:degraded",
      ["provider-profile:hermes-zzh"],
      "degraded"
    );
    const offline = new RecordingAdapter(
      "adapter:offline",
      ["provider-profile:hermes-jarvis"],
      "offline"
    );
    const router = new ProviderAdapterRouter([
      { providerProfileRefs: ["provider-profile:fake-local"], adapter: online },
      { providerProfileRefs: ["provider-profile:hermes-zzh"], adapter: degraded },
      { providerProfileRefs: ["provider-profile:hermes-jarvis"], adapter: offline }
    ], () => new Date("2026-07-25T12:00:04.000Z"));

    await expect(router.health()).resolves.toEqual({
      protocolVersion: "1.0",
      adapterRef: "adapter:provider-router",
      status: "offline",
      providerProfiles: [
        "provider-profile:fake-local",
        "provider-profile:hermes-jarvis",
        "provider-profile:hermes-zzh"
      ],
      checkedAt: "2026-07-25T12:00:04.000Z"
    });
  });
});
