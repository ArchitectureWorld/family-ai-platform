import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MOBILE_ENTRY_PROTOCOL_VERSION,
  deviceCredentialSchema,
  mobileDeviceRefSchema,
  pairingClaimRequestSchema,
  pairingPreviewRequestSchema,
  pairingQrPayloadSchema,
  pairingRefSchema,
  personRefSchema,
  secureGatewayBaseUrlSchema
} from "@family-ai/contracts";
import {
  EntrySessionAuthenticator,
  requireEntryRequest
} from "./entrySessionAuth.js";
import { MobilePairingRepository } from "./mobilePairing.js";
import { GatewayDomainError } from "./service.js";

function mobileError(
  code: string,
  statusCode: number,
  category: "validation" | "permission" | "availability" | "timeout" | "conflict" | "internal",
  message: string,
  retryable = false
): GatewayDomainError {
  return new GatewayDomainError(code, statusCode, category, retryable, message);
}

function rejectAuthorizationOnPublicPairing(request: FastifyRequest): void {
  if (request.headers.authorization) {
    throw mobileError(
      "PAIRING_INVALID",
      400,
      "validation",
      "公开配对接口不接受 Authorization。"
    );
  }
}

function requireProtocolVersion(body: unknown): void {
  if (
    !body ||
    typeof body !== "object" ||
    (body as Record<string, unknown>).protocolVersion !== MOBILE_ENTRY_PROTOCOL_VERSION
  ) {
    throw mobileError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      400,
      "validation",
      "不支持的 Mobile Entry 协议版本。"
    );
  }
}

function developmentLoopbackHost(host: string, mode: "test" | "development" | "production"): boolean {
  if (mode !== "development") return false;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/iu.test(host);
}

function requestGatewayBaseUrl(
  request: FastifyRequest,
  mode: "test" | "development" | "production"
): string {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProtocol = typeof forwarded === "string"
    ? forwarded.split(",", 1)[0]?.trim().toLowerCase()
    : undefined;
  const host = request.headers.host;
  const loopbackAcceptance = typeof host === "string" && developmentLoopbackHost(host, mode);
  const protocol = forwardedProtocol === "https" || request.protocol === "https" || loopbackAcceptance
    ? "https"
    : "http";
  const candidate = typeof host === "string" ? `${protocol}://${host}` : "";
  const parsed = secureGatewayBaseUrlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw mobileError(
      "PAIRING_INVALID",
      400,
      "validation",
      "请通过 Gateway 的 HTTPS 地址生成 iPhone 配对材料。"
    );
  }
  return parsed.data;
}

function deviceAuthentication(request: FastifyRequest, repository: MobilePairingRepository) {
  const authorization = request.headers.authorization;
  const refHeader = request.headers["x-device-ref"];
  const deviceRef = typeof refHeader === "string" ? refHeader : "";
  const credential = authorization?.startsWith("Device ")
    ? authorization.slice("Device ".length).trim()
    : "";
  if (
    !mobileDeviceRefSchema.safeParse(deviceRef).success ||
    !deviceCredentialSchema.safeParse(credential).success
  ) {
    throw mobileError("DEVICE_AUTH_INVALID", 401, "permission", "设备凭证无效。");
  }
  return repository.authenticateDevice(deviceRef, credential);
}

function pairingRequestError(): GatewayDomainError {
  return mobileError("PAIRING_INVALID", 400, "validation", "配对请求格式无效。");
}

export function registerMobileRoutes(
  app: FastifyInstance,
  input: {
    mobileRepository: MobilePairingRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    mode: "test" | "development" | "production";
  }
): void {
  app.post("/api/v1/admin/members/:personRef/pairing-codes", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const { personRef } = request.params as { personRef: string };
    if (!personRefSchema.safeParse(personRef).success) throw pairingRequestError();

    const gateway = requestGatewayBaseUrl(request, input.mode);
    const material = input.mobileRepository.createPairingCode({
      familyRef: context.family.familyRef,
      personRef,
      createdByEntryBindingRef: context.entryBindingRef
    });
    const qrPayload = pairingQrPayloadSchema.parse({
      version: MOBILE_ENTRY_PROTOCOL_VERSION,
      gateway,
      pairingRef: material.pairingRef,
      code: material.code,
      expiresAt: material.expiresAt
    });
    const fragment = new URLSearchParams({
      v: String(MOBILE_ENTRY_PROTOCOL_VERSION),
      gateway: qrPayload.gateway,
      pairingRef: qrPayload.pairingRef,
      code: qrPayload.code,
      expiresAt: qrPayload.expiresAt
    });

    return reply.code(201).send({
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      pairing: {
        pairingRef: material.pairingRef,
        code: material.code,
        expiresAt: material.expiresAt,
        status: "active"
      },
      family: material.family,
      person: material.person,
      qr: {
        payload: qrPayload,
        url: `familyai://pair#${fragment.toString()}`
      }
    });
  });

  app.delete("/api/v1/admin/pairing-codes/:pairingRef", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const { pairingRef } = request.params as { pairingRef: string };
    if (!pairingRefSchema.safeParse(pairingRef).success) throw pairingRequestError();
    const result = input.mobileRepository.revokePairingCode({
      familyRef: context.family.familyRef,
      pairingRef
    });
    return {
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      ...result
    };
  });

  app.delete("/api/v1/admin/devices/:deviceRef", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const { deviceRef } = request.params as { deviceRef: string };
    if (!mobileDeviceRefSchema.safeParse(deviceRef).success) {
      throw mobileError("DEVICE_AUTH_INVALID", 404, "permission", "设备不存在。");
    }
    return input.mobileRepository.revokeDevice({
      deviceRef,
      administratorFamilyRef: context.family.familyRef
    });
  });

  app.post("/api/v1/mobile/pairing/preview", async (request) => {
    rejectAuthorizationOnPublicPairing(request);
    requireProtocolVersion(request.body);
    const parsed = pairingPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) throw pairingRequestError();
    return input.mobileRepository.previewPairing({
      ...parsed.data,
      gatewayHost: request.hostname
    });
  });

  app.post("/api/v1/mobile/pairing/claim", async (request, reply) => {
    rejectAuthorizationOnPublicPairing(request);
    requireProtocolVersion(request.body);
    const parsed = pairingClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) throw pairingRequestError();
    const result = input.mobileRepository.claimPairing(parsed.data);
    return reply.code(201).send(result);
  });

  app.post("/api/v1/mobile/session/renew", async (request) => {
    const authentication = deviceAuthentication(request, input.mobileRepository);
    return input.mobileRepository.renewPersonalSession(authentication);
  });

  app.post("/api/v1/mobile/session/logout", async (request) => {
    const authentication = deviceAuthentication(request, input.mobileRepository);
    return input.mobileRepository.logoutPersonalSession(authentication);
  });

  app.delete("/api/v1/mobile/device", async (request) => {
    const authentication = deviceAuthentication(request, input.mobileRepository);
    return input.mobileRepository.revokeDevice({
      deviceRef: authentication.deviceRef,
      authenticatedDevice: authentication
    });
  });
}
