import {
  agentInvocationRequestV1Schema,
  agentInvocationResultV1Schema
} from "@family-ai/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  EntrySessionAuthenticator,
  type EntrySessionAuthentication
} from "./entrySessionAuth.js";
import { FederationService } from "./federationService.js";
import { GatewayDomainError } from "./service.js";
import { useFederationEntryCookies } from "./webEntryCookies.js";

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function entryError(result: EntrySessionAuthentication): GatewayDomainError {
  if (result.status === "expired") {
    return new GatewayDomainError(
      "ENTRY_SESSION_EXPIRED",
      401,
      "permission",
      false,
      "入口会话已经过期。"
    );
  }
  if (result.status === "device_revoked") {
    return new GatewayDomainError(
      "DEVICE_REVOKED",
      403,
      "permission",
      false,
      "设备授权已经撤销。"
    );
  }
  return new GatewayDomainError(
    "ENTRY_SESSION_INVALID",
    401,
    "permission",
    false,
    "入口会话无效。"
  );
}

export function registerFederationRoutes(
  app: FastifyInstance,
  input: {
    service: FederationService;
    entryAuthenticator: EntrySessionAuthenticator;
  }
): void {
  const authenticateService = (request: FastifyRequest) => {
    const token = bearerToken(request);
    if (!token) {
      throw new GatewayDomainError(
        "FEDERATION_SERVICE_UNAUTHORIZED",
        401,
        "permission",
        false,
        "产品服务身份无效。"
      );
    }
    return input.service.authenticateService(token);
  };

  const issueBrowserActor = (request: FastifyRequest) => {
    const service = authenticateService(request);
    const credentials = useFederationEntryCookies(request);
    if (!credentials) throw entryError({ status: "invalid" });
    const authentication = input.entryAuthenticator.authenticate(
      credentials.entrySessionRef,
      credentials.entryToken
    );
    if (authentication.status !== "authenticated") {
      throw entryError(authentication);
    }
    return input.service.issueActorContext(
      service,
      credentials.entrySessionRef
    );
  };

  app.get("/api/v1/federation/session", async (request, reply) => {
    const actor = issueBrowserActor(request);
    reply.headers({
      "X-Family-AI-Context-Ref": actor.contextRef,
      "X-Family-AI-Family-Ref": actor.familyRef,
      "X-Family-AI-Person-Ref": actor.personRef,
      "X-Family-AI-Device-Ref": actor.deviceRef,
      "X-Family-AI-Roles": actor.roles.join(","),
      "X-Family-AI-Assignment-Version": String(actor.assignmentVersion),
      "X-Family-AI-Context-Expires-At": actor.expiresAt
    });
    return reply.code(204).send();
  });

  app.get("/api/v1/federation/agents", async (request) => {
    const actor = issueBrowserActor(request);
    return {
      protocolVersion: 1,
      agents: await input.service.listAgents(actor)
    };
  });

  app.post("/api/v1/federation/invocations", async (request) => {
    const service = authenticateService(request);
    const parsed = agentInvocationRequestV1Schema.safeParse(request.body);
    if (!parsed.success || parsed.data.product === "family") {
      throw new GatewayDomainError(
        "FEDERATION_REQUEST_INVALID",
        400,
        "validation",
        false,
        "Agent 请求格式不正确。"
      );
    }
    const { externalSessionRef, ...requiredRequest } = parsed.data;
    return agentInvocationResultV1Schema.parse(
      await input.service.invoke(
        service,
        externalSessionRef === undefined
          ? requiredRequest
          : { ...requiredRequest, externalSessionRef }
      )
    );
  });
}
