import {
  pairingCodeSchema,
  pairingRefSchema,
  webDeviceCredentialSchema,
  webPairingClaimRequestSchema,
} from "@family-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePairingFragment,
  clearPendingClaim,
  createDeviceCredential,
  isTerminalPairingError,
  normalizePairingCode,
  preparePendingClaim,
  readPendingClaim,
  shouldRetainPendingClaim,
} from "../member-public/pairing.js";
import {
  createStorage,
  zeroCrypto,
} from "./helpers/memberBrowserHarness.js";

const installationId = "b53f0490-99f1-4d6c-9a95-921a3d76a8c3";
const pendingClaimKey = "family-ai-member-pending-claim:v2";
const terminalPairingCodes = [
  "PAIRING_INVALID",
  "PAIRING_EXPIRED",
  "PAIRING_ATTEMPTS_EXCEEDED",
  "PAIRING_CONSUMED",
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "PAIRING_TARGET_INACTIVE",
] as const;

afterEach(() => vi.unstubAllGlobals());

function seedPendingClaim(sessionStorage: ReturnType<typeof createStorage>) {
  const pending = {
    protocolVersion: 2,
    pairingRef: "pairing:web-1",
    code: "ABCD-EFGH",
    installationId,
    deviceCredential: "A".repeat(43),
  };
  sessionStorage.setItem(pendingClaimKey, JSON.stringify(pending));
  return pending;
}

async function settlePendingClaim(
  sessionStorage: ReturnType<typeof createStorage>,
  claim: () => Promise<void>,
) {
  try {
    await claim();
    clearPendingClaim(sessionStorage);
    return { error: null, retryAvailable: false };
  } catch (error) {
    const retryAvailable = shouldRetainPendingClaim(error);
    if (!retryAvailable) clearPendingClaim(sessionStorage);
    return { error, retryAvailable };
  }
}

describe("Member Web pairing Credential", () => {
  it("creates a canonical 32-byte Credential whose zero-padded final sextet is canonical", () => {
    let requestedBytes = 0;
    const cryptoImpl = {
      getRandomValues(bytes: Uint8Array) {
        requestedBytes = bytes.byteLength;
        bytes.fill(0);
        return bytes;
      },
    };

    const credential = createDeviceCredential(cryptoImpl);

    expect(credential).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(requestedBytes).toBe(32);
    expect(webDeviceCredentialSchema.safeParse(credential).success).toBe(true);
  });

  it("keeps plain-JS pairing validation locked to the Contracts boundaries", () => {
    expect(normalizePairingCode(" abcd-efgh ")).toBe("ABCD-EFGH");
    const refCases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ["pairing:ab", true],
      [`pairing:a${"b".repeat(126)}`, true],
      ["pairing:a", false],
      [`pairing:a${"b".repeat(127)}`, false],
      ["pairing:Ab", false],
      ["device:ab", false],
    ];
    for (const [pairingRef, accepted] of refCases) {
      expect(
        pairingRef === undefined || pairingRefSchema.safeParse(pairingRef).success,
      ).toBe(accepted);
      const prepare = () =>
        preparePendingClaim({
          pairingRef,
          code: "ABCD-EFGH",
          installationId,
          sessionStorage: createStorage(),
          cryptoImpl: zeroCrypto(),
        });
      if (accepted) expect(prepare()).toMatchObject({ code: "ABCD-EFGH" });
      else expect(prepare).toThrow();
    }

    const codeCases: Array<[string, boolean]> = [
      ["ABCD-EFGH", true],
      ["ABCI-EFGH", false],
      ["ABCD-EFG1", false],
      ["abcd-efgh", false],
      ["ABCDE-FGH", false],
    ];
    for (const [code, accepted] of codeCases) {
      expect(pairingCodeSchema.safeParse(code).success).toBe(accepted);
      const prepare = () =>
        preparePendingClaim({
          code,
          installationId,
          sessionStorage: createStorage(),
          cryptoImpl: zeroCrypto(),
        });
      if (accepted) expect(prepare()).toMatchObject({ code });
      else expect(prepare).toThrow();
    }
  });

  it.each(["missing", "noncanonical"])(
    "reports one local code when btoa is %s",
    (failure) => {
      vi.stubGlobal(
        "btoa",
        failure === "missing"
          ? undefined
          : () => `${"A".repeat(42)}B`,
      );

      expect(() => createDeviceCredential(zeroCrypto())).toThrowError(
        expect.objectContaining({ code: "PAIRING_CREDENTIAL_UNAVAILABLE" }),
      );
    },
  );

  it("rejects a non-Contracts installation UUID before generating or storing material", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes);
    const sessionStorage = createStorage();
    const invalidInstallationId =
      "b53f0490-99f1-0d6c-9a95-921a3d76a8c3";
    expect(webPairingClaimRequestSchema.safeParse({
      protocolVersion: 2,
      code: "ABCD-EFGH",
      installationId: invalidInstallationId,
      deviceCredential: "A".repeat(43),
      device: {
        displayName: "Alice 的浏览器",
        browser: "Chrome",
        operatingSystem: "Linux",
        appVersion: "0.1.0",
      },
    }).success).toBe(false);

    expect(() =>
      preparePendingClaim({
        code: "ABCD-EFGH",
        installationId: invalidInstallationId,
        sessionStorage,
        cryptoImpl: { getRandomValues },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PAIRING_FRAGMENT_INVALID" }),
    );
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});

describe("Member Web pairing fragment capture", () => {
  it("stores valid fragment material before synchronously scrubbing only the URL path", () => {
    const calls: string[] = [];
    const sessionStorage = createStorage({
      onSetItem: () => calls.push("store"),
    });
    const historyRef = {
      state: { retained: true },
      replaceState(state: unknown, _title: string, url: string) {
        expect(state).toEqual({ retained: true });
        calls.push(`scrub:${url}`);
      },
    };

    const pending = capturePairingFragment({
      href: "http://127.0.0.1:8791/member/#pairingRef=pairing%3Aweb-1&code=abcd-efgh",
      historyRef,
      installationId,
      sessionStorage,
      cryptoImpl: zeroCrypto(),
    });

    expect(calls).toEqual(["store", "scrub:/member/"]);
    expect(pending).toEqual({
      protocolVersion: 2,
      pairingRef: "pairing:web-1",
      code: "ABCD-EFGH",
      installationId,
      deviceCredential:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(readPendingClaim(sessionStorage, installationId)).toEqual(pending);
  });

  it.each([
    "pairingRef=device%3Awrong&code=ABCD-EFGH",
    "pairingRef=pairing%3Aweb-1",
    "code=ABCD-EFGH",
    "pairingRef=pairing%3Aweb-1&pairingRef=pairing%3Aweb-2&code=ABCD-EFGH",
    "pairingRef=pairing%3Aweb-1&code=ABCD-EFGH&code=JKLM-NPQR",
    "pairingRef=pairing%3Aweb-1&code=ABCI-EFGH",
  ])(
    "scrubs invalid fragment %s before throwing PAIRING_FRAGMENT_INVALID",
    (fragment) => {
      const calls: string[] = [];
      const historyRef = {
        state: { retained: true },
        replaceState(state: unknown, _title: string, url: string) {
          expect(state).toEqual({ retained: true });
          calls.push(`scrub:${url}`);
        },
      };

      expect(() =>
        capturePairingFragment({
          href: `http://127.0.0.1:8791/member/?keep=yes#${fragment}`,
          historyRef,
          installationId,
          sessionStorage: undefined,
          cryptoImpl: undefined,
        }),
      ).toThrowError(expect.objectContaining({ code: "PAIRING_FRAGMENT_INVALID" }));
      expect(calls).toEqual(["scrub:/member/?keep=yes"]);
    },
  );

  it.each([
    "Web Crypto missing",
    "Web Crypto throws",
    "btoa missing",
    "SessionStorage missing",
    "SessionStorage throws",
  ])(
    "keeps the fragment and schedules no Claim when %s",
    (failure) => {
      const replaceState = vi.fn();
      const fetchImpl = vi.fn();
      const localStorageSet = vi.fn();
      const indexedDbOpen = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      vi.stubGlobal("localStorage", { setItem: localStorageSet });
      vi.stubGlobal("indexedDB", { open: indexedDbOpen });

      let sessionStorage: ReturnType<typeof createStorage> | undefined =
        createStorage();
      let cryptoImpl:
        | ReturnType<typeof zeroCrypto>
        | { getRandomValues(): never }
        | undefined = zeroCrypto();
      if (failure === "Web Crypto missing") {
        vi.stubGlobal("crypto", undefined);
        cryptoImpl = undefined;
      }
      if (failure === "Web Crypto throws") {
        cryptoImpl = {
          getRandomValues() {
            throw new Error("CRYPTO_FAILED");
          },
        };
      }
      if (failure === "btoa missing") vi.stubGlobal("btoa", undefined);
      if (failure === "SessionStorage missing") sessionStorage = undefined;
      if (failure === "SessionStorage throws") {
        sessionStorage = {
          ...createStorage(),
          setItem() {
            throw new Error("QUOTA_EXCEEDED");
          },
        };
      }

      expect(() =>
        capturePairingFragment({
          href: "http://127.0.0.1:8791/member/#pairingRef=pairing%3Aweb-1&code=ABCD-EFGH",
          historyRef: { state: null, replaceState },
          installationId,
          sessionStorage,
          cryptoImpl,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PAIRING_CREDENTIAL_UNAVAILABLE" }),
      );
      expect(replaceState).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(localStorageSet).not.toHaveBeenCalled();
      expect(indexedDbOpen).not.toHaveBeenCalled();
    },
  );
});

describe("Member Web pending Claim storage", () => {
  it("treats query keys as legacy material, preserves history state, and returns the unresolved Claim", () => {
    const sessionStorage = createStorage();
    const pending = preparePendingClaim({
      pairingRef: "pairing:web-1",
      code: "ABCD-EFGH",
      installationId,
      sessionStorage,
      cryptoImpl: zeroCrypto(),
    });
    const historyCalls: Array<{ state: unknown; url: string }> = [];

    const captured = capturePairingFragment({
      href: "http://127.0.0.1:8791/member/?pairingRef=pairing%3Aquery&keep=yes&code=ABCD-EFGH#section=chat",
      historyRef: {
        state: { retained: true },
        replaceState(state: unknown, _title: string, url: string) {
          historyCalls.push({ state, url });
        },
      },
      installationId,
      sessionStorage,
      cryptoImpl: {
        getRandomValues() {
          throw new Error("QUERY_MUST_NOT_CREATE_CREDENTIAL");
        },
      },
    });

    expect(captured).toEqual(pending);
    expect(historyCalls).toEqual([
      { state: { retained: true }, url: "/member/?keep=yes" },
    ]);
  });

  it("stores a manual Claim under only the v2 SessionStorage key and omits pairingRef", () => {
    const sessionStorage = createStorage();

    const pending = preparePendingClaim({
      code: "ABCD-EFGH",
      installationId,
      sessionStorage,
      cryptoImpl: zeroCrypto(),
    });

    expect(pending).toEqual({
      protocolVersion: 2,
      code: "ABCD-EFGH",
      installationId,
      deviceCredential:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(pending).not.toHaveProperty("pairingRef");
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.key(0)).toBe(pendingClaimKey);
    expect(JSON.parse(sessionStorage.getItem(pendingClaimKey)!)).toEqual(pending);
  });

  it("re-reads unresolved material without changing a byte or regenerating the Credential", () => {
    const sessionStorage = createStorage();
    const pending = preparePendingClaim({
      pairingRef: "pairing:web-1",
      code: "ABCD-EFGH",
      installationId,
      sessionStorage,
      cryptoImpl: zeroCrypto(),
    });
    const storedBefore = sessionStorage.getItem(pendingClaimKey);

    const reread = readPendingClaim(sessionStorage, installationId);

    expect(reread).toEqual(pending);
    expect(reread?.deviceCredential).toBe(pending.deviceCredential);
    expect(sessionStorage.getItem(pendingClaimKey)).toBe(storedBefore);
  });

  it.each([
    [
      "installation mismatch",
      {
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId: "9cf14c6b-a53f-4705-9455-8905dcae78ec",
        deviceCredential: "A".repeat(43),
      },
    ],
    [
      "noncanonical Credential final sextet",
      {
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId,
        deviceCredential: `${"A".repeat(42)}B`,
      },
    ],
    [
      "unexpected stored field",
      {
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId,
        deviceCredential: "A".repeat(43),
        replayCount: 1,
      },
    ],
  ])("clears and ignores %s", (_label, stored) => {
    const sessionStorage = createStorage();
    sessionStorage.setItem(pendingClaimKey, JSON.stringify(stored));

    expect(readPendingClaim(sessionStorage, installationId)).toBeNull();
    expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
  });

  it("clears malformed stored JSON instead of replaying it", () => {
    const sessionStorage = createStorage();
    sessionStorage.setItem(pendingClaimKey, "{not-json");

    expect(readPendingClaim(sessionStorage, installationId)).toBeNull();
    expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
  });

  it.each(["missing", "throwing"])(
    "maps a %s SessionStorage getItem to PAIRING_CREDENTIAL_UNAVAILABLE",
    (failure) => {
      const sessionStorage = failure === "missing"
        ? {
          removeItem: vi.fn(),
        }
        : {
          getItem() {
            throw new DOMException("storage denied", "SecurityError");
          },
          removeItem: vi.fn(),
        };

      expect(() =>
        readPendingClaim(sessionStorage, installationId),
      ).toThrowError(
        expect.objectContaining({ code: "PAIRING_CREDENTIAL_UNAVAILABLE" }),
      );
    },
  );

  it.each(["missing", "throwing"])(
    "maps a %s SessionStorage removeItem to PAIRING_CREDENTIAL_UNAVAILABLE",
    (failure) => {
      const sessionStorage = failure === "missing"
        ? {}
        : {
          removeItem() {
            throw new DOMException("storage denied", "SecurityError");
          },
        };

      expect(() => clearPendingClaim(sessionStorage)).toThrowError(
        expect.objectContaining({ code: "PAIRING_CREDENTIAL_UNAVAILABLE" }),
      );
    },
  );

  it.each([
    [
      "malformed JSON with throwing removeItem",
      "{not-json",
      installationId,
      () => {
        throw new DOMException("storage denied", "SecurityError");
      },
    ],
    [
      "installation mismatch with missing removeItem",
      JSON.stringify({
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId: "9cf14c6b-a53f-4705-9455-8905dcae78ec",
        deviceCredential: "A".repeat(43),
      }),
      installationId,
      undefined,
    ],
  ])(
    "maps cleanup failure for %s to the single storage-unavailable code",
    (_label, stored, expectedInstallationId, removeItem) => {
      const sessionStorage = {
        getItem: () => stored,
        ...(removeItem ? { removeItem } : {}),
      };

      expect(() =>
        readPendingClaim(sessionStorage, expectedInstallationId),
      ).toThrowError(
        expect.objectContaining({ code: "PAIRING_CREDENTIAL_UNAVAILABLE" }),
      );
    },
  );

  it.each([
    [
      "invalid expectedInstallationId against a valid stored UUID",
      {
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId,
        deviceCredential: "A".repeat(43),
      },
      "not-a-uuid",
    ],
    [
      "matching invalid installation strings",
      {
        protocolVersion: 2,
        code: "ABCD-EFGH",
        installationId: "not-a-uuid",
        deviceCredential: "A".repeat(43),
      },
      "not-a-uuid",
    ],
  ])("clears %s instead of retaining malformed installation identity", (
    _label,
    stored,
    expectedInstallationId,
  ) => {
    const sessionStorage = createStorage();
    sessionStorage.setItem(pendingClaimKey, JSON.stringify(stored));

    expect(readPendingClaim(sessionStorage, expectedInstallationId)).toBeNull();
    expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
  });
});

describe("Member Web pending Claim lifecycle", () => {
  it("clears pending material after a successful Claim", async () => {
    const sessionStorage = createStorage();
    seedPendingClaim(sessionStorage);

    const result = await settlePendingClaim(
      sessionStorage,
      async () => undefined,
    );

    expect(result).toEqual({ error: null, retryAvailable: false });
    expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
  });

  it.each(terminalPairingCodes)(
    "classifies %s as terminal and clears it even when retry signals are present",
    async (code) => {
      const sessionStorage = createStorage();
      seedPendingClaim(sessionStorage);
      const error = Object.assign(new Error(code), {
        code,
        category: "timeout",
        retryable: true,
      });

      const result = await settlePendingClaim(sessionStorage, async () => {
        throw error;
      });

      expect(isTerminalPairingError(error)).toBe(true);
      expect(result).toEqual({ error, retryAvailable: false });
      expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
    },
  );

  it.each([
    ["network TypeError", new TypeError("Failed to fetch")],
    [
      "timeout category",
      Object.assign(new Error("timed out"), {
        code: "UPSTREAM_TIMEOUT",
        category: "timeout",
        retryable: false,
      }),
    ],
    [
      "Gateway unavailable",
      Object.assign(new Error("offline"), {
        code: "GATEWAY_UNAVAILABLE",
        category: "availability",
        retryable: false,
      }),
    ],
    [
      "retryable 5xx",
      Object.assign(new Error("retry later"), {
        code: "PROVIDER_FAILED",
        category: "availability",
        status: 503,
        retryable: true,
      }),
    ],
  ])("retains byte-identical material for %s", async (_label, error) => {
    const sessionStorage = createStorage();
    const pending = seedPendingClaim(sessionStorage);
    const storedBefore = sessionStorage.getItem(pendingClaimKey);

    const result = await settlePendingClaim(sessionStorage, async () => {
      throw error;
    });

    expect(result).toEqual({ error, retryAvailable: true });
    expect(readPendingClaim(sessionStorage, installationId)).toEqual(pending);
    expect(sessionStorage.getItem(pendingClaimKey)).toBe(storedBefore);
  });

  it("clears a non-terminal non-retryable rejection without exposing Retry", async () => {
    const sessionStorage = createStorage();
    seedPendingClaim(sessionStorage);
    const error = Object.assign(new Error("request rejected"), {
      code: "PAIRING_POLICY_REJECTED",
      category: "permission",
      retryable: false,
    });

    const result = await settlePendingClaim(sessionStorage, async () => {
      throw error;
    });

    expect(isTerminalPairingError(error)).toBe(false);
    expect(result).toEqual({ error, retryAvailable: false });
    expect(sessionStorage.getItem(pendingClaimKey)).toBeNull();
  });
});
