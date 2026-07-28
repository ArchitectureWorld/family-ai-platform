import type { FastifyInstance } from "fastify";
import {
  adminAgentCatalogResponseSchema,
  agentRefSchema,
  memberAgentMountsResponseSchema,
  mountMemberAgentRequestSchema,
  personRefSchema,
  setDefaultAgentRequestSchema
} from "@family-ai/contracts";
import { z } from "zod";
import { AgentManagementRepository } from "./agentManagement.js";
import {
  EntrySessionAuthenticator,
  requireEntryRequest
} from "./entrySessionAuth.js";
import { GatewayDomainError } from "./service.js";

export interface AgentStatusLookup {
  snapshot(agentRef: string): Promise<{
    status: "idle" | "working" | "problem";
    statusLabel: "空闲" | "工作中" | "有问题";
    activeTurnCount: number;
    lastCheckedAt: string;
    publicProblem: string | null;
  }>;
}

const memberParamsSchema = z.object({ personRef: personRefSchema }).strict();
const mountParamsSchema = memberParamsSchema.extend({ agentRef: agentRefSchema }).strict();

function invalidRequest(): GatewayDomainError {
  return new GatewayDomainError("REQUEST_INVALID", 400, "validation", false, "Agent 请求格式不正确。");
}

export function registerAgentRoutes(
  app: FastifyInstance,
  input: {
    repository: AgentManagementRepository;
    entryAuthenticator: EntrySessionAuthenticator;
    agentStatus: AgentStatusLookup;
  }
): void {
  const mountResponse = async (familyRef: string, personRef: string) => {
    const mounts = input.repository.listMemberMounts(familyRef, personRef);
    return memberAgentMountsResponseSchema.parse({
      protocolVersion: 1,
      ...mounts,
      mountedAgents: await Promise.all(mounts.mountedAgents.map(async (mount) => {
        const status = await input.agentStatus.snapshot(mount.agentRef);
        return { ...mount, status: status.status, statusLabel: status.statusLabel };
      }))
    });
  };

  app.get("/api/v1/admin/agents", async (request) => {
    requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    return adminAgentCatalogResponseSchema.parse({
      protocolVersion: 1,
      agents: await Promise.all(input.repository.listCatalog().map(async (agent) => ({
        ...agent,
        ...await input.agentStatus.snapshot(agent.agentRef)
      })))
    });
  });

  app.get("/api/v1/admin/members/:personRef/agent-mounts", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const parsed = memberParamsSchema.safeParse(request.params);
    if (!parsed.success) throw invalidRequest();
    return mountResponse(context.family.familyRef, parsed.data.personRef);
  });

  app.post("/api/v1/admin/members/:personRef/agent-mounts", async (request, reply) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const params = memberParamsSchema.safeParse(request.params);
    const body = mountMemberAgentRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw invalidRequest();
    input.repository.mountMemberAgent({
      familyRef: context.family.familyRef,
      personRef: params.data.personRef,
      agentRef: body.data.agentRef
    });
    return reply.code(201).send(
      await mountResponse(context.family.familyRef, params.data.personRef)
    );
  });

  app.delete("/api/v1/admin/members/:personRef/agent-mounts/:agentRef", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const parsed = mountParamsSchema.safeParse(request.params);
    if (!parsed.success) throw invalidRequest();
    input.repository.unmountMemberAgent({
      familyRef: context.family.familyRef,
      personRef: parsed.data.personRef,
      agentRef: parsed.data.agentRef
    });
    return mountResponse(context.family.familyRef, parsed.data.personRef);
  });

  app.put("/api/v1/admin/members/:personRef/default-agent", async (request) => {
    const context = requireEntryRequest(request, input.entryAuthenticator, "family_admin");
    const params = memberParamsSchema.safeParse(request.params);
    const body = setDefaultAgentRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw invalidRequest();
    input.repository.setDefaultAgent({
      familyRef: context.family.familyRef,
      personRef: params.data.personRef,
      agentRef: body.data.agentRef
    });
    return mountResponse(context.family.familyRef, params.data.personRef);
  });
}
