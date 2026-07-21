import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const token = "development-console-token-with-enough-length";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function appFor(mode: "development" | "production") {
  const directory = mkdtempSync(join(tmpdir(), `family-ai-${mode}-`));
  directories.push(directory);
  return buildGatewayApp({
    databasePath: join(directory, "gateway.sqlite"),
    deviceToken: token,
    mode
  });
}

describe("development acceptance console", () => {
  it("is served only in development mode with no-store headers", async () => {
    const development = await appFor("development");
    const response = await development.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Gateway 体验验收台");
    expect(response.body).not.toContain(token);
    await development.close();

    const production = await appFor("production");
    expect((await production.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    await production.close();
  });
});
