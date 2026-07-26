import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import { openGatewayDatabase, sha256, type GatewayDatabase } from "../src/database.js";
import { MobilePairingRepository } from "../src/mobilePairing.js";
import { EntrySessionAuthenticator } from "../src/entrySessionAuth.js";
import { WebEntryRepository } from "../src/webEntry.js";

const EXISTING_CREDENTIAL = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE";
const WRONG_CREDENTIAL = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCI";

const claim = {
  protocolVersion: 2 as const,
  pairingRef: "",
  code: "ABCD-EFGH",
  installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
  deviceCredential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  device: {
    displayName: "Alice 的浏览器",
    browser: "Chrome 140",
    operatingSystem: "macOS 15",
    appVersion: "0.1.0"
  }
};

describe("Web Entry repository", () => {
  let directory = "";
  let db: GatewayDatabase;
  let family: FamilyDomainRepository;
  let web: WebEntryRepository;
  let currentNow: Date;
  let ownerPersonRef = "";
  let familyRef = "";
  let adminEntryBindingRef = "";
  let pairingRef = "";

  function createPairing(code: string) {
    return new MobilePairingRepository(db, {
      now: () => currentNow,
      codeGenerator: () => code
    }).createPairingCode({
      familyRef,
      personRef: ownerPersonRef,
      createdByEntryBindingRef: adminEntryBindingRef
    });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-"));
    db = openGatewayDatabase(join(directory, "gateway.sqlite"));
    family = new FamilyDomainRepository(db);
    const onboarding = family.initializeFamily({
      familyName: "测试家庭",
      ownerName: "Alice",
      deviceName: "测试电脑",
      deviceCredential: "web-entry-bootstrap-device-credential-with-enough-length"
    });
    ownerPersonRef = onboarding.owner.personRef;
    familyRef = onboarding.family.familyRef;
    adminEntryBindingRef = onboarding.entries.admin.entryBindingRef;
    currentNow = new Date("2026-07-25T08:00:00.000Z");
    const pairing = createPairing(claim.code);
    pairingRef = pairing.pairingRef;
    web = new WebEntryRepository(db, () => currentNow);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("claims real web/browser Device and issues a Personal Entry Session", () => {
    const result = web.claimPairing({ ...claim, pairingRef });

    expect(result.deviceRef).toMatch(/^device:/);
    expect(result.deviceCredential).toBe(claim.deviceCredential);
    expect(result.entrySessionRef).toMatch(/^entry-session:/);
    expect(result.entryToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = db.prepare(
      `SELECT terminal_type, platform, status, credential_hash,
              installation_ref, system_version, app_version, device_model
       FROM managed_devices WHERE device_ref = ?`
    ).get(result.deviceRef) as Record<string, unknown>;
    expect(row).toMatchObject({
      terminal_type: "web",
      platform: "browser",
      status: "active",
      installation_ref: sha256(claim.installationId),
      system_version: "macOS 15",
      app_version: "0.1.0",
      device_model: "Chrome 140"
    });
    expect(row.credential_hash).toBe(sha256(result.deviceCredential));
    expect(JSON.stringify(row)).not.toContain(result.deviceCredential);

    const authenticated = new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(result.entrySessionRef, result.entryToken);
    expect(authenticated).toMatchObject({
      status: "authenticated",
      context: {
        audience: "personal",
        person: { personRef: ownerPersonRef },
        device: {
          deviceRef: result.deviceRef,
          terminalType: "web",
          platform: "browser"
        }
      }
    });
  });

  it("replays the same consumed Claim without rotating its Session", () => {
    const first = web.claimPairing({ ...claim, pairingRef });
    currentNow = new Date("2026-07-25T08:01:00.000Z");
    const replay = web.claimPairing({ ...claim, pairingRef });

    expect(replay).toEqual(first);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM managed_devices WHERE installation_ref = ?"
    ).get(sha256(claim.installationId))).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it("rejects replay with the wrong submitted Device Credential before incrementing", () => {
    const first = web.claimPairing({ ...claim, pairingRef });

    expect(() => web.claimPairing({
      ...claim,
      pairingRef,
      deviceCredential: WRONG_CREDENTIAL
    })).toThrowError(expect.objectContaining({ code: "DEVICE_AUTH_INVALID", statusCode: 401 }));
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it("rejects replay from a different installation before incrementing", () => {
    const first = web.claimPairing({ ...claim, pairingRef });

    expect(() => web.claimPairing({
      ...claim,
      pairingRef,
      installationId: "4897332a-782a-4ce8-b91b-f1c2543ba188"
    })).toThrowError(expect.objectContaining({ code: "PAIRING_CONSUMED", statusCode: 409 }));
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it.each([
    {
      layer: "managed Device",
      revokeSql: "UPDATE managed_devices SET status = 'revoked' WHERE device_ref = ?"
    },
    {
      layer: "active Device Binding",
      revokeSql: "UPDATE device_bindings SET status = 'revoked' WHERE device_ref = ?"
    },
    {
      layer: "active Entry Binding",
      revokeSql: "UPDATE entry_bindings SET status = 'revoked' WHERE device_ref = ?"
    }
  ])("rejects replay after revoking the $layer before incrementing", ({ revokeSql }) => {
    const first = web.claimPairing({ ...claim, pairingRef });
    db.prepare(revokeSql).run(first.deviceRef);

    expect(() => web.claimPairing({ ...claim, pairingRef }))
      .toThrowError(expect.objectContaining({ code: "DEVICE_REVOKED", statusCode: 403 }));
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it("accepts replay at exactly two minutes and rejects it one millisecond later", () => {
    const first = web.claimPairing({ ...claim, pairingRef });

    currentNow = new Date("2026-07-25T08:02:00.000Z");
    expect(web.claimPairing({ ...claim, pairingRef })).toEqual(first);

    currentNow = new Date("2026-07-25T08:02:00.001Z");
    expect(() => web.claimPairing({ ...claim, pairingRef }))
      .toThrowError(expect.objectContaining({ code: "PAIRING_CONSUMED", statusCode: 409 }));
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it("allows only three identical consumed Claim replays", () => {
    const first = web.claimPairing({ ...claim, pairingRef });

    const replay1 = web.claimPairing({ ...claim, pairingRef });
    const replay2 = web.claimPairing({ ...claim, pairingRef });
    const replay3 = web.claimPairing({ ...claim, pairingRef });
    expect([replay1, replay2, replay3]).toEqual([first, first, first]);

    expect(() => web.claimPairing({ ...claim, pairingRef }))
      .toThrowError(expect.objectContaining({ code: "PAIRING_CONSUMED", statusCode: 409 }));
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(pairingRef)).toEqual({ web_replay_count: 3 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
    ).get(first.entryBindingRef)).toEqual({ count: 1 });
  });

  it("uses a verified existing-Device Cookie Credential for a distinct pending Claim", () => {
    const existing = web.claimPairing({ ...claim, pairingRef });
    const nextPairing = createPairing("JKLM-NPQR");
    const nextClaim = {
      ...claim,
      pairingRef: nextPairing.pairingRef,
      code: nextPairing.code,
      deviceCredential: EXISTING_CREDENTIAL,
      existingDevice: {
        deviceRef: existing.deviceRef,
        deviceCredential: existing.deviceCredential
      }
    };

    const first = web.claimPairing(nextClaim);
    const replay = web.claimPairing(nextClaim);

    expect(first.deviceRef).toBe(existing.deviceRef);
    expect(first.deviceCredential).toBe(claim.deviceCredential);
    expect(replay).toEqual(first);
    expect(db.prepare(
      "SELECT credential_hash FROM managed_devices WHERE device_ref = ?"
    ).get(existing.deviceRef)).toEqual({ credential_hash: sha256(claim.deviceCredential) });
    expect(db.prepare(
      "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
    ).get(nextPairing.pairingRef)).toEqual({ web_replay_count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM entry_sessions
       WHERE entry_session_ref = (
         SELECT web_claim_session_ref FROM mobile_pairing_codes WHERE pairing_ref = ?
       )`
    ).get(nextPairing.pairingRef)).toEqual({ count: 1 });
  });

  it.each(["missing", "corrupt"] as const)(
    "rejects a distinct pending Credential when the existing-Device Cookie is %s",
    (cookieState) => {
      const existing = web.claimPairing({ ...claim, pairingRef });
      const nextPairing = createPairing("JKLM-NPQR");
      const validExistingDevice = {
        deviceRef: existing.deviceRef,
        deviceCredential: existing.deviceCredential
      };
      const nextClaim = {
        ...claim,
        pairingRef: nextPairing.pairingRef,
        code: nextPairing.code,
        deviceCredential: EXISTING_CREDENTIAL,
        existingDevice: validExistingDevice
      };
      const first = web.claimPairing(nextClaim);

      expect(() => web.claimPairing({
        ...nextClaim,
        existingDevice: cookieState === "missing"
          ? undefined
          : { deviceRef: existing.deviceRef, deviceCredential: WRONG_CREDENTIAL }
      })).toThrowError(expect.objectContaining({ code: "DEVICE_AUTH_INVALID", statusCode: 401 }));
      expect(db.prepare(
        "SELECT web_replay_count FROM mobile_pairing_codes WHERE pairing_ref = ?"
      ).get(nextPairing.pairingRef)).toEqual({ web_replay_count: 0 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM entry_sessions WHERE entry_binding_ref = ?"
      ).get(first.entryBindingRef)).toEqual({ count: 2 });
    }
  );

  it("targets exact Session logout without letting delayed S1 logout revoke S2", () => {
    const first = web.claimPairing({ ...claim, pairingRef });
    const device = web.authenticateDevice(first.deviceRef, first.deviceCredential);
    const firstLogout = {
      entrySessionRef: first.entrySessionRef,
      entryBindingRef: device.entryBindingRef
    };

    expect(web.logoutSession(firstLogout)).toBe(true);
    expect(new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(first.entrySessionRef, first.entryToken).status).not.toBe("authenticated");

    currentNow = new Date("2026-07-25T08:02:00.000Z");
    const renewed = web.renewSession(device);
    expect(new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(renewed.entrySessionRef, renewed.entryToken).status).toBe("authenticated");

    expect(web.logoutSession(firstLogout)).toBe(false);
    expect(new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(renewed.entrySessionRef, renewed.entryToken).status).toBe("authenticated");

    web.revokeDevice(device);
    expect(() => web.authenticateDevice(first.deviceRef, first.deviceCredential))
      .toThrowError(expect.objectContaining({ code: "DEVICE_REVOKED", statusCode: 403 }));
    expect(new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(renewed.entrySessionRef, renewed.entryToken).status).not.toBe("authenticated");
  });

  it("rejects expired material without leaving a partial Web Device", () => {
    currentNow = new Date("2026-07-25T08:06:00.001Z");
    expect(() => web.claimPairing({ ...claim, pairingRef }))
      .toThrowError(expect.objectContaining({ code: "PAIRING_EXPIRED", statusCode: 410 }));
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM managed_devices WHERE terminal_type = 'web'"
    ).get()).toEqual({ count: 0 });
  });
});
