import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/index.js";
import { ProviderAdapterRouter } from "../src/providerRouter.js";

function adapter(name: string): ProviderAdapter {
  return {
    async health() {
      return {
        protocolVersion: 1,
        adapterRef: `adapter:${name}`,
        status: "online",
        providerProfiles: [`provider-profile:${name}`],
        checkedAt: "2026-07-28T12:00:00.000Z"
      };
    },
    async invoke() {
      throw new Error("not used");
    }
  };
}

describe("ProviderAdapterRouter", () => {
  it("resolves each persisted provider profile to its configured adapter", () => {
    const hermes = adapter("hermes-jarvis");
    const codex = adapter("codex-cli");
    const router = new ProviderAdapterRouter([
      ["provider-profile:hermes-jarvis", hermes],
      ["provider-profile:codex-cli", codex]
    ]);

    expect(router.resolve("provider-profile:hermes-jarvis")).toBe(hermes);
    expect(router.resolve("provider-profile:codex-cli")).toBe(codex);
    expect(() => router.resolve("provider-profile:missing"))
      .toThrow("PROVIDER_ADAPTER_NOT_CONFIGURED");
  });

  it("wraps the legacy single adapter for the fake-local profile", () => {
    const legacy = adapter("fake-local");
    const router = ProviderAdapterRouter.single(
      "provider-profile:fake-local",
      legacy
    );

    expect(router.resolve("provider-profile:fake-local")).toBe(legacy);
  });
});
