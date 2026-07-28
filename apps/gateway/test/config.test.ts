import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/config.js";

const token = "configuration-test-token-with-enough-length";

describe("Gateway configuration", () => {
  it("defaults to development loopback and a disposable runtime database", () => {
    const config = loadGatewayConfig({ GATEWAY_DEVICE_TOKEN: token });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      mode: "development",
      deviceToken: token
    });
    expect(config.databasePath).toContain(".runtime/data/gateway.sqlite");
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

  it("requires the development Admin Preview persistence path and origin together", () => {
    expect(loadGatewayConfig({
      GATEWAY_DEVICE_TOKEN: token,
      GATEWAY_PREVIEW_ADMIN_ENTRY_PATH: "/tmp/family-ai/admin-entry.json",
      GATEWAY_PREVIEW_ADMIN_ORIGIN: "http://127.0.0.1:8791"
    })).toMatchObject({
      previewAdminEntryPath: "/tmp/family-ai/admin-entry.json",
      previewAdminOrigin: "http://127.0.0.1:8791"
    });
    for (const env of [
      { GATEWAY_PREVIEW_ADMIN_ENTRY_PATH: "/tmp/family-ai/admin-entry.json" },
      { GATEWAY_PREVIEW_ADMIN_ORIGIN: "http://127.0.0.1:8791" }
    ]) {
      expect(() => loadGatewayConfig({
        GATEWAY_DEVICE_TOKEN: token,
        ...env
      })).toThrow("configured together");
    }
    expect(() => loadGatewayConfig({
      GATEWAY_DEVICE_TOKEN: token,
      GATEWAY_MODE: "test",
      GATEWAY_PREVIEW_ADMIN_ENTRY_PATH: "/tmp/family-ai/admin-entry.json",
      GATEWAY_PREVIEW_ADMIN_ORIGIN: "http://127.0.0.1:8791"
    })).toThrow("development-only");
  });

  it("rejects missing or short development Tokens", () => {
    expect(() => loadGatewayConfig({})).toThrow("GATEWAY_DEVICE_TOKEN");
    expect(() => loadGatewayConfig({ GATEWAY_DEVICE_TOKEN: "short" })).toThrow(
      "GATEWAY_DEVICE_TOKEN"
    );
  });

  it("rejects production until an explicit production runtime composition exists", () => {
    expect(() =>
      loadGatewayConfig({
        GATEWAY_MODE: "production",
        GATEWAY_HOST: "127.0.0.1"
      })
    ).toThrow("production runtime composition");
  });
});
