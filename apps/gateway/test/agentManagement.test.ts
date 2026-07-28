import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
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

type MountWorkerMessage =
  | { type: "ready" }
  | { type: "mounting" }
  | { type: "result"; mount: ReturnType<AgentManagementRepository["mountMemberAgent"]> }
  | { type: "error"; code: string; message: string };

function waitForWorkerMessage(
  worker: Worker,
  expectedType: MountWorkerMessage["type"]
): Promise<MountWorkerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: MountWorkerMessage) => {
      if (message.type !== expectedType) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`Agent mount worker exited with code ${code}`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function startWorkerMount(worker: Worker) {
  const mounting = waitForWorkerMessage(worker, "mounting");
  const result = new Promise<ReturnType<AgentManagementRepository["mountMemberAgent"]>>(
    (resolve, reject) => {
      worker.on("message", (message: MountWorkerMessage) => {
        if (message.type === "result") resolve(message.mount);
        if (message.type === "error") {
          reject(new Error(`${message.code}: ${message.message}`));
        }
      });
      worker.once("error", reject);
    }
  );
  worker.postMessage({ type: "mount" });
  return { mounting, result };
}

describe("Agent management repository", () => {
  let directory = "";
  let databasePath = "";
  let db: GatewayDatabase;
  let repository: AgentManagementRepository;
  let familyRef = "";
  let alice = "";
  let bob = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-agent-management-"));
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
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

  it("atomically retires unconfigured Fake runtime state in authoritative real mode", () => {
    repository.reconcileRuntimeCatalog(
      configuredAgents.filter(agent => agent.providerKind !== "fake"),
      { authoritative: true }
    );

    expect(repository.listCatalog().map(agent => agent.agentRef)).toEqual([
      "agent:codex-cli",
      "agent:hermes-jarvis"
    ]);
    expect(repository.listMemberMounts(familyRef, alice)).toMatchObject({
      defaultAgentRef: null,
      mountedAgents: []
    });
    expect(db.prepare(
      `SELECT status FROM agent_runtime_bindings
       WHERE provider_profile_ref = 'provider-profile:fake-local'
       ORDER BY agent_ref`
    ).all()).toEqual([{ status: "disabled" }, { status: "disabled" }]);
    expect(db.prepare(
      `SELECT status, is_default, effective_to
       FROM assistant_assignments
       WHERE provider_profile_ref = 'provider-profile:fake-local'`
    ).all()).toEqual([
      {
        status: "ended",
        is_default: 0,
        effective_to: "2026-07-28T10:00:00.000Z"
      },
      {
        status: "ended",
        is_default: 0,
        effective_to: "2026-07-28T10:00:00.000Z"
      }
    ]);
    expect(db.prepare(
      `SELECT agent_ref, provider_profile_ref, status
       FROM family_manager_assignments
       ORDER BY effective_from, assignment_ref`
    ).all()).toEqual(expect.arrayContaining([
      {
        agent_ref: "agent:family-manager",
        provider_profile_ref: "provider-profile:fake-local",
        status: "ended"
      },
      {
        agent_ref: "agent:hermes-jarvis",
        provider_profile_ref: "provider-profile:hermes-jarvis",
        status: "active"
      }
    ]));
  });

  it("mounts one Agent for two members but not twice for one member", () => {
    const first = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    const replay = repository.mountMemberAgent({ familyRef, personRef: alice, agentRef: "agent:shared" });
    const secondMember = repository.mountMemberAgent({ familyRef, personRef: bob, agentRef: "agent:shared" });
    expect(replay.assignmentRef).toBe(first.assignmentRef);
    expect(secondMember.assignmentRef).not.toBe(first.assignmentRef);
  });

  it("serializes concurrent duplicate mounts across independent database connections", async () => {
    const workerInput = {
      databasePath,
      familyRef,
      personRef: alice,
      agentRef: "agent:shared",
      now: "2026-07-28T10:00:00.000Z"
    };
    const workers = [
      new Worker(new URL("./fixtures/agentManagementMountWorker.mjs", import.meta.url), {
        workerData: workerInput
      }),
      new Worker(new URL("./fixtures/agentManagementMountWorker.mjs", import.meta.url), {
        workerData: workerInput
      })
    ];
    let lockHeld = false;

    try {
      await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, "ready")));
      db.exec("BEGIN IMMEDIATE");
      lockHeld = true;

      const calls = workers.map(startWorkerMount);
      await Promise.all(calls.map((call) => call.mounting));
      await delay(100);
      db.exec("COMMIT");
      lockHeld = false;

      const [first, second] = await Promise.all(calls.map((call) => call.result));
      expect(second!.assignmentRef).toBe(first!.assignmentRef);
    } finally {
      if (lockHeld) db.exec("ROLLBACK");
      await Promise.all(workers.map((worker) => worker.terminate()));
    }

    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM assistant_assignments
       WHERE person_ref = ? AND agent_ref = ? AND status = 'active'`
    ).get(alice, "agent:shared")).toEqual({ count: 1 });
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
