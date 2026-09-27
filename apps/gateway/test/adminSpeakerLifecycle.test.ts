import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock("../admin-public/admin-api.js", () => ({
  AdminApiError: class extends Error {},
  createAdminApi: () => fixture.api
}));
class Element extends EventTarget {
  children: Element[] = [];
  ownText = "";
  hidden = false;
  disabled = false;
  className = "";
  value = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { toggle: vi.fn() };
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(" "); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.ownText = ""; }
  querySelector() { return null; }
}
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
let mountedDirectory = "";
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
  if (mountedDirectory) rmSync(mountedDirectory, { recursive: true, force: true });
});

it("switching away from Devices and leaving management destroys polling and discards pending data", async () => {
  vi.useFakeTimers();
  const selectors = new Map<string, Element>();
  const states = ["initializing", "management", "recovery-required", "create-family"].map(state => {
    const node = new Element(); node.dataset.state = state; return node;
  });
  const buttons = ["members", "workspace", "devices"].map(adminPage => {
    const node = new Element(); node.dataset.adminPage = adminPage; return node;
  });
  const documentRef = {
    querySelector(selector: string) {
      if (!selectors.has(selector)) selectors.set(selector, new Element());
      return selectors.get(selector);
    },
    querySelectorAll(selector: string) { return selector === "[data-state]" ? states : buttons; },
    createElement: () => new Element()
  };
  const windowRef = Object.assign(new EventTarget(), {
    location: { hash: "", search: "" }, history: { replaceState() {} },
    sessionStorage: { removeItem() {} }
  });
  vi.stubGlobal("document", documentRef); vi.stubGlobal("window", windowRef);
  const resolves: Array<(value: unknown) => void> = [];
  const speakers = vi.fn(() => new Promise(resolve => { resolves.push(resolve); }));
  fixture.api = {
    adminWebMode: async () => ({ mode: "production" }),
    context: async () => ({ family: { displayName: "测试家庭" }, person: { displayName: "管理员" } }),
    members: async () => ({ members: [] }), speakers
  };
  // Mirror adminWeb's HTTP asset mapping: qr.js is served from public/, while
  // all other imports are served from admin-public/. Only specifiers change.
  const adminDirectory = fileURLToPath(new URL("../admin-public/", import.meta.url));
  mountedDirectory = mkdtempSync(join(tmpdir(), "admin-speaker-lifecycle-"));
  const source = readFileSync(join(adminDirectory, "admin.js"), "utf8").replace(
    /from "\.\/([^"]+)"/g,
    (_match, file) => `from "${pathToFileURL(join(adminDirectory, file === "qr.js" ? "../public/qr.js" : file)).href}"`
  );
  const entry = join(mountedDirectory, "admin.mjs");
  writeFileSync(entry, source);
  const { showAdminState } = await import(pathToFileURL(entry).href);
  await flush();
  buttons[2]!.dispatchEvent(new Event("click"));
  expect(speakers).toHaveBeenCalledOnce();
  const root = selectors.get("#admin-devices-page")!;
  expect(root.hidden).toBe(false);
  buttons[0]!.dispatchEvent(new Event("click"));
  expect(root.hidden).toBe(true);
  expect(root.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  resolves[0]!({ protocolVersion: 1, sourceState: "not_configured", sampledAt: null, speakers: [] });
  await flush();
  expect(root.textContent).toBe("");
  buttons[2]!.dispatchEvent(new Event("click"));
  expect(speakers).toHaveBeenCalledTimes(2);
  showAdminState("recovery-required");
  resolves[1]!({ protocolVersion: 1, sourceState: "not_configured", sampledAt: null, speakers: [] });
  await flush();
  expect(root.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(speakers).toHaveBeenCalledTimes(2);
});
