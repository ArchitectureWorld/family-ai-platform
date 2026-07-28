import type { GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface AdminAgentAssignment {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
}

export interface AdminWorkspaceSummary {
  protocolVersion: 1;
  agents: Array<Pick<AdminAgentAssignment, "agentRef" | "displayName">>;
}

function unavailableAgent(): GatewayDomainError {
  return new GatewayDomainError(
    "ADMIN_AGENT_NOT_FOUND",
    404,
    "permission",
    false,
    "没有找到这个管理系统 Agent。"
  );
}

export function requireAdminAgentAssignment(
  db: GatewayDatabase,
  input: {
    familyRef: string;
    personRef: string;
    agentRef: string;
  }
): AdminAgentAssignment {
  const row = db.prepare(
    `SELECT aaa.agent_ref, a.display_name, aaa.provider_profile_ref
     FROM admin_agent_assignments aaa
     JOIN agents a ON a.agent_ref = aaa.agent_ref
     JOIN agent_runtime_bindings rb
       ON rb.agent_ref = aaa.agent_ref
      AND rb.provider_profile_ref = aaa.provider_profile_ref
      AND rb.status = 'active'
     WHERE aaa.family_ref = ? AND aaa.person_ref = ? AND aaa.agent_ref = ?
       AND aaa.status = 'active'`
  ).get(input.familyRef, input.personRef, input.agentRef) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw unavailableAgent();
  return {
    agentRef: String(row.agent_ref),
    displayName: String(row.display_name),
    providerProfileRef: String(row.provider_profile_ref)
  };
}

export class AdminWorkspaceRepository {
  constructor(private readonly db: GatewayDatabase) {}

  summary(input: {
    familyRef: string;
    personRef: string;
  }): AdminWorkspaceSummary {
    const rows = this.db.prepare(
      `SELECT aaa.agent_ref, a.display_name
       FROM admin_agent_assignments aaa
       JOIN agents a ON a.agent_ref = aaa.agent_ref
       JOIN agent_runtime_bindings rb
         ON rb.agent_ref = aaa.agent_ref
        AND rb.provider_profile_ref = aaa.provider_profile_ref
        AND rb.status = 'active'
       WHERE aaa.family_ref = ? AND aaa.person_ref = ?
         AND aaa.status = 'active'
       ORDER BY aaa.agent_ref`
    ).all(input.familyRef, input.personRef) as Array<Record<string, unknown>>;
    return {
      protocolVersion: 1,
      agents: rows.map((row) => ({
        agentRef: String(row.agent_ref),
        displayName: String(row.display_name)
      }))
    };
  }

  requireAgent(input: {
    familyRef: string;
    personRef: string;
    agentRef: string;
  }): AdminAgentAssignment {
    return requireAdminAgentAssignment(this.db, input);
  }
}
