import type { FastifyInstance, FastifyRequest } from "fastify";
import { MOBILE_ENTRY_PROTOCOL_VERSION, personalPortalContextSchema } from "@family-ai/contracts";
import { z } from "zod";
import { FamilyDomainRepository } from "./familyDomain.js";
import { GatewayRepository } from "./database.js";
import {
  EntrySessionAuthenticator,
  requireEntryRequest
} from "./entrySessionAuth.js";
import { MobileDeviceSummaryRepository } from "./mobileDeviceSummary.js";
import { GatewayDomainError } from "./service.js";

const onboardingSchema = z
  .object({
    familyName: z.string().trim().min(1).max(80),
    ownerName: z.string().trim().min(1).max(80),
    deviceName: z.string().trim().min(1).max(80)
  })
  .strict();

const memberSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    familyRole: z.enum(["adult", "child", "elder"])
  })
  .strict();

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function deviceRef(request: FastifyRequest): string | null {
  const value = request.headers["x-device-ref"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidRequest(message: string): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, message);
}

export function registerFamilyRoutes(
  app: FastifyInstance,
  input: {
    familyRepository: FamilyDomainRepository;
    gatewayRepository: GatewayRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    mobileDeviceSummaryRepository: MobileDeviceSummaryRepository;
  }
): void {
  function requireSetupDevice(request: FastifyRequest) {
    const ref = deviceRef(request);
    const token = bearerToken(request);
    const device = ref && token ? input.gatewayRepository.authenticateDevice(ref, token) : null;
    if (!device) {
      throw new GatewayDomainError(
        "DEVICE_AUTH_INVALID",
        401,
        "permission",
        false,
        "设备编号或设备令牌不正确。"
      );
    }
    return { device, token: token! };
  }

  function withMobileDeviceCount<T extends { personRef: string; familyRef?: never }>(
    familyRef: string,
    member: T
  ) {
    return {
      ...member,
      activePersonalDeviceCount: input.mobileDeviceSummaryRepository.activePersonalDeviceCount(
        familyRef,
        member.personRef
      )
    };
  }

  app.get("/api/v1/onboarding/status", async () => ({
    initialized: input.familyRepository.isInitialized()
  }));

  app.post("/api/v1/onboarding/family", async (request, reply) => {
    const setup = requireSetupDevice(request);
    const parsed = onboardingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw invalidRequest("家庭名称、管理员姓名或设备名称不正确。");
    }
    const result = input.familyRepository.initializeFamily({
      ...parsed.data,
      deviceCredential: setup.token
    });
    return reply.code(201).send(result);
  });

  app.get("/api/v1/portal/context", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator);
    if (context.audience === "personal") {
      return personalPortalContextSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        ...context
      });
    }
    return {
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      ...context
    };
  });

  app.get("/api/v1/admin/members", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    return {
      members: input.familyRepository
        .listMembers(context.family.familyRef)
        .map((member) => withMobileDeviceCount(context.family.familyRef, member))
    };
  });

  app.post("/api/v1/admin/members", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const parsed = memberSchema.safeParse(request.body);
    if (!parsed.success) {
      throw invalidRequest("成员姓名或家庭角色不正确。");
    }
    const member = input.familyRepository.createMember({
      familyRef: context.family.familyRef,
      displayName: parsed.data.displayName,
      familyRole: parsed.data.familyRole
    });
    return reply.code(201).send({
      member: withMobileDeviceCount(context.family.familyRef, member)
    });
  });
}
