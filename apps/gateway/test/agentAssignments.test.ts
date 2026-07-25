import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAssignmentRepository,
  HERMES_JARVIS_YUTU_DEFAULTS,
  agentDefaultsForPreset
} from "../src/agentAssignments.js";
import { openGatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const directories: string[] = [];
const timestamp = "2026-07-25T14:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setupFamily() {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-agent-assignments-"));
  directories.push(directory);
  const database = openGatewayDatabase(join(directory, "gateway.sqlite"));
  const familyRepository = new FamilyDomainRepository(database);
  const initialized = familyRepository.initializeFamily({
    familyName: "测试家庭",
    ownerName: "Owner",
    deviceName: "家庭服务器",
    deviceCredential: "assignment-test-device-credential-with-safe-length"
  });
  const adult = familyRepository.createMember({
    familyRef: initialized.family.familyRef,
    displayName: "Adult",
    familyRole: "adult"
  });
  return { database, initialized, adult };
}

function activeManager(database: ReturnType<typeof openGatewayDatabase>, familyRef: string) {
  return database.prepare(
    `SELECT assignment_ref, agent_ref, provider_profile_ref
     FROM family_manager_assignments
     WHERE family_ref = ? AND status = 'active'`
  ).get(familyRef) as {
    assignment_ref: string;
    agent_ref: string;
    provider_profile_ref: string;
  };
}

function activeAssistant(database: ReturnType<typeof openGatewayDatabase>, personRef: string) {
  return database.prepare(
    `SELECT assignment_ref, agent_ref, provider_profile_ref
     FROM assistant_assignments
     WHERE person_ref = ? AND status = 'active'`
  ).get(personRef) as {
    assignment_ref: string;
    agent_ref: string;
    provider_profile_ref: string;
  };
}

describe("AgentAssignmentRepository", () => {
  it("migrates the Family Manager and only the active Owner to Jarvis and Yutu", () => {
    const { database, initialized, adult } = setupFamily();
    try {
      const oldManager = activeManager(database, initialized.family.familyRef);
      const oldOwnerAssistant = activeAssistant(database, initialized.owner.personRef);
      const adultBefore = activeAssistant(database, adult.personRef);
      const repository = new AgentAssignmentRepository(
        database,
        () => new Date(timestamp)
      );

      expect(repository.applyPreset("hermes-jarvis-yutu-v1")).toEqual({
        preset: "hermes-jarvis-yutu-v1",
        familyManagersMigrated: 1,
        ownersMigrated: 1,
        familyManagersAlreadyCurrent: 0,
        ownersAlreadyCurrent: 0
      });

      expect(database.prepare(
        `SELECT provider_profile_ref, provider_kind, display_name
         FROM provider_profiles
         WHERE provider_profile_ref IN (?, ?)
         ORDER BY provider_profile_ref`
      ).all(
        "provider-profile:hermes-jarvis",
        "provider-profile:hermes-zzh"
      )).toEqual([
        {
          provider_profile_ref: "provider-profile:hermes-jarvis",
          provider_kind: "hermes",
          display_name: "Hermes Jarvis"
        },
        {
          provider_profile_ref: "provider-profile:hermes-zzh",
          provider_kind: "hermes",
          display_name: "Hermes zzh"
        }
      ]);
      expect(database.prepare(
        `SELECT agent_ref, display_name FROM agents
         WHERE agent_ref IN (?, ?) ORDER BY agent_ref`
      ).all("agent:jarvis", "agent:yutu")).toEqual([
        { agent_ref: "agent:jarvis", display_name: "Jarvis" },
        { agent_ref: "agent:yutu", display_name: "于途" }
      ]);

      expect(activeManager(database, initialized.family.familyRef)).toMatchObject({
        agent_ref: "agent:jarvis",
        provider_profile_ref: "provider-profile:hermes-jarvis"
      });
      expect(activeAssistant(database, initialized.owner.personRef)).toMatchObject({
        agent_ref: "agent:yutu",
        provider_profile_ref: "provider-profile:hermes-zzh"
      });
      expect(activeAssistant(database, adult.personRef)).toEqual(adultBefore);

      expect(database.prepare(
        `SELECT status, effective_to FROM family_manager_assignments
         WHERE assignment_ref = ?`
      ).get(oldManager.assignment_ref)).toEqual({
        status: "ended",
        effective_to: timestamp
      });
      expect(database.prepare(
        `SELECT status, effective_to FROM assistant_assignments
         WHERE assignment_ref = ?`
      ).get(oldOwnerAssistant.assignment_ref)).toEqual({
        status: "ended",
        effective_to: timestamp
      });
    } finally {
      database.close();
    }
  });

  it("is idempotent and keeps assignment history stable", () => {
    const { database, initialized } = setupFamily();
    try {
      const repository = new AgentAssignmentRepository(
        database,
        () => new Date(timestamp)
      );
      repository.applyPreset("hermes-jarvis-yutu-v1");
      const managerCount = (database.prepare(
        "SELECT COUNT(*) AS count FROM family_manager_assignments"
      ).get() as { count: number }).count;
      const assistantCount = (database.prepare(
        "SELECT COUNT(*) AS count FROM assistant_assignments"
      ).get() as { count: number }).count;

      expect(repository.applyPreset("hermes-jarvis-yutu-v1")).toEqual({
        preset: "hermes-jarvis-yutu-v1",
        familyManagersMigrated: 0,
        ownersMigrated: 0,
        familyManagersAlreadyCurrent: 1,
        ownersAlreadyCurrent: 1
      });
      expect((database.prepare(
        "SELECT COUNT(*) AS count FROM family_manager_assignments"
      ).get() as { count: number }).count).toBe(managerCount);
      expect((database.prepare(
        "SELECT COUNT(*) AS count FROM assistant_assignments"
      ).get() as { count: number }).count).toBe(assistantCount);
      expect(activeAssistant(database, initialized.owner.personRef)).toMatchObject({
        agent_ref: "agent:yutu"
      });
    } finally {
      database.close();
    }
  });

  it("rejects a conflicting Provider kind without partial migration", () => {
    const { database, initialized } = setupFamily();
    try {
      database.prepare(
        `INSERT INTO provider_profiles
         (provider_profile_ref, provider_kind, display_name, created_at)
         VALUES(?, 'codex', ?, ?)`
      ).run("provider-profile:hermes-zzh", "Conflicting Profile", timestamp);
      const oldManager = activeManager(database, initialized.family.familyRef);
      const oldAssistant = activeAssistant(database, initialized.owner.personRef);
      const repository = new AgentAssignmentRepository(database);

      expect(() => repository.applyPreset("hermes-jarvis-yutu-v1"))
        .toThrow("Provider Profile kind conflict");
      expect(activeManager(database, initialized.family.familyRef)).toEqual(oldManager);
      expect(activeAssistant(database, initialized.owner.personRef)).toEqual(oldAssistant);
      expect(database.prepare(
        "SELECT 1 FROM agents WHERE agent_ref = 'agent:jarvis'"
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("exposes fixed defaults and no arbitrary preset surface", () => {
    expect(agentDefaultsForPreset("hermes-jarvis-yutu-v1"))
      .toEqual(HERMES_JARVIS_YUTU_DEFAULTS);
    expect(agentDefaultsForPreset(null).memberAssistant).toMatchObject({
      agentRef: "agent:personal-assistant",
      providerProfileRef: "provider-profile:fake-local"
    });
  });
});
