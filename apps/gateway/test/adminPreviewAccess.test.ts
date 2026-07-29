import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const deviceToken = "preview-access-device-token-long-enough";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type App = Awaited<ReturnType<typeof buildGatewayApp>>;
type Entry = { entrySessionRef: string; token: string };

const directories: string[] = [];
const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `admin-preview-access-${label}-`));
  directories.push(directory);
  return directory;
}

async function initializedPreview(label = "initialized") {
  const directory = temporaryDirectory(label);
  const configDir = join(directory, "config");
  mkdirSync(configDir, { mode: 0o700 });
  const databasePath = join(directory, "gateway.sqlite");
  const adminEntryPath = join(configDir, "admin-entry.json");
  const app = await buildGatewayApp({
    databasePath,
    deviceToken,
    mode: "development",
    previewAdminEntryPath: adminEntryPath,
    previewAdminOrigin: "http://127.0.0.1:8791"
  });
  apps.push(app);
  const initialized = await app.inject({
    method: "POST",
    url: "/api/v1/onboarding/family",
    headers: bootstrapHeaders,
    payload: {
      familyName: "直接访问家庭",
      ownerName: "管理员",
      deviceName: "管理电脑"
    }
  });
  expect(initialized.statusCode).toBe(201);
  const body = initialized.json() as {
    family: { familyRef: string };
    owner: { personRef: string };
    device: { deviceRef: string };
    entries: { admin: Entry; personal: Entry };
  };
  const persisted = await app.inject({
    method: "POST",
    url: "/api/v1/admin/preview-entry",
    headers: {
      authorization: `Bearer ${body.entries.admin.token}`,
      "x-entry-session-ref": body.entries.admin.entrySessionRef
    }
  });
  expect(persisted.statusCode).toBe(200);
  return { directory, databasePath, adminEntryPath, app, ...body };
}

function expectNoCredential(responseBody: string, token?: string): void {
  expect(responseBody).not.toContain("adminCredential");
  expect(responseBody).not.toContain("entrySessionRef");
  if (token) expect(responseBody).not.toContain(token);
}

describe("development Admin Preview direct access", () => {
  it("reports Preview auto mode and returns the current family-admin entry without a code", async () => {
    const fixture = await initializedPreview("success");

    const mode = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/admin/access-mode"
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.headers["cache-control"]).toBe("no-store");
    expect(mode.json()).toEqual({ mode: "preview-auto" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/admin/preview-access"
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        adminCredential: {
          kind: "entry",
          entrySessionRef: fixture.entries.admin.entrySessionRef,
          token: fixture.entries.admin.token
        }
      });
    }
  });

  it("fails closed when the persisted Admin entry is missing, malformed, or revoked", async () => {
    const missing = await initializedPreview("missing");
    rmSync(missing.adminEntryPath);
    const missingResponse = await missing.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(missingResponse.statusCode).toBe(401);
    expect(missingResponse.json().code).toBe("PREVIEW_ADMIN_ENTRY_INVALID");
    expectNoCredential(missingResponse.body, missing.entries.admin.token);

    const malformed = await initializedPreview("malformed");
    writeFileSync(malformed.adminEntryPath, "{\n", { mode: 0o600 });
    const malformedResponse = await malformed.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(malformedResponse.statusCode).toBe(401);
    expect(malformedResponse.json().code).toBe("PREVIEW_ADMIN_ENTRY_INVALID");
    expectNoCredential(malformedResponse.body, malformed.entries.admin.token);

    const revoked = await initializedPreview("revoked");
    const database = new Database(revoked.databasePath);
    database.prepare(
      "UPDATE entry_sessions SET status = 'revoked' WHERE entry_session_ref = ?"
    ).run(revoked.entries.admin.entrySessionRef);
    database.close();
    const revokedResponse = await revoked.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedResponse.json().code).toBe("PREVIEW_ADMIN_ENTRY_INVALID");
    expectNoCredential(revokedResponse.body, revoked.entries.admin.token);
  });

  it("rejects wrong-origin and personal entries without returning credentials", async () => {
    const wrongOrigin = await initializedPreview("wrong-origin");
    const wrongOriginEntry = JSON.parse(
      readFileSync(wrongOrigin.adminEntryPath, "utf8")
    ) as Record<string, unknown>;
    writeFileSync(wrongOrigin.adminEntryPath, `${JSON.stringify({
      ...wrongOriginEntry,
      origin: "http://127.0.0.1:9999"
    })}\n`, { mode: 0o600 });
    const wrongOriginResponse = await wrongOrigin.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(wrongOriginResponse.statusCode).toBe(401);
    expectNoCredential(wrongOriginResponse.body, wrongOrigin.entries.admin.token);

    const personal = await initializedPreview("personal");
    writeFileSync(personal.adminEntryPath, `${JSON.stringify({
      version: 1,
      origin: "http://127.0.0.1:8791",
      familyRef: personal.family.familyRef,
      personRef: personal.owner.personRef,
      deviceRef: personal.device.deviceRef,
      entryBindingRef: "entry-binding:preview-personal",
      entrySessionRef: personal.entries.personal.entrySessionRef,
      token: personal.entries.personal.token
    })}\n`, { mode: 0o600 });
    const personalResponse = await personal.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(personalResponse.statusCode).toBe(401);
    expectNoCredential(personalResponse.body, personal.entries.personal.token);
  });

  it("fails closed for symlinked or overly permissive Admin entry files", async () => {
    const symlink = await initializedPreview("symlink");
    const original = readFileSync(symlink.adminEntryPath);
    const victim = join(symlink.directory, "admin-entry-victim.json");
    writeFileSync(victim, original, { mode: 0o600 });
    rmSync(symlink.adminEntryPath);
    symlinkSync(victim, symlink.adminEntryPath);
    const symlinkResponse = await symlink.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(symlinkResponse.statusCode).toBe(401);
    expectNoCredential(symlinkResponse.body, symlink.entries.admin.token);
    expect(readFileSync(victim)).toEqual(original);

    const permissive = await initializedPreview("mode");
    chmodSync(permissive.adminEntryPath, 0o644);
    const modeResponse = await permissive.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-access"
    });
    expect(modeResponse.statusCode).toBe(401);
    expectNoCredential(modeResponse.body, permissive.entries.admin.token);
  });

  it("does not expose direct access without explicit development configuration", async () => {
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
      for (const [method, url] of [
        ["GET", "/api/v1/admin/access-mode"],
        ["POST", "/api/v1/admin/preview-access"]
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${mode}:${configured}:${url}`).toBe(404);
      }
    }
  });

  it("retires the activation endpoint even in configured development", async () => {
    const fixture = await initializedPreview("no-activation");
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-activation",
      payload: { code: "ABCDE-FGHJK" }
    });
    expect(response.statusCode).toBe(404);
    expectNoCredential(response.body, fixture.entries.admin.token);
  });
});
