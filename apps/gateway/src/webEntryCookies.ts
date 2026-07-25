import type { FastifyRequest } from "fastify";
import { GatewayDomainError } from "./service.js";

export type WebCookieMode = "test" | "development" | "production";

export const WEB_COOKIE_NAMES = {
  deviceRef: "family_ai_web_device_ref",
  deviceCredential: "family_ai_web_device_credential",
  entrySessionRef: "family_ai_web_entry_session_ref",
  entryToken: "family_ai_web_entry_token"
} as const;

export interface WebEntryCookieSecrets {
  deviceRef: string;
  deviceCredential: string;
  entrySessionRef: string;
  entryToken: string;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cookie(
  name: string,
  value: string,
  mode: WebCookieMode,
  input: { maxAge?: number; expires?: Date } = {}
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Priority=High"
  ];
  if (input.maxAge !== undefined) parts.push(`Max-Age=${input.maxAge}`);
  if (input.expires) parts.push(`Expires=${input.expires.toUTCString()}`);
  if (mode === "production") parts.push("Secure");
  return parts.join("; ");
}

function expiredCookie(name: string, mode: WebCookieMode): string {
  return cookie(name, "", mode, {
    maxAge: 0,
    expires: new Date(0)
  });
}

export function setWebEntryCookieHeaders(
  secrets: WebEntryCookieSecrets,
  mode: WebCookieMode
): string[] {
  return [
    cookie(WEB_COOKIE_NAMES.deviceRef, secrets.deviceRef, mode, { maxAge: 365 * 24 * 60 * 60 }),
    cookie(
      WEB_COOKIE_NAMES.deviceCredential,
      secrets.deviceCredential,
      mode,
      { maxAge: 365 * 24 * 60 * 60 }
    ),
    cookie(WEB_COOKIE_NAMES.entrySessionRef, secrets.entrySessionRef, mode),
    cookie(WEB_COOKIE_NAMES.entryToken, secrets.entryToken, mode)
  ];
}

export function clearWebSessionCookieHeaders(mode: WebCookieMode): string[] {
  return [
    expiredCookie(WEB_COOKIE_NAMES.entrySessionRef, mode),
    expiredCookie(WEB_COOKIE_NAMES.entryToken, mode)
  ];
}

export function clearAllWebEntryCookieHeaders(mode: WebCookieMode): string[] {
  return [
    expiredCookie(WEB_COOKIE_NAMES.deviceRef, mode),
    expiredCookie(WEB_COOKIE_NAMES.deviceCredential, mode),
    ...clearWebSessionCookieHeaders(mode)
  ];
}

export function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  if (typeof header !== "string") return {};
  const result: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const encoded = pair.slice(separator + 1).trim();
    if (!name || !encoded) continue;
    try {
      result[name] = decodeURIComponent(encoded);
    } catch {
      // Ignore malformed Cookie pairs instead of treating them as credentials.
    }
  }
  return result;
}

function bridgePath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return path === "/api/v1/web-entry/context" ||
    path === "/api/v1/web-entry/logout" ||
    path === "/api/v1/portal/context" ||
    path === "/api/v1/chat" ||
    path.startsWith("/api/v1/chat/") ||
    path === "/api/v1/work-conversations" ||
    path.startsWith("/api/v1/work-conversations/") ||
    path.startsWith("/api/v1/threads/") ||
    path === "/api/v1/events/stream" ||
    path.startsWith("/api/v1/sync/");
}

function forbiddenWebRequest(): GatewayDomainError {
  return new GatewayDomainError(
    "WEB_REQUEST_FORBIDDEN",
    403,
    "permission",
    false,
    "浏览器请求来源不正确。"
  );
}

export function assertWebCookieRequestAllowed(request: FastifyRequest): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;

  if (headerString(request.headers["x-family-ai-web-request"]) !== "1") {
    throw forbiddenWebRequest();
  }

  const fetchSite = headerString(request.headers["sec-fetch-site"]);
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    throw forbiddenWebRequest();
  }

  const origin = headerString(request.headers.origin);
  const host = headerString(request.headers.host);
  if (origin !== undefined) {
    if (!host || origin !== `${request.protocol}://${host}`) {
      throw forbiddenWebRequest();
    }
  }
}

export function applyWebEntryCookieHeaders(request: FastifyRequest): boolean {
  if (request.headers.authorization || !bridgePath(request.url)) return false;

  const cookies = parseCookieHeader(request.headers.cookie);
  const entrySessionRef = cookies[WEB_COOKIE_NAMES.entrySessionRef];
  const entryToken = cookies[WEB_COOKIE_NAMES.entryToken];
  if (!entrySessionRef || !entryToken) return false;

  assertWebCookieRequestAllowed(request);
  request.headers.authorization = `Bearer ${entryToken}`;
  request.headers["x-entry-session-ref"] = entrySessionRef;
  return true;
}

export function readWebDeviceCookies(request: FastifyRequest): {
  deviceRef: string;
  deviceCredential: string;
} | null {
  const cookies = parseCookieHeader(request.headers.cookie);
  const deviceRef = cookies[WEB_COOKIE_NAMES.deviceRef];
  const deviceCredential = cookies[WEB_COOKIE_NAMES.deviceCredential];
  return deviceRef && deviceCredential ? { deviceRef, deviceCredential } : null;
}
