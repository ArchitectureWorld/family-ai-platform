import {
  lstatSync,
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
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "preview-persistence-device-token-long-enough";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

describe("development Admin Preview persistence", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function initializedApp(adminEntryPath: string) {
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "development",
      previewAdminEntryPath: adminEntryPath,
      previewAdminOrigin: "http://127.0.0.1:8791"
    });
    const initialized = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "可恢复家庭",
        ownerName: "管理员",
        deviceName: "管理电脑"
      }
    });
    expect(initialized.statusCode).toBe(201);
    return initialized.json() as {
      entries: {
        admin: {
          entryBindingRef: string;
          entrySessionRef: string;
          token: string;
        };
      };
    };
  }

  it("atomically writes the authenticated family-admin entry with mode 0600", async () => {
    directory = mkdtempSync(join(tmpdir(), "admin-preview-persist-"));
    const configDir = join(directory, "config");
    mkdirSync(configDir, { mode: 0o700 });
    const adminEntryPath = join(configDir, "admin-entry.json");
    const initialized = await initializedApp(adminEntryPath);
    const admin = initialized.entries.admin;

    const unauthorized = await app!.inject({
      method: "POST",
      url: "/api/v1/admin/preview-entry"
    });
    expect(unauthorized.statusCode).toBe(401);

    const persisted = await app!.inject({
      method: "POST",
      url: "/api/v1/admin/preview-entry",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "x-entry-session-ref": admin.entrySessionRef
      }
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toEqual({ persisted: true });
    expect(lstatSync(adminEntryPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(adminEntryPath, "utf8"))).toEqual({
      version: 1,
      origin: "http://127.0.0.1:8791",
      familyRef: expect.stringMatching(/^family:/),
      personRef: expect.stringMatching(/^person:/),
      deviceRef: expect.stringMatching(/^device:/),
      entryBindingRef: admin.entryBindingRef,
      entrySessionRef: admin.entrySessionRef,
      token: admin.token
    });
  });

  it("fails closed instead of following a reused symlink target", async () => {
    directory = mkdtempSync(join(tmpdir(), "admin-preview-symlink-"));
    const configDir = join(directory, "config");
    mkdirSync(configDir, { mode: 0o700 });
    const victim = join(directory, "victim");
    writeFileSync(victim, "safe\n", { mode: 0o600 });
    const adminEntryPath = join(configDir, "admin-entry.json");
    symlinkSync(victim, adminEntryPath);
    const initialized = await initializedApp(adminEntryPath);
    const admin = initialized.entries.admin;

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/admin/preview-entry",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "x-entry-session-ref": admin.entrySessionRef
      }
    });
    expect(response.statusCode).toBe(500);
    expect(readFileSync(victim, "utf8")).toBe("safe\n");
  });

  it("does not expose the persistence route without explicit development configuration", async () => {
    directory = mkdtempSync(join(tmpdir(), "admin-preview-disabled-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test"
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/preview-entry"
    });
    expect(response.statusCode).toBe(404);
  });
});
