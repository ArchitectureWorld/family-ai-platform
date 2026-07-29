import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProviderRuntime,
  loadGatewayConfig
} from "../src/config.js";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const token = "configuration-test-token-with-enough-length";
const temporaryDirectories: string[] = [];

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "family-ai-runtime-config-"));
  temporaryDirectories.push(root);
  const executable = join(root, "provider-cli");
  const invocationLog = join(root, "invocations.jsonl");
  const jarvisHome = join(root, "jarvis");
  const personalHome = join(root, "personal");
  const codexWorkingDirectory = join(root, "workspace");
  writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(
  ${JSON.stringify(invocationLog)},
  JSON.stringify(process.argv.slice(2)) + "\\n"
);
process.stdout.write("Profile native reply");
process.stderr.write("session_id: profile_native_session_42\\n");
`, { mode: 0o700 });
  for (const directory of [jarvisHome, personalHome, codexWorkingDirectory]) {
    mkdirSync(directory);
  }
  return {
    root,
    executable,
    invocationLog,
    jarvisHome,
    personalHome,
    codexWorkingDirectory
  };
}

function realEnvironment(fixture = runtimeFixture()): NodeJS.ProcessEnv {
  return {
    GATEWAY_DEVICE_TOKEN: token,
    FAMILY_AI_PROVIDER_MODE: "real",
    FAMILY_AI_HERMES_EXECUTABLE: fixture.executable,
    FAMILY_AI_HERMES_JARVIS_HOME: fixture.jarvisHome,
    FAMILY_AI_HERMES_PERSONAL_HOME: fixture.personalHome,
    FAMILY_AI_HERMES_PROFILES: "ZZH,nsy",
    FAMILY_AI_CODEX_EXECUTABLE: fixture.executable,
    FAMILY_AI_CODEX_WORKING_DIRECTORY: fixture.codexWorkingDirectory
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    expect(config.providerRuntime).toEqual({ mode: "fake" });
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

  it("allows production only with an explicit real Provider runtime", () => {
    expect(() =>
      loadGatewayConfig({
        GATEWAY_MODE: "production",
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_DEVICE_TOKEN: token
      })
    ).toThrow("real Provider runtime");
    expect(loadGatewayConfig({
      ...realEnvironment(),
      GATEWAY_MODE: "production"
    })).toMatchObject({
      mode: "production",
      providerRuntime: { mode: "real" }
    });
  });

  it("validates every executable and server-owned runtime directory in real mode", () => {
    const fixture = runtimeFixture();
    const valid = realEnvironment(fixture);
    expect(loadGatewayConfig(valid).providerRuntime).toMatchObject({
      mode: "real",
      hermes: {
        executable: fixture.executable,
        jarvisHome: fixture.jarvisHome,
        personalHome: fixture.personalHome,
        profiles: ["zzh", "nsy"]
      },
      codex: {
        executable: fixture.executable,
        workingDirectory: fixture.codexWorkingDirectory
      }
    });

    for (const key of [
      "FAMILY_AI_HERMES_EXECUTABLE",
      "FAMILY_AI_CODEX_EXECUTABLE"
    ]) {
      const env = { ...valid };
      delete env[key];
      expect(() => loadGatewayConfig(env)).toThrow("runtime configuration");
    }

    chmodSync(fixture.executable, 0o600);
    expect(() => loadGatewayConfig(valid)).toThrow("runtime configuration");
    expect(() => loadGatewayConfig({
      ...valid,
      FAMILY_AI_HERMES_JARVIS_HOME: join(fixture.root, "missing-jarvis")
    })).toThrow("runtime configuration");
    expect(() => loadGatewayConfig({
      ...valid,
      FAMILY_AI_CODEX_WORKING_DIRECTORY: join(fixture.root, "missing-workspace")
    })).toThrow("runtime configuration");
  });

  it("normalizes Hermes Profile names and rejects normalized collisions", () => {
    expect(() => loadGatewayConfig({
      ...realEnvironment(),
      FAMILY_AI_HERMES_PROFILES: "ZZH,zzh"
    })).toThrow("runtime configuration");
    expect(() => loadGatewayConfig({
      ...realEnvironment(),
      FAMILY_AI_HERMES_PROFILES: "valid,bad profile"
    })).toThrow("runtime configuration");
    expect(() => loadGatewayConfig({
      ...realEnvironment(),
      FAMILY_AI_HERMES_PROFILES: "Jarvis,zzh"
    })).toThrow("runtime configuration");
  });

  it("ignores stale global Hermes model routing overrides", () => {
    const runtime = loadGatewayConfig({
      ...realEnvironment(),
      FAMILY_AI_HERMES_MODEL: "deepseek-v4-flash --quiet",
      FAMILY_AI_HERMES_PROVIDER: "SenseNova"
    }).providerRuntime;

    expect(runtime).toMatchObject({ mode: "real" });
    if (runtime.mode !== "real") throw new Error("real runtime expected");
    expect(runtime.hermes).not.toHaveProperty("model");
    expect(runtime.hermes).not.toHaveProperty("provider");
  });

  it("builds Jarvis and personal invocations without global route overrides", async () => {
    const fixture = runtimeFixture();
    const runtime = buildProviderRuntime(
      loadGatewayConfig(realEnvironment(fixture)).providerRuntime
    );
    const baseRequest = {
      protocolVersion: "1.0" as const,
      invocationRef: "invocation:018f47a2-1f10-7a3d-8c2d-61f369284f31",
      correlationRef: "correlation:018f47a2-1f10-7a3d-8c2d-61f369284f32",
      idempotencyKey: "device:test:message:routing",
      requestedAt: "2026-07-29T08:00:00.000Z",
      targetAgentRef: "agent:test",
      conversationRef: "conversation:018f47a2-1f10-7a3d-8c2d-61f369284f33",
      content: [{ type: "text" as const, text: "route probe" }],
      timeoutMs: 2_000
    };

    for (const providerProfileRef of [
      "provider-profile:hermes-jarvis",
      "provider-profile:hermes-zzh"
    ]) {
      await runtime.router.resolve(providerProfileRef).invoke({
        ...baseRequest,
        providerProfileRef
      });
    }

    const [jarvisArgs, zzhArgs] = readFileSync(
      fixture.invocationLog,
      "utf8"
    ).trim().split("\n").map(line => JSON.parse(line) as string[]);

    for (const args of [jarvisArgs, zzhArgs]) {
      expect(args).not.toContain("-m");
      expect(args).not.toContain("--provider");
    }
    expect(jarvisArgs).not.toContain("-p");
    expect(zzhArgs).toContain("-p");
    expect(zzhArgs).toContain("zzh");
  });

  it("composes deterministic Agent and Provider refs for every real runtime", () => {
    const runtime = buildProviderRuntime(
      loadGatewayConfig(realEnvironment()).providerRuntime
    );
    expect(runtime.agents).toEqual([
      {
        agentRef: "agent:hermes-jarvis",
        displayName: "Jarvis",
        providerProfileRef: "provider-profile:hermes-jarvis",
        providerKind: "hermes"
      },
      {
        agentRef: "agent:hermes-zzh",
        displayName: "zzh",
        providerProfileRef: "provider-profile:hermes-zzh",
        providerKind: "hermes"
      },
      {
        agentRef: "agent:hermes-nsy",
        displayName: "nsy",
        providerProfileRef: "provider-profile:hermes-nsy",
        providerKind: "hermes"
      },
      {
        agentRef: "agent:codex-cli",
        displayName: "Codex",
        providerProfileRef: "provider-profile:codex-cli",
        providerKind: "codex"
      }
    ]);
    for (const agent of runtime.agents) {
      expect(() => runtime.router.resolve(agent.providerProfileRef)).not.toThrow();
    }
  });

  it("reconciles runtime catalog and existing owner Admin assignments idempotently", async () => {
    const fixture = runtimeFixture();
    const databasePath = join(fixture.root, "gateway.sqlite");
    const seed = openGatewayDatabase(databasePath);
    new FamilyDomainRepository(seed).initializeFamily({
      familyName: "Runtime Family",
      ownerName: "Runtime Owner",
      deviceName: "Runtime Device",
      deviceCredential: token
    });
    seed.close();
    const runtime = buildProviderRuntime(
      loadGatewayConfig(realEnvironment(fixture)).providerRuntime
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const app = await buildGatewayApp({
        databasePath,
        deviceToken: token,
        mode: "development",
        providerRouter: runtime.router,
        configuredAgentRuntimes: runtime.agents,
        authoritativeAgentRuntimeCatalog: runtime.authoritative
      });
      await app.close();
    }

    const verified = openGatewayDatabase(databasePath);
    expect(verified.prepare(
      `SELECT COUNT(*) AS count
       FROM admin_agent_assignments
       WHERE status = 'active'`
    ).get()).toEqual({ count: 2 });
    expect(verified.prepare(
      `SELECT agent_ref, provider_profile_ref
       FROM admin_agent_assignments
       WHERE status = 'active'
       ORDER BY agent_ref`
    ).all()).toEqual([
      {
        agent_ref: "agent:codex-cli",
        provider_profile_ref: "provider-profile:codex-cli"
      },
      {
        agent_ref: "agent:hermes-jarvis",
        provider_profile_ref: "provider-profile:hermes-jarvis"
      }
    ]);
    expect(verified.prepare(
      `SELECT status FROM agent_runtime_bindings
       WHERE provider_profile_ref = 'provider-profile:fake-local'
       ORDER BY agent_ref`
    ).all()).toEqual([{ status: "disabled" }, { status: "disabled" }]);
    expect(verified.prepare(
      `SELECT status, is_default FROM assistant_assignments
       WHERE provider_profile_ref = 'provider-profile:fake-local'`
    ).all()).toEqual([{ status: "ended", is_default: 0 }]);
    verified.close();
  });

  it("does not serialize Provider paths or echo them in validation errors", () => {
    const fixture = runtimeFixture();
    const config = loadGatewayConfig(realEnvironment(fixture));
    const serialized = JSON.stringify(config);
    for (const path of [
      fixture.executable,
      fixture.jarvisHome,
      fixture.personalHome,
      fixture.codexWorkingDirectory
    ]) {
      expect(serialized).not.toContain(path);
    }

    const privatePath = join(fixture.root, "private-provider-home");
    let message = "";
    try {
      loadGatewayConfig({
        ...realEnvironment(fixture),
        FAMILY_AI_HERMES_JARVIS_HOME: privatePath
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("runtime configuration");
    expect(message).not.toContain(privatePath);
  });
});
