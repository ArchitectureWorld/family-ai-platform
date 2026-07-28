import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeProviderAdapter,
  ProviderAdapterRouter
} from "@family-ai/provider-adapter-sdk";
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

  it("serves every focused product module with strict no-store protections", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePathFor("product-assets"),
      deviceToken: token,
      mode: "development"
    });
    try {
      for (const name of [
        "entry.js",
        "api.js",
        "store.js",
        "cache.js",
        "thread.js",
        "sync.js",
        "chat.js",
        "work.js",
        "render.js",
        "product.js"
      ]) {
        const response = await app.inject({
          method: "GET",
          url: `/member/assets/${name}`
        });
        expect(response.statusCode, name).toBe(200);
        expect(response.headers["content-type"], name).toContain("text/javascript");
        expect(response.headers["cache-control"], name).toBe("no-store");
        expect(response.headers["content-security-policy"], name).toContain("default-src 'self'");
        expect(response.headers["x-content-type-options"], name).toBe("nosniff");
        expect(response.body, name).not.toContain("document.cookie");
      }

      const style = await app.inject({
        method: "GET",
        url: "/member/assets/member.css"
      });
      expect(style.statusCode).toBe(200);
      expect(style.headers["content-type"]).toContain("text/css");
      expect(style.headers["cache-control"]).toBe("no-store");
      expect(style.body).toContain("prefers-reduced-motion");

      for (const path of [
        "/acceptance.js",
        "/mobileAcceptance.js",
        "/acceptance.css",
        "/mobile-acceptance.css",
        "/qr.js",
        "/qr-v10.mjs"
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
    ).rejects.toThrow("explicit provider adapter or router");
  });

  it("accepts an explicit Provider Router as the production runtime boundary", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePathFor("production-with-router"),
      deviceToken: token,
      mode: "production",
      providerRouter: ProviderAdapterRouter.single(
        "provider-profile:fake-local",
        new FakeProviderAdapter()
      )
    });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
