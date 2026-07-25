import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../member-public/entry.js", import.meta.url));

describe("Member Web browser installation lifecycle", () => {
  it("reads or creates the installation id at claim time so revoke can rotate it without reload", () => {
    const source = readFileSync(entryPath, "utf8");
    expect(source).toContain("function installationId()");
    expect(source).toContain("installationId: installationId()");
    expect(source).not.toContain("const installationId =");
    expect(source).toContain("localStorage.removeItem(installationKey)");
  });
});
