import { describe, expect, it, vi } from "vitest";
import { GatewayError, createApiClient } from "../member-public/api.js";
import { createStore } from "../member-public/store.js";

const webPairingRequest = {
  protocolVersion: 2,
  pairingRef: "pairing:web-1",
  code: "ABCD-EFGH",
  installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
  deviceCredential: "A".repeat(43),
  device: {
    displayName: "Alice 的浏览器",
    browser: "Chrome",
    operatingSystem: "Linux",
    appVersion: "0.1.0"
  }
};

async function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("EXPECTED_REJECTION");
    },
    (error) => error
  );
}

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
      protocolVersion: 2,
      error: {
        code: "PROVIDER_FAILED",
        category: "availability",
        message: "回复失败，可以重试。",
        retryable: true,
        requestId: "request:public-1"
      }
    }), { status: 502, headers: { "x-internal-trace": "must-not-leak" } }));
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
      expect(error).not.toHaveProperty("requestId");
      expect(error).not.toHaveProperty("headers");
    });
  });

  it("returns null for a Work that has no progress snapshot", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: 2,
      error: {
        code: "WORK_PROGRESS_NOT_FOUND",
        category: "permission",
        message: "没有进度。",
        retryable: false,
        requestId: "request:progress-1"
      }
    }), { status: 404 }));
    const api = createApiClient(fetchImpl as typeof fetch);
    await expect(api.getWorkProgress("work:0001")).resolves.toBeNull();
  });
});

describe("Member Web pairing API client", () => {
  it("accepts only exact 204 without consuming JSON and forwards the hardened request init", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return response;
    });
    const api = createApiClient(fetchImpl as typeof fetch);
    const signal = new AbortController().signal;

    await expect(
      api.claimWebPairing(webPairingRequest, { signal }),
    ).resolves.toBeUndefined();

    expect(json).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/v1/web-entry/pairing/claim",
      init: {
        method: "POST",
        body: JSON.stringify(webPairingRequest),
        credentials: "same-origin",
        keepalive: false,
        signal
      }
    });
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-family-ai-web-request")).toBe("1");
  });

  it("marks a strict parsed v2 non-2xx envelope rejected without exposing outcome or headers", async () => {
    const response = new Response(JSON.stringify({
      protocolVersion: 2,
      error: {
        code: "PAIRING_EXPIRED",
        category: "conflict",
        message: "配对码已过期。",
        retryable: false,
        requestId: "request:claim-1"
      }
    }), {
      status: 409,
      headers: { "x-internal-trace": "must-not-leak" }
    });
    const api = createApiClient(vi.fn(async () => response) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      status: 409,
      code: "PAIRING_EXPIRED",
      category: "conflict",
      retryable: false,
      claimOutcome: "rejected"
    });
    expect(Object.keys(error)).not.toContain("claimOutcome");
    expect(JSON.stringify(error)).not.toContain("claimOutcome");
    expect(error).not.toHaveProperty("headers");
    expect(error).not.toHaveProperty("response");
    expect(error).not.toHaveProperty("requestId");
  });

  it("clears entry cookies with a same-origin unsafe POST", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return new Response(null, { status: 204 });
    });
    const api = createApiClient(fetchImpl as typeof fetch);

    await expect(api.clearWebEntryCookies()).resolves.toBeNull();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/v1/web-entry/cookies/clear",
      init: { method: "POST", credentials: "same-origin" }
    });
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get("x-family-ai-web-request")).toBe("1");
  });

  it.each([
    ["network", new TypeError("Failed to fetch")],
    ["abort", new DOMException("Claim aborted", "AbortError")]
  ])("marks a %s failure unknown without making the outcome enumerable", async (_label, failure) => {
    const api = createApiClient(vi.fn(async () => {
      throw failure;
    }) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).toBe(failure);
    expect(error).toMatchObject({ claimOutcome: "unknown" });
    expect(Object.keys(error)).not.toContain("claimOutcome");
    expect(JSON.stringify(error)).not.toContain("claimOutcome");
  });

  it("marks a malformed non-2xx envelope unknown instead of treating it as a rejection", async () => {
    const response = new Response(JSON.stringify({
      protocolVersion: 2,
      error: {
        code: "PAIRING_EXPIRED",
        category: "conflict",
        message: "配对码已过期。",
        retryable: false
      }
    }), { status: 409 });
    const api = createApiClient(vi.fn(async () => response) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).not.toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "GATEWAY_RESPONSE_INVALID",
      claimOutcome: "unknown"
    });
    expect(Object.keys(error)).not.toContain("claimOutcome");
  });

  it("marks an unexpected success status unknown without consuming its JSON body", async () => {
    const response = new Response(JSON.stringify({
      protocolVersion: 2,
      status: "claimed"
    }), { status: 200 });
    const json = vi.spyOn(response, "json");
    const api = createApiClient(vi.fn(async () => response) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).toMatchObject({
      code: "ENTRY_CLAIM_RESPONSE_INVALID",
      claimOutcome: "unknown"
    });
    expect(Object.keys(error)).not.toContain("claimOutcome");
    expect(json).not.toHaveBeenCalled();
  });

  it("uses the same strict v2 parser for ordinary API error responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "PROVIDER_FAILED",
      category: "availability",
      message: "legacy unversioned error",
      retryable: true
    }), { status: 502 }));
    const api = createApiClient(fetchImpl as typeof fetch);

    await expect(api.listWorks()).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE_INVALID"
    });
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
