import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sha256, type GatewayDatabase } from "./database.js";
import {
  FamilyDomainRepository,
  type EntryAudience,
  type EntryContext
} from "./familyDomain.js";
import { GatewayDomainError } from "./service.js";

export type EntrySessionAuthentication =
  | { status: "authenticated"; context: EntryContext }
  | { status: "expired" }
  | { status: "device_revoked" }
  | { status: "invalid" };

function secureHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function entrySessionRef(request: FastifyRequest): string | null {
  const value = request.headers["x-entry-session-ref"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class EntrySessionAuthenticator {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly familyRepository: FamilyDomainRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  authenticate(entrySessionRefValue: string, token: string): EntrySessionAuthentication {
    const row = this.db.prepare(
      `SELECT es.token_hash, es.status AS session_status, es.expires_at,
              eb.status AS binding_status, d.status AS device_status
       FROM entry_sessions es
       JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
       JOIN managed_devices d ON d.device_ref = eb.device_ref
       WHERE es.entry_session_ref = ?`
    ).get(entrySessionRefValue) as {
      token_hash: string;
      session_status: "active" | "revoked" | "expired";
      expires_at: string;
      binding_status: "active" | "revoked";
      device_status: "active" | "revoked";
    } | undefined;

    if (!row || !secureHashEqual(sha256(token), row.token_hash)) {
      return { status: "invalid" };
    }
    if (row.device_status === "revoked") {
      return { status: "device_revoked" };
    }
    if (row.session_status === "active" && Date.parse(row.expires_at) <= this.now().getTime()) {
      this.db.prepare(
        `UPDATE entry_sessions
         SET status = 'expired'
         WHERE entry_session_ref = ? AND status = 'active'`
      ).run(entrySessionRefValue);
      return { status: "expired" };
    }
    if (row.session_status === "expired") {
      return { status: "expired" };
    }
    if (row.session_status !== "active" || row.binding_status !== "active") {
      return { status: "invalid" };
    }

    const context = this.familyRepository.authenticateEntrySession(entrySessionRefValue, token);
    return context ? { status: "authenticated", context } : { status: "invalid" };
  }
}

export function requireEntryRequest(
  request: FastifyRequest,
  authenticator: EntrySessionAuthenticator,
  expectedAudience?: EntryAudience
): EntryContext {
  const ref = entrySessionRef(request);
  const token = bearerToken(request);
  const result = ref && token
    ? authenticator.authenticate(ref, token)
    : { status: "invalid" as const };

  if (result.status === "expired") {
    throw new GatewayDomainError(
      "ENTRY_SESSION_EXPIRED",
      401,
      "permission",
      false,
      "入口会话已经过期。"
    );
  }
  if (result.status === "device_revoked") {
    throw new GatewayDomainError(
      "DEVICE_REVOKED",
      403,
      "permission",
      false,
      "设备授权已经撤销。"
    );
  }
  if (result.status !== "authenticated") {
    throw new GatewayDomainError(
      "ENTRY_SESSION_INVALID",
      401,
      "permission",
      false,
      "入口会话无效。"
    );
  }
  if (expectedAudience && result.context.audience !== expectedAudience) {
    throw new GatewayDomainError(
      "ENTRY_AUDIENCE_FORBIDDEN",
      403,
      "permission",
      false,
      "当前入口没有执行家庭管理操作的权限。"
    );
  }
  return result.context;
}
