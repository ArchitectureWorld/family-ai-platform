import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const publicDirectory = join(repositoryRoot, "apps/gateway/public");

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("one-click beginner Mobile Entry acceptance", () => {
  it("ships a visible guided acceptance runner and redacted report", () => {
    const html = read(join(publicDirectory, "index.html"));
    const javascript = read(join(publicDirectory, "acceptance.js"));
    const stylesheet = read(join(publicDirectory, "acceptance.css"));

    expect(html).toContain('id="runMobileAcceptance"');
    expect(html).toContain('id="mobileAcceptanceSteps"');
    expect(html).toContain('id="mobileAcceptanceReport"');
    expect(html).toContain("一键体验验收");

    expect(javascript).toContain("runMobileAcceptance");
    expect(javascript).toContain("simulateMobileClaim");
    expect(javascript).toContain("renderMobileAcceptanceReport");
    expect(javascript).toContain("/api/v1/mobile/pairing/preview");
    expect(javascript).toContain("/api/v1/mobile/pairing/claim");
    expect(javascript).toContain("/api/v1/mobile/session/renew");
    expect(javascript).toContain("/api/v1/mobile/device");
    expect(javascript).not.toMatch(/sessionStorage\.setItem\([^\n]*(deviceCredential|installationId|pairing)/i);
    expect(stylesheet).toContain(".acceptance-runner");
    expect(stylesheet).toContain(".acceptance-step");
  });

  it("turns the existing acceptance script into a self-preparing browser launcher", () => {
    const script = read(join(repositoryRoot, "scripts/acceptance-mobile-pairing.sh"));

    expect(script).toContain("prepare_beginner_environment");
    expect(script).toContain("prepare_browser_experience");
    expect(script).toContain("open_acceptance_url");
    expect(script).toContain("mode=mobile-acceptance");
    expect(script).toContain("./scripts/verify-foundation.sh");
    expect(script).not.toContain("run ./scripts/verify-foundation.sh first");
  });
});
