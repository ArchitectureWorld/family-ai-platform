import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const directory = fileURLToPath(new URL("../admin-public/", import.meta.url));
const moduleUrl = pathToFileURL(join(directory, "admin-speakers.js")).href;
const apiUrl = pathToFileURL(join(directory, "admin-api.js")).href;
const now = new Date("2026-09-27T08:00:00Z");
const snapshot = () => ({ protocolVersion: 1, sourceState: "ready", sampledAt: now.toISOString(), speakers: [{
  speakerId: "112233aabbcc", displayName: "客厅 DIY", room: "客厅", board: "diy-n16r8",
  usbConnected: true, transport: "wifi", serviceState: "running", linkState: "connected", phase: "listening",
  runtimeUpdatedAt: now.toISOString(), firmware: "V4", volumePercent: 45,
  capabilities: { wifi: true, aec: false, duplex: false }, problemCode: null
}] });
class Element {
  children: Element[] = [];
  ownText = "";
  className = "";
  attributes = new Map<string, string>();
  constructor(readonly tagName: string) {}
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(" "); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.ownText = ""; }
}
const documentRef = { createElement: (tag: string) => new Element(tag) };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("speaker API and devices page", () => {
  it("uses the same-origin cookie API and removes unapproved response keys", async () => {
    const { createAdminApi } = await import(apiUrl);
    const value = snapshot(); Object.assign(value.speakers[0]!, { transcript: "PRIVATE" });
    const fetchImpl = vi.fn(async () => ({ status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => value }));
    const api = createAdminApi({ cookieSession: true, fetchImpl });
    expect(await api.speakers()).toEqual(snapshot());
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/admin/speakers", expect.objectContaining({ method: "GET" }));
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty("headers.Authorization");
  });

  it("renders independent USB, Wi-Fi, voice, capabilities and timestamps using text only", async () => {
    const { createSpeakerMonitor } = await import(moduleUrl);
    vi.useFakeTimers();
    const root = new Element("section");
    const monitor = createSpeakerMonitor({ root, api: { speakers: async () => snapshot() }, documentRef, now: () => now });
    await monitor.ready;
    for (const text of ["USB 已插入", "Wi-Fi 已连接", "正在聆听", "V4", "45%", "无 AEC", "半双工", "客厅", "2026"]) expect(root.textContent).toContain(text);
    expect(root.children.some(child => child.tagName === "button")).toBe(false);
    monitor.destroy();
    expect(root.textContent).toBe("");
  });

  it("refreshes every five seconds and never overlaps or keeps green data after TTL while a request hangs", async () => {
    const { createSpeakerMonitor } = await import(moduleUrl);
    vi.useFakeTimers(); vi.setSystemTime(now);
    let calls = 0;
    const root = new Element("section");
    const monitor = createSpeakerMonitor({ root, documentRef, api: { speakers: async () => {
      if (++calls === 1) return snapshot();
      return new Promise(() => {});
    } } });
    await monitor.ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(2);
    expect(root.textContent).toContain("采集已过期");
    expect(root.textContent).not.toContain("Wi-Fi 已连接");
    expect(root.textContent).not.toContain("正在聆听");
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys polling on exit and ignores the late response", async () => {
    const { createSpeakerMonitor } = await import(moduleUrl);
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const root = new Element("section");
    const monitor = createSpeakerMonitor({ root, documentRef, api: { speakers: () => new Promise(done => { resolve = done; }) } });
    monitor.destroy(); resolve(snapshot()); await monitor.ready;
    expect(root.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])("clears previous data and stops polling on authorization error %i", async status => {
    const { createSpeakerMonitor } = await import(moduleUrl);
    vi.useFakeTimers();
    let calls = 0;
    const onAuthenticationError = vi.fn();
    const root = new Element("section");
    const monitor = createSpeakerMonitor({ root, documentRef, now: () => now, onAuthenticationError, api: { speakers: async () => {
      if (++calls === 1) return snapshot();
      throw Object.assign(new Error("PRIVATE_ERROR"), { status });
    } } });
    await monitor.ready; await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(root.textContent).not.toContain("客厅 DIY");
    expect(root.textContent).not.toContain("PRIVATE_ERROR");
    expect(root.textContent).toContain("管理员授权已失效");
    expect(onAuthenticationError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    monitor.destroy();
  });

  it.each(["stale", "unavailable", "not_configured"])("renders explicit source state %s without active voice or green connection", async sourceState => {
    const { createSpeakerMonitor } = await import(moduleUrl);
    vi.useFakeTimers();
    const root = new Element("section");
    const value = { ...snapshot(), sourceState };
    if (sourceState !== "stale") { value.speakers = []; value.sampledAt = null as unknown as string; }
    const monitor = createSpeakerMonitor({ root, documentRef, now: () => now, api: { speakers: async () => value } });
    await monitor.ready;
    expect(root.textContent).toContain({ stale: "采集已过期", unavailable: "暂时无法获取", not_configured: "尚未配置" }[sourceState]!);
    expect(root.textContent).not.toContain("Wi-Fi 已连接");
    expect(root.textContent).not.toContain("正在聆听");
    monitor.destroy();
  });
});
