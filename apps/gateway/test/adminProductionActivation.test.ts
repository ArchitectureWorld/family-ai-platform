import { spawnSync } from "node:child_process";
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
import { openGatewayDatabase } from "../src/database.js";
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

  it("does not strand an activation lock when a consumed code is replayed", async () => {
    const { app, entryPath, activationPath } = await fixture("replay-reissue");
    const activate = (code: string) => app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code }
    });
    expect((await activate("AAAAA-BBBBB")).statusCode).toBe(401);
    expect(existsSync(activationPath + ".lock")).toBe(false);
    const first = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath
    });
    const activateAgain = (code: string) => app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code }
    });
    expect((await activateAgain(first.code)).statusCode).toBe(200);
    expect(existsSync(activationPath + ".lock")).toBe(false);
    expect((await activateAgain(first.code)).statusCode).toBe(401);
    expect(existsSync(activationPath + ".lock")).toBe(false);
    const next = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath
    });
    expect((await activateAgain(next.code)).statusCode).toBe(200);
  });

  it("issues separate persistent browser sessions and revokes only the browser that logs out", async () => {
    const { app, entryPath, activationPath, databasePath, body } = await fixture("separate-browsers");
    const activate = async () => {
      const activation = await createProductionAdminActivation({
        adminEntryPath: entryPath, activationPath
      });
      const response = await app.inject({
        method: "POST", url: "/api/v1/admin/activate",
        headers: activationHeaders(), payload: { code: activation.code }
      });
      expect(response.statusCode).toBe(200);
      const setCookies = response.headers["set-cookie"] as string[];
      expect(setCookies.join(";")).toContain("Max-Age=");
      expect(setCookies.join(";")).not.toContain(body.entries.admin.token);
      return setCookies.map(value => value.split(";", 1)[0]).join("; ");
    };
    const firstCookie = await activate();
    const secondCookie = await activate();
    expect(firstCookie).not.toBe(secondCookie);
    expect(firstCookie).not.toContain(body.entries.admin.entrySessionRef);
    expect(secondCookie).not.toContain(body.entries.admin.entrySessionRef);

    const firstBefore = await app.inject({
      method: "GET", url: "/api/v1/admin/members", headers: { cookie: firstCookie }
    });
    const secondBefore = await app.inject({
      method: "GET", url: "/api/v1/admin/members", headers: { cookie: secondCookie }
    });
    expect(firstBefore.statusCode).toBe(200);
    expect(secondBefore.statusCode).toBe(200);
    expect(String(firstBefore.headers["set-cookie"])).toContain("Max-Age=");

    const crossOrigin = await app.inject({
      method: "POST", url: "/api/v1/admin/logout",
      headers: {
        cookie: firstCookie, "x-family-ai-web-request": "1",
        origin: "https://other.example:8793", "sec-fetch-site": "cross-site"
      }
    });
    expect(crossOrigin.statusCode).not.toBe(200);

    const logout = await app.inject({
      method: "POST", url: "/api/v1/admin/logout",
      headers: {
        cookie: firstCookie, host: "admin.example:8793",
        "x-family-ai-web-request": "1", ...activationHeaders()
      }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ loggedOut: true });
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    const firstAfter = await app.inject({
      method: "GET", url: "/api/v1/admin/members", headers: { cookie: firstCookie }
    });
    const secondAfter = await app.inject({
      method: "GET", url: "/api/v1/admin/members", headers: { cookie: secondCookie }
    });
    expect(firstAfter.statusCode).toBe(401);
    expect(secondAfter.statusCode).toBe(200);
    const operatorContext = await app.inject({
      method: "GET", url: "/api/v1/portal/context",
      headers: {
        authorization: `Bearer ${body.entries.admin.token}`,
        "x-entry-session-ref": body.entries.admin.entrySessionRef
      }
    });
    expect(operatorContext.statusCode).toBe(200);

    const db = openGatewayDatabase(databasePath, {
      intent: "test-create-or-existing", simulate: "migrate-create-or-existing"
    });
    db.prepare("UPDATE managed_devices SET status = 'revoked' WHERE device_ref = ?")
      .run(body.device.deviceRef);
    db.close();
    const revoked = await app.inject({
      method: "GET", url: "/api/v1/admin/members", headers: { cookie: secondCookie }
    });
    expect(revoked.statusCode).toBe(403);
   }, 15_000);

  it("accepts an unused V2 activation code months after its creation", async () => {
    const { app, entryPath, activationPath } = await fixture("no-time-limit");
    const activation = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath,
      now: () => new Date("2020-01-01T00:00:00.000Z")
    });
    const record = JSON.parse(readFileSync(activationPath, "utf8"));
    expect(record).toMatchObject({ version: 2, failedAttempts: 0 });
    expect(record).not.toHaveProperty("expiresAt");
    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code: activation.code }
    });
    expect(response.statusCode).toBe(200);
  });

  it("locks a V2 code after ten wrong guesses and keeps the lock across a Gateway restart", async () => {
    const fixtureValue = await fixture("wrong-attempts");
    const activation = await createProductionAdminActivation({
      adminEntryPath: fixtureValue.entryPath,
      activationPath: fixtureValue.activationPath
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fixtureValue.app.inject({
        method: "POST", url: "/api/v1/admin/activate",
        headers: activationHeaders(), payload: { code: "AAAAA-BBBBB" }
      });
      expect(response.statusCode).toBe(401);
    }
    const record = JSON.parse(readFileSync(fixtureValue.activationPath, "utf8"));
    expect(record.failedAttempts).toBe(10);
    await fixtureValue.app.close();
    apps.splice(apps.indexOf(fixtureValue.app), 1);
    const reopened = await buildGatewayApp({
      databaseOpenRequest: { intent: "test-create-or-existing", simulate: "migrate-create-or-existing" },
      databasePath: fixtureValue.databasePath, deviceToken, mode: "production",
      providerAdapter: new FakeProviderAdapter(), adminWebEnabled: true,
      productionAdminEntryPath: fixtureValue.entryPath,
      productionAdminActivationPath: fixtureValue.activationPath,
      adminWebOrigin: origin
    });
    apps.push(reopened);
    const correct = await reopened.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code: activation.code }
    });
    expect(correct.statusCode).toBe(401);
  });

  it("fails closed after a separate process dies while holding the activation claim", async () => {
    const { app, entryPath, activationPath, databasePath } = await fixture("claim-crash");
    const activation = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath
    });
    const crashed = spawnSync(process.execPath, [
      "-e",
      "require('node:fs').openSync(process.argv[1], 'wx', 0o600); process.kill(process.pid, 'SIGKILL')",
      activationPath + ".lock"
    ], { encoding: "utf8" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(existsSync(activationPath + ".lock")).toBe(true);
    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code: activation.code }
    });
    expect(response.statusCode).toBe(401);
    const generator = spawnSync(process.execPath, [
      join(process.cwd(), "../../scripts/admin-production-activate.mjs"),
      "--database", databasePath, "--entry", entryPath, "--output", activationPath
    ], { encoding: "utf8" });
    expect(generator.status).toBe(1);
    expect(generator.stdout).toBe("");
    expect(existsSync(activationPath)).toBe(true);
  });

  it("invalidates a replaced code and admits only one concurrent use", async () => {
    const { app, entryPath, activationPath } = await fixture("replacement-race");
    const oldCode = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath
    });
    const currentCode = await createProductionAdminActivation({
      adminEntryPath: entryPath, activationPath
    });
    const oldAttempt = await app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code: oldCode.code }
    });
    expect(oldAttempt.statusCode).toBe(401);
    const attempts = await Promise.all([1, 2].map(() => app.inject({
      method: "POST", url: "/api/v1/admin/activate",
      headers: activationHeaders(), payload: { code: currentCode.code }
    })));
    expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 401]);
  });

  it("rejects wrong, expired V1, malformed, replayed, and cross-origin activation", async () => {
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
    const oldRecord = JSON.parse(readFileSync(fixtureValue.activationPath, "utf8"));
    writeFileSync(fixtureValue.activationPath, `${JSON.stringify({
      version: 1,
      createdAt: "2026-09-11T00:00:00.000Z",
      expiresAt: "2026-09-11T00:05:00.000Z",
      salt: oldRecord.salt,
      codeHash: oldRecord.codeHash
    })}\n`, { mode: 0o600 });
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
