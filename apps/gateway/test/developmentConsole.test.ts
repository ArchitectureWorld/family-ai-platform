import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";

const token = "development-console-token-with-enough-length";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePathFor(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), `family-ai-${mode}-`));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

describe("development onboarding console", () => {
  it("serves the dual-entry onboarding portal only in development with strict protections", async () => {
    const development = await buildGatewayApp({
      databasePath: databasePathFor("development"),
      deviceToken: token,
      mode: "development"
    });
    const response = await development.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.body).toContain("家庭 AI 初始化与入口验收台");
    expect(response.body).toContain("家庭管理");
    expect(response.body).toContain("个人空间");
    expect(response.body).not.toContain(token);
    await development.close();

    const production = await buildGatewayApp({
      databasePath: databasePathFor("production"),
      deviceToken: token,
      mode: "production",
      providerAdapter: new FakeProviderAdapter()
    });
    expect((await production.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    await production.close();
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
