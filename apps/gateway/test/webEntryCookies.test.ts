import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  WEB_COOKIE_NAMES,
  applyWebEntryCookieHeaders,
  assertWebCookieRequestAllowed,
  clearAllWebEntryCookieHeaders,
  clearWebSessionCookieHeaders,
  parseCookieHeader,
  setWebEntryCookieHeaders,
  useWebDeviceCookies,
  webAuthenticationSource,
  webErrorCookieHeaders
} from "../src/webEntryCookies.js";

function request(input: {
  method?: string;
  url?: string;
  headers?: Record<string, string | undefined>;
  protocol?: string;
} = {}): FastifyRequest {
  return {
    method: input.method ?? "GET",
    url: input.url ?? "/api/v1/chat",
    protocol: input.protocol ?? "https",
    headers: {
      host: "family.example",
      ...(input.headers ?? {})
    }
  } as unknown as FastifyRequest;
}

describe("Web Entry Cookie helpers", () => {
  const secrets = {
    deviceRef: "device:web-alice",
    deviceCredential: "A".repeat(43),
    entrySessionRef: "entry-session:web-alice",
    entryToken: "B".repeat(43)
  };

  it("sets HttpOnly Strict cookies and only adds Secure in production", () => {
    const production = setWebEntryCookieHeaders(secrets, "production");
    expect(production).toHaveLength(4);
    for (const value of production) {
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/");
      expect(value).toContain("Secure");
      expect(value).not.toContain("Domain=");
    }

    const development = setWebEntryCookieHeaders(secrets, "development");
    expect(development.every((value) => !value.includes("Secure"))).toBe(true);
  });

  it("clears session cookies separately from persistent Device cookies", () => {
    const session = clearWebSessionCookieHeaders("development");
    expect(session).toHaveLength(2);
    expect(session.join("\n")).toContain(WEB_COOKIE_NAMES.entrySessionRef);
    expect(session.join("\n")).toContain(WEB_COOKIE_NAMES.entryToken);
    expect(session.join("\n")).not.toContain(WEB_COOKIE_NAMES.deviceCredential);
    expect(session.every((value) => value.includes("Max-Age=0"))).toBe(true);

    const all = clearAllWebEntryCookieHeaders("production");
    expect(all).toHaveLength(4);
    expect(all.every((value) => value.includes("Max-Age=0") && value.includes("Secure")))
      .toBe(true);
  });

  it("parses encoded Cookie values without treating malformed pairs as credentials", () => {
    expect(parseCookieHeader(
      `${WEB_COOKIE_NAMES.deviceRef}=device%3Aweb-alice; invalid; ${WEB_COOKIE_NAMES.entryToken}=token_value`
    )).toMatchObject({
      [WEB_COOKIE_NAMES.deviceRef]: "device:web-alice",
      [WEB_COOKIE_NAMES.entryToken]: "token_value"
    });
  });

  it("records Entry Cookie provenance but preserves explicit Authorization", () => {
    const cookie = [
      `${WEB_COOKIE_NAMES.entrySessionRef}=entry-session%3Aweb-alice`,
      `${WEB_COOKIE_NAMES.entryToken}=${"B".repeat(43)}`
    ].join("; ");
    const bridged = request({ headers: { cookie } });
    expect(applyWebEntryCookieHeaders(bridged)).toBe(true);
    expect(bridged.headers.authorization).toBe(`Bearer ${"B".repeat(43)}`);
    expect(bridged.headers["x-entry-session-ref"]).toBe("entry-session:web-alice");
    expect(webAuthenticationSource(bridged)).toBe("entry_cookie");

    const explicit = request({ headers: { cookie, authorization: "Bearer explicit-token" } });
    expect(applyWebEntryCookieHeaders(explicit)).toBe(false);
    expect(explicit.headers.authorization).toBe("Bearer explicit-token");
    expect(webAuthenticationSource(explicit)).toBe("explicit_authorization");

    const unrelated = request({ url: "/health", headers: { cookie } });
    expect(applyWebEntryCookieHeaders(unrelated)).toBe(false);
    expect(unrelated.headers.authorization).toBeUndefined();
    expect(webAuthenticationSource(unrelated)).toBe("none");
  });

  it("records Device Cookie provenance only when a route deliberately uses the credentials", () => {
    const cookie = [
      `${WEB_COOKIE_NAMES.deviceRef}=device%3Aweb-alice`,
      `${WEB_COOKIE_NAMES.deviceCredential}=${"A".repeat(43)}`
    ].join("; ");
    const deliberate = request({
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie }
    });
    expect(webAuthenticationSource(deliberate)).toBe("none");
    expect(useWebDeviceCookies(deliberate)).toEqual({
      deviceRef: "device:web-alice",
      deviceCredential: "A".repeat(43)
    });
    expect(webAuthenticationSource(deliberate)).toBe("device_cookie");

    const explicit = request({
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie, authorization: "Bearer explicit-token" }
    });
    expect(useWebDeviceCookies(explicit)).toEqual({
      deviceRef: "device:web-alice",
      deviceCredential: "A".repeat(43)
    });
    expect(webAuthenticationSource(explicit)).toBe("explicit_authorization");
  });

  it("clears exactly the cookies permitted by authentication source and error code", () => {
    const sessionInvalid = webErrorCookieHeaders({
      source: "entry_cookie",
      errorCode: "ENTRY_SESSION_INVALID",
      mode: "development"
    });
    const sessionExpired = webErrorCookieHeaders({
      source: "entry_cookie",
      errorCode: "ENTRY_SESSION_EXPIRED",
      mode: "development"
    });
    for (const values of [sessionInvalid, sessionExpired]) {
      expect(values).toHaveLength(2);
      expect(values.join("\n")).toContain(WEB_COOKIE_NAMES.entrySessionRef);
      expect(values.join("\n")).toContain(WEB_COOKIE_NAMES.entryToken);
      expect(values.join("\n")).not.toContain(WEB_COOKIE_NAMES.deviceRef);
      expect(values.join("\n")).not.toContain(WEB_COOKIE_NAMES.deviceCredential);
    }

    for (const [source, errorCode] of [
      ["entry_cookie", "DEVICE_REVOKED"],
      ["device_cookie", "DEVICE_AUTH_INVALID"],
      ["device_cookie", "DEVICE_REVOKED"]
    ] as const) {
      const values = webErrorCookieHeaders({ source, errorCode, mode: "development" });
      expect(values).toHaveLength(4);
      expect(values.every((value) => value.includes("Max-Age=0"))).toBe(true);
    }
  });

  it("has no Cookie side effects for explicit, absent, or unrelated authentication failures", () => {
    for (const [source, errorCode] of [
      ["explicit_authorization", "DEVICE_REVOKED"],
      ["explicit_authorization", "ENTRY_SESSION_EXPIRED"],
      ["none", "DEVICE_REVOKED"],
      ["none", "ENTRY_SESSION_INVALID"],
      ["entry_cookie", "DEVICE_AUTH_INVALID"],
      ["entry_cookie", "REQUEST_INVALID"],
      ["device_cookie", "ENTRY_SESSION_INVALID"],
      ["device_cookie", "ENTRY_SESSION_EXPIRED"],
      ["device_cookie", "REQUEST_INVALID"]
    ] as const) {
      expect(webErrorCookieHeaders({ source, errorCode, mode: "development" })).toEqual([]);
    }
  });

  it("requires same-origin metadata and a custom header for unsafe Cookie requests", () => {
    const safe = request({
      method: "POST",
      headers: {
        "x-family-ai-web-request": "1",
        "sec-fetch-site": "same-origin",
        origin: "https://family.example"
      }
    });
    expect(() => assertWebCookieRequestAllowed(safe)).not.toThrow();

    const proxied = request({
      method: "POST",
      protocol: "http",
      headers: {
        "x-family-ai-web-request": "1",
        "sec-fetch-site": "same-origin",
        origin: "https://family.example"
      }
    });
    expect(() => assertWebCookieRequestAllowed(proxied)).not.toThrow();

    for (const candidate of [
      request({ method: "POST" }),
      request({ method: "POST", headers: { "x-family-ai-web-request": "1", "sec-fetch-site": "cross-site" } }),
      request({ method: "POST", headers: { "x-family-ai-web-request": "1", origin: "https://evil.example" } })
    ]) {
      expect(() => assertWebCookieRequestAllowed(candidate)).toThrowError(
        expect.objectContaining({ code: "WEB_REQUEST_FORBIDDEN", statusCode: 403 })
      );
    }

    expect(() => assertWebCookieRequestAllowed(request({ method: "GET" }))).not.toThrow();
  });
});
