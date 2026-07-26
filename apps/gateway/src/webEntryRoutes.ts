import {
  WEB_ENTRY_PROTOCOL_VERSION,
  webEntryContextResponseSchema,
  webEntryOperationResponseSchema,
  webPairingClaimRequestSchema
} from "@family-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EntrySessionAuthenticator,
  requireEntryRequest,
  requireEntryRequestWithSession
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";
import {
  WebEntryRepository,
  type WebEntrySessionMaterial
} from "./webEntry.js";
import {
  applyWebEntryCookieHeaders,
  assertWebCookieRequestAllowed,
  clearAllWebEntryCookieHeaders,
  clearWebSessionCookieHeaders,
  setWebEntryCookieHeaders,
  useWebDeviceCookies,
  type WebCookieMode
} from "./webEntryCookies.js";

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

function invalidDevice(): GatewayDomainError {
  return new GatewayDomainError(
    "DEVICE_AUTH_INVALID",
    401,
    "permission",
    false,
    "浏览器设备凭证无效。"
  );
}

function authenticatedContext(
  authenticator: EntrySessionAuthenticator,
  session: WebEntrySessionMaterial
) {
  const authentication = authenticator.authenticate(
    session.entrySessionRef,
    session.entryToken
  );
  if (
    authentication.status !== "authenticated" ||
    authentication.context.audience !== "personal"
  ) {
    throw new GatewayDomainError(
      "ENTRY_SESSION_INVALID",
      401,
      "permission",
      false,
      "浏览器入口会话无效。"
    );
  }
  return authentication.context;
}

function setCookies(reply: FastifyReply, values: string[]): void {
  reply.header("Set-Cookie", values);
}

export function registerWebEntryCookieBridge(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    applyWebEntryCookieHeaders(request);
  });
}

export function registerWebEntryRoutes(
  app: FastifyInstance,
  input: {
    repository: WebEntryRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    mode: WebCookieMode;
  }
): void {
  app.post("/api/v1/web-entry/cookies/clear", async (request, reply) => {
    assertWebCookieRequestAllowed(request);
    if (request.headers.authorization) {
      throw invalidRequest("Cookie 清理接口不接受 Authorization。");
    }
    setCookies(reply, clearAllWebEntryCookieHeaders(input.mode));
    return reply.code(204).send();
  });

  app.post("/api/v1/web-entry/pairing/claim", async (request, reply) => {
    assertWebCookieRequestAllowed(request);
    if (request.headers.authorization) {
      throw invalidRequest("公开浏览器配对接口不接受 Authorization。");
    }
    const parsed = webPairingClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest("浏览器配对请求格式无效。");

    const existingDevice = useWebDeviceCookies(request);
    const claimed = input.repository.claimPairing({
      ...parsed.data,
      ...(existingDevice ? { existingDevice } : {})
    });
    authenticatedContext(input.entryAuthenticator, claimed);
    const cookieHeaders = setWebEntryCookieHeaders({
      deviceRef: claimed.deviceRef,
      deviceCredential: claimed.deviceCredential,
      entrySessionRef: claimed.entrySessionRef,
      entryToken: claimed.entryToken
    }, input.mode);
    setCookies(reply, cookieHeaders);
    return reply.code(204).send();
  });

  app.get("/api/v1/web-entry/context", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "personal");
    return webEntryContextResponseSchema.parse({
      protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
      context: {
        protocolVersion: 1,
        ...context
      }
    });
  });

  app.post("/api/v1/web-entry/session/renew", async (request, reply) => {
    assertWebCookieRequestAllowed(request);
    const cookies = useWebDeviceCookies(request);
    if (!cookies) throw invalidDevice();
    const device = input.repository.authenticateDevice(
      cookies.deviceRef,
      cookies.deviceCredential
    );
    const session = input.repository.renewSession(device);
    const context = authenticatedContext(input.entryAuthenticator, session);
    setCookies(reply, setWebEntryCookieHeaders({
      deviceRef: device.deviceRef,
      deviceCredential: cookies.deviceCredential,
      entrySessionRef: session.entrySessionRef,
      entryToken: session.entryToken
    }, input.mode));
    return webEntryContextResponseSchema.parse({
      protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
      context: {
        protocolVersion: 1,
        ...context
      }
    });
  });

  app.post("/api/v1/web-entry/logout", async (request, reply) => {
    const authenticated = requireEntryRequestWithSession(
      request,
      input.entryAuthenticator,
      "personal"
    );
    input.repository.logoutSession({
      entrySessionRef: authenticated.entrySessionRef,
      entryBindingRef: authenticated.context.entryBindingRef
    });
    setCookies(reply, clearWebSessionCookieHeaders(input.mode));
    return webEntryOperationResponseSchema.parse({
      protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
      status: "logged_out"
    });
  });

  app.delete("/api/v1/web-entry/device", async (request, reply) => {
    assertWebCookieRequestAllowed(request);
    const cookies = useWebDeviceCookies(request);
    if (!cookies) throw invalidDevice();
    const device = input.repository.authenticateDevice(
      cookies.deviceRef,
      cookies.deviceCredential
    );
    input.repository.revokeDevice(device);
    setCookies(reply, clearAllWebEntryCookieHeaders(input.mode));
    return webEntryOperationResponseSchema.parse({
      protocolVersion: WEB_ENTRY_PROTOCOL_VERSION,
      status: "revoked"
    });
  });
}

export function webEntryCookieRequest(request: FastifyRequest): boolean {
  return applyWebEntryCookieHeaders(request);
}
