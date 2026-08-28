import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  FederationActorContextV1,
  ProductId
} from "@family-ai/contracts";
import type { GatewayDatabase } from "./database.js";

export type FederationServiceProduct = Exclude<ProductId, "family">;
export type DiscoveryKind =
  | "agent"
  | "harness"
  | "provider"
  | "tool-gateway"
  | "terminal";
export type DiscoveryStatus = "available" | "unavailable" | "disabled";
export type InvocationAuditStatus = "accepted" | "succeeded" | "failed";

export interface AuthenticatedFederationService {
  serviceRef: string;
  product: FederationServiceProduct;
}

export interface AgentDiscoveryObservation {
  agentRef: string;
  kind: DiscoveryKind;
  runtime: string;
  status: DiscoveryStatus;
  capabilities: string[];
  observedAt: string;
}

export interface InvocationAuditRecord {
  invocationRef: string;
  correlationRef: string;
  product: ProductId;
  personRef: string;
  agentRef: string;
  localSessionRef: string;
  status: InvocationAuditStatus;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface FederationSessionBinding {
  product: FederationServiceProduct;
  familyRef: string;
  personRef: string;
  agentRef: string;
  localSessionRef: string;
  externalSessionRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorizedFederationAgent {
  agentRef: string;
  displayName: string;
  providerProfileRef: string;
  system: boolean;
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9._:-]{0,99}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const PRODUCT_IDS = new Set<ProductId>(["family", "canvas", "me"]);
const SERVICE_PRODUCTS = new Set<FederationServiceProduct>(["canvas", "me"]);
const DISCOVERY_KINDS = new Set<DiscoveryKind>([
  "agent",
  "harness",
  "provider",
  "tool-gateway",
  "terminal"
]);
const DISCOVERY_STATUSES = new Set<DiscoveryStatus>([
  "available",
  "unavailable",
  "disabled"
]);
const FEDERATION_AGENT_PROFILES = new Map<string, string>([
  ["agent:hermes-jarvis", "provider-profile:broker-jarvis"],
  ["agent:hermes-zzh", "provider-profile:broker-zzh"],
  ["agent:hermes-nsy", "provider-profile:broker-nsy"]
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function hasRefPrefix(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}:[a-z0-9][a-z0-9._:-]{1,126}$`).test(value);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseCapabilities(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 100 ||
    parsed.some((capability) =>
      typeof capability !== "string" || !SAFE_IDENTIFIER.test(capability)
    )
  ) {
    throw new Error("FEDERATION_DISCOVERY_INVALID");
  }
  return parsed;
}

function mapObservation(row: Record<string, unknown>): AgentDiscoveryObservation {
  return {
    agentRef: String(row.agent_ref),
    kind: row.kind as DiscoveryKind,
    runtime: String(row.runtime),
    status: row.status as DiscoveryStatus,
    capabilities: parseCapabilities(row.capabilities_json),
    observedAt: String(row.observed_at)
  };
}

function mapAudit(row: Record<string, unknown>): InvocationAuditRecord {
  return {
    invocationRef: String(row.invocation_ref),
    correlationRef: String(row.correlation_ref),
    product: row.product as ProductId,
    personRef: String(row.person_ref),
    agentRef: String(row.agent_ref),
    localSessionRef: String(row.local_session_ref),
    status: row.status as InvocationAuditStatus,
    errorCode: row.error_code === null ? null : String(row.error_code),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at)
  };
}

function mapSessionBinding(row: Record<string, unknown>): FederationSessionBinding {
  return {
    product: row.product as FederationServiceProduct,
    familyRef: String(row.family_ref),
    personRef: String(row.person_ref),
    agentRef: String(row.agent_ref),
    localSessionRef: String(row.local_session_ref),
    externalSessionRef: String(row.external_session_ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

type LiveActorRow = Record<string, unknown> & {
  audience: "family_admin" | "personal";
  family_role: string;
  assignment_version: number;
};

export class FederationRepository {
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly db: GatewayDatabase,
    options: {
      now?: () => Date;
      uuid?: () => string;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  provisionService(input: {
    serviceRef: string;
    product: FederationServiceProduct;
    token: string;
  }): void {
    if (
      !hasRefPrefix(input.serviceRef, "service") ||
      !SERVICE_PRODUCTS.has(input.product) ||
      input.token.length < 16 ||
      input.token.length > 4096
    ) {
      throw new Error("FEDERATION_SERVICE_INVALID");
    }
    const tokenHash = sha256(input.token);
    this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT service_ref, product, token_hash
         FROM federation_services
         WHERE service_ref = ? OR token_hash = ?`
      ).get(input.serviceRef, tokenHash) as Record<string, unknown> | undefined;
      if (existing) {
        if (
          String(existing.service_ref) !== input.serviceRef ||
          existing.product !== input.product ||
          !hashesEqual(String(existing.token_hash), tokenHash)
        ) {
          throw new Error("FEDERATION_SERVICE_CONFLICT");
        }
        return;
      }
      this.db.prepare(
        `INSERT INTO federation_services(
           service_ref, product, token_hash, status, created_at, revoked_at
         ) VALUES(?, ?, ?, 'active', ?, NULL)`
      ).run(input.serviceRef, input.product, tokenHash, this.now().toISOString());
    }).immediate();
  }

  authenticateService(token: string): AuthenticatedFederationService | null {
    if (token.length < 1 || token.length > 4096) return null;
    const tokenHash = sha256(token);
    const row = this.db.prepare(
      `SELECT service_ref, product, token_hash
       FROM federation_services
       WHERE token_hash = ? AND status = 'active'`
    ).get(tokenHash) as Record<string, unknown> | undefined;
    if (!row || !hashesEqual(String(row.token_hash), tokenHash)) return null;
    return {
      serviceRef: String(row.service_ref),
      product: row.product as FederationServiceProduct
    };
  }

  revokeService(serviceRef: string): boolean {
    if (!hasRefPrefix(serviceRef, "service")) {
      throw new Error("FEDERATION_SERVICE_INVALID");
    }
    const result = this.db.prepare(
      `UPDATE federation_services
       SET status = 'revoked', revoked_at = ?
       WHERE service_ref = ? AND status = 'active'`
    ).run(this.now().toISOString(), serviceRef);
    return result.changes === 1;
  }

  recordDiscoveryObservation(input: {
    agentRef: string;
    kind: DiscoveryKind;
    runtime: string;
    status: DiscoveryStatus;
    capabilities: readonly string[];
    observedAt: string;
  }): AgentDiscoveryObservation {
    if (
      !hasRefPrefix(input.agentRef, "agent") ||
      !DISCOVERY_KINDS.has(input.kind) ||
      !SAFE_IDENTIFIER.test(input.runtime) ||
      !DISCOVERY_STATUSES.has(input.status) ||
      !validTimestamp(input.observedAt) ||
      input.capabilities.length < 1 ||
      input.capabilities.length > 100 ||
      input.capabilities.some((capability) => !SAFE_IDENTIFIER.test(capability))
    ) {
      throw new Error("FEDERATION_DISCOVERY_INVALID");
    }
    const capabilitiesJson = JSON.stringify([...input.capabilities]);
    this.db.prepare(
      `INSERT INTO agent_discovery_observations(
         agent_ref, kind, runtime, status, capabilities_json, observed_at
       ) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_ref) DO UPDATE SET
         kind = excluded.kind,
         runtime = excluded.runtime,
         status = excluded.status,
         capabilities_json = excluded.capabilities_json,
         observed_at = excluded.observed_at`
    ).run(
      input.agentRef,
      input.kind,
      input.runtime,
      input.status,
      capabilitiesJson,
      input.observedAt
    );
    return this.getDiscoveryObservation(input.agentRef)!;
  }

  getDiscoveryObservation(agentRef: string): AgentDiscoveryObservation | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_discovery_observations WHERE agent_ref = ?"
    ).get(agentRef) as Record<string, unknown> | undefined;
    return row ? mapObservation(row) : null;
  }

  listDiscoveryObservations(): AgentDiscoveryObservation[] {
    return (this.db.prepare(
      "SELECT * FROM agent_discovery_observations ORDER BY agent_ref"
    ).all() as Array<Record<string, unknown>>).map(mapObservation);
  }

  issueActorContext(input: {
    product: ProductId;
    entrySessionRef: string;
    lifetimeSeconds?: number;
  }): FederationActorContextV1 {
    const lifetimeSeconds = input.lifetimeSeconds ?? 60;
    if (
      !PRODUCT_IDS.has(input.product) ||
      !hasRefPrefix(input.entrySessionRef, "entry-session") ||
      !Number.isInteger(lifetimeSeconds) ||
      lifetimeSeconds < 1 ||
      lifetimeSeconds > 60
    ) {
      throw new Error("FEDERATION_CONTEXT_TTL_INVALID");
    }
    const issue = this.db.transaction(() => {
      const createdAt = this.now();
      const row = this.findLiveActor(input.entrySessionRef, createdAt.toISOString());
      if (!row) throw new Error("FEDERATION_ENTRY_INACTIVE");
      const assignmentVersion = Number(row.assignment_version);
      if (!Number.isSafeInteger(assignmentVersion) || assignmentVersion < 1) {
        throw new Error("FEDERATION_ASSIGNMENT_VERSION_UNAVAILABLE");
      }
      const contextRef = `actor-context:${this.uuid()}`;
      if (!hasRefPrefix(contextRef, "actor-context")) {
        throw new Error("FEDERATION_CONTEXT_REF_INVALID");
      }
      const expiresAt = new Date(
        createdAt.getTime() + lifetimeSeconds * 1_000
      ).toISOString();
      this.db.prepare(
        `INSERT INTO federation_actor_contexts(
           context_ref, product, family_ref, person_ref, device_ref,
           entry_session_ref, assignment_version, expires_at, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        contextRef,
        input.product,
        String(row.family_ref),
        String(row.person_ref),
        String(row.device_ref),
        input.entrySessionRef,
        assignmentVersion,
        expiresAt,
        createdAt.toISOString()
      );
      return this.mapActorContext({
        ...row,
        context_ref: contextRef,
        product: input.product,
        entry_session_ref: input.entrySessionRef,
        assignment_version: assignmentVersion,
        expires_at: expiresAt
      });
    });
    return issue.immediate();
  }

  getActorContext(contextRef: string): FederationActorContextV1 | null {
    if (!hasRefPrefix(contextRef, "actor-context")) return null;
    const now = this.now().toISOString();
    const row = this.db.prepare(
      `SELECT fac.*, eb.audience, fm.family_role,
              pes.last_sequence AS current_assignment_version
       FROM federation_actor_contexts fac
       JOIN entry_sessions es
         ON es.entry_session_ref = fac.entry_session_ref
        AND es.status = 'active'
        AND es.expires_at > ?
       JOIN entry_bindings eb
         ON eb.entry_binding_ref = es.entry_binding_ref
        AND eb.status = 'active'
        AND eb.family_ref = fac.family_ref
        AND eb.person_ref = fac.person_ref
        AND eb.device_ref = fac.device_ref
       JOIN families f
         ON f.family_ref = fac.family_ref AND f.status = 'active'
       JOIN persons p
         ON p.person_ref = fac.person_ref AND p.status = 'active'
       JOIN family_memberships fm
         ON fm.family_ref = fac.family_ref
        AND fm.person_ref = fac.person_ref
        AND fm.status = 'active'
       JOIN managed_devices d
         ON d.device_ref = fac.device_ref AND d.status = 'active'
       JOIN device_bindings db
         ON db.device_ref = fac.device_ref
        AND db.family_ref = fac.family_ref
        AND db.person_ref = fac.person_ref
        AND db.owner_scope = 'person'
        AND db.status = 'active'
       JOIN person_event_sequences pes
         ON pes.person_ref = fac.person_ref
       WHERE fac.context_ref = ?
         AND fac.expires_at > ?
         AND pes.last_sequence = fac.assignment_version`
    ).get(now, contextRef, now) as LiveActorRow | undefined;
    return row ? this.mapActorContext(row) : null;
  }

  listAuthorizedAgents(
    actor: FederationActorContextV1
  ): AuthorizedFederationAgent[] {
    const rows = this.db.prepare(
      `SELECT a.agent_ref, a.display_name, rb.provider_profile_ref,
              CASE WHEN a.agent_ref = 'agent:hermes-jarvis' THEN 1 ELSE 0 END AS system
       FROM agents a
       JOIN agent_runtime_bindings rb
         ON rb.agent_ref = a.agent_ref AND rb.status = 'active'
       WHERE (
         a.agent_ref = 'agent:hermes-jarvis'
         AND ? = 1
       ) OR EXISTS (
         SELECT 1 FROM assistant_assignments aa
         WHERE aa.person_ref = ?
           AND aa.agent_ref = a.agent_ref
           AND aa.provider_profile_ref = rb.provider_profile_ref
           AND aa.status = 'active'
           AND aa.agent_ref IN ('agent:hermes-zzh', 'agent:hermes-nsy')
       )
       ORDER BY a.agent_ref`
    ).all(
      actor.roles.includes("family_admin") ? 1 : 0,
      actor.personRef
    ) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const agentRef = String(row.agent_ref);
      const providerProfileRef = String(row.provider_profile_ref);
      if (FEDERATION_AGENT_PROFILES.get(agentRef) !== providerProfileRef) {
        return [];
      }
      return [{
        agentRef,
        displayName: String(row.display_name),
        providerProfileRef,
        system: Number(row.system) === 1
      }];
    });
  }

  requireAuthorizedAgent(
    actor: FederationActorContextV1,
    agentRef: string
  ): AuthorizedFederationAgent {
    const authorized = this.listAuthorizedAgents(actor).find(
      (candidate) => candidate.agentRef === agentRef
    );
    if (!authorized) throw new Error("FEDERATION_AGENT_FORBIDDEN");
    return authorized;
  }

  validateExternalSessionBinding(input: {
    product: FederationServiceProduct;
    familyRef: string;
    personRef: string;
    agentRef: string;
    localSessionRef: string;
    externalSessionRef?: string;
  }): FederationSessionBinding | null {
    this.validateSessionBindingInput(input);
    const exact = this.db.prepare(
      `SELECT * FROM federation_session_bindings
       WHERE product = ? AND family_ref = ? AND person_ref = ?
         AND agent_ref = ? AND local_session_ref = ?`
    ).get(
      input.product,
      input.familyRef,
      input.personRef,
      input.agentRef,
      input.localSessionRef
    ) as Record<string, unknown> | undefined;
    if (exact) {
      const binding = mapSessionBinding(exact);
      if (input.externalSessionRef === undefined) {
        throw new Error("FEDERATION_SESSION_REQUIRED");
      }
      if (input.externalSessionRef !== binding.externalSessionRef) {
        throw new Error("FEDERATION_SESSION_MISMATCH");
      }
      return binding;
    }
    if (input.externalSessionRef !== undefined) {
      const occupied = this.db.prepare(
        `SELECT 1 FROM federation_session_bindings
         WHERE external_session_ref = ?`
      ).get(input.externalSessionRef);
      if (occupied) throw new Error("FEDERATION_SESSION_SCOPE_CONFLICT");
    }
    return null;
  }

  bindExternalSession(input: {
    product: FederationServiceProduct;
    familyRef: string;
    personRef: string;
    agentRef: string;
    localSessionRef: string;
    externalSessionRef: string;
  }): FederationSessionBinding {
    const bind = this.db.transaction(() => {
      const existing = this.validateExternalSessionBinding(input);
      if (existing) return existing;
      const timestamp = this.now().toISOString();
      this.db.prepare(
        `INSERT INTO federation_session_bindings(
           product, family_ref, person_ref, agent_ref, local_session_ref,
           external_session_ref, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.product,
        input.familyRef,
        input.personRef,
        input.agentRef,
        input.localSessionRef,
        input.externalSessionRef,
        timestamp,
        timestamp
      );
      return mapSessionBinding(this.db.prepare(
        `SELECT * FROM federation_session_bindings
         WHERE product = ? AND family_ref = ? AND person_ref = ?
           AND agent_ref = ? AND local_session_ref = ?`
      ).get(
        input.product,
        input.familyRef,
        input.personRef,
        input.agentRef,
        input.localSessionRef
      ) as Record<string, unknown>);
    });
    return bind.immediate();
  }

  acceptInvocation(input: {
    invocationRef: string;
    correlationRef: string;
    product: ProductId;
    personRef: string;
    agentRef: string;
    localSessionRef: string;
  }): InvocationAuditRecord {
    if (
      !hasRefPrefix(input.invocationRef, "invocation") ||
      !hasRefPrefix(input.correlationRef, "correlation") ||
      !PRODUCT_IDS.has(input.product) ||
      !hasRefPrefix(input.personRef, "person") ||
      !hasRefPrefix(input.agentRef, "agent") ||
      !hasRefPrefix(input.localSessionRef, "local-session")
    ) {
      throw new Error("FEDERATION_AUDIT_INVALID");
    }
    const accept = this.db.transaction(() => {
      const duplicate = this.db.prepare(
        "SELECT 1 FROM agent_invocation_audit WHERE invocation_ref = ?"
      ).get(input.invocationRef);
      if (duplicate) throw new Error("FEDERATION_INVOCATION_DUPLICATE");
      const subject = this.db.prepare(
        `SELECT 1
         FROM persons p, agents a
         WHERE p.person_ref = ? AND p.status = 'active' AND a.agent_ref = ?`
      ).get(input.personRef, input.agentRef);
      if (!subject) throw new Error("FEDERATION_AUDIT_SUBJECT_INVALID");
      this.db.prepare(
        `INSERT INTO agent_invocation_audit(
           invocation_ref, correlation_ref, product, person_ref, agent_ref,
           local_session_ref, status, error_code, started_at, completed_at
         ) VALUES(?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, NULL)`
      ).run(
        input.invocationRef,
        input.correlationRef,
        input.product,
        input.personRef,
        input.agentRef,
        input.localSessionRef,
        this.now().toISOString()
      );
      return this.getInvocationAudit(input.invocationRef)!;
    });
    return accept.immediate();
  }

  completeInvocation(input: {
    invocationRef: string;
    status: "succeeded" | "failed";
    errorCode?: string;
  }): InvocationAuditRecord {
    if (
      !hasRefPrefix(input.invocationRef, "invocation") ||
      (input.status !== "succeeded" && input.status !== "failed") ||
      (input.status === "succeeded" && input.errorCode !== undefined) ||
      (input.status === "failed" &&
        (input.errorCode === undefined || !SAFE_ERROR_CODE.test(input.errorCode)))
    ) {
      throw new Error("FEDERATION_AUDIT_INVALID_TRANSITION");
    }
    const result = this.db.prepare(
      `UPDATE agent_invocation_audit
       SET status = ?, error_code = ?, completed_at = ?
       WHERE invocation_ref = ? AND status = 'accepted'`
    ).run(
      input.status,
      input.errorCode ?? null,
      this.now().toISOString(),
      input.invocationRef
    );
    if (result.changes !== 1) {
      throw new Error("FEDERATION_AUDIT_INVALID_TRANSITION");
    }
    return this.getInvocationAudit(input.invocationRef)!;
  }

  getInvocationAudit(invocationRef: string): InvocationAuditRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_invocation_audit WHERE invocation_ref = ?"
    ).get(invocationRef) as Record<string, unknown> | undefined;
    return row ? mapAudit(row) : null;
  }

  private findLiveActor(entrySessionRef: string, now: string): LiveActorRow | null {
    const row = this.db.prepare(
      `SELECT eb.family_ref, eb.person_ref, eb.device_ref, eb.audience,
              fm.family_role, pes.last_sequence AS assignment_version
       FROM entry_sessions es
       JOIN entry_bindings eb
         ON eb.entry_binding_ref = es.entry_binding_ref AND eb.status = 'active'
       JOIN families f
         ON f.family_ref = eb.family_ref AND f.status = 'active'
       JOIN persons p
         ON p.person_ref = eb.person_ref AND p.status = 'active'
       JOIN family_memberships fm
         ON fm.family_ref = eb.family_ref
        AND fm.person_ref = eb.person_ref
        AND fm.status = 'active'
       JOIN managed_devices d
         ON d.device_ref = eb.device_ref AND d.status = 'active'
       JOIN device_bindings db
         ON db.device_ref = eb.device_ref
        AND db.family_ref = eb.family_ref
        AND db.person_ref = eb.person_ref
        AND db.owner_scope = 'person'
        AND db.status = 'active'
       LEFT JOIN person_event_sequences pes
         ON pes.person_ref = eb.person_ref
       WHERE es.entry_session_ref = ?
         AND es.status = 'active'
         AND es.expires_at > ?`
    ).get(entrySessionRef, now) as LiveActorRow | undefined;
    return row ?? null;
  }

  private validateSessionBindingInput(input: {
    product: FederationServiceProduct;
    familyRef: string;
    personRef: string;
    agentRef: string;
    localSessionRef: string;
    externalSessionRef?: string;
  }): void {
    if (
      !SERVICE_PRODUCTS.has(input.product) ||
      !hasRefPrefix(input.familyRef, "family") ||
      !hasRefPrefix(input.personRef, "person") ||
      !hasRefPrefix(input.agentRef, "agent") ||
      !hasRefPrefix(input.localSessionRef, "local-session") ||
      (input.externalSessionRef !== undefined &&
        !hasRefPrefix(input.externalSessionRef, "external-session"))
    ) {
      throw new Error("FEDERATION_SESSION_INVALID");
    }
  }

  private mapActorContext(row: LiveActorRow): FederationActorContextV1 {
    const roles = [String(row.family_role)];
    if (row.audience === "family_admin") roles.push("family_admin");
    return {
      protocolVersion: 1,
      contextRef: String(row.context_ref),
      product: row.product as ProductId,
      familyRef: String(row.family_ref),
      personRef: String(row.person_ref),
      deviceRef: String(row.device_ref),
      entrySessionRef: String(row.entry_session_ref),
      roles,
      assignmentVersion: Number(row.assignment_version),
      expiresAt: String(row.expires_at)
    };
  }
}
