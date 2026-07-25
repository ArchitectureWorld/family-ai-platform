import { resolve } from "node:path";
import type { AgentAssignmentPreset } from "./agentAssignments.js";
import type { GatewayMode } from "./app.js";

export interface GatewayConfig {
  host: string;
  port: number;
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  providerConfigPath: string | null;
  assignmentPreset: AgentAssignmentPreset | null;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assignmentPreset(raw: string | undefined): AgentAssignmentPreset | null {
  if (raw === undefined || raw.length === 0) return null;
  if (raw !== "hermes-jarvis-yutu-v1") {
    throw new Error(
      "GATEWAY_AGENT_ASSIGNMENT_PRESET must be hermes-jarvis-yutu-v1 when provided"
    );
  }
  return raw;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mode = (env.GATEWAY_MODE ?? "development") as GatewayMode;
  if (!("test development production".split(" ") as GatewayMode[]).includes(mode)) {
    throw new Error("GATEWAY_MODE must be test, development, or production");
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

  const providerConfigRaw = env.GATEWAY_PROVIDER_CONFIG_PATH?.trim() ?? "";
  if (mode === "production" && providerConfigRaw.length === 0) {
    throw new Error("GATEWAY_PROVIDER_CONFIG_PATH is required in production");
  }

  return {
    host,
    port,
    databasePath: resolve(env.GATEWAY_DATABASE_PATH ?? ".runtime/data/gateway.sqlite"),
    deviceToken,
    mode,
    providerConfigPath: providerConfigRaw.length > 0 ? resolve(providerConfigRaw) : null,
    assignmentPreset: assignmentPreset(env.GATEWAY_AGENT_ASSIGNMENT_PRESET)
  };
}
