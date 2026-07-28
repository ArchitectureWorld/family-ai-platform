const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const GATEWAY_ERROR_CATEGORIES = new Set([
  "validation", "permission", "availability", "timeout", "conflict", "internal"
]);
const GATEWAY_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

export class GatewayError extends Error {
  constructor(input) {
    super(input.message);
    this.name = "GatewayError";
    this.status = input.status;
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
  }
}

function queryPath(path, values = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function localApiError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.category = "internal";
  error.retryable = false;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isGatewayErrorEnvelope(body) {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["protocolVersion", "error"]) ||
    body.protocolVersion !== 2 ||
    !isRecord(body.error) ||
    !hasExactKeys(body.error, [
      "code", "category", "message", "retryable", "requestId"
    ])
  ) {
    return false;
  }
  const error = body.error;
  return (
    typeof error.code === "string" &&
    GATEWAY_ERROR_CODE_PATTERN.test(error.code) &&
    typeof error.category === "string" &&
    GATEWAY_ERROR_CATEGORIES.has(error.category) &&
    typeof error.message === "string" &&
    error.message.length >= 1 &&
    error.message.length <= 500 &&
    typeof error.retryable === "boolean" &&
    typeof error.requestId === "string" &&
    error.requestId.length >= 1
  );
}

function normalizedError(status, body) {
  const publicError = body?.error ?? body ?? {};
  return new GatewayError({
    status,
    code: typeof publicError.code === "string" ? publicError.code : "GATEWAY_UNAVAILABLE",
    category: typeof publicError.category === "string" ? publicError.category : "internal",
    message: typeof publicError.message === "string"
      ? publicError.message
      : `Gateway 请求失败（HTTP ${status}）。`,
    retryable: Boolean(publicError.retryable)
  });
}

function safeErrorProperty(error, property) {
  try {
    return error?.[property];
  } catch {
    return undefined;
  }
}

function wrappedClaimError(caught) {
  const sourceMessage = safeErrorProperty(caught, "message");
  const message = typeof sourceMessage === "string"
    ? sourceMessage
    : typeof caught === "string"
      ? caught
      : "配对请求失败。";
  const sourceName = safeErrorProperty(caught, "name");
  let error;
  if (caught instanceof TypeError) {
    error = new TypeError(message);
  } else if (
    typeof globalThis.DOMException === "function" &&
    caught instanceof globalThis.DOMException
  ) {
    error = new globalThis.DOMException(
      message,
      typeof sourceName === "string" ? sourceName : "Error"
    );
  } else {
    error = new Error(message);
    if (typeof sourceName === "string" && sourceName !== "") {
      error.name = sourceName;
    }
  }
  Object.defineProperty(error, "cause", {
    value: caught,
    enumerable: false,
    configurable: true
  });
  for (const property of ["code", "category", "retryable", "status"]) {
    const value = safeErrorProperty(caught, property);
    if (value !== undefined && !(property in error)) {
      Object.defineProperty(error, property, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
  }
  return error;
}

function claimErrorWithOutcome(caught, outcome) {
  const isObject =
    caught !== null &&
    (typeof caught === "object" || typeof caught === "function");
  if (isObject) {
    try {
      if (Object.isExtensible(caught) && !("claimOutcome" in caught)) {
        Object.defineProperty(caught, "claimOutcome", {
          value: outcome,
          enumerable: false
        });
        return caught;
      }
    } catch {
      // A hostile or non-extensible foreign error is wrapped below.
    }
  }

  const error = wrappedClaimError(caught);
  Object.defineProperty(error, "claimOutcome", {
    value: outcome,
    enumerable: false
  });
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

function mergeAbortSignals(defaultSignal, requestSignal) {
  const signals = [...new Set([defaultSignal, requestSignal].filter(Boolean))];
  if (signals.length < 2) {
    return { signal: signals[0], dispose: () => {} };
  }

  const controller = new AbortController();
  const listeners = new Map();
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  }
  const abortFrom = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    dispose();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return {
    signal: controller.signal,
    dispose
  };
}

export function createApiClient(
  fetchImpl = globalThis.fetch?.bind(globalThis),
  { defaultSignal, onRequest } = {}
) {
  if (typeof fetchImpl !== "function") throw new Error("FETCH_UNAVAILABLE");

  function throwIfRequestAborted(requestSignal) {
    throwIfAborted(defaultSignal);
    if (requestSignal !== defaultSignal) throwIfAborted(requestSignal);
  }

  async function rawApiRequest(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    if (!SAFE_METHODS.has(method)) headers.set("x-family-ai-web-request", "1");

    const merged = mergeAbortSignals(defaultSignal, options.signal);
    throwIfRequestAborted(options.signal);
    try {
      const rawFetchPromise = Promise.resolve(fetchImpl(path, {
        method,
        headers,
        body,
        credentials: "same-origin",
        ...(merged.signal ? { signal: merged.signal } : {}),
        ...(options.keepalive !== undefined
          ? { keepalive: options.keepalive }
          : {})
      }));
      onRequest?.(rawFetchPromise);
      const response = await rawFetchPromise;
      throwIfRequestAborted(options.signal);
      return response;
    } finally {
      merged.dispose();
    }
  }

  async function parseStrictGatewayError(response, requestSignal) {
    let responseBody;
    let parseFailed = false;
    try {
      responseBody = await response.json();
    } catch {
      parseFailed = true;
    }
    throwIfRequestAborted(requestSignal);
    if (parseFailed) {
      throw localApiError(
        "GATEWAY_RESPONSE_INVALID",
        "Gateway 返回了无效响应。"
      );
    }
    if (!isGatewayErrorEnvelope(responseBody)) {
      throw localApiError(
        "GATEWAY_RESPONSE_INVALID",
        "Gateway 返回了无效响应。"
      );
    }
    return normalizedError(response.status, responseBody);
  }

  async function parseGatewayError(response, requestSignal) {
    const responseBody = await response.json().catch(() => null);
    throwIfRequestAborted(requestSignal);
    return normalizedError(response.status, responseBody);
  }

  async function apiRequest(path, options = {}) {
    const response = await rawApiRequest(path, options);
    throwIfRequestAborted(options.signal);
    if (!response.ok) {
      throw await parseGatewayError(response, options.signal);
    }
    if (response.status === 204) return null;
    const responseBody = await response.json().catch(() => null);
    throwIfRequestAborted(options.signal);
    return responseBody;
  }

  return {
    apiRequest,
    claimWebPairing: async (request, { signal } = {}) => {
      let response;
      try {
        response = await rawApiRequest(
          "/api/v1/web-entry/pairing/claim",
          {
            method: "POST",
            body: request,
            signal,
            keepalive: false
          }
        );
      } catch (caught) {
        throw claimErrorWithOutcome(caught, "unknown");
      }

      if (response.status === 204) return;
      if (!response.ok) {
        let error;
        try {
          error = await parseStrictGatewayError(response, signal);
        } catch (caught) {
          throw claimErrorWithOutcome(caught, "unknown");
        }
        throw claimErrorWithOutcome(error, "rejected");
      }

      throw claimErrorWithOutcome(
        localApiError(
          "ENTRY_CLAIM_RESPONSE_INVALID",
          "配对响应无效。"
        ),
        "unknown"
      );
    },
    clearWebEntryCookies: () => apiRequest(
      "/api/v1/web-entry/cookies/clear",
      { method: "POST" }
    ),
    getWebContext: async () => ({
      protocolVersion: 2,
      context: await apiRequest("/api/v1/portal/context")
    }),
    renewWebSession: () => apiRequest("/api/v1/web-entry/session/renew", { method: "POST" }),
    logoutWebSession: () => apiRequest("/api/v1/web-entry/logout", { method: "POST" }),
    revokeWebDevice: () => apiRequest("/api/v1/web-entry/device", { method: "DELETE" }),
    getHomeChat: (agentRef, timezone) => {
      const legacyTimeZone = timezone === undefined && !String(agentRef).startsWith("agent:")
        ? agentRef
        : timezone;
      const selectedAgentRef = legacyTimeZone === agentRef ? undefined : agentRef;
      return apiRequest(queryPath("/api/v1/chat", { agentRef: selectedAgentRef, timezone: legacyTimeZone }));
    },
    getThreadMessages: (threadRef, options = {}) => apiRequest(queryPath(
      `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      {
        beforeSequence: options.beforeSequence,
        limit: options.limit
      }
    )),
    sendThreadMessage: (threadRef, request) => apiRequest(
      `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      { method: "POST", body: request }
    ),
    listWorks: (agentRef) =>
      apiRequest(queryPath("/api/v1/work-conversations", { agentRef })),
    createWork: (request) => apiRequest("/api/v1/work-conversations", {
      method: "POST",
      body: request
    }),
    async getWorkProgress(workConversationRef) {
      try {
        return await apiRequest(
          `/api/v1/work-conversations/${encodeURIComponent(workConversationRef)}/progress`
        );
      } catch (error) {
        if (error instanceof GatewayError && error.code === "WORK_PROGRESS_NOT_FOUND") return null;
        throw error;
      }
    },
    convertChatToWork: (request) => apiRequest("/api/v1/chat/work-conversions", {
      method: "POST",
      body: request
    }),
    getSyncEvents: (options = {}) => apiRequest(queryPath("/api/v1/sync/events", {
      afterSequence: options.afterSequence,
      limit: options.limit
    })),
    ackSyncEvent: (event) => apiRequest("/api/v1/sync/ack", {
      method: "POST",
      body: {
        protocolVersion: 1,
        eventSequence: event.eventSequence,
        eventRef: event.eventRef
      }
    })
  };
}
