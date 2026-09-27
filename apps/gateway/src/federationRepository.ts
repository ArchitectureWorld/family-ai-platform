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
  requestSha256: string | null;
  serviceRef: string | null;
  familyRef: string | null;
  actorContextRef: string | null;
  requestedExternalSessionRef: string | null;
  timeoutMs: number | null;
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

export interface FederationInvocationClaim {
  product: FederationServiceProduct;
  familyRef: string;
  personRef: string;
  agentRef: string;
  localSessionRef: string;
  invocationRef: string;
  serviceRef: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

interface ScopedInvocationStatusBase {
  invocationRef: string;
  correlationRef: string;
  serviceRef: string;
  product: FederationServiceProduct;
  familyRef: string;
  personRef: string;
  agentRef: string;
  localSessionRef: string;
}

export type ScopedInvocationStatus =
  | (ScopedInvocationStatusBase & {
      status: "accepted";
      leaseExpiresAt: string;
      retryAfter: number;
    })
  | (ScopedInvocationStatusBase & {
      status: "succeeded";
      externalSessionRef: string;
      completedAt: string;
      outputAvailable: false;
    })
  | (ScopedInvocationStatusBase & {
      status: "failed";
      completedAt: string;
      errorCode: string;
    });

export type ClaimInvocationResult =
  | { kind: "acquired"; claim: FederationInvocationClaim }
  | { kind: "accepted"; status: Extract<ScopedInvocationStatus, { status: "accepted" }> }
  | { kind: "succeeded"; status: Extract<ScopedInvocationStatus, { status: "succeeded" }> }
  | { kind: "failed"; status: Extract<ScopedInvocationStatus, { status: "failed" }> };

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
const INVOCATION_CLEANUP_GRACE_MS = 30_000;

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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
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
    requestSha256: row.request_sha256 === null || row.request_sha256 === undefined
      ? null
      : String(row.request_sha256),
    serviceRef: row.service_ref === null || row.service_ref === undefined
      ? null
      : String(row.service_ref),
    familyRef: row.family_ref === null || row.family_ref === undefined
      ? null
      : String(row.family_ref),
    actorContextRef: row.actor_context_ref === null || row.actor_context_ref === undefined
      ? null
      : String(row.actor_context_ref),
    requestedExternalSessionRef:
      row.requested_external_session_ref === null
        || row.requested_external_session_ref === undefined
        ? null
        : String(row.requested_external_session_ref),
    timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined
      ? null
      : Number(row.timeout_ms),
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

function mapInvocationClaim(row: Record<string, unknown>): FederationInvocationClaim {
  return {
    product: row.product as FederationServiceProduct,
    familyRef: String(row.family_ref),
    personRef: String(row.person_ref),
    agentRef: String(row.agent_ref),
    localSessionRef: String(row.local_session_ref),
    invocationRef: String(row.invocation_ref),
    serviceRef: String(row.service_ref),
    claimedAt: String(row.claimed_at),
    leaseExpiresAt: String(row.lease_expires_at)
  };
}

type LiveActorRow = Record<string, unknown> & {
  audience?: "family_admin" | "personal";
  family_role?: string;
  assignment_version: number;
  context_version: number;
};

const CANONICAL_FEDERATION_ROLES = new Set([
  '["owner"]', '["owner","family_admin"]',
  '["adult"]', '["adult","family_admin"]',
  '["child"]', '["child","family_admin"]',
  '["elder"]', '["elder","family_admin"]'
]);

function projectionDisplayName(value: unknown): string {
  const name = String(value);
  if (
    name.length < 1 ||
    name.length > 80 ||
    name !== name.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
    /[\uD800-\uDFFF]/u.test(name)
  ) {
    throw new Error("FEDERATION_IDENTITY_PROJECTION_INVALID");
  }
  return name;
}

function projectionRoles(row: LiveActorRow): readonly string[] {
  if (typeof row.roles_json === "string") {
    if (!CANONICAL_FEDERATION_ROLES.has(row.roles_json)) {
      throw new Error("FEDERATION_IDENTITY_PROJECTION_INVALID");
    }
    return JSON.parse(row.roles_json) as string[];
  }
  if (
    typeof row.family_role !== "string" ||
    (row.audience !== "family_admin" && row.audience !== "personal")
  ) {
    throw new Error("FEDERATION_IDENTITY_PROJECTION_INVALID");
  }
  return row.audience === "family_admin"
    ? [row.family_role, "family_admin"]
    : [row.family_role];
}

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

  requireActiveService(
    service: AuthenticatedFederationService
  ): AuthenticatedFederationService {
    if (
      !hasRefPrefix(service.serviceRef, "service") ||
      !SERVICE_PRODUCTS.has(service.product)
    ) {
      throw new Error("FEDERATION_SERVICE_INACTIVE");
    }
    const row = this.db.prepare(
      `SELECT service_ref, product FROM federation_services
       WHERE service_ref = ? AND product = ? AND status = 'active'`
    ).get(service.serviceRef, service.product) as
      | { service_ref: string; product: FederationServiceProduct }
      | undefined;
    if (!row) throw new Error("FEDERATION_SERVICE_INACTIVE");
    return { serviceRef: row.service_ref, product: row.product };
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
    service: AuthenticatedFederationService;
    entrySessionRef: string;
    lifetimeSeconds?: number;
  }): FederationActorContextV1 {
    const lifetimeSeconds = input.lifetimeSeconds ?? 60;
    if (
      !hasRefPrefix(input.service.serviceRef, "service") ||
      !SERVICE_PRODUCTS.has(input.service.product) ||
      !hasRefPrefix(input.entrySessionRef, "entry-session") ||
      !Number.isInteger(lifetimeSeconds) ||
      lifetimeSeconds < 1 ||
      lifetimeSeconds > 60
    ) {
      throw new Error("FEDERATION_CONTEXT_TTL_INVALID");
    }
    const issue = this.db.transaction(() => {
      const createdAt = this.now();
      const service = this.requireActiveService(input.service);
      this.ensureAssignmentVersion(
        input.entrySessionRef,
        createdAt.toISOString()
      );
      const row = this.findLiveActor(input.entrySessionRef, createdAt.toISOString());
      if (!row) throw new Error("FEDERATION_ENTRY_INACTIVE");
      const assignmentVersion = Number(row.assignment_version);
      if (!Number.isSafeInteger(assignmentVersion) || assignmentVersion < 1) {
        throw new Error("FEDERATION_ASSIGNMENT_VERSION_UNAVAILABLE");
      }
      const contextVersion = Number(row.context_version);
      if (!Number.isSafeInteger(contextVersion) || contextVersion < 1) {
        throw new Error("FEDERATION_CONTEXT_VERSION_UNAVAILABLE");
      }
      const personDisplayName = projectionDisplayName(row.person_display_name);
      const familyDisplayName = projectionDisplayName(row.family_display_name);
      const roles = projectionRoles(row);
      const rolesJson = JSON.stringify(roles);
      const capturedNow = createdAt.toISOString();
      this.db.prepare(
        `DELETE FROM federation_actor_contexts
         WHERE context_ref IN (
           SELECT context_ref FROM federation_actor_contexts
           WHERE expires_at <= ?
           ORDER BY expires_at, context_ref
           LIMIT 256
         )`
      ).run(capturedNow);
      const reuseFloorMs = Math.min(15_000, lifetimeSeconds * 250);
      const reuseCutoff = new Date(
        createdAt.getTime() + reuseFloorMs
      ).toISOString();
      const reusable = this.db.prepare(
        `SELECT * FROM federation_actor_contexts
         WHERE service_ref = ?
           AND product = ?
           AND entry_session_ref = ?
           AND family_ref = ?
           AND person_ref = ?
           AND device_ref = ?
           AND assignment_version = ?
           AND context_version = ?
           AND person_display_name = ?
           AND family_display_name = ?
           AND roles_json = ?
           AND expires_at > ?
         ORDER BY expires_at DESC, context_ref ASC
         LIMIT 1`
      ).get(
        service.serviceRef,
        service.product,
        input.entrySessionRef,
        String(row.family_ref),
        String(row.person_ref),
        String(row.device_ref),
        assignmentVersion,
        contextVersion,
        personDisplayName,
        familyDisplayName,
        rolesJson,
        reuseCutoff
      ) as LiveActorRow | undefined;
      if (reusable) return this.mapActorContext(reusable);

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
           entry_session_ref, person_display_name, family_display_name,
           assignment_version, context_version, expires_at, created_at,
           service_ref, roles_json
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        contextRef,
        service.product,
        String(row.family_ref),
        String(row.person_ref),
        String(row.device_ref),
        input.entrySessionRef,
        personDisplayName,
        familyDisplayName,
        assignmentVersion,
        contextVersion,
        expiresAt,
        capturedNow,
        service.serviceRef,
        rolesJson
      );
      return this.mapActorContext({
        ...row,
        context_ref: contextRef,
        product: service.product,
        entry_session_ref: input.entrySessionRef,
        person_display_name: personDisplayName,
        family_display_name: familyDisplayName,
        assignment_version: assignmentVersion,
        context_version: contextVersion,
        expires_at: expiresAt,
        service_ref: service.serviceRef,
        roles_json: rolesJson
      });
    });
    return issue.immediate();
  }

  getActorContext(
    service: AuthenticatedFederationService,
    contextRef: string
  ): FederationActorContextV1 | null {
    const activeService = this.requireActiveService(service);
    if (!hasRefPrefix(contextRef, "actor-context")) return null;
    const now = this.now().toISOString();
    const row = this.db.prepare(
      `SELECT fac.*, eb.audience, fm.family_role,
              paav.assignment_version AS current_assignment_version,
              pvc.context_version AS current_context_version
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
       JOIN person_agent_assignment_versions paav
         ON paav.person_ref = fac.person_ref
       JOIN person_federation_context_versions pvc
         ON pvc.person_ref = fac.person_ref
       WHERE fac.context_ref = ?
         AND fac.service_ref = ?
         AND fac.product = ?
         AND fac.roles_json IS NOT NULL
         AND fac.expires_at > ?
         AND paav.assignment_version = fac.assignment_version
         AND pvc.context_version = fac.context_version`
    ).get(
      now,
      contextRef,
      activeService.serviceRef,
      activeService.product,
      now
    ) as LiveActorRow | undefined;
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
      throw new Error("FEDERATION_SESSION_UNBOUND");
    }
    return null;
  }

  claimInvocation(input: {
    serviceRef: string;
    product: FederationServiceProduct;
    familyRef: string;
    personRef: string;
    actorContextRef: string;
    agentRef: string;
    localSessionRef: string;
    externalSessionRef?: string;
    invocationRef: string;
    correlationRef: string;
    requestSha256: string;
    timeoutMs: number;
  }): ClaimInvocationResult {
    this.validateSessionBindingInput(input);
    if (
      !hasRefPrefix(input.serviceRef, "service") ||
      !hasRefPrefix(input.actorContextRef, "actor-context") ||
      !hasRefPrefix(input.invocationRef, "invocation") ||
      !hasRefPrefix(input.correlationRef, "correlation") ||
      !/^[a-f0-9]{64}$/.test(input.requestSha256) ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1_000 ||
      input.timeoutMs > 300_000
    ) {
      throw new Error("FEDERATION_CLAIM_INVALID");
    }
    const claim = this.db.transaction((): ClaimInvocationResult => {
      this.requireActiveService({
        serviceRef: input.serviceRef,
        product: input.product
      });
      const claimedAt = this.now();
      const claimedAtIso = claimedAt.toISOString();
      const existingAudit = this.db.prepare(
        "SELECT * FROM agent_invocation_audit WHERE invocation_ref = ?"
      ).get(input.invocationRef) as Record<string, unknown> | undefined;
      if (existingAudit) {
        const exact =
          existingAudit.request_sha256 === input.requestSha256 &&
          existingAudit.service_ref === input.serviceRef &&
          existingAudit.product === input.product &&
          existingAudit.family_ref === input.familyRef &&
          existingAudit.person_ref === input.personRef &&
          existingAudit.agent_ref === input.agentRef &&
          existingAudit.local_session_ref === input.localSessionRef &&
          existingAudit.correlation_ref === input.correlationRef &&
          existingAudit.requested_external_session_ref ===
            (input.externalSessionRef ?? null) &&
          Number(existingAudit.timeout_ms) === input.timeoutMs;
        if (!exact) throw new Error("FEDERATION_INVOCATION_DUPLICATE");
        const status = this.getScopedInvocationStatus(input);
        if (!status) throw new Error("FEDERATION_INVOCATION_DUPLICATE");
        if (status.status === "accepted") return { kind: "accepted", status };
        if (status.status === "succeeded") return { kind: "succeeded", status };
        return { kind: "failed", status };
      }
      this.validateExternalSessionBinding(input);
      const existingClaim = this.db.prepare(
        `SELECT * FROM federation_session_invocation_claims
         WHERE product = ? AND family_ref = ? AND person_ref = ?
           AND agent_ref = ? AND local_session_ref = ?`
      ).get(
        input.product,
        input.familyRef,
        input.personRef,
        input.agentRef,
        input.localSessionRef
      ) as Record<string, unknown> | undefined;
      if (existingClaim) {
        throw new Error("FEDERATION_INVOCATION_BUSY");
      }
      const subject = this.db.prepare(
        `SELECT 1 FROM persons p, agents a
         WHERE p.person_ref = ? AND p.status = 'active' AND a.agent_ref = ?`
      ).get(input.personRef, input.agentRef);
      if (!subject) throw new Error("FEDERATION_AUDIT_SUBJECT_INVALID");
      this.db.prepare(
        `INSERT INTO agent_invocation_audit(
           invocation_ref, correlation_ref, product, person_ref, agent_ref,
           local_session_ref, request_sha256, service_ref, family_ref,
           actor_context_ref, requested_external_session_ref, timeout_ms,
           status, error_code, started_at, completed_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, NULL)`
      ).run(
        input.invocationRef,
        input.correlationRef,
        input.product,
        input.personRef,
        input.agentRef,
        input.localSessionRef,
        input.requestSha256,
        input.serviceRef,
        input.familyRef,
        input.actorContextRef,
        input.externalSessionRef ?? null,
        input.timeoutMs,
        claimedAtIso
      );
      const leaseExpiresAt = new Date(
        claimedAt.getTime() + input.timeoutMs + INVOCATION_CLEANUP_GRACE_MS
      ).toISOString();
      this.db.prepare(
        `INSERT INTO federation_session_invocation_claims(
           product, family_ref, person_ref, agent_ref, local_session_ref,
           invocation_ref, service_ref, claimed_at, lease_expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.product,
        input.familyRef,
        input.personRef,
        input.agentRef,
        input.localSessionRef,
        input.invocationRef,
        input.serviceRef,
        claimedAtIso,
        leaseExpiresAt
      );
      return {
        kind: "acquired",
        claim: this.getInvocationClaim(input.invocationRef)!
      };
    });
    return claim.immediate();
  }

  getScopedInvocationStatus(input: {
    serviceRef: string;
    product: FederationServiceProduct;
    familyRef: string;
    personRef: string;
    agentRef: string;
    localSessionRef: string;
    invocationRef: string;
  }): ScopedInvocationStatus | null {
    if (
      !hasRefPrefix(input.serviceRef, "service") ||
      !SERVICE_PRODUCTS.has(input.product) ||
      !hasRefPrefix(input.familyRef, "family") ||
      !hasRefPrefix(input.personRef, "person") ||
      !hasRefPrefix(input.agentRef, "agent") ||
      !hasRefPrefix(input.localSessionRef, "local-session") ||
      !hasRefPrefix(input.invocationRef, "invocation")
    ) {
      return null;
    }
    const row = this.db.prepare(
      `SELECT audit.*, claim.lease_expires_at,
              binding.external_session_ref AS bound_external_session_ref
       FROM agent_invocation_audit audit
       LEFT JOIN federation_session_invocation_claims claim
         ON claim.invocation_ref = audit.invocation_ref
       LEFT JOIN federation_session_bindings binding
         ON binding.product = audit.product
        AND binding.family_ref = audit.family_ref
        AND binding.person_ref = audit.person_ref
        AND binding.agent_ref = audit.agent_ref
        AND binding.local_session_ref = audit.local_session_ref
       WHERE audit.invocation_ref = ?
         AND audit.service_ref = ?
         AND audit.product = ?
         AND audit.family_ref = ?
         AND audit.person_ref = ?
         AND audit.agent_ref = ?
         AND audit.local_session_ref = ?`
    ).get(
      input.invocationRef,
      input.serviceRef,
      input.product,
      input.familyRef,
      input.personRef,
      input.agentRef,
      input.localSessionRef
    ) as Record<string, unknown> | undefined;
    if (!row || row.request_sha256 === null) return null;
    const base: ScopedInvocationStatusBase = {
      invocationRef: String(row.invocation_ref),
      correlationRef: String(row.correlation_ref),
      serviceRef: String(row.service_ref),
      product: row.product as FederationServiceProduct,
      familyRef: String(row.family_ref),
      personRef: String(row.person_ref),
      agentRef: String(row.agent_ref),
      localSessionRef: String(row.local_session_ref)
    };
    if (row.status === "accepted") {
      const leaseExpiresAt = String(row.lease_expires_at ?? "");
      if (!validTimestamp(leaseExpiresAt)) throw new Error("FEDERATION_CLAIM_INVALID");
      return {
        ...base,
        status: "accepted",
        leaseExpiresAt,
        retryAfter: Math.max(
          1,
          Math.ceil((Date.parse(leaseExpiresAt) - this.now().getTime()) / 1_000)
        )
      };
    }
    const completedAt = String(row.completed_at ?? "");
    if (!validTimestamp(completedAt)) throw new Error("FEDERATION_AUDIT_INVALID_TRANSITION");
    if (row.status === "succeeded") {
      const externalSessionRef = String(row.bound_external_session_ref ?? "");
      if (!hasRefPrefix(externalSessionRef, "external-session")) {
        throw new Error("FEDERATION_SESSION_UNBOUND");
      }
      return {
        ...base,
        status: "succeeded",
        externalSessionRef,
        completedAt,
        outputAvailable: false
      };
    }
    const errorCode = String(row.error_code ?? "");
    if (row.status !== "failed" || !SAFE_ERROR_CODE.test(errorCode)) {
      throw new Error("FEDERATION_AUDIT_INVALID_TRANSITION");
    }
    return { ...base, status: "failed", completedAt, errorCode };
  }

  getInvocationClaim(invocationRef: string): FederationInvocationClaim | null {
    if (!hasRefPrefix(invocationRef, "invocation")) return null;
    const row = this.db.prepare(
      `SELECT * FROM federation_session_invocation_claims
       WHERE invocation_ref = ?`
    ).get(invocationRef) as Record<string, unknown> | undefined;
    return row ? mapInvocationClaim(row) : null;
  }

  finalizeInvocationSuccess(input: {
    invocationRef: string;
    externalSessionRef: string;
  }): InvocationAuditRecord {
    if (
      !hasRefPrefix(input.invocationRef, "invocation") ||
      !hasRefPrefix(input.externalSessionRef, "external-session")
    ) {
      throw new Error("FEDERATION_FINALIZE_INVALID");
    }
    const finalize = this.db.transaction(() => {
      const claim = this.requireInvocationClaim(input.invocationRef);
      const exact = this.db.prepare(
        `SELECT * FROM federation_session_bindings
         WHERE product = ? AND family_ref = ? AND person_ref = ?
           AND agent_ref = ? AND local_session_ref = ?`
      ).get(
        claim.product,
        claim.familyRef,
        claim.personRef,
        claim.agentRef,
        claim.localSessionRef
      ) as Record<string, unknown> | undefined;
      if (exact) {
        if (mapSessionBinding(exact).externalSessionRef !== input.externalSessionRef) {
          throw new Error("FEDERATION_SESSION_MISMATCH");
        }
      } else {
        const occupied = this.db.prepare(
          `SELECT 1 FROM federation_session_bindings
           WHERE external_session_ref = ?`
        ).get(input.externalSessionRef);
        if (occupied) throw new Error("FEDERATION_SESSION_SCOPE_CONFLICT");
        const timestamp = this.now().toISOString();
        this.db.prepare(
          `INSERT INTO federation_session_bindings(
             product, family_ref, person_ref, agent_ref, local_session_ref,
             external_session_ref, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          claim.product,
          claim.familyRef,
          claim.personRef,
          claim.agentRef,
          claim.localSessionRef,
          input.externalSessionRef,
          timestamp,
          timestamp
        );
      }
      this.transitionClaimedAudit({
        invocationRef: input.invocationRef,
        status: "succeeded"
      });
      this.deleteInvocationClaim(input.invocationRef);
      return this.getInvocationAudit(input.invocationRef)!;
    });
    return finalize.immediate();
  }

  finalizeInvocationFailure(input: {
    invocationRef: string;
    errorCode: string;
  }): InvocationAuditRecord {
    if (
      !hasRefPrefix(input.invocationRef, "invocation") ||
      !SAFE_ERROR_CODE.test(input.errorCode)
    ) {
      throw new Error("FEDERATION_FINALIZE_INVALID");
    }
    const finalize = this.db.transaction(() => {
      this.requireInvocationClaim(input.invocationRef);
      this.transitionClaimedAudit({
        invocationRef: input.invocationRef,
        status: "failed",
        errorCode: input.errorCode
      });
      this.deleteInvocationClaim(input.invocationRef);
      return this.getInvocationAudit(input.invocationRef)!;
    });
    return finalize.immediate();
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
              f.display_name AS family_display_name,
              p.display_name AS person_display_name,
              fm.family_role, paav.assignment_version AS assignment_version,
              pvc.context_version AS context_version
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
       JOIN person_agent_assignment_versions paav
         ON paav.person_ref = eb.person_ref
       JOIN person_federation_context_versions pvc
         ON pvc.person_ref = eb.person_ref
       WHERE es.entry_session_ref = ?
         AND es.status = 'active'
         AND es.expires_at > ?`
    ).get(entrySessionRef, now) as LiveActorRow | undefined;
    return row ?? null;
  }

  private ensureAssignmentVersion(entrySessionRef: string, now: string): void {
    this.db.prepare(
      `INSERT INTO person_agent_assignment_versions(
         person_ref, assignment_version, updated_at
       )
       SELECT eb.person_ref, 1, ?
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
       WHERE es.entry_session_ref = ?
         AND es.status = 'active'
         AND es.expires_at > ?
       ON CONFLICT(person_ref) DO NOTHING`
    ).run(now, entrySessionRef, now);
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

  private requireInvocationClaim(invocationRef: string): FederationInvocationClaim {
    const claim = this.getInvocationClaim(invocationRef);
    if (!claim) throw new Error("FEDERATION_CLAIM_NOT_OWNED");
    return claim;
  }

  private transitionClaimedAudit(input: {
    invocationRef: string;
    status: "succeeded" | "failed";
    errorCode?: string;
  }): void {
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
  }

  private deleteInvocationClaim(invocationRef: string): void {
    const result = this.db.prepare(
      `DELETE FROM federation_session_invocation_claims
       WHERE invocation_ref = ?`
    ).run(invocationRef);
    if (result.changes !== 1) {
      throw new Error("FEDERATION_CLAIM_NOT_OWNED");
    }
  }

  private mapActorContext(row: LiveActorRow): FederationActorContextV1 {
    const roles = projectionRoles(row);
    return {
      protocolVersion: 1,
      contextRef: String(row.context_ref),
      product: row.product as ProductId,
      familyRef: String(row.family_ref),
      personRef: String(row.person_ref),
      deviceRef: String(row.device_ref),
      entrySessionRef: String(row.entry_session_ref),
      personDisplayName: projectionDisplayName(row.person_display_name),
      familyDisplayName: projectionDisplayName(row.family_display_name),
      roles,
      assignmentVersion: Number(row.assignment_version),
      contextVersion: Number(row.context_version),
      expiresAt: String(row.expires_at)
    };
  }
}
