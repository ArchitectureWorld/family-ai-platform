import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGatewayDatabase, sha256, type GatewayDatabase } from "../src/database.js";
import { FamilyDomainRepository, type OnboardingResult } from "../src/familyDomain.js";
import {
  MobilePairingRepository,
  type MobileDeviceAuthentication
} from "../src/mobilePairing.js";
import { GatewayDomainError } from "../src/service.js";

const INSTALLATION_A = "e6eb6a53-26b9-4b91-ae0d-ff5e8d9d58a8";
const INSTALLATION_B = "41e0d7fa-3698-445c-89d7-a5e960957a1a";
const CREDENTIAL_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CREDENTIAL_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function domainCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayDomainError);
    return (error as GatewayDomainError).code;
  }
  throw new Error("Expected a GatewayDomainError");
}

function claimInput(code: string, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1 as const,
    code,
    installationId: INSTALLATION_A,
    deviceCredential: CREDENTIAL_A,
    device: {
      displayName: "测试 iPhone",
      terminalType: "mobile" as const,
      platform: "ios" as const,
      systemVersion: "26.0",
      appVersion: "1.0.0",
      model: "iPhone"
    },
    ...overrides
  };
}

describe("MobilePairingRepository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let familyRepository: FamilyDomainRepository;
  let onboarding: OnboardingResult;
  let personRef = "";
  let nowMs = Date.parse("2026-07-22T12:00:00.000Z");
  let generatedCodes: string[];
  let repository: MobilePairingRepository;

  function buildRepository() {
    repository = new MobilePairingRepository(db, {
      now: () => new Date(nowMs),
      codeGenerator: () => generatedCodes.shift() ?? "WXYZ-6789"
    });
  }

  function createPairing(targetPersonRef = personRef) {
    return repository.createPairingCode({
      familyRef: onboarding.family.familyRef,
      personRef: targetPersonRef,
      createdByEntryBindingRef: onboarding.entries.admin.entryBindingRef
    });
  }

  function authenticate(deviceRef: string, credential = CREDENTIAL_A): MobileDeviceAuthentication {
    return repository.authenticateDevice(deviceRef, credential);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-mobile-pairing-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    familyRepository = new FamilyDomainRepository(db);
    onboarding = familyRepository.initializeFamily({
      familyName: "测试家庭",
      ownerName: "管理员",
      deviceName: "管理电脑",
      deviceCredential: "bootstrap-device-credential-with-enough-length"
    });
    personRef = familyRepository.createMember({
      familyRef: onboarding.family.familyRef,
      displayName: "手机使用者",
      familyRole: "adult"
    }).personRef;
    generatedCodes = ["ABCD-EFGH", "JKLM-NPQR", "STUV-WXYZ", "2345-6789"];
    buildRepository();
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("previews and claims a code-only manual pairing into one personal device entry", () => {
    const pairing = createPairing();
    const preview = repository.previewPairing({
      protocolVersion: 1,
      code: pairing.code,
      gatewayHost: "family-ai-gateway.example.test"
    });
    expect(preview).toEqual({
      protocolVersion: 1,
      family: { displayName: "测试家庭" },
      person: { displayName: "手机使用者" },
      gatewayHost: "family-ai-gateway.example.test",
      expiresAt: pairing.expiresAt
    });

    const claimed = repository.claimPairing(claimInput(pairing.code));
    expect(claimed.protocolVersion).toBe(1);
    expect(claimed.device).toMatchObject({ displayName: "测试 iPhone", status: "active" });
    expect(claimed.entry.token).toMatch(SESSION_PATTERN);
    expect(Date.parse(claimed.entry.expiresAt) - nowMs).toBe(7 * 24 * 60 * 60 * 1000);

    const rows = db.prepare(
      `SELECT md.terminal_type, md.platform, db.owner_scope, eb.audience
       FROM managed_devices md
       JOIN device_bindings db ON db.device_ref = md.device_ref
       JOIN entry_bindings eb ON eb.device_ref = md.device_ref
       WHERE md.device_ref = ?`
    ).all(claimed.device.deviceRef);
    expect(rows).toEqual([{
      terminal_type: "mobile",
      platform: "ios",
      owner_scope: "person",
      audience: "personal"
    }]);
  });

  it("supports QR pairing and rejects a pairingRef/code mismatch while counting the referenced attempt", () => {
    const first = createPairing();
    const second = createPairing();

    expect(domainCode(() => repository.previewPairing({
      protocolVersion: 1,
      pairingRef: first.pairingRef,
      code: second.code,
      gatewayHost: "family-ai-gateway.example.test"
    }))).toBe("PAIRING_INVALID");
    expect(db.prepare(
      "SELECT failed_attempts FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(first.pairingRef)).toEqual({ failed_attempts: 1 });

    const claimed = repository.claimPairing(claimInput(second.code, {
      pairingRef: second.pairingRef
    }));
    expect(claimed.device.status).toBe("active");
  });

  it("rejects expired, consumed, revoked, and five-times-failed pairing codes", () => {
    const expired = createPairing();
    nowMs += 5 * 60 * 1000 + 1;
    expect(domainCode(() => repository.previewPairing({
      protocolVersion: 1,
      code: expired.code,
      gatewayHost: "family-ai-gateway.example.test"
    }))).toBe("PAIRING_EXPIRED");
    expect(db.prepare(
      "SELECT status FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(expired.pairingRef)).toEqual({ status: "expired" });

    nowMs += 1;
    const consumed = createPairing();
    repository.claimPairing(claimInput(consumed.code));
    expect(domainCode(() => repository.claimPairing(claimInput(consumed.code, {
      installationId: INSTALLATION_B
    })))).toBe("PAIRING_CONSUMED");

    const revoked = createPairing();
    repository.revokePairingCode({
      familyRef: onboarding.family.familyRef,
      pairingRef: revoked.pairingRef
    });
    expect(domainCode(() => repository.claimPairing(claimInput(revoked.code, {
      installationId: INSTALLATION_B
    })))).toBe("PAIRING_INVALID");

    const exhausted = createPairing();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(domainCode(() => repository.previewPairing({
        protocolVersion: 1,
        pairingRef: exhausted.pairingRef,
        code: "AAAA-AAAA",
        gatewayHost: "family-ai-gateway.example.test"
      }))).toBe("PAIRING_INVALID");
    }
    expect(domainCode(() => repository.previewPairing({
      protocolVersion: 1,
      pairingRef: exhausted.pairingRef,
      code: "BBBB-BBBB",
      gatewayHost: "family-ai-gateway.example.test"
    }))).toBe("PAIRING_ATTEMPTS_EXCEEDED");
  });

  it("requires active family, Person, Membership, and personal-assistant Assignment", () => {
    db.prepare(
      "UPDATE family_memberships SET status = 'inactive' WHERE family_ref = ? AND person_ref = ?"
    ).run(onboarding.family.familyRef, personRef);
    expect(domainCode(() => createPairing())).toBe("PAIRING_TARGET_INACTIVE");

    db.prepare(
      "UPDATE family_memberships SET status = 'active' WHERE family_ref = ? AND person_ref = ?"
    ).run(onboarding.family.familyRef, personRef);
    const pairing = createPairing();
    db.prepare("UPDATE assistant_assignments SET status = 'ended' WHERE person_ref = ?")
      .run(personRef);
    expect(domainCode(() => repository.claimPairing(claimInput(pairing.code))))
      .toBe("PAIRING_TARGET_INACTIVE");
  });

  it("regenerates a colliding short code and permits multiple personal devices per Person", () => {
    const first = createPairing();
    generatedCodes = [first.code, "JKLM-NPQR"];
    buildRepository();
    const second = createPairing();
    expect(second.code).toBe("JKLM-NPQR");

    repository.claimPairing(claimInput(first.code));
    repository.claimPairing(claimInput(second.code, {
      installationId: INSTALLATION_B,
      deviceCredential: CREDENTIAL_B,
      device: { ...claimInput(second.code).device, displayName: "第二台 iPhone" }
    }));
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM entry_bindings
       WHERE person_ref = ? AND audience = 'personal' AND status = 'active'`
    ).get(personRef)).toEqual({ count: 2 });
  });

  it("rolls back the complete claim transaction when session creation fails", () => {
    const pairing = createPairing();
    db.exec(`
      CREATE TRIGGER fail_mobile_session
      BEFORE INSERT ON entry_sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced mobile session failure');
      END;
    `);

    expect(() => repository.claimPairing(claimInput(pairing.code)))
      .toThrow(/forced mobile session failure/);
    expect(db.prepare(
      "SELECT status, consumed_device_ref FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairing.pairingRef)).toEqual({ status: "active", consumed_device_ref: null });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM managed_devices WHERE installation_ref = ?"
    ).get(sha256(INSTALLATION_A))).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_bindings WHERE person_ref = ? AND audience = 'personal'"
    ).get(personRef)).toEqual({ count: 0 });
  });

  it("retries an interrupted claim idempotently without duplicating identity rows", () => {
    const pairing = createPairing();
    const first = repository.claimPairing(claimInput(pairing.code));
    const retried = repository.claimPairing(claimInput(pairing.code));

    expect(retried.device.deviceRef).toBe(first.device.deviceRef);
    expect(retried.entry.token).toMatch(SESSION_PATTERN);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM managed_devices WHERE installation_ref = ?"
    ).get(sha256(INSTALLATION_A))).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM device_bindings WHERE device_ref = ?"
    ).get(first.device.deviceRef)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_bindings WHERE device_ref = ? AND audience = 'personal'"
    ).get(first.device.deviceRef)).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM entry_sessions es
       JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
       WHERE eb.device_ref = ? AND es.status = 'active'`
    ).get(first.device.deviceRef)).toEqual({ count: 1 });
  });

  it("rejects a credential conflict for the same installation without consuming a new code", () => {
    const first = createPairing();
    repository.claimPairing(claimInput(first.code));
    const second = createPairing();

    expect(domainCode(() => repository.claimPairing(claimInput(second.code, {
      deviceCredential: CREDENTIAL_B
    })))).toBe("DEVICE_AUTH_INVALID");
    expect(db.prepare(
      "SELECT status FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(second.pairingRef)).toEqual({ status: "active" });
  });

  it("stores installation, code, credential, and session material only as SHA-256 hashes", () => {
    const pairing = createPairing();
    const result = repository.claimPairing(claimInput(pairing.code));
    const persisted = JSON.stringify({
      pairing: db.prepare("SELECT * FROM mobile_pairing_codes WHERE pairing_ref = ?")
        .get(pairing.pairingRef),
      device: db.prepare("SELECT * FROM managed_devices WHERE device_ref = ?")
        .get(result.device.deviceRef),
      sessions: db.prepare(
        `SELECT es.* FROM entry_sessions es
         JOIN entry_bindings eb ON eb.entry_binding_ref = es.entry_binding_ref
         WHERE eb.device_ref = ?`
      ).all(result.device.deviceRef)
    });
    expect(persisted).not.toContain(pairing.code);
    expect(persisted).not.toContain(INSTALLATION_A);
    expect(persisted).not.toContain(CREDENTIAL_A);
    expect(persisted).not.toContain(result.entry.token);
    expect(persisted).toContain(sha256(pairing.code));
    expect(persisted).toContain(sha256(INSTALLATION_A));
    expect(persisted).toContain(sha256(CREDENTIAL_A));
    expect(persisted).toContain(sha256(result.entry.token));
  });

  it("renews one personal session, logs out only the session, and preserves device authorization", () => {
    const pairing = createPairing();
    const claimed = repository.claimPairing(claimInput(pairing.code));
    const auth = authenticate(claimed.device.deviceRef);
    const renewed = repository.renewPersonalSession(auth);

    expect(renewed.protocolVersion).toBe(1);
    expect(renewed.entry.entryBindingRef).toBe(claimed.entry.entryBindingRef);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM entry_sessions
       WHERE entry_binding_ref = ? AND status = 'active'`
    ).get(claimed.entry.entryBindingRef)).toEqual({ count: 1 });

    expect(repository.logoutPersonalSession(auth)).toEqual({
      protocolVersion: 1,
      status: "logged_out"
    });
    expect(db.prepare(
      "SELECT status FROM managed_devices WHERE device_ref = ?"
    ).get(claimed.device.deviceRef)).toEqual({ status: "active" });
    expect(db.prepare(
      "SELECT status FROM entry_bindings WHERE entry_binding_ref = ?"
    ).get(claimed.entry.entryBindingRef)).toEqual({ status: "active" });
    expect(repository.renewPersonalSession(auth).entry.token).toMatch(SESSION_PATTERN);
  });

  it("uses one transactional path for local unbind and administrator remote revocation", () => {
    const localPairing = createPairing();
    const local = repository.claimPairing(claimInput(localPairing.code));
    expect(repository.revokeDevice({
      deviceRef: local.device.deviceRef,
      authenticatedDevice: authenticate(local.device.deviceRef)
    })).toEqual({ protocolVersion: 1, status: "revoked" });

    for (const table of ["managed_devices", "device_bindings", "entry_bindings"] as const) {
      expect(db.prepare(`SELECT status FROM ${table} WHERE device_ref = ?`)
        .get(local.device.deviceRef)).toEqual({ status: "revoked" });
    }
    expect(domainCode(() => repository.authenticateDevice(local.device.deviceRef, CREDENTIAL_A)))
      .toBe("DEVICE_REVOKED");

    const remotePairing = createPairing();
    const remote = repository.claimPairing(claimInput(remotePairing.code, {
      installationId: INSTALLATION_B,
      deviceCredential: CREDENTIAL_B
    }));
    expect(repository.revokeDevice({
      deviceRef: remote.device.deviceRef,
      administratorFamilyRef: onboarding.family.familyRef
    })).toEqual({ protocolVersion: 1, status: "revoked" });
    expect(domainCode(() => repository.renewPersonalSession(
      repository.authenticateDevice(remote.device.deviceRef, CREDENTIAL_B)
    ))).toBe("DEVICE_REVOKED");
  });
});
