import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentInvocationResultV1Schema,
  type AgentInvocationRequestV1
} from "@family-ai/contracts";
import {
  BrokerProviderAdapter,
  ProviderAdapterRouter
} from "@family-ai/provider-adapter-sdk";
import { buildGatewayApp } from "../src/app.js";
import { AgentManagementRepository } from "../src/agentManagement.js";
import { openGatewayDatabase, type GatewayDatabase } from "../src/database.js";
import { DomainEventStore } from "../src/domainEvents.js";
import { FederationRepository } from "../src/federationRepository.js";
import { FederationService } from "../src/federationService.js";

const NOW = "2026-08-28T12:00:00.000Z";
const DEVICE_TOKEN = "federation-routes-bootstrap-device-token-long-enough";
const CANVAS_TOKEN = "canvas-service-token-private-value";
const ME_TOKEN = "me-service-token-private-value";
const PRIVATE_PROMPT = "PRIVATE_PROMPT_never_persist";
const PRIVATE_OUTPUT = "PRIVATE_OUTPUT_never_persist";
const PRIVATE_BROKER_ERROR = "PRIVATE_BROKER_STACK_/home/private/hermes";

const agents = [
  {
    agentRef: "agent:hermes-jarvis",
    displayName: "Jarvis",
    providerProfileRef: "provider-profile:broker-jarvis",
    providerKind: "hermes" as const,
    system: true
  },
  {
    agentRef: "agent:hermes-zzh",
    displayName: "于途",
    providerProfileRef: "provider-profile:broker-zzh",
    providerKind: "hermes" as const,
    system: false
  },
  {
    agentRef: "agent:hermes-nsy",
    displayName: "乔晶晶",
    providerProfileRef: "provider-profile:broker-nsy",
    providerKind: "hermes" as const,
    system: false
  }
] as const;

type Entry = { entrySessionRef: string; token: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cookie(entry: Entry): string {
  return [
    `family_ai_web_entry_session_ref=${encodeURIComponent(entry.entrySessionRef)}`,
    `family_ai_web_entry_token=${encodeURIComponent(entry.token)}`
  ].join("; ");
}

function serviceHeaders(token: string, entry?: Entry): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(entry === undefined ? {} : { cookie: cookie(entry) })
  };
}

function invocation(input: Partial<AgentInvocationRequestV1> = {}): AgentInvocationRequestV1 {
  return {
    protocolVersion: 1,
    invocationRef: "invocation:canvas-1",
    correlationRef: "correlation:canvas-1",
    product: "canvas",
    actorContextRef: "actor-context:placeholder",
    agentRef: "agent:hermes-zzh",
    localSessionRef: "local-session:canvas-1",
    prompt: PRIVATE_PROMPT,
    timeoutMs: 2_000,
    ...input
  };
}

describe("Family federation routes", () => {
  let directory = "";
  let socketDirectory = "";
  let socketPath = "";
  let broker: Server;
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let secondApp: Awaited<ReturnType<typeof buildGatewayApp>> | undefined;
  let providerRouter: ProviderAdapterRouter;
  let databasePath = "";
  let db: GatewayDatabase;
  let now = new Date(NOW);
  let admin: Entry;
  let personal: Entry;
  let member: Entry;
  let familyRef = "";
  let ownerPersonRef = "";
  let memberPersonRef = "";
  let brokerCalls = 0;
  let brokerDelayMs = 0;
  let brokerFailure = false;

  const actorRef = async (product: "canvas" | "me", entry: Entry): Promise<string> => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/federation/session",
      headers: serviceHeaders(product === "canvas" ? CANVAS_TOKEN : ME_TOKEN, entry)
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    return String(response.headers["x-family-ai-context-ref"]);
  };

  const insertMemberEntry = (): Entry => {
    const entry = {
      entrySessionRef: "entry-session:federation-member",
      token: "member-entry-token-private-value-long-enough"
    };
    const deviceRef = "device:federation-member";
    const time = now.toISOString();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO managed_devices(
           device_ref, display_name, terminal_type, platform, status,
           credential_hash, created_at, updated_at, revoked_at
         ) VALUES(?, '成员浏览器', 'web', 'test', 'active', ?, ?, ?, NULL)`
      ).run(deviceRef, sha256("member-device-private"), time, time);
      db.prepare(
        `INSERT INTO device_bindings(
           device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
           status, bound_at, revoked_at
         ) VALUES('device-binding:federation-member', ?, 'person', ?, ?,
           'active', ?, NULL)`
      ).run(deviceRef, familyRef, memberPersonRef, time);
      db.prepare(
        `INSERT INTO entry_bindings(
           entry_binding_ref, device_ref, family_ref, person_ref, audience,
           status, bound_at, last_used_at
         ) VALUES('entry-binding:federation-member', ?, ?, ?, 'personal',
           'active', ?, NULL)`
      ).run(deviceRef, familyRef, memberPersonRef, time);
      db.prepare(
        `INSERT INTO entry_sessions(
           entry_session_ref, entry_binding_ref, token_hash, status,
           created_at, expires_at, revoked_at
         ) VALUES(?, 'entry-binding:federation-member', ?, 'active', ?, ?, NULL)`
      ).run(
        entry.entrySessionRef,
        sha256(entry.token),
        time,
        new Date(now.getTime() + 60 * 60 * 1000).toISOString()
      );
    })();
    return entry;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-ai-federation-routes-"));
    socketDirectory = await mkdtemp(join(tmpdir(), "family-ai-federation-broker-"));
    socketPath = join(socketDirectory, "broker.sock");
    brokerCalls = 0;
    brokerDelayMs = 0;
    brokerFailure = false;
    broker = http.createServer((request, response) => {
      if (request.url === "/v1/health") {
        const body = JSON.stringify({
          status: "ok",
          agents: agents.map((agent) => ({
            protocolVersion: 1,
            agentRef: agent.agentRef,
            displayName: agent.displayName,
            kind: "agent",
            runtime: "hermes-local",
            status: "available",
            capabilities: ["chat", "session-resume"],
            system: agent.system,
            observedAt: NOW
          }))
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        });
        response.end(body);
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        brokerCalls += 1;
        if (brokerFailure) {
          const body = JSON.stringify({ error: PRIVATE_BROKER_ERROR });
          response.writeHead(500, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          });
          response.end(body);
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentInvocationRequestV1;
        const profile = body.agentRef.split("-").at(-1);
        const result = JSON.stringify({
          protocolVersion: 1,
          invocationRef: body.invocationRef,
          correlationRef: body.correlationRef,
          status: "succeeded",
          output: PRIVATE_OUTPUT,
          completedAt: new Date(now.getTime() + 1_000).toISOString(),
          externalSessionRef: body.externalSessionRef ??
            `external-session:hermes-${profile}-session-${brokerCalls}`
        });
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(result)
          });
          response.end(result);
        }, brokerDelayMs);
      });
    });
    await new Promise<void>((resolve, reject) => {
      broker.once("error", reject);
      broker.listen(socketPath, resolve);
    });

    databasePath = join(directory, "gateway.sqlite");
    providerRouter = new ProviderAdapterRouter(agents.map((agent) => [
      agent.providerProfileRef,
      new BrokerProviderAdapter({
        socketPath,
        targetAgentRef: agent.agentRef,
        providerProfileRef: agent.providerProfileRef,
        clock: () => now
      })
    ] as const));
    app = await buildGatewayApp({
      databasePath,
      deviceToken: DEVICE_TOKEN,
      mode: "test",
      configuredAgentRuntimes: agents,
      providerRouter,
      authoritativeAgentRuntimeCatalog: true,
      federationServices: [
        { serviceRef: "service:canvas", product: "canvas", token: CANVAS_TOKEN },
        { serviceRef: "service:me", product: "me", token: ME_TOKEN }
      ],
      now: () => now
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: {
        authorization: `Bearer ${DEVICE_TOKEN}`,
        "x-device-ref": "device:test"
      },
      payload: {
        familyName: "联邦测试家庭",
        ownerName: "管理员",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const onboarded = onboarding.json() as {
      family: { familyRef: string };
      owner: { personRef: string };
      entries: { admin: Entry; personal: Entry };
    };
    familyRef = onboarded.family.familyRef;
    ownerPersonRef = onboarded.owner.personRef;
    admin = onboarded.entries.admin;
    personal = onboarded.entries.personal;

    const createdMember = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "x-entry-session-ref": admin.entrySessionRef
      },
      payload: { displayName: "普通成员", familyRole: "adult" }
    });
    expect(createdMember.statusCode).toBe(201);
    memberPersonRef = String((createdMember.json() as { member: { personRef: string } }).member.personRef);

    db = openGatewayDatabase(databasePath);
    const events = new DomainEventStore(db, () => now);
    for (const personRef of [ownerPersonRef, memberPersonRef]) {
      events.append({
        personRef,
        eventType: "test.federation.assignment.initialized",
        aggregateType: "work",
        aggregateRef: `work:${personRef.split(":").at(-1)}`,
        payload: {},
        occurredAt: now.toISOString()
      });
    }
    member = insertMemberEntry();
    for (const agent of agents.filter((candidate) => !candidate.system)) {
      db.prepare(
        `INSERT INTO assistant_assignments(
           assignment_ref, person_ref, agent_ref, provider_profile_ref,
           status, effective_from, effective_to, is_default
         ) VALUES(?, ?, ?, ?, 'active', ?, NULL, 0)`
      ).run(
        `assignment:owner-${agent.agentRef.split(":").at(-1)}`,
        ownerPersonRef,
        agent.agentRef,
        agent.providerProfileRef,
        now.toISOString()
      );
    }
    db.prepare(
      `INSERT INTO assistant_assignments(
         assignment_ref, person_ref, agent_ref, provider_profile_ref,
         status, effective_from, effective_to, is_default
       ) VALUES('assignment:member-nsy', ?, 'agent:hermes-nsy',
         'provider-profile:broker-nsy', 'active', ?, NULL, 0)`
    ).run(memberPersonRef, now.toISOString());
  });

  afterEach(async () => {
    db?.close();
    await secondApp?.close();
    await app?.close();
    await new Promise<void>((resolve) => broker?.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  });

  it("issues Canvas and ME contexts with only fixed safe headers", async () => {
    for (const [product, token] of [["canvas", CANVAS_TOKEN], ["me", ME_TOKEN]] as const) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/federation/session",
        headers: {
          ...serviceHeaders(token, admin),
          "x-family-ai-person-ref": memberPersonRef,
          "x-family-ai-product": product === "canvas" ? "me" : "canvas",
          "x-family-ai-role": "super_admin"
        }
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(response.headers["x-family-ai-person-ref"]).toBe(ownerPersonRef);
      expect(response.headers["x-family-ai-family-ref"]).toBe(familyRef);
      expect(response.headers["x-family-ai-roles"]).toBe("owner,family_admin");
      expect(response.headers["x-family-ai-context-ref"]).toMatch(/^actor-context:/);
      expect(response.headers["x-family-ai-person-display-name-b64"])
        .toBe("566h55CG5ZGY");
      expect(response.headers["x-family-ai-family-display-name-b64"])
        .toBe("6IGU6YKm5rWL6K-V5a625bqt");
      expect(response.headers["x-family-ai-context-version"]).toBe("1");
      expect(response.headers["x-family-ai-person-display-name-b64"])
        .toMatch(/^[A-Za-z0-9_-]+$/);
      expect(response.headers["x-family-ai-family-display-name-b64"])
        .toMatch(/^[A-Za-z0-9_-]+$/);
      const serialized = JSON.stringify(response.headers);
      expect(serialized).not.toMatch(/管理员|联邦测试家庭|\r|\n/);
      expect(serialized).not.toMatch(/entry-token|service-token|provider-profile|hermes-home/i);
    }
  });

  it("invokes mounted Agents successfully for both Canvas and ME contexts", async () => {
    for (const [product, token, agentRef] of [
      ["canvas", CANVAS_TOKEN, "agent:hermes-zzh"],
      ["me", ME_TOKEN, "agent:hermes-nsy"]
    ] as const) {
      const contextRef = await actorRef(product, admin);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/federation/invocations",
        headers: serviceHeaders(token),
        payload: invocation({
          invocationRef: `invocation:${product}-success`,
          correlationRef: `correlation:${product}-success`,
          product,
          actorContextRef: contextRef,
          agentRef,
          localSessionRef: `local-session:${product}-success`
        })
      });
      expect(response.statusCode).toBe(200);
      expect(agentInvocationResultV1Schema.parse(response.json())).toMatchObject({
        invocationRef: `invocation:${product}-success`,
        status: "succeeded"
      });
    }
  });

  it("lists only Jarvis for admins and exact active mounts for members", async () => {
    const adminList = await app.inject({
      method: "GET",
      url: "/api/v1/federation/agents",
      headers: serviceHeaders(CANVAS_TOKEN, admin)
    });
    expect(adminList.statusCode).toBe(200);
    expect((adminList.json() as { agents: Array<{ agentRef: string }> }).agents.map(
      (agent) => agent.agentRef
    )).toEqual([
      "agent:hermes-jarvis",
      "agent:hermes-nsy",
      "agent:hermes-zzh"
    ]);
    expect(adminList.body).not.toMatch(/provider-profile|\/home\/|service-token|assignment:/i);

    const memberList = await app.inject({
      method: "GET",
      url: "/api/v1/federation/agents",
      headers: serviceHeaders(ME_TOKEN, member)
    });
    expect(memberList.statusCode).toBe(200);
    expect((memberList.json() as { agents: Array<{ agentRef: string }> }).agents.map(
      (agent) => agent.agentRef
    )).toEqual(["agent:hermes-nsy"]);
  });

  it("allows Jarvis only for family_admin and personal Agents only with an active exact mount", async () => {
    const adminContext = await actorRef("canvas", admin);
    const memberContext = await actorRef("canvas", member);
    const adminJarvis = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:jarvis-admin",
        correlationRef: "correlation:jarvis-admin",
        actorContextRef: adminContext,
        agentRef: "agent:hermes-jarvis",
        localSessionRef: "local-session:jarvis-admin"
      })
    });
    expect(adminJarvis.statusCode).toBe(200);
    expect(agentInvocationResultV1Schema.parse(adminJarvis.json()).status).toBe("succeeded");

    const beforeDenied = brokerCalls;
    const memberJarvis = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:jarvis-member",
        correlationRef: "correlation:jarvis-member",
        actorContextRef: memberContext,
        agentRef: "agent:hermes-jarvis",
        localSessionRef: "local-session:jarvis-member"
      })
    });
    expect(memberJarvis.statusCode).toBe(403);
    expect(brokerCalls).toBe(beforeDenied);

    const mounted = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:member-nsy",
        correlationRef: "correlation:member-nsy",
        actorContextRef: memberContext,
        agentRef: "agent:hermes-nsy",
        localSessionRef: "local-session:member-nsy"
      })
    });
    expect(mounted.statusCode).toBe(200);

    const beforeUnmounted = brokerCalls;
    const unmounted = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:member-zzh",
        correlationRef: "correlation:member-zzh",
        actorContextRef: memberContext,
        agentRef: "agent:hermes-zzh",
        localSessionRef: "local-session:member-zzh"
      })
    });
    expect(unmounted.statusCode).toBe(403);
    expect(brokerCalls).toBe(beforeUnmounted);
  });

  it("rejects service product body context mismatches and every external-session scope reuse before Broker", async () => {
    const canvasContext = await actorRef("canvas", admin);
    const unboundBefore = brokerCalls;
    const unbound = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:unbound-external",
        correlationRef: "correlation:unbound-external",
        actorContextRef: canvasContext,
        localSessionRef: "local-session:unbound-external",
        externalSessionRef: "external-session:hermes-zzh-never-issued"
      })
    });
    expect(unbound.statusCode).toBe(409);
    expect(brokerCalls).toBe(unboundBefore);
    expect(db.prepare(
      "SELECT 1 FROM agent_invocation_audit WHERE invocation_ref = ?"
    ).get("invocation:unbound-external")).toBeUndefined();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({ actorContextRef: canvasContext })
    });
    expect(first.statusCode).toBe(200);
    const externalSessionRef = agentInvocationResultV1Schema.parse(first.json()).externalSessionRef;

    const continued = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:canvas-continuation",
        correlationRef: "correlation:canvas-continuation",
        actorContextRef: canvasContext,
        externalSessionRef
      })
    });
    expect(continued.statusCode).toBe(200);
    expect(agentInvocationResultV1Schema.parse(continued.json()).externalSessionRef)
      .toBe(externalSessionRef);

    const cases: Array<{
      token: string;
      payload: AgentInvocationRequestV1;
    }> = [
      {
        token: ME_TOKEN,
        payload: invocation({
          invocationRef: "invocation:wrong-service",
          correlationRef: "correlation:wrong-service",
          actorContextRef: canvasContext
        })
      },
      {
        token: CANVAS_TOKEN,
        payload: invocation({
          invocationRef: "invocation:wrong-body",
          correlationRef: "correlation:wrong-body",
          actorContextRef: canvasContext,
          product: "me"
        })
      },
      {
        token: CANVAS_TOKEN,
        payload: invocation({
          invocationRef: "invocation:missing-resume",
          correlationRef: "correlation:missing-resume",
          actorContextRef: canvasContext
        })
      },
      {
        token: CANVAS_TOKEN,
        payload: invocation({
          invocationRef: "invocation:wrong-local",
          correlationRef: "correlation:wrong-local",
          actorContextRef: canvasContext,
          localSessionRef: "local-session:canvas-other",
          externalSessionRef
        })
      },
      {
        token: CANVAS_TOKEN,
        payload: invocation({
          invocationRef: "invocation:wrong-agent",
          correlationRef: "correlation:wrong-agent",
          actorContextRef: canvasContext,
          agentRef: "agent:hermes-nsy",
          localSessionRef: "local-session:canvas-other-agent",
          externalSessionRef
        })
      }
    ];
    const meContext = await actorRef("me", admin);
    cases.push({
      token: ME_TOKEN,
      payload: invocation({
        invocationRef: "invocation:wrong-product-session",
        correlationRef: "correlation:wrong-product-session",
        product: "me",
        actorContextRef: meContext,
        localSessionRef: "local-session:me-other",
        externalSessionRef
      })
    });
    const memberContext = await actorRef("canvas", member);
    cases.push({
      token: CANVAS_TOKEN,
      payload: invocation({
        invocationRef: "invocation:wrong-person-session",
        correlationRef: "correlation:wrong-person-session",
        actorContextRef: memberContext,
        agentRef: "agent:hermes-nsy",
        localSessionRef: "local-session:member-other",
        externalSessionRef
      })
    });

    for (const testCase of cases) {
      const before = brokerCalls;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/federation/invocations",
        headers: serviceHeaders(testCase.token),
        payload: testCase.payload
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(brokerCalls).toBe(before);
    }
  });

  it("uses a durable claim to stop a second Gateway instance before Broker", async () => {
    secondApp = await buildGatewayApp({
      databasePath,
      deviceToken: DEVICE_TOKEN,
      mode: "test",
      configuredAgentRuntimes: agents,
      providerRouter: new ProviderAdapterRouter(agents.map((agent) => [
        agent.providerProfileRef,
        new BrokerProviderAdapter({
          socketPath,
          targetAgentRef: agent.agentRef,
          providerProfileRef: agent.providerProfileRef,
          clock: () => now
        })
      ] as const)),
      authoritativeAgentRuntimeCatalog: true,
      federationServices: [
        { serviceRef: "service:canvas", product: "canvas", token: CANVAS_TOKEN },
        { serviceRef: "service:me", product: "me", token: ME_TOKEN }
      ],
      now: () => now
    });
    const contextRef = await actorRef("canvas", admin);
    brokerDelayMs = 500;
    const before = brokerCalls;
    const first = app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:gateway-one",
        correlationRef: "correlation:gateway-one",
        actorContextRef: contextRef,
        localSessionRef: "local-session:cross-gateway"
      })
    });
    await expect.poll(() => brokerCalls).toBe(before + 1);
    const second = await secondApp.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:gateway-two",
        correlationRef: "correlation:gateway-two",
        actorContextRef: contextRef,
        localSessionRef: "local-session:cross-gateway"
      })
    });
    expect(second.statusCode).toBe(409);
    expect(brokerCalls).toBe(before + 1);
    expect((await first).statusCode).toBe(200);
  });

  it("rechecks service activity after claim and releases the failed audit before Broker", async () => {
    const federationRepository = new FederationRepository(db, { now: () => now });
    const adapter = providerRouter.resolve("provider-profile:broker-zzh");
    let resolves = 0;
    const service = new FederationService(
      federationRepository,
      {
        resolve() {
          resolves += 1;
          if (resolves === 2) {
            federationRepository.revokeService("service:canvas");
          }
          return adapter;
        }
      },
      () => now
    );
    const authenticated = service.authenticateService(CANVAS_TOKEN);
    const actor = federationRepository.issueActorContext({
      product: "canvas",
      entrySessionRef: admin.entrySessionRef,
      lifetimeSeconds: 60
    });
    const before = brokerCalls;

    await expect(service.invoke(authenticated, invocation({
      invocationRef: "invocation:revoked-after-claim",
      correlationRef: "correlation:revoked-after-claim",
      actorContextRef: actor.contextRef,
      localSessionRef: "local-session:revoked-after-claim"
    }))).rejects.toMatchObject({ code: "FEDERATION_SERVICE_UNAUTHORIZED" });
    expect(brokerCalls).toBe(before);
    expect(federationRepository.getInvocationAudit(
      "invocation:revoked-after-claim"
    )).toMatchObject({
      status: "failed",
      errorCode: "FEDERATION_SERVICE_REVOKED"
    });
    expect(federationRepository.getInvocationClaim(
      "invocation:revoked-after-claim"
    )).toBeNull();
  });

  it("rejects a queued invocation when its service is revoked before dequeue", async () => {
    const contextRef = await actorRef("canvas", admin);
    const initial = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:queued-initial",
        correlationRef: "correlation:queued-initial",
        actorContextRef: contextRef,
        localSessionRef: "local-session:queued-revocation"
      })
    });
    expect(initial.statusCode).toBe(200);
    const externalSessionRef = agentInvocationResultV1Schema.parse(
      initial.json()
    ).externalSessionRef;
    brokerDelayMs = 400;
    const before = brokerCalls;
    const first = app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:queued-first",
        correlationRef: "correlation:queued-first",
        actorContextRef: contextRef,
        localSessionRef: "local-session:queued-revocation",
        externalSessionRef
      })
    });
    await expect.poll(() => brokerCalls).toBe(before + 1);
    const queued = app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:queued-revoked",
        correlationRef: "correlation:queued-revoked",
        actorContextRef: contextRef,
        localSessionRef: "local-session:queued-revocation",
        externalSessionRef
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare(
      `UPDATE federation_services
       SET status = 'revoked', revoked_at = ? WHERE service_ref = ?`
    ).run(now.toISOString(), "service:canvas");

    expect((await first).statusCode).toBe(200);
    const rejected = await queued;
    expect(rejected.statusCode).toBe(401);
    expect(brokerCalls).toBe(before + 1);
    expect(db.prepare(
      "SELECT 1 FROM agent_invocation_audit WHERE invocation_ref = ?"
    ).get("invocation:queued-revoked")).toBeUndefined();
  });

  it("invalidates contexts for every live authority relation and assignment-version drift", async () => {
    const refs = db.prepare(
      `SELECT es.entry_session_ref, eb.entry_binding_ref, eb.device_ref,
              db.device_binding_ref
       FROM entry_sessions es
       JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
       JOIN device_bindings db ON db.device_ref = eb.device_ref
       WHERE es.entry_session_ref = ?`
    ).get(admin.entrySessionRef) as {
      entry_session_ref: string;
      entry_binding_ref: string;
      device_ref: string;
      device_binding_ref: string;
    };
    const cases = [
      ["entry_sessions", "entry_session_ref", refs.entry_session_ref, "status", "revoked", "active"],
      ["entry_bindings", "entry_binding_ref", refs.entry_binding_ref, "status", "revoked", "active"],
      ["managed_devices", "device_ref", refs.device_ref, "status", "revoked", "active"],
      ["device_bindings", "device_binding_ref", refs.device_binding_ref, "status", "revoked", "active"],
      ["family_memberships", "person_ref", ownerPersonRef, "status", "inactive", "active"],
      ["persons", "person_ref", ownerPersonRef, "status", "suspended", "active"],
      ["families", "family_ref", familyRef, "status", "archived", "active"]
    ] as const;
    for (const [table, key, value, column, inactive, active] of cases) {
      const contextRef = await actorRef("canvas", admin);
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(inactive, value);
      const before = brokerCalls;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/federation/invocations",
        headers: serviceHeaders(CANVAS_TOKEN),
        payload: invocation({
          invocationRef: `invocation:invalid-${table.replaceAll("_", "-")}`,
          correlationRef: `correlation:invalid-${table.replaceAll("_", "-")}`,
          actorContextRef: contextRef,
          localSessionRef: `local-session:invalid-${table.replaceAll("_", "-")}`
        })
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(brokerCalls).toBe(before);
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(active, value);
    }

    const allocationContext = await actorRef("canvas", admin);
    new AgentManagementRepository(db, () => now).unmountMemberAgent({
      familyRef,
      personRef: ownerPersonRef,
      agentRef: "agent:hermes-zzh"
    });
    const beforeAllocationChange = brokerCalls;
    const allocationChanged = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:allocation-version-changed",
        correlationRef: "correlation:allocation-version-changed",
        actorContextRef: allocationContext,
        localSessionRef: "local-session:allocation-version-changed"
      })
    });
    expect(allocationChanged.statusCode).toBe(403);
    expect(brokerCalls).toBe(beforeAllocationChange);

    const stale = await actorRef("canvas", admin);
    db.prepare(
      `UPDATE person_agent_assignment_versions
       SET assignment_version = assignment_version + 1, updated_at = ?
       WHERE person_ref = ?`
    ).run(now.toISOString(), ownerPersonRef);
    const before = brokerCalls;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:stale-version",
        correlationRef: "correlation:stale-version",
        actorContextRef: stale,
        localSessionRef: "local-session:stale-version"
      })
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(brokerCalls).toBe(before);
  });

  it("serializes concurrent first calls, completes audits once, and persists no content or secrets", async () => {
    const contextRef = await actorRef("canvas", admin);
    brokerDelayMs = 30;
    const payload = (suffix: string) => invocation({
      invocationRef: `invocation:concurrent-${suffix}`,
      correlationRef: `correlation:concurrent-${suffix}`,
      actorContextRef: contextRef,
      localSessionRef: "local-session:concurrent"
    });
    const before = brokerCalls;
    const [left, right] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/federation/invocations",
        headers: serviceHeaders(CANVAS_TOKEN),
        payload: payload("left")
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/federation/invocations",
        headers: serviceHeaders(CANVAS_TOKEN),
        payload: payload("right")
      })
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    expect(brokerCalls - before).toBe(1);

    const duplicateBefore = brokerCalls;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: payload("left")
    });
    expect(duplicate.statusCode).toBeGreaterThanOrEqual(400);
    expect(brokerCalls).toBe(duplicateBefore);

    const persisted = [
      "agent_invocation_audit",
      "federation_session_bindings"
    ].flatMap((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const serialized = JSON.stringify(persisted);
    for (const secret of [
      PRIVATE_PROMPT,
      PRIVATE_OUTPUT,
      CANVAS_TOKEN,
      ME_TOKEN,
      admin.token,
      "family_ai_web_entry_token",
      PRIVATE_BROKER_ERROR
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(db.prepare(
      `SELECT status, COUNT(*) AS count
       FROM agent_invocation_audit
       GROUP BY status`
    ).all()).not.toContainEqual({ status: "accepted", count: 1 });
  });

  it("sanitizes raw Broker failures and service Bearer cannot mutate admin allocation", async () => {
    const beforeAssignments = db.prepare(
      `SELECT assignment_ref, status, is_default
       FROM assistant_assignments ORDER BY assignment_ref`
    ).all();
    const allocationRequests = [
      { method: "GET", url: "/api/v1/admin/agents" },
      {
        method: "GET",
        url: `/api/v1/admin/members/${encodeURIComponent(memberPersonRef)}/agent-mounts`
      },
      {
        method: "POST",
        url: `/api/v1/admin/members/${encodeURIComponent(memberPersonRef)}/agent-mounts`,
        payload: { agentRef: "agent:hermes-zzh" }
      },
      {
        method: "DELETE",
        url: `/api/v1/admin/members/${encodeURIComponent(memberPersonRef)}/agent-mounts/agent%3Ahermes-nsy`
      },
      {
        method: "PUT",
        url: `/api/v1/admin/members/${encodeURIComponent(memberPersonRef)}/default-agent`,
        payload: { agentRef: "agent:hermes-nsy" }
      }
    ];
    for (const request of allocationRequests) {
      const denied = await app.inject({
        ...request,
        headers: serviceHeaders(CANVAS_TOKEN, admin)
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(db.prepare(
      `SELECT assignment_ref, status, is_default
       FROM assistant_assignments ORDER BY assignment_ref`
    ).all()).toEqual(beforeAssignments);

    const contextRef = await actorRef("canvas", admin);
    brokerFailure = true;
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/federation/invocations",
      headers: serviceHeaders(CANVAS_TOKEN),
      payload: invocation({
        invocationRef: "invocation:broker-failure",
        correlationRef: "correlation:broker-failure",
        actorContextRef: contextRef,
        localSessionRef: "local-session:broker-failure"
      })
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(failed.body).not.toContain(PRIVATE_BROKER_ERROR);
    expect(failed.body).not.toMatch(/\/home\/private|provider-profile|stack/i);
    expect(failed.headers["set-cookie"]).toBeUndefined();
    expect(db.prepare(
      "SELECT status, error_code FROM agent_invocation_audit WHERE invocation_ref = ?"
    ).get("invocation:broker-failure")).toEqual({
      status: "failed",
      error_code: "AGENT_RUNTIME_UNAVAILABLE"
    });
  });
});
