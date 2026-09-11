import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync
} from "node:fs";
import { isAbsolute, parse, resolve, sep } from "node:path";
import {
  BrokerProviderAdapter,
  CodexCliProviderAdapter,
  FakeProviderAdapter,
  HermesCliProviderAdapter,
  ProviderAdapterRouter,
  type HermesPrivateInputMode,
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
    privateInputMode: HermesPrivateInputMode;
  };
  codex: {
    executable: string;
    workingDirectory: string;
  };
}

export interface BrokerGatewayProviderRuntimeConfig {
  mode: "broker";
  socketPath: string;
}

export type GatewayProviderRuntimeConfig =
  | FakeGatewayProviderRuntimeConfig
  | BrokerGatewayProviderRuntimeConfig
  | RealGatewayProviderRuntimeConfig;

export interface GatewayProviderRuntime {
  router: ProviderAdapterRouter;
  agents: readonly ConfiguredAgentRuntime[];
  authoritative: boolean;
}

export interface GatewayConfig {
  host: string;
  port: number;
  databasePath: string;
  attachmentRoot: string;
  attachmentQuotaBytes: number;
  deviceToken: string;
  mode: GatewayMode;
  providerRuntime: GatewayProviderRuntimeConfig;
  previewAdminEntryPath?: string;
  previewAdminOrigin?: string;
  adminWebEnabled: boolean;
  productionAdminEntryPath?: string;
  productionAdminActivationPath?: string;
  adminWebOrigin?: string;
  canvasBaseUrl?: string;
  canvasAllowContainerService?: boolean;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanFlag(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

function adminOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GATEWAY_ADMIN_WEB_ORIGIN must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("GATEWAY_ADMIN_WEB_ORIGIN must be a valid HTTPS origin");
  }
  return url.origin;
}

function protectedPath(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const path = resolve(raw);
  if (path === parse(path).root || path.split(sep).includes(".git")) {
    throw new Error(`${name} is unsafe`);
  }
  return path;
}

function attachmentDirectory(raw: string | undefined): string {
  const path = resolve(raw ?? ".runtime/attachments");
  const root = parse(path).root;
  if (
    path === root ||
    path === resolve(".") ||
    path.split(sep).includes(".git")
  ) {
    throw new Error("attachment storage path is unsafe");
  }
  if (existsSync(path)) {
    const information = lstatSync(path);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("attachment storage path is unsafe");
    }
    return realpathSync(path);
  }
  return path;
}

function canvasBaseUrl(raw: string | undefined, containerized: boolean): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FAMILY_AI_CANVAS_BASE_URL must be a valid URL");
  }
  const trustedHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    (containerized && url.hostname === "canvas");
  if (
    url.protocol !== "http:" ||
    !trustedHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("FAMILY_AI_CANVAS_BASE_URL must be a trusted internal HTTP origin");
  }
  return url.origin;
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

function existingUnixSocket(raw: string | undefined): string {
  if (!raw || !isAbsolute(raw) || resolve(raw) !== raw) {
    throw runtimeConfigurationError();
  }
  try {
    const information = lstatSync(raw);
    if (!information.isSocket() || information.isSymbolicLink()) {
      throw runtimeConfigurationError();
    }
    const real = realpathSync(raw);
    if (real !== raw) throw runtimeConfigurationError();
    return real;
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
    profiles.includes("jarvis") ||
    new Set(profiles).size !== profiles.length
  ) {
    throw runtimeConfigurationError();
  }
  return profiles;
}

function hermesPrivateInputMode(
  raw: string | undefined
): HermesPrivateInputMode {
  const mode = raw ?? "disabled";
  if (mode !== "disabled" && mode !== "query-stdin-v1") {
    throw runtimeConfigurationError();
  }
  return mode;
}

function providerRuntimeConfig(env: NodeJS.ProcessEnv): GatewayProviderRuntimeConfig {
  const mode = env.FAMILY_AI_PROVIDER_MODE ?? "fake";
  if (mode === "fake") return { mode };
  if (mode === "broker") {
    const runtime: BrokerGatewayProviderRuntimeConfig = {
      mode,
      socketPath: existingUnixSocket(env.FAMILY_AI_AGENT_BROKER_SOCKET)
    };
    Object.defineProperty(runtime, "toJSON", {
      value: () => ({ mode: "broker" }),
      enumerable: false
    });
    return runtime;
  }
  if (mode !== "real") throw runtimeConfigurationError();
  const runtime: RealGatewayProviderRuntimeConfig = {
    mode,
    hermes: {
      executable: existingExecutable(env.FAMILY_AI_HERMES_EXECUTABLE),
      jarvisHome: existingDirectory(env.FAMILY_AI_HERMES_JARVIS_HOME),
      personalHome: existingDirectory(env.FAMILY_AI_HERMES_PERSONAL_HOME),
      profiles: profileNames(env.FAMILY_AI_HERMES_PROFILES),
      privateInputMode: hermesPrivateInputMode(
        env.FAMILY_AI_HERMES_PRIVATE_INPUT_MODE
      )
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
      agents: [],
      authoritative: false
    };
  }

  if (config.mode === "broker") {
    const catalog = [
      {
        agentRef: "agent:hermes-jarvis",
        providerProfileRef: "provider-profile:broker-jarvis",
        providerKind: "hermes" as const,
        displayName: "Jarvis"
      },
      {
        agentRef: "agent:hermes-zzh",
        providerProfileRef: "provider-profile:broker-zzh",
        providerKind: "hermes" as const,
        displayName: "于途"
      },
      {
        agentRef: "agent:hermes-nsy",
        providerProfileRef: "provider-profile:broker-nsy",
        providerKind: "hermes" as const,
        displayName: "乔晶晶"
      }
    ] satisfies readonly ConfiguredAgentRuntime[];
    return {
      router: new ProviderAdapterRouter(
        catalog.map((agent) => [
          agent.providerProfileRef,
          new BrokerProviderAdapter({
            socketPath: config.socketPath,
            targetAgentRef: agent.agentRef,
            providerProfileRef: agent.providerProfileRef
          })
        ] as const)
      ),
      agents: catalog,
      authoritative: true
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
      providerProfileRef: jarvisProviderRef,
      privateInputMode: config.hermes.privateInputMode
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
        providerProfileRef,
        privateInputMode: config.hermes.privateInputMode
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
    agents,
    authoritative: true
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mode = (env.GATEWAY_MODE ?? "development") as GatewayMode;
  if (!("test development production".split(" ") as GatewayMode[]).includes(mode)) {
    throw new Error("GATEWAY_MODE must be test, development, or production");
  }
  const providerRuntime = providerRuntimeConfig(env);
  if (mode === "production" && providerRuntime.mode === "fake") {
    throw new Error(
      "GATEWAY_MODE=production requires an explicit non-Fake Provider runtime"
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

  const attachmentRoot = attachmentDirectory(env.FAMILY_AI_ATTACHMENT_ROOT);
  const configuredCanvasBaseUrl = canvasBaseUrl(
    env.FAMILY_AI_CANVAS_BASE_URL,
    containerized
  );
  const attachmentQuotaBytes = positiveInteger(
    env.FAMILY_AI_ATTACHMENT_QUOTA_BYTES,
    21474836480,
    "FAMILY_AI_ATTACHMENT_QUOTA_BYTES"
  );
  if (!Number.isSafeInteger(attachmentQuotaBytes)) {
    throw new Error("FAMILY_AI_ATTACHMENT_QUOTA_BYTES must be a safe integer");
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

  const adminWebFlag = booleanFlag(env.GATEWAY_ADMIN_WEB_ENABLED, "GATEWAY_ADMIN_WEB_ENABLED");
  const adminWebEnabled = adminWebFlag ?? mode === "development";
  const adminWebOrigin = adminOrigin(env.GATEWAY_ADMIN_WEB_ORIGIN);
  const productionAdminEntryPath = protectedPath(
    env.GATEWAY_PRODUCTION_ADMIN_ENTRY_PATH,
    "GATEWAY_PRODUCTION_ADMIN_ENTRY_PATH"
  );
  const productionAdminActivationPath = protectedPath(
    env.GATEWAY_PRODUCTION_ADMIN_ACTIVATION_PATH,
    "GATEWAY_PRODUCTION_ADMIN_ACTIVATION_PATH"
  );
  if (mode === "production" && adminWebEnabled) {
    if (
      productionAdminEntryPath === undefined ||
      productionAdminActivationPath === undefined ||
      adminWebOrigin === undefined
    ) {
      throw new Error(
        "Production Admin Web requires GATEWAY_PRODUCTION_ADMIN_ENTRY_PATH, " +
        "GATEWAY_PRODUCTION_ADMIN_ACTIVATION_PATH, and GATEWAY_ADMIN_WEB_ORIGIN"
      );
    }
  }
  if (
    (productionAdminEntryPath === undefined) !==
    (productionAdminActivationPath === undefined)
  ) {
    throw new Error(
      "Production Admin Web paths must be configured together"
    );
  }

  const config = {
    host,
    port,
    databasePath: resolve(env.GATEWAY_DATABASE_PATH ?? ".runtime/data/gateway.sqlite"),
    attachmentRoot,
    attachmentQuotaBytes,
    deviceToken,
    mode,
    adminWebEnabled,
    ...(productionAdminEntryPath === undefined
      ? {}
      : {
          productionAdminEntryPath,
          productionAdminActivationPath: productionAdminActivationPath!
        }),
    ...(adminWebOrigin === undefined ? {} : { adminWebOrigin }),
    ...(configuredCanvasBaseUrl === undefined
      ? {}
      : {
          canvasBaseUrl: configuredCanvasBaseUrl,
          canvasAllowContainerService: containerized
        }),
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
