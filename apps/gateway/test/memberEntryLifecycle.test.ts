import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../member-public/entry.js", import.meta.url));
const htmlPath = fileURLToPath(new URL("../member-public/index.html", import.meta.url));

describe("Member Web browser installation lifecycle", () => {
  it("reads or creates the installation id at claim time so revoke can rotate it without reload", () => {
    const source = readFileSync(entryPath, "utf8");
    expect(source).toContain("function installationId()");
    expect(source).toContain("installationId: installationId()");
    expect(source).not.toContain("const installationId =");
    expect(source).toContain("localStorage.removeItem(installationKey)");
  });

  it("clears a consumed deep-link reference before the user enters another pairing code", () => {
    const source = readFileSync(entryPath, "utf8");
    expect(source).toMatch(/function clearPairingLocation\(\)[\s\S]*state\.pairingRef = null;/);
  });

  it("updates the pairing explanation without replacing the product eyebrow", () => {
    const html = readFileSync(htmlPath, "utf8");
    const source = readFileSync(entryPath, "utf8");
    expect(html).toContain('id="pairingMessage"');
    expect(source).toContain('$("pairingMessage").textContent = message');
    expect(source).not.toContain('$("pairForm").querySelector("p").textContent');
  });

  it("offers an explicit device-session recovery action after logout", () => {
    const html = readFileSync(htmlPath, "utf8");
    const source = readFileSync(entryPath, "utf8");
    expect(html).toContain('id="resumeBrowserButton"');
    expect(source).toContain('$("resumeBrowserButton").addEventListener');
  });
});
