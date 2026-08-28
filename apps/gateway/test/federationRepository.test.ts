import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, sha256, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import { FederationRepository } from "../src/federationRepository.js";

const SENSITIVE_VALUES = [
  "canvas-service-token-plaintext",
  "prompt: private family request",
  "response: private agent answer",
  "stderr: provider stack trace",
  "hermes-session:private-session-id",
  "/srv/private/hermes/profile"
] as const;

describe("FederationRepository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let repository: FederationRepository;
  let now: Date;
  let familyRef = "";
  let personRef = "";
  let deviceRef = "";
  let entrySessionRef = "";
  let nextId = 1;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-federation-repository-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    const onboarding = new FamilyDomainRepository(db).initializeFamily({
      familyName: "联邦测试家庭",
      ownerName: "联邦测试成员",
      deviceName: "联邦测试设备",
      deviceCredential: "federation-device-credential-with-enough-length"
    });
    familyRef = onboarding.family.familyRef;
    personRef = onboarding.owner.personRef;
    deviceRef = onboarding.device.deviceRef;
    entrySessionRef = onboarding.entries.admin.entrySessionRef;
    now = new Date();
    const events = new DomainEventStore(db, () => now);
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      events.append({
        personRef,
        eventType: `test.federation.assignment.${sequence}`,
        aggregateType: "work",
        aggregateRef: `work:federation-${sequence}`,
        payload: { sequence },
        occurredAt: now.toISOString()
      });
    }
    repository = new FederationRepository(db, {
      now: () => now,
      uuid: () => `context-${nextId++}`
    });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("authenticates active product services by SHA-256 token and keeps revocation sticky", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });

    expect(repository.authenticateService(SENSITIVE_VALUES[0])).toEqual({
      serviceRef: "service:canvas",
      product: "canvas"
    });
    expect(repository.authenticateService("wrong-service-token")).toBeNull();
    expect(db.prepare(
      "SELECT service_ref, product, token_hash, status FROM federation_services"
    ).get()).toEqual({
      service_ref: "service:canvas",
      product: "canvas",
      token_hash: sha256(SENSITIVE_VALUES[0]),
      status: "active"
    });

    repository.revokeService("service:canvas");
    expect(repository.authenticateService(SENSITIVE_VALUES[0])).toBeNull();
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    expect(repository.authenticateService(SENSITIVE_VALUES[0])).toBeNull();
  });

  it("upserts safe discovery observations without accepting a local runtime path", () => {
    const agentRef = "agent:personal-assistant";
    expect(repository.recordDiscoveryObservation({
      agentRef,
      kind: "agent",
      runtime: "hermes-local",
      status: "available",
      capabilities: ["chat", "session-resume"],
      observedAt: now.toISOString()
    })).toEqual({
      agentRef,
      kind: "agent",
      runtime: "hermes-local",
      status: "available",
      capabilities: ["chat", "session-resume"],
      observedAt: now.toISOString()
    });
    expect(() => repository.recordDiscoveryObservation({
      agentRef,
      kind: "agent",
      runtime: SENSITIVE_VALUES[5],
      status: "available",
      capabilities: ["chat"],
      observedAt: now.toISOString()
    })).toThrow("FEDERATION_DISCOVERY_INVALID");
    expect(() => repository.recordDiscoveryObservation({
      agentRef,
      kind: "process" as "agent",
      runtime: "hermes-local",
      status: "running" as "available",
      capabilities: ["chat"],
      observedAt: now.toISOString()
    })).toThrow("FEDERATION_DISCOVERY_INVALID");
    expect(repository.getDiscoveryObservation(agentRef)?.capabilities).toEqual([
      "chat",
      "session-resume"
    ]);
  });

  it("issues Actor contexts for at most 60 seconds from live Entry and Person sequence", () => {
    const actor = repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 60
    });

    expect(actor).toEqual({
      protocolVersion: 1,
      contextRef: "actor-context:context-1",
      product: "canvas",
      familyRef,
      personRef,
      deviceRef,
      entrySessionRef,
      roles: ["owner", "family_admin"],
      assignmentVersion: 7,
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
    expect(repository.getActorContext(actor.contextRef)).toEqual(actor);
    expect(() => repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 61
    })).toThrow("FEDERATION_CONTEXT_TTL_INVALID");
  });

  it("rejects a path-shaped generated Actor context ref without persisting the sentinel", () => {
    const pathSentinel = ["", "home", "youran", "private-context"].join("/");
    const malicious = new FederationRepository(db, {
      now: () => now,
      uuid: () => pathSentinel
    });

    expect(() => malicious.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 60
    })).toThrow("FEDERATION_CONTEXT_REF_INVALID");

    const persisted = [
      "federation_services",
      "agent_discovery_observations",
      "federation_actor_contexts",
      "agent_invocation_audit"
    ].flatMap((table) => db.prepare(`SELECT * FROM ${table}`).all());
    expect(persisted).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain(pathSentinel);
  });

  it("invalidates Actor lookup after context expiry, Entry revocation, Device revocation, or version drift", () => {
    const issue = () => repository.issueActorContext({
      product: "me",
      entrySessionRef,
      lifetimeSeconds: 60
    });
    const expired = issue();
    now = new Date(now.getTime() + 60_001);
    expect(repository.getActorContext(expired.contextRef)).toBeNull();

    now = new Date(now.getTime() - 60_001);
    const revokedEntry = issue();
    db.prepare("UPDATE entry_sessions SET status = 'revoked', revoked_at = ? WHERE entry_session_ref = ?")
      .run(now.toISOString(), entrySessionRef);
    expect(repository.getActorContext(revokedEntry.contextRef)).toBeNull();
    db.prepare("UPDATE entry_sessions SET status = 'active', revoked_at = NULL WHERE entry_session_ref = ?")
      .run(entrySessionRef);

    const revokedDevice = issue();
    db.prepare("UPDATE managed_devices SET status = 'revoked', revoked_at = ? WHERE device_ref = ?")
      .run(now.toISOString(), deviceRef);
    expect(repository.getActorContext(revokedDevice.contextRef)).toBeNull();
    db.prepare("UPDATE managed_devices SET status = 'active', revoked_at = NULL WHERE device_ref = ?")
      .run(deviceRef);

    const staleVersion = issue();
    new DomainEventStore(db, () => now).append({
      personRef,
      eventType: "test.federation.assignment.changed",
      aggregateType: "work",
      aggregateRef: "work:federation-version-change",
      payload: {},
      occurredAt: now.toISOString()
    });
    expect(repository.getActorContext(staleVersion.contextRef)).toBeNull();
  });

  it("fails Actor lookup closed when any live authority relation becomes inactive", () => {
    const refs = db.prepare(
      `SELECT es.entry_binding_ref, db.device_binding_ref
       FROM entry_sessions es
       JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
       JOIN device_bindings db
         ON db.device_ref = eb.device_ref
        AND db.family_ref = eb.family_ref
        AND db.person_ref = eb.person_ref
        AND db.owner_scope = 'person'
        AND db.status = 'active'
       WHERE es.entry_session_ref = ?`
    ).get(entrySessionRef) as {
      entry_binding_ref: string;
      device_binding_ref: string;
    };
    const cases = [
      {
        mutate: () => db.prepare(
          "UPDATE entry_bindings SET status = 'revoked' WHERE entry_binding_ref = ?"
        ).run(refs.entry_binding_ref),
        restore: () => db.prepare(
          "UPDATE entry_bindings SET status = 'active' WHERE entry_binding_ref = ?"
        ).run(refs.entry_binding_ref)
      },
      {
        mutate: () => db.prepare(
          "UPDATE families SET status = 'archived' WHERE family_ref = ?"
        ).run(familyRef),
        restore: () => db.prepare(
          "UPDATE families SET status = 'active' WHERE family_ref = ?"
        ).run(familyRef)
      },
      {
        mutate: () => db.prepare(
          "UPDATE persons SET status = 'suspended' WHERE person_ref = ?"
        ).run(personRef),
        restore: () => db.prepare(
          "UPDATE persons SET status = 'active' WHERE person_ref = ?"
        ).run(personRef)
      },
      {
        mutate: () => db.prepare(
          `UPDATE family_memberships SET status = 'inactive'
           WHERE family_ref = ? AND person_ref = ?`
        ).run(familyRef, personRef),
        restore: () => db.prepare(
          `UPDATE family_memberships SET status = 'active'
           WHERE family_ref = ? AND person_ref = ?`
        ).run(familyRef, personRef)
      },
      {
        mutate: () => db.prepare(
          "UPDATE device_bindings SET status = 'revoked' WHERE device_binding_ref = ?"
        ).run(refs.device_binding_ref),
        restore: () => db.prepare(
          "UPDATE device_bindings SET status = 'active' WHERE device_binding_ref = ?"
        ).run(refs.device_binding_ref)
      }
    ];

    for (const testCase of cases) {
      const actor = repository.issueActorContext({
        product: "canvas",
        entrySessionRef,
        lifetimeSeconds: 60
      });
      testCase.mutate();
      expect(repository.getActorContext(actor.contextRef)).toBeNull();
      testCase.restore();
    }
  });

  it("allows only accepted to succeeded or failed audit transitions", () => {
    const accepted = repository.acceptInvocation({
      invocationRef: "invocation:federation-1",
      correlationRef: "correlation:federation-1",
      product: "canvas",
      personRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:canvas-1",
      prompt: SENSITIVE_VALUES[1],
      response: SENSITIVE_VALUES[2],
      stderr: SENSITIVE_VALUES[3],
      hermesSessionId: SENSITIVE_VALUES[4],
      localPath: SENSITIVE_VALUES[5]
    } as Parameters<FederationRepository["acceptInvocation"]>[0] & Record<string, string>);
    expect(accepted).toMatchObject({ status: "accepted", completedAt: null });

    now = new Date(now.getTime() + 1_000);
    expect(repository.completeInvocation({
      invocationRef: accepted.invocationRef,
      status: "succeeded"
    })).toMatchObject({
      status: "succeeded",
      errorCode: null,
      completedAt: now.toISOString()
    });
    expect(() => repository.completeInvocation({
      invocationRef: accepted.invocationRef,
      status: "failed",
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    })).toThrow("FEDERATION_AUDIT_INVALID_TRANSITION");
    const invalidStatus = repository.acceptInvocation({
      invocationRef: "invocation:federation-invalid-status",
      correlationRef: "correlation:federation-invalid-status",
      product: "canvas",
      personRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:canvas-invalid-status"
    });
    expect(() => repository.completeInvocation({
      invocationRef: invalidStatus.invocationRef,
      status: "cancelled" as "failed",
      errorCode: "AGENT_CANCELLED"
    })).toThrow("FEDERATION_AUDIT_INVALID_TRANSITION");

    const failed = repository.acceptInvocation({
      invocationRef: "invocation:federation-2",
      correlationRef: "correlation:federation-2",
      product: "me",
      personRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:me-1"
    });
    expect(repository.completeInvocation({
      invocationRef: failed.invocationRef,
      status: "failed",
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    })).toMatchObject({
      status: "failed",
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    });
  });

  it("never persists token plaintext, prompts, outputs, stderr, Hermes sessions, or local paths", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    repository.recordDiscoveryObservation({
      agentRef: "agent:personal-assistant",
      kind: "agent",
      runtime: "hermes-local",
      status: "available",
      capabilities: ["chat"],
      observedAt: now.toISOString(),
      prompt: SENSITIVE_VALUES[1],
      response: SENSITIVE_VALUES[2],
      stderr: SENSITIVE_VALUES[3],
      hermesSessionId: SENSITIVE_VALUES[4],
      localPath: SENSITIVE_VALUES[5]
    } as Parameters<FederationRepository["recordDiscoveryObservation"]>[0] & Record<string, string>);
    const actor = repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 30
    });
    repository.acceptInvocation({
      invocationRef: "invocation:sensitive-scan",
      correlationRef: "correlation:sensitive-scan",
      product: actor.product,
      personRef: actor.personRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:safe-scan",
      prompt: SENSITIVE_VALUES[1],
      response: SENSITIVE_VALUES[2],
      stderr: SENSITIVE_VALUES[3],
      hermesSessionId: SENSITIVE_VALUES[4],
      localPath: SENSITIVE_VALUES[5]
    } as Parameters<FederationRepository["acceptInvocation"]>[0] & Record<string, string>);

    const persisted = [
      "federation_services",
      "agent_discovery_observations",
      "federation_actor_contexts",
      "agent_invocation_audit"
    ].flatMap((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const serialized = JSON.stringify(persisted);
    for (const sensitive of SENSITIVE_VALUES) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
