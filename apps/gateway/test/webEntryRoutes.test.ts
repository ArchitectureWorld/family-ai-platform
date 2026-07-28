import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webEntryContextResponseSchema } from "@family-ai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "../src/app.js";
import { WebEntryRepository } from "../src/webEntry.js";

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

const allWebCookieNames = [
  "family_ai_web_device_ref",
  "family_ai_web_device_credential",
  "family_ai_web_entry_session_ref",
  "family_ai_web_entry_token"
] as const;

const sessionCookieNames = [
  "family_ai_web_entry_session_ref",
  "family_ai_web_entry_token"
] as const;

function expectExpiredCookies(
  setCookie: string | string[] | undefined,
  names: readonly string[]
): void {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  expect(values).toHaveLength(names.length);
  expect(values.map((value) => value.split("=", 1)[0])).toEqual(names);
  expect(values.every((value) =>
    value.includes("Max-Age=0") &&
    value.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
  )).toBe(true);
}

describe("Web Entry HTTP routes", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let admin: EntryCredential;
  let personRef = "";
  let pairingRef = "";
  let code = "";
  let currentTime = new Date("2026-07-25T09:00:00.000Z");

  beforeEach(async () => {
    currentTime = new Date("2026-07-25T09:00:00.000Z");
    directory = mkdtempSync(join(tmpdir(), "family-ai-web-entry-routes-"));
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      now: () => currentTime
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
    vi.restoreAllMocks();
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
    expectExpiredCookies(invalidExistingDevice.headers["set-cookie"], allWebCookieNames);
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
        person: { personRef },
        mountedAgents: [{
          agentRef: "agent:personal-assistant",
          providerProfileRef: "provider-profile:fake-local",
          isDefault: true
        }],
        defaultAgentRef: "agent:personal-assistant"
      }
    });
    expect(context.json().context).not.toHaveProperty("agent");

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
        person: { personRef },
        mountedAgents: [{
          agentRef: "agent:personal-assistant",
          providerProfileRef: "provider-profile:fake-local",
          isDefault: true
        }],
        defaultAgentRef: "agent:personal-assistant"
      }
    });
    expect(renew.json().context).not.toHaveProperty("agent");

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
    expect(rejected.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "DEVICE_REVOKED" }
    });
    expectExpiredCookies(rejected.headers["set-cookie"], allWebCookieNames);
  });

  it("returns a strict empty Web context when the authenticated member has no mount", async () => {
    const claimed = await claim();
    expect(claimed.statusCode).toBe(204);
    const unmounted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${encodeURIComponent(personRef)}/agent-mounts/${encodeURIComponent("agent:personal-assistant")}`,
      headers: entryHeaders(admin)
    });
    expect(unmounted.statusCode).toBe(200);

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookieHeader(claimed.headers["set-cookie"]) }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      protocolVersion: 2,
      context: {
        protocolVersion: 1,
        person: { personRef },
        mountedAgents: [],
        defaultAgentRef: null
      }
    });
    expect(context.json().context).not.toHaveProperty("agent");
    expect(() => webEntryContextResponseSchema.parse(context.json())).not.toThrow();
  });

  it("expires only Session cookies for invalid and expired Entry Cookie authentication", async () => {
    const claimed = await claim();
    const named = cookiesByName(claimed.headers["set-cookie"]);
    const invalidCookie = [
      `family_ai_web_device_ref=${named.family_ai_web_device_ref}`,
      `family_ai_web_device_credential=${named.family_ai_web_device_credential}`,
      `family_ai_web_entry_session_ref=${named.family_ai_web_entry_session_ref}`,
      `family_ai_web_entry_token=${"Z".repeat(43)}`
    ].join("; ");
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: invalidCookie }
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "ENTRY_SESSION_INVALID" }
    });
    expectExpiredCookies(invalid.headers["set-cookie"], sessionCookieNames);

    currentTime = new Date("2027-07-25T09:00:00.000Z");
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/web-entry/context",
      headers: { cookie: cookieHeader(claimed.headers["set-cookie"]) }
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "ENTRY_SESSION_EXPIRED" }
    });
    expectExpiredCookies(expired.headers["set-cookie"], sessionCookieNames);
  });

  it("expires all cookies for invalid Device Cookie authentication but not explicit Authorization", async () => {
    const claimed = await claim();
    const named = cookiesByName(claimed.headers["set-cookie"]);
    const invalidDeviceCookie = deviceCookie(named, otherDeviceCredential);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: {
        cookie: invalidDeviceCookie,
        "x-family-ai-web-request": "1"
      }
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "DEVICE_AUTH_INVALID" }
    });
    expectExpiredCookies(invalid.headers["set-cookie"], allWebCookieNames);

    const explicit = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: {
        cookie: invalidDeviceCookie,
        authorization: "Bearer deliberately-invalid-explicit-token",
        "x-family-ai-web-request": "1"
      }
    });
    expect(explicit.statusCode).toBe(401);
    expect(explicit.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "DEVICE_AUTH_INVALID" }
    });
    expect(explicit.headers["set-cookie"]).toBeUndefined();
  });

  it("does not attach positive renew Cookies when strict response validation fails", async () => {
    const claimed = await claim();
    const named = cookiesByName(claimed.headers["set-cookie"]);
    vi.spyOn(webEntryContextResponseSchema, "parse").mockImplementationOnce(() => {
      throw new Error("forced renew response validation failure");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/session/renew",
      headers: {
        cookie: deviceCookie(named),
        "x-family-ai-web-request": "1"
      }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      protocolVersion: 2,
      error: { code: "GATEWAY_INTERNAL_ERROR" }
    });

    const setCookie = response.headers["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const webValues = values.filter((value) =>
      allWebCookieNames.some((name) => value.startsWith(`${name}=`))
    );
    const positive = webValues.filter((value) =>
      !value.split(";", 1)[0]!.endsWith("=")
    );
    const expiry = webValues.filter((value) => value.includes("Max-Age=0"));
    expect(positive).toEqual([]);
    expect(expiry).toEqual([]);
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
      protocolVersion: 2,
      error: {
        code: "WEB_REQUEST_FORBIDDEN",
        category: "permission",
        retryable: false
      }
    });
  });

  it("clears all browser credentials only for auth-free same-origin requests", async () => {
    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/web-entry/cookies/clear",
      headers: {
        host: "family.example",
        origin: "https://family.example",
        "sec-fetch-site": "same-origin",
        "x-family-ai-web-request": "1"
      }
    });
    expect(cleared.statusCode).toBe(204);
    expect(cleared.body).toBe("");
    const setCookie = cleared.headers["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(values).toHaveLength(4);
    expect(values.map((value) => value.split("=", 1)[0])).toEqual([
      "family_ai_web_device_ref",
      "family_ai_web_device_credential",
      "family_ai_web_entry_session_ref",
      "family_ai_web_entry_token"
    ]);
    expect(values.every((value) =>
      value.includes("Max-Age=0") &&
      value.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    )).toBe(true);

    const rejected = [
      await app.inject({
        method: "POST",
        url: "/api/v1/web-entry/cookies/clear",
        headers: { host: "family.example" }
      }),
      await app.inject({
        method: "POST",
        url: "/api/v1/web-entry/cookies/clear",
        headers: {
          host: "family.example",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "x-family-ai-web-request": "1"
        }
      }),
      await app.inject({
        method: "POST",
        url: "/api/v1/web-entry/cookies/clear",
        headers: {
          host: "family.example",
          origin: "https://family.example",
          "sec-fetch-site": "same-origin",
          "x-family-ai-web-request": "1",
          authorization: "Bearer explicit-token"
        }
      })
    ];
    expect(rejected.map((response) => response.statusCode)).toEqual([403, 403, 400]);
    expect(rejected.map((response) => response.json())).toEqual([
      expect.objectContaining({
        protocolVersion: 2,
        error: expect.objectContaining({ code: "WEB_REQUEST_FORBIDDEN" })
      }),
      expect.objectContaining({
        protocolVersion: 2,
        error: expect.objectContaining({ code: "WEB_REQUEST_FORBIDDEN" })
      }),
      expect.objectContaining({
        protocolVersion: 2,
        error: expect.objectContaining({ code: "REQUEST_INVALID" })
      })
    ]);
    expect(rejected.every((response) => response.headers["set-cookie"] === undefined)).toBe(true);
  });

  it("serializes unexpected Claim failures as the strict Web v2 error envelope", async () => {
    vi.spyOn(WebEntryRepository.prototype, "claimPairing").mockImplementationOnce(() => {
      throw new Error("repository implementation detail");
    });
    const response = await claim();
    expect(response.statusCode).toBe(500);
    const body = response.json() as Record<string, unknown> & {
      error: Record<string, unknown>;
    };
    expect(Object.keys(body)).toEqual(["protocolVersion", "error"]);
    expect(body.protocolVersion).toBe(2);
    expect(Object.keys(body.error)).toEqual([
      "code",
      "category",
      "message",
      "retryable",
      "requestId"
    ]);
    expect(body.error).toMatchObject({
      code: "GATEWAY_INTERNAL_ERROR",
      category: "internal",
      message: "Family AI 暂时无法完成这个操作，请稍后重试。",
      retryable: true,
      requestId: expect.stringMatching(/^request:/)
    });
    expect(body).not.toHaveProperty("code");
  });
});
