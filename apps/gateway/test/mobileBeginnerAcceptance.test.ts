import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const publicDirectory = join(repositoryRoot, "apps/gateway/public");
const mobileAcceptanceModule = join(publicDirectory, "mobileAcceptance.js");

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("one-click beginner Mobile Entry acceptance", () => {
  it("ships a visible guided acceptance runner and Chinese report", () => {
    const html = read(join(publicDirectory, "index.html"));
    const javascript = read(mobileAcceptanceModule);
    const stylesheet = read(join(publicDirectory, "mobile-acceptance.css"));
    const developmentConsole = read(join(repositoryRoot, "apps/gateway/src/developmentConsole.ts"));

    expect(html).toContain('id="runMobileAcceptance"');
    expect(html).toContain('id="mobileAcceptanceSteps"');
    expect(html).toContain('id="mobileAcceptanceReport"');
    expect(html).toContain("一键体验验收");
    expect(html).toContain('src="/mobileAcceptance.js"');
    expect(html).toContain('href="/mobile-acceptance.css"');

    expect(javascript).toContain("runMobileAcceptance");
    expect(javascript).toContain("simulateMobileClaim");
    expect(javascript).toContain("renderMobileAcceptanceReport");
    expect(javascript).toContain("/api/v1/mobile/pairing/preview");
    expect(javascript).toContain("/api/v1/mobile/pairing/claim");
    expect(javascript).toContain("/api/v1/mobile/session/renew");
    expect(javascript).toContain("/api/v1/mobile/device");
    expect(stylesheet).toContain(".acceptance-runner");
    expect(stylesheet).toContain(".acceptance-step");
    expect(developmentConsole).toContain('"/mobileAcceptance.js"');
    expect(developmentConsole).toContain('"/mobile-acceptance.css"');
  });

  it("keeps pairing and device material in memory and redacts the report", () => {
    const javascript = read(mobileAcceptanceModule);

    expect(javascript).not.toContain("localStorage");
    expect(javascript).not.toMatch(/sessionStorage\.setItem\([^\n]*(deviceCredential|installationId|pairing)/i);
    expect(javascript).not.toMatch(/console\.(log|info|warn|error)/);
    expect(javascript).toContain("报告不会包含配对码、二维码内容、设备凭证、Session Token 或数据库内容");
    expect(javascript).toContain("pairingMaterial = null");
    expect(javascript).toContain("firstDevice = null");
    expect(javascript).toContain("secondDevice = null");
  });

  it("is valid JavaScript before the browser loads it", () => {
    const result = spawnSync(process.execPath, ["--check", mobileAcceptanceModule], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
