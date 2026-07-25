import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FamilyDomainRepository } from "../src/familyDomain.js";
import { openGatewayDatabase, sha256, type GatewayDatabase } from "../src/database.js";
import { MobilePairingRepository } from "../src/mobilePairing.js";
import { EntrySessionAuthenticator } from "../src/entrySessionAuth.js";
import { WebEntryRepository } from "../src/webEntry.js";

const claim = {
  protocolVersion: 1 as const,
  pairingRef: "",
  code: "ABCD-EFGH",
  installationId: "b53f0490-99f1-4d6c-9a95-921a3d76a8c3",
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
  let pairingRef = "";

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
    currentNow = new Date("2026-07-25T08:00:00.000Z");
    const pairing = new MobilePairingRepository(db, {
      now: () => currentNow,
      codeGenerator: () => "ABCD-EFGH"
    }).createPairingCode({
      familyRef: onboarding.family.familyRef,
      personRef: ownerPersonRef,
      createdByEntryBindingRef: onboarding.entries.admin.entryBindingRef
    });
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
    expect(result.deviceCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  it("replays a consumed pairing only for the same installation and Device credential", () => {
    const first = web.claimPairing({ ...claim, pairingRef });
    currentNow = new Date("2026-07-25T08:01:00.000Z");
    const replay = web.claimPairing({
      ...claim,
      pairingRef,
      existingDevice: {
        deviceRef: first.deviceRef,
        deviceCredential: first.deviceCredential
      }
    });

    expect(replay.deviceRef).toBe(first.deviceRef);
    expect(replay.deviceCredential).toBe(first.deviceCredential);
    expect(replay.entrySessionRef).not.toBe(first.entrySessionRef);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM managed_devices WHERE installation_ref = ?"
    ).get(sha256(claim.installationId))).toEqual({ count: 1 });

    expect(() => web.claimPairing({
      ...claim,
      pairingRef,
      installationId: "4897332a-782a-4ce8-b91b-f1c2543ba188"
    })).toThrowError(expect.objectContaining({ code: "PAIRING_CONSUMED", statusCode: 409 }));
  });

  it("supports logout, Device-authenticated renewal and permanent revocation", () => {
    const first = web.claimPairing({ ...claim, pairingRef });
    const device = web.authenticateDevice(first.deviceRef, first.deviceCredential);

    web.logoutSession(device.entryBindingRef);
    expect(new EntrySessionAuthenticator(db, family, () => currentNow)
      .authenticate(first.entrySessionRef, first.entryToken).status).not.toBe("authenticated");

    currentNow = new Date("2026-07-25T08:02:00.000Z");
    const renewed = web.renewSession(device);
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
