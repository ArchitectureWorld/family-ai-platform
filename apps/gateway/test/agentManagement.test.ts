import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentManagementRepository,
  type ConfiguredAgentRuntime
} from "../src/agentManagement.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";

const configuredAgents: readonly ConfiguredAgentRuntime[] = [
  { agentRef: "agent:shared", displayName: "共享助理", providerProfileRef: "provider-profile:shared", providerKind: "fake" },
  { agentRef: "agent:hermes-jarvis", displayName: "Hermes Jarvis", providerProfileRef: "provider-profile:hermes-jarvis", providerKind: "hermes" },
  { agentRef: "agent:codex-cli", displayName: "Codex CLI", providerProfileRef: "provider-profile:codex-cli", providerKind: "codex" }
];

describe("Agent management repository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let repository: AgentManagementRepository;
  let familyRef = "";
  let alice = "";
  let bob = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-agent-management-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({ familyName: "测试家庭", ownerName: "Alice", deviceName: "测试设备", deviceCredential: "agent-management-device-credential" });
    familyRef = onboarding.family.familyRef;
    alice = onboarding.owner.personRef;
    bob = family.createMember({ familyRef, displayName: "Bob", familyRole: "adult" }).personRef;
    repository = new AgentManagementRepository(db, () => new Date("2026-07-28T10:00:00.000Z"));
    repository.reconcileRuntimeCatalog(configuredAgents);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reconciles the configured catalog without exposing non-allowlisted problems", () => {
    expect(repository.listCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentRef: "agent:codex-cli", displayName: "Codex CLI", status: "idle", statusLabel: "空闲", activeTurnCount: 0, lastCheckedAt: "2026-07-28T10:00:00.000Z", publicProblem: null }),
      expect.objectContaining({ agentRef: "agent:hermes-jarvis" }),
      expect.objectContaining({ agentRef: "agent:shared" })
    ]));
    expect(() => repository.reconcileRuntimeCatalog([
      configuredAgents[0]!,
      { ...configuredAgents[0]!, providerProfileRef: "provider-profile:other" }
    ])).toThrow(/duplicate Agent ref/i);
  });

  it("mounts one Agent for two members but not twice for one member", () => {
    const first = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    const replay = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    const secondMember = repository.mountMemberAgent({ familyRef, personRef: bob, agentRef: "agent:shared" });
    expect(replay.assignmentRef).toBe(first.assignmentRef);
    expect(secondMember.assignmentRef).not.toBe(first.assignmentRef);
  });

  it("allows clearing the default and preserves ended history", () => {
    repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    repository.setDefaultAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    repository.unmountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    expect(repository.listMemberMounts(familyRef, alice).defaultAgentRef).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM assistant_assignments WHERE person_ref = ? AND agent_ref = ? AND status = ?`).get(alice, "agent:shared", "ended")).toEqual({ count: 1 });
  });

  it("creates missing owner Admin assignments without overwriting them", () => {
    repository.ensureOwnerAdminAssignments({ familyRef, personRef: alice, agentRefs: ["agent:hermes-jarvis", "agent:codex-cli"] });
    const first = db.prepare(`SELECT assignment_ref, agent_ref, provider_profile_ref, status FROM admin_agent_assignments WHERE family_ref = ? AND person_ref = ? ORDER BY agent_ref`).all(familyRef, alice);
    repository.ensureOwnerAdminAssignments({ familyRef, personRef: alice, agentRefs: ["agent:hermes-jarvis", "agent:codex-cli"] });
    expect(db.prepare(`SELECT assignment_ref, agent_ref, provider_profile_ref, status FROM admin_agent_assignments WHERE family_ref = ? AND person_ref = ? ORDER BY agent_ref`).all(familyRef, alice)).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it("rejects a runtime remap without hiding an existing mount", () => {
    const mount = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    const beforeBinding = db.prepare("SELECT agent_ref, provider_profile_ref, status FROM agent_runtime_bindings WHERE agent_ref = ?").get("agent:shared");
    const beforeAssignment = db.prepare("SELECT assignment_ref, provider_profile_ref, status FROM assistant_assignments WHERE assignment_ref = ?").get(mount.assignmentRef);
    expect(() => repository.reconcileRuntimeCatalog([{
      ...configuredAgents[0]!, providerProfileRef: "provider-profile:remapped"
    }])).toThrow(/Provider/);
    expect(db.prepare("SELECT agent_ref, provider_profile_ref, status FROM agent_runtime_bindings WHERE agent_ref = ?").get("agent:shared")).toEqual(beforeBinding);
    expect(db.prepare("SELECT assignment_ref, provider_profile_ref, status FROM assistant_assignments WHERE assignment_ref = ?").get(mount.assignmentRef)).toEqual(beforeAssignment);
    expect(repository.listMemberMounts(familyRef, alice).mountedAgents).toContainEqual(
      expect.objectContaining({ assignmentRef: mount.assignmentRef, agentRef: "agent:shared" })
    );
  });
});
