import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/config.js";

const token = "configuration-test-token-with-enough-length";

describe("Gateway configuration", () => {
  it("defaults to development loopback with no Provider file or Agent preset", () => {
    const config = loadGatewayConfig({ GATEWAY_DEVICE_TOKEN: token });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      mode: "development",
      deviceToken: token,
      providerConfigPath: null,
      assignmentPreset: null
    });
    expect(config.databasePath).toContain(".runtime/data/gateway.sqlite");
  });

  it("resolves an optional development Provider config path", () => {
    const config = loadGatewayConfig({
      GATEWAY_DEVICE_TOKEN: token,
      GATEWAY_PROVIDER_CONFIG_PATH: ".runtime/config/providers.json"
    });
    expect(config.providerConfigPath).toMatch(/\.runtime\/config\/providers\.json$/);
  });

  it("accepts only the reviewed Jarvis and Yutu assignment preset", () => {
    expect(loadGatewayConfig({
      GATEWAY_DEVICE_TOKEN: token,
      GATEWAY_AGENT_ASSIGNMENT_PRESET: "hermes-jarvis-yutu-v1"
    }).assignmentPreset).toBe("hermes-jarvis-yutu-v1");

    for (const value of [
      "jarvis",
      "HERMES-JARVIS-YUTU-V1",
      "hermes-jarvis-yutu-v2",
      "agent:yutu",
      "hermes-jarvis-yutu-v1,other"
    ]) {
      expect(() => loadGatewayConfig({
        GATEWAY_DEVICE_TOKEN: token,
        GATEWAY_AGENT_ASSIGNMENT_PRESET: value
      })).toThrow("GATEWAY_AGENT_ASSIGNMENT_PRESET");
    }
  });

  it("rejects non-loopback binding outside the approved container profile", () => {
    expect(() =>
      loadGatewayConfig({
        GATEWAY_DEVICE_TOKEN: token,
        GATEWAY_HOST: "0.0.0.0"
      })
    ).toThrow("loopback");
    expect(() =>
      loadGatewayConfig({
        GATEWAY_DEVICE_TOKEN: token,
        GATEWAY_HOST: "192.168.1.8"
      })
    ).toThrow("loopback");
  });

  it("allows container all-interface binding only when explicitly declared", () => {
    expect(
      loadGatewayConfig({
        GATEWAY_DEVICE_TOKEN: token,
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_CONTAINERIZED: "true"
      }).host
    ).toBe("0.0.0.0");
  });

  it("rejects missing or short development Tokens", () => {
    expect(() => loadGatewayConfig({})).toThrow("GATEWAY_DEVICE_TOKEN");
    expect(() => loadGatewayConfig({ GATEWAY_DEVICE_TOKEN: "short" })).toThrow(
      "GATEWAY_DEVICE_TOKEN"
    );
  });

  it("requires an explicit Provider runtime file in production", () => {
    expect(() =>
      loadGatewayConfig({
        GATEWAY_MODE: "production",
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_DEVICE_TOKEN: token
      })
    ).toThrow("GATEWAY_PROVIDER_CONFIG_PATH");
  });

  it("accepts production when the runtime Provider path is explicit", () => {
    const config = loadGatewayConfig({
      GATEWAY_MODE: "production",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_DEVICE_TOKEN: token,
      GATEWAY_PROVIDER_CONFIG_PATH: ".runtime/config/providers.json",
      GATEWAY_AGENT_ASSIGNMENT_PRESET: "hermes-jarvis-yutu-v1"
    });
    expect(config).toMatchObject({
      mode: "production",
      providerConfigPath: expect.stringMatching(/providers\.json$/),
      assignmentPreset: "hermes-jarvis-yutu-v1"
    });
  });
});
