import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  WEB_COOKIE_NAMES,
  applyWebEntryCookieHeaders,
  assertWebCookieRequestAllowed,
  clearAllWebEntryCookieHeaders,
  clearWebSessionCookieHeaders,
  parseCookieHeader,
  setWebEntryCookieHeaders
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

  it("bridges Session cookies only for formal personal APIs and preserves explicit Authorization", () => {
    const cookie = [
      `${WEB_COOKIE_NAMES.entrySessionRef}=entry-session%3Aweb-alice`,
      `${WEB_COOKIE_NAMES.entryToken}=${"B".repeat(43)}`
    ].join("; ");
    const bridged = request({ headers: { cookie } });
    expect(applyWebEntryCookieHeaders(bridged)).toBe(true);
    expect(bridged.headers.authorization).toBe(`Bearer ${"B".repeat(43)}`);
    expect(bridged.headers["x-entry-session-ref"]).toBe("entry-session:web-alice");

    const explicit = request({ headers: { cookie, authorization: "Bearer explicit-token" } });
    expect(applyWebEntryCookieHeaders(explicit)).toBe(false);
    expect(explicit.headers.authorization).toBe("Bearer explicit-token");

    const unrelated = request({ url: "/health", headers: { cookie } });
    expect(applyWebEntryCookieHeaders(unrelated)).toBe(false);
    expect(unrelated.headers.authorization).toBeUndefined();
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
