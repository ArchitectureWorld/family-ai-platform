import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";

const token = "admin-web-bootstrap-token-with-enough-length";
const directories: string[] = [];

function databasePathFor(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `family-ai-admin-web-${label}-`));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("development Admin Web product entry", () => {
  it("serves an explicit protected admin state machine without taking over the member root", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePathFor("development"),
      deviceToken: token,
      mode: "development"
    });
    try {
      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe("/member/");

      const redirect = await app.inject({ method: "GET", url: "/admin" });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe("/admin/");

      const admin = await app.inject({ method: "GET", url: "/admin/" });
      expect(admin.statusCode).toBe(200);
      expect(admin.headers["content-type"]).toContain("text/html");
      expect(admin.headers["cache-control"]).toBe("no-store");
      expect(admin.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(admin.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(admin.headers["referrer-policy"]).toBe("no-referrer");
      expect(admin.headers["x-content-type-options"]).toBe("nosniff");
      expect(admin.headers["x-frame-options"]).toBe("DENY");
      expect(admin.body).toContain("Family AI 家庭管理");
      expect(admin.body).toContain('data-state="initializing"');
      expect(admin.body).toContain('data-state="create-family"');
      expect(admin.body).toContain('data-state="management"');
      expect(admin.body).toContain('data-state="recovery-required"');
      expect(admin.body).not.toContain(token);

      for (const [path, contentType] of [
        ["/admin/assets/admin.css", "text/css"],
        ["/admin/assets/admin.js", "text/javascript"],
        ["/admin/assets/admin-entry.js", "text/javascript"],
        ["/admin/assets/admin-api.js", "text/javascript"],
        ["/admin/assets/qr.js", "text/javascript"],
        ["/admin/assets/qr-v10.mjs", "text/javascript"]
      ] as const) {
        const asset = await app.inject({ method: "GET", url: path });
        expect(asset.statusCode, path).toBe(200);
        expect(asset.headers["content-type"], path).toContain(contentType);
        expect(asset.headers["cache-control"], path).toBe("no-store");
        expect(asset.headers["content-security-policy"], path).toContain("default-src 'self'");
      }
    } finally {
      await app.close();
    }
  });

  it("does not expose Admin Web routes outside development mode", async () => {
    for (const mode of ["test", "production"] as const) {
      const app = await buildGatewayApp({
        databasePath: databasePathFor(mode),
        deviceToken: token,
        mode,
        ...(mode === "production" ? { providerAdapter: new FakeProviderAdapter() } : {})
      });
      try {
        for (const path of [
          "/admin",
          "/admin/",
          "/admin/assets/admin.css",
          "/admin/assets/admin.js",
          "/admin/assets/admin-entry.js",
          "/admin/assets/admin-api.js",
          "/admin/assets/qr.js",
          "/admin/assets/qr-v10.mjs"
        ]) {
          expect((await app.inject({ method: "GET", url: path })).statusCode, `${mode}:${path}`)
            .toBe(404);
        }
      } finally {
        await app.close();
      }
    }
  });
});
