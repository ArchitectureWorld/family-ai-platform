import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "web-entry-route-bootstrap-device-token-with-enough-length";
const deviceCredential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const pendingDeviceCredential = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE";
const otherDeviceCredential = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCI";
const installationA = "b53f0490-99f1-4d6c-9a95-921a3d76a8c3";
const installationB = "4897332a-782a-4ce8-b91b-f1c2543ba188";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

type EntryCredential = { entrySessionRef: string; token: string };

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef,
    host: "family.example",
    "x-forwarded-proto": "https"
  };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function cookiesByName(setCookie: string | string[] | undefined): Record<string, string> {
  return Object.fromEntries(cookieHeader(setCookie).split("; ").filter(Boolean).map((pair) => {
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

function deviceCookie(
  named: Record<string, string>,
  credential = named.family_ai_web_device_credential
): string {
  return [
    `family_ai_web_device_ref=${named.family_ai_web_device_ref}`,
    `family_ai_web_device_credential=${credential}`
  ].join("; ");
}

describe("Web Entry HTTP routes", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personRef = "";
  let pairingRef = "";
  let code = "";

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-routes-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      now: () => new Date("2026-07-25T09:00:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "Alice",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    const body = onboarding.json() as {
      owner: { personRef: string };
      entries: { admin: EntryCredential };
    };
    personRef = body.owner.personRef;
    admin = body.entries.admin;

    const pairing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: entryHeaders(admin)
    });
    expect(pairing.statusCode).toBe(201);
    const pairingBody = pairing.json() as {
      pairing: { pairingRef: string; code: string };
    };
    pairingRef = pairingBody.pairing.pairingRef;
    code = pairingBody.pairing.code;
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createPairing(): Promise<{ pairingRef: string; code: string }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
      headers: entryHeaders(admin)
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as {
      pairing: { pairingRef: string; code: string };
    }).pairing;
  }

  async function claim(input: {
    pairing?: { pairingRef: string; code: string };
    protocolVersion?: number;
    code?: string;
    installationId?: string;
    deviceCredential?: string;
    cookie?: string;
  } = {}) {
    const pairing = input.pairing ?? { pairingRef, code };
    return app.inject({
      method: "POST",
      url: "/api/v1/web-entry/pairing/claim",
      headers: {
        "x-family-ai-web-request": "1",
        host: "family.example",
        ...(input.cookie ? { cookie: input.cookie } : {})
      },
      payload: {
        protocolVersion: input.protocolVersion ?? 2,
        pairingRef: pairing.pairingRef,
        code: input.code ?? pairing.code,
        installationId: input.installationId ?? installationA,
        deviceCredential: input.deviceCredential ?? deviceCredential,
        device: {
          displayName: "Alice 的浏览器",
          browser: "Chrome 140",
          operatingSystem: "macOS 15",
          appVersion: "0.1.0"
        }
      }
    });
  }

  it("claims without a response body while secrets stay in HttpOnly cookies", async () => {
    const response = await claim();
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const setCookie = response.headers["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(values).toHaveLength(4);
    expect(values.every((value) =>
      value.includes("HttpOnly") && value.includes("SameSite=Strict") && value.includes("Path=/")
    )).toBe(true);
    expect(values.every((value) => !value.includes("Secure"))).toBe(true);
  });

  it("replays a lost Claim response with identical Cookies and no duplicate Device", async () => {
    const first = await claim();
    const replay = await claim();

    expect(first.statusCode).toBe(204);
    expect(replay.statusCode).toBe(204);
    expect(cookiesByName(replay.headers["set-cookie"]))
      .toEqual(cookiesByName(first.headers["set-cookie"]));
    expect(first.body).toBe("");
    expect(replay.body).toBe("");
  });

  it("keeps a verified Device Cookie without copying it across installations", async () => {
    const first = await claim();
    const firstCookies = cookieHeader(first.headers["set-cookie"]);
    const firstNamed = cookiesByName(first.headers["set-cookie"]);

    const sameInstallation = await claim({
      pairing: await createPairing(),
      deviceCredential: pendingDeviceCredential,
      cookie: firstCookies
    });
    const sameNamed = cookiesByName(sameInstallation.headers["set-cookie"]);
    expect(sameInstallation.statusCode).toBe(204);
    expect(sameNamed.family_ai_web_device_ref).toBe(firstNamed.family_ai_web_device_ref);
    expect(sameNamed.family_ai_web_device_credential)
      .toBe(firstNamed.family_ai_web_device_credential);
    expect(sameNamed.family_ai_web_device_credential).not.toBe(pendingDeviceCredential);

    const otherInstallation = await claim({
      pairing: await createPairing(),
      installationId: installationB,
      deviceCredential: otherDeviceCredential,
      cookie: firstCookies
    });
    const otherNamed = cookiesByName(otherInstallation.headers["set-cookie"]);
    expect(otherInstallation.statusCode).toBe(204);
    expect(otherNamed.family_ai_web_device_ref).not.toBe(firstNamed.family_ai_web_device_ref);
    expect(otherNamed.family_ai_web_device_credential).toBe(otherDeviceCredential);
    expect(otherNamed.family_ai_web_device_credential)
      .not.toBe(firstNamed.family_ai_web_device_credential);

    const firstDeviceStillWorks = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: {
        cookie: deviceCookie(firstNamed),
        "x-family-ai-web-request": "1"
      }
    });
    expect(firstDeviceStillWorks.statusCode).toBe(200);
    expect(cookiesByName(firstDeviceStillWorks.headers["set-cookie"])
      .family_ai_web_device_credential).toBe(deviceCredential);
  });

  it("never attaches positive Entry or Device Cookies to rejected Claims", async () => {
    const malformed = await claim({ protocolVersion: 1 });
    const wrongCode = `${code.startsWith("A") ? "B" : "A"}${code.slice(1)}`;
    const repositoryError = await claim({ code: wrongCode });

    const first = await claim();
    const firstNamed = cookiesByName(first.headers["set-cookie"]);
    const invalidExistingDevice = await claim({
      pairing: await createPairing(),
      deviceCredential: pendingDeviceCredential,
      cookie: deviceCookie(firstNamed, otherDeviceCredential)
    });

    expect(malformed.statusCode).toBe(400);
    expect(repositoryError.statusCode).toBe(404);
    expect(invalidExistingDevice.statusCode).toBe(401);
    for (const response of [malformed, repositoryError, invalidExistingDevice]) {
      const positiveWebCookies = Object.entries(cookiesByName(response.headers["set-cookie"]))
        .filter(([name, value]) => name.startsWith("family_ai_web_") && value.length > 0);
      expect(positiveWebCookies).toEqual([]);
    }
  });

  it("restores context, logs out, renews from Device cookies and permanently revokes", async () => {
    const claimed = await claim();
    expect(claimed.statusCode).toBe(204);
    const cookies = cookieHeader(claimed.headers["set-cookie"]);
    const named = cookiesByName(claimed.headers["set-cookie"]);
    const deviceOnly = deviceCookie(named);

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookies }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      protocolVersion: 2,
      context: {
        protocolVersion: 1,
        person: { personRef }
      }
    });

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: cookies, "x-family-ai-web-request": "1" }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ protocolVersion: 2, status: "logged_out" });
    const logoutCookies = Array.isArray(logout.headers["set-cookie"])
      ? logout.headers["set-cookie"]
      : [String(logout.headers["set-cookie"])];
    expect(logoutCookies).toHaveLength(2);
    expect(logoutCookies.every((value) => value.includes("Max-Age=0"))).toBe(true);

    const expiredContext = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookies }
    });
    expect(expiredContext.statusCode).toBe(401);

    const renew = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie: deviceOnly, "x-family-ai-web-request": "1" }
    });
    expect(renew.statusCode).toBe(200);
    const renewedCookies = cookieHeader(renew.headers["set-cookie"]);
    expect(renew.json()).toMatchObject({
      protocolVersion: 2,
      context: {
        protocolVersion: 1,
        person: { personRef }
      }
    });

    const revoke = await app.inject({
      method: "DELETE",
      url: "/api/v1/web-entry/device",
      headers: { cookie: renewedCookies, "x-family-ai-web-request": "1" }
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ protocolVersion: 2, status: "revoked" });
    const revokeCookies = Array.isArray(revoke.headers["set-cookie"])
      ? revoke.headers["set-cookie"]
      : [String(revoke.headers["set-cookie"])];
    expect(revokeCookies).toHaveLength(4);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: { cookie: deviceOnly, "x-family-ai-web-request": "1" }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("logs out only the exact authenticated Session and leaves a newer Session active", async () => {
    const first = await claim();
    const firstCookies = cookieHeader(first.headers["set-cookie"]);
    const second = await claim({
      pairing: await createPairing(),
      deviceCredential: pendingDeviceCredential,
      cookie: firstCookies
    });
    const secondCookies = cookieHeader(second.headers["set-cookie"]);

    for (const cookie of [firstCookies, secondCookies]) {
      const active = await app.inject({
        method: "GET",
        url: "/api/v1/web-entry/context",
        headers: { cookie }
      });
      expect(active.statusCode).toBe(200);
    }

    const logoutFirst = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: firstCookies, "x-family-ai-web-request": "1" }
    });
    expect(logoutFirst.statusCode).toBe(200);
    expect(logoutFirst.json()).toEqual({ protocolVersion: 2, status: "logged_out" });

    const firstRejected = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: firstCookies }
    });
    expect(firstRejected.statusCode).toBe(401);

    const secondStillActive = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: secondCookies }
    });
    expect(secondStillActive.statusCode).toBe(200);

    const delayedFirstLogout = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: firstCookies, "x-family-ai-web-request": "1" }
    });
    expect(delayedFirstLogout.statusCode).toBe(401);

    const afterDelay = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: secondCookies }
    });
    expect(afterDelay.statusCode).toBe(200);
  });

  it("rejects unsafe browser writes without the same-origin custom header", async () => {
    const claimed = await claim();
    const cookies = cookieHeader(claimed.headers["set-cookie"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/logout",
      headers: { cookie: cookies }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "WEB_REQUEST_FORBIDDEN",
      category: "permission",
      retryable: false
    });
  });
});
