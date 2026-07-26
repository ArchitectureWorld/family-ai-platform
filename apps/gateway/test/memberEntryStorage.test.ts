import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_COOKIE_INTENT_KEY,
  COOKIE_CLEAR_PENDING_KEY,
  INSTALLATION_KEY,
  createEntryStorage,
  installationIdForStorageKey,
} from "../member-public/entry-storage.js";
import { createEntryMutationLock } from "../member-public/entry-mutation.js";
import {
  createDeterministicWebLocks,
  createStorage,
  deferred,
  deterministicUuidCrypto,
} from "./helpers/memberBrowserHarness.js";

const INSTALLATION_A = "00000000-0000-4000-8000-000000000001";
const INSTALLATION_B = "00000000-0000-4000-8000-000000000002";
const TRANSITION_A = "82c136a6-20b8-4f04-8d99-ec754c0dc9f8";
const TRANSITION_B = "1d98be57-0696-4539-9fc6-0d768cd80f13";
const FIXED_TIME = "2026-07-25T09:00:00.000Z";
const IDENTITY_A = {
  familyRef: "family:alice",
  personRef: "person:alice",
  deviceRef: "device:alice",
};
const IDENTITY_B = {
  familyRef: "family:bob",
  personRef: "person:bob",
  deviceRef: "device:bob",
};
const OWNER_A = {
  protocolVersion: 2,
  transitionId: TRANSITION_A,
  installationId: INSTALLATION_A,
  createdAt: FIXED_TIME,
};
const OWNER_B = {
  protocolVersion: 2,
  transitionId: TRANSITION_B,
  installationId: INSTALLATION_B,
  createdAt: "2026-07-25T09:00:01.000Z",
};

const lockKey = (id: string) => `family-ai-member-entry-lock:${id}`;
const identityKey = (id: string) =>
  `family-ai-member-cache-identity:${id}`;
const lifecycleKey = (id: string) =>
  `family-ai-member-entry-state:${id}`;
const tombstoneKey = (id: string) =>
  `family-ai-member-revoke-cleanup:${id}`;

function createFixedEntry(storage = createStorage()) {
  return {
    entry: createEntryStorage({
      localStorage: storage,
      cryptoImpl: deterministicUuidCrypto(),
      now: () => new Date(FIXED_TIME),
    }),
    storage,
  };
}

function closingTombstone(
  overrides: Record<string, unknown> = {},
) {
  return {
    protocolVersion: 2,
    transitionId: TRANSITION_A,
    identity: IDENTITY_A,
    phase: "closing",
    cookiesCleared: false,
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Member Entry non-secret storage", () => {
  it("stores only protocol-v2 non-secret lifecycle records under exact installation keys", () => {
    const { entry, storage } = createFixedEntry();
    const installationId = entry.getOrCreateInstallationId();
    const marker = entry.writeLockMarker(installationId);
    entry.writeIdentityPointer(installationId, IDENTITY_A);
    entry.writeCleanupTombstone(
      installationId,
      closingTombstone({ identity: null }),
    );
    const locked = entry.advanceLifecycle(
      installationId,
      "locked",
      TRANSITION_A,
    );
    const active = entry.advanceLifecycle(
      installationId,
      "active",
      TRANSITION_B,
    );

    expect(installationId).toBe(INSTALLATION_A);
    expect(marker).toEqual({
      protocolVersion: 2,
      lockedAt: FIXED_TIME,
    });
    expect(locked.revision).toBe(1);
    expect(active.revision).toBe(2);
    expect(Object.keys(storage.dump()).sort()).toEqual(
      [
        INSTALLATION_KEY,
        lockKey(INSTALLATION_A),
        identityKey(INSTALLATION_A),
        lifecycleKey(INSTALLATION_A),
        tombstoneKey(INSTALLATION_A),
      ].sort(),
    );
    expect(
      Object.keys(storage.dump())
        .filter((key) => key !== "family-ai-web-installation-id")
        .every((key) => key.endsWith(`:${INSTALLATION_A}`)),
    ).toBe(true);
    expect(JSON.stringify(storage.dump())).not.toMatch(
      /token|credential|pairingRef|message/iu,
    );
  });

  it("returns null only for missing records", () => {
    const { entry } = createFixedEntry();
    expect(entry.readInstallationId()).toBeNull();
    expect(entry.readLockMarker(INSTALLATION_A)).toBeNull();
    expect(entry.readIdentityPointer(INSTALLATION_A)).toBeNull();
    expect(entry.readLifecycle(INSTALLATION_A)).toBeNull();
    expect(entry.readCleanupTombstone(INSTALLATION_A)).toBeNull();
    expect(entry.readClaimCookieIntent()).toBeNull();
    expect(entry.readCookieClearPending()).toBeNull();
  });

  it("throws ENTRY_STORAGE_INVALID for malformed, wrong-version, and widened stored records", () => {
    const cases = [
      [INSTALLATION_KEY, "not-a-uuid", (entry: any) => entry.readInstallationId()],
      [
        lockKey(INSTALLATION_A),
        JSON.stringify({ protocolVersion: 1, lockedAt: FIXED_TIME }),
        (entry: any) => entry.readLockMarker(INSTALLATION_A),
      ],
      [
        identityKey(INSTALLATION_A),
        JSON.stringify({ protocolVersion: 2, ...IDENTITY_A, displayName: "Alice" }),
        (entry: any) => entry.readIdentityPointer(INSTALLATION_A),
      ],
      [
        lifecycleKey(INSTALLATION_A),
        JSON.stringify({
          protocolVersion: 2,
          revision: 1,
          state: "active",
          transitionId: "not-a-uuid",
        }),
        (entry: any) => entry.readLifecycle(INSTALLATION_A),
      ],
      [
        tombstoneKey(INSTALLATION_A),
        JSON.stringify({
          protocolVersion: 2,
          transitionId: TRANSITION_A,
          identity: IDENTITY_A,
          phase: "deleting",
        }),
        (entry: any) => entry.readCleanupTombstone(INSTALLATION_A),
      ],
      [
        CLAIM_COOKIE_INTENT_KEY,
        JSON.stringify({ ...OWNER_A, protocolVersion: 1 }),
        (entry: any) => entry.readClaimCookieIntent(),
      ],
      [
        COOKIE_CLEAR_PENDING_KEY,
        JSON.stringify({ ...OWNER_A, identity: IDENTITY_A }),
        (entry: any) => entry.readCookieClearPending(),
      ],
    ] as const;

    for (const [key, value, read] of cases) {
      const { entry, storage } = createFixedEntry();
      storage.setItem(key, value);
      expect(() => read(entry)).toThrowError(
        expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }),
      );
    }
  });

  it("maps only valid namespaced Entry storage keys back to an installation", () => {
    for (const key of [
      lockKey(INSTALLATION_A),
      identityKey(INSTALLATION_A),
      lifecycleKey(INSTALLATION_A),
      tombstoneKey(INSTALLATION_A),
    ]) {
      expect(installationIdForStorageKey(key)).toBe(INSTALLATION_A);
    }
    expect(installationIdForStorageKey(INSTALLATION_KEY)).toBeNull();
    expect(installationIdForStorageKey(CLAIM_COOKIE_INTENT_KEY)).toBeNull();
    expect(installationIdForStorageKey(COOKIE_CLEAR_PENDING_KEY)).toBeNull();
    expect(installationIdForStorageKey(lockKey("not-a-uuid"))).toBeNull();
    expect(installationIdForStorageKey(`unknown:${INSTALLATION_A}`)).toBeNull();
    expect(installationIdForStorageKey(null)).toBeNull();
  });

  it("matches the Contracts UUID version, variant, nil, and max boundaries", () => {
    const accepted = [
      "b53f0490-99f1-1d6c-9a95-921a3d76a8c3",
      "b53f0490-99f1-8d6c-ba95-921a3d76a8c3",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    for (const installationId of accepted) {
      const { entry, storage } = createFixedEntry();
      storage.setItem(INSTALLATION_KEY, installationId);
      expect(entry.readInstallationId()).toBe(installationId);
      expect(installationIdForStorageKey(lockKey(installationId))).toBe(
        installationId,
      );
    }

    for (const installationId of [
      "b53f0490-99f1-0d6c-9a95-921a3d76a8c3",
      "b53f0490-99f1-4d6c-7a95-921a3d76a8c3",
    ]) {
      const { entry, storage } = createFixedEntry();
      storage.setItem(INSTALLATION_KEY, installationId);
      expect(() => entry.readInstallationId()).toThrowError(
        expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }),
      );
      expect(installationIdForStorageKey(lockKey(installationId))).toBeNull();
    }
  });

  it("creates one installation UUID and rotates an expected UUID only once", () => {
    const storage = createStorage();
    const cryptoImpl = deterministicUuidCrypto();
    const firstTab = createEntryStorage({ localStorage: storage, cryptoImpl });
    const secondTab = createEntryStorage({ localStorage: storage, cryptoImpl });

    const first = firstTab.getOrCreateInstallationId();
    expect(secondTab.getOrCreateInstallationId()).toBe(first);
    const rotated = firstTab.rotateInstallationId(first);
    expect(rotated).toBe(INSTALLATION_B);
    expect(secondTab.rotateInstallationId(first)).toBe(rotated);
    expect(firstTab.rotateInstallationId(rotated)).toBe(
      "00000000-0000-4000-8000-000000000003",
    );
  });

  it("refuses to persist an invalid or unchanged rotation UUID", () => {
    for (const generated of ["not-a-uuid", INSTALLATION_A]) {
      const storage = createStorage();
      storage.setItem(INSTALLATION_KEY, INSTALLATION_A);
      const before = storage.dump();
      const entry = createEntryStorage({
        localStorage: storage,
        cryptoImpl: { randomUUID: () => generated },
      });
      expect(() => entry.rotateInstallationId(INSTALLATION_A)).toThrowError(
        expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }),
      );
      expect(storage.dump()).toEqual(before);
    }
  });

  it("mirrors strict Contracts family, person, and device Ref schemas", () => {
    const invalidIdentities = [
      { ...IDENTITY_A, familyRef: "person:alice" },
      { ...IDENTITY_A, familyRef: "family:Alice" },
      { ...IDENTITY_A, familyRef: "family:a" },
      { ...IDENTITY_A, familyRef: `family:${"a".repeat(128)}` },
      { ...IDENTITY_A, personRef: "family:alice" },
      { ...IDENTITY_A, personRef: "person:Alice" },
      { ...IDENTITY_A, personRef: "person:a" },
      { ...IDENTITY_A, personRef: `person:${"a".repeat(128)}` },
      { ...IDENTITY_A, deviceRef: "person:alice" },
      { ...IDENTITY_A, deviceRef: "device:Alice" },
      { ...IDENTITY_A, deviceRef: "device:a" },
      { ...IDENTITY_A, deviceRef: `device:${"a".repeat(128)}` },
    ];
    for (const identity of invalidIdentities) {
      const { entry } = createFixedEntry();
      expect(() =>
        entry.writeIdentityPointer(INSTALLATION_A, identity),
      ).toThrowError(expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }));
      expect(() =>
        entry.writeCleanupTombstone(
          INSTALLATION_A,
          closingTombstone({ identity }),
        ),
      ).toThrowError(expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }));
    }
  });

  it("writes one exact identity and compare-clears only that identity", () => {
    const { entry } = createFixedEntry();
    const pointer = { protocolVersion: 2, ...IDENTITY_A };
    expect(entry.writeIdentityPointer(INSTALLATION_A, IDENTITY_A)).toEqual(pointer);
    expect(entry.writeIdentityPointer(INSTALLATION_A, IDENTITY_A)).toEqual(pointer);
    expect(() => entry.writeIdentityPointer(INSTALLATION_A, IDENTITY_B)).toThrowError(
      expect.objectContaining({ code: "ENTRY_STORAGE_IDENTITY_CONFLICT" }),
    );
    expect(() =>
      entry.writeIdentityPointer(INSTALLATION_A, {
        ...IDENTITY_A,
        displayName: "Alice",
      }),
    ).toThrowError(expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }));
    expect(entry.clearIdentityPointer(INSTALLATION_A, null)).toBe(false);
    expect(entry.clearIdentityPointer(INSTALLATION_A, IDENTITY_B)).toBe(false);
    expect(entry.readIdentityPointer(INSTALLATION_A)).toEqual(pointer);
    expect(entry.clearIdentityPointer(INSTALLATION_A, IDENTITY_A)).toBe(true);
    entry.writeIdentityPointer(INSTALLATION_A, IDENTITY_A);
    expect(entry.clearIdentityPointer(INSTALLATION_A)).toBe(true);
  });

  it("accepts only strict closing/deleting tombstones with a cookie checkpoint", () => {
    const { entry } = createFixedEntry();
    expect(
      entry.writeCleanupTombstone(
        INSTALLATION_A,
        closingTombstone({ identity: null }),
      ),
    ).toEqual(closingTombstone({ identity: null }));
    expect(
      entry.writeCleanupTombstone(
        INSTALLATION_A,
        closingTombstone({ identity: IDENTITY_A }),
      ),
    ).toEqual(closingTombstone({ identity: IDENTITY_A }));
    expect(
      entry.writeCleanupTombstone(
        INSTALLATION_A,
        closingTombstone({
          identity: IDENTITY_A,
          phase: "deleting",
          cookiesCleared: true,
        }),
      ),
    ).toEqual(
      closingTombstone({
        identity: IDENTITY_A,
        phase: "deleting",
        cookiesCleared: true,
      }),
    );

    expect(() =>
      entry.writeCleanupTombstone(
        INSTALLATION_B,
        closingTombstone({ identity: null, phase: "deleting" }),
      ),
    ).toThrow();
    expect(() =>
      entry.writeCleanupTombstone(
        INSTALLATION_B,
        closingTombstone({
          identity: IDENTITY_A,
          phase: "deleting",
          cookiesCleared: false,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }));
    expect(() =>
      entry.writeCleanupTombstone(INSTALLATION_B, {
        protocolVersion: 2,
        transitionId: TRANSITION_A,
        identity: IDENTITY_A,
        phase: "closing",
      }),
    ).toThrow();
    expect(() =>
      entry.writeCleanupTombstone(
        INSTALLATION_B,
        closingTombstone({ extra: true }),
      ),
    ).toThrow();
  });

  it("rejects every tombstone ownership or monotonicity regression without modifying storage", () => {
    const { entry, storage } = createFixedEntry();
    const initial = closingTombstone({
      identity: IDENTITY_A,
      cookiesCleared: true,
    });
    entry.writeCleanupTombstone(INSTALLATION_A, initial);

    for (const candidate of [
      closingTombstone({ transitionId: TRANSITION_B, cookiesCleared: true }),
      closingTombstone({ cookiesCleared: false }),
      closingTombstone({ identity: null, cookiesCleared: true }),
      closingTombstone({ identity: IDENTITY_B, cookiesCleared: true }),
    ]) {
      expect(() =>
        entry.writeCleanupTombstone(INSTALLATION_A, candidate),
      ).toThrowError(expect.objectContaining({ code: "ENTRY_TOMBSTONE_REGRESSION" }));
      expect(JSON.parse(storage.getItem(tombstoneKey(INSTALLATION_A))!)).toEqual(
        initial,
      );
    }

    const deleting = closingTombstone({
      identity: IDENTITY_A,
      phase: "deleting",
      cookiesCleared: true,
    });
    entry.writeCleanupTombstone(INSTALLATION_A, deleting);
    expect(() =>
      entry.writeCleanupTombstone(INSTALLATION_A, initial),
    ).toThrowError(expect.objectContaining({ code: "ENTRY_TOMBSTONE_REGRESSION" }));
    expect(entry.readCleanupTombstone(INSTALLATION_A)).toEqual(deleting);
    expect(entry.clearCleanupTombstone(INSTALLATION_A, TRANSITION_B)).toBe(
      false,
    );
    expect(entry.readCleanupTombstone(INSTALLATION_A)).toEqual(deleting);
    expect(entry.clearCleanupTombstone(INSTALLATION_A, TRANSITION_A)).toBe(
      true,
    );
  });

  it("lists cleanup records by encoded installation ID in stable sorted order", () => {
    const { entry, storage } = createFixedEntry();
    const first = closingTombstone({ identity: null });
    const second = closingTombstone({
      transitionId: TRANSITION_B,
      identity: IDENTITY_B,
    });
    storage.setItem(tombstoneKey(INSTALLATION_B), JSON.stringify(second));
    storage.setItem(`unrelated:${INSTALLATION_A}`, JSON.stringify(first));
    storage.setItem(tombstoneKey(INSTALLATION_A), JSON.stringify(first));

    expect(entry.listCleanupTombstones()).toEqual([
      { installationId: INSTALLATION_A, tombstone: first },
      { installationId: INSTALLATION_B, tombstone: second },
    ]);
  });

  it("fails closed when a cleanup-prefixed key or record is malformed", () => {
    const badKey = createFixedEntry();
    badKey.storage.setItem(
      tombstoneKey("not-a-uuid"),
      JSON.stringify(closingTombstone()),
    );
    expect(() => badKey.entry.listCleanupTombstones()).toThrowError(
      expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }),
    );

    const badRecord = createFixedEntry();
    badRecord.storage.setItem(tombstoneKey(INSTALLATION_A), "{malformed");
    expect(() => badRecord.entry.listCleanupTombstones()).toThrowError(
      expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }),
    );
  });

  it("increments lifecycle revision from shared storage and accepts only exact states", () => {
    const storage = createStorage();
    const firstTab = createEntryStorage({ localStorage: storage });
    const secondTab = createEntryStorage({ localStorage: storage });

    expect(
      firstTab.advanceLifecycle(INSTALLATION_A, "locked", TRANSITION_A),
    ).toMatchObject({ revision: 1 });
    expect(
      secondTab.advanceLifecycle(INSTALLATION_A, "active", TRANSITION_B),
    ).toMatchObject({ revision: 2 });
    expect(
      firstTab.advanceLifecycle(INSTALLATION_A, "revoked", TRANSITION_A),
    ).toEqual({
      protocolVersion: 2,
      revision: 3,
      state: "revoked",
      transitionId: TRANSITION_A,
    });
    expect(() =>
      firstTab.advanceLifecycle(INSTALLATION_A, "pairing", TRANSITION_A),
    ).toThrow();
  });

  it("rejects lifecycle revision overflow without modifying the stored record", () => {
    const { entry, storage } = createFixedEntry();
    const current = {
      protocolVersion: 2,
      revision: Number.MAX_SAFE_INTEGER,
      state: "locked",
      transitionId: TRANSITION_A,
    };
    storage.setItem(lifecycleKey(INSTALLATION_A), JSON.stringify(current));
    expect(() =>
      entry.advanceLifecycle(INSTALLATION_A, "active", TRANSITION_B),
    ).toThrowError(expect.objectContaining({ code: "ENTRY_STORAGE_INVALID" }));
    expect(entry.readLifecycle(INSTALLATION_A)).toEqual(current);
  });

  it("makes same-clock lock markers monotonic and compare-clears captured bytes", () => {
    const { entry } = createFixedEntry();
    const first = entry.writeLockMarker(INSTALLATION_A);
    const second = entry.writeLockMarker(INSTALLATION_A);

    expect(first.lockedAt).toBe(FIXED_TIME);
    expect(second.lockedAt).toBe("2026-07-25T09:00:00.001Z");
    expect(entry.clearLockMarker(INSTALLATION_A, null)).toBe(false);
    expect(
      entry.clearLockMarker(INSTALLATION_A, {
        lockedAt: second.lockedAt,
        protocolVersion: 2,
      }),
    ).toBe(false);
    expect(entry.clearLockMarker(INSTALLATION_A, first)).toBe(false);
    expect(entry.readLockMarker(INSTALLATION_A)).toEqual(second);
    expect(entry.clearLockMarker(INSTALLATION_A, second)).toBe(true);
    entry.writeLockMarker(INSTALLATION_A);
    expect(entry.clearLockMarker(INSTALLATION_A)).toBe(true);
  });
});

describe("Member Entry origin-global Cookie ownership", () => {
  it("persists a strict Cookie-clear signal, preserves its first owner, and compare-clears", () => {
    const { entry } = createFixedEntry();
    expect(entry.writeCookieClearPending(OWNER_A)).toEqual(OWNER_A);
    expect(entry.writeCookieClearPending(OWNER_B)).toEqual(OWNER_A);
    expect(entry.readCookieClearPending()).toEqual(OWNER_A);
    expect(entry.clearCookieClearPending(TRANSITION_B)).toBe(false);
    expect(entry.readCookieClearPending()).toEqual(OWNER_A);
    expect(entry.clearCookieClearPending(TRANSITION_A)).toBe(true);
    expect(entry.readCookieClearPending()).toBeNull();

    expect(() =>
      entry.writeCookieClearPending({ ...OWNER_A, identity: IDENTITY_A }),
    ).toThrow();
    expect(() =>
      entry.writeCookieClearPending({ ...OWNER_A, createdAt: "yesterday" }),
    ).toThrow();
  });

  it("preserves one exact Claim intent owner and refuses replacement", () => {
    const { entry } = createFixedEntry();
    expect(entry.writeClaimCookieIntent(OWNER_A)).toEqual(OWNER_A);
    expect(entry.writeClaimCookieIntent({ ...OWNER_A })).toEqual(OWNER_A);
    expect(() => entry.writeClaimCookieIntent(OWNER_B)).toThrowError(
      expect.objectContaining({ code: "ENTRY_COOKIE_OWNER_CONFLICT" }),
    );
    expect(entry.clearClaimCookieIntent(TRANSITION_B)).toBe(false);
    expect(entry.readClaimCookieIntent()).toEqual(OWNER_A);
    expect(entry.clearClaimCookieIntent(TRANSITION_A)).toBe(true);
  });

  it("never allows Claim intent and Cookie-clear signal to coexist", () => {
    const first = createFixedEntry();
    first.entry.writeClaimCookieIntent(OWNER_A);
    expect(() => first.entry.writeCookieClearPending(OWNER_B)).toThrowError(
      expect.objectContaining({ code: "ENTRY_COOKIE_OWNER_CONFLICT" }),
    );
    expect(first.entry.readCookieClearPending()).toBeNull();

    const second = createFixedEntry();
    second.entry.writeCookieClearPending(OWNER_B);
    expect(() => second.entry.writeClaimCookieIntent(OWNER_A)).toThrowError(
      expect.objectContaining({ code: "ENTRY_COOKIE_OWNER_CONFLICT" }),
    );
    expect(second.entry.readClaimCookieIntent()).toBeNull();
  });

  it("returns the exact set or clear event edge and rejects updates or malformed replacements", () => {
    const { entry, storage } = createFixedEntry();
    const setWake = entry.readCookieOwnerWakeFromEvent({
      key: CLAIM_COOKIE_INTENT_KEY,
      oldValue: null,
      newValue: JSON.stringify(OWNER_A),
    });
    expect(setWake).toEqual({ kind: "set", owner: OWNER_A });

    storage.setItem(CLAIM_COOKIE_INTENT_KEY, JSON.stringify(OWNER_A));
    storage.removeItem(CLAIM_COOKIE_INTENT_KEY);
    expect(setWake).toEqual({ kind: "set", owner: OWNER_A });
    expect(
      entry.readCookieOwnerWakeFromEvent({
        key: CLAIM_COOKIE_INTENT_KEY,
        oldValue: JSON.stringify(OWNER_A),
        newValue: null,
      }),
    ).toEqual({ kind: "clear", owner: OWNER_A });
    expect(
      entry.readCookieOwnerWakeFromEvent({
        key: COOKIE_CLEAR_PENDING_KEY,
        oldValue: JSON.stringify(OWNER_A),
        newValue: JSON.stringify(OWNER_B),
      }),
    ).toBeNull();
    expect(
      entry.readCookieOwnerWakeFromEvent({
        key: COOKIE_CLEAR_PENDING_KEY,
        oldValue: JSON.stringify(OWNER_A),
        newValue: "{malformed",
      }),
    ).toBeNull();
    expect(
      entry.readCookieOwnerWakeFromEvent({
        key: "unrelated",
        oldValue: null,
        newValue: JSON.stringify(OWNER_A),
      }),
    ).toBeNull();
  });
});

describe("Member Entry Web Lock coordination", () => {
  it("serializes two mutations under the exact installation lock", async () => {
    const locks = createDeterministicWebLocks();
    const mutation = createEntryMutationLock({ locks });
    const order: string[] = [];
    const firstEntered = deferred<undefined>();
    const releaseFirst = deferred<undefined>();

    const first = mutation.run("install-a", async () => {
      order.push("a:start");
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
      order.push("a:end");
    });
    await firstEntered.promise;
    const second = mutation.run("install-a", async () => {
      order.push("b:start", "b:end");
    });
    await flush();
    expect(order).toEqual(["a:start"]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(locks.requestedNames).toEqual([
      "family-ai-member-entry-mutation:install-a",
      "family-ai-member-entry-mutation:install-a",
    ]);
  });

  it("fails closed without Web Locks while keeping cache reads viewable and writing no lease", async () => {
    const storage = createStorage();
    const mutation = createEntryMutationLock({ locks: null });
    const callback = vi.fn();

    expect(mutation.available).toBe(false);
    await expect(mutation.run(INSTALLATION_A, callback)).rejects.toMatchObject({
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
    });
    await expect(mutation.runCookieMutation(callback)).rejects.toMatchObject({
      code: "ENTRY_MUTATION_LOCK_UNAVAILABLE",
    });
    await expect(
      mutation.runProductDrain(INSTALLATION_A, callback),
    ).rejects.toMatchObject({ code: "ENTRY_MUTATION_LOCK_UNAVAILABLE" });
    expect(callback).not.toHaveBeenCalled();

    const lease = await mutation.acquireProductFlight(INSTALLATION_A);
    await lease.release();
    await lease.release();
    await expect(
      mutation.runCacheOpen(INSTALLATION_A, async () => "cached"),
    ).resolves.toBe("cached");
    expect(storage.dump()).toEqual({});
  });

  it("serializes uncertain Claim, cleanup, and a different installation Claim by the global Cookie lock", async () => {
    const locks = createDeterministicWebLocks();
    const firstTab = createEntryMutationLock({ locks });
    const secondTab = createEntryMutationLock({ locks });
    const order: string[] = [];
    const firstEntered = deferred<undefined>();
    const releaseFirst = deferred<undefined>();

    const uncertainClaim = firstTab.runCookieMutation(() =>
      firstTab.run(INSTALLATION_A, async () => {
        order.push("i1:claim:start");
        firstEntered.resolve(undefined);
        await releaseFirst.promise;
        order.push("i1:claim:end");
      }),
    );
    await firstEntered.promise;
    const cleanup = firstTab.runCookieMutation(() =>
      firstTab.run(INSTALLATION_A, async () => {
        order.push("i1:clear:start", "i1:clear:end");
      }),
    );
    const secondClaim = secondTab.runCookieMutation(() =>
      secondTab.run(INSTALLATION_B, async () => {
        order.push("i2:claim:start", "i2:claim:end");
      }),
    );
    await flush();
    expect(order).toEqual(["i1:claim:start"]);

    releaseFirst.resolve(undefined);
    await Promise.all([uncertainClaim, cleanup, secondClaim]);
    expect(order).toEqual([
      "i1:claim:start",
      "i1:claim:end",
      "i1:clear:start",
      "i1:clear:end",
      "i2:claim:start",
      "i2:claim:end",
    ]);
    expect(
      locks.requestedNames.filter(
        (name) => name === "family-ai-member-cookie-mutation",
      ),
    ).toHaveLength(3);
  });

  it("drains all same-installation shared Product flights but not another installation", async () => {
    const locks = createDeterministicWebLocks();
    const tabA = createEntryMutationLock({ locks });
    const tabB = createEntryMutationLock({ locks });
    const flightA = await tabA.acquireProductFlight("install-a");
    const flightB = await tabB.acquireProductFlight("install-a");
    const unrelated = await tabB.acquireProductFlight("install-b");
    let entered = 0;

    const drain = tabA.runProductDrain("install-a", async () => {
      entered += 1;
    });
    await flush();
    expect(entered).toBe(0);
    await flightA.release();
    await flightA.release();
    await flush();
    expect(entered).toBe(0);
    await flightB.release();
    await drain;
    expect(entered).toBe(1);
    const sameInstallationEvents = locks.events.filter(
      (event) =>
        event.name === "family-ai-member-product-flight:install-a" &&
        event.phase !== "request",
    );
    expect(sameInstallationEvents.map((event) => `${event.phase}:${event.mode}`))
      .toEqual([
        "enter:shared",
        "enter:shared",
        "exit:shared",
        "exit:shared",
        "enter:exclusive",
        "exit:exclusive",
      ]);
    await unrelated.release();
  });

  it("releases held locks after synchronous throws and asynchronous rejections", async () => {
    const locks = createDeterministicWebLocks();
    const mutation = createEntryMutationLock({ locks });
    const syncError = new Error("sync");
    const asyncError = new Error("async");

    await expect(
      mutation.run("install-a", () => {
        throw syncError;
      }),
    ).rejects.toBe(syncError);
    await expect(
      mutation.run("install-a", async () => {
        throw asyncError;
      }),
    ).rejects.toBe(asyncError);
    await expect(
      mutation.run("install-a", async () => "released"),
    ).resolves.toBe("released");
  });

  it("rejects Product-flight acquisition on an early synchronous request throw", async () => {
    const requestError = new Error("request threw");
    const mutation = createEntryMutationLock({
      locks: {
        request() {
          throw requestError;
        },
      },
    });
    await expect(mutation.acquireProductFlight("install-a")).rejects.toBe(
      requestError,
    );
  });

  it("rejects Product-flight acquisition on an early asynchronous request rejection", async () => {
    const requestError = new Error("request rejected");
    const mutation = createEntryMutationLock({
      locks: {
        request() {
          return Promise.reject(requestError);
        },
      },
    });
    await expect(mutation.acquireProductFlight("install-a")).rejects.toBe(
      requestError,
    );
  });

  it("waits for the Product-flight Web Lock callback to exit and releases idempotently", async () => {
    let callbackExited = false;
    const locks = {
      request(
        _name: string,
        _options: unknown,
        callback: (lock: { name: string }) => unknown,
      ) {
        return Promise.resolve()
          .then(() => callback({ name: "flight" }))
          .then((value) => {
            callbackExited = true;
            return value;
          });
      },
    };
    const mutation = createEntryMutationLock({ locks });
    const lease = await mutation.acquireProductFlight("install-a");
    const firstRelease = lease.release();
    const secondRelease = lease.release();
    await Promise.all([firstRelease, secondRelease]);
    expect(callbackExited).toBe(true);
  });

  it("uses the cookie-entry-flight-cache order and observes a published pointer without deadlock", async () => {
    const locks = createDeterministicWebLocks();
    const productTab = createEntryMutationLock({ locks });
    const revokeTab = createEntryMutationLock({ locks });
    const pointer: string[] = [];
    const productCacheEntered = deferred<undefined>();
    const publishPointer = deferred<undefined>();
    let observed: string | undefined;

    const productFlight = await productTab.acquireProductFlight("install-a");
    const productCache = productTab.runCacheOpen("install-a", async () => {
      productCacheEntered.resolve(undefined);
      await publishPointer.promise;
      pointer.push("identity-a");
    });
    await productCacheEntered.promise;

    const revoke = revokeTab.runCookieMutation(() =>
      revokeTab.run("install-a", () =>
        revokeTab.runProductDrain("install-a", () =>
          revokeTab.runCacheOpen("install-a", async () => {
            observed = pointer[0];
          }),
        ),
      ),
    );
    await flush();
    expect(observed).toBeUndefined();
    publishPointer.resolve(undefined);
    await productCache;
    await flush();
    expect(observed).toBeUndefined();
    await productFlight.release();
    await revoke;

    expect(observed).toBe("identity-a");
    expect(locks.requestedNames).toEqual([
      "family-ai-member-product-flight:install-a",
      "family-ai-member-cache-open:install-a",
      "family-ai-member-cookie-mutation",
      "family-ai-member-entry-mutation:install-a",
      "family-ai-member-product-flight:install-a",
      "family-ai-member-cache-open:install-a",
    ]);
  });
});
