import { randomUUID } from "node:crypto";
import type { AgentCatalogItem, MountedAgent } from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

export interface ConfiguredAgentRuntime {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  providerKind: "fake" | "hermes" | "codex";
}

type MemberMounts = {
  personRef: string;
  defaultAgentRef: string | null;
  mountedAgents: MountedAgent[];
};

const active = "active";
const idleStatus = { status: "idle" as const, statusLabel: "空闲" as const };
const ended = "ended";

export class AgentManagementRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  reconcileRuntimeCatalog(definitions: readonly ConfiguredAgentRuntime[]): void {
    const seenAgentRefs = new Set<string>();
    for (const definition of definitions) {
      if (seenAgentRefs.has(definition.agentRef)) {
        throw new Error(`duplicate Agent ref: ${definition.agentRef}`);
      }
      seenAgentRefs.add(definition.agentRef);
    }

    const now = this.now().toISOString();
    this.db.transaction(() => {
      const insertProfile = this.db.prepare(
        `INSERT OR IGNORE INTO provider_profiles
         (provider_profile_ref, provider_kind, display_name, created_at)
         VALUES(?, ?, ?, ?)`
      );
      const insertAgent = this.db.prepare(
        "INSERT OR IGNORE INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)"
      );
      const updateAgentName = this.db.prepare(
        "UPDATE agents SET display_name = ? WHERE agent_ref = ?"
      );
      const upsertBinding = this.db.prepare(
        `INSERT INTO agent_runtime_bindings
         (agent_ref, provider_profile_ref, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(agent_ref) DO UPDATE SET
           provider_profile_ref = excluded.provider_profile_ref,
           status = excluded.status,
           updated_at = excluded.updated_at`
      );
      for (const definition of definitions) {
        insertProfile.run(
          definition.providerProfileRef,
          definition.providerKind,
          definition.providerProfileRef,
          now
        );
        insertAgent.run(definition.agentRef, definition.displayName, now);
        updateAgentName.run(definition.displayName, definition.agentRef);
        upsertBinding.run(
          definition.agentRef,
          definition.providerProfileRef,
          active,
          now,
          now
        );
      }
    })();
  }

  listCatalog(): AgentCatalogItem[] {
    const checkedAt = this.now().toISOString();
    const rows = this.db.prepare(
      `SELECT a.agent_ref, a.display_name
       FROM agents a
       JOIN agent_runtime_bindings rb ON rb.agent_ref = a.agent_ref
       WHERE rb.status = ?
       ORDER BY a.agent_ref`
    ).all(active) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      agentRef: String(row.agent_ref),
      displayName: String(row.display_name),
      ...idleStatus,
      activeTurnCount: 0,
      lastCheckedAt: checkedAt,
      publicProblem: null
    }));
  }

  listMemberMounts(familyRef: string, personRef: string): MemberMounts {
    this.requireActiveMember(familyRef, personRef);
    const rows = this.db.prepare(
      `SELECT aa.assignment_ref, aa.agent_ref, a.display_name, aa.provider_profile_ref, aa.is_default
       FROM assistant_assignments aa
       JOIN agents a ON a.agent_ref = aa.agent_ref
       JOIN agent_runtime_bindings rb
         ON rb.agent_ref = aa.agent_ref
        AND rb.provider_profile_ref = aa.provider_profile_ref
        AND rb.status = ?
       WHERE aa.person_ref = ? AND aa.status = ?
       ORDER BY aa.effective_from, aa.assignment_ref`
    ).all(active, personRef, active) as Array<Record<string, unknown>>;
    const mountedAgents = rows.map((row) => ({
      assignmentRef: String(row.assignment_ref),
      agentRef: String(row.agent_ref),
      displayName: String(row.display_name),
      providerProfileRef: String(row.provider_profile_ref),
      isDefault: Number(row.is_default) === 1,
      ...idleStatus
    }));
    const defaults = mountedAgents.filter((mount) => mount.isDefault);
    return {
      personRef,
      defaultAgentRef: defaults.length === 1 ? defaults[0]!.agentRef : null,
      mountedAgents
    };
  }

  mountMemberAgent(input: { familyRef: string; personRef: string; agentRef: string }): MountedAgent {
    return this.db.transaction(() => {
      this.requireActiveMember(input.familyRef, input.personRef);
      const runtime = this.runtimeForAgent(input.agentRef);
      const existing = this.db.prepare(
        `SELECT aa.assignment_ref, aa.agent_ref, a.display_name, aa.provider_profile_ref, aa.is_default
         FROM assistant_assignments aa
         JOIN agents a ON a.agent_ref = aa.agent_ref
         WHERE aa.person_ref = ? AND aa.agent_ref = ? AND aa.status = ?`
      ).get(input.personRef, input.agentRef, active) as Record<string, unknown> | undefined;
      if (existing) return this.mapMount(existing);

      const assignmentRef = `assignment:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO assistant_assignments
         (assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
          effective_from, effective_to, is_default)
         VALUES(?, ?, ?, ?, ?, ?, NULL, 0)`
      ).run(
        assignmentRef,
        input.personRef,
        input.agentRef,
        runtime.providerProfileRef,
        active,
        this.now().toISOString()
      );
      return {
        assignmentRef,
        agentRef: input.agentRef,
        displayName: runtime.displayName,
        providerProfileRef: runtime.providerProfileRef,
        isDefault: false,
        ...idleStatus
      };
    })();
  }

  unmountMemberAgent(input: { familyRef: string; personRef: string; agentRef: string }): void {
    this.db.transaction(() => {
      this.requireActiveMember(input.familyRef, input.personRef);
      this.db.prepare(
        `UPDATE assistant_assignments
         SET status = ?, effective_to = ?, is_default = 0
         WHERE person_ref = ? AND agent_ref = ? AND status = ?`
      ).run(ended, this.now().toISOString(), input.personRef, input.agentRef, active);
    })();
  }

  setDefaultAgent(input: { familyRef: string; personRef: string; agentRef: string | null }): void {
    this.db.transaction(() => {
      this.requireActiveMember(input.familyRef, input.personRef);
      if (input.agentRef !== null) {
        const mounted = this.db.prepare(
          `SELECT 1 FROM assistant_assignments
           WHERE person_ref = ? AND agent_ref = ? AND status = ?`
        ).get(input.personRef, input.agentRef, active);
        if (!mounted) throw this.agentNotMounted();
      }
      this.db.prepare(
        "UPDATE assistant_assignments SET is_default = 0 WHERE person_ref = ? AND status = ?"
      ).run(input.personRef, active);
      if (input.agentRef !== null) {
        this.db.prepare(
          `UPDATE assistant_assignments SET is_default = 1
           WHERE person_ref = ? AND agent_ref = ? AND status = ?`
        ).run(input.personRef, input.agentRef, active);
      }
    })();
  }

  ensureOwnerAdminAssignments(input: {
    familyRef: string;
    personRef: string;
    agentRefs: readonly ["agent:hermes-jarvis", "agent:codex-cli"];
  }): void {
    this.db.transaction(() => {
      const owner = this.db.prepare(
        `SELECT 1 FROM family_memberships fm
         JOIN persons p ON p.person_ref = fm.person_ref
         WHERE fm.family_ref = ? AND fm.person_ref = ? AND fm.family_role = ?
           AND fm.status = ? AND p.status = ?`
      ).get(input.familyRef, input.personRef, "owner", active, active);
      if (!owner) throw this.memberNotFound();
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO admin_agent_assignments
         (assignment_ref, family_ref, person_ref, agent_ref, provider_profile_ref,
          status, effective_from, effective_to)
         VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`
      );
      for (const agentRef of input.agentRefs) {
        const runtime = this.runtimeForAgent(agentRef);
        insert.run(
          `assignment:${randomUUID()}`,
          input.familyRef,
          input.personRef,
          agentRef,
          runtime.providerProfileRef,
          active,
          this.now().toISOString()
        );
      }
    })();
  }

  private requireActiveMember(familyRef: string, personRef: string): void {
    const member = this.db.prepare(
      `SELECT 1 FROM family_memberships fm
       JOIN persons p ON p.person_ref = fm.person_ref
       WHERE fm.family_ref = ? AND fm.person_ref = ? AND fm.status = ? AND p.status = ?`
    ).get(familyRef, personRef, active, active);
    if (!member) throw this.memberNotFound();
  }

  private runtimeForAgent(agentRef: string): { providerProfileRef: string; displayName: string } {
    const runtime = this.db.prepare(
      `SELECT rb.provider_profile_ref, a.display_name
       FROM agent_runtime_bindings rb
       JOIN agents a ON a.agent_ref = rb.agent_ref
       WHERE rb.agent_ref = ? AND rb.status = ?`
    ).get(agentRef, active) as Record<string, unknown> | undefined;
    if (!runtime) {
      throw new GatewayDomainError(
        "AGENT_RUNTIME_UNAVAILABLE", 409, "conflict", false, "Agent 尚未配置。"
      );
    }
    return { providerProfileRef: String(runtime.provider_profile_ref), displayName: String(runtime.display_name) };
  }

  private mapMount(row: Record<string, unknown>): MountedAgent {
    return {
      assignmentRef: String(row.assignment_ref),
      agentRef: String(row.agent_ref),
      displayName: String(row.display_name),
      providerProfileRef: String(row.provider_profile_ref),
      isDefault: Number(row.is_default) === 1,
      ...idleStatus
    };
  }

  private memberNotFound(): GatewayDomainError {
    return new GatewayDomainError("PERSON_NOT_IN_FAMILY", 404, "permission", false, "没有找到这个家庭成员。");
  }

  private agentNotMounted(): GatewayDomainError {
    return new GatewayDomainError("AGENT_NOT_MOUNTED", 409, "conflict", false, "该 Agent 尚未挂载。");
  }
}
