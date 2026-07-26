import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebPairingClaimRequest } from "@family-ai/contracts";
import { sha256, type GatewayDatabase } from "./database.js";
import { GatewayDomainError } from "./service.js";
import { deriveWebClaimEntryToken } from "./webEntryCrypto.js";

const WEB_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

interface PairingRow extends Record<string, unknown> {
  pairing_ref: string;
  family_ref: string;
  person_ref: string;
  code_hash: string;
  status: "active" | "consumed" | "revoked" | "expired";
  failed_attempts: number;
  max_attempts: number;
  expires_at: string;
  created_by_entry_binding_ref: string;
  created_at: string;
  consumed_at: string | null;
  consumed_device_ref: string | null;
  revoked_at: string | null;
  web_claim_session_ref: string | null;
  web_replay_count: number;
}

interface WebDeviceRow extends Record<string, unknown> {
  device_ref: string;
  display_name: string;
  terminal_type: string;
  platform: string;
  status: "active" | "revoked";
  credential_hash: string;
  installation_ref: string | null;
}

export interface WebDeviceAuthentication {
  deviceRef: string;
  displayName: string;
  familyRef: string;
  personRef: string;
  entryBindingRef: string;
}

export interface WebEntrySessionMaterial {
  entryBindingRef: string;
  entrySessionRef: string;
  entryToken: string;
  expiresAt: string;
}

export interface WebPairingClaimResult extends WebEntrySessionMaterial {
  deviceRef: string;
  deviceCredential: string;
}

function webError(
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

export class WebEntryRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  private nowIso(): string {
    return this.now().toISOString();
  }

  private pairingByRef(pairingRef: string): PairingRow | null {
    return (this.db.prepare(
      `SELECT pairing_ref, family_ref, person_ref, code_hash, status,
              failed_attempts, max_attempts, expires_at,
              created_by_entry_binding_ref, created_at, consumed_at,
              consumed_device_ref, revoked_at, web_claim_session_ref,
              web_replay_count
       FROM mobile_pairing_codes WHERE pairing_ref = ?`
    ).get(pairingRef) as PairingRow | undefined) ?? null;
  }

  private pairingByCodeHash(codeHash: string): PairingRow | null {
    return (this.db.prepare(
      `SELECT pairing_ref, family_ref, person_ref, code_hash, status,
              failed_attempts, max_attempts, expires_at,
              created_by_entry_binding_ref, created_at, consumed_at,
              consumed_device_ref, revoked_at, web_claim_session_ref,
              web_replay_count
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
      throw webError("PAIRING_EXPIRED", 410, "conflict", "配对码已经过期。");
    }
    if (pairing.status === "revoked") {
      throw webError("PAIRING_INVALID", 404, "validation", "配对码无效。");
    }
    if (pairing.failed_attempts >= pairing.max_attempts) {
      throw webError(
        "PAIRING_ATTEMPTS_EXCEEDED",
        429,
        "permission",
        "配对尝试次数已经用尽。"
      );
    }
    if (pairing.status === "consumed" && !allowConsumed) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }
  }

  private recordMismatch(pairing: PairingRow): never {
    const failedAttempts = pairing.failed_attempts + 1;
    this.db.prepare(
      `UPDATE mobile_pairing_codes
       SET failed_attempts = ?
       WHERE pairing_ref = ? AND status = 'active'`
    ).run(failedAttempts, pairing.pairing_ref);
    if (failedAttempts >= pairing.max_attempts) {
      throw webError(
        "PAIRING_ATTEMPTS_EXCEEDED",
        429,
        "permission",
        "配对尝试次数已经用尽。"
      );
    }
    throw webError("PAIRING_INVALID", 404, "validation", "配对码无效。");
  }

  private resolvePairing(
    input: Pick<WebPairingClaimRequest, "code" | "pairingRef">,
    allowConsumed: boolean
  ): PairingRow {
    const codeHash = sha256(input.code);
    let pairing: PairingRow | null;
    if (input.pairingRef) {
      pairing = this.pairingByRef(input.pairingRef);
      if (!pairing) throw webError("PAIRING_INVALID", 404, "validation", "配对码无效。");
      pairing = this.expireIfNeeded(pairing);
      this.assertUsableState(pairing, allowConsumed);
      if (!secureHashEqual(pairing.code_hash, codeHash)) {
        if (pairing.status !== "active") {
          throw webError("PAIRING_INVALID", 404, "validation", "配对码无效。");
        }
        return this.recordMismatch(pairing);
      }
    } else {
      pairing = this.pairingByCodeHash(codeHash);
      if (!pairing) throw webError("PAIRING_INVALID", 404, "validation", "配对码无效。");
      pairing = this.expireIfNeeded(pairing);
      this.assertUsableState(pairing, allowConsumed);
    }
    return pairing;
  }

  private requireActiveTarget(familyRef: string, personRef: string): void {
    const row = this.db.prepare(
      `SELECT 1
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
    ).get(personRef, familyRef);
    if (!row) {
      throw webError(
        "PAIRING_TARGET_INACTIVE",
        409,
        "conflict",
        "配对目标当前不可用。"
      );
    }
  }

  private deviceByInstallation(installationRef: string): WebDeviceRow | null {
    return (this.db.prepare(
      `SELECT device_ref, display_name, terminal_type, platform, status,
              credential_hash, installation_ref
       FROM managed_devices WHERE installation_ref = ?`
    ).get(installationRef) as WebDeviceRow | undefined) ?? null;
  }

  private deviceByRef(deviceRef: string): WebDeviceRow | null {
    return (this.db.prepare(
      `SELECT device_ref, display_name, terminal_type, platform, status,
              credential_hash, installation_ref
       FROM managed_devices WHERE device_ref = ?`
    ).get(deviceRef) as WebDeviceRow | undefined) ?? null;
  }

  private personalBinding(
    deviceRef: string,
    familyRef: string,
    personRef: string
  ): { entry_binding_ref: string } | null {
    return (this.db.prepare(
      `SELECT eb.entry_binding_ref
       FROM entry_bindings eb
       JOIN device_bindings db
         ON db.device_ref = eb.device_ref
        AND db.family_ref = eb.family_ref
        AND db.owner_scope = 'person'
        AND db.person_ref = eb.person_ref
        AND db.status = 'active'
       WHERE eb.device_ref = ? AND eb.family_ref = ? AND eb.person_ref = ?
         AND eb.audience = 'personal' AND eb.status = 'active'`
    ).get(deviceRef, familyRef, personRef) as { entry_binding_ref: string } | undefined) ?? null;
  }

  private issueSession(entryBindingRef: string): WebEntrySessionMaterial {
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + WEB_SESSION_LIFETIME_MS).toISOString();
    const entrySessionRef = `entry-session:${randomUUID()}`;
    const entryToken = randomBytes(32).toString("base64url");

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
    ).run(entrySessionRef, entryBindingRef, sha256(entryToken), nowIso, expiresAt);

    return { entryBindingRef, entrySessionRef, entryToken, expiresAt };
  }

  private issueClaimSession(
    entryBindingRef: string,
    entryToken: string
  ): WebEntrySessionMaterial {
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + WEB_SESSION_LIFETIME_MS).toISOString();
    const entrySessionRef = `entry-session:${randomUUID()}`;

    this.db.prepare(
      `INSERT INTO entry_sessions
       (entry_session_ref, entry_binding_ref, token_hash, status,
        created_at, expires_at, revoked_at)
       VALUES(?, ?, ?, 'active', ?, ?, NULL)`
    ).run(entrySessionRef, entryBindingRef, sha256(entryToken), nowIso, expiresAt);

    return { entryBindingRef, entrySessionRef, entryToken, expiresAt };
  }

  private activeClaimSession(
    entrySessionRef: string,
    entryBindingRef: string,
    entryToken: string
  ): WebEntrySessionMaterial | null {
    const row = this.db.prepare(
      `SELECT entry_session_ref, entry_binding_ref, token_hash, status, expires_at
       FROM entry_sessions
       WHERE entry_session_ref = ?`
    ).get(entrySessionRef) as {
      entry_session_ref: string;
      entry_binding_ref: string;
      token_hash: string;
      status: "active" | "revoked" | "expired";
      expires_at: string;
    } | undefined;
    if (
      !row ||
      row.entry_binding_ref !== entryBindingRef ||
      row.status !== "active" ||
      !secureHashEqual(row.token_hash, sha256(entryToken))
    ) {
      return null;
    }
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime()) {
      return null;
    }
    return {
      entryBindingRef: row.entry_binding_ref,
      entrySessionRef: row.entry_session_ref,
      entryToken,
      expiresAt: row.expires_at
    };
  }

  private requireExistingDeviceCredential(
    device: WebDeviceRow,
    input: { deviceRef: string; deviceCredential: string } | undefined
  ): string {
    if (
      !input ||
      input.deviceRef !== device.device_ref ||
      !secureHashEqual(device.credential_hash, sha256(input.deviceCredential))
    ) {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "浏览器设备凭证无效。");
    }
    if (device.status === "revoked") {
      throw webError("DEVICE_REVOKED", 403, "permission", "浏览器设备已经撤销。");
    }
    if (device.terminal_type !== "web" || device.platform !== "browser") {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "该设备不是浏览器入口。");
    }
    return input.deviceCredential;
  }

  private replayConsumedPairing(
    pairing: PairingRow,
    input: WebPairingClaimRequest & {
      existingDevice?: { deviceRef: string; deviceCredential: string };
    },
    installationRef: string
  ): WebPairingClaimResult {
    if (
      !pairing.consumed_at ||
      !pairing.consumed_device_ref ||
      !pairing.web_claim_session_ref
    ) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }
    const consumedDevice = this.deviceByRef(pairing.consumed_device_ref);
    if (!consumedDevice || consumedDevice.installation_ref !== installationRef) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }

    const submittedCredentialMatches = secureHashEqual(
      consumedDevice.credential_hash,
      sha256(input.deviceCredential)
    );
    const existingCredentialMatches =
      input.existingDevice?.deviceRef === consumedDevice.device_ref &&
      secureHashEqual(
        consumedDevice.credential_hash,
        sha256(input.existingDevice.deviceCredential)
      );
    const replayCredential = existingCredentialMatches
      ? input.existingDevice!.deviceCredential
      : submittedCredentialMatches
        ? input.deviceCredential
        : null;
    if (!replayCredential) {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "浏览器设备凭证无效。");
    }
    if (consumedDevice.terminal_type !== "web" || consumedDevice.platform !== "browser") {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "该设备不是浏览器入口。");
    }
    if (consumedDevice.status === "revoked") {
      throw webError("DEVICE_REVOKED", 403, "permission", "浏览器设备已经撤销。");
    }

    const binding = this.personalBinding(
      consumedDevice.device_ref,
      pairing.family_ref,
      pairing.person_ref
    );
    if (!binding) {
      throw webError("DEVICE_REVOKED", 403, "permission", "浏览器入口已经撤销。");
    }

    const recoveryDeadline = Date.parse(pairing.consumed_at) + 2 * 60 * 1000;
    if (this.now().getTime() > recoveryDeadline || pairing.web_replay_count >= 3) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }

    const entryToken = deriveWebClaimEntryToken(replayCredential, pairing.pairing_ref);
    const session = this.activeClaimSession(
      pairing.web_claim_session_ref,
      binding.entry_binding_ref,
      entryToken
    );
    if (!session) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }

    const updated = this.db.prepare(
      `UPDATE mobile_pairing_codes
       SET web_replay_count = web_replay_count + 1
       WHERE pairing_ref = ?
         AND status = 'consumed'
         AND web_replay_count < 3`
    ).run(pairing.pairing_ref);
    if (updated.changes !== 1) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }

    return {
      deviceRef: consumedDevice.device_ref,
      deviceCredential: replayCredential,
      ...session
    };
  }

  private finalizeActivePairingClaim(
    pairing: PairingRow,
    deviceRef: string,
    entryBindingRef: string,
    deviceCredential: string
  ): WebPairingClaimResult {
    const entryToken = deriveWebClaimEntryToken(deviceCredential, pairing.pairing_ref);
    const session = this.issueClaimSession(entryBindingRef, entryToken);
    const consumed = this.db.prepare(
      `UPDATE mobile_pairing_codes
       SET status = 'consumed',
           consumed_at = ?,
           consumed_device_ref = ?,
           web_claim_session_ref = ?,
           web_replay_count = 0
       WHERE pairing_ref = ? AND status = 'active'`
    ).run(
      this.nowIso(),
      deviceRef,
      session.entrySessionRef,
      pairing.pairing_ref
    );
    if (consumed.changes !== 1) {
      throw webError("PAIRING_CONSUMED", 409, "conflict", "配对码已经被使用。");
    }
    return {
      deviceRef,
      deviceCredential,
      ...session
    };
  }

  claimPairing(
    input: WebPairingClaimRequest & {
      existingDevice?: { deviceRef: string; deviceCredential: string };
    }
  ): WebPairingClaimResult {
    return this.db.transaction(() => {
      const pairing = this.resolvePairing(input, true);
      this.requireActiveTarget(pairing.family_ref, pairing.person_ref);
      const installationRef = sha256(input.installationId);

      if (pairing.status === "consumed") {
        return this.replayConsumedPairing(pairing, input, installationRef);
      }

      const existing = this.deviceByInstallation(installationRef);
      if (existing) {
        const deviceCredential = this.requireExistingDeviceCredential(existing, input.existingDevice);
        const binding = this.personalBinding(
          existing.device_ref,
          pairing.family_ref,
          pairing.person_ref
        );
        if (!binding) {
          throw webError("PAIRING_CONSUMED", 409, "conflict", "该浏览器已绑定其他个人入口。");
        }
        const now = this.nowIso();
        this.db.prepare(
          `UPDATE managed_devices
           SET display_name = ?, system_version = ?, app_version = ?, device_model = ?,
               last_seen_at = ?, updated_at = ?
           WHERE device_ref = ?`
        ).run(
          input.device.displayName,
          input.device.operatingSystem,
          input.device.appVersion,
          input.device.browser,
          now,
          now,
          existing.device_ref
        );
        return this.finalizeActivePairingClaim(
          pairing,
          existing.device_ref,
          binding.entry_binding_ref,
          deviceCredential
        );
      }

      const now = this.nowIso();
      const deviceRef = `device:${randomUUID()}`;
      const deviceBindingRef = `device-binding:${randomUUID()}`;
      const entryBindingRef = `entry-binding:${randomUUID()}`;
      const deviceCredential = input.deviceCredential;

      this.db.prepare(
        `INSERT INTO managed_devices
         (device_ref, display_name, terminal_type, platform, status, credential_hash,
          created_at, updated_at, revoked_at, installation_ref,
          system_version, app_version, device_model, last_seen_at)
         VALUES(?, ?, 'web', 'browser', 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        deviceRef,
        input.device.displayName,
        sha256(deviceCredential),
        now,
        now,
        installationRef,
        input.device.operatingSystem,
        input.device.appVersion,
        input.device.browser,
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

      return this.finalizeActivePairingClaim(
        pairing,
        deviceRef,
        entryBindingRef,
        deviceCredential
      );
    })();
  }

  authenticateDevice(deviceRef: string, deviceCredential: string): WebDeviceAuthentication {
    const device = this.deviceByRef(deviceRef);
    if (!device || !secureHashEqual(device.credential_hash, sha256(deviceCredential))) {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "浏览器设备凭证无效。");
    }
    if (device.status === "revoked") {
      throw webError("DEVICE_REVOKED", 403, "permission", "浏览器设备已经撤销。");
    }
    if (device.terminal_type !== "web" || device.platform !== "browser") {
      throw webError("DEVICE_AUTH_INVALID", 401, "permission", "该设备不是浏览器入口。");
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
      throw webError("DEVICE_REVOKED", 403, "permission", "浏览器入口已经撤销。");
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

  renewSession(authentication: WebDeviceAuthentication): WebEntrySessionMaterial {
    return this.db.transaction(() => {
      const active = this.db.prepare(
        `SELECT 1
         FROM managed_devices d
         JOIN device_bindings db
           ON db.device_ref = d.device_ref
          AND db.status = 'active'
         JOIN entry_bindings eb
           ON eb.device_ref = d.device_ref
          AND eb.entry_binding_ref = ?
          AND eb.audience = 'personal'
          AND eb.status = 'active'
         WHERE d.device_ref = ? AND d.status = 'active'`
      ).get(authentication.entryBindingRef, authentication.deviceRef);
      if (!active) {
        throw webError("DEVICE_REVOKED", 403, "permission", "浏览器入口已经撤销。");
      }
      return this.issueSession(authentication.entryBindingRef);
    })();
  }

  logoutSession(input: {
    entrySessionRef: string;
    entryBindingRef: string;
  }): boolean {
    const result = this.db.prepare(
      `UPDATE entry_sessions
       SET status = 'revoked', revoked_at = ?
       WHERE entry_session_ref = ?
         AND entry_binding_ref = ?
         AND status = 'active'`
    ).run(this.nowIso(), input.entrySessionRef, input.entryBindingRef);
    return result.changes === 1;
  }

  revokeDevice(authentication: WebDeviceAuthentication): void {
    this.db.transaction(() => {
      const now = this.nowIso();
      this.db.prepare(
        `UPDATE entry_sessions
         SET status = 'revoked', revoked_at = ?
         WHERE entry_binding_ref IN (
           SELECT entry_binding_ref FROM entry_bindings WHERE device_ref = ?
         ) AND status = 'active'`
      ).run(now, authentication.deviceRef);
      this.db.prepare(
        `UPDATE entry_bindings SET status = 'revoked'
         WHERE device_ref = ? AND status = 'active'`
      ).run(authentication.deviceRef);
      this.db.prepare(
        `UPDATE device_bindings SET status = 'revoked', revoked_at = ?
         WHERE device_ref = ? AND status = 'active'`
      ).run(now, authentication.deviceRef);
      this.db.prepare(
        `UPDATE managed_devices
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE device_ref = ? AND status = 'active'`
      ).run(now, now, authentication.deviceRef);
    })();
  }
}
