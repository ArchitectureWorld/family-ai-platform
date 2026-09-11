import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import {
  createProductionAdminActivation
} from "../src/adminProductionActivation.js";

const deviceToken = "production-admin-activation-device-token-long-enough";
const origin = "https://admin.example:8793";
const directories: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildGatewayApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(label = "default") {
  const directory = mkdtempSync(join(tmpdir(), `family-production-admin-${label}-`));
  directories.push(directory);
  const configDir = join(directory, "config");
  mkdirSync(configDir, { mode: 0o700 });
  const databasePath = join(directory, "gateway.sqlite");
  const entryPath = join(configDir, "admin-entry.json");
  const activationPath = join(configDir, "admin-activation.json");
  const development = await buildGatewayApp({
    databaseOpenRequest: { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" },
    databasePath,
    deviceToken,
    mode: "development"
  });
  const initialized = await development.inject({
    method: "POST",
    url: "/api/v1/onboarding/family",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "x-device-ref": "device:test"
    },
    payload: {
      familyName: "正式管理员家庭",
      ownerName: "管理员",
      deviceName: "管理电脑"
    }
  });
  expect(initialized.statusCode).toBe(201);
  const body = initialized.json() as {
    family: { familyRef: string };
    owner: { personRef: string };
    device: { deviceRef: string };
    entries: {
      admin: { entryBindingRef: string; entrySessionRef: string; token: string };
      personal: { entryBindingRef: string; entrySessionRef: string; token: string };
    };
  };
  await development.close();
  writeFileSync(entryPath, `${JSON.stringify({
    version: 1,
    origin,
    familyRef: body.family.familyRef,
    personRef: body.owner.personRef,
    deviceRef: body.device.deviceRef,
    entryBindingRef: body.entries.admin.entryBindingRef,
    entrySessionRef: body.entries.admin.entrySessionRef,
    token: body.entries.admin.token
  })}\n`, { mode: 0o600 });
  const app = await buildGatewayApp({
    databaseOpenRequest: { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" },
    databasePath,
    deviceToken,
    mode: "production",
    providerAdapter: new FakeProviderAdapter(),
    adminWebEnabled: true,
    productionAdminEntryPath: entryPath,
    productionAdminActivationPath: activationPath,
    adminWebOrigin: origin
  });
  apps.push(app);
  return { directory, configDir, databasePath, entryPath, activationPath, app, body };
}

function activationHeaders() {
  return { origin, "sec-fetch-site": "same-origin" };
}

describe("production Admin Web activation", () => {
  it("sets only Secure HttpOnly admin session cookies and consumes the code once", async () => {
    const fixtureValue = await fixture();
    const activation = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath,
      randomBytesImpl: () => Buffer.alloc(16, 7)
    });
    expect(activation.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u);
    const response = await fixtureValue.app.inject({
      method: "POST",
      url: "/api/v1/admin/activate",
      headers: activationHeaders(),
      payload: { code: activation.code }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activated: true });
    expect(response.body).not.toContain(fixtureValue.body.entries.admin.token);
    const cookies = response.headers["set-cookie"];
    expect(cookies).toBeInstanceOf(Array);
    expect(cookies?.join("\n")).toContain("HttpOnly");
    expect(cookies?.join("\n")).toContain("Secure");
    expect(cookies?.join("\n")).toContain("SameSite=Strict");
    expect(existsSync(fixtureValue.activationPath)).toBe(false);
  });

  it("rejects wrong, expired, malformed, replayed, and cross-origin activation", async () => {
    const fixtureValue = await fixture("invalid");
    const activation = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath,
      now: () => new Date("2026-09-11T00:00:00.000Z"),
      randomBytesImpl: () => Buffer.alloc(16, 8)
    });
    const wrong = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate", headers: activationHeaders(),
      payload: { code: "AAAAA-BBBBB" }
    });
    expect(wrong.statusCode).toBe(401);
    const crossOrigin = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: { origin: "https://evil.example:8793", "sec-fetch-site": "cross-site" },
      payload: { code: activation.code }
    });
    expect(crossOrigin.statusCode).toBe(401);
    const expired = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate", headers: activationHeaders(),
      payload: { code: activation.code }
    });
    expect(expired.statusCode).toBe(401);
    const valid = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath,
      randomBytesImpl: () => Buffer.alloc(16, 9)
    });
    const success = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate", headers: activationHeaders(),
      payload: { code: valid.code }
    });
    expect(success.statusCode).toBe(200);
    const replay = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate", headers: activationHeaders(),
      payload: { code: valid.code }
    });
    expect(replay.statusCode).toBe(401);
    const malformed = await fixtureValue.app.inject({
      method: "POST", url: "/api/v1/admin/activate", headers: activationHeaders(),
      payload: { code: "not-a-code", extra: true }
    });
    expect(malformed.statusCode).toBe(401);
  });

  it("fails closed for personal entries, symlinks, and permissive files", async () => {
    const fixtureValue = await fixture("files");
    const original = readFileSync(fixtureValue.entryPath);
    const victim = join(fixtureValue.configDir, "victim.json");
    writeFileSync(victim, original, { mode: 0o600 });
    rmSync(fixtureValue.entryPath);
    symlinkSync(victim, fixtureValue.entryPath);
    await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath
    }).catch(error => expect(String(error)).toContain("PROTECTED"));
    rmSync(fixtureValue.entryPath);
    writeFileSync(fixtureValue.entryPath, original, { mode: 0o644 });
    await expect(createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath
    })).rejects.toThrow("PROTECTED");
    chmodSync(fixtureValue.entryPath, 0o600);
    const activation = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath
    });
    expect(activation.outputPath).toBe(fixtureValue.activationPath);
  });

  it("rejects a protected administrator entry bound to another origin", async () => {
    const fixtureValue = await fixture("origin");
    const entry = JSON.parse(readFileSync(fixtureValue.entryPath, "utf8"));
    writeFileSync(fixtureValue.entryPath, `${JSON.stringify({
      ...entry,
      origin: "https://other.example:8793"
    })}\n`, { mode: 0o600 });
    const activation = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath
    });
    const response = await fixtureValue.app.inject({
      method: "POST",
      url: "/api/v1/admin/activate",
      headers: activationHeaders(),
      payload: { code: activation.code }
    });
    expect(response.statusCode).toBe(401);
  });
});
