import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { GatewayDatabase } from "./database.js";
import { sha256 } from "./database.js";
import { GatewayDomainError } from "./service.js";

export type FamilyRole = "owner" | "adult" | "child" | "elder";
export type EntryAudience = "family_admin" | "personal";

const FAMILY_MANAGER_AGENT_REF = "agent:family-manager";
const PERSONAL_ASSISTANT_AGENT_REF = "agent:personal-assistant";
const DEVELOPMENT_PROVIDER_PROFILE_REF = "provider-profile:fake-local";
const ENTRY_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface EntryCredential {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: EntryAudience;
  agentRef: string;
}

export interface OnboardingResult {
  family: {
    familyRef: string;
    displayName: string;
    status: "active";
  };
  owner: {
    personRef: string;
    displayName: string;
    status: "active";
  };
  device: {
    deviceRef: string;
    displayName: string;
    status: "active";
  };
  entries: {
    admin: EntryCredential;
    personal: EntryCredential;
  };
}

export interface EntryContext {
  audience: EntryAudience;
  entrySessionRef: string;
  entryBindingRef: string;
  family: {
    familyRef: string;
    displayName: string;
  };
  person: {
    personRef: string;
    displayName: string;
  };
  membership: {
    familyRole: FamilyRole;
  };
  device: {
    deviceRef: string;
    displayName: string;
    terminalType: string;
    platform: string;
  };
  agent: {
    assignmentRef: string;
    assignmentType: "family_manager" | "personal_assistant";
    agentRef: string;
    displayName: string;
    providerProfileRef: string;
  };
}

export interface FamilyMember {
  personRef: string;
  displayName: string;
  familyRole: FamilyRole;
  status: "active";
  personalAssistant: {
    assignmentRef: string;
    agentRef: string;
    displayName: string;
    providerProfileRef: string;
  };
  entryStatus: "claimed" | "unclaimed";
  joinedAt: string;
}

function secureHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function createSessionMaterial(audience: EntryAudience, agentRef: string) {
  return {
    entryBindingRef: `entry-binding:${randomUUID()}`,
    entrySessionRef: `entry-session:${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    audience,
    agentRef
  } satisfies EntryCredential;
}

function mapMember(row: Record<string, unknown>): FamilyMember {
  return {
    personRef: String(row.person_ref),
    displayName: String(row.display_name),
    familyRole: row.family_role as FamilyRole,
    status: "active",
    personalAssistant: {
      assignmentRef: String(row.assignment_ref),
      agentRef: String(row.agent_ref),
      displayName: String(row.agent_display_name),
      providerProfileRef: String(row.provider_profile_ref)
    },
    entryStatus: Number(row.has_personal_entry) === 1 ? "claimed" : "unclaimed",
    joinedAt: String(row.joined_at)
  };
}

export class FamilyDomainRepository {
  constructor(private readonly db: GatewayDatabase) {}

  isInitialized(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM families").get() as {
      count: number;
    };
    return row.count > 0;
  }

  initializeFamily(input: {
    familyName: string;
    ownerName: string;
    deviceName: string;
    deviceCredential: string;
  }): OnboardingResult {
    if (this.isInitialized()) {
      throw new GatewayDomainError(
        "ONBOARDING_ALREADY_COMPLETED",
        409,
        "conflict",
        false,
        "家庭已经完成初始化。"
      );
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ENTRY_SESSION_LIFETIME_MS).toISOString();
    const familyRef = `family:${randomUUID()}`;
    const personRef = `person:${randomUUID()}`;
    const deviceRef = `device:${randomUUID()}`;
    const deviceBindingRef = `device-binding:${randomUUID()}`;
    const familyManagerAssignmentRef = `assignment:${randomUUID()}`;
    const personalAssistantAssignmentRef = `assignment:${randomUUID()}`;
    const admin = createSessionMaterial("family_admin", FAMILY_MANAGER_AGENT_REF);
    const personal = createSessionMaterial("personal", PERSONAL_ASSISTANT_AGENT_REF);

    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM families LIMIT 1").get();
      if (existing) {
        throw new GatewayDomainError(
          "ONBOARDING_ALREADY_COMPLETED",
          409,
          "conflict",
          false,
          "家庭已经完成初始化。"
        );
      }

      this.db.prepare(
        `INSERT OR IGNORE INTO provider_profiles
         (provider_profile_ref, provider_kind, display_name, created_at)
         VALUES(?, 'fake', 'Local Fake Provider', ?)`
      ).run(DEVELOPMENT_PROVIDER_PROFILE_REF, now);
      this.db.prepare(
        "INSERT OR IGNORE INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)"
      ).run(FAMILY_MANAGER_AGENT_REF, "家庭管家", now);
      this.db.prepare(
        "INSERT OR IGNORE INTO agents(agent_ref, display_name, created_at) VALUES(?, ?, ?)"
      ).run(PERSONAL_ASSISTANT_AGENT_REF, "个人助理", now);

      this.db.prepare(
        `INSERT INTO families(family_ref, display_name, status, created_at, updated_at)
         VALUES(?, ?, 'active', ?, ?)`
      ).run(familyRef, input.familyName, now, now);
      this.db.prepare(
        `INSERT INTO persons(person_ref, display_name, status, created_at, updated_at)
         VALUES(?, ?, 'active', ?, ?)`
      ).run(personRef, input.ownerName, now, now);
      this.db.prepare(
        `INSERT INTO family_memberships
         (family_ref, person_ref, family_role, status, joined_at, updated_at)
         VALUES(?, ?, 'owner', 'active', ?, ?)`
      ).run(familyRef, personRef, now, now);
      this.db.prepare(
        `INSERT INTO managed_devices
         (device_ref, display_name, terminal_type, platform, status, credential_hash,
          created_at, updated_at, revoked_at)
         VALUES(?, ?, 'computer', 'development-browser', 'active', ?, ?, ?, NULL)`
      ).run(deviceRef, input.deviceName, sha256(input.deviceCredential), now, now);
      this.db.prepare(
        `INSERT INTO device_bindings
         (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
          status, bound_at, revoked_at)
         VALUES(?, ?, 'person', ?, ?, 'active', ?, NULL)`
      ).run(deviceBindingRef, deviceRef, familyRef, personRef, now);
      this.db.prepare(
        `INSERT INTO family_manager_assignments
         (assignment_ref, family_ref, agent_ref, provider_profile_ref, status,
          effective_from, effective_to)
         VALUES(?, ?, ?, ?, 'active', ?, NULL)`
      ).run(
        familyManagerAssignmentRef,
        familyRef,
        FAMILY_MANAGER_AGENT_REF,
        DEVELOPMENT_PROVIDER_PROFILE_REF,
        now
      );
      this.db.prepare(
        `INSERT INTO assistant_assignments
         (assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
          effective_from, effective_to)
         VALUES(?, ?, ?, ?, 'active', ?, NULL)`
      ).run(
        personalAssistantAssignmentRef,
        personRef,
        PERSONAL_ASSISTANT_AGENT_REF,
        DEVELOPMENT_PROVIDER_PROFILE_REF,
        now
      );

      const insertBinding = this.db.prepare(
        `INSERT INTO entry_bindings
         (entry_binding_ref, device_ref, family_ref, person_ref, audience, status,
          bound_at, last_used_at)
         VALUES(?, ?, ?, ?, ?, 'active', ?, NULL)`
      );
      const insertSession = this.db.prepare(
        `INSERT INTO entry_sessions
         (entry_session_ref, entry_binding_ref, token_hash, status,
          created_at, expires_at, revoked_at)
         VALUES(?, ?, ?, 'active', ?, ?, NULL)`
      );
      for (const entry of [admin, personal]) {
        insertBinding.run(
          entry.entryBindingRef,
          deviceRef,
          familyRef,
          personRef,
          entry.audience,
          now
        );
        insertSession.run(
          entry.entrySessionRef,
          entry.entryBindingRef,
          sha256(entry.token),
          now,
          expiresAt
        );
      }
    })();

    return {
      family: { familyRef, displayName: input.familyName, status: "active" },
      owner: { personRef, displayName: input.ownerName, status: "active" },
      device: { deviceRef, displayName: input.deviceName, status: "active" },
      entries: { admin, personal }
    };
  }

  authenticateEntrySession(entrySessionRef: string, token: string): EntryContext | null {
    const now = new Date().toISOString();
    const row = this.db.prepare(
      `SELECT es.entry_session_ref, es.token_hash,
              eb.entry_binding_ref, eb.audience,
              f.family_ref, f.display_name AS family_display_name,
              p.person_ref, p.display_name AS person_display_name,
              fm.family_role,
              d.device_ref, d.display_name AS device_display_name,
              d.terminal_type, d.platform,
              COALESCE(fma.assignment_ref, aa.assignment_ref) AS assignment_ref,
              COALESCE(fma.agent_ref, aa.agent_ref) AS agent_ref,
              COALESCE(fma.provider_profile_ref, aa.provider_profile_ref) AS provider_profile_ref,
              a.display_name AS agent_display_name
       FROM entry_sessions es
       JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
       JOIN families f ON f.family_ref = eb.family_ref AND f.status = 'active'
       JOIN persons p ON p.person_ref = eb.person_ref AND p.status = 'active'
       JOIN family_memberships fm
         ON fm.family_ref = f.family_ref AND fm.person_ref = p.person_ref AND fm.status = 'active'
       JOIN managed_devices d ON d.device_ref = eb.device_ref AND d.status = 'active'
       JOIN device_bindings db
         ON db.device_ref = d.device_ref
        AND db.family_ref = f.family_ref
        AND db.person_ref = p.person_ref
        AND db.owner_scope = 'person'
        AND db.status = 'active'
       LEFT JOIN family_manager_assignments fma
         ON eb.audience = 'family_admin'
        AND fma.family_ref = f.family_ref
        AND fma.status = 'active'
       LEFT JOIN assistant_assignments aa
         ON eb.audience = 'personal'
        AND aa.person_ref = p.person_ref
        AND aa.status = 'active'
       JOIN agents a ON a.agent_ref = COALESCE(fma.agent_ref, aa.agent_ref)
       WHERE es.entry_session_ref = ?
         AND es.status = 'active'
         AND es.expires_at > ?
         AND eb.status = 'active'`
    ).get(entrySessionRef, now) as Record<string, unknown> | undefined;

    if (!row || typeof row.token_hash !== "string") return null;
    if (!secureHashEqual(sha256(token), row.token_hash)) return null;

    this.db.prepare(
      "UPDATE entry_bindings SET last_used_at = ? WHERE entry_binding_ref = ?"
    ).run(now, String(row.entry_binding_ref));

    const audience = row.audience as EntryAudience;
    return {
      audience,
      entrySessionRef: String(row.entry_session_ref),
      entryBindingRef: String(row.entry_binding_ref),
      family: {
        familyRef: String(row.family_ref),
        displayName: String(row.family_display_name)
      },
      person: {
        personRef: String(row.person_ref),
        displayName: String(row.person_display_name)
      },
      membership: {
        familyRole: row.family_role as FamilyRole
      },
      device: {
        deviceRef: String(row.device_ref),
        displayName: String(row.device_display_name),
        terminalType: String(row.terminal_type),
        platform: String(row.platform)
      },
      agent: {
        assignmentRef: String(row.assignment_ref),
        assignmentType: audience === "family_admin" ? "family_manager" : "personal_assistant",
        agentRef: String(row.agent_ref),
        displayName: String(row.agent_display_name),
        providerProfileRef: String(row.provider_profile_ref)
      }
    };
  }

  listMembers(familyRef: string): FamilyMember[] {
    const rows = this.db.prepare(
      `SELECT p.person_ref, p.display_name, fm.family_role, fm.joined_at,
              aa.assignment_ref, aa.agent_ref, aa.provider_profile_ref,
              a.display_name AS agent_display_name,
              CASE WHEN EXISTS (
                SELECT 1 FROM entry_bindings eb
                WHERE eb.family_ref = fm.family_ref
                  AND eb.person_ref = fm.person_ref
                  AND eb.audience = 'personal'
                  AND eb.status = 'active'
              ) THEN 1 ELSE 0 END AS has_personal_entry
       FROM family_memberships fm
       JOIN persons p ON p.person_ref = fm.person_ref AND p.status = 'active'
       JOIN assistant_assignments aa ON aa.person_ref = p.person_ref AND aa.status = 'active'
       JOIN agents a ON a.agent_ref = aa.agent_ref
       WHERE fm.family_ref = ? AND fm.status = 'active'
       ORDER BY CASE fm.family_role WHEN 'owner' THEN 0 ELSE 1 END,
                fm.joined_at, p.person_ref`
    ).all(familyRef) as Array<Record<string, unknown>>;
    return rows.map(mapMember);
  }

  createMember(input: {
    familyRef: string;
    displayName: string;
    familyRole: Exclude<FamilyRole, "owner">;
  }): FamilyMember {
    const now = new Date().toISOString();
    const personRef = `person:${randomUUID()}`;
    const assignmentRef = `assignment:${randomUUID()}`;

    this.db.transaction(() => {
      const family = this.db.prepare(
        "SELECT 1 FROM families WHERE family_ref = ? AND status = 'active'"
      ).get(input.familyRef);
      if (!family) {
        throw new GatewayDomainError(
          "FAMILY_NOT_FOUND",
          404,
          "permission",
          false,
          "没有找到这个家庭。"
        );
      }
      this.db.prepare(
        `INSERT INTO persons(person_ref, display_name, status, created_at, updated_at)
         VALUES(?, ?, 'active', ?, ?)`
      ).run(personRef, input.displayName, now, now);
      this.db.prepare(
        `INSERT INTO family_memberships
         (family_ref, person_ref, family_role, status, joined_at, updated_at)
         VALUES(?, ?, ?, 'active', ?, ?)`
      ).run(input.familyRef, personRef, input.familyRole, now, now);
      this.db.prepare(
        `INSERT INTO assistant_assignments
         (assignment_ref, person_ref, agent_ref, provider_profile_ref, status,
          effective_from, effective_to)
         VALUES(?, ?, ?, ?, 'active', ?, NULL)`
      ).run(
        assignmentRef,
        personRef,
        PERSONAL_ASSISTANT_AGENT_REF,
        DEVELOPMENT_PROVIDER_PROFILE_REF,
        now
      );
    })();

    const member = this.listMembers(input.familyRef).find((item) => item.personRef === personRef);
    if (!member) {
      throw new Error("Family member was not readable after creation");
    }
    return member;
  }
}
