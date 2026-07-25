import { randomUUID } from "node:crypto";
import type { GatewayDatabase } from "./database.js";

export type AgentAssignmentPreset = "hermes-jarvis-yutu-v1";

export interface AgentTarget {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  providerKind: "fake" | "hermes" | "codex";
  providerDisplayName: string;
}

export interface FamilyAgentDefaults {
  familyManager: AgentTarget;
  ownerAssistant: AgentTarget;
  memberAssistant: AgentTarget;
}

const FAKE_PROVIDER: AgentTarget = {
  agentRef: "agent:personal-assistant",
  displayName: "个人助理",
  providerProfileRef: "provider-profile:fake-local",
  providerKind: "fake",
  providerDisplayName: "Local Fake Provider"
};

export const DEVELOPMENT_AGENT_DEFAULTS: FamilyAgentDefaults = {
  familyManager: {
    agentRef: "agent:family-manager",
    displayName: "家庭管家",
    providerProfileRef: "provider-profile:fake-local",
    providerKind: "fake",
    providerDisplayName: "Local Fake Provider"
  },
  ownerAssistant: FAKE_PROVIDER,
  memberAssistant: FAKE_PROVIDER
};

export const HERMES_JARVIS_YUTU_DEFAULTS: FamilyAgentDefaults = {
  familyManager: {
    agentRef: "agent:jarvis",
    displayName: "Jarvis",
    providerProfileRef: "provider-profile:hermes-jarvis",
    providerKind: "hermes",
    providerDisplayName: "Hermes Jarvis"
  },
  ownerAssistant: {
    agentRef: "agent:yutu",
    displayName: "于途",
    providerProfileRef: "provider-profile:hermes-zzh",
    providerKind: "hermes",
    providerDisplayName: "Hermes zzh"
  },
  memberAssistant: FAKE_PROVIDER
};

export function agentDefaultsForPreset(
  preset: AgentAssignmentPreset | null
): FamilyAgentDefaults {
  return preset === "hermes-jarvis-yutu-v1"
    ? HERMES_JARVIS_YUTU_DEFAULTS
    : DEVELOPMENT_AGENT_DEFAULTS;
}

export function ensureAgentTarget(
  db: GatewayDatabase,
  target: AgentTarget,
  createdAt: string
): void {
  const existingProfile = db.prepare(
    `SELECT provider_kind FROM provider_profiles WHERE provider_profile_ref = ?`
  ).get(target.providerProfileRef) as { provider_kind: string } | undefined;
  if (existingProfile && existingProfile.provider_kind !== target.providerKind) {
    throw new Error(
      `Provider Profile kind conflict for ${target.providerProfileRef}`
    );
  }
  if (!existingProfile) {
    db.prepare(
      `INSERT INTO provider_profiles
       (provider_profile_ref, provider_kind, display_name, created_at)
       VALUES(?, ?, ?, ?)`
    ).run(
      target.providerProfileRef,
      target.providerKind,
      target.providerDisplayName,
      createdAt
    );
  } else {
    db.prepare(
      `UPDATE provider_profiles SET display_name = ? WHERE provider_profile_ref = ?`
    ).run(target.providerDisplayName, target.providerProfileRef);
  }

  db.prepare(
    `INSERT INTO agents(agent_ref, display_name, created_at)
     VALUES(?, ?, ?)
     ON CONFLICT(agent_ref) DO UPDATE SET display_name = excluded.display_name`
  ).run(target.agentRef, target.displayName, createdAt);
}

export interface AgentAssignmentMigrationResult {
  preset: AgentAssignmentPreset;
  familyManagersMigrated: number;
  ownersMigrated: number;
  familyManagersAlreadyCurrent: number;
  ownersAlreadyCurrent: number;
}

interface ActiveAssignmentRow {
  assignment_ref: string;
  agent_ref: string;
  provider_profile_ref: string;
}

export class AgentAssignmentRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  applyPreset(
    preset: AgentAssignmentPreset | null
  ): AgentAssignmentMigrationResult | null {
    if (preset === null) return null;
    const defaults = agentDefaultsForPreset(preset);
    const timestamp = this.now().toISOString();

    return this.db.transaction(() => {
      ensureAgentTarget(this.db, defaults.familyManager, timestamp);
      ensureAgentTarget(this.db, defaults.ownerAssistant, timestamp);
      ensureAgentTarget(this.db, defaults.memberAssistant, timestamp);

      let familyManagersMigrated = 0;
      let ownersMigrated = 0;
      let familyManagersAlreadyCurrent = 0;
      let ownersAlreadyCurrent = 0;

      const families = this.db.prepare(
        `SELECT family_ref FROM families WHERE status = 'active' ORDER BY family_ref`
      ).all() as Array<{ family_ref: string }>;
      for (const family of families) {
        const active = this.db.prepare(
          `SELECT assignment_ref, agent_ref, provider_profile_ref
           FROM family_manager_assignments
           WHERE family_ref = ? AND status = 'active'`
        ).get(family.family_ref) as ActiveAssignmentRow | undefined;
        if (
          active?.agent_ref === defaults.familyManager.agentRef &&
          active.provider_profile_ref === defaults.familyManager.providerProfileRef
        ) {
          familyManagersAlreadyCurrent += 1;
          continue;
        }
        if (active) {
          this.db.prepare(
            `UPDATE family_manager_assignments
             SET status = 'ended', effective_to = ?
             WHERE assignment_ref = ? AND status = 'active'`
          ).run(timestamp, active.assignment_ref);
        }
        this.db.prepare(
          `INSERT INTO family_manager_assignments
           (assignment_ref, family_ref, agent_ref, provider_profile_ref, status,
            effective_from, effective_to)
           VALUES(?, ?, ?, ?, 'active', ?, NULL)`
        ).run(
          `assignment:${randomUUID()}`,
          family.family_ref,
          defaults.familyManager.agentRef,
          defaults.familyManager.providerProfileRef,
          timestamp
        );
        familyManagersMigrated += 1;
      }

      const owners = this.db.prepare(
        `SELECT fm.person_ref
         FROM family_memberships fm
         JOIN families f ON f.family_ref = fm.family_ref AND f.status = 'active'
         JOIN persons p ON p.person_ref = fm.person_ref AND p.status = 'active'
         WHERE fm.family_role = 'owner' AND fm.status = 'active'
         ORDER BY fm.person_ref`
      ).all() as Array<{ person_ref: string }>;
      for (const owner of owners) {
        const active = this.db.prepare(
          `SELECT assignment_ref, agent_ref, provider_profile_ref
           FROM assistant_assignments
           WHERE person_ref = ? AND status = 'active'`
        ).get(owner.person_ref) as ActiveAssignmentRow | undefined;
        if (
          active?.agent_ref === defaults.ownerAssistant.agentRef &&
          active.provider_profile_ref === defaults.ownerAssistant.providerProfileRef
        ) {
          ownersAlreadyCurrent += 1;
          continue;
        }
        if (active) {
          this.db.prepare(
            `UPDATE assistant_assignments
             SET status = 'ended', effective_to = ?
             WHERE assignment_ref = ? AND status = 'active'`
          ).run(timestamp, active.assignment_ref);
        }
        this.db.prepare(
          `INSERT INTO assistant_assignments
           (assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
            effective_from, effective_to)
           VALUES(?, ?, ?, ?, 'active', ?, NULL)`
        ).run(
          `assignment:${randomUUID()}`,
          owner.person_ref,
          defaults.ownerAssistant.agentRef,
          defaults.ownerAssistant.providerProfileRef,
          timestamp
        );
        ownersMigrated += 1;
      }

      return {
        preset,
        familyManagersMigrated,
        ownersMigrated,
        familyManagersAlreadyCurrent,
        ownersAlreadyCurrent
      };
    })();
  }
}
