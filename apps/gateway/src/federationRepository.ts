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
