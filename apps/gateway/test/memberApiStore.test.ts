import { describe, expect, it, vi } from "vitest";
import { GatewayError, createApiClient } from "../member-public/api.js";
import { createStore } from "../member-public/store.js";

describe("Member Web API client", () => {
  it("uses same-origin Cookie requests and adds the browser safety header only to unsafe methods", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const api = createApiClient(fetchImpl as typeof fetch);

    await api.listWorks();
    await api.createWork({
      protocolVersion: 1,
      title: "产品工作台",
      goal: "验证真实 Work"
    });

    expect(requests[0]).toMatchObject({
      path: "/api/v1/work-conversations",
      init: { method: "GET", credentials: "same-origin" }
    });
    expect(new Headers(requests[0].init.headers).has("x-family-ai-web-request")).toBe(false);

    expect(requests[1]).toMatchObject({
      path: "/api/v1/work-conversations",
      init: { method: "POST", credentials: "same-origin" }
    });
    const headers = new Headers(requests[1].init.headers);
    expect(headers.get("x-family-ai-web-request")).toBe("1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("builds encoded Chat, Thread, Work and Sync requests", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (path: string) => {
      paths.push(path);
      return new Response(JSON.stringify({ protocolVersion: 1 }), { status: 200 });
    });
    const api = createApiClient(fetchImpl as typeof fetch);

    await api.getHomeChat("America/Los_Angeles");
    await api.getThreadMessages("thread:work/unsafe", { beforeSequence: 40, limit: 20 });
    await api.getWorkProgress("work:unsafe/value");
    await api.getSyncEvents({ afterSequence: 12, limit: 100 });

    expect(paths).toEqual([
      "/api/v1/chat?timezone=America%2FLos_Angeles",
      "/api/v1/threads/thread%3Awork%2Funsafe/messages?beforeSequence=40&limit=20",
      "/api/v1/work-conversations/work%3Aunsafe%2Fvalue/progress",
      "/api/v1/sync/events?afterSequence=12&limit=100"
    ]);
  });

  it("normalizes PublicError responses without exposing internal bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "PROVIDER_FAILED",
      category: "availability",
      message: "回复失败，可以重试。",
      retryable: true,
      internalStack: "must-not-leak"
    }), { status: 502 }));
    const api = createApiClient(fetchImpl as typeof fetch);

    await expect(api.listWorks()).rejects.toEqual(expect.objectContaining({
      name: "GatewayError",
      status: 502,
      code: "PROVIDER_FAILED",
      category: "availability",
      message: "回复失败，可以重试。",
      retryable: true
    }));
    await api.listWorks().catch((error) => {
      expect(error).toBeInstanceOf(GatewayError);
      expect(error).not.toHaveProperty("internalStack");
    });
  });

  it("returns null for a Work that has no progress snapshot", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "WORK_PROGRESS_NOT_FOUND",
      category: "permission",
      message: "没有进度。",
      retryable: false
    }), { status: 404 }));
    const api = createApiClient(fetchImpl as typeof fetch);
    await expect(api.getWorkProgress("work:0001")).resolves.toBeNull();
  });
});

describe("Member Web in-memory store", () => {
  it("publishes immutable snapshots once per state update", () => {
    const store = createStore({ section: "chat", messages: [] as string[] });
    const observed: unknown[] = [];
    const unsubscribe = store.subscribe((snapshot) => observed.push(snapshot));

    store.setState((current) => ({
      ...current,
      messages: [...current.messages, "message:0001"]
    }));

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ section: "chat", messages: ["message:0001"] });
    const snapshot = store.getState();
    snapshot.messages.push("local-mutation");
    expect(store.getState().messages).toEqual(["message:0001"]);

    unsubscribe();
    store.setState({ section: "work" });
    expect(observed).toHaveLength(1);
  });

  it("resets to the original product state", () => {
    const store = createStore({ section: "chat", selectedWorkRef: null as string | null });
    store.setState({ section: "work", selectedWorkRef: "work:0001" });
    store.reset();
    expect(store.getState()).toEqual({ section: "chat", selectedWorkRef: null });
  });
});
