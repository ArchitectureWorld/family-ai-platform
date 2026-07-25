import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/config.js";

const token = "configuration-test-token-with-enough-length";

describe("Gateway configuration", () => {
  it("defaults to development loopback and no explicit Provider runtime file", () => {
    const config = loadGatewayConfig({ GATEWAY_DEVICE_TOKEN: token });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      mode: "development",
      deviceToken: token,
      providerConfigPath: null
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
      GATEWAY_PROVIDER_CONFIG_PATH: ".runtime/config/providers.json"
    });
    expect(config).toMatchObject({
      mode: "production",
      providerConfigPath: expect.stringMatching(/providers\.json$/)
    });
  });
});
