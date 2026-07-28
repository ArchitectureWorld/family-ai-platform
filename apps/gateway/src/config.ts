import { resolve } from "node:path";
import type { GatewayMode } from "./app.js";

export interface GatewayConfig {
  host: string;
  port: number;
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  previewAdminEntryPath?: string;
  previewAdminOrigin?: string;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mode = (env.GATEWAY_MODE ?? "development") as GatewayMode;
  if (!("test development production".split(" ") as GatewayMode[]).includes(mode)) {
    throw new Error("GATEWAY_MODE must be test, development, or production");
  }
  if (mode === "production") {
    throw new Error(
      "GATEWAY_MODE=production requires an explicit production runtime composition; " +
        "the development binary must not bootstrap test identities or a Fake Provider."
    );
  }

  const host = env.GATEWAY_HOST ?? "127.0.0.1";
  const containerized = env.GATEWAY_CONTAINERIZED === "true";
  if (host !== "127.0.0.1" && !(containerized && host === "0.0.0.0")) {
    throw new Error("Gateway must bind to loopback unless running in the approved container profile");
  }

  const port = positiveInteger(env.GATEWAY_PORT, 8790, "GATEWAY_PORT");
  if (port > 65535) throw new Error("GATEWAY_PORT must be at most 65535");

  const deviceToken = env.GATEWAY_DEVICE_TOKEN;
  if (!deviceToken || deviceToken.length < 24) {
    throw new Error("GATEWAY_DEVICE_TOKEN must contain at least 24 characters");
  }

  const previewAdminEntryPath = env.GATEWAY_PREVIEW_ADMIN_ENTRY_PATH;
  const previewAdminOrigin = env.GATEWAY_PREVIEW_ADMIN_ORIGIN;
  if ((previewAdminEntryPath === undefined) !== (previewAdminOrigin === undefined)) {
    throw new Error(
      "GATEWAY_PREVIEW_ADMIN_ENTRY_PATH and GATEWAY_PREVIEW_ADMIN_ORIGIN must be configured together"
    );
  }
  if (
    (previewAdminEntryPath !== undefined || previewAdminOrigin !== undefined) &&
    mode !== "development"
  ) {
    throw new Error("Admin Preview persistence is development-only");
  }

  return {
    host,
    port,
    databasePath: resolve(env.GATEWAY_DATABASE_PATH ?? ".runtime/data/gateway.sqlite"),
    deviceToken,
    mode,
    ...(previewAdminEntryPath === undefined
      ? {}
      : {
          previewAdminEntryPath: resolve(previewAdminEntryPath),
          previewAdminOrigin: previewAdminOrigin!
        })
  };
}
