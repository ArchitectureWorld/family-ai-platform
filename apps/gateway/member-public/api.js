const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

export function createApiClient(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new Error("FETCH_UNAVAILABLE");

  async function apiRequest(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    if (!SAFE_METHODS.has(method)) headers.set("x-family-ai-web-request", "1");

    const response = await fetchImpl(path, {
      method,
      headers,
      body,
      credentials: "same-origin",
      ...(options.signal ? { signal: options.signal } : {})
    });
    const responseBody = response.status === 204
      ? null
      : await response.json().catch(() => null);
    if (!response.ok) throw normalizedError(response.status, responseBody);
    return responseBody;
  }

  return {
    apiRequest,
    getWebContext: () => apiRequest("/api/v1/web-entry/context"),
    renewWebSession: () => apiRequest("/api/v1/web-entry/session/renew", { method: "POST" }),
    logoutWebSession: () => apiRequest("/api/v1/web-entry/logout", { method: "POST" }),
    revokeWebDevice: () => apiRequest("/api/v1/web-entry/device", { method: "DELETE" }),
    getHomeChat: (timezone) => apiRequest(queryPath("/api/v1/chat", { timezone })),
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
    listWorks: () => apiRequest("/api/v1/work-conversations"),
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
