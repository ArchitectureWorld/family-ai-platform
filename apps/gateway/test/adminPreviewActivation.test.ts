import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "preview-activation-device-token-long-enough";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};
const fixedNow = new Date();
const activeCreatedAt = fixedNow.toISOString();
const activeExpiresAt = new Date(fixedNow.getTime() + 5 * 60 * 1_000).toISOString();

type App = Awaited<ReturnType<typeof buildGatewayApp>>;

const directories: string[] = [];
const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `admin-preview-activation-${label}-`));
  directories.push(directory);
  return directory;
}

function activationHash(salt: string, code: string): string {
  return createHash("sha256")
    .update(`${salt}\0${code}`, "utf8")
    .digest("hex");
}

function writeActivation(
  path: string,
  {
    code,
    createdAt = activeCreatedAt,
    expiresAt = activeExpiresAt
  }: {
    code: string;
    createdAt?: string;
    expiresAt?: string;
  }
): void {
  const salt = Buffer.alloc(16, 9).toString("base64url");
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    createdAt,
    expiresAt,
    salt,
    codeHash: activationHash(salt, code)
  })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function initializedPreview(label = "initialized") {
  const directory = temporaryDirectory(label);
  const configDir = join(directory, "config");
  mkdirSync(configDir, { mode: 0o700 });
  const databasePath = join(directory, "gateway.sqlite");
  const adminEntryPath = join(configDir, "admin-entry.json");
  const activationPath = join(configDir, "admin-activation.json");
  const app = await buildGatewayApp({
    databasePath,
    deviceToken,
    mode: "development",
    previewAdminEntryPath: adminEntryPath,
    previewAdminOrigin: "http://127.0.0.1:8791",
    now: () => fixedNow
  });
  apps.push(app);
  const initialized = await app.inject({
    method: "POST",
    url: "/api/v1/onboarding/family",
    headers: bootstrapHeaders,
    payload: {
      familyName: "Windows 激活家庭",
      ownerName: "管理员",
      deviceName: "管理电脑"
    }
  });
  expect(initialized.statusCode).toBe(201);
  const body = initialized.json() as {
    entries: {
      admin: {
        entrySessionRef: string;
        token: string;
      };
    };
  };
  const admin = body.entries.admin;
  const persisted = await app.inject({
    method: "POST",
    url: "/api/v1/admin/preview-entry",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-entry-session-ref": admin.entrySessionRef
    }
  });
  expect(persisted.statusCode).toBe(200);
  return {
    directory,
    databasePath,
    configDir,
    adminEntryPath,
    activationPath,
    app,
    admin
  };
}

function expectNoCredential(responseBody: string, token?: string): void {
  expect(responseBody).not.toContain("adminCredential");
  expect(responseBody).not.toContain("entrySessionRef");
  if (token) expect(responseBody).not.toContain(token);
}

describe("development Admin Preview activation", () => {
  it("exchanges a correct activation code for the current family-admin entry exactly once", async () => {
    const fixture = await initializedPreview("once");
    writeActivation(fixture.activationPath, { code: "ABCDE-FGHJK" });

    const first = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json()).toEqual({
      adminCredential: {
        kind: "entry",
        entrySessionRef: fixture.admin.entrySessionRef,
        token: fixture.admin.token
      }
    });
    expect(existsSync(fixture.activationPath)).toBe(false);
    expect(readdirSync(fixture.configDir).some(name => name.includes(".claim.")))
      .toBe(false);

    const replay = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.headers["cache-control"]).toBe("no-store");
    expect(replay.json().code).toBe("PREVIEW_ACTIVATION_UNAVAILABLE");
    expectNoCredential(replay.body, fixture.admin.token);
  });

  it("rejects malformed and wrong codes without consuming a valid activation", async () => {
    const fixture = await initializedPreview("wrong");
    writeActivation(fixture.activationPath, { code: "ABCDE-FGHJK" });

    const malformed = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHIJ", extra: true }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("PREVIEW_ACTIVATION_INVALID");
    expectNoCredential(malformed.body, fixture.admin.token);

    const wrong = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "KLMNP-QRSTU" }
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("PREVIEW_ACTIVATION_INVALID");
    expectNoCredential(wrong.body, fixture.admin.token);
    expect(existsSync(fixture.activationPath)).toBe(true);

    const correct = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(correct.statusCode).toBe(200);
  });

  it("rejects expired activation material without returning credentials", async () => {
    const fixture = await initializedPreview("expired");
    writeActivation(fixture.activationPath, {
      code: "ABCDE-FGHJK",
      createdAt: new Date(fixedNow.getTime() - 5 * 60 * 1_000 - 1).toISOString(),
      expiresAt: new Date(fixedNow.getTime() - 1).toISOString()
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().code).toBe("PREVIEW_ACTIVATION_EXPIRED");
    expectNoCredential(response.body, fixture.admin.token);
  });

  it("does not consume a code when the persisted Admin entry is revoked", async () => {
    const fixture = await initializedPreview("revoked");
    writeActivation(fixture.activationPath, { code: "ABCDE-FGHJK" });
    const database = new Database(fixture.databasePath);
    database.prepare(
      "UPDATE entry_sessions SET status = 'revoked' WHERE entry_session_ref = ?"
    ).run(fixture.admin.entrySessionRef);
    database.close();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("PREVIEW_ADMIN_ENTRY_INVALID");
    expectNoCredential(response.body, fixture.admin.token);
    expect(existsSync(fixture.activationPath)).toBe(true);
  });

  it("allows only one of two concurrent correct exchanges", async () => {
    const fixture = await initializedPreview("concurrent");
    writeActivation(fixture.activationPath, { code: "ABCDE-FGHJK" });

    const responses = await Promise.all([
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/admin/preview-activation",
        payload: { code: "ABCDE-FGHJK" }
      }),
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/admin/preview-activation",
        payload: { code: "ABCDE-FGHJK" }
      })
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 404]);
    expect(responses.filter(response => response.body.includes(fixture.admin.token)))
      .toHaveLength(1);
  });

  it("fails closed for symlinked or overly permissive protected files", async () => {
    const symlinkFixture = await initializedPreview("symlink");
    const victim = join(symlinkFixture.directory, "activation-victim");
    writeActivation(victim, { code: "ABCDE-FGHJK" });
    symlinkSync(victim, symlinkFixture.activationPath);

    const symlinkResponse = await symlinkFixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(symlinkResponse.statusCode).not.toBe(200);
    expectNoCredential(symlinkResponse.body, symlinkFixture.admin.token);
    expect(readFileSync(victim, "utf8")).toContain('"version":1');

    const modeFixture = await initializedPreview("mode");
    writeActivation(modeFixture.activationPath, { code: "ABCDE-FGHJK" });
    chmodSync(modeFixture.activationPath, 0o644);
    const modeResponse = await modeFixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(modeResponse.statusCode).not.toBe(200);
    expectNoCredential(modeResponse.body, modeFixture.admin.token);
  });

  it("maps malformed protected JSON to bounded activation and Admin errors", async () => {
    const activationFixture = await initializedPreview("malformed-activation");
    writeFileSync(activationFixture.activationPath, "{\n", { mode: 0o600 });
    const activationResponse = await activationFixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(activationResponse.statusCode).toBe(404);
    expect(activationResponse.json().code).toBe("PREVIEW_ACTIVATION_UNAVAILABLE");
    expectNoCredential(activationResponse.body, activationFixture.admin.token);

    const adminFixture = await initializedPreview("malformed-admin");
    writeActivation(adminFixture.activationPath, { code: "ABCDE-FGHJK" });
    writeFileSync(adminFixture.adminEntryPath, "{\n", { mode: 0o600 });
    const adminResponse = await adminFixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(adminResponse.statusCode).toBe(401);
    expect(adminResponse.json().code).toBe("PREVIEW_ADMIN_ENTRY_INVALID");
    expectNoCredential(adminResponse.body, adminFixture.admin.token);
    expect(existsSync(adminFixture.activationPath)).toBe(true);
  });

  it("does not expose the activation route without explicit development configuration", async () => {
    for (const [mode, configured] of [
      ["test", false],
      ["development", false],
      ["production", true]
    ] as const) {
      const directory = temporaryDirectory(`${mode}-${configured}`);
      const configDir = join(directory, "config");
      mkdirSync(configDir, { mode: 0o700 });
      const app = await buildGatewayApp({
        databasePath: join(directory, "gateway.sqlite"),
        deviceToken,
        mode,
        ...(mode === "production"
          ? { providerAdapter: new FakeProviderAdapter() }
          : {}),
        ...(configured
          ? {
              previewAdminEntryPath: join(configDir, "admin-entry.json"),
              previewAdminOrigin: "http://127.0.0.1:8791"
            }
          : {})
      });
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/preview-activation",
        payload: { code: "ABCDE-FGHJK" }
      });
      expect(response.statusCode, `${mode}:${configured}`).toBe(404);
    }
  });
});
