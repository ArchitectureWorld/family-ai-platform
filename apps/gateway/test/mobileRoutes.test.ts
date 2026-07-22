import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mobileGatewayErrorSchema,
  pairingClaimResponseSchema,
  pairingPreviewResponseSchema,
  personalPortalContextSchema,
  sessionRenewResponseSchema
} from "@family-ai/contracts";
import { buildGatewayApp } from "../src/app.js";
import { openGatewayDatabase } from "../src/database.js";

const bootstrapToken = "mobile-route-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};
const installationId = "e6eb6a53-26b9-4b91-ae0d-ff5e8d9d58a8";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type EntryCredential = {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
};

type Initialized = {
  family: { familyRef: string; displayName: string };
  owner: { personRef: string; displayName: string };
  entries: { admin: EntryCredential; personal: EntryCredential };
};

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function deviceHeaders(deviceRef: string, credential = deviceCredential) {
  return {
    authorization: `Device ${credential}`,
    "x-device-ref": deviceRef
  };
}

function expectMobileError(response: { json(): unknown }, code: string) {
  const parsed = mobileGatewayErrorSchema.parse(response.json());
  expect(parsed.protocolVersion).toBe(1);
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.message.length).toBeGreaterThan(0);
  return parsed;
}

describe("mobile pairing and device-authenticated routes", () => {
  let directory = "";
  let databasePath = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;

  async function openApp() {
    app = await buildGatewayApp({
      databasePath,
      deviceToken: bootstrapToken,
      mode: "test"
    });
  }

  async function initialize(): Promise<Initialized> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "管理员",
        deviceName: "管理电脑"
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Initialized;
  }

  async function createMember(admin: EntryCredential) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(admin),
      payload: { displayName: "手机使用者", familyRole: "adult" }
    });
    expect(response.statusCode).toBe(201);
    return response.json().member as {
      personRef: string;
      displayName: string;
      entryStatus: "claimed" | "unclaimed";
      activePersonalDeviceCount: number;
    };
  }

  async function createPairing(admin: EntryCredential, personRef: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(admin),
        host: "family-ai-gateway.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      protocolVersion: 1,
      pairing: {
        pairingRef: expect.stringMatching(/^pairing:/),
        code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
        status: "active"
      },
      family: { displayName: "测试家庭" },
      person: { displayName: "手机使用者" },
      qr: {
        url: expect.stringMatching(/^familyai:\/\/pair#v=1&/)
      }
    });
    expect(body.qr.url).toContain(encodeURIComponent(body.pairing.pairingRef));
    expect(body.qr.url).toContain(encodeURIComponent(body.pairing.code));
    return body as {
      pairing: { pairingRef: string; code: string; expiresAt: string };
      qr: { url: string };
    };
  }

  async function claim(code: string, pairingRef?: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      headers: { host: "family-ai-gateway.example.test" },
      payload: {
        protocolVersion: 1,
        ...(pairingRef ? { pairingRef } : {}),
        code,
        installationId,
        deviceCredential,
        device: {
          displayName: "测试 iPhone",
          terminalType: "mobile",
          platform: "ios",
          systemVersion: "26.0",
          appVersion: "1.0.0",
          model: "iPhone"
        }
      }
    });
    expect(response.statusCode).toBe(201);
    return pairingClaimResponseSchema.parse(response.json());
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-mobile-routes-"));
    databasePath = join(directory, "gateway.sqlite");
    await openApp();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires family_admin to create/revoke pairing material and never accepts Bootstrap auth", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);

    const personal = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(member.personRef)}/pairing-codes`,
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(personal.statusCode).toBe(403);
    expectMobileError(personal, "ENTRY_AUDIENCE_FORBIDDEN");

    const bootstrap = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(member.personRef)}/pairing-codes`,
      headers: bootstrapHeaders
    });
    expect(bootstrap.statusCode).toBe(401);
    expectMobileError(bootstrap, "ENTRY_SESSION_INVALID");

    const pairing = await createPairing(initialized.entries.admin, member.personRef);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/pairing-codes/${encodeURIComponent(pairing.pairing.pairingRef)}`,
      headers: entryHeaders(initialized.entries.admin)
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ protocolVersion: 1, status: "revoked" });
  });

  it("supports manual preview/claim and QR pairingRef + code through frozen schemas", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);
    const manual = await createPairing(initialized.entries.admin, member.personRef);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      headers: { host: "family-ai-gateway.example.test" },
      payload: { protocolVersion: 1, code: manual.pairing.code }
    });
    expect(preview.statusCode).toBe(200);
    expect(pairingPreviewResponseSchema.parse(preview.json())).toMatchObject({
      protocolVersion: 1,
      family: { displayName: "测试家庭" },
      person: { displayName: "手机使用者" },
      gatewayHost: "family-ai-gateway.example.test"
    });
    const manualClaim = await claim(manual.pairing.code);
    expect(manualClaim.device.displayName).toBe("测试 iPhone");

    const secondMember = await createMember(initialized.entries.admin);
    const qr = await createPairing(initialized.entries.admin, secondMember.personRef);
    const qrPreview = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      headers: { host: "family-ai-gateway.example.test" },
      payload: {
        protocolVersion: 1,
        pairingRef: qr.pairing.pairingRef,
        code: qr.pairing.code
      }
    });
    expect(qrPreview.statusCode).toBe(200);
  });

  it("rejects unsupported protocol versions, unknown fields, authorization headers, and ref/code mismatch", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);
    const first = await createPairing(initialized.entries.admin, member.personRef);
    const second = await createPairing(initialized.entries.admin, member.personRef);

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      payload: { protocolVersion: 2, code: first.pairing.code }
    });
    expect(unsupported.statusCode).toBe(400);
    expectMobileError(unsupported, "PROTOCOL_VERSION_UNSUPPORTED");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      payload: { protocolVersion: 1, code: first.pairing.code, secretRef: "not-allowed" }
    });
    expect(unknown.statusCode).toBe(400);
    expectMobileError(unknown, "PAIRING_INVALID");

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      headers: bootstrapHeaders,
      payload: { protocolVersion: 1, code: first.pairing.code }
    });
    expect(bootstrap.statusCode).toBe(400);
    expectMobileError(bootstrap, "PAIRING_INVALID");

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/preview",
      payload: {
        protocolVersion: 1,
        pairingRef: first.pairing.pairingRef,
        code: second.pairing.code
      }
    });
    expect(mismatch.statusCode).toBe(404);
    expectMobileError(mismatch, "PAIRING_INVALID");
  });

  it("isolates Device authentication from portal, admin, Chat, and Bootstrap Bearer", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);
    const pairing = await createPairing(initialized.entries.admin, member.personRef);
    const claimed = await claim(pairing.pairing.code, pairing.pairing.pairingRef);
    const headers = deviceHeaders(claimed.device.deviceRef);

    const portal = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers
    });
    expect(portal.statusCode).toBe(401);
    expectMobileError(portal, "ENTRY_SESSION_INVALID");

    const admin = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers
    });
    expect(admin.statusCode).toBe(401);
    expectMobileError(admin, "ENTRY_SESSION_INVALID");

    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers
    });
    expect(chat.statusCode).toBe(401);

    const renewWithBearer = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(renewWithBearer.statusCode).toBe(401);
    expectMobileError(renewWithBearer, "DEVICE_AUTH_INVALID");
  });

  it("returns versioned personal portal context and separates expired from invalid sessions", async () => {
    const initialized = await initialize();
    const personalContext = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(personalContext.statusCode).toBe(200);
    expect(personalPortalContextSchema.parse(personalContext.json()).protocolVersion).toBe(1);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: {
        authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "x-entry-session-ref": initialized.entries.personal.entrySessionRef
      }
    });
    expect(invalid.statusCode).toBe(401);
    expectMobileError(invalid, "ENTRY_SESSION_INVALID");

    await app.close();
    const db = openGatewayDatabase(databasePath);
    db.prepare(
      "UPDATE entry_sessions SET expires_at = ? WHERE entry_session_ref = ?"
    ).run("2026-01-01T00:00:00.000Z", initialized.entries.personal.entrySessionRef);
    db.close();
    await openApp();

    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: entryHeaders(initialized.entries.personal)
    });
    expect(expired.statusCode).toBe(401);
    expectMobileError(expired, "ENTRY_SESSION_EXPIRED");
  });

  it("renews only one session, logs out only the session, and lets the device renew again", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);
    const pairing = await createPairing(initialized.entries.admin, member.personRef);
    const claimed = await claim(pairing.pairing.code);
    const headers = deviceHeaders(claimed.device.deviceRef);

    const renewed = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers
    });
    expect(renewed.statusCode).toBe(200);
    const renewedBody = sessionRenewResponseSchema.parse(renewed.json());
    expect(renewedBody.entry.entryBindingRef).toBe(claimed.entry.entryBindingRef);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/logout",
      headers
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(loggedOut.json()).toEqual({ protocolVersion: 1, status: "logged_out" });

    const oldPortal = await app.inject({
      method: "GET",
      url: "/api/v1/portal/context",
      headers: {
        authorization: `Bearer ${renewedBody.entry.token}`,
        "x-entry-session-ref": renewedBody.entry.entrySessionRef
      }
    });
    expect(oldPortal.statusCode).toBe(401);
    expectMobileError(oldPortal, "ENTRY_SESSION_INVALID");

    const renewedAgain = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers
    });
    expect(renewedAgain.statusCode).toBe(200);
  });

  it("uses the same revocation behavior for local unbind and administrator remote revoke", async () => {
    const initialized = await initialize();
    const member = await createMember(initialized.entries.admin);
    const firstPairing = await createPairing(initialized.entries.admin, member.personRef);
    const first = await claim(firstPairing.pairing.code);

    const unbound = await app.inject({
      method: "DELETE",
      url: "/api/v1/mobile/device",
      headers: deviceHeaders(first.device.deviceRef)
    });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toEqual({ protocolVersion: 1, status: "revoked" });
    const deniedAfterUnbind = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers: deviceHeaders(first.device.deviceRef)
    });
    expect(deniedAfterUnbind.statusCode).toBe(403);
    expectMobileError(deniedAfterUnbind, "DEVICE_REVOKED");

    const secondMember = await createMember(initialized.entries.admin);
    const secondPairing = await createPairing(initialized.entries.admin, secondMember.personRef);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      payload: {
        protocolVersion: 1,
        code: secondPairing.pairing.code,
        installationId: "41e0d7fa-3698-445c-89d7-a5e960957a1a",
        deviceCredential: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        device: {
          displayName: "第二台 iPhone",
          terminalType: "mobile",
          platform: "ios",
          systemVersion: "26.0",
          appVersion: "1.0.0",
          model: "iPhone"
        }
      }
    });
    expect(second.statusCode).toBe(201);
    const secondClaim = pairingClaimResponseSchema.parse(second.json());

    const remotelyRevoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/devices/${encodeURIComponent(secondClaim.device.deviceRef)}`,
      headers: entryHeaders(initialized.entries.admin)
    });
    expect(remotelyRevoked.statusCode).toBe(200);
    expect(remotelyRevoked.json()).toEqual({ protocolVersion: 1, status: "revoked" });

    const deniedAfterRemote = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/session/renew",
      headers: deviceHeaders(
        secondClaim.device.deviceRef,
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      )
    });
    expect(deniedAfterRemote.statusCode).toBe(403);
    expectMobileError(deniedAfterRemote, "DEVICE_REVOKED");
  });
});
