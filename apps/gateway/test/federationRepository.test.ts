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
  let databasePath = "";
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
    databasePath = join(directory, "gateway.sqlite");
    db = openGatewayDatabase(databasePath);
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
    for (const observedAt of [
      "2026-08-28 12:00:00",
      "2026-08-28T20:00:00.000+08:00",
      "2026-08-28T12:00:00Z"
    ]) {
      expect(() => repository.recordDiscoveryObservation({
        agentRef,
        kind: "agent",
        runtime: "hermes-local",
        status: "available",
        capabilities: ["chat"],
        observedAt
      })).toThrow("FEDERATION_DISCOVERY_INVALID");
    }
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
      personDisplayName: "联邦测试成员",
      familyDisplayName: "联邦测试家庭",
      roles: ["owner", "family_admin"],
      assignmentVersion: 1,
      contextVersion: 1,
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
      "agent_invocation_audit",
      "person_agent_assignment_versions",
      "federation_session_bindings",
      "federation_session_invocation_claims"
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
    db.prepare(
      `UPDATE person_agent_assignment_versions
       SET assignment_version = assignment_version + 1, updated_at = ?
       WHERE person_ref = ?`
    ).run(now.toISOString(), personRef);
    expect(repository.getActorContext(staleVersion.contextRef)).toBeNull();

    const staleIdentity = issue();
    db.prepare(
      `UPDATE person_federation_context_versions
       SET context_version = context_version + 1, updated_at = ?
       WHERE person_ref = ?`
    ).run(now.toISOString(), personRef);
    expect(repository.getActorContext(staleIdentity.contextRef)).toBeNull();
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
      "agent_invocation_audit",
      "person_agent_assignment_versions",
      "federation_session_bindings",
      "federation_session_invocation_claims"
    ].flatMap((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const serialized = JSON.stringify(persisted);
    for (const sensitive of SENSITIVE_VALUES) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("binds one external session to one exact product Person Agent and local session", () => {
    const key = {
      product: "canvas" as const,
      familyRef,
      personRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:canvas-1"
    };
    expect(repository.validateExternalSessionBinding(key)).toBeNull();
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    repository.claimInvocation({
      ...key,
      serviceRef: "service:canvas",
      actorContextRef: "actor-context:bind-first",
      invocationRef: "invocation:bind-first",
      correlationRef: "correlation:bind-first",
      requestSha256: "65a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000
    });
    repository.finalizeInvocationSuccess({
      invocationRef: "invocation:bind-first",
      externalSessionRef: "external-session:hermes-zzh-session-1"
    });
    const bound = repository.validateExternalSessionBinding({
      ...key,
      externalSessionRef: "external-session:hermes-zzh-session-1"
    })!;
    expect(bound).toMatchObject({
      ...key,
      externalSessionRef: "external-session:hermes-zzh-session-1"
    });
    expect(repository.validateExternalSessionBinding({
      ...key,
      externalSessionRef: bound.externalSessionRef
    })).toEqual(bound);
    expect(() => repository.validateExternalSessionBinding(key)).toThrow(
      "FEDERATION_SESSION_REQUIRED"
    );
    expect(() => repository.validateExternalSessionBinding({
      ...key,
      externalSessionRef: "external-session:hermes-zzh-session-2"
    })).toThrow("FEDERATION_SESSION_MISMATCH");
    expect(() => repository.validateExternalSessionBinding({
      ...key,
      product: "me",
      externalSessionRef: bound.externalSessionRef
    })).toThrow("FEDERATION_SESSION_UNBOUND");
    expect(() => repository.validateExternalSessionBinding({
      ...key,
      localSessionRef: "local-session:brand-new",
      externalSessionRef: "external-session:hermes-zzh-never-seen"
    })).toThrow("FEDERATION_SESSION_UNBOUND");
  });

  it("acquires one full-scope invocation and returns same-ref state without a second claim", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    repository.provisionService({
      serviceRef: "service:canvas-other",
      product: "canvas",
      token: "canvas-other-service-token"
    });
    repository.provisionService({
      serviceRef: "service:me",
      product: "me",
      token: "me-other-service-token"
    });
    const actor = repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 60
    });
    const input = {
      serviceRef: "service:canvas",
      product: "canvas" as const,
      familyRef,
      personRef,
      actorContextRef: actor.contextRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:same-ref",
      invocationRef: "invocation:same-ref",
      correlationRef: "correlation:same-ref",
      requestSha256: "15a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000
    };

    expect(repository.claimInvocation(input)).toMatchObject({
      kind: "acquired",
      claim: { invocationRef: input.invocationRef }
    });
    const secondDb = openGatewayDatabase(databasePath);
    try {
      const second = new FederationRepository(secondDb, { now: () => now });
      expect(second.claimInvocation(input)).toMatchObject({
        kind: "accepted",
        status: {
          invocationRef: input.invocationRef,
          correlationRef: input.correlationRef,
          serviceRef: input.serviceRef,
          product: input.product,
          familyRef,
          personRef,
          agentRef: input.agentRef,
          localSessionRef: input.localSessionRef,
          leaseExpiresAt: new Date(now.getTime() + 32_000).toISOString()
        }
      });
      expect(() => second.claimInvocation({
        ...input,
        requestSha256: "25a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83"
      })).toThrow("FEDERATION_INVOCATION_DUPLICATE");
      expect(() => second.claimInvocation({
        ...input,
        correlationRef: "correlation:same-ref-drift"
      })).toThrow("FEDERATION_INVOCATION_DUPLICATE");
      for (const drift of [
        { serviceRef: "service:canvas-other" },
        { serviceRef: "service:me", product: "me" as const },
        { familyRef: "family:same-ref-drift" },
        { personRef: "person:same-ref-drift" },
        { agentRef: "agent:hermes-nsy" },
        { localSessionRef: "local-session:same-ref-drift" },
        { externalSessionRef: "external-session:same-ref-drift" },
        { timeoutMs: 2_001 }
      ]) {
        expect(() => second.claimInvocation({
          ...input,
          ...drift
        })).toThrow("FEDERATION_INVOCATION_DUPLICATE");
      }
    } finally {
      secondDb.close();
    }
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM agent_invocation_audit WHERE invocation_ref = ?"
    ).get(input.invocationRef)).toEqual({ count: 1 });
  });

  it("returns exact succeeded and failed status only for the stored full scope", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    const actor = repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 60
    });
    const base = {
      serviceRef: "service:canvas",
      product: "canvas" as const,
      familyRef,
      personRef,
      actorContextRef: actor.contextRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:status-scope",
      invocationRef: "invocation:status-success",
      correlationRef: "correlation:status-success",
      requestSha256: "35a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000
    };
    repository.claimInvocation(base);
    now = new Date(now.getTime() + 1_000);
    repository.finalizeInvocationSuccess({
      invocationRef: base.invocationRef,
      externalSessionRef: "external-session:status-success"
    });
    expect(repository.getScopedInvocationStatus(base)).toMatchObject({
      status: "succeeded",
      invocationRef: base.invocationRef,
      externalSessionRef: "external-session:status-success",
      completedAt: now.toISOString()
    });
    for (const drift of [
      { personRef: "person:other-status" },
      { agentRef: "agent:hermes-nsy" },
      { localSessionRef: "local-session:other-status" }
    ]) {
      expect(repository.getScopedInvocationStatus({ ...base, ...drift })).toBeNull();
    }

    const failure = {
      ...base,
      localSessionRef: "local-session:status-failed",
      invocationRef: "invocation:status-failed",
      correlationRef: "correlation:status-failed",
      requestSha256: "45a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83"
    };
    repository.claimInvocation(failure);
    now = new Date(now.getTime() + 1_000);
    repository.finalizeInvocationFailure({
      invocationRef: failure.invocationRef,
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    });
    expect(repository.getScopedInvocationStatus(failure)).toMatchObject({
      status: "failed",
      errorCode: "AGENT_RUNTIME_UNAVAILABLE",
      completedAt: now.toISOString()
    });
  });

  it("keeps legacy unscoped invocation audits historical and non-replayable", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    db.prepare(
      `INSERT INTO agent_invocation_audit(
         invocation_ref, correlation_ref, product, person_ref, agent_ref,
         local_session_ref, status, error_code, started_at, completed_at
       ) VALUES(?, ?, 'canvas', ?, 'agent:personal-assistant', ?,
                'failed', 'AGENT_RUNTIME_UNAVAILABLE', ?, ?)`
    ).run(
      "invocation:legacy-unscoped",
      "correlation:legacy-unscoped",
      personRef,
      "local-session:legacy-unscoped",
      now.toISOString(),
      now.toISOString()
    );
    const input = {
      serviceRef: "service:canvas",
      product: "canvas" as const,
      familyRef,
      personRef,
      actorContextRef: "actor-context:legacy-retry",
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:legacy-unscoped",
      invocationRef: "invocation:legacy-unscoped",
      correlationRef: "correlation:legacy-unscoped",
      requestSha256: "a5a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000
    };
    expect(repository.getScopedInvocationStatus(input)).toBeNull();
    expect(() => repository.claimInvocation(input)).toThrow(
      "FEDERATION_INVOCATION_DUPLICATE"
    );
  });

  it("keeps an accepted invocation exclusive after lease expiry without reclaiming the session", () => {
    repository.provisionService({
      serviceRef: "service:canvas",
      product: "canvas",
      token: SENSITIVE_VALUES[0]
    });
    const actor = repository.issueActorContext({
      product: "canvas",
      entrySessionRef,
      lifetimeSeconds: 60
    });
    const claim = (invocationRef: string) => repository.claimInvocation({
      serviceRef: "service:canvas",
      product: "canvas",
      familyRef,
      personRef,
      actorContextRef: actor.contextRef,
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:durable-claim",
      invocationRef,
      correlationRef: `correlation:${invocationRef.split(":")[1]}`,
      requestSha256: "55a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 1_000
    });

    expect(claim("invocation:lease-first")).toMatchObject({
      kind: "acquired",
      claim: {
        invocationRef: "invocation:lease-first",
        leaseExpiresAt: new Date(now.getTime() + 31_000).toISOString()
      }
    });
    now = new Date(now.getTime() + 30_999);
    expect(() => claim("invocation:lease-too-early")).toThrow(
      "FEDERATION_INVOCATION_BUSY"
    );
    expect(repository.getInvocationAudit("invocation:lease-first")?.status)
      .toBe("accepted");

    now = new Date(now.getTime() + 1);
    expect(() => claim("invocation:lease-at-deadline")).toThrow(
      "FEDERATION_INVOCATION_BUSY"
    );
    now = new Date(now.getTime() + 1);
    expect(() => claim("invocation:lease-still-blocked")).toThrow(
      "FEDERATION_INVOCATION_BUSY"
    );
    expect(claim("invocation:lease-first")).toMatchObject({
      kind: "accepted",
      status: { invocationRef: "invocation:lease-first" }
    });
    expect(repository.getInvocationAudit("invocation:lease-first")).toMatchObject({
      status: "accepted",
      errorCode: null
    });
  });

  it("atomically finalizes success or failure and preserves a recoverable claim on DB failure", () => {
    repository.provisionService({
      serviceRef: "service:me",
      product: "me",
      token: "me-service-token-private-value"
    });
    const claimInput = {
      serviceRef: "service:me",
      product: "me" as const,
      familyRef,
      personRef,
      actorContextRef: "actor-context:atomic-finalize",
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:atomic-finalize",
      invocationRef: "invocation:atomic-finalize",
      correlationRef: "correlation:atomic-finalize",
      requestSha256: "75a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000
    };
    repository.claimInvocation(claimInput);
    db.exec(`
      CREATE TRIGGER fail_federation_audit_success
      BEFORE UPDATE OF status ON agent_invocation_audit
      WHEN NEW.invocation_ref = 'invocation:atomic-finalize'
       AND NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE');
      END;
    `);

    expect(() => repository.finalizeInvocationSuccess({
      invocationRef: claimInput.invocationRef,
      externalSessionRef: "external-session:fake-atomic"
    })).toThrow("INJECTED_AUDIT_FAILURE");
    expect(repository.getInvocationAudit(claimInput.invocationRef)?.status)
      .toBe("accepted");
    expect(repository.getInvocationClaim(claimInput.invocationRef)).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM federation_session_bindings").get())
      .toEqual({ count: 0 });

    db.exec("DROP TRIGGER fail_federation_audit_success");
    repository.finalizeInvocationSuccess({
      invocationRef: claimInput.invocationRef,
      externalSessionRef: "external-session:fake-atomic"
    });
    expect(repository.getInvocationAudit(claimInput.invocationRef)?.status)
      .toBe("succeeded");
    expect(repository.getInvocationClaim(claimInput.invocationRef)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM federation_session_bindings").get())
      .toEqual({ count: 1 });

    repository.claimInvocation({
      ...claimInput,
      localSessionRef: "local-session:atomic-failure",
      invocationRef: "invocation:atomic-failure",
      correlationRef: "correlation:atomic-failure",
      requestSha256: "85a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83"
    });
    repository.finalizeInvocationFailure({
      invocationRef: "invocation:atomic-failure",
      errorCode: "AGENT_RUNTIME_UNAVAILABLE"
    });
    expect(repository.getInvocationAudit("invocation:atomic-failure")?.status)
      .toBe("failed");
    expect(repository.getInvocationClaim("invocation:atomic-failure")).toBeNull();
  });

  it("does not persist prompt output token Cookie path or raw Hermes material in V12", () => {
    repository.provisionService({
      serviceRef: "service:me",
      product: "me",
      token: SENSITIVE_VALUES[0]
    });
    repository.claimInvocation({
      serviceRef: "service:me",
      product: "me",
      familyRef,
      personRef,
      actorContextRef: "actor-context:sensitive-v14",
      agentRef: "agent:personal-assistant",
      localSessionRef: "local-session:me-safe",
      invocationRef: "invocation:sensitive-v12",
      correlationRef: "correlation:sensitive-v12",
      requestSha256: "95a7b2b705e7f01121080c12e2b8a708aece031fab917f696b2d4697c926df83",
      timeoutMs: 2_000,
      prompt: SENSITIVE_VALUES[1],
      output: SENSITIVE_VALUES[2],
      token: SENSITIVE_VALUES[0],
      cookie: "family_ai_web_entry_token=private",
      path: SENSITIVE_VALUES[5]
    } as Parameters<FederationRepository["claimInvocation"]>[0] & Record<string, string>);
    repository.finalizeInvocationSuccess({
      invocationRef: "invocation:sensitive-v12",
      externalSessionRef: "external-session:hermes-nsy-safe"
    });
    const serialized = JSON.stringify([
      ...db.prepare("SELECT * FROM federation_session_bindings").all(),
      ...db.prepare("SELECT * FROM federation_session_invocation_claims").all()
    ]);
    for (const sensitive of [...SENSITIVE_VALUES, "family_ai_web_entry_token"]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
