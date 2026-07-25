import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";

const token = "member-web-product-token-with-enough-length";
const directories: string[] = [];

function databasePathFor(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), `family-ai-member-web-${mode}-`));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Member Web product entry", () => {
  it("makes the normal product workbench the root experience in every mode", async () => {
    for (const mode of ["test", "development", "production"] as const) {
      const app = await buildGatewayApp({
        databasePath: databasePathFor(mode),
        deviceToken: token,
        mode,
        ...(mode === "production" ? { providerAdapter: new FakeProviderAdapter() } : {})
      });
      try {
        const root = await app.inject({ method: "GET", url: "/" });
        expect(root.statusCode).toBe(302);
        expect(root.headers.location).toBe("/member/");

        const member = await app.inject({ method: "GET", url: "/member/" });
        expect(member.statusCode).toBe(200);
        expect(member.headers["cache-control"]).toBe("no-store");
        expect(member.headers["content-security-policy"]).toContain("default-src 'self'");
        expect(member.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(member.headers["referrer-policy"]).toBe("no-referrer");
        expect(member.headers["x-frame-options"]).toBe("DENY");
        expect(member.body).toContain("Family AI");
        expect(member.body).toContain("个人工作台");
        expect(member.body).toContain("Chat");
        expect(member.body).toContain("Work");
        expect(member.body).not.toContain("验收台");
        expect(member.body).not.toContain("调试日志");
        expect(member.body).not.toContain(token);
      } finally {
        await app.close();
      }
    }
  });

  it("serves external product assets and no longer exposes acceptance-console routes", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePathFor("development-assets"),
      deviceToken: token,
      mode: "development"
    });
    try {
      const script = await app.inject({
        method: "GET",
        url: "/member/assets/entry.js"
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toContain("text/javascript");
      expect(script.body).toContain("/api/v1/web-entry/context");
      expect(script.body).toContain("history.replaceState");
      expect(script.body).not.toContain("document.cookie");

      const style = await app.inject({
        method: "GET",
        url: "/member/assets/member.css"
      });
      expect(style.statusCode).toBe(200);
      expect(style.headers["content-type"]).toContain("text/css");
      expect(style.body).toContain("@media");

      for (const path of [
        "/acceptance.js",
        "/mobileAcceptance.js",
        "/acceptance.css",
        "/mobile-acceptance.css"
      ]) {
        expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("does not allow production to default to the development Fake Provider", async () => {
    await expect(
      buildGatewayApp({
        databasePath: databasePathFor("production-without-provider"),
        deviceToken: token,
        mode: "production"
      })
    ).rejects.toThrow("explicit provider adapter");
  });
});
