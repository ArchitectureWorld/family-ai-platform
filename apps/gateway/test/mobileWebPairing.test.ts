import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const bootstrapToken = "mobile-web-bootstrap-token-with-enough-length";
const bootstrapHeaders = {
  authorization: `Bearer ${bootstrapToken}`,
  "x-device-ref": "device:test"
};
const installationId = "e6eb6a53-26b9-4b91-ae0d-ff5e8d9d58a8";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const directories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-mobile-web-"));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

type EntryCredential = {
  entryBindingRef: string;
  entrySessionRef: string;
  token: string;
  audience: "family_admin" | "personal";
  agentRef: string;
};

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("mobile pairing and product Web boundaries", () => {
  it("reports claimed state and the active personal mobile-device count", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePath(),
      deviceToken: bootstrapToken,
      mode: "test"
    });

    const initializedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "管理员",
        deviceName: "管理电脑"
      }
    });
    expect(initializedResponse.statusCode).toBe(201);
    const initialized = initializedResponse.json() as {
      entries: { admin: EntryCredential };
    };

    const memberResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/members",
      headers: entryHeaders(initialized.entries.admin),
      payload: { displayName: "手机使用者", familyRole: "adult" }
    });
    expect(memberResponse.statusCode).toBe(201);
    const member = memberResponse.json().member as { personRef: string };

    const beforeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: entryHeaders(initialized.entries.admin)
    });
    const before = beforeResponse.json().members.find(
      (item: { personRef: string }) => item.personRef === member.personRef
    );
    expect(before).toMatchObject({
      entryStatus: "unclaimed",
      activePersonalDeviceCount: 0
    });

    const pairingResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(member.personRef)}/pairing-codes`,
      headers: {
        ...entryHeaders(initialized.entries.admin),
        host: "family-ai-gateway.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(pairingResponse.statusCode).toBe(201);
    const pairing = pairingResponse.json().pairing as {
      pairingRef: string;
      code: string;
    };

    const claimResponse = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/pairing/claim",
      payload: {
        protocolVersion: 1,
        pairingRef: pairing.pairingRef,
        code: pairing.code,
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
    expect(claimResponse.statusCode).toBe(201);

    const afterResponse = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: entryHeaders(initialized.entries.admin)
    });
    const after = afterResponse.json().members.find(
      (item: { personRef: string }) => item.personRef === member.personRef
    );
    expect(after).toMatchObject({
      entryStatus: "claimed",
      activePersonalDeviceCount: 1
    });

    await app.close();
  });

  it("does not expose the historical acceptance-only browser assets", async () => {
    const app = await buildGatewayApp({
      databasePath: databasePath(),
      deviceToken: bootstrapToken,
      mode: "development"
    });
    try {
      for (const path of [
        "/qr.js",
        "/qr-v10.mjs",
        "/acceptance.js",
        "/mobileAcceptance.js",
        "/acceptance.css",
        "/mobile-acceptance.css"
      ]) {
        expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
