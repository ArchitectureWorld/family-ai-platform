import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { FamilyDomainRepository, type EntryAudience, type EntryContext } from "./familyDomain.js";
import { GatewayRepository } from "./database.js";
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

function entrySessionRef(request: FastifyRequest): string | null {
  const value = request.headers["x-entry-session-ref"];
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

  function requireEntry(
    request: FastifyRequest,
    expectedAudience?: EntryAudience
  ): EntryContext {
    const sessionRef = entrySessionRef(request);
    const token = bearerToken(request);
    const context = sessionRef && token
      ? input.familyRepository.authenticateEntrySession(sessionRef, token)
      : null;
    if (!context) {
      throw new GatewayDomainError(
        "ENTRY_SESSION_INVALID",
        401,
        "permission",
        false,
        "入口会话无效或已失效。"
      );
    }
    if (expectedAudience && context.audience !== expectedAudience) {
      throw new GatewayDomainError(
        "ENTRY_AUDIENCE_FORBIDDEN",
        403,
        "permission",
        false,
        "当前入口没有执行家庭管理操作的权限。"
      );
    }
    return context;
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

  app.get("/api/v1/portal/context", async (request) => requireEntry(request));

  app.get("/api/v1/admin/members", async (request) => {
    const context = requireEntry(request, "family_admin");
    return {
      members: input.familyRepository.listMembers(context.family.familyRef)
    };
  });

  app.post("/api/v1/admin/members", async (request, reply) => {
    const context = requireEntry(request, "family_admin");
    const parsed = memberSchema.safeParse(request.body);
    if (!parsed.success) {
      throw invalidRequest("成员姓名或家庭角色不正确。");
    }
    const member = input.familyRepository.createMember({
      familyRef: context.family.familyRef,
      displayName: parsed.data.displayName,
      familyRole: parsed.data.familyRole
    });
    return reply.code(201).send({ member });
  });
}
