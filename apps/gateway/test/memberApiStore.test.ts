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

function expectClaimOutcome(error: Record<string, unknown>, outcome: string) {
  expect(error.claimOutcome).toBe(outcome);
  expect(Object.getOwnPropertyDescriptor(error, "claimOutcome")).toMatchObject({
    value: outcome,
    enumerable: false
  });
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

  it("reports the raw fetch Promise synchronously before awaiting transport settlement", async () => {
    let resolveFetch!: (response: Response) => void;
    const rawFetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = vi.fn(() => rawFetchPromise);
    const observed: Promise<Response>[] = [];
    const api = createApiClient(fetchImpl as typeof fetch, {
      onRequest(request) {
        observed.push(request);
      }
    });

    const request = api.listWorks();

    expect(observed).toEqual([rawFetchPromise]);
    resolveFetch(new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(request).resolves.toEqual({ conversations: [] });
  });

  it("tracks only raw transport settlement instead of response parsing", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    const rawFetchPromise = Promise.resolve({
      ok: true,
      status: 200,
      json: () => body.then((text) => JSON.parse(text))
    } as Response);
    const observedSettled = vi.fn();
    const api = createApiClient(vi.fn(() => rawFetchPromise) as typeof fetch, {
      onRequest(request) {
        void request.then(observedSettled);
      }
    });

    const request = api.listWorks();
    await rawFetchPromise;
    await Promise.resolve();

    expect(observedSettled).toHaveBeenCalledOnce();
    let requestSettled = false;
    void request.finally(() => {
      requestSettled = true;
    });
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    resolveBody(JSON.stringify({ conversations: [] }));
    await expect(request).resolves.toEqual({ conversations: [] });
  });

  it.each(["default", "request"])(
    "merges default and request-local AbortSignals when the %s signal aborts",
    async (source) => {
      const defaultAbort = new AbortController();
      const requestAbort = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_path: string, init: RequestInit) => {
        receivedSignal = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      const api = createApiClient(fetchImpl as typeof fetch, {
        defaultSignal: defaultAbort.signal
      });

      void api.claimWebPairing(webPairingRequest, { signal: requestAbort.signal });
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).not.toBe(defaultAbort.signal);
      expect(receivedSignal).not.toBe(requestAbort.signal);

      (source === "default" ? defaultAbort : requestAbort).abort();
      expect(receivedSignal?.aborted).toBe(true);
    }
  );

  it("deduplicates an identical default/request signal and blocks an ignored transport response after abort", async () => {
    let resolveFetch!: (response: Response) => void;
    const rawFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const api = createApiClient(vi.fn(() => rawFetch) as typeof fetch, {
      defaultSignal: abort.signal
    });

    const request = api.apiRequest("/ignored-abort", { signal: abort.signal });
    abort.abort();
    resolveFetch(Response.json({ mustNotContinue: true }));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes merged-signal listeners immediately on abort before an ignoring transport settles", async () => {
    let resolveFetch!: (response: Response) => void;
    const rawFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const defaultAbort = new AbortController();
    const requestAbort = new AbortController();
    const defaultAdd = vi.spyOn(defaultAbort.signal, "addEventListener");
    const defaultRemove = vi.spyOn(defaultAbort.signal, "removeEventListener");
    const requestAdd = vi.spyOn(requestAbort.signal, "addEventListener");
    const requestRemove = vi.spyOn(requestAbort.signal, "removeEventListener");
    const api = createApiClient(vi.fn(() => rawFetch) as typeof fetch, {
      defaultSignal: defaultAbort.signal
    });

    const request = api.apiRequest("/ignored-abort", {
      signal: requestAbort.signal
    });
    defaultAbort.abort();
    await Promise.resolve();

    expect(defaultAdd).toHaveBeenCalledOnce();
    expect(requestAdd).toHaveBeenCalledOnce();
    expect(defaultRemove).toHaveBeenCalledOnce();
    expect(requestRemove).toHaveBeenCalledOnce();

    resolveFetch(Response.json({ mustNotContinue: true }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(defaultRemove).toHaveBeenCalledOnce();
    expect(requestRemove).toHaveBeenCalledOnce();
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
      code: "WORK_PROGRESS_NOT_FOUND",
      category: "permission",
      message: "没有进度。",
      retryable: false
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

  it.each([
    ["frozen network", Object.freeze(new TypeError("Failed to fetch"))],
    ["frozen abort", Object.freeze(new DOMException("Claim aborted", "AbortError"))]
  ])("safely wraps a %s failure while preserving cause and recognizable semantics", async (kind, failure) => {
    const api = createApiClient(vi.fn(async () => {
      throw failure;
    }) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).not.toBe(failure);
    expect(error.cause).toBe(failure);
    expectClaimOutcome(error, "unknown");
    if (kind === "frozen network") expect(error).toBeInstanceOf(TypeError);
    else expect(error).toMatchObject({ name: "AbortError" });
  });

  it("wraps a sealed error instead of masking it with a defineProperty TypeError", async () => {
    const failure = Object.seal(new Error("sealed network failure"));
    const api = createApiClient(vi.fn(async () => {
      throw failure;
    }) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).not.toBe(failure);
    expect(error.cause).toBe(failure);
    expect(error.message).toBe("sealed network failure");
    expectClaimOutcome(error, "unknown");
  });

  it("wraps a primitive failure and preserves it as cause", async () => {
    const api = createApiClient(vi.fn(async () => {
      throw "primitive network failure";
    }) as typeof fetch);

    const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe("primitive network failure");
    expectClaimOutcome(error, "unknown");
  });

  it.each(["own", "inherited"])(
    "does not trust a spoofed %s claimOutcome property",
    async (propertyKind) => {
      const failure = propertyKind === "own"
        ? Object.assign(new Error("spoofed outcome"), { claimOutcome: "rejected" })
        : Object.assign(Object.create({ claimOutcome: "rejected" }), {
          message: "spoofed inherited outcome"
        });
      const api = createApiClient(vi.fn(async () => {
        throw failure;
      }) as typeof fetch);

      const error = await rejectionOf(api.claimWebPairing(webPairingRequest));

      expect(error).not.toBe(failure);
      expect(error.cause).toBe(failure);
      expectClaimOutcome(error, "unknown");
    }
  );

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

  it("keeps ordinary Chat and Work errors tolerant without weakening strict Claim parsing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "PROVIDER_FAILED",
      category: "availability",
      message: "ordinary unwrapped error",
      retryable: true
    }), { status: 502 }));
    const api = createApiClient(fetchImpl as typeof fetch);

    await expect(api.listWorks()).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      retryable: true
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
