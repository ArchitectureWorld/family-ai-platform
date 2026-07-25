import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicDirectory = join(root, "apps/gateway/member-public");
const gatewaySource = join(root, "apps/gateway/src/memberWeb.ts");

function read(name: string) {
  return readFileSync(join(publicDirectory, name), "utf8");
}

const modules = [
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
];

describe("Member Web product modules", () => {
  it("ships syntactically valid focused ES modules through explicit product routes", () => {
    const registration = readFileSync(gatewaySource, "utf8");
    for (const name of modules) {
      const result = spawnSync(process.execPath, ["--check", join(publicDirectory, name)], {
        encoding: "utf8"
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(registration).toContain(`"/member/assets/${name}"`);
    }
    expect(registration).not.toContain("fastify-static");
    expect(registration).not.toContain("acceptance.js");
  });

  it("renders the normal Chat and Work product structure without debug or acceptance controls", () => {
    const html = read("index.html");
    for (const required of [
      'id="chatSection"',
      'id="workSection"',
      'id="threadMessages"',
      'aria-live="polite"',
      'id="messageComposer"',
      'id="messageInput"',
      'id="sendMessageButton"',
      'id="loadEarlierButton"',
      'id="workList"',
      'id="createWorkButton"',
      'id="createWorkDialog"',
      'id="workDetail"',
      'id="workProgress"',
      'id="chatToWorkDialog"',
      'id="mobileNavigation"'
    ]) {
      expect(html).toContain(required);
    }
    expect(html).not.toContain("验收台");
    expect(html).not.toContain("一键验收");
    expect(html).not.toContain("调试日志");
    expect(html).not.toContain("暂停 Work");
    expect(html).not.toContain("完成 Work");
    expect(html).not.toContain("归档 Work");
  });

  it("supports keyboard, touch, reduced motion and responsive layouts", () => {
    const html = read("index.html");
    const css = read("member.css");
    expect(html).toContain('aria-label="消息输入"');
    expect(html).toContain('<dialog id="createWorkDialog"');
    expect(html).toContain('<dialog id="chatToWorkDialog"');
    expect(css).toContain("@media (max-width:");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain(".mobile-navigation");
  });

  it("keeps user content in textContent-based rendering and credentials outside product modules", () => {
    const render = read("render.js");
    expect(render).toContain("textContent");
    expect(render).not.toContain("innerHTML");

    const source = modules.map(read).join("\n");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("family_ai_web_entry_token");
    expect(source).not.toContain("family_ai_web_device_credential");
    expect(source).not.toContain("externalSessionRef");
  });

  it("starts and stops the product workbench from the real Entry lifecycle", () => {
    const entry = read("entry.js");
    expect(entry).toContain('from "./product.js"');
    expect(entry).toContain("startProductWorkbench");
    expect(entry).toContain("stopProductWorkbench");
    expect(entry).toContain("clearProductWorkbenchCache");
    expect(entry).not.toContain("chatPreview");
    expect(entry).not.toContain("workPreview");
  });
});
