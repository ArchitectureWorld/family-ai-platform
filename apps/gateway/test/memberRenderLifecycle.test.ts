import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const htmlPath = fileURLToPath(new URL("../member-public/index.html", import.meta.url));
const renderPath = fileURLToPath(new URL("../member-public/render.js", import.meta.url));

describe("Member Web render lifecycle", () => {
  it("keeps the global connection indicator aligned with network and sync state", () => {
    const render = readFileSync(renderPath, "utf8");
    expect(render).toContain('$("connectionStatus")');
    expect(render).toContain('connection online');
    expect(render).toContain('connection offline');
    expect(render).toContain('connection degraded');
  });

  it("clears the active composer only after a successful authoritative send", () => {
    const render = readFileSync(renderPath, "utf8");
    expect(render).toContain('result?.status === "succeeded"');
    expect(render).toContain('textarea.value = ""');
  });

  it("lets mobile users select an existing Work without opening the desktop sidebar", () => {
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain('id="mobileWorkSelect"');
    expect(html).toContain('aria-label="选择 Work"');
  });
});
