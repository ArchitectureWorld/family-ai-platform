import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MOBILE_ENTRY_PROTOCOL_VERSION,
  mobileOperationResponseSchema,
  pairingClaimResponseSchema,
  pairingCodeSchema,
  pairingPreviewResponseSchema,
  sessionRenewResponseSchema,
  type MobileOperationResponse,
  type PairingClaimRequest,
  type PairingClaimResponse,
  type PairingPreviewRequest,
  type PairingPreviewResponse,
  type SessionRenewResponse
} from "@family-ai/contracts";
import { sha256, type GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";

const PAIRING_LIFETIME_MS = 5 * 60 * 1000;
const PERSONAL_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_CODE_GENERATION_ATTEMPTS = 64;

interface PairingRow extends Record<string, unknown> {
  pairing_ref: string;
  family_ref: string;
  person_ref: string;
  code_hash: string;
  status: "active" | "consumed" | "revoked" | "expired";
  failed_attempts: number;
  max_attempts: number;
  expires_at: string;
  consumed_device_ref: string | null;
}

interface TargetRow extends Record<string, unknown> {
  family_ref: string;
  family_display_name: string;
  person_ref: string;
  person_display_name: string;
}

interface DeviceRow extends Record<string, unknown> {
  device_ref: string;
  display_name: string;
  status: "active" | "revoked";
  credential_hash: string;
  installation_ref: string | null;
}

export interface MobileDeviceAuthentication {
  deviceRef: string;
  displayName: string;
  familyRef: string;
  personRef: string;
  entryBindingRef: string;
}

export interface PairingMaterial {
  protocolVersion: 1;
  pairingRef: string;
  code: string;
  expiresAt: string;
  family: { displayName: string };
  person: { displayName: string };
}

export interface MobilePairingRepositoryOptions {
  now?: () => Date;
  codeGenerator?: () => string;
}

function mobileError(
  code: string,
  statusCode: number,
  category: "validation" | "permission" | "availability" | "timeout" | "conflict" | "internal",
  message: string,
  retryable = false
): GatewayDomainError {
  return new GatewayDomainError(code, statusCode, category, retryable, message);
}

function secureHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultCodeGenerator(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: mobile_pairing_codes\.code_hash/.test(
    error.message
  );
}

export class MobilePairingRepository {
  private readonly now: () => Date;
  private readonly codeGenerator: () => string;

  constructor(
    private readonly db: GatewayDatabase,
    options: MobilePairingRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.codeGenerator = options.codeGenerator ?? defaultCodeGenerator;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private activeTarget(familyRef: string, personRef: string): TargetRow | null {
    const row = this.db.prepare(
      `SELECT f.family_ref, f.display_name AS family_display_name,
              p.person_ref, p.display_name AS person_display_name
       FROM families f
       JOIN family_memberships fm
         ON fm.family_ref = f.family_ref
        AND fm.person_ref = ?
        AND fm.status = 'active'
       JOIN persons p
         ON p.person_ref = fm.person_ref
        AND p.status = 'active'
       JOIN assistant_assignments aa
         ON aa.person_ref = p.person_ref
        AND aa.status = 'active'
       WHERE f.family_ref = ? AND f.status = 'active'`
    ).get(personRef, familyRef) as TargetRow | undefined;
    return row ?? null;
  }

  private requireActiveTarget(familyRef: string, personRef: string): TargetRow {
    const target = this.activeTarget(familyRef, personRef);
    if (!target) {
      throw mobileError(
        "PAIRING_TARGET_INACTIVE",
        409,
        "conflict",
        "配对目标当前不可用。"
      );
    }
    return target;
  }

  private requireAdministratorBinding(
    familyRef: string,
    entryBindingRef: string
  ): void {
    const row = this.db.prepare(
      `SELECT 1
       FROM entry_bindings
       WHERE entry_binding_ref = ?
         AND family_ref = ?
         AND audience = 'family_admin'
         AND status = 'active'`
    ).get(entryBindingRef, familyRef);
    if (!row) {
      throw mobileError(
        "ENTRY_AUDIENCE_FORBIDDEN",
        403,
        "permission",
        "当前入口不能创建移动设备配对材料。"
      );
    }
  }

  createPairingCode(input: {
    familyRef: string;
    personRef: string;
    createdByEntryBindingRef: string;
  }): PairingMaterial {
    this.requireAdministratorBinding(input.familyRef, input.createdByEntryBindingRef);
    const target = this.requireActiveTarget(input.familyRef, input.personRef);
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS).toISOString();

    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = this.codeGenerator();
      if (!pairingCodeSchema.safeParse(code).success) {
        continue;
      }
      const pairingRef = `pairing:${randomUUID()}`;
      try {
        this.db.prepare(
          `INSERT INTO mobile_pairing_codes
           (pairing_ref, family_ref, person_ref, code_hash, status,
            failed_attempts, max_attempts, expires_at,
            created_by_entry_binding_ref, created_at,
            consumed_at, consumed_device_ref, revoked_at)
           VALUES(?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, NULL, NULL, NULL)`
        ).run(
          pairingRef,
          input.familyRef,
          input.personRef,
          sha256(code),
          MAX_PAIRING_ATTEMPTS,
          expiresAt,
          input.createdByEntryBindingRef,
          nowIso
        );
        return {
          protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
          pairingRef,
          code,
          expiresAt,
          family: { displayName: target.family_display_name },
          person: { displayName: target.person_display_name }
        };
      } catch (error) {
        if (isUniqueConstraint(error)) continue;
        throw error;
      }
    }

    throw mobileError(
      "PAIRING_INVALID",
      503,
      "availability",
      "暂时无法生成唯一配对码，请稍后重试。",
      true
    );
  }

  private pairingByRef(pairingRef: string): PairingRow | null {
    return (this.db.prepare(
      `SELECT pairing_ref, family_ref, person_ref, code_hash, status,
              failed_attempts, max_attempts, expires_at, consumed_device_ref
       FROM mobile_pairing_codes WHERE pairing_ref = ?`
    ).get(pairingRef) as PairingRow | undefined) ?? null;
  }

  private pairingByCodeHash(codeHash: string): PairingRow | null {
    return (this.db.prepare(
      `SELECT pairing_ref, family_ref, person_ref, code_hash, status,
              failed_attempts, max_attempts, expires_at, consumed_device_ref
       FROM mobile_pairing_codes WHERE code_hash = ?`
    ).get(codeHash) as PairingRow | undefined) ?? null;
  }

  private expireIfNeeded(pairing: PairingRow): PairingRow {
    if (pairing.status === "active" && Date.parse(pairing.expires_at) <= this.now().getTime()) {
      this.db.prepare(
        `UPDATE mobile_pairing_codes
         SET status = 'expired'
         WHERE pairing_ref = ? AND status = 'active'`
      ).run(pairing.pairing_ref);
      return { ...pairing, status: "expired" };
    }
    return pairing;
  }

  private assertUsableState(pairing: PairingRow, allowConsumed: boolean): void {
    if (pairing.status === "expired") {
      throw mobileError("PAIRING_EXPIRED", 410, "conflict", "配对码已经过期。");
    }
    if (pairing.status === "revoked") {
      throw mobileError("PAIRING_INVALID", 404, "validation", "配对码无效。");
    }
    if (pairing.failed_attempts >= pairing.max_attempts) {
      throw mobileError(
        "PAIRING_ATTEMPTS_EXCEEDED",
        429,
        "permission",
        "配对尝试次数已经用尽。"
      );
    }
    if (pairing.status === "consumed" && !allowConsumed) {
      throw mobileError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }
  }

  private recordMismatch(pairing: PairingRow): never {
    const nextAttempts = pairing.failed_attempts + 1;
    this.db.prepare(
      `UPDATE mobile_pairing_codes
       SET failed_attempts = ?
       WHERE pairing_ref = ? AND status = 'active'`
    ).run(nextAttempts, pairing.pairing_ref);
    if (nextAttempts >= pairing.max_attempts) {
      throw mobileError(
        "PAIRING_ATTEMPTS_EXCEEDED",
        429,
        "permission",
        "配对尝试次数已经用尽。"
      );
    }
    throw mobileError("PAIRING_INVALID", 404, "validation", "配对码无效。");
  }

  private resolvePairing(
    input: Pick<PairingPreviewRequest, "code" | "pairingRef">,
    allowConsumed: boolean
  ): PairingRow {
    const codeHash = sha256(input.code);
    let pairing: PairingRow | null;

    if (input.pairingRef) {
      pairing = this.pairingByRef(input.pairingRef);
      if (!pairing) {
        throw mobileError("PAIRING_INVALID", 404, "validation", "配对码无效。");
      }
      pairing = this.expireIfNeeded(pairing);
      this.assertUsableState(pairing, allowConsumed);
      if (!secureHashEqual(pairing.code_hash, codeHash)) {
        if (pairing.status !== "active") {
          throw mobileError("PAIRING_INVALID", 404, "validation", "配对码无效。");
        }
        return this.recordMismatch(pairing);
      }
    } else {
      pairing = this.pairingByCodeHash(codeHash);
      if (!pairing) {
        throw mobileError("PAIRING_INVALID", 404, "validation", "配对码无效。");
      }
      pairing = this.expireIfNeeded(pairing);
      this.assertUsableState(pairing, allowConsumed);
    }

    return pairing;
  }

  previewPairing(
    input: PairingPreviewRequest & { gatewayHost: string }
  ): PairingPreviewResponse {
    const pairing = this.resolvePairing(input, false);
    const target = this.requireActiveTarget(pairing.family_ref, pairing.person_ref);
    return pairingPreviewResponseSchema.parse({
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      family: { displayName: target.family_display_name },
      person: { displayName: target.person_display_name },
      gatewayHost: input.gatewayHost,
      expiresAt: pairing.expires_at
    });
  }

  revokePairingCode(input: {
    familyRef: string;
    pairingRef: string;
  }): { pairingRef: string; status: "revoked" } {
    return this.db.transaction(() => {
      let pairing = this.pairingByRef(input.pairingRef);
      if (!pairing || pairing.family_ref !== input.familyRef) {
        throw mobileError("PAIRING_INVALID", 404, "permission", "配对记录不存在。");
      }
      pairing = this.expireIfNeeded(pairing);
      if (pairing.status === "consumed") {
        throw mobileError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
      }
      if (pairing.status === "expired") {
        throw mobileError("PAIRING_EXPIRED", 410, "conflict", "配对码已经过期。");
      }
      if (pairing.status === "active") {
        this.db.prepare(
          `UPDATE mobile_pairing_codes
           SET status = 'revoked', revoked_at = ?
           WHERE pairing_ref = ? AND status = 'active'`
        ).run(this.nowIso(), pairing.pairing_ref);
      }
      return { pairingRef: pairing.pairing_ref, status: "revoked" as const };
    })();
  }

  private deviceByInstallation(installationRef: string): DeviceRow | null {
    return (this.db.prepare(
      `SELECT device_ref, display_name, status, credential_hash, installation_ref
       FROM managed_devices WHERE installation_ref = ?`
    ).get(installationRef) as DeviceRow | undefined) ?? null;
  }

  private deviceByRef(deviceRef: string): DeviceRow | null {
    return (this.db.prepare(
      `SELECT device_ref, display_name, status, credential_hash, installation_ref
       FROM managed_devices WHERE device_ref = ?`
    ).get(deviceRef) as DeviceRow | undefined) ?? null;
  }

  private personalBinding(
    deviceRef: string,
    familyRef: string,
    personRef: string
  ): { entry_binding_ref: string } | null {
    return (this.db.prepare(
      `SELECT entry_binding_ref
       FROM entry_bindings
       WHERE device_ref = ? AND family_ref = ? AND person_ref = ?
         AND audience = 'personal' AND status = 'active'`
    ).get(deviceRef, familyRef, personRef) as { entry_binding_ref: string } | undefined) ?? null;
  }

  private issuePersonalSession(entryBindingRef: string): {
    entryBindingRef: string;
    entrySessionRef: string;
    token: string;
    expiresAt: string;
  } {
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + PERSONAL_SESSION_LIFETIME_MS).toISOString();
    const entrySessionRef = `entry-session:${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");

    this.db.prepare(
      `UPDATE entry_sessions
       SET status = 'revoked', revoked_at = ?
       WHERE entry_binding_ref = ? AND status = 'active'`
    ).run(nowIso, entryBindingRef);
    this.db.prepare(
      `INSERT INTO entry_sessions
       (entry_session_ref, entry_binding_ref, token_hash, status,
        created_at, expires_at, revoked_at)
       VALUES(?, ?, ?, 'active', ?, ?, NULL)`
    ).run(entrySessionRef, entryBindingRef, sha256(token), nowIso, expiresAt);

    return { entryBindingRef, entrySessionRef, token, expiresAt };
  }

  private assertExistingDeviceMatches(
    device: DeviceRow,
    installationRef: string,
    credentialHash: string
  ): void {
    if (
      device.installation_ref !== installationRef ||
      !secureHashEqual(device.credential_hash, credentialHash)
    ) {
      throw mobileError(
        "DEVICE_AUTH_INVALID",
        401,
        "permission",
        "该安装标识已经绑定到其他设备凭证。"
      );
    }
    if (device.status === "revoked") {
      throw mobileError("DEVICE_REVOKED", 403, "permission", "设备授权已经撤销。");
    }
  }

  private responseForExistingDevice(
    pairing: PairingRow,
    device: DeviceRow,
    installationRef: string,
    credentialHash: string
  ): PairingClaimResponse {
    this.assertExistingDeviceMatches(device, installationRef, credentialHash);
    const binding = this.personalBinding(
      device.device_ref,
      pairing.family_ref,
      pairing.person_ref
    );
    if (!binding) {
      throw mobileError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被其他设备使用。");
    }
    const entry = this.issuePersonalSession(binding.entry_binding_ref);
    this.db.prepare(
      "UPDATE managed_devices SET last_seen_at = ?, updated_at = ? WHERE device_ref = ?"
    ).run(this.nowIso(), this.nowIso(), device.device_ref);
    return pairingClaimResponseSchema.parse({
      protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
      device: {
        deviceRef: device.device_ref,
        displayName: device.display_name,
        status: "active"
      },
      entry
    });
  }

  claimPairing(input: PairingClaimRequest): PairingClaimResponse {
    return this.db.transaction(() => {
      const pairing = this.resolvePairing(input, true);
      this.requireActiveTarget(pairing.family_ref, pairing.person_ref);
      const installationRef = sha256(input.installationId);
      const credentialHash = sha256(input.deviceCredential);

      if (pairing.status === "consumed") {
        if (!pairing.consumed_device_ref) {
          throw mobileError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
        }
        const consumedDevice = this.deviceByRef(pairing.consumed_device_ref);
        if (!consumedDevice || consumedDevice.installation_ref !== installationRef) {
          throw mobileError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
        }
        if (!secureHashEqual(consumedDevice.credential_hash, credentialHash)) {
          throw mobileError(
            "DEVICE_AUTH_INVALID",
            401,
            "permission",
            "该安装标识已经绑定到其他设备凭证。"
          );
        }
        return this.responseForExistingDevice(
          pairing,
          consumedDevice,
          installationRef,
          credentialHash
        );
      }

      const existingDevice = this.deviceByInstallation(installationRef);
      if (existingDevice) {
        const response = this.responseForExistingDevice(
          pairing,
          existingDevice,
          installationRef,
          credentialHash
        );
        this.db.prepare(
          `UPDATE mobile_pairing_codes
           SET status = 'consumed', consumed_at = ?, consumed_device_ref = ?
           WHERE pairing_ref = ? AND status = 'active'`
        ).run(this.nowIso(), existingDevice.device_ref, pairing.pairing_ref);
        return response;
      }

      const now = this.nowIso();
      const deviceRef = `device:${randomUUID()}`;
      const deviceBindingRef = `device-binding:${randomUUID()}`;
      const entryBindingRef = `entry-binding:${randomUUID()}`;

      this.db.prepare(
        `INSERT INTO managed_devices
         (device_ref, display_name, terminal_type, platform, status, credential_hash,
          created_at, updated_at, revoked_at, installation_ref,
          system_version, app_version, device_model, last_seen_at)
         VALUES(?, ?, 'mobile', 'ios', 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        deviceRef,
        input.device.displayName,
        credentialHash,
        now,
        now,
        installationRef,
        input.device.systemVersion,
        input.device.appVersion,
        input.device.model,
        now
      );
      this.db.prepare(
        `INSERT INTO device_bindings
         (device_binding_ref, device_ref, owner_scope, family_ref, person_ref,
          status, bound_at, revoked_at)
         VALUES(?, ?, 'person', ?, ?, 'active', ?, NULL)`
      ).run(deviceBindingRef, deviceRef, pairing.family_ref, pairing.person_ref, now);
      this.db.prepare(
        `INSERT INTO entry_bindings
         (entry_binding_ref, device_ref, family_ref, person_ref, audience,
          status, bound_at, last_used_at)
         VALUES(?, ?, ?, ?, 'personal', 'active', ?, NULL)`
      ).run(entryBindingRef, deviceRef, pairing.family_ref, pairing.person_ref, now);
      const entry = this.issuePersonalSession(entryBindingRef);
      this.db.prepare(
        `UPDATE mobile_pairing_codes
         SET status = 'consumed', consumed_at = ?, consumed_device_ref = ?
         WHERE pairing_ref = ? AND status = 'active'`
      ).run(now, deviceRef, pairing.pairing_ref);

      return pairingClaimResponseSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        device: {
          deviceRef,
          displayName: input.device.displayName,
          status: "active"
        },
        entry
      });
    })();
  }

  authenticateDevice(deviceRef: string, credential: string): MobileDeviceAuthentication {
    const device = this.deviceByRef(deviceRef);
    if (!device || !secureHashEqual(device.credential_hash, sha256(credential))) {
      throw mobileError("DEVICE_AUTH_INVALID", 401, "permission", "设备凭证无效。");
    }
    if (device.status === "revoked") {
      throw mobileError("DEVICE_REVOKED", 403, "permission", "设备授权已经撤销。");
    }
    const row = this.db.prepare(
      `SELECT db.family_ref, db.person_ref, eb.entry_binding_ref
       FROM device_bindings db
       JOIN entry_bindings eb
         ON eb.device_ref = db.device_ref
        AND eb.family_ref = db.family_ref
        AND eb.person_ref = db.person_ref
        AND eb.audience = 'personal'
        AND eb.status = 'active'
       JOIN families f ON f.family_ref = db.family_ref AND f.status = 'active'
       JOIN persons p ON p.person_ref = db.person_ref AND p.status = 'active'
       JOIN family_memberships fm
         ON fm.family_ref = db.family_ref
        AND fm.person_ref = db.person_ref
        AND fm.status = 'active'
       JOIN assistant_assignments aa
         ON aa.person_ref = db.person_ref
        AND aa.status = 'active'
       WHERE db.device_ref = ?
         AND db.owner_scope = 'person'
         AND db.status = 'active'`
    ).get(deviceRef) as {
      family_ref: string;
      person_ref: string;
      entry_binding_ref: string;
    } | undefined;
    if (!row) {
      throw mobileError("DEVICE_REVOKED", 403, "permission", "设备授权已经撤销。");
    }
    const now = this.nowIso();
    this.db.prepare(
      "UPDATE managed_devices SET last_seen_at = ?, updated_at = ? WHERE device_ref = ?"
    ).run(now, now, deviceRef);
    return {
      deviceRef,
      displayName: device.display_name,
      familyRef: row.family_ref,
      personRef: row.person_ref,
      entryBindingRef: row.entry_binding_ref
    };
  }

  renewPersonalSession(authentication: MobileDeviceAuthentication): SessionRenewResponse {
    return this.db.transaction(() => {
      const active = this.db.prepare(
        `SELECT 1
         FROM managed_devices d
         JOIN device_bindings db ON db.device_ref = d.device_ref AND db.status = 'active'
         JOIN entry_bindings eb
           ON eb.device_ref = d.device_ref
          AND eb.entry_binding_ref = ?
          AND eb.audience = 'personal'
          AND eb.status = 'active'
         WHERE d.device_ref = ? AND d.status = 'active'`
      ).get(authentication.entryBindingRef, authentication.deviceRef);
      if (!active) {
        throw mobileError("DEVICE_REVOKED", 403, "permission", "设备授权已经撤销。");
      }
      return sessionRenewResponseSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        entry: this.issuePersonalSession(authentication.entryBindingRef)
      });
    })();
  }

  logoutPersonalSession(
    authentication: MobileDeviceAuthentication
  ): MobileOperationResponse {
    return this.db.transaction(() => {
      this.db.prepare(
        `UPDATE entry_sessions
         SET status = 'revoked', revoked_at = ?
         WHERE entry_binding_ref = ? AND status = 'active'`
      ).run(this.nowIso(), authentication.entryBindingRef);
      return mobileOperationResponseSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        status: "logged_out"
      });
    })();
  }

  revokeDevice(input: {
    deviceRef: string;
    authenticatedDevice?: MobileDeviceAuthentication;
    administratorFamilyRef?: string;
  }): MobileOperationResponse {
    return this.db.transaction(() => {
      if (input.authenticatedDevice?.deviceRef !== undefined) {
        if (input.authenticatedDevice.deviceRef !== input.deviceRef) {
          throw mobileError("DEVICE_AUTH_INVALID", 401, "permission", "设备凭证无效。");
        }
      } else if (input.administratorFamilyRef) {
        const authorized = this.db.prepare(
          `SELECT 1 FROM device_bindings
           WHERE device_ref = ? AND family_ref = ?`
        ).get(input.deviceRef, input.administratorFamilyRef);
        if (!authorized) {
          throw mobileError("DEVICE_AUTH_INVALID", 404, "permission", "设备不存在。");
        }
      } else {
        throw mobileError("DEVICE_AUTH_INVALID", 401, "permission", "设备凭证无效。");
      }

      const device = this.deviceByRef(input.deviceRef);
      if (!device) {
        throw mobileError("DEVICE_AUTH_INVALID", 404, "permission", "设备不存在。");
      }
      const now = this.nowIso();
      this.db.prepare(
        `UPDATE entry_sessions
         SET status = 'revoked', revoked_at = ?
         WHERE entry_binding_ref IN (
           SELECT entry_binding_ref FROM entry_bindings WHERE device_ref = ?
         ) AND status = 'active'`
      ).run(now, input.deviceRef);
      this.db.prepare(
        `UPDATE entry_bindings
         SET status = 'revoked'
         WHERE device_ref = ? AND status = 'active'`
      ).run(input.deviceRef);
      this.db.prepare(
        `UPDATE device_bindings
         SET status = 'revoked', revoked_at = ?
         WHERE device_ref = ? AND status = 'active'`
      ).run(now, input.deviceRef);
      this.db.prepare(
        `UPDATE managed_devices
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE device_ref = ? AND status = 'active'`
      ).run(now, now, input.deviceRef);

      return mobileOperationResponseSchema.parse({
        protocolVersion: MOBILE_ENTRY_PROTOCOL_VERSION,
        status: "revoked"
      });
    })();
  }
}
