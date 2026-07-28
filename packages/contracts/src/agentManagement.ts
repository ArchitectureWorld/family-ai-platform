import { z } from "zod";
import { CHAT_WORK_PROTOCOL_VERSION } from "./chatWork.js";

const protocolVersionSchema = z.literal(CHAT_WORK_PROTOCOL_VERSION);
const timestampSchema = z.string().datetime({ offset: true });
const displayNameSchema = z.string().trim().min(1).max(80);

function refSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`));
}

const personRefSchema = refSchema("person");
const assignmentRefSchema = refSchema("assignment");
export const agentRefSchema = refSchema("agent");
export const providerProfileRefSchema = refSchema("provider-profile");

export const agentRuntimeStatusSchema = z.enum(["idle", "working", "problem"]);

const agentStatusLabelSchema = z.enum(["空闲", "工作中", "有问题"]);

export const agentCatalogItemSchema = z
  .object({
    agentRef: agentRefSchema,
    displayName: displayNameSchema,
    status: agentRuntimeStatusSchema,
    statusLabel: agentStatusLabelSchema,
    activeTurnCount: z.number().int().nonnegative(),
    lastCheckedAt: timestampSchema,
    publicProblem: z.string().trim().min(1).max(500).nullable()
  })
  .strict();

export const mountedAgentSchema = z
  .object({
    assignmentRef: assignmentRefSchema,
    agentRef: agentRefSchema,
    displayName: displayNameSchema,
    providerProfileRef: providerProfileRefSchema,
    isDefault: z.boolean(),
    status: agentRuntimeStatusSchema,
    statusLabel: agentStatusLabelSchema
  })
  .strict();

export const adminAgentCatalogResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    agents: z.array(agentCatalogItemSchema).max(500)
  })
  .strict();

const memberAgentMountsResponseBaseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    personRef: personRefSchema,
    defaultAgentRef: agentRefSchema.nullable(),
    mountedAgents: z.array(mountedAgentSchema).max(100)
  })
  .strict();

function validateDefaultMountedAgent(
  value: z.infer<typeof memberAgentMountsResponseBaseSchema>,
  context: z.RefinementCtx
) {
  if (value.defaultAgentRef === null) {
    return;
  }

  const defaults = value.mountedAgents.filter((agent) => agent.agentRef === value.defaultAgentRef);
  if (defaults.length !== 1 || !defaults[0]?.isDefault) {
    context.addIssue({
      code: "custom",
      path: ["defaultAgentRef"],
      message: "defaultAgentRef must identify exactly one mounted default Agent"
    });
  }
}

export const memberAgentMountsResponseSchema = memberAgentMountsResponseBaseSchema.superRefine(
  validateDefaultMountedAgent
);

export const mountMemberAgentRequestSchema = z
  .object({
    agentRef: agentRefSchema
  })
  .strict();

export const setDefaultAgentRequestSchema = z
  .object({
    agentRef: agentRefSchema.nullable()
  })
  .strict();

export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
export type AgentCatalogItem = z.infer<typeof agentCatalogItemSchema>;
export type MountedAgent = z.infer<typeof mountedAgentSchema>;
export type AdminAgentCatalogResponse = z.infer<typeof adminAgentCatalogResponseSchema>;
export type MemberAgentMountsResponse = z.infer<typeof memberAgentMountsResponseSchema>;
export type MountMemberAgentRequest = z.infer<typeof mountMemberAgentRequestSchema>;
export type SetDefaultAgentRequest = z.infer<typeof setDefaultAgentRequestSchema>;
