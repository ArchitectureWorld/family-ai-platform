import {
  accessSync,
  constants,
  lstatSync,
  realpathSync
} from "node:fs";
import { resolve } from "node:path";
import {
  CodexCliProviderAdapter,
  FakeProviderAdapter,
  HermesCliProviderAdapter,
  ProviderAdapterRouter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import type { GatewayMode } from "./app.js";
import type { ConfiguredAgentRuntime } from "./agentManagement.js";

export interface FakeGatewayProviderRuntimeConfig {
  mode: "fake";
}

export interface RealGatewayProviderRuntimeConfig {
  mode: "real";
  hermes: {
    executable: string;
    jarvisHome: string;
    personalHome: string;
    profiles: readonly string[];
  };
  codex: {
    executable: string;
    workingDirectory: string;
  };
}

export type GatewayProviderRuntimeConfig =
  | FakeGatewayProviderRuntimeConfig
  | RealGatewayProviderRuntimeConfig;

export interface GatewayProviderRuntime {
  router: ProviderAdapterRouter;
  agents: readonly ConfiguredAgentRuntime[];
}

export interface GatewayConfig {
  host: string;
  port: number;
  databasePath: string;
  deviceToken: string;
  mode: GatewayMode;
  providerRuntime: GatewayProviderRuntimeConfig;
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

function runtimeConfigurationError(): Error {
  return new Error("Provider runtime configuration is invalid");
}

function existingExecutable(raw: string | undefined): string {
  if (!raw) throw runtimeConfigurationError();
  try {
    const path = resolve(raw);
    const information = lstatSync(path);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw runtimeConfigurationError();
    }
    accessSync(path, constants.X_OK);
    return realpathSync(path);
  } catch {
    throw runtimeConfigurationError();
  }
}

function existingDirectory(raw: string | undefined): string {
  if (!raw) throw runtimeConfigurationError();
  try {
    const path = resolve(raw);
    const information = lstatSync(path);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw runtimeConfigurationError();
    }
    return realpathSync(path);
  } catch {
    throw runtimeConfigurationError();
  }
}

function profileNames(raw: string | undefined): readonly string[] {
  if (!raw) throw runtimeConfigurationError();
  const profiles = raw.split(",").map(value => value.trim().toLowerCase());
  if (
    profiles.length === 0 ||
    profiles.some(profile => !/^[a-z0-9_-]+$/.test(profile)) ||
    new Set(profiles).size !== profiles.length
  ) {
    throw runtimeConfigurationError();
  }
  return profiles;
}

function providerRuntimeConfig(env: NodeJS.ProcessEnv): GatewayProviderRuntimeConfig {
  const mode = env.FAMILY_AI_PROVIDER_MODE ?? "fake";
  if (mode === "fake") return { mode };
  if (mode !== "real") throw runtimeConfigurationError();
  const runtime: RealGatewayProviderRuntimeConfig = {
    mode,
    hermes: {
      executable: existingExecutable(env.FAMILY_AI_HERMES_EXECUTABLE),
      jarvisHome: existingDirectory(env.FAMILY_AI_HERMES_JARVIS_HOME),
      personalHome: existingDirectory(env.FAMILY_AI_HERMES_PERSONAL_HOME),
      profiles: profileNames(env.FAMILY_AI_HERMES_PROFILES)
    },
    codex: {
      executable: existingExecutable(env.FAMILY_AI_CODEX_EXECUTABLE),
      workingDirectory: existingDirectory(
        env.FAMILY_AI_CODEX_WORKING_DIRECTORY
      )
    }
  };
  Object.defineProperty(runtime, "toJSON", {
    value: () => ({ mode: "real" }),
    enumerable: false
  });
  return runtime;
}

function controlledEnvironment(
  additional: ReadonlyArray<readonly [string, string]> = []
): Array<readonly [string, string]> {
  return [
    ["HOME", process.env.HOME ?? "/tmp"],
    ["LANG", process.env.LANG ?? "C.UTF-8"],
    ["PATH", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"],
    ["TERM", process.env.TERM ?? "dumb"],
    ...additional
  ];
}

export function buildProviderRuntime(
  config: GatewayProviderRuntimeConfig
): GatewayProviderRuntime {
  if (config.mode === "fake") {
    const adapter = new FakeProviderAdapter();
    return {
      router: ProviderAdapterRouter.single(
        "provider-profile:fake-local",
        adapter
      ),
      agents: []
    };
  }

  const routes: Array<readonly [string, ProviderAdapter]> = [];
  const agents: ConfiguredAgentRuntime[] = [];
  const jarvisProviderRef = "provider-profile:hermes-jarvis";
  routes.push([
    jarvisProviderRef,
    new HermesCliProviderAdapter({
      executable: config.hermes.executable,
      cwd: config.hermes.jarvisHome,
      allowedEnvironment: controlledEnvironment([
        ["HERMES_HOME", config.hermes.jarvisHome]
      ]),
      providerProfileRef: jarvisProviderRef
    })
  ] as const);
  agents.push({
    agentRef: "agent:hermes-jarvis",
    providerProfileRef: jarvisProviderRef,
    providerKind: "hermes",
    displayName: "Jarvis"
  });

  for (const profileName of config.hermes.profiles) {
    const providerProfileRef = `provider-profile:hermes-${profileName}`;
    routes.push([
      providerProfileRef,
      new HermesCliProviderAdapter({
        executable: config.hermes.executable,
        cwd: config.hermes.personalHome,
        allowedEnvironment: controlledEnvironment([
          ["HERMES_HOME", config.hermes.personalHome]
        ]),
        profileName,
        providerProfileRef
      })
    ] as const);
    agents.push({
      agentRef: `agent:hermes-${profileName}`,
      providerProfileRef,
      providerKind: "hermes",
      displayName: profileName
    });
  }

  const codexProviderRef = "provider-profile:codex-cli";
  routes.push([
    codexProviderRef,
    new CodexCliProviderAdapter({
      executable: config.codex.executable,
      cwd: config.codex.workingDirectory,
      allowedEnvironment: controlledEnvironment(),
      providerProfileRef: codexProviderRef
    })
  ] as const);
  agents.push({
    agentRef: "agent:codex-cli",
    providerProfileRef: codexProviderRef,
    providerKind: "codex",
    displayName: "Codex"
  });

  return {
    router: new ProviderAdapterRouter(routes),
    agents
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mode = (env.GATEWAY_MODE ?? "development") as GatewayMode;
  if (!("test development production".split(" ") as GatewayMode[]).includes(mode)) {
    throw new Error("GATEWAY_MODE must be test, development, or production");
  }
  const providerRuntime = providerRuntimeConfig(env);
  if (mode === "production" && providerRuntime.mode !== "real") {
    throw new Error(
      "GATEWAY_MODE=production requires an explicit real Provider runtime"
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

  const config = {
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
  Object.defineProperty(config, "providerRuntime", {
    value: providerRuntime,
    enumerable: false
  });
  return config as GatewayConfig;
}
